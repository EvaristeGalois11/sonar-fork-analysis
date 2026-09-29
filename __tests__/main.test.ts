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
import { exec } from '../__fixtures__/exec.js'

// Mocks must be declared before the module under test is imported.
jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('@actions/exec', () => ({ exec }))
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

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(exec.mock.calls[0][2]!.env!.SONAR_TOKEN).toBeUndefined()
    const [name, files, staging, options] =
      artifact.uploadArtifact.mock.calls[0]
    expect(name).toBe('sonar-fork-analysis')
    expect(options).toEqual({ retentionDays: 1 })
    const settings = readFileSync(join(staging, 'settings.json'), 'utf8')
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
