import * as core from '@actions/core'

export type State = 'pending' | 'success' | 'failure'

export type StatusTarget = {
  apiUrl: string
  repository: string
  sha: string
  token: string
  // The status's name on the commit.
  name: string
  // Where the status links to: this run.
  url: string
}

// Resolves to whether GitHub took the status.
export type Reporter = (state: State, description: string) => Promise<boolean>

// A workflow_run run does not show among a pull request's checks, so a failed analysis would go
// unnoticed; a status on the analysed commit does show. A token without statuses: write is the way to
// turn it off, so that is not a problem, and nothing here ever fails the analysis.
export function statusReporter(target: StatusTarget): Reporter {
  let enabled = true
  return async (state, description) => {
    if (!enabled) return false
    const url = `${target.apiUrl}/repos/${target.repository}/statuses/${target.sha}`
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${target.token}`
        },
        body: JSON.stringify({
          state,
          // GitHub rejects longer descriptions.
          description:
            description.length > 140
              ? `${description.slice(0, 139)}…`
              : description,
          context: target.name,
          target_url: target.url
        })
      })
    } catch (error) {
      core.warning(
        `Could not post the ${target.name} status: ${error instanceof Error ? error.message : String(error)}`
      )
      return false
    }
    if (response.status === 401 || response.status === 403) {
      enabled = false
      core.info(
        `Not posting the ${target.name} status: the token lacks statuses: write`
      )
    } else if (!response.ok) {
      core.warning(
        `Could not post the ${target.name} status: GitHub answered ${response.status}`
      )
    }
    return response.ok
  }
}

export const noReporter: Reporter = async () => false

const PENDING = 'pending-status'

// Remembered for the post step, which runs even when the job is cancelled or times out. The token
// stays out of the saved state: the post step reads it from the inputs again.
export function rememberPending(target: StatusTarget): void {
  core.saveState(PENDING, JSON.stringify({ ...target, token: undefined }))
}

export function forgetPending(): void {
  core.saveState(PENDING, '')
}

// The post step: a status still pending means the analysis was interrupted, or could not report.
export async function reportInterrupted(): Promise<void> {
  const saved = core.getState(PENDING)
  if (!saved) return
  const target = { ...JSON.parse(saved), token: core.getInput('github-token') }
  await statusReporter(target)(
    'failure',
    'The analysis ended without reporting its result'
  )
}
