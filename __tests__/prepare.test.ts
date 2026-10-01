import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  artifactName,
  simulationProperties,
  stageAnalysis
} from '../src/prepare.js'

let root: string
let workspace: string
let home: string
let staging: string

function file(path: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, 'x')
  return path
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'prepare-'))
  workspace = join(root, 'work')
  home = join(root, 'home')
  staging = join(root, 'staging')
  mkdirSync(workspace)
  mkdirSync(home)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('simulationProperties', () => {
  it('passes both dump property names and an unreachable host', () => {
    expect(simulationProperties('/tmp/dump')).toEqual([
      '-Dsonar.host.url=http://127.0.0.1:9',
      '-Dsonar.scanner.dumpToFile=/tmp/dump',
      '-Dsonar.scanner.internal.dumpToFile=/tmp/dump'
    ])
  })
})

describe('artifactName', () => {
  it('names the artifact after the project', () => {
    expect(artifactName('acme_app')).toBe('sonar-fork-analysis-acme_app')
  })

  it('replaces the colon, which artifact names cannot hold', () => {
    expect(artifactName('org.acme:app')).toBe(
      'sonar-fork-analysis-org.acme_app'
    )
  })

  it('rejects what is no project key', () => {
    expect(() => artifactName('a/b')).toThrow(/Invalid project key/)
    expect(() => artifactName('')).toThrow(/Invalid project key/)
  })
})

describe('stageAnalysis', () => {
  it('rewrites paths and ships only build output', () => {
    const app = join(workspace, 'app')
    file(join(app, 'target/classes/App.class'))
    file(join(app, 'src/main/java/App.java'))
    file(join(app, 'target/site/jacoco/jacoco.xml'))
    const jar = file(join(home, '.m2/repository/junit/junit.jar'))

    const staged = stageAnalysis(
      new Map([
        ['sonar.modules', 'app'],
        ['app.sonar.projectBaseDir', app],
        ['app.sonar.sources', join(app, 'src/main/java')],
        ['app.sonar.java.binaries', join(app, 'target/classes')],
        ['app.sonar.java.libraries', `${jar},${join(app, 'missing.jar')}`],
        ['app.sonar.java.source', '21']
      ]),
      { workspace, home },
      staging,
      'maven'
    )

    expect(staged.settings).toEqual({
      'sonar.modules': 'app',
      'app.sonar.projectBaseDir': '{workspace}/app',
      'app.sonar.sources': '{workspace}/app/src/main/java',
      'app.sonar.java.binaries': '{workspace}/app/target/classes',
      'app.sonar.java.libraries': '{home}/.m2/repository/junit/junit.jar',
      'app.sonar.java.source': '21'
    })
    const shipped = staged.files.map((path) => path.slice(staging.length + 1))
    expect(shipped.sort()).toEqual([
      'home/.m2/repository/junit/junit.jar',
      'settings.json',
      'workspace/app/target/classes/App.class',
      'workspace/app/target/site/jacoco/jacoco.xml'
    ])
    expect(
      JSON.parse(readFileSync(join(staging, 'settings.json'), 'utf8'))
    ).toEqual({ format: 1, buildTool: 'maven', settings: staged.settings })
  })

  it('keeps relative entries relative and ships what they point to', () => {
    file(join(workspace, 'reports/jacoco.xml'))
    const staged = stageAnalysis(
      new Map([
        ['sonar.projectBaseDir', workspace],
        ['sonar.coverage.jacoco.xmlReportPaths', 'reports/jacoco.xml']
      ]),
      { workspace, home },
      staging,
      'gradle'
    )
    expect(staged.settings['sonar.coverage.jacoco.xmlReportPaths']).toBe(
      'reports/jacoco.xml'
    )
    expect(existsSync(join(staging, 'workspace/reports/jacoco.xml'))).toBe(true)
  })

  it('ships an aggregate coverage report, as Sonar advises for multi-module builds', () => {
    const report = join(workspace, 'report/build/jacoco.xml')
    file(report)
    const staged = stageAnalysis(
      new Map([
        ['sonar.projectBaseDir', workspace],
        ['sonar.coverage.jacoco.aggregateXmlReportPaths', report]
      ]),
      { workspace, home },
      staging,
      'gradle'
    )
    expect(
      staged.settings['sonar.coverage.jacoco.aggregateXmlReportPaths']
    ).toBe('{workspace}/report/build/jacoco.xml')
    expect(existsSync(join(staging, 'workspace/report/build/jacoco.xml'))).toBe(
      true
    )
  })

  it('ships the reports a pattern matches, listed', () => {
    file(join(workspace, 'a/target/site/jacoco/jacoco.xml'))
    file(join(workspace, 'b/c/target/site/jacoco/jacoco.xml'))
    file(join(workspace, 'b/target/other.xml'))
    const staged = stageAnalysis(
      new Map([
        ['sonar.projectBaseDir', workspace],
        [
          'sonar.coverage.jacoco.xmlReportPaths',
          '**/target/site/jacoco/jacoco.xml'
        ],
        ['sonar.java.libraries', `${workspace}/missing/*.jar`]
      ]),
      { workspace, home },
      staging,
      'maven'
    )
    expect(staged.settings).toEqual({
      'sonar.projectBaseDir': '{workspace}',
      'sonar.coverage.jacoco.xmlReportPaths':
        'a/target/site/jacoco/jacoco.xml,b/c/target/site/jacoco/jacoco.xml'
    })
    expect(
      existsSync(join(staging, 'workspace/b/c/target/site/jacoco/jacoco.xml'))
    ).toBe(true)
    expect(existsSync(join(staging, 'workspace/b/target/other.xml'))).toBe(
      false
    )
  })

  it('ships the reports of any tool', () => {
    file(join(workspace, 'ruff.json'))
    const staged = stageAnalysis(
      new Map([
        ['sonar.python.ruff.reportPaths', join(workspace, 'ruff.json')]
      ]),
      { workspace, home },
      staging,
      'gradle'
    )
    expect(staged.settings['sonar.python.ruff.reportPaths']).toBe(
      '{workspace}/ruff.json'
    )
    expect(existsSync(join(staging, 'workspace/ruff.json'))).toBe(true)
  })

  it('drops paths outside the workspace and home with a warning', () => {
    const staged = stageAnalysis(
      new Map([['sonar.sources', '/etc/passwd']]),
      { workspace, home },
      staging,
      'maven'
    )
    expect(staged.settings['sonar.sources']).toBe('')
    expect(staged.warnings).toEqual([
      'Dropped sonar.sources entry outside the workspace: /etc/passwd'
    ])
  })
})
