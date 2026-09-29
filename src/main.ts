import * as core from '@actions/core'
import { DefaultArtifactClient } from '@actions/artifact'
import { exec } from '@actions/exec'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { detectBuildTool } from './build-tool.js'
import {
  buildFailure,
  sonarBuildArguments,
  missingAnalysis,
  sonarProperties
} from './direct.js'
import { readInputs, type Inputs } from './inputs.js'
import { resolveMode } from './mode.js'
import {
  artifactName,
  missingDump,
  simulationProperties,
  stageAnalysis
} from './prepare.js'
import { parseProperties } from './properties.js'
import { findNewReport, snapshotReports } from './report.js'
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
  const temp = mkdtempSync(
    join(process.env.RUNNER_TEMP ?? tmpdir(), 'sonar-fork-analysis-')
  )
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
      throw new Error(`Mode '${resolution.mode}' is not implemented yet`)
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
