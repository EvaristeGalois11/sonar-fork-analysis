import { jest } from '@jest/globals'
import {
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
    expect(options).toEqual({ retentionDays: 1 })
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
    prepared({
      'sonar.projectBaseDir': '{workspace}',
      'sonar.sources': '',
      'sonar.java.binaries': '{workspace}/target/classes',
      'sonar.host.url': 'https://evil.example.com'
    })

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    const [tool, args, options] = exec.mock.calls[0]
    expect(tool).toBe('/opt/sonar-scanner/bin/sonar-scanner')
    expect(args!.join(' ')).not.toContain(TOKEN)
    expect(options!.env!.SONAR_TOKEN).toBe(TOKEN)
    // The inputs hold tokens the scanner, which reads untrusted content, has no use for.
    expect(
      Object.keys(options!.env!).filter((name) => name.startsWith('INPUT_'))
    ).toEqual([])
    const settingsFile = args![0].replace('-Dproject.settings=', '')
    const settings = readFileSync(settingsFile, 'utf8')
    expect(settings).toContain('sonar.projectKey=key')
    expect(settings).toContain('sonar.scm.revision=head-sha')
    expect(settings).not.toContain('evil.example.com')
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

    it('stays silent when the build analysed directly', async () => {
      triggeredBy('push', 'owner/repo')
      process.env.ACTIONS_RUNTIME_TOKEN = 'runtime'
      artifact.getArtifact.mockImplementation(async (name) => {
        if (name === 'sonar-fork-analysis-key+direct')
          return { artifact: { id: 1, name, size: 1 } }
        throw new artifact.ArtifactNotFoundError(name)
      })

      await run()

      expect(statuses()).toEqual([])
      expect(getExecOutput).not.toHaveBeenCalled()
      expect(core.setFailed).not.toHaveBeenCalled()
      // Looked up in the build's run, not this one.
      expect(artifact.getArtifact.mock.calls[0][1]).toMatchObject({
        findBy: { workflowRunId: 42 }
      })
    })

    it('reports a build that left nothing to analyse, before checking out', async () => {
      triggeredBy('pull_request', 'forker/repo')

      await run()

      expect(statuses()).toEqual(['failure: The build left nothing to analyse'])
      expect(getExecOutput).not.toHaveBeenCalled()
      expect(core.setFailed).not.toHaveBeenCalled()
    })
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
