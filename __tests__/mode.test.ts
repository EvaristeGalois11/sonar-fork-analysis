import { describe, it, expect } from 'vitest'
import { resolveMode as resolveModeOf } from '../src/mode.js'

// After a push to this repository, unless a test says otherwise.
const resolveMode = (
  requested: string,
  eventName: string,
  token: string,
  untrustedRun = false
) => resolveModeOf(requested, eventName, token, untrustedRun)

describe('resolveMode', () => {
  it('analyses directly when the token is available', () => {
    expect(resolveMode('auto', 'pull_request', 'token')).toEqual({
      mode: 'direct'
    })
    expect(resolveMode('auto', 'push', 'token')).toEqual({ mode: 'direct' })
  })

  it('prepares when the token is empty, as on pull requests from forks', () => {
    expect(resolveMode('auto', 'pull_request', '')).toEqual({
      mode: 'prepare'
    })
  })

  it('analyses the artifact on workflow_run, token or not', () => {
    expect(resolveMode('auto', 'workflow_run', 'token')).toEqual({
      mode: 'analyze'
    })
    expect(resolveMode('auto', 'workflow_run', '')).toEqual({
      mode: 'analyze'
    })
  })

  it('honours a forced mode', () => {
    expect(resolveMode('direct', 'push', 'token')).toEqual({ mode: 'direct' })
    expect(resolveMode('prepare', 'push', '')).toEqual({ mode: 'prepare' })
    expect(resolveMode('analyze', 'push', 'token')).toEqual({
      mode: 'analyze'
    })
  })

  it('fails a forced direct analysis without a token, pull requests included', () => {
    for (const event of ['push', 'pull_request', 'workflow_run'])
      expect(() => resolveMode('direct', event, '')).toThrow(
        /No Sonar token available/
      )
  })

  it.each(['pull_request_target', 'issue_comment'])(
    'refuses to build on %s in any building mode',
    (event) => {
      for (const [mode, token] of [
        ['auto', 'token'],
        ['auto', ''],
        ['direct', 'token'],
        ['prepare', '']
      ])
        expect(() => resolveMode(mode, event, token)).toThrow(
          /Refusing to build/
        )
    }
  )

  it('refuses a forced prepare with the Sonar token in the job', () => {
    for (const event of ['push', 'pull_request'])
      expect(() => resolveMode('prepare', event, 'token')).toThrow(
        /the build could read it from the job/
      )
  })

  it('refuses a forced prepare on workflow_run', () => {
    expect(() => resolveMode('prepare', 'workflow_run', '')).toThrow(
      /Refusing to build on workflow_run/
    )
  })

  it('allows analyze on privileged events, as it builds nothing', () => {
    expect(resolveMode('analyze', 'pull_request_target', 'token')).toEqual({
      mode: 'analyze'
    })
  })

  it("refuses a forced direct analysis of a pull request's code on workflow_run", () => {
    expect(() => resolveMode('direct', 'workflow_run', 'token', true)).toThrow(
      /Refusing to build on workflow_run after a run of a pull request/
    )
    expect(resolveMode('auto', 'workflow_run', 'token', true)).toEqual({
      mode: 'analyze'
    })
  })

  it('warns about a forced direct analysis on workflow_run', () => {
    expect(resolveMode('direct', 'workflow_run', 'token')).toEqual({
      mode: 'direct',
      warning: expect.stringContaining('fork')
    })
  })

  it('rejects unknown modes', () => {
    expect(() => resolveMode('fast', 'push', 'token')).toThrow(
      /Unknown mode 'fast'/
    )
  })
})
