import * as core from '@actions/core'
import { DefaultArtifactClient, GHESNotSupportedError } from '@actions/artifact'
import { exec } from '@actions/exec'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  checkNoLinks,
  formatProperties,
  recreateLinks,
  removeOutwardLinks,
  readManifest,
  removeProjectSettings,
  resolveSettings,
  trustedProperties,
  unpackWorkspace
} from './analyze.js'
import { detectBuildTool, type BuildTool } from './build-tool.js'
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
  type PullRequest,
  type PullRequestEvent,
  type WorkflowRunEvent
} from './origin.js'
import {
  ARTIFACT_FORMAT,
  ARTIFACT_PREFIX,
  artifactName,
  directArtifactName,
  missingDump,
  simulationProperties,
  stageAnalysis,
  typeInformation
} from './prepare.js'
import { parseProperties } from './properties.js'
import { findNewReport, snapshotReports } from './report.js'
import { installScanner } from './scanner.js'
import { noReporter, trackedReporter, type Reporter } from './status.js'
import { filterSettings, moduleTree } from './settings.js'

async function direct(inputs: Inputs): Promise<void> {
  if (!inputs.projectKey) throw new Error('Input required: project-key')
  const workingDirectory = resolve(inputs.workingDirectory)
  const tool = detectBuildTool(workingDirectory, inputs.buildTool)
  warnWithoutSettings(tool, workingDirectory, inputs.buildArguments)
  const args = sonarBuildArguments(
    tool,
    inputs.buildGoals,
    sonarProperties(inputs),
    inputs.buildArguments
  )

  core.info(`Analysing the ${tool.name} build in ${workingDirectory}`)
  // The token goes through the environment, which the scanner reads, so it never shows up in a command line.
  const env = { ...jobEnvironment(), SONAR_TOKEN: inputs.token }
  const reportsBefore = snapshotReports(workingDirectory)
  let errorOutput = ''
  const exitCode = await exec(await executable(tool), args, {
    cwd: workingDirectory,
    env,
    ignoreReturnCode: true,
    listeners: { stderr: (data) => (errorOutput += data.toString()) }
  })
  if (exitCode !== 0) throw new Error(buildFailure(tool, exitCode, errorOutput))
  // Sanity check against misconfiguration, e.g. Gradle running another task matching 'sonar'. Not a
  // guarantee: the build can write any report it likes.
  if (!findNewReport(workingDirectory, reportsBefore))
    throw new Error(missingAnalysis(tool))
  await leaveDirectNote(inputs.projectKey)
}

const NOTE_DAYS = 35

// The job's environment without what the runner gives only the action: its inputs, the Sonar token
// and the GitHub token among them, and the runtime's own tokens.
function jobEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !entry[0].startsWith('INPUT_') &&
        !entry[0].startsWith('ACTIONS_')
    )
  )
}

const RUNNER_FILES = new Set([
  'GITHUB_ENV',
  'GITHUB_OUTPUT',
  'GITHUB_PATH',
  'GITHUB_STATE',
  'GITHUB_STEP_SUMMARY',
  'GITHUB_TOKEN'
])

// Tells a fork path's analysis, which runs after every build, that this one already analysed.
async function leaveDirectNote(projectKey: string): Promise<void> {
  if (!process.env.ACTIONS_RUNTIME_TOKEN) return
  // GitHub cancels a run after 35 days, approval waits included, so a note kept that long outlives
  // any build that still completes. The repository may keep artifacts for less, and an expired
  // artifact is no longer listed.
  const limit = Number.parseInt(process.env.GITHUB_RETENTION_DAYS ?? '', 10)
  const days = Number.isNaN(limit) ? NOTE_DAYS : Math.min(NOTE_DAYS, limit)
  if (days < NOTE_DAYS) {
    core.notice(
      `This repository keeps artifacts ${days} days: if this build completes more than ${days} days after its analysis, e.g. after a deployment approval, the fork path will report that it left nothing to analyse.`
    )
  }
  const note = join(tempDirectory(), 'analysed-directly.json')
  writeFileSync(note, JSON.stringify({ format: ARTIFACT_FORMAT }))
  try {
    await new DefaultArtifactClient().uploadArtifact(
      directArtifactName(projectKey),
      [note],
      dirname(note),
      { retentionDays: days }
    )
  } catch (error) {
    // No artifacts there, so no fork path to tell either.
    if (error instanceof GHESNotSupportedError) return
    const message = error instanceof Error ? error.message : String(error)
    const clash = /\(409\)/.test(message)
      ? '; analyses in one workflow need distinct project keys'
      : ''
    core.warning(
      `Could not note the direct analysis for the fork path: ${message}${clash}`
    )
  }
}

