import * as core from '@actions/core'

// Mirrors the defaults in action.yml. They are repeated here because an input passed explicitly as
// an empty string (e.g. a reusable workflow forwarding an unset input) does not get the default.
export const DEFAULTS: Record<string, string> = {
  mode: 'auto',
  'working-directory': '.',
  'build-tool': 'auto'
}

export type Inputs = {
  mode: string
  workingDirectory: string
  buildTool: string
  buildGoals: string[]
  buildArguments: string[]
  projectKey: string
  organization: string
  hostUrl: string
  token: string
}

function input(name: string): string {
  return core.getInput(name) || DEFAULTS[name] || ''
}

export function readInputs(): Inputs {
  return {
    mode: input('mode'),
    workingDirectory: input('working-directory'),
    buildTool: input('build-tool'),
    buildGoals: core.getMultilineInput('build-goals'),
    buildArguments: core.getMultilineInput('build-arguments'),
    projectKey: input('project-key'),
    organization: input('sonar-organization'),
    hostUrl: input('sonar-host-url'),
    token: input('sonar-token')
  }
}
