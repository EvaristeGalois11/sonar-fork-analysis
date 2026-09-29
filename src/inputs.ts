import * as core from '@actions/core'

// Mirrors the defaults in action.yml. They are repeated here because an input passed explicitly as
// an empty string (e.g. a reusable workflow forwarding an unset input) does not get the default.
export const DEFAULTS: Record<string, string> = {
  mode: 'auto',
  'working-directory': '.',
  'build-tool': 'auto',
  checkout: 'true'
}

export type Inputs = {
  mode: string
  id: string
  workingDirectory: string
  buildTool: string
  buildGoals: string[]
  buildArguments: string[]
  projectKey: string
  organization: string
  hostUrl: string
  token: string
  githubToken: string
  checkout: boolean
}

function input(name: string): string {
  return core.getInput(name) || DEFAULTS[name] || ''
}

function flag(name: string): boolean {
  const value = input(name).toLowerCase()
  if (value !== 'true' && value !== 'false')
    throw new Error(`Input ${name} must be true or false, not '${value}'`)
  return value === 'true'
}

// getMultilineInput drops empty lines before trimming, so whitespace-only lines would survive as
// empty arguments.
function lines(name: string): string[] {
  return core.getMultilineInput(name).filter((line) => line.length > 0)
}

export function readInputs(): Inputs {
  return {
    mode: input('mode'),
    id: input('id'),
    workingDirectory: input('working-directory'),
    buildTool: input('build-tool'),
    buildGoals: lines('build-goals'),
    buildArguments: lines('build-arguments'),
    projectKey: input('project-key'),
    organization: input('sonar-organization'),
    hostUrl: input('sonar-host-url'),
    token: input('sonar-token'),
    githubToken: input('github-token'),
    checkout: flag('checkout')
  }
}
