import * as core from '@actions/core'
import { ArtifactNotFoundError, DefaultArtifactClient } from '@actions/artifact'
import { exec } from '@actions/exec'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  checkNoLinks,
  formatProperties,
  removeProjectSettings,
  resolveSettings,
  trustedProperties,
  unpackWorkspace
} from './analyze.js'
import { detectBuildTool } from './build-tool.js'
import { checkoutCommit, verifyCheckout } from './checkout.js'
import {
  buildFailure,
  sonarBuildArguments,
  missingAnalysis,
  sonarProperties
} from './direct.js'
import { readInputs, type Inputs } from './inputs.js'
import { resolveMode } from './mode.js'
import {
  choosePullRequest,
  resolveOrigin,
  type Context,
  type Origin,
  type PullRequest
} from './origin.js'
import {
  ARTIFACT_FORMAT,
  artifactName,
  directArtifactName,
  missingDump,
  simulationProperties,
  stageAnalysis
} from './prepare.js'
import { parseProperties } from './properties.js'
import { findNewReport, snapshotReports } from './report.js'
import { installScanner } from './scanner.js'
import {
  forgetPending,
  noReporter,
  rememberPending,
  statusReporter,
  type StatusTarget
} from './status.js'
import { filterSettings } from './settings.js'

async function direct(inputs: Inputs): Promise<void> {
  if (!inputs.projectKey) throw new Error('Input required: project-key')
  const workingDirectory = resolve(inputs.workingDirectory)
  const tool = detectBuildTool(workingDirectory, inputs.buildTool)
  const args = sonarBuildArguments(
    tool,
    inputs.buildGoals,
    sonarProperties(inputs),
    inputs.buildArguments
  )

  core.info(`Analysing the ${tool.name} build in ${workingDirectory}`)
  // The token goes through the environment, which the scanner reads, so it never shows up in a command line.
  const env = { ...process.env, SONAR_TOKEN: inputs.token }
  const reportsBefore = snapshotReports(workingDirectory)
  let errorOutput = ''
  const exitCode = await exec(tool.executable, args, {
    cwd: workingDirectory,
    env: env as Record<string, string>,
    ignoreReturnCode: true,
    listeners: { stderr: (data) => (errorOutput += data.toString()) }
  })
  if (exitCode !== 0) throw new Error(buildFailure(tool, exitCode, errorOutput))
  // Sanity check against misconfiguration, e.g. Gradle running another task matching 'sonar'. Not a
  // guarantee: the build can write any report it likes.
  if (!findNewReport(workingDirectory, reportsBefore))
    throw new Error(missingAnalysis(tool))
  await leaveDirectNote(inputs.id)
}

// Tells a fork path's analysis, which runs after every build, that this one already analysed.
async function leaveDirectNote(id: string): Promise<void> {
  if (!process.env.ACTIONS_RUNTIME_TOKEN) return
  const note = join(tempDirectory(), 'analysed-directly.json')
  writeFileSync(note, JSON.stringify({ format: ARTIFACT_FORMAT }))
  try {
    await new DefaultArtifactClient().uploadArtifact(
      directArtifactName(id),
      [note],
      dirname(note),
      { retentionDays: 1 }
    )
  } catch (error) {
    core.warning(
      `Could not note the direct analysis for the fork path (${error instanceof Error ? error.message : String(error)}); analyses in one workflow need distinct ids`
    )
  }
}

async function prepare(inputs: Inputs): Promise<void> {
  const name = artifactName(inputs.id)
  const workingDirectory = resolve(inputs.workingDirectory)
  const tool = detectBuildTool(workingDirectory, inputs.buildTool)
  const temp = tempDirectory()
  const dump = join(temp, 'dump.properties')
  const args = sonarBuildArguments(
    tool,
    inputs.buildGoals,
    simulationProperties(dump),
    inputs.buildArguments
  )

  core.info(
    `Preparing the analysis of the ${tool.name} build in ${workingDirectory}`
  )
  const env: Record<string, string | undefined> = { ...process.env }
  delete env.SONAR_TOKEN
  let errorOutput = ''
  const exitCode = await exec(tool.executable, args, {
    cwd: workingDirectory,
    env: env as Record<string, string>,
    ignoreReturnCode: true,
    listeners: { stderr: (data) => (errorOutput += data.toString()) }
  })
  if (exitCode !== 0) throw new Error(buildFailure(tool, exitCode, errorOutput))
  if (!existsSync(dump)) throw new Error(missingDump(tool))

  // The dump holds the build's whole environment, so it never leaves this machine.
  const settings = parseProperties(readFileSync(dump, 'utf8'))
  rmSync(dump)
  const { kept, dropped } = filterSettings(settings)
  core.debug(`Settings the analysis decides itself: ${dropped.join(', ')}`)

  const staging = join(temp, 'artifact')
  const staged = stageAnalysis(
    kept,
    {
      workspace: process.env.GITHUB_WORKSPACE ?? process.cwd(),
      home: homedir()
    },
    staging,
    tool.name,
    pullRequestNumber()
  )
  for (const warning of staged.warnings) core.warning(warning)

  if (!process.env.ACTIONS_RUNTIME_TOKEN) {
    core.warning(
      `Not running in GitHub Actions, so ${name} was not uploaded: ${staging}`
    )
    return
  }
  await new DefaultArtifactClient().uploadArtifact(
    name,
    staged.files,
    staging,
    {
      retentionDays: 1
    }
  )
  core.info(`Uploaded ${name} with ${staged.files.length} files`)
}

