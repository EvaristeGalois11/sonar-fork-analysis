export type Mode = 'direct' | 'prepare' | 'analyze'

export type Resolution = { mode: Mode; warning?: string } | { skip: string }

const MODES = ['auto', 'direct', 'prepare', 'analyze']

export function resolveMode(
  requested: string,
  eventName: string,
  token: string
): Resolution {
  if (!MODES.includes(requested)) {
    throw new Error(
      `Unknown mode '${requested}', expected one of: ${MODES.join(', ')}`
    )
  }

  let mode: Mode
  if (requested === 'auto') {
    if (eventName === 'workflow_run') return { mode: 'analyze' }
    // GitHub expands secrets to an empty string for pull requests from forks.
    mode = token ? 'direct' : 'prepare'
  } else {
    mode = requested as Mode
  }
  if (mode !== 'direct') return { mode }

  if (eventName === 'pull_request_target') {
    // The token is available there, and a checkout of the pull request head would hand it to the
    // fork's build. Refuse instead of analysing.
    throw new Error(
      'Refusing to build with the Sonar token on pull_request_target; trigger the build on pull_request instead.'
    )
  }
  if (!token) {
    if (eventName === 'pull_request') {
      return {
        skip: 'No Sonar token available (pull request from a fork or Dependabot), skipping the direct analysis.'
      }
    }
    throw new Error('No Sonar token available, set the sonar-token input.')
  }
  if (eventName === 'workflow_run') {
    return {
      mode,
      warning:
        'Direct analysis on workflow_run builds the checked-out code with the Sonar token; make sure it is not code from a fork.'
    }
  }
  return { mode }
}
