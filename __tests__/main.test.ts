import { jest } from '@jest/globals'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as artifact from '../__fixtures__/artifact.js'
import * as core from '../__fixtures__/core.js'
import { exec, getExecOutput } from '../__fixtures__/exec.js'

// Mocks must be declared before the module under test is imported.
jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('@actions/exec', () => ({ exec, getExecOutput }))
jest.unstable_mockModule('../src/scanner.js', () => ({
  installScanner: async () => '/opt/sonar-scanner/bin/sonar-scanner'
}))
jest.unstable_mockModule('@actions/artifact', () => artifact)

const { run } = await import('../src/main.js')

const TOKEN = 'sqa_not_a_real_token'
let project: string
let inputs: Record<string, string>

let analyses = 0

function writeReport(directory: string): void {
  mkdirSync(join(directory, 'target', 'sonar'), { recursive: true })
  writeFileSync(
    join(directory, 'target', 'sonar', 'report-task.txt'),
    `ceTaskId=${++analyses}\n`
  )
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'main-'))
  writeFileSync(join(project, 'pom.xml'), '')
  inputs = {
    mode: 'auto',
    'working-directory': project,
    'project-key': 'key',
    'sonar-token': TOKEN
  }
  core.getInput.mockImplementation((name) => inputs[name] ?? '')
  core.getMultilineInput.mockImplementation((name) =>
    (inputs[name] ?? '').split('\n').filter((line) => line !== '')
  )
  process.env.GITHUB_EVENT_NAME = 'push'
})

afterEach(() => {
  jest.resetAllMocks()
  rmSync(project, { recursive: true, force: true })
})