// Tells the analysis which pull request this build is for, in case several share its head.
function pullRequestNumber(): number | undefined {
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request' || !eventPath)
    return undefined
  return JSON.parse(readFileSync(eventPath, 'utf8')).pull_request?.number
}

function tempDirectory(): string {
  return mkdtempSync(
    join(process.env.RUNNER_TEMP ?? tmpdir(), 'sonar-fork-analysis-')
  )
}

type FindOptions = {
  findBy?: {
    token: string
    workflowRunId: number
    repositoryOwner: string
    repositoryName: string
  }
}

// An artifact of the build: in its run, or in this one when analysing within the same run.
type Found = { id: number; options: FindOptions } | { local: string }

async function findArtifact(
  name: string,
  origin: Origin,
  context: Context
): Promise<Found | undefined> {
  if (!process.env.ACTIONS_RUNTIME_TOKEN) {
    const local = process.env.SONAR_FORK_ANALYSIS_ARTIFACT
    if (local) core.warning(`Not running in GitHub Actions, analysing ${local}`)
    return local ? { local } : undefined
  }
  const [owner, repo] = context.repository.split('/')
  const options: FindOptions =
    origin.runId === undefined
      ? {}
      : {
          findBy: {
            token: context.token,
            workflowRunId: origin.runId,
            repositoryOwner: owner,
            repositoryName: repo
          }
        }
  try {
    const { artifact } = await new DefaultArtifactClient().getArtifact(
      name,
      options
    )
    return { id: artifact.id, options }
  } catch (error) {
    if (error instanceof ArtifactNotFoundError) return undefined
    throw error
  }
}

async function downloadArtifact(found: Found, temp: string): Promise<string> {
  if ('local' in found) return found.local
  const path = join(temp, 'artifact')
  await new DefaultArtifactClient().downloadArtifact(found.id, {
    ...found.options,
    path
  })
  return path
}

async function analyze(inputs: Inputs): Promise<void> {
  if (!inputs.projectKey) throw new Error('Input required: project-key')
  if (!inputs.token) {
    throw new Error('No Sonar token available, set the sonar-token input.')
  }
  const workspace = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd())
  const eventPath = process.env.GITHUB_EVENT_PATH
  const context: Context = {
    eventName: process.env.GITHUB_EVENT_NAME ?? '',
    event: eventPath ? JSON.parse(readFileSync(eventPath, 'utf8')) : {},
    repository: process.env.GITHUB_REPOSITORY ?? '',
    sha: process.env.GITHUB_SHA ?? '',
    refName: process.env.GITHUB_REF_NAME ?? '',
    apiUrl: process.env.GITHUB_API_URL ?? 'https://api.github.com',
    token: inputs.githubToken
  }
  const origin = await resolveOrigin(context)
  if ('skip' in origin) {
    core.notice(origin.skip)
    return
  }

  const target: StatusTarget = {
    apiUrl: context.apiUrl,
    repository: context.repository,
    sha: origin.headSha,
    token: inputs.githubToken,
    name: `Sonar fork analysis${inputs.id ? ` (${inputs.id})` : ''}`,
    url: `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${context.repository}/actions/runs/${process.env.GITHUB_RUN_ID ?? ''}`
  }
  const report =
    context.eventName === 'workflow_run' ? statusReporter(target) : noReporter

  // Looked up before checking out, so a run with nothing to do takes seconds.
  const name = artifactName(inputs.id)
  const found = await findArtifact(name, origin, context)
  if (!found) {
    if (await findArtifact(directArtifactName(inputs.id), origin, context)) {
      core.info('The build analysed directly, so there is nothing to analyse.')
      return
    }
    // Without the artifact the Sonar check never comes; this status says why.
    core.notice(`No ${name} artifact: the build left nothing to analyse.`)
    await report('failure', 'The build left nothing to analyse')
    return
  }

  if (await report('pending', 'Analysing')) rememberPending(target)
  let reported = false
  try {
    await analyzeCommit(inputs, context, origin, workspace, found)
    reported = await report('success', 'Analysed')
  } catch (error) {
    reported = await report(
      'failure',
      error instanceof Error ? error.message : String(error)
    )
    throw error
  } finally {
    // Otherwise the post step closes the status.
    if (reported) forgetPending()
  }
}

