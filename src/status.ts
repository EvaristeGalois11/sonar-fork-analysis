import * as core from '@actions/core'
import { readFileSync } from 'node:fs'
import type { WorkflowRunEvent } from './origin.js'

type State = 'pending' | 'success' | 'failure'

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
    // GitHub's rate limits answer 403 as well, but say when to retry.
    const limited =
      response.headers.has('retry-after') ||
      response.headers.get('x-ratelimit-remaining') === '0'
    if ((response.status === 401 || response.status === 403) && !limited) {
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

export const noReporter: Reporter = () => Promise.resolve(false)

const NOTE = 'pending-status'

type Note = { state: State; description: string }
const INTERRUPTED = 'The analysis ended without reporting its result'

// The note is from the main step to the post step, which runs even when the job is cancelled or
// times out: what the status should end as, until GitHub has taken the final one.
function leaveNote(state: State, description: string) {
  core.saveState(NOTE, JSON.stringify({ state, description } satisfies Note))
}

function clearNote(): void {
  core.saveState(NOTE, '')
}

// A reporter whose last word reaches GitHub: the note is left before each post, so a job interrupted
// mid-way, or a final status GitHub refused, is still closed by the post step.
export function trackedReporter(target: StatusTarget): Reporter {
  const report = statusReporter(target)
  let open = false
  return async (state, description) => {
    if (state === 'pending') {
      leaveNote('failure', INTERRUPTED)
      open = await report(state, description)
      if (!open) clearNote()
      return open
    }
    if (open) leaveNote(state, description)
    const taken = await report(state, description)
    if (taken) clearNote()
    return taken
  }
}

// Where a workflow_run analysis reports. It all comes from the runner and the inputs, never from
// anything the analysis could rewrite.
export function runStatusTarget(): StatusTarget | undefined {
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (process.env.GITHUB_EVENT_NAME !== 'workflow_run' || !eventPath)
    return undefined
  const repository = process.env.GITHUB_REPOSITORY ?? ''
  const projectKey = core.getInput('project-key')
  return {
    apiUrl: process.env.GITHUB_API_URL ?? 'https://api.github.com',
    repository,
    sha: (JSON.parse(readFileSync(eventPath, 'utf8')) as WorkflowRunEvent)
      .workflow_run.head_sha,
    token: core.getInput('github-token'),
    name: projectKey
      ? `Sonar fork analysis (${projectKey})`
      : 'Sonar fork analysis',
    url: `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID ?? ''}`
  }
}

// The post step: a note left means GitHub never took the final status.
export async function reportInterrupted(): Promise<void> {
  const saved = core.getState(NOTE)
  const target = runStatusTarget()
  if (!saved || !target) return
  const note = readNote(saved)
  if (!note) {
    core.warning('Not posting the final status: its note is damaged')
    return
  }
  await statusReporter(target)(note.state, note.description)
}

function readNote(saved: string): Note | undefined {
  try {
    const note = JSON.parse(saved) as Note
    return (note.state === 'success' || note.state === 'failure') &&
      typeof note.description === 'string'
      ? note
      : undefined
  } catch {
    return undefined
  }
}
