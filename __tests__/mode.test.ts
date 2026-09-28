import { resolveMode } from '../src/mode.js'

describe('resolveMode', () => {
  it('analyses directly when the token is available', () => {
    expect(resolveMode('auto', 'pull_request', 'token')).toEqual({
      mode: 'direct'
    })
    expect(resolveMode('auto', 'push', 'token')).toEqual({ mode: 'direct' })
  })

  it('prepares when the token is empty, as on pull requests from forks', () => {
    expect(resolveMode('auto', 'pull_request', '')).toEqual({ mode: 'prepare' })
  })

  it('analyses the artifact on workflow_run, token or not', () => {
    expect(resolveMode('auto', 'workflow_run', 'token')).toEqual({
      mode: 'analyze'
    })
  })

  it('honours a forced mode', () => {
    expect(resolveMode('prepare', 'push', 'token')).toEqual({ mode: 'prepare' })
    expect(resolveMode('analyze', 'push', 'token')).toEqual({ mode: 'analyze' })
  })

  it('skips a forced direct analysis without a token', () => {
    expect(resolveMode('direct', 'pull_request', '')).toHaveProperty('skip')
  })

  it('rejects unknown modes', () => {
    expect(() => resolveMode('fast', 'push', 'token')).toThrow(
      /Unknown mode 'fast'/
    )
  })
})
