import { jest } from '@jest/globals'
import * as core from '../__fixtures__/core.js'

jest.unstable_mockModule('@actions/core', () => core)

const { reportInterrupted, statusReporter, trackedReporter } =
  await import('../src/status.js')

const target = {
  apiUrl: 'https://api.github.com',
  repository: 'owner/repo',
  sha: 'head-sha',
  token: 'gh-token',
  name: 'Sonar fork analysis (acme_app)',
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
      context: 'Sonar fork analysis (acme_app)',
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

describe('trackedReporter', () => {
  function note(call = -1): Record<string, string> | '' {
    const value = core.saveState.mock.calls.at(call)![1] as string
    return value && JSON.parse(value)
  }

  it('leaves the post step a failure while the analysis runs, and nothing once it ended', async () => {
    fetch.mockImplementation(async () => new Response('{}', { status: 201 }))
    const report = trackedReporter(target)

    await report('pending', 'Analysing')
    expect(note()).toMatchObject({
      sha: 'head-sha',
      state: 'failure',
      description: 'The analysis ended without reporting its result'
    })
    expect(JSON.stringify(note())).not.toContain('gh-token')

    await report('success', 'Analysed')
    expect(note()).toBe('')
  })

  it('leaves the refused final status for the post step to retry', async () => {
    fetch
      .mockResolvedValueOnce(new Response('{}', { status: 201 }))
      .mockResolvedValueOnce(new Response('', { status: 502 }))
    const report = trackedReporter(target)

    await report('pending', 'Analysing')
    await report('success', 'Analysed')

    expect(note()).toMatchObject({ state: 'success', description: 'Analysed' })
  })

  it('leaves nothing when no status could be opened', async () => {
    fetch.mockResolvedValue(new Response('{}', { status: 403 }))
    const report = trackedReporter(target)

    await report('pending', 'Analysing')
    await report('success', 'Analysed')

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(note()).toBe('')
  })
})

describe('the post step', () => {
  it('posts what the note says, with the token from the inputs', async () => {
    fetch.mockResolvedValue(new Response('{}', { status: 201 }))
    core.getState.mockReturnValue(
      JSON.stringify({
        ...target,
        token: undefined,
        state: 'success',
        description: 'Analysed'
      })
    )
    core.getInput.mockReturnValue('input-token')

    await reportInterrupted()

    expect(sent()).toMatchObject({
      state: 'success',
      description: 'Analysed',
      context: 'Sonar fork analysis (acme_app)'
    })
    expect(fetch.mock.calls[0][1]!.headers).toMatchObject({
      Authorization: 'Bearer input-token'
    })
  })

  it('does nothing without a note', async () => {
    core.getState.mockReturnValue('')

    await reportInterrupted()

    expect(fetch).not.toHaveBeenCalled()
  })
})
