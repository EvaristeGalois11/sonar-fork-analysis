import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  chmodSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  artifactName,
  simulationProperties,
  stageAnalysis,
  typeDeclarations
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

  it('expands patterns against the module, absolute ones into placeholders', () => {
    const app = join(workspace, 'app')
    file(join(app, 'build/test-results/a.xml'))
    file(join(app, 'build/test-results/b.xml'))
    file(join(home, 'reports/lint.xml'))
    const staged = stageAnalysis(
      new Map([
        ['sonar.modules', 'app'],
        ['app.sonar.projectBaseDir', app],
        ['app.sonar.junit.reportPaths', 'build/test-results/*.xml'],
        ['app.sonar.androidLint.reportPaths', `${home}/reports/*.xml`]
      ]),
      { workspace, home },
      staging,
      'gradle'
    )
    expect(staged.settings['app.sonar.junit.reportPaths']).toBe(
      'build/test-results/a.xml,build/test-results/b.xml'
    )
    expect(staged.settings['app.sonar.androidLint.reportPaths']).toBe(
      '{home}/reports/lint.xml'
    )
    expect(
      existsSync(join(staging, 'workspace/app/build/test-results/b.xml'))
    ).toBe(true)
    expect(existsSync(join(staging, 'home/reports/lint.xml'))).toBe(true)
  })

  it('drops the matches of a pattern leaving the workspace', () => {
    file(join(root, 'secrets/a.xml'))
    const staged = stageAnalysis(
      new Map([
        ['sonar.projectBaseDir', workspace],
        ['sonar.coverageReportPaths', '../secrets/*.xml']
      ]),
      { workspace, home },
      staging,
      'maven'
    )
    expect(staged.settings['sonar.coverageReportPaths']).toBeUndefined()
    expect(staged.warnings).toEqual([
      'Dropped sonar.coverageReportPaths entry outside the workspace: ../secrets/a.xml'
    ])
    expect(existsSync(join(staging, 'workspace'))).toBe(false)
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

  it('keeps a single path whole, commas included', () => {
    const base = join(workspace, 'a,b')
    file(join(base, 'pom.xml'))
    const staged = stageAnalysis(
      new Map([['sonar.projectBaseDir', base]]),
      { workspace, home },
      staging,
      'maven'
    )
    expect(staged.settings['sonar.projectBaseDir']).toBe('{workspace}/a,b')
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

describe('typeDeclarations', () => {
  it('finds the declarations in every node_modules, and the package.json files leading to them', () => {
    file(join(workspace, 'package.json'))
    file(join(workspace, 'src/types.d.ts'))
    file(join(workspace, 'node_modules/express/index.js'))
    const found = [
      file(join(workspace, 'node_modules/express/index.d.ts')),
      file(join(workspace, 'node_modules/express/package.json')),
      file(join(workspace, 'node_modules/a/node_modules/b/lib/x.d.mts')),
      file(join(workspace, 'packages/web/node_modules/c/index.d.cts'))
    ]
    expect(typeDeclarations(workspace, workspace).sort()).toEqual(found.sort())
  })

  it('does not follow links, out of the workspace or anywhere', () => {
    file(join(home, 'elsewhere/index.d.ts'))
    mkdirSync(join(workspace, 'node_modules'))
    symlinkSync(join(home, 'elsewhere'), join(workspace, 'node_modules/linked'))
    expect(typeDeclarations(workspace, workspace)).toEqual([])
  })

  it('takes the tsconfig files projects extend, and nothing else of a package', () => {
    const tsconfig = file(
      join(workspace, 'node_modules/@tsconfig/node22/tsconfig.json')
    )
    file(join(workspace, 'node_modules/@tsconfig/node22/README.md'))
    expect(typeDeclarations(workspace, workspace)).toEqual([tsconfig])
  })

  it("skips pnpm's store, reachable only through links, but not other dot-directories", () => {
    file(
      join(
        workspace,
        'node_modules/.pnpm/express@5/node_modules/express/index.d.ts'
      )
    )
    const prisma = file(
      join(workspace, 'node_modules/.prisma/client/index.d.ts')
    )
    expect(typeDeclarations(workspace, workspace)).toEqual([prisma])
  })

  it('takes the node_modules above the project up to the workspace, where workspaces install', () => {
    const project = join(workspace, 'packages/web')
    const own = file(join(project, 'node_modules/local/index.d.ts'))
    const hoisted = file(join(workspace, 'node_modules/express/index.d.ts'))
    file(join(root, 'node_modules/outside/index.d.ts'))
    expect(typeDeclarations(project, workspace).sort()).toEqual(
      [own, hoisted].sort()
    )
  })

  it('skips a directory it cannot read', () => {
    // Root reads anything, so the directory can't be locked against it.
    if (process.getuid?.() === 0) return
    const locked = join(workspace, 'data')
    file(join(locked, 'x'))
    const found = file(join(workspace, 'node_modules/x/index.d.ts'))
    chmodSync(locked, 0o000)
    try {
      expect(typeDeclarations(workspace, workspace)).toEqual([found])
    } finally {
      chmodSync(locked, 0o755)
    }
  })

  it('are shipped with the settings', () => {
    const declaration = file(join(workspace, 'node_modules/x/index.d.ts'))
    stageAnalysis(
      new Map([['sonar.projectBaseDir', workspace]]),
      { workspace, home },
      staging,
      'node',
      undefined,
      [declaration]
    )
    expect(
      existsSync(join(staging, 'workspace/node_modules/x/index.d.ts'))
    ).toBe(true)
  })
})
