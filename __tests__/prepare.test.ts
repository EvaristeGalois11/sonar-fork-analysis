import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
import { dirname, join, sep } from 'node:path'
import { nonRootIt } from '../__fixtures__/platform.js'
import {
  artifactName,
  simulationProperties,
  stageAnalysis,
  typeInformation
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
    const shipped = staged.files.map((path) =>
      path
        .slice(staging.length + 1)
        .split(sep)
        .join('/')
    )
    expect(shipped.sort()).toEqual([
      'home/.m2/repository/junit/junit.jar',
      'settings.json',
      'workspace/app/target/classes/App.class',
      'workspace/app/target/site/jacoco/jacoco.xml'
    ])
    expect(
      JSON.parse(readFileSync(join(staging, 'settings.json'), 'utf8'))
    ).toEqual({
      format: 1,
      buildTool: 'maven',
      settings: staged.settings,
      links: []
    })
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

describe('typeInformation', () => {
  const files = (directory: string): string[] =>
    typeInformation(directory, workspace).files.sort()

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
    expect(files(workspace)).toEqual(found.sort())
  })

  it('takes the tsconfig files projects extend, and nothing else of a package', () => {
    const tsconfig = file(
      join(workspace, 'node_modules/@tsconfig/node22/tsconfig.json')
    )
    file(join(workspace, 'node_modules/@tsconfig/node22/README.md'))
    expect(files(workspace)).toEqual([tsconfig])
  })

  it('takes the node_modules above the project up to the workspace, where workspaces install', () => {
    const project = join(workspace, 'packages/web')
    const own = file(join(project, 'node_modules/local/index.d.ts'))
    const hoisted = file(join(workspace, 'node_modules/express/index.d.ts'))
    file(join(root, 'node_modules/outside/index.d.ts'))
    expect(files(project)).toEqual([own, hoisted].sort())
  })

  it("records a workspace's links to its own packages, without following them", () => {
    file(join(workspace, 'packages/shared/src/index.ts'))
    mkdirSync(join(workspace, 'node_modules/@app'), { recursive: true })
    symlinkSync(
      '../../packages/shared',
      join(workspace, 'node_modules/@app/shared')
    )
    expect(typeInformation(workspace, workspace)).toEqual({
      files: [],
      links: [{ path: 'node_modules/@app/shared', target: 'packages/shared' }],
      outside: 0
    })
  })

  it("takes pnpm's store and the links leading into it", () => {
    const store = 'node_modules/.pnpm/express@5/node_modules'
    const declaration = file(join(workspace, store, 'express/index.d.ts'))
    symlinkSync(
      join(workspace, store, 'express'),
      join(workspace, 'node_modules/express')
    )
    expect(typeInformation(workspace, workspace)).toEqual({
      files: [declaration],
      links: [{ path: 'node_modules/express', target: `${store}/express` }],
      outside: 0
    })
  })

  it('records no link leading out of the workspace, to a file or nowhere', () => {
    file(join(home, 'elsewhere/index.d.ts'))
    file(join(workspace, 'node_modules/typescript/bin/tsc'))
    mkdirSync(join(workspace, 'node_modules/.bin'))
    symlinkSync(join(home, 'elsewhere'), join(workspace, 'node_modules/out'))
    symlinkSync(
      '../typescript/bin/tsc',
      join(workspace, 'node_modules/.bin/tsc')
    )
    symlinkSync('missing', join(workspace, 'node_modules/dangling'))
    const found = typeInformation(workspace, workspace)
    expect(found.links).toEqual([])
    // Only the directory outside counts as left out, not the file or the broken link.
    expect(found.outside).toBe(1)
  })

  it("takes a linked workspace package's own dependencies, which pnpm doesn't hoist", () => {
    const app = join(workspace, 'packages/app')
    mkdirSync(join(app, 'node_modules/@app'), { recursive: true })
    // Before the link: Windows makes a link to a missing target a file link.
    const zod = file(
      join(workspace, 'packages/shared/node_modules/zod/index.d.ts')
    )
    symlinkSync('../../../shared', join(app, 'node_modules/@app/shared'))
    expect(typeInformation(app, workspace)).toEqual({
      files: [zod],
      links: [
        {
          path: 'packages/app/node_modules/@app/shared',
          target: 'packages/shared'
        }
      ],
      outside: 0
    })
  })

  nonRootIt('skips a directory it cannot read', () => {
    const locked = join(workspace, 'data')
    file(join(locked, 'x'))
    const found = file(join(workspace, 'node_modules/x/index.d.ts'))
    chmodSync(locked, 0o000)
    try {
      expect(files(workspace)).toEqual([found])
    } finally {
      chmodSync(locked, 0o755)
    }
  })

  it('are shipped with the settings, links in the manifest', () => {
    const declaration = file(join(workspace, 'node_modules/x/index.d.ts'))
    const links = [{ path: 'node_modules/y', target: 'packages/y' }]
    stageAnalysis(
      new Map([['sonar.projectBaseDir', workspace]]),
      { workspace, home },
      staging,
      'scanner',
      undefined,
      [declaration],
      links
    )
    expect(
      existsSync(join(staging, 'workspace/node_modules/x/index.d.ts'))
    ).toBe(true)
    expect(
      JSON.parse(readFileSync(join(staging, 'settings.json'), 'utf8')).links
    ).toEqual(links)
  })
})
