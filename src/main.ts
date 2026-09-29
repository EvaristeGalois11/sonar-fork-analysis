import * as core from '@actions/core'
import { ArtifactNotFoundError, DefaultArtifactClient } from '@actions/artifact'
import { exec, getExecOutput } from '@actions/exec'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  checkNoLinks,
  formatProperties,
  removeProjectSettings,
  resolveSettings,
  trustedProperties,
  unpackWorkspace
} from './analyze.js'
import { detectBuildTool } from './build-tool.js'
import {
  buildFailure,
  sonarBuildArguments,
  missingAnalysis,
  sonarProperties
} from './direct.js'
import { readInputs, type Inputs } from './inputs.js'
import { resolveMode } from './mode.js'
import { resolveOrigin, type Context, type Origin } from './origin.js'
import {
  ARTIFACT_FORMAT,
  artifactName,
  missingDump,
  simulationProperties,
  stageAnalysis
} from './prepare.js'
import { parseProperties } from './properties.js'
import { findNewReport, snapshotReports } from './report.js'
import { installScanner } from './scanner.js'
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
    tool.name
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

function tempDirectory(): string {
  return mkdtempSync(
    join(process.env.RUNNER_TEMP ?? tmpdir(), 'sonar-fork-analysis-')
  )
}

async function downloadAnalysis(
  name: string,
  origin: Origin,
  context: Context,
  temp: string
): Promise<string | undefined> {
  if (!process.env.ACTIONS_RUNTIME_TOKEN) {
    const local = process.env.SONAR_FORK_ANALYSIS_ARTIFACT
    if (local) core.warning(`Not running in GitHub Actions, analysing ${local}`)
    return local
  }
  const client = new DefaultArtifactClient()
  const [owner, repo] = context.repository.split('/')
  const options =
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
  let id: number
  try {
    id = (await client.getArtifact(name, options)).artifact.id
  } catch (error) {
    if (error instanceof ArtifactNotFoundError) return undefined
    throw error
  }
  const path = join(temp, 'artifact')
  await client.downloadArtifact(id, { ...options, path })
  return path
}

async function analyze(inputs: Inputs): Promise<void> {
  if (!inputs.projectKey) throw new Error('Input required: project-key')
  if (!inputs.token) {
    throw new Error('No Sonar token available, set the sonar-token input.')
  }
  const name = artifactName(inputs.id)
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

  const head = (
    await getExecOutput('git', ['rev-parse', 'HEAD'], {
      cwd: workspace,
      silent: true
    })
  ).stdout.trim()
  if (head !== origin.headSha) {
    throw new Error(
      `The checkout is at ${head} but the analysis is for ${origin.headSha}: check out that commit first`
    )
  }

  const temp = tempDirectory()
  const artifact = await downloadAnalysis(name, origin, context, temp)
  if (!artifact) {
    core.notice(
      `No ${name} artifact to analyse; the build may have analysed directly.`
    )
    return
  }
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
  // core.warning escapes its message, unlike core.info, so artifact content cannot inject commands.
  for (const warning of warnings) core.warning(warning)

  const properties = resolved.properties
  if (!properties.has('sonar.projectBaseDir'))
    properties.set('sonar.projectBaseDir', workspace)
  const trusted = trustedProperties(
    { ...inputs, javaHome: process.env.JAVA_HOME },
    origin
  )
  for (const [key, value] of trusted) properties.set(key, value)
  const settingsFile = join(temp, 'sonar-project.properties')
  writeFileSync(settingsFile, formatProperties(properties))

  const scanner = await installScanner()
  core.info(`Analysing ${name}`)
  const env = { ...process.env, SONAR_TOKEN: inputs.token }
  const exitCode = await exec(
    scanner,
    [`-Dproject.settings=${settingsFile}`, ...inputs.buildArguments],
    {
      cwd: workspace,
      env: env as Record<string, string>,
      ignoreReturnCode: true
    }
  )
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
