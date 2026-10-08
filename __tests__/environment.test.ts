import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { jobEnvironment, toolEnvironment } from '../src/environment.js'

const RUNNER_FILES = [
  'GITHUB_ENV',
  'GITHUB_OUTPUT',
  'GITHUB_PATH',
  'GITHUB_STATE',
  'GITHUB_STEP_SUMMARY'
]

describe('environments', () => {
  const saved = { ...process.env }

  beforeEach(() => {
    process.env['INPUT_SONAR-TOKEN'] = 'sonar'
    process.env['INPUT_GITHUB-TOKEN'] = 'github'
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'oidc'
    for (const name of RUNNER_FILES) process.env[name] = `/runner/${name}`
    process.env.GITHUB_TOKEN = 'set by the workflow'
    process.env.JAVA_HOME = '/java'
  })

  afterEach(() => {
    process.env = { ...saved }
  })

  it("gives a build the job's environment without the action's inputs", () => {
    const env = jobEnvironment()
    expect(
      Object.keys(env).filter((name) => name.startsWith('INPUT_'))
    ).toEqual([])
    expect(env).toMatchObject({
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc',
      GITHUB_STEP_SUMMARY: '/runner/GITHUB_STEP_SUMMARY',
      GITHUB_TOKEN: 'set by the workflow',
      JAVA_HOME: '/java'
    })
  })

  it('gives a tool reading the pull request no tokens nor runner files', () => {
    const env = toolEnvironment()
    expect(
      Object.keys(env).filter(
        (name) => name.startsWith('INPUT_') || name.startsWith('ACTIONS_')
      )
    ).toEqual([])
    for (const name of RUNNER_FILES) expect(env[name]).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.JAVA_HOME).toBe('/java')
  })
})
