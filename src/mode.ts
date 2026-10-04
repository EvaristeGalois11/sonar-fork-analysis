type Mode = 'direct' | 'prepare' | 'analyze'

export type Resolution = { mode: Mode; warning?: string }

const MODES = ['auto', 'direct', 'prepare', 'analyze']

// Events that run with the base repository's secrets and write token. Building a pull request
// there would hand those to its code, which is exactly what this action exists to avoid.
const PRIVILEGED_EVENTS = new Set(['pull_request_target', 'issue_comment'])

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
  if (mode === 'analyze') return { mode }

  if (
    PRIVILEGED_EVENTS.has(eventName) ||
    (mode === 'prepare' && eventName === 'workflow_run')
  ) {
    throw new Error(
      `Refusing to build on ${eventName}, which runs with the repository's secrets; trigger the build on pull_request instead.`
    )
  }
  if (mode === 'direct' && !token) {
    throw new Error(
      'No Sonar token available, set the sonar-token input. On pull requests from forks, use mode auto.'
    )
  }
  if (mode === 'direct' && eventName === 'workflow_run') {
    return {
      mode,
      warning:
        'Direct analysis on workflow_run builds the checked-out code with the Sonar token; make sure it is not code from a fork.'
    }
  }
  return { mode }
}
