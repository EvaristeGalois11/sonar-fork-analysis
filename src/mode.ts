export type Mode = 'direct' | 'prepare' | 'analyze'

export type Resolution = { mode: Mode } | { skip: string }

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
  if (requested === 'auto') {
    if (eventName === 'workflow_run') return { mode: 'analyze' }
    // GitHub expands secrets to an empty string for pull requests from forks.
    return { mode: token ? 'direct' : 'prepare' }
  }
  if (requested === 'direct' && !token) {
    return {
      skip: 'No Sonar token available (pull request from a fork?), skipping the direct analysis.'
    }
  }
  return { mode: requested as Mode }
}
