import type { components } from '@octokit/openapi-webhooks-types'

// The payloads the action reads, as GitHub documents them. GitHub writes the file, so its shape is
// trusted; the values in it may still come from a fork.
export type WorkflowRunEvent =
  components['schemas']['webhook-workflow-run-completed']
export type PullRequestEvent =
  components['schemas']['webhook-pull-request-synchronize']
type RepositoryEvent = { repository?: { default_branch?: string } }

export type PullRequest = { key: string; branch: string; base: string }

export type Origin = {
  // The run holding the prepared artifact; undefined for the current run.
  runId?: number
  // The repository holding the analysed commit: the fork, for a pull request from one.
  repository: string
  headSha: string
  // The open pull requests with this head; usually one.
  pullRequests?: PullRequest[]
  // Set for branches other than the default one, which Sonar analyses as branches.
  branch?: string
}

export type Context = {
  eventName: string
  // The webhook payload of the event that started the workflow, as eventName says.
  event: unknown
  repository: string
  sha: string
  refName: string
  apiUrl: string
  token: string
}

type ApiPullRequest = {
  number: number
  head: { sha: string; ref: string }
  base: { ref: string }
}

// workflow_run payloads carry no pull request for forks, so it is looked up by its head.
async function findPullRequests(
  context: Context,
  owner: string,
  branch: string,
  sha: string
): Promise<PullRequest[]> {
  const query = new URLSearchParams({
    state: 'open',
    head: `${owner}:${branch}`,
    per_page: '100'
  })
  const response = await fetch(
    `${context.apiUrl}/repos/${context.repository}/pulls?${query.toString()}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${context.token}`
      }
    }
  )
  if (!response.ok) {
    throw new Error(
      `Could not look up the pull request: GitHub answered ${response.status}`
    )
  }
  return ((await response.json()) as ApiPullRequest[])
    .filter((pull) => pull.head.sha === sha)
    .map((pull) => ({
      key: String(pull.number),
      branch: pull.head.ref,
      base: pull.base.ref
    }))
}

// The hint comes from the artifact, i.e. from the fork: it may only choose among the pull requests
// already matched by their head, never name another one.
export function choosePullRequest(
  candidates: PullRequest[],
  hint: unknown
): { pullRequest: PullRequest; warning?: string } {
  const hinted = candidates.find((pull) => pull.key === usableHint(hint))
  if (hinted) return { pullRequest: hinted }
  const [first] = candidates
  if (!first) throw new Error('There is no open pull request to analyse')
  return candidates.length > 1
    ? {
        pullRequest: first,
        warning: `${candidates.length} open pull requests have this head, analysing #${first.key}`
      }
    : { pullRequest: first }
}

function usableHint(hint: unknown): string | undefined {
  return typeof hint === 'number' && Number.isSafeInteger(hint) && hint > 0
    ? String(hint)
    : undefined
}

// The pull request the build names, when it's none of the candidates: closed, or moved on to newer
// commits. Another candidate would get results built for a different base.
export function goneHint(
  candidates: PullRequest[],
  hint: unknown
): number | undefined {
  const key = usableHint(hint)
  return key && !candidates.some((pull) => pull.key === key)
    ? Number(key)
    : undefined
}

// The hint comes from the fork. A green "skipped" status needs a pull request that really had this
// head and has moved on.
export async function pullRequestGone(
  context: Context,
  head: { repository: string; branch: string; sha: string },
  number: number
): Promise<boolean> {
  const response = await fetch(
    `${context.apiUrl}/repos/${context.repository}/pulls/${String(number)}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${context.token}`
      }
    }
  )
  if (response.status === 404) return false
  if (!response.ok) {
    throw new Error(
      `Could not look up the pull request: GitHub answered ${response.status}`
    )
  }
  const pull = (await response.json()) as {
    state: string
    head: { sha: string; ref: string; repo: { full_name: string } | null }
  }
  return (
    pull.head.repo?.full_name.toLowerCase() === head.repository.toLowerCase() &&
    pull.head.ref === head.branch &&
    (pull.state === 'closed' || pull.head.sha !== head.sha)
  )
}

export async function resolveOrigin(
  context: Context
): Promise<Origin | { skip: string }> {
  const { eventName, event } = context
  if (eventName === 'workflow_run') {
    const run = (event as WorkflowRunEvent).workflow_run
    const origin: Origin = {
      runId: run.id,
      repository: run.head_repository.full_name,
      headSha: run.head_sha
    }
    if (run.event === 'pull_request') {
      // GitHub's schema allows a run without a branch, which leaves nothing to look the pull request
      // up by; the owner may be missing too, but the repository's full name always has it.
      if (!run.head_branch)
        return {
          skip: 'The run names no branch to find its pull request by.'
        }
      const [owner = ''] = run.head_repository.full_name.split('/')
      origin.pullRequests = await findPullRequests(
        context,
        owner,
        run.head_branch,
        run.head_sha
      )
      if (origin.pullRequests.length === 0) {
        return {
          skip: `No open pull request has ${run.head_sha} as its head any more; a newer run analyses it.`
        }
      }
    } else if (
      run.head_repository.full_name.toLowerCase() !==
      context.repository.toLowerCase()
    ) {
      // A fork's pull request can add a workflow with the same name on another event; its branch
      // must not pass for one of ours.
      return {
        skip: `The run analyses ${run.head_repository.full_name}, not this repository, and is not for a pull request.`
      }
    } else if (
      run.head_branch &&
      run.head_branch !== (event as WorkflowRunEvent).repository.default_branch
    ) {
      origin.branch = run.head_branch
    }
    return origin
  }
  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    const pull = (event as PullRequestEvent).pull_request
    return {
      repository: pull.head.repo.full_name,
      headSha: pull.head.sha,
      pullRequests: [
        {
          key: String(pull.number),
          branch: pull.head.ref,
          base: pull.base.ref
        }
      ]
    }
  }
  const origin: Origin = {
    repository: context.repository,
    headSha: context.sha
  }
  if (context.refName !== (event as RepositoryEvent).repository?.default_branch)
    origin.branch = context.refName
  return origin
}
