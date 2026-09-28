import * as core from '@actions/core'
import { exec } from '@actions/exec'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { detectBuildTool } from './build-tool.js'
import { directArguments, gradleInitScript, sonarProperties } from './direct.js'
import { readInputs, type Inputs } from './inputs.js'
import { resolveMode } from './mode.js'

function writeGradleInitScript(pluginVersion: string): string {
  const directory = mkdtempSync(
    join(process.env.RUNNER_TEMP ?? tmpdir(), 'sonar-fork-analysis-')
  )
  const script = join(directory, 'sonar.init.gradle.kts')
  writeFileSync(script, gradleInitScript(pluginVersion))
  return script
}

async function direct(inputs: Inputs): Promise<void> {
  if (!inputs.projectKey) throw new Error('Input required: project-key')
  const workingDirectory = resolve(inputs.workingDirectory)
  const tool = detectBuildTool(workingDirectory, inputs.buildTool)
  const initScript =
    tool.name === 'gradle'
      ? writeGradleInitScript(inputs.gradlePluginVersion)
      : ''

  const args = directArguments(
    tool,
    inputs.buildGoals,
    sonarProperties(inputs),
    inputs.buildArguments,
    inputs.mavenPluginVersion,
    initScript
  )

  core.info(`Analysing the ${tool.name} build in ${workingDirectory}`)
  // The token goes through the environment, which the scanner reads, so it never shows up in a command line.
  await exec(tool.executable, args, {
    cwd: workingDirectory,
    env: { ...process.env, SONAR_TOKEN: inputs.token } as Record<string, string>
  })
}

async function dispatch(inputs: Inputs): Promise<void> {
  const resolution = resolveMode(
    inputs.mode,
    process.env.GITHUB_EVENT_NAME ?? '',
    inputs.token
  )
  if ('skip' in resolution) {
    core.notice(resolution.skip)
    return
  }
  if (resolution.warning) core.warning(resolution.warning)
  core.info(`Mode: ${resolution.mode}`)

  switch (resolution.mode) {
    case 'direct':
      return direct(inputs)
    case 'prepare':
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
