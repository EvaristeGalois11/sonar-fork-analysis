import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance
} from 'vitest'
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as artifact from '../__fixtures__/artifact.js'
import * as core from '../__fixtures__/core.js'
import { linuxIt } from '../__fixtures__/platform.js'
import { exec, getExecOutput } from '../__fixtures__/exec.js'
import { NO_FILE } from '../src/languages.js'

// Mocks must be declared before the module under test is imported.
vi.doMock('@actions/core', () => core)
vi.doMock('@actions/exec', () => ({ exec, getExecOutput }))
vi.doMock('../src/scanner.js', () => ({
  installScanner: async () => '/opt/sonar-scanner/bin/sonar-scanner'
}))
vi.doMock('@actions/artifact', () => artifact)
// The server's languages, which the analysis asks for.
const serverLanguages = vi.fn(async () => ['java', 'ts', 'py', 'rust'])
vi.doMock('../src/languages.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/languages.js')>()),
  serverLanguages
}))

const { run } = await import('../src/main.js')

const TOKEN = 'sqa_not_a_real_token'
let project: string
let inputs: Record<string, string>

let analyses = 0

// What the runner gives an action: its inputs, as INPUT_ and the input's name, which a step doesn't
// get, and the runtime's tokens.
function runAsAction(): void {
  process.env['INPUT_SONAR-TOKEN'] = TOKEN
  process.env['INPUT_GITHUB-TOKEN'] = 'gh-token'
  process.env.ACTIONS_RUNTIME_TOKEN = 'runtime'
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'oidc'
  process.env.GITHUB_STEP_SUMMARY = '/runner/summary'
}

function inputVariables(env: Record<string, string>): string[] {
  return Object.keys(env).filter((name) => name.startsWith('INPUT_'))
}

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
  vi.resetAllMocks()
  rmSync(project, { recursive: true, force: true })
})

