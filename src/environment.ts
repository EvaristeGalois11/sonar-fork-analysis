// Hygiene, not a boundary: a process of the same user can still read the action's own environment,
// e.g. from /proc. What must not reach a process must not be in the job at all.

// The job's environment without the action's inputs, the Sonar token and the GitHub token among
// them, which a step of its own wouldn't see either.
export function jobEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !entry[0].startsWith('INPUT_')
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

// For tools that read the pull request's content, which need neither the runtime's tokens, nor the
// files through which a step talks to the runner, nor a GitHub token.
export function toolEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(jobEnvironment()).filter(
      ([name]) => !name.startsWith('ACTIONS_') && !RUNNER_FILES.has(name)
    )
  )
}
