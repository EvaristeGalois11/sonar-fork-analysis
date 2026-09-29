import { jest } from '@jest/globals'
import { resolveOrigin, type Context } from '../src/origin.js'

const base: Context = {
  eventName: '',
  event: {},
  repository: 'owner/repo',
  sha: 'merge-sha',
  refName: 'main',
  apiUrl: 'https://api.github.com',
  token: 'gh-token'
}

function workflowRun(event: string, headBranch = 'feature') {
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
          full_name: 'forker/repo',
          owner: { login: 'forker' }
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
      pullRequest: { key: '7', branch: 'feature', base: 'main' }
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
      await resolveOrigin({ ...base, ...workflowRun('push', 'release') })
    ).toEqual({
      runId: 42,
      repository: 'forker/repo',
      headSha: 'head-sha',
      branch: 'release'
    })
    expect(
      await resolveOrigin({ ...base, ...workflowRun('push', 'main') })
    ).toEqual({
      runId: 42,
      repository: 'forker/repo',
      headSha: 'head-sha'
    })
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
      pullRequest: { key: '9', branch: 'topic', base: 'main' }
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