describe('run', () => {
  const saved = { ...process.env }

  afterEach(() => {
    process.env = { ...saved }
  })

  it('passes the token only through the environment', async () => {
    runAsAction()
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
    expect(inputVariables(options!.env!)).toEqual([])
    // A step of its own would have it, with id-token: write.
    expect(options!.env!.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBe('oidc')
    expect(options!.env!.GITHUB_STEP_SUMMARY).toBe('/runner/summary')
  })

  it("refuses to build a pull request's, another repository's or a bot's run on workflow_run, and only warns for a person's push here", async () => {
    inputs.mode = 'direct'
    process.env.GITHUB_EVENT_NAME = 'workflow_run'
    process.env.GITHUB_REPOSITORY = 'owner/repo'
    const event = join(project, 'event.json')
    process.env.GITHUB_EVENT_PATH = event
    exec.mockImplementation(async (_tool, _args, options) => {
      writeReport(options!.cwd!)
      return 0
    })
    // The failure status of a refused run.
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 201 }))
    const after = async (
      runEvent: string,
      repository: string,
      accounts: { actor?: unknown; triggering_actor?: unknown } = {},
      branch = 'main'
    ) => {
      vi.clearAllMocks()
      writeFileSync(
        event,
        JSON.stringify({
          repository: { default_branch: 'main' },
          workflow_run: {
            event: runEvent,
            head_branch: branch,
            head_repository: { full_name: repository },
            ...accounts
          }
        })
      )
      await run()
    }
    const bot = { type: 'Bot' }
    const person = { type: 'User' }

    try {
      // A pull request from this repository's own branch, as Dependabot opens them.
      await after('pull_request', 'owner/repo')
      expect(core.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('Refusing to build on workflow_run')
      )
      expect(exec).not.toHaveBeenCalled()

      await after('push', 'fork/repo')
      expect(core.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('Refusing to build on workflow_run')
      )
      expect(exec).not.toHaveBeenCalled()

      // A bot's push to a branch of its own, such as Dependabot's, whoever re-runs it.
      for (const accounts of [
        { actor: bot, triggering_actor: bot },
        { actor: bot, triggering_actor: person },
        { actor: person, triggering_actor: bot }
      ]) {
        await after('push', 'owner/repo', accounts, 'dependabot/npm/x')
        expect(core.setFailed).toHaveBeenCalledWith(
          expect.stringContaining('Refusing to build on workflow_run')
        )
        expect(exec).not.toHaveBeenCalled()
      }

      // A bot that merges into the default branch, and a run with no accounts named.
      for (const accounts of [{ actor: bot, triggering_actor: bot }, {}]) {
        await after('push', 'owner/repo', accounts)
        expect(core.setFailed).not.toHaveBeenCalled()
      }

      await after('push', 'Owner/Repo')
      expect(core.setFailed).not.toHaveBeenCalled()
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('Direct analysis on workflow_run')
      )
    } finally {
      fetch.mockRestore()
    }
  })

  it('analyses a Node project with the scanner it pins', async () => {
    rmSync(join(project, 'pom.xml'))
    writeFileSync(join(project, 'package.json'), '{}')
    exec.mockImplementation(async (_tool, _args, options) => {
      const work = join(options!.cwd!, '.scannerwork')
      mkdirSync(work, { recursive: true })
      writeFileSync(join(work, 'report-task.txt'), `ceTaskId=${++analyses}\n`)
      return 0
    })

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    const [tool, args, options] = exec.mock.calls[0]
    expect(tool).toBe('/opt/sonar-scanner/bin/sonar-scanner')
    expect(args).toEqual(['-Dsonar.projectKey=key'])
    expect(options!.cwd).toBe(project)
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
      // Escaped like the plugins write Java properties: Windows paths have backslashes.
      writeFileSync(
        target,
        dump.replaceAll(project, project.replaceAll('\\', '\\\\'))
      )
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
    runAsAction()

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(exec.mock.calls[0][2]!.env!.SONAR_TOKEN).toBeUndefined()
    expect(inputVariables(exec.mock.calls[0][2]!.env!)).toEqual([])
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
        'sonar.modules=app',
        `app.sonar.projectBaseDir=${project}`,
        'sonar.host.url=http\\://127.0.0.1\\:9',
        'sonar.nodejs.executable=/usr/bin/node',
        'app.sonar.nodejs.executable=/usr/bin/node',
        'app.sonar.python.file.suffixes=.java',
        'env.SECRET=leaked'
      ].join('\n')
    )

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(core.warning).toHaveBeenCalledTimes(1)
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'leaves out these settings: sonar.nodejs.executable, sonar.python.file.suffixes.'
      )
    )
    expect(core.info).toHaveBeenCalledWith(
      'Ignored 1 environment variables and JVM properties'
    )
  })

  it('warns about an organization set only in the build', async () => {
    simulate(
      [`sonar.projectBaseDir=${project}`, 'sonar.organization=org'].join('\n')
    )

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('set it in both workflows')
    )
  })

  it('does not warn about an organization the input also sets', async () => {
    inputs['sonar-organization'] = 'org'
    simulate(
      [`sonar.projectBaseDir=${project}`, 'sonar.organization=org'].join('\n')
    )

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(core.warning).not.toHaveBeenCalled()
  })

  it('reads a Node project with the scanner it pins, and ships its type declarations', async () => {
    rmSync(join(project, 'pom.xml'))
    writeFileSync(join(project, 'package.json'), '{}')
    mkdirSync(join(project, 'src'))
    mkdirSync(join(project, 'coverage'))
    writeFileSync(join(project, 'coverage', 'lcov.info'), 'TN:')
    mkdirSync(join(project, 'node_modules', 'express'), { recursive: true })
    writeFileSync(join(project, 'node_modules', 'express', 'index.d.ts'), '')
    simulate(
      [
        `sonar.projectBaseDir=${project}`,
        'sonar.sources=src',
        'sonar.javascript.lcov.reportPaths=coverage/lcov.info'
      ].join('\n')
    )

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    const [tool, args] = exec.mock.calls[0]
    expect(tool).toBe('/opt/sonar-scanner/bin/sonar-scanner')
    expect(args).not.toContain('verify')
    const [, files, staging] = artifact.uploadArtifact.mock.calls[0]
    expect(files).toContain(
      join(staging, 'workspace', 'node_modules', 'express', 'index.d.ts')
    )
    expect(files).toContain(join(staging, 'workspace', 'coverage', 'lcov.info'))
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('Shipping 1 type declaration files')
    )
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'No sonar-project.properties in ' +
          project +
          ', so the scanner analyses the whole directory'
      )
    )
  })

  it('says when a Node project has no type declarations to ship', async () => {
    rmSync(join(project, 'pom.xml'))
    writeFileSync(join(project, 'package.json'), '{}')
    writeFileSync(join(project, 'sonar-project.properties'), 'sonar.sources=.')
    simulate([`sonar.projectBaseDir=${project}`, 'sonar.sources=.'].join('\n'))

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(core.info).toHaveBeenCalledWith(
      'No type declarations found in node_modules: the analysis of pull requests resolves fewer types'
    )
    expect(core.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('No sonar-project.properties')
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
      expect.stringContaining(
        'wrote no analysis settings; the fork path needs sonar-maven-plugin 3.2 or later'
      )
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
  // The analysis moves to its own directory.
  const cwd = process.cwd()
  let artifactDir: string
  let head: string

  function prepared(
    settings: Record<string, string>,
    pullRequest?: number,
    links?: { path: string; target: string }[]
  ): void {
    artifactDir = mkdtempSync(join(tmpdir(), 'artifact-'))
    writeFileSync(
      join(artifactDir, 'settings.json'),
      JSON.stringify({
        format: 1,
        buildTool: 'maven',
        pullRequest,
        settings,
        links
      })
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
    process.chdir(cwd)
    process.env = { ...saved }
    if (artifactDir) rmSync(artifactDir, { recursive: true, force: true })
  })

  it("makes the links the build's node_modules had again", async () => {
    mkdirSync(join(project, 'packages', 'shared'), { recursive: true })
    prepared({ 'sonar.projectBaseDir': '{workspace}' }, undefined, [
      { path: 'node_modules/@app/shared', target: 'packages/shared' }
    ])

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(
      lstatSync(
        join(project, 'node_modules', '@app', 'shared')
      ).isSymbolicLink()
    ).toBe(true)
  })

  linuxIt(
    'removes a link to its working directory, which the scanner has elsewhere',
    async () => {
      prepared({ 'sonar.projectBaseDir': '{workspace}' })
      symlinkSync('/proc/self/cwd', join(project, 'cwd'))
      // Where the runner starts the action, with its temporary directory elsewhere.
      process.chdir(project)
      const runnerTemp = mkdtempSync(join(tmpdir(), 'runner-'))
      process.env.RUNNER_TEMP = runnerTemp
      try {
        await run()
      } finally {
        rmSync(runnerTemp, { recursive: true, force: true })
      }

      expect(core.setFailed).not.toHaveBeenCalled()
      expect(
        lstatSync(join(project, 'cwd'), { throwIfNoEntry: false })
      ).toBeUndefined()
    }
  )

  it('scans with trusted settings and the token only in the environment', async () => {
    process.env['INPUT_GITHUB-TOKEN'] = 'gh-token'
    process.env.ACTIONS_RUNTIME_TOKEN_FOR_TEST = 'runtime'
    process.env.GITHUB_STATE = '/runner/state'
    prepared({
      'sonar.projectBaseDir': '{workspace}',
      'sonar.sources': '',
      'sonar.java.binaries': '{workspace}/target/classes',
      'sonar.host.url': 'https://evil.example.com',
      'sonar.sca.enabled': 'true',
      'sonar.scanner.autoconfig.enabled': 'true'
    })

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    const [tool, args, options] = exec.mock.calls[0]
    expect(tool).toBe('/opt/sonar-scanner/bin/sonar-scanner')
    expect(args!.join(' ')).not.toContain(TOKEN)
    expect(options!.env!.SONAR_TOKEN).toBe(TOKEN)
    expect(options!.env!.LC_ALL).toBe(
      process.platform === 'linux' ? 'C.UTF-8' : process.env.LC_ALL
    )
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
    // In a directory of the action's, where tools the engine starts find none of the checkout.
    expect(options!.cwd).not.toBe(project)
    expect(options!.cwd).toBe(join(dirname(settingsFile), 'run'))
    const settings = readFileSync(settingsFile, 'utf8')
    expect(settings).toContain('sonar.projectKey=key')
    expect(settings).toContain('sonar.scm.revision=head-sha')
    expect(settings).not.toContain('evil.example.com')
    // The scanner would otherwise run the checkout's build tools to list its dependencies.
    expect(settings).toContain('sonar.sca.enabled=false')
    expect(settings).not.toContain('sonar.sca.enabled=true')
    expect(settings).toContain('sonar.scanner.autoconfig.enabled=false')
    expect(settings).not.toContain('sonar.scanner.autoconfig.enabled=true')
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

  it('turns off the analyzers of untested languages unless build-arguments turn one on', async () => {
    prepared({
      'sonar.inclusions': 'src/**',
      'sonar.python.file.suffixes': '.java',
      'sonar.lang.patterns.rust': '**/*.java'
    })
    inputs['build-arguments'] = '-Dsonar.lang.patterns.py=**/*.py'

    await run()

    const args = exec.mock.calls[0][1]!
    const settings = readFileSync(
      args[0].replace('-Dproject.settings=', ''),
      'utf8'
    )
    expect(serverLanguages).toHaveBeenCalledWith('https://sonarcloud.io', TOKEN)
    expect(settings).toContain('sonar.inclusions=src/**\n')
    expect(settings).toContain(`sonar.lang.patterns.py=${NO_FILE}\n`)
    expect(settings).toContain(`sonar.lang.patterns.rust=${NO_FILE}\n`)
    expect(settings).not.toMatch(
      /patterns\.(java|ts)=|file\.suffixes|\*\*\/\*\.java/
    )
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringMatching(
        /^Dropped settings a build never ships: .*sonar\.python\.file\.suffixes.*sonar\.lang\.patterns\.rust/
      )
    )
    // The scanner takes the last value it reads for a key.
    expect(args.slice(1)).toEqual(['-Dsonar.lang.patterns.py=**/*.py'])
    expect(core.info).toHaveBeenCalledWith(
      "The analyzers of languages this action isn't tested with stay off: py, rust. To turn one on, set sonar.lang.patterns.<language> in build-arguments."
    )
    expect(core.info).toHaveBeenCalledWith(
      "build-arguments set sonar.lang.patterns.py: that language's analyzer runs with the token."
    )
  })

  it("analyses nothing without the server's languages", async () => {
    prepared({})
    serverLanguages.mockRejectedValueOnce(
      new Error(
        "Could not get the server's languages: https://sonarcloud.io answered 401"
      )
    )

    await run()

    expect(exec).not.toHaveBeenCalled()
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("Could not get the server's languages")
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
    const fetch = vi.spyOn(globalThis, 'fetch')
    const scan = async (hint?: number): Promise<string | undefined> => {
      // GitHub has never heard of any other pull request.
      fetch.mockImplementation(async (url) =>
        /\/pulls\/\d+$/.test(String(url))
          ? new Response('{}', { status: 404 })
          : new Response(JSON.stringify([pull(7, 'main'), pull(8, 'release')]))
      )
      exec.mockClear()
      prepared({}, hint)
      await run()
      const settings = exec.mock.calls[0]?.[1]?.[0]
      return settings === undefined
        ? undefined
        : readFileSync(settings.replace('-Dproject.settings=', ''), 'utf8')
    }

    expect(await scan(8)).toContain('sonar.pullrequest.key=8')
    // Another pull request, such as one of another fork's, is never analysed in its place.
    expect(await scan(3)).toContain('sonar.pullrequest.key=7')
    expect(await scan()).toContain('sonar.pullrequest.key=7')
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('2 open pull requests')
    )
    fetch.mockRestore()
  })

  describe('on workflow_run', () => {
    let fetch: MockInstance<typeof globalThis.fetch>

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
          const { state, description } = JSON.parse(String(init!.body)) as {
            state: string
            description: string
          }
          return `${state}: ${description}`
        })
    }

    beforeEach(() => {
      fetch = vi
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

    // GitHub's answers about single pull requests, on top of the list of open ones.
    function knowing(pulls: Record<string, unknown>): void {
      const list = fetch.getMockImplementation()!
      fetch.mockImplementation(async (url, init) => {
        const number = /\/pulls\/(\d+)$/.exec(String(url))?.[1]
        if (number === undefined) return list(url, init)
        const pull = pulls[number]
        return pull
          ? new Response(JSON.stringify(pull))
          : new Response('{}', { status: 404 })
      })
    }

    it("skips when the build's pull request is gone, and closes its status", async () => {
      // Two pull requests had this head; #8 closed before this run, which built it.
      triggeredBy('pull_request', 'fork/repo')
      knowing({
        8: {
          state: 'closed',
          head: {
            sha: 'head-sha',
            ref: 'main',
            repo: { full_name: 'fork/repo' }
          }
        }
      })
      prepared({}, 8)

      await run()

      expect(exec).not.toHaveBeenCalled()
      expect(core.notice).toHaveBeenCalledWith(
        "The build's pull request #8 is closed or has newer commits: nothing to analyse."
      )
      expect(statuses()).toEqual([
        'pending: Analysing',
        'success: Skipped: the build was for #8'
      ])
      expect(core.setFailed).not.toHaveBeenCalled()
    })

    it('analyses its pull request when the build names one that never had this head', async () => {
      triggeredBy('pull_request', 'fork/repo')
      knowing({
        1: {
          state: 'closed',
          head: {
            sha: 'other-sha',
            ref: 'other',
            repo: { full_name: 'other/repo' }
          }
        }
      })
      prepared({}, 1)

      await run()

      expect(exec).toHaveBeenCalled()
      expect(statuses()).toEqual(['pending: Analysing', 'success: Analysed'])
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
        return { downloadPath: options!.path! }
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
        return { downloadPath: options!.path! }
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
      return { downloadPath: options!.path! }
    })

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(artifact.listArtifacts.mock.calls[0][0]).not.toHaveProperty('findBy')
    const [id, options] = artifact.downloadArtifact.mock.calls[0]
    expect(id).toBe(3)
    expect(options).not.toHaveProperty('findBy')
  })

  it('posts no status where the job itself shows on the pull request', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
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