describe('run', () => {
  const saved = { ...process.env }

  afterEach(() => {
    process.env = { ...saved }
  })

  it('passes the token only through the environment', async () => {
    exec.mockImplementation(async (_tool, _args, options) => {
      writeReport(options!.cwd!)
      return 0
    })

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(core.setSecret).toHaveBeenCalledWith(TOKEN)
    const [tool, args, options] = exec.mock.calls[0]
    expect(tool).toBe('mvn')
    expect(args!.join(' ')).not.toContain(TOKEN)
    expect(options!.env!.SONAR_TOKEN).toBe(TOKEN)
  })

  it('reports a failed build with its exit code', async () => {
    exec.mockResolvedValue(1)

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      'The Maven build failed with exit code 1'
    )
  })

  it('explains a Gradle build without the Sonar plugin', async () => {
    rmSync(join(project, 'pom.xml'))
    writeFileSync(join(project, 'settings.gradle.kts'), '')
    exec.mockImplementation(async (_tool, _args, options) => {
      options!.listeners!.stderr!(
        Buffer.from("Task 'sonar' not found in root project 'app'.")
      )
      return 1
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('apply the org.sonarqube plugin')
    )
  })

  it('fails when the build succeeded without an analysis', async () => {
    exec.mockResolvedValue(0)

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('no Sonar analysis ran')
    )
  })

  it('does not count a report left over from an earlier build', async () => {
    writeReport(project)
    exec.mockResolvedValue(0)

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('no Sonar analysis ran')
    )
  })

  it('notes the direct analysis for the fork path', async () => {
    process.env.ACTIONS_RUNTIME_TOKEN = 'runtime'
    // Set by GitHub in CI, where this test runs too.
    delete process.env.GITHUB_RETENTION_DAYS
    artifact.uploadArtifact.mockResolvedValue({ id: 1, size: 1 })
    exec.mockImplementation(async (_tool, _args, options) => {
      writeReport(options!.cwd!)
      return 0
    })

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    const [name, files, , options] = artifact.uploadArtifact.mock.calls[0]
    expect(name).toBe('sonar-fork-analysis-key+direct')
    expect(files).toHaveLength(1)
    expect(options).toEqual({ retentionDays: 35 })
    expect(core.notice).not.toHaveBeenCalled()
  })

  it('keeps the note no longer than a build can last', async () => {
    process.env.ACTIONS_RUNTIME_TOKEN = 'runtime'
    process.env.GITHUB_RETENTION_DAYS = '90'
    artifact.uploadArtifact.mockResolvedValue({ id: 1, size: 1 })
    exec.mockImplementation(async (_tool, _args, options) => {
      writeReport(options!.cwd!)
      return 0
    })

    await run()

    expect(artifact.uploadArtifact.mock.calls[0][3]).toEqual({
      retentionDays: 35
    })
    expect(core.notice).not.toHaveBeenCalled()
  })

  it('says when the repository keeps the note too briefly', async () => {
    process.env.ACTIONS_RUNTIME_TOKEN = 'runtime'
    process.env.GITHUB_RETENTION_DAYS = '7'
    artifact.uploadArtifact.mockResolvedValue({ id: 1, size: 1 })
    exec.mockImplementation(async (_tool, _args, options) => {
      writeReport(options!.cwd!)
      return 0
    })

    await run()

    expect(artifact.uploadArtifact.mock.calls[0][3]).toEqual({
      retentionDays: 7
    })
    expect(core.notice).toHaveBeenCalledWith(
      expect.stringContaining('keeps artifacts 7 days')
    )
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('still succeeds when the note cannot be left, explaining a name clash', async () => {
    process.env.ACTIONS_RUNTIME_TOKEN = 'runtime'
    artifact.uploadArtifact.mockRejectedValue(
      new Error('Received non-retryable error: Failed request: (409) Conflict')
    )
    exec.mockImplementation(async (_tool, _args, options) => {
      writeReport(options!.cwd!)
      return 0
    })

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('need distinct project keys')
    )
  })

  it('leaves no note where artifacts are not supported', async () => {
    process.env.ACTIONS_RUNTIME_TOKEN = 'runtime'
    artifact.uploadArtifact.mockRejectedValue(
      new artifact.GHESNotSupportedError('GHES')
    )
    exec.mockImplementation(async (_tool, _args, options) => {
      writeReport(options!.cwd!)
      return 0
    })

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(core.warning).not.toHaveBeenCalled()
  })

  it('fails a forced direct analysis without a token before building', async () => {
    inputs.mode = 'direct'
    inputs['sonar-token'] = ''

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('No Sonar token available')
    )
    expect(exec).not.toHaveBeenCalled()
    expect(core.setSecret).not.toHaveBeenCalled()
  })
})

