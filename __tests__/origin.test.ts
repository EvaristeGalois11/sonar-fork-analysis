import { jest } from '@jest/globals'
import {
  choosePullRequest,
  resolveOrigin,
  type Context
} from '../src/origin.js'

const base: Context = {
  eventName: '',
  event: {},
  repository: 'owner/repo',
  sha: 'merge-sha',
  refName: 'main',
  apiUrl: 'https://api.github.com',
  token: 'gh-token'
}

function workflowRun(
  event: string,
  headBranch: string | null = 'feature',
  headRepository = 'forker/repo'
) {
  return {
    eventName: 'workflow_run',
    event: {
      repository: { default_branch: 'main' },
      workflow_run: {
        id: 42,
        event,
        head_sha: 'head-sha',
        head_branch: headBranch,
        head_repository: {
          full_name: headRepository,
          owner: { login: headRepository.split('/')[0] }
        }
      }
    }
  }
}

afterEach(() => {
  jest.restoreAllMocks()
})

describe('resolveOrigin', () => {
  it('finds the pull request of a fork by its head', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            number: 3,
            head: { sha: 'old-sha', ref: 'feature' },
            base: { ref: 'main' }
          },
          {
            number: 7,
            head: { sha: 'head-sha', ref: 'feature' },
            base: { ref: 'main' }
          }
        ])
      )
    )

    const origin = await resolveOrigin({
      ...base,
      ...workflowRun('pull_request')
    })

    expect(origin).toEqual({
      runId: 42,
      repository: 'forker/repo',
      headSha: 'head-sha',
      pullRequests: [{ key: '7', branch: 'feature', base: 'main' }]
    })
    const [url, init] = fetch.mock.calls[0]
    expect(String(url)).toBe(
      'https://api.github.com/repos/owner/repo/pulls?state=open&head=forker%3Afeature&per_page=100'
    )
    expect(init!.headers).toMatchObject({ Authorization: 'Bearer gh-token' })
  })

  it('skips a pull request that has moved on since the build', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]'))

    const origin = await resolveOrigin({
      ...base,
      ...workflowRun('pull_request')
    })

    expect(origin).toHaveProperty('skip')
  })

  it('skips a run that names no branch to look the pull request up by', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch')

    const origin = await resolveOrigin({
      ...base,
      ...workflowRun('pull_request', null)
    })

    expect(origin).toEqual({
      skip: 'The run names no fork and branch to find its pull request by.'
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fails when GitHub refuses the lookup', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 403 }))

    await expect(
      resolveOrigin({ ...base, ...workflowRun('pull_request') })
    ).rejects.toThrow(/GitHub answered 403/)
  })

  it('analyses pushes to other branches as branches', async () => {
    expect(
      await resolveOrigin({
        ...base,
        ...workflowRun('push', 'release', 'owner/repo')
      })
    ).toEqual({
      runId: 42,
      repository: 'owner/repo',
      headSha: 'head-sha',
      branch: 'release'
    })
    expect(
      await resolveOrigin({
        ...base,
        ...workflowRun('push', 'main', 'owner/repo')
      })
    ).toEqual({
      runId: 42,
      repository: 'owner/repo',
      headSha: 'head-sha'
    })
  })

  it("skips a fork's run that is not for a pull request", async () => {
    // e.g. a workflow the pull request added, named like ours, on pull_request_review
    expect(
      await resolveOrigin({
        ...base,
        ...workflowRun('pull_request_review', 'main')
      })
    ).toHaveProperty('skip')
  })

  it('takes a pull request of the current run from the event', async () => {
    const origin = await resolveOrigin({
      ...base,
      eventName: 'pull_request',
      event: {
        pull_request: {
          number: 9,
          head: {
            sha: 'pr-head',
            ref: 'topic',
            repo: { full_name: 'owner/repo' }
          },
          base: { ref: 'main' }
        }
      }
    })
    expect(origin).toEqual({
      repository: 'owner/repo',
      headSha: 'pr-head',
      pullRequests: [{ key: '9', branch: 'topic', base: 'main' }]
    })
  })

  it('uses the pushed commit for the current run', async () => {
    expect(
      await resolveOrigin({
        ...base,
        eventName: 'push',
        event: { repository: { default_branch: 'main' } }
      })
    ).toEqual({ repository: 'owner/repo', headSha: 'merge-sha' })
  })
})

describe('choosePullRequest', () => {
  const toMain = { key: '7', branch: 'feature', base: 'main' }
  const toRelease = { key: '8', branch: 'feature', base: 'release' }

  it('takes the only candidate whatever the hint says', () => {
    expect(choosePullRequest([toMain], 1)).toEqual({ pullRequest: toMain })
  })

  it('has nothing to choose without candidates', () => {
    expect(() => choosePullRequest([], 7)).toThrow(
      'There is no open pull request to analyse'
    )
  })

  it('lets the hint choose among the candidates', () => {
    expect(choosePullRequest([toMain, toRelease], 8)).toEqual({
      pullRequest: toRelease
    })
  })

  it.each([undefined, 99, '8', 8.5])(
    'falls back to the first candidate, with a warning, for the hint %p',
    (hint) => {
      const choice = choosePullRequest([toMain, toRelease], hint)
      expect(choice.pullRequest).toBe(toMain)
      expect(choice.warning).toMatch(/2 open pull requests/)
    }
  )
})