async function analyzeCommit(
  inputs: Inputs,
  context: Context,
  origin: Origin,
  workspace: string,
  found: Found
): Promise<void> {
  const name = artifactName(inputs.id)
  if (inputs.checkout) {
    await checkoutCommit(workspace, {
      serverUrl: process.env.GITHUB_SERVER_URL ?? 'https://github.com',
      repository: context.repository,
      headRepository: origin.repository,
      sha: origin.headSha,
      token: inputs.githubToken
    })
  }
  await verifyCheckout(workspace, origin.headSha)

  const temp = tempDirectory()
  const artifact = await downloadArtifact(found, temp)
  checkNoLinks(artifact)
  const manifest = JSON.parse(
    readFileSync(join(artifact, 'settings.json'), 'utf8')
  )
  if (manifest.format !== ARTIFACT_FORMAT) {
    throw new Error(
      `${name} was prepared by an incompatible version of this action`
    )
  }

  // Sources are checked against the checkout before anything is unpacked into it.
  const home = join(temp, 'home')
  const resolved = resolveSettings(manifest.settings, workspace, home)
  removeProjectSettings(workspace)
  const warnings = [
    ...resolved.warnings,
    ...unpackWorkspace(
      join(artifact, 'workspace'),
      workspace,
      resolved.sourceRoots
    )
  ]
  if (existsSync(join(artifact, 'home')))
    cpSync(join(artifact, 'home'), home, { recursive: true })
  let pullRequest: PullRequest | undefined
  if (origin.pullRequests) {
    const choice = choosePullRequest(origin.pullRequests, manifest.pullRequest)
    pullRequest = choice.pullRequest
    if (choice.warning) warnings.push(choice.warning)
  }
  // core.warning escapes its message, unlike core.info, so artifact content cannot inject commands.
  for (const warning of warnings) core.warning(warning)

  const properties = resolved.properties
  if (!properties.has('sonar.projectBaseDir'))
    properties.set('sonar.projectBaseDir', workspace)
  const trusted = trustedProperties(
    inputs,
    { headSha: origin.headSha, pullRequest, branch: origin.branch },
    join(temp, 'scannerwork')
  )
  for (const [key, value] of trusted) properties.set(key, value)
  const settingsFile = join(temp, 'sonar-project.properties')
  writeFileSync(settingsFile, formatProperties(properties))

  const scanner = await installScanner()
  core.info(`Analysing ${name}`)
  const env = { ...process.env, SONAR_TOKEN: inputs.token }
  // The scanner prints module names and paths from the artifact and the checkout; none of it may
  // pass for a workflow command.
  const resume = randomUUID()
  core.info(`::stop-commands::${resume}`)
  let exitCode: number
  try {
    exitCode = await exec(
      scanner,
      [`-Dproject.settings=${settingsFile}`, ...inputs.buildArguments],
      {
        cwd: workspace,
        env: env as Record<string, string>,
        ignoreReturnCode: true
      }
    )
  } finally {
    core.info(`::${resume}::`)
  }
  if (exitCode !== 0)
    throw new Error(`The Sonar scanner failed with exit code ${exitCode}`)
}

async function dispatch(inputs: Inputs): Promise<void> {
  const resolution = resolveMode(
    inputs.mode,
    process.env.GITHUB_EVENT_NAME ?? '',
    inputs.token
  )
  if (resolution.warning) core.warning(resolution.warning)
  core.info(`Mode: ${resolution.mode}`)

  switch (resolution.mode) {
    case 'direct':
      return direct(inputs)
    case 'prepare':
      return prepare(inputs)
    case 'analyze':
      return analyze(inputs)
  }
}

export async function run(): Promise<void> {
  try {
    const inputs = readInputs()
    if (inputs.token) core.setSecret(inputs.token)
    await dispatch(inputs)
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error))
  }
}