describe('run in prepare mode', () => {
  const saved = { ...process.env }

  // Plays the Sonar plugin in simulation mode: writes the dump where it was asked to.
  function simulate(dump: string): void {
    exec.mockImplementation(async (_tool, args) => {
      const target = args!
        .find((arg) => arg.startsWith('-Dsonar.scanner.internal.dumpToFile='))!
        .split('=')[1]
      writeFileSync(target, dump)
      return 0
    })
  }

  beforeEach(() => {
    inputs['sonar-token'] = ''
    process.env.GITHUB_EVENT_NAME = 'pull_request'
    process.env.GITHUB_WORKSPACE = project
    process.env.RUNNER_TEMP = project
    process.env.ACTIONS_RUNTIME_TOKEN = 'runtime'
    process.env.SONAR_TOKEN = 'must-not-reach-the-build'
    artifact.uploadArtifact.mockResolvedValue({ id: 1, size: 1 })
  })

  afterEach(() => {
    process.env = { ...saved }
  })

  it('builds without the token and uploads only analysis settings', async () => {
    mkdirSync(join(project, 'target', 'classes'), { recursive: true })
    writeFileSync(join(project, 'target', 'classes', 'App.class'), '')
    simulate(
      [
        `sonar.projectBaseDir=${project}`,
        `sonar.java.binaries=${project}/target/classes`,
        'sonar.host.url=http\\://127.0.0.1\\:9',
        'env.SECRET=leaked'
      ].join('\n')
    )
    const event = join(project, 'event.json')
    writeFileSync(event, JSON.stringify({ pull_request: { number: 12 } }))
    process.env.GITHUB_EVENT_PATH = event

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(exec.mock.calls[0][2]!.env!.SONAR_TOKEN).toBeUndefined()
    const [name, files, staging, options] =
      artifact.uploadArtifact.mock.calls[0]
    expect(name).toBe('sonar-fork-analysis-key')
    expect(options).toEqual({ retentionDays: 1 })
    const settings = readFileSync(join(staging, 'settings.json'), 'utf8')
    expect(JSON.parse(settings).pullRequest).toBe(12)
    expect(JSON.parse(settings).settings).toEqual({
      'sonar.projectBaseDir': '{workspace}',
      'sonar.java.binaries': '{workspace}/target/classes'
    })
    expect(settings).not.toContain('leaked')
    expect(files).toContain(
      join(staging, 'workspace', 'target', 'classes', 'App.class')
    )
    expect(
      readdirSync(join(staging, '..')).filter((f) => f.endsWith('.properties'))
    ).toEqual([])
  })

  it('warns about the settings the analysis of pull requests leaves out', async () => {
    simulate(
      [
        `sonar.projectBaseDir=${project}`,
        'sonar.host.url=http\\://127.0.0.1\\:9',
        'sonar.nodejs.executable=/usr/bin/node',
        'env.SECRET=leaked'
      ].join('\n')
    )

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(core.warning).toHaveBeenCalledTimes(1)
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'leaves out these settings: sonar.nodejs.executable.'
      )
    )
    expect(core.info).toHaveBeenCalledWith(
      'Ignored 1 environment variables and JVM properties'
    )
  })

  it('needs the project key, which names the artifact', async () => {
    delete inputs['project-key']

    await run()

    expect(core.setFailed).toHaveBeenCalledWith('Input required: project-key')
    expect(exec).not.toHaveBeenCalled()
  })

  it('fails when the plugin wrote no settings', async () => {
    exec.mockResolvedValue(0)

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('wrote no analysis settings')
    )
    expect(artifact.uploadArtifact).not.toHaveBeenCalled()
  })

  it('keeps the artifact local outside GitHub Actions', async () => {
    delete process.env.ACTIONS_RUNTIME_TOKEN
    simulate(`sonar.projectBaseDir=${project}`)

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(artifact.uploadArtifact).not.toHaveBeenCalled()
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('was not uploaded')
    )
  })
})

