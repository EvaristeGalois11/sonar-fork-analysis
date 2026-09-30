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

export type Reporter = (state: State, description: string) => Promise<void>

// A workflow_run run does not show among a pull request's checks, so a failed analysis would go
// unnoticed; a status on the analysed commit does show. A token without statuses: write is the way to
// turn it off, so that is not a problem, and nothing here ever fails the analysis.
export function statusReporter(target: StatusTarget): Reporter {
  let enabled = true
  return async (state, description) => {
    if (!enabled) return
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
      return
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
  }
}

export const noReporter: Reporter = async () => {}
