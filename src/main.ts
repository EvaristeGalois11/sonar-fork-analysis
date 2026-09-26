import * as core from '@actions/core'
import { exec } from '@actions/exec'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { detectBuildTool } from './build-tool.js'
import { directArguments, gradleInitScript } from './direct.js'
import { resolveMode } from './mode.js'

function lines(value: string): string[] {
  return value
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
}

async function direct(token: string): Promise<void> {
  const workingDirectory = resolve(core.getInput('working-directory'))
  const tool = detectBuildTool(workingDirectory, core.getInput('build-tool'))
  const scriptDirectory = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'sonar-fork-analysis-'))
  const initScript = join(scriptDirectory, 'sonar.init.gradle.kts')
  writeFileSync(initScript, gradleInitScript(core.getInput('gradle-plugin-version')))

  const args = directArguments(
    tool,
    {
      hostUrl: core.getInput('sonar-host-url'),
      projectKey: core.getInput('project-key', { required: true }),
      organization: core.getInput('sonar-organization'),
    },
    { maven: core.getInput('maven-plugin-version'), gradle: core.getInput('gradle-plugin-version') },
    lines(core.getInput('build-arguments')),
    initScript,
  )

  core.info(`Analysing the ${tool.name} build in ${workingDirectory}`)
  // The token goes through the environment, which the scanner reads, so it never shows up in a command line.
  await exec(tool.executable, args, {
    cwd: workingDirectory,
    env: { ...process.env, SONAR_TOKEN: token } as Record<string, string>,
  })
}

async function run(): Promise<void> {
  const token = core.getInput('sonar-token')
  if (token) core.setSecret(token)

  const resolution = resolveMode(core.getInput('mode'), process.env.GITHUB_EVENT_NAME ?? '', token)
  if ('skip' in resolution) {
    core.notice(resolution.skip)
    return
  }
  core.info(`Mode: ${resolution.mode}`)

  switch (resolution.mode) {
    case 'direct':
      return direct(token)
    case 'prepare':
    case 'analyze':
      throw new Error(`Mode '${resolution.mode}' is not implemented yet`)
  }
}

run().catch(error => core.setFailed(error instanceof Error ? error.message : String(error)))