describe('run in analyze mode', () => {
  const saved = { ...process.env }
  let artifactDir: string
  let head: string

  function prepared(
    settings: Record<string, string>,
    pullRequest?: number
  ): void {
    artifactDir = mkdtempSync(join(tmpdir(), 'artifact-'))
    writeFileSync(
      join(artifactDir, 'settings.json'),
      JSON.stringify({ format: 1, buildTool: 'maven', pullRequest, settings })
    )
    mkdirSync(join(artifactDir, 'workspace', 'target', 'classes'), {
      recursive: true
    })
    writeFileSync(
      join(artifactDir, 'workspace', 'target', 'classes', 'App.class'),
      'bytes'
    )
    process.env.SONAR_FORK_ANALYSIS_ARTIFACT = artifactDir
  }

  beforeEach(() => {
    inputs.mode = 'analyze'
    delete process.env.ACTIONS_RUNTIME_TOKEN
    process.env.GITHUB_WORKSPACE = project
    process.env.RUNNER_TEMP = project
    process.env.GITHUB_EVENT_NAME = 'push'
    process.env.GITHUB_SHA = 'head-sha'
    process.env.GITHUB_REF_NAME = 'main'
    const event = join(project, 'event.json')
    writeFileSync(
      event,
      JSON.stringify({ repository: { default_branch: 'main' } })
    )
    process.env.GITHUB_EVENT_PATH = event
    inputs.checkout = 'false'
    head = 'head-sha'
    getExecOutput.mockImplementation(async (_tool, args) => {
      if (args!.includes('--is-shallow-repository'))
        return { exitCode: 0, stdout: 'false\n', stderr: '' }
      if (args![0] === 'config') return { exitCode: 1, stdout: '', stderr: '' }
      return { exitCode: 0, stdout: `${head}\n`, stderr: '' }
    })
    exec.mockResolvedValue(0)
  })

  afterEach(() => {
    process.env = { ...saved }
    if (artifactDir) rmSync(artifactDir, { recursive: true, force: true })
  })

  it('scans with trusted settings and the token only in the environment', async () => {
    process.env['INPUT_GITHUB-TOKEN'] = 'gh-token'
    process.env.ACTIONS_RUNTIME_TOKEN_FOR_TEST = 'runtime'
    process.env.GITHUB_STATE = '/runner/state'
    prepared({
      'sonar.projectBaseDir': '{workspace}',
      'sonar.sources': '',
      'sonar.java.binaries': '{workspace}/target/classes',
      'sonar.host.url': 'https://evil.example.com',
      'sonar.sca.enabled': 'true'
    })

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    const [tool, args, options] = exec.mock.calls[0]
    expect(tool).toBe('/opt/sonar-scanner/bin/sonar-scanner')
    expect(args!.join(' ')).not.toContain(TOKEN)
    expect(options!.env!.SONAR_TOKEN).toBe(TOKEN)
    // Tokens and runner files the scanner, which reads untrusted content, has no use for.
    expect(
      Object.keys(options!.env!).filter(
        (name) =>
          name.startsWith('INPUT_') ||
          name.startsWith('ACTIONS_') ||
          name === 'GITHUB_STATE'
      )
    ).toEqual([])
    const settingsFile = args![0].replace('-Dproject.settings=', '')
    const settings = readFileSync(settingsFile, 'utf8')
    expect(settings).toContain('sonar.projectKey=key')
    expect(settings).toContain('sonar.scm.revision=head-sha')
    expect(settings).not.toContain('evil.example.com')
    // The scanner would otherwise run the checkout's build tools to list its dependencies.
    expect(settings).toContain('sonar.sca.enabled=false')
    expect(settings).not.toContain('sonar.sca.enabled=true')
    expect(
      readFileSync(join(project, 'target', 'classes', 'App.class'), 'utf8')
    ).toBe('bytes')
  })

  it('keeps workflow commands in the scanner output inert', async () => {
    prepared({})

    await run()

    const stop = core.info.mock.calls.find(([message]) =>
      message.startsWith('::stop-commands::')
    )
    const resume = stop![0].replace('::stop-commands::', '')
    expect(core.info).toHaveBeenCalledWith(`::${resume}::`)
    const order = (message: string): number =>
      core.info.mock.invocationCallOrder[
        core.info.mock.calls.findIndex(([m]) => m === message)
      ]
    expect(order(stop![0])).toBeLessThan(exec.mock.invocationCallOrder[0])
    expect(order(`::${resume}::`)).toBeGreaterThan(
      exec.mock.invocationCallOrder[0]
    )
  })

  it('lets the artifact choose only among pull requests with the analysed head', async () => {
    const event = process.env.GITHUB_EVENT_PATH!
    process.env.GITHUB_EVENT_NAME = 'workflow_run'
    writeFileSync(
      event,
      JSON.stringify({
        repository: { default_branch: 'main' },
        workflow_run: {
          id: 42,
          event: 'pull_request',
          head_sha: 'head-sha',
          head_branch: 'feature',
          head_repository: {
            full_name: 'forker/repo',
            owner: { login: 'forker' }
          }
        }
      })
    )
    const pull = (number: number, base: string) => ({
      number,
      head: { sha: 'head-sha', ref: 'feature' },
      base: { ref: base }
    })
    const fetch = jest.spyOn(globalThis, 'fetch')
    const scan = async (hint: number): Promise<string> => {
      fetch.mockResolvedValue(
        new Response(JSON.stringify([pull(7, 'main'), pull(8, 'release')]))
      )
      exec.mockClear()
      prepared({}, hint)
      await run()
      return readFileSync(
        exec.mock.calls[0][1]![0].replace('-Dproject.settings=', ''),
        'utf8'
      )
    }

    expect(await scan(8)).toContain('sonar.pullrequest.key=8')
    expect(await scan(3)).toContain('sonar.pullrequest.key=7')
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('2 open pull requests')
    )
    fetch.mockRestore()
  })

  describe('on workflow_run', () => {
    let fetch: jest.SpiedFunction<typeof globalThis.fetch>

    // Starts the analysis the way Fixtures Sonar does: after a build of owner/repo or of a fork.
    function triggeredBy(event: string, repository: string): void {
      process.env.GITHUB_EVENT_NAME = 'workflow_run'
      process.env.GITHUB_REPOSITORY = 'owner/repo'
      writeFileSync(
        process.env.GITHUB_EVENT_PATH!,
        JSON.stringify({
          repository: { default_branch: 'main' },
          workflow_run: {
            id: 42,
            event,
            head_sha: 'head-sha',
            head_branch: 'main',
            head_repository: {
              full_name: repository,
              owner: { login: repository.split('/')[0] }
            }
          }
        })
      )
    }

    function statuses(): string[] {
      return fetch.mock.calls
        .filter(([, init]) => init?.method === 'POST')
        .map(([, init]) => {
          const { state, description } = JSON.parse(String(init!.body))
          return `${state}: ${description}`
        })
    }

    beforeEach(() => {
      fetch = jest
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (_url, init) =>
          init?.method === 'POST'
            ? new Response('{}', { status: 201 })
            : new Response(
                JSON.stringify([
                  {
                    number: 7,
                    head: { sha: 'head-sha', ref: 'main' },
                    base: { ref: 'main' }
                  }
                ])
              )
        )
    })

    afterEach(() => {
      fetch.mockRestore()
    })

    it('reports the analysis on the analysed commit', async () => {
      triggeredBy('push', 'owner/repo')
      prepared({})

      await run()

      expect(statuses()).toEqual(['pending: Analysing', 'success: Analysed'])
      // Reported to the end, so nothing is left for the post step.
      expect(core.saveState.mock.calls.at(-1)).toEqual(['pending-status', ''])
    })

    it('leaves the status to the post step when its end cannot be reported', async () => {
      triggeredBy('push', 'owner/repo')
      prepared({})
      fetch.mockImplementation(
        async (_url, init) =>
          new Response('{}', {
            status: statuses().length > 1 && init?.method === 'POST' ? 502 : 201
          })
      )

      await run()

      const [key, note] = core.saveState.mock.calls.at(-1)!
      expect(key).toBe('pending-status')
      expect(JSON.parse(note as string)).toMatchObject({ state: 'success' })
    })

    it('reports a failed analysis, and still fails', async () => {
      triggeredBy('push', 'owner/repo')
      prepared({})
      exec.mockResolvedValue(1)

      await run()

      // Not the error itself: messages may quote the artifact, i.e. the fork.
      expect(statuses()).toEqual([
        'pending: Analysing',
        'failure: The analysis failed, see the run'
      ])
      expect(core.setFailed).toHaveBeenCalled()
    })

    function built(...names: string[]): void {
      process.env.ACTIONS_RUNTIME_TOKEN = 'runtime'
      artifact.listArtifacts.mockResolvedValue({
        artifacts: names.map((name, id) => ({ name, id, size: 1 }))
      })
    }

    it('stays silent when the build analysed directly', async () => {
      triggeredBy('push', 'owner/repo')
      built('sonar-fork-analysis-key+direct')

      await run()

      expect(statuses()).toEqual([])
      expect(getExecOutput).not.toHaveBeenCalled()
      expect(core.setFailed).not.toHaveBeenCalled()
      // Listed in the build's run, not this one.
      expect(artifact.listArtifacts.mock.calls[0][0]).toMatchObject({
        findBy: { workflowRunId: 42 },
        latest: true
      })
    })

    it("downloads this project's artifact from the build's run", async () => {
      triggeredBy('push', 'owner/repo')
      prepared({})
      built('sonar-fork-analysis-other_project', 'sonar-fork-analysis-key')
      artifact.downloadArtifact.mockImplementation(async (_id, options) => {
        cpSync(artifactDir, options!.path!, { recursive: true })
        return { downloadPath: options!.path }
      })

      await run()

      expect(core.setFailed).not.toHaveBeenCalled()
      const [id, options] = artifact.downloadArtifact.mock.calls[0]
      expect(id).toBe(1)
      expect(options).toMatchObject({ findBy: { workflowRunId: 42 } })
      expect(statuses()).toEqual(['pending: Analysing', 'success: Analysed'])
    })

    it('stays silent for a project the build did not prepare', async () => {
      // A monorepo build that skipped this project because none of its files changed.
      triggeredBy('pull_request', 'forker/repo')
      built('sonar-fork-analysis-other_project', 'test-reports')

      await run()

      expect(statuses()).toEqual([])
      expect(getExecOutput).not.toHaveBeenCalled()
      expect(core.setFailed).not.toHaveBeenCalled()
    })

    it('does not count artifacts that are not ours', async () => {
      triggeredBy('pull_request', 'forker/repo')
      built('test-reports')

      await run()

      expect(statuses()).toEqual(['failure: The build left nothing to analyse'])
    })

    it('reports a missing token as a failure, without a pending status', async () => {
      triggeredBy('push', 'owner/repo')
      prepared({})
      delete inputs['sonar-token']

      await run()

      expect(statuses()).toEqual(['failure: The analysis failed, see the run'])
      expect(core.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('No Sonar token')
      )
      // Nothing was left open for the post step.
      expect(core.saveState.mock.calls.every(([, note]) => note === '')).toBe(
        true
      )
    })

    it('reports inputs it cannot read', async () => {
      triggeredBy('push', 'owner/repo')
      inputs.mode = 'analyse'

      await run()

      expect(statuses()).toEqual(['failure: The analysis failed, see the run'])
      expect(core.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('analyse')
      )
    })

    it('posts nothing for a pull request that has moved on', async () => {
      triggeredBy('pull_request', 'forker/repo')
      fetch.mockImplementation(async () => new Response('[]'))

      await run()

      expect(statuses()).toEqual([])
      expect(core.notice).toHaveBeenCalledWith(
        expect.stringContaining('No open pull request')
      )
    })

    it('prefers the prepared artifact to its own direct note', async () => {
      triggeredBy('push', 'owner/repo')
      prepared({})
      built('sonar-fork-analysis-key+direct', 'sonar-fork-analysis-key')
      artifact.downloadArtifact.mockImplementation(async (_id, options) => {
        cpSync(artifactDir, options!.path!, { recursive: true })
        return { downloadPath: options!.path }
      })

      await run()

      expect(statuses()).toEqual(['pending: Analysing', 'success: Analysed'])
    })

    it('does not need the token when the build analysed directly', async () => {
      triggeredBy('push', 'owner/repo')
      delete inputs['sonar-token']
      built('sonar-fork-analysis-key+direct')

      await run()

      expect(statuses()).toEqual([])
      expect(core.setFailed).not.toHaveBeenCalled()
    })

    it('reports a failed pull request lookup on the commit GitHub named', async () => {
      triggeredBy('pull_request', 'forker/repo')
      fetch.mockImplementation(
        async (_url, init) =>
          new Response('{}', { status: init?.method === 'POST' ? 201 : 500 })
      )

      await run()

      expect(statuses()).toEqual(['failure: The analysis failed, see the run'])
      const posted = fetch.mock.calls.find(
        ([, init]) => init?.method === 'POST'
      )!
      expect(String(posted[0])).toMatch(/\/statuses\/head-sha$/)
      expect(core.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('GitHub answered 500')
      )
    })

    it('reports a failed artifact lookup', async () => {
      triggeredBy('push', 'owner/repo')
      process.env.ACTIONS_RUNTIME_TOKEN = 'runtime'
      artifact.listArtifacts.mockRejectedValue(new Error('artifacts API down'))

      await run()

      expect(statuses()).toEqual(['failure: The analysis failed, see the run'])
      expect(core.setFailed).toHaveBeenCalledWith('artifacts API down')
    })

    it('reports a missing project key under a plain name', async () => {
      triggeredBy('push', 'owner/repo')
      delete inputs['project-key']

      await run()

      const posted = fetch.mock.calls.find(
        ([, init]) => init?.method === 'POST'
      )!
      expect(JSON.parse(String(posted[1]!.body))).toMatchObject({
        state: 'failure',
        context: 'Sonar fork analysis'
      })
      expect(core.setFailed).toHaveBeenCalledWith('Input required: project-key')
    })

    it('reports a build that left nothing to analyse, before checking out', async () => {
      triggeredBy('pull_request', 'forker/repo')

      await run()

      expect(statuses()).toEqual(['failure: The build left nothing to analyse'])
      expect(getExecOutput).not.toHaveBeenCalled()
      expect(core.setFailed).not.toHaveBeenCalled()
    })
  })

  it("lists and downloads the same run's artifact without looking elsewhere", async () => {
    process.env.ACTIONS_RUNTIME_TOKEN = 'runtime'
    prepared({})
    artifact.listArtifacts.mockResolvedValue({
      artifacts: [{ name: 'sonar-fork-analysis-key', id: 3, size: 1 }]
    })
    artifact.downloadArtifact.mockImplementation(async (_id, options) => {
      cpSync(artifactDir, options!.path!, { recursive: true })
      return { downloadPath: options!.path }
    })

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(artifact.listArtifacts.mock.calls[0][0]).not.toHaveProperty('findBy')
    const [id, options] = artifact.downloadArtifact.mock.calls[0]
    expect(id).toBe(3)
    expect(options).not.toHaveProperty('findBy')
  })

  it('posts no status where the job itself shows on the pull request', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch')
    prepared({})

    await run()

    expect(fetch).not.toHaveBeenCalled()
    fetch.mockRestore()
  })

  it('refuses a pull request whose branch name would expand into the token', async () => {
    process.env.GITHUB_EVENT_NAME = 'pull_request'
    writeFileSync(
      process.env.GITHUB_EVENT_PATH!,
      JSON.stringify({
        pull_request: {
          number: 7,
          head: {
            sha: 'head-sha',
            ref: '${env.SONAR_TOKEN}',
            repo: { full_name: 'forker/repo' }
          },
          base: { ref: 'main' }
        }
      })
    )
    prepared({})

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining(
        'holds a placeholder the Sonar scanner would expand'
      )
    )
    expect(exec).not.toHaveBeenCalled()
  })

  it('refuses a checkout of another commit', async () => {
    prepared({})
    head = 'other'

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('check out that commit')
    )
    expect(exec).not.toHaveBeenCalled()
  })

  it('skips when nothing was prepared', async () => {
    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(core.notice).toHaveBeenCalledWith(
      expect.stringContaining('No sonar-fork-analysis-key artifact')
    )
    expect(exec).not.toHaveBeenCalled()
  })
})
