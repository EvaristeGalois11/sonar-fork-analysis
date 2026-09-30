import { jest } from '@jest/globals'
import * as core from '../__fixtures__/core.js'

jest.unstable_mockModule('@actions/core', () => core)

const { statusReporter } = await import('../src/status.js')

const target = {
  apiUrl: 'https://api.github.com',
  repository: 'owner/repo',
  sha: 'head-sha',
  token: 'gh-token',
  name: 'Sonar fork analysis (maven)',
  url: 'https://github.com/owner/repo/actions/runs/42'
}

let fetch: jest.SpiedFunction<typeof globalThis.fetch>

beforeEach(() => {
  fetch = jest.spyOn(globalThis, 'fetch')
})

afterEach(() => {
  jest.restoreAllMocks()
  jest.clearAllMocks()
})

function sent(call = 0): Record<string, string> {
  return JSON.parse(String(fetch.mock.calls[call][1]!.body))
}

describe('statusReporter', () => {
  it('posts the state on the analysed commit, linking to the run', async () => {
    fetch.mockResolvedValue(new Response('{}', { status: 201 }))

    await statusReporter(target)('success', 'Analysed')

    const [url, init] = fetch.mock.calls[0]
    expect(String(url)).toBe(
      'https://api.github.com/repos/owner/repo/statuses/head-sha'
    )
    expect(init!.method).toBe('POST')
    expect(init!.headers).toMatchObject({ Authorization: 'Bearer gh-token' })
    expect(sent()).toEqual({
      state: 'success',
      description: 'Analysed',
      context: 'Sonar fork analysis (maven)',
      target_url: 'https://github.com/owner/repo/actions/runs/42'
    })
    expect(core.warning).not.toHaveBeenCalled()
  })

  it('keeps descriptions within what GitHub accepts', async () => {
    fetch.mockResolvedValue(new Response('{}', { status: 201 }))

    await statusReporter(target)('failure', 'x'.repeat(200))

    expect(sent().description).toHaveLength(140)
  })

  it('stops quietly when the token may not post statuses', async () => {
    fetch.mockResolvedValue(new Response('{}', { status: 403 }))
    const report = statusReporter(target)

    await report('pending', 'Analysing')
    await report('success', 'Analysed')

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('lacks statuses: write')
    )
    expect(core.warning).not.toHaveBeenCalled()
  })

  it('warns, without failing, when GitHub cannot take the status', async () => {
    fetch
      .mockResolvedValueOnce(new Response('', { status: 502 }))
      .mockRejectedValueOnce(new Error('network down'))
    const report = statusReporter(target)

    await report('pending', 'Analysing')
    await report('success', 'Analysed')

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('GitHub answered 502')
    )
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('network down')
    )
  })
})
