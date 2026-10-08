type Mode = 'direct' | 'prepare' | 'analyze'

export type Resolution = { mode: Mode; warning?: string }

const MODES = ['auto', 'direct', 'prepare', 'analyze']

// Events that run with the base repository's secrets and write token. Building a pull request
// there would hand those to its code, which is exactly what this action exists to avoid.
const PRIVILEGED_EVENTS = new Set(['pull_request_target', 'issue_comment'])

// untrustedRun: on workflow_run, whether the run it follows built a pull request's code, another
// repository's or a bot's.
export function resolveMode(
  requested: string,
  eventName: string,
  token: string,
  untrustedRun: boolean
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
  return checkBuild(mode, eventName, token, untrustedRun)
}

// Whether a mode that builds may build on this event.
function checkBuild(
  mode: 'direct' | 'prepare',
  eventName: string,
  token: string,
  untrustedRun: boolean
): Resolution {
  if (
    PRIVILEGED_EVENTS.has(eventName) ||
    (mode === 'prepare' && eventName === 'workflow_run')
  ) {
    throw new Error(
      `Refusing to build on ${eventName}, which runs with the repository's secrets; trigger the build on pull_request instead.`
    )
  }
  if (mode === 'prepare') {
    // Leaving it out of the build's environment doesn't help: a process of the same user can read
    // the action's own, e.g. from /proc.
    if (token)
      throw new Error(
        'The sonar-token input is set, but mode prepare must build without the token: the build could read it from the job. Remove sonar-token or use mode auto.'
      )
    return { mode }
  }
  if (!token) {
    throw new Error(
      'No Sonar token available, set the sonar-token input. On pull requests from forks, use mode auto.'
    )
  }
  if (eventName !== 'workflow_run') return { mode }
  if (untrustedRun)
    throw new Error(
      "Refusing to build on workflow_run after a run of a pull request, another repository or a bot: the build would run with the repository's secrets. Use mode auto to analyse it."
    )
  return {
    mode,
    warning:
      'Direct analysis on workflow_run builds the checked-out code with the Sonar token; make sure it is not code from a fork.'
  }
}