async function prepare(inputs: Inputs): Promise<void> {
  if (!inputs.projectKey) throw new Error('Input required: project-key')
  const name = artifactName(inputs.projectKey)
  const workingDirectory = resolve(inputs.workingDirectory)
  const tool = detectBuildTool(workingDirectory, inputs.buildTool)
  warnWithoutSettings(tool, workingDirectory, inputs.buildArguments)
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
  const env = jobEnvironment()
  delete env.SONAR_TOKEN
  let errorOutput = ''
  const exitCode = await exec(await executable(tool), args, {
    cwd: workingDirectory,
    env,
    ignoreReturnCode: true,
    listeners: { stderr: (data) => (errorOutput += data.toString()) }
  })
  if (exitCode !== 0) throw new Error(buildFailure(tool, exitCode, errorOutput))
  if (!existsSync(dump)) throw new Error(missingDump(tool))

  // The dump holds the build's whole environment, so it never leaves this machine.
  const settings = parseProperties(readFileSync(dump, 'utf8'))
  rmSync(dump)
  const { kept, dropped, replaced, ignored } = filterSettings(settings)
  core.debug(`Settings the analysis sets itself: ${replaced.join(', ')}`)
  core.info(
    `Ignored ${ignored.length} environment variables and JVM properties`
  )
  // Maven repeats command-line and parent settings in every module.
  const tree = moduleTree(settings)
  const left = new Set(dropped.map((key) => tree.split(key).bareKey))
  if (left.size > 0)
    core.warning(
      `The analysis of pull requests leaves out these settings: ${[...left].join(', ')}. Pass them to the analysis job's build-arguments if it needs them.`
    )

  // The analysis takes the organization only from its own input, so one set only in the build would
  // send the fork path's analysis to no organization at all.
  if (settings.get('sonar.organization') && !inputs.organization)
    core.warning(
      `The build sets sonar.organization, which the analysis of pull requests takes only from the sonar-organization input: set it in both workflows.`
    )

  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd()
  const types =
    tool.name === 'scanner'
      ? typeInformation(workingDirectory, workspace)
      : { files: [], links: [], outside: 0 }
  if (types.files.length > 0 || types.links.length > 0) {
    const bytes = types.files.reduce(
      (sum, path) => sum + statSync(path).size,
      0
    )
    const outside =
      types.outside > 0
        ? `, leaving out ${types.outside} links that lead outside the workspace`
        : ''
    core.info(
      `Shipping ${types.files.length} type declaration files (${Math.ceil(bytes / 1_048_576)} MB) and ${types.links.length} links from node_modules${outside}`
    )
  } else if (
    tool.name === 'scanner' &&
    existsSync(join(workingDirectory, 'package.json'))
  ) {
    core.info(
      'No type declarations found in node_modules: the analysis of pull requests resolves fewer types'
    )
  }
  const staging = join(temp, 'artifact')
  const staged = stageAnalysis(
    kept,
    {
      workspace,
      home: homedir()
    },
    staging,
    tool.name,
    pullRequestNumber(),
    types.files,
    types.links
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
  const event = JSON.parse(readFileSync(eventPath, 'utf8')) as PullRequestEvent
  return event.pull_request.number
}

// Without them the scanner analyses the whole directory, which for a project picked by its package.json
// usually means working-directory points at the wrong place.
function warnWithoutSettings(
  tool: BuildTool,
  directory: string,
  buildArguments: string[]
): void {
  if (
    tool.name === 'scanner' &&
    !existsSync(join(directory, 'sonar-project.properties')) &&
    !buildArguments.some((arg) => arg.startsWith('-Dsonar.sources='))
  )
    core.warning(
      `No sonar-project.properties in ${directory}, so the scanner analyses the whole directory: set sonar.sources there, or point working-directory at the project`
    )
}

// Without a build to run, the action runs the scanner CLI it pins.
async function executable(tool: BuildTool): Promise<string> {
  return tool.name === 'scanner' ? installScanner() : tool.executable
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

// What the build left: its artifacts by name, or a local directory outside GitHub Actions.
type Listed =
  { ids: Map<string, number>; options: FindOptions } | { local: string }

async function listArtifacts(
  origin: Origin,
  context: Context
): Promise<Listed> {
  if (!process.env.ACTIONS_RUNTIME_TOKEN) {
    const local = process.env.SONAR_FORK_ANALYSIS_ARTIFACT
    if (!local) return { ids: new Map(), options: {} }
    core.warning(`Not running in GitHub Actions, analysing ${local}`)
    return { local }
  }
  const [owner = '', repo = ''] = context.repository.split('/')
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
  const { artifacts } = await new DefaultArtifactClient().listArtifacts({
    ...options,
    // A re-run build may have uploaded the same name again.
    latest: true
  })
  return {
    ids: new Map(artifacts.map((artifact) => [artifact.name, artifact.id])),
    options
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

async function analyze(inputs: Inputs, report: Reporter): Promise<void> {
  const workspace = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd())
  const eventPath = process.env.GITHUB_EVENT_PATH
  const context: Context = {
    eventName: process.env.GITHUB_EVENT_NAME ?? '',
    event: eventPath
      ? (JSON.parse(readFileSync(eventPath, 'utf8')) as unknown)
      : {},
    repository: process.env.GITHUB_REPOSITORY ?? '',
    sha: process.env.GITHUB_SHA ?? '',
    refName: process.env.GITHUB_REF_NAME ?? '',
    apiUrl: process.env.GITHUB_API_URL ?? 'https://api.github.com',
    token: inputs.githubToken
  }
  await analyzeRun(inputs, context, workspace, report)
}

// Posts pending only once there is something to analyse, so a build that analysed directly, or did
// not concern this project, stays quiet.
async function analyzeRun(
  inputs: Inputs,
  context: Context,
  workspace: string,
  report: Reporter
): Promise<void> {
  if (!inputs.projectKey) throw new Error('Input required: project-key')
  const origin = await resolveOrigin(context)
  if ('skip' in origin) {
    core.notice(origin.skip)
    return
  }

  // Listed before checking out, so a run with nothing to do takes seconds.
  const name = artifactName(inputs.projectKey)
  const listed = await listArtifacts(origin, context)
  let found: Found
  if ('local' in listed) {
    found = listed
  } else if (listed.ids.has(name)) {
    found = { id: listed.ids.get(name) as number, options: listed.options }
  } else if (listed.ids.has(directArtifactName(inputs.projectKey))) {
    core.info('The build analysed directly, so there is nothing to analyse.')
    return
  } else if (
    [...listed.ids.keys()].some((n) => n.startsWith(ARTIFACT_PREFIX))
  ) {
    // E.g. a monorepo build that skipped this project because none of its files changed.
    core.info(`The build prepared other projects, not ${inputs.projectKey}.`)
    return
  } else {
    // Without the artifact the Sonar check never comes; this status says why.
    core.notice(`No ${name} artifact: the build left nothing to analyse.`)
    await report('failure', 'The build left nothing to analyse')
    return
  }
  // Only needed from here: a missing token does not matter when there is nothing to analyse.
  if (!inputs.token) {
    throw new Error('No Sonar token available, set the sonar-token input.')
  }

  await report('pending', 'Analysing')
  await analyzeCommit(inputs, context, origin, workspace, found)
  await report('success', 'Analysed')
}

async function analyzeCommit(
  inputs: Inputs,
  context: Context,
  origin: Origin,
  workspace: string,
  found: Found
): Promise<void> {
  const name = artifactName(inputs.projectKey)
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
  // /proc/self/cwd leads to the working directory of whichever process reads it: the checkout for the
  // action, where the runner starts it, so the sweep would keep a link to it. From here it leads out
  // of the checkout, as it does for the scanner.
  process.chdir(temp)
  const removedLinks = removeOutwardLinks(workspace)

  const artifact = await downloadArtifact(found, temp)
  checkNoLinks(artifact)
  const manifest = readManifest(
    readFileSync(join(artifact, 'settings.json'), 'utf8'),
    name
  )

  // Sources are checked against the checkout before anything is unpacked into it.
  const home = join(temp, 'home')
  const resolved = resolveSettings(manifest.settings, workspace, home)
  removeProjectSettings(workspace)
  const warnings = [
    ...removedLinks,
    ...resolved.warnings,
    ...unpackWorkspace(
      join(artifact, 'workspace'),
      workspace,
      resolved.sourceRoots,
      resolved.reports
    ),
    ...recreateLinks(workspace, manifest.links)
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
  // The scanner reads untrusted content, and needs neither the files through which a step talks to
  // the runner nor a GitHub token.
  const env = Object.fromEntries(
    Object.entries(jobEnvironment()).filter(([name]) => !RUNNER_FILES.has(name))
  )
  env.SONAR_TOKEN = inputs.token
  // Java names files in the locale's encoding; without a UTF-8 one, e.g. in a bare container, it reads
  // a non-ASCII name as '?', which is not the path checked here.
  if (process.platform === 'linux') env.LC_ALL = 'C.UTF-8'
  // The scanner prints module names and paths from the artifact and the checkout; none of it may
  // pass for a workflow command.
  const resume = randomUUID()
  // Not the checkout: the engine starts tools in its working directory, e.g. dotnet build -version for
  // its analytics, and they read their configuration there. The settings name every path in full.
  const cwd = join(temp, 'run')
  mkdirSync(cwd)
  core.info(`::stop-commands::${resume}`)
  let exitCode: number
  try {
    exitCode = await exec(
      scanner,
      [`-Dproject.settings=${settingsFile}`, ...inputs.buildArguments],
      {
        cwd,
        env,
        ignoreReturnCode: true
      }
    )
  } finally {
    core.info(`::${resume}::`)
  }
  if (exitCode !== 0)
    throw new Error(`The Sonar scanner failed with exit code ${exitCode}`)
}

async function dispatch(inputs: Inputs, report: Reporter): Promise<void> {
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
      return analyze(inputs, report)
  }
}

// Under workflow_run the job does not show on the pull request, so a status reports its failures.
// GitHub names the commit the triggering run built, so the status has somewhere to go before anything
// can fail, the reading of the inputs included.
function workflowRunReporter(): Reporter {
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (process.env.GITHUB_EVENT_NAME !== 'workflow_run' || !eventPath)
    return noReporter
  const repository = process.env.GITHUB_REPOSITORY ?? ''
  const projectKey = core.getInput('project-key')
  return trackedReporter({
    apiUrl: process.env.GITHUB_API_URL ?? 'https://api.github.com',
    repository,
    sha: (JSON.parse(readFileSync(eventPath, 'utf8')) as WorkflowRunEvent)
      .workflow_run.head_sha,
    token: core.getInput('github-token'),
    name: projectKey
      ? `Sonar fork analysis (${projectKey})`
      : 'Sonar fork analysis',
    url: `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID ?? ''}`
  })
}

export async function run(): Promise<void> {
  let report: Reporter = noReporter
  try {
    report = workflowRunReporter()
    const inputs = readInputs()
    if (inputs.token) core.setSecret(inputs.token)
    await dispatch(inputs, report)
  } catch (error) {
    // Not the message: it may quote the artifact, i.e. words of the fork's choosing. The run has it.
    await report('failure', 'The analysis failed, see the run')
    core.setFailed(error instanceof Error ? error.message : String(error))
  }
}
