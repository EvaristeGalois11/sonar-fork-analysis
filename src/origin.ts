export type PullRequest = { key: string; branch: string; base: string }

export type Origin = {
  // The run holding the prepared artifact; undefined for the current run.
  runId?: number
  // The repository holding the analysed commit: the fork, for a pull request from one.
  repository: string
  headSha: string
  pullRequest?: PullRequest
  // Set for branches other than the default one, which Sonar analyses as branches.
  branch?: string
}

export type Context = {
  eventName: string
  // The webhook payload of the event that started the workflow.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  event: any
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
async function findPullRequest(
  context: Context,
  owner: string,
  branch: string,
  sha: string
): Promise<PullRequest | undefined> {
  const query = new URLSearchParams({
    state: 'open',
    head: `${owner}:${branch}`,
    per_page: '100'
  })
  const response = await fetch(
    `${context.apiUrl}/repos/${context.repository}/pulls?${query}`,
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
  const found = ((await response.json()) as ApiPullRequest[]).find(
    (pull) => pull.head.sha === sha
  )
  return (
    found && {
      key: String(found.number),
      branch: found.head.ref,
      base: found.base.ref
    }
  )
}

export async function resolveOrigin(
  context: Context
): Promise<Origin | { skip: string }> {
  const { eventName, event } = context
  if (eventName === 'workflow_run') {
    const run = event.workflow_run
    const origin: Origin = {
      runId: run.id,
      repository: run.head_repository.full_name,
      headSha: run.head_sha
    }
    if (run.event === 'pull_request') {
      origin.pullRequest = await findPullRequest(
        context,
        run.head_repository.owner.login,
        run.head_branch,
        run.head_sha
      )
      if (!origin.pullRequest) {
        return {
          skip: `No open pull request has ${run.head_sha} as its head any more; a newer run analyses it.`
        }
      }
    } else if (run.head_branch !== event.repository.default_branch) {
      origin.branch = run.head_branch
    }
    return origin
  }
  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    const pull = event.pull_request
    return {
      repository: pull.head.repo.full_name,
      headSha: pull.head.sha,
      pullRequest: {
        key: String(pull.number),
        branch: pull.head.ref,
        base: pull.base.ref
      }
    }
  }
  const origin: Origin = {
    repository: context.repository,
    headSha: context.sha
  }
  if (context.refName !== event.repository?.default_branch)
    origin.branch = context.refName
  return origin
}
