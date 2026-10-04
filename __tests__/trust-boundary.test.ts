// What the analysis does with an artifact the fork wrote, tried on generated artifacts: whatever is
// in it, the checkout and everything outside it end up only as the rules below allow.
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import fc from 'fast-check'
import {
  readManifest,
  recreateLinks,
  resolveSettings,
  unpackWorkspace
} from '../src/analyze.js'
import { placeholder, settingText, trustedKeys } from './arbitraries.js'

let root = ''
let workspace: string
let outside: string

// Each run gets its own directories: the code under test writes to them.
function freshDirectories(): void {
  root = mkdtempSync(join(tmpdir(), 'boundary-'))
  workspace = join(root, 'work')
  outside = join(root, 'outside')
  mkdirSync(workspace)
  mkdirSync(outside)
  writeFileSync(join(outside, 'secret'), 'secret')
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

function file(path: string, content = 'x'): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

// Every entry under a directory, links recorded but never followed: what each path is, and its
// content or target.
function snapshot(directory: string): Map<string, string> {
  const entries = new Map<string, string>()
  const visit = (path: string): void => {
    for (const name of readdirSync(path)) {
      const child = join(path, name)
      const rel = relative(directory, child)
      const stats = lstatSync(child)
      if (stats.isSymbolicLink())
        entries.set(rel, `link ${readlinkSync(child)}`)
      else if (stats.isDirectory()) {
        entries.set(rel, 'directory')
        visit(child)
      } else entries.set(rel, `file ${readFileSync(child, 'utf8')}`)
    }
  }
  visit(directory)
  return entries
}

function added(
  before: Map<string, string>,
  after: Map<string, string>
): string[] {
  for (const [path, was] of before)
    expect({ path, now: after.get(path) }).toEqual({ path, now: was })
  return [...after.keys()].filter((path) => !before.has(path))
}

// What a call gave back, or the message of what it threw, so a property can check either.
function outcome<T>(call: () => T): { value?: T; refusal?: string } {
  try {
    return { value: call() }
  } catch (error) {
    return { refusal: error instanceof Error ? error.message : String(error) }
  }
}

const isGit = (segment: string): boolean =>
  /^(?:\.git|git~\d+)$/i.test(segment.replace(/[. ]+$/, ''))

const within = (path: string, directory: string): boolean =>
  path === directory || path.startsWith(directory + sep)

describe('readManifest on any JSON', () => {
  const manifest = fc.oneof(
    fc.jsonValue(),
    fc.record({
      format: fc.oneof(fc.constant(1), fc.jsonValue()),
      settings: fc.oneof(
        fc.dictionary(fc.string(), fc.oneof(fc.string(), fc.jsonValue())),
        fc.jsonValue()
      ),
      links: fc.jsonValue(),
      pullRequest: fc.jsonValue()
    })
  )

  it('gives settings that are all text, or refuses the artifact', () => {
    fc.assert(
      fc.property(manifest, (value) => {
        const { value: manifest, refusal = '' } = outcome(() =>
          readManifest(JSON.stringify(value), 'it')
        )
        expect(refusal).toMatch(
          /^(?:it (?:was prepared by an incompatible version|holds settings that are not all text).*)?$/
        )
        for (const setting of Object.values(manifest?.settings ?? {}))
          expect(typeof setting).toBe('string')
      }),
      { numRuns: 1000 }
    )
  })
})

describe('resolveSettings on any settings', () => {
  const pathKeys = [
    'sonar.sources',
    'sonar.tests',
    'sonar.projectBaseDir',
    'sonar.java.binaries',
    'sonar.coverageReportPaths',
    'sonar.projectBuildDir'
  ]
  const bareKey = fc.oneof(
    fc.constantFrom(...trustedKeys, ...pathKeys, 'sonar.modules'),
    settingText
  )
  const key = fc.oneof(
    bareKey,
    bareKey.map((key) => `m.${key}`),
    bareKey.map((key) => `n.${key}`)
  )
  const pathEntry = fc.constantFrom(
    'src',
    '',
    ' ',
    '.',
    '..',
    'src/**',
    '"src"',
    '{workspace}',
    '{workspace}/src',
    '{home}/lib.jar',
    '/etc'
  )
  const value = fc.oneof(
    settingText,
    fc.array(pathEntry, { maxLength: 4 }).map((entries) => entries.join(',')),
    fc.constantFrom(
      'm',
      'm,n',
      'sonar',
      '${env.SONAR_TOKEN}',
      '{workspace}',
      '{workspace}/src',
      '{home}/lib.jar',
      '/etc',
      '..',
      'src,../outside'
    )
  )

  it('keeps no trusted setting, placeholder or half character, and fails only by refusing', () => {
    freshDirectories()
    mkdirSync(join(workspace, 'src'))
    const home = join(root, 'home')
    fc.assert(
      fc.property(fc.dictionary(key, value), (settings) => {
        const { value: resolved, refusal = '' } = outcome(() =>
          resolveSettings(settings, workspace, home)
        )
        expect(refusal).toMatch(
          /^(?:.*no base directory in the checkout|Invalid module id.*)?$/
        )
        const properties = resolved?.properties ?? new Map<string, string>()
        for (const [key, value] of properties) {
          for (const text of [key, value]) {
            expect(placeholder.test(text)).toBe(false)
            expect(/\p{Cs}/u.test(text)).toBe(false)
          }
        }
        for (const trusted of trustedKeys)
          for (const prefix of ['', 'm.', 'n.'])
            expect(properties.has(prefix + trusted)).toBe(false)
      }),
      { numRuns: 1000 }
    )
  })
})

const segment = fc.constantFrom(
  'node_modules',
  '.pnpm',
  'pkg',
  'packages',
  'a',
  'src',
  'out',
  'lnk',
  'target',
  'README.md',
  '..',
  '.',
  '',
  '.git',
  '.GIT.',
  'GIT~1',
  'hooks',
  'sonar-project.properties',
  'x:y',
  'a\\b'
)
const pathText = fc.oneof(
  fc.array(segment, { minLength: 1, maxLength: 5 }).map((s) => s.join('/')),
  fc.array(segment, { maxLength: 3 }).map((s) => `/${s.join('/')}`)
)

describe('recreateLinks on any links', () => {
  // Mostly links that could be made, so the checks that refuse them are reached: a place a link may
  // or may not go, and the directories of the checkout set up below, links and .git among them.
  const linkPath = fc.oneof(
    {
      weight: 3,
      arbitrary: fc
        .tuple(
          fc.constantFrom(
            'node_modules',
            'node_modules/@scope',
            'packages/a/node_modules',
            'packages',
            'src',
            'node_modules/.git',
            'lnk/node_modules',
            'out/node_modules'
          ),
          fc.constantFrom(
            'pkg',
            'new',
            '.pnpm',
            'a',
            'sonar-project.properties',
            '.git'
          )
        )
        .map(([directory, name]) => `${directory}/${name}`)
    },
    { weight: 1, arbitrary: pathText }
  )
  const linkTarget = fc.oneof(
    {
      weight: 3,
      arbitrary: fc.constantFrom(
        'packages/a',
        'packages',
        'node_modules/.pnpm/pkg/node_modules/pkg',
        'src',
        'out',
        'lnk',
        '.git',
        '.git/hooks',
        '.',
        '..',
        '../outside',
        'README.md',
        'missing',
        'self',
        'g',
        'g/hooks'
      )
    },
    { weight: 1, arbitrary: pathText }
  )
  const link = fc.oneof(
    { weight: 4, arbitrary: fc.record({ path: linkPath, target: linkTarget }) },
    { weight: 1, arbitrary: fc.anything() }
  )
  const links = fc.oneof(
    { weight: 4, arbitrary: fc.array(link, { minLength: 1, maxLength: 8 }) },
    { weight: 1, arbitrary: fc.anything() }
  )

  it('only adds links in node_modules to directories of the checkout outside .git', () => {
    fc.assert(
      fc.property(links, (links) => {
        freshDirectories()
        try {
          mkdirSync(
            join(workspace, 'node_modules/.pnpm/pkg/node_modules/pkg'),
            {
              recursive: true
            }
          )
          mkdirSync(join(workspace, 'packages/a'), { recursive: true })
          mkdirSync(join(workspace, 'src'))
          mkdirSync(join(workspace, '.git/hooks'), { recursive: true })
          symlinkSync(outside, join(workspace, 'out'))
          symlinkSync('packages', join(workspace, 'lnk'))
          // Committed links to the checkout itself and into .git, which only resolving reveals.
          symlinkSync('.', join(workspace, 'self'))
          symlinkSync('.git', join(workspace, 'g'))
          file(join(workspace, 'README.md'))
          const realWorkspace = realpathSync(workspace)
          const before = snapshot(workspace)
          const outsideBefore = snapshot(outside)

          recreateLinks(workspace, links)

          expect(snapshot(outside)).toEqual(outsideBefore)
          for (const path of added(before, snapshot(workspace))) {
            const stats = lstatSync(join(workspace, path))
            expect(stats.isFile()).toBe(false)
            const segments = path.split(sep)
            expect(segments.some(isGit)).toBe(false)
            expect(
              segments.some(
                (s) => s.toLowerCase() === 'sonar-project.properties'
              )
            ).toBe(false)
            if (!stats.isSymbolicLink()) continue
            expect(segments.slice(0, -1)).toContain('node_modules')
            const target = realpathSync(join(workspace, path))
            expect(target).not.toBe(realWorkspace)
            expect(within(target, realWorkspace)).toBe(true)
            expect(relative(realWorkspace, target).split(sep).some(isGit)).toBe(
              false
            )
          }
        } finally {
          rmSync(root, { recursive: true, force: true })
        }
      }),
      { numRuns: 500 }
    )
  })
})

describe('unpackWorkspace on any artifact', () => {
  const artifactFile = fc.record({
    path: fc.array(segment, { minLength: 1, maxLength: 4 }),
    name: fc.constantFrom(
      'Main.java',
      'report.xml',
      'index.d.ts',
      'package.json',
      'config',
      'README.md',
      'sonar-project.properties',
      'SONAR-PROJECT.PROPERTIES',
      'new.txt'
    ),
    content: fc.constantFrom('artifact', '')
  })

  it('writes only new files, outside .git, and into the sources only reports and type information', () => {
    fc.assert(
      fc.property(fc.array(artifactFile, { maxLength: 8 }), (files) => {
        freshDirectories()
        try {
          const artifact = join(root, 'artifact')
          mkdirSync(artifact)
          for (const { path, name, content } of files) {
            // Only what a file system can hold: no '..' or '.' names, no file where a directory is.
            const segments = path.filter((s) => !['', '.', '..'].includes(s))
            try {
              file(join(artifact, ...segments, name), content)
            } catch {
              continue
            }
          }
          file(join(workspace, 'src/Main.java'), 'main')
          mkdirSync(join(workspace, 'src/node_modules'))
          file(join(workspace, '.git/config'), 'git')
          file(join(workspace, 'target/old.txt'), 'old')
          file(join(workspace, 'README.md'), 'readme')
          symlinkSync(outside, join(workspace, 'out'))
          symlinkSync('src', join(workspace, 'lnk'))
          const realSources = realpathSync(join(workspace, 'src'))
          const report = join(realSources, 'report.xml')
          const before = snapshot(workspace)
          const outsideBefore = snapshot(outside)

          unpackWorkspace(
            artifact,
            workspace,
            [join(workspace, 'src')],
            [report]
          )

          expect(snapshot(outside)).toEqual(outsideBefore)
          for (const path of added(before, snapshot(workspace))) {
            const segments = path.split(sep)
            expect(segments.some(isGit)).toBe(false)
            expect(segments.at(-1)?.toLowerCase()).not.toBe(
              'sonar-project.properties'
            )
            const real = join(realpathSync(workspace), path)
            if (!within(real, realSources) || real === realSources) continue
            if (lstatSync(real).isDirectory()) continue
            const typeInformation =
              segments.includes('node_modules') &&
              /^(?:package\.json|.*\.d\.[cm]?ts|tsconfig.*\.json)$/.test(
                segments.at(-1) ?? ''
              )
            expect({
              path,
              allowed: real === report || typeInformation
            }).toEqual({
              path,
              allowed: true
            })
          }
        } finally {
          rmSync(root, { recursive: true, force: true })
        }
      }),
      { numRuns: 300 }
    )
  })
})
