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
  statSync,
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
import { ARTIFACT_FORMAT } from '../src/prepare.js'
import { placeholder, settingText, trustedKeys } from './arbitraries.js'

let root = ''
let workspace: string
let outside: string

// Each run gets its own directories: the code under test writes to them. The checkout sits a few
// levels down, so a path climbing out of it still lands where the snapshot of the root sees it.
function freshDirectories(): void {
  root = mkdtempSync(join(tmpdir(), 'boundary-'))
  const base = join(root, 'a', 'b', 'c', 'd')
  workspace = join(base, 'work')
  outside = join(base, 'outside')
  mkdirSync(workspace, { recursive: true })
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

// Given snapshots of the root, checks that nothing there changed and that everything added is in the
// checkout; gives back what was added, relative to the checkout.
function addedToCheckout(
  before: Map<string, string>,
  after: Map<string, string>
): string[] {
  for (const [path, was] of before)
    expect({ path, now: after.get(path) }).toEqual({ path, now: was })
  const checkout = relative(root, workspace) + sep
  const added = [...after.keys()].filter((path) => !before.has(path))
  for (const path of added)
    expect({ path, inCheckout: path.startsWith(checkout) }).toEqual({
      path,
      inCheckout: true
    })
  return added.map((path) => path.slice(checkout.length))
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
      format: fc.oneof(fc.constant(ARTIFACT_FORMAT), fc.jsonValue()),
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
          /^(?:it (?:was prepared by an incompatible version|holds settings that are not all text).*)?$/s
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
  // What a fork's build must never pass on: the token, where the analysis goes, the scanner's own
  // settings, anything that starts a program.
  const forbidden = [
    ...trustedKeys,
    'sonar.token',
    'sonar.login',
    'sonar.scanner.javaExePath',
    'sonar.scanner.javaOpts',
    'sonar.nodejs.executable',
    'sonar.plsql.jdbc.driver.path',
    'sonar.sca.enabled',
    'sonar.working.directory',
    'sonar.userHome'
  ]
  const bareKey = fc.oneof(
    fc.constantFrom(...forbidden, ...pathKeys, 'sonar.modules'),
    settingText,
    // Keys the allowlist keeps whatever follows or precedes, so random text reaches the later checks.
    fc
      .tuple(
        fc.constantFrom('sonar.issue.ignore.', 'sonar.links.'),
        settingText
      )
      .map(([prefix, text]) => prefix + text),
    settingText.map((text) => `sonar.${text}.exclusions`),
    settingText.map((text) => `sonar.${text}.reportPaths`)
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

  // Modules m and n with bases the checks accept, so their keys are kept rather than refused.
  const modules = {
    'sonar.modules': 'm,n',
    'm.sonar.projectBaseDir': '{workspace}/src',
    'n.sonar.projectBaseDir': '{workspace}/lib'
  }
  const settings = fc.oneof(
    fc.dictionary(key, value),
    fc.dictionary(key, value).map((random) => ({ ...random, ...modules }))
  )

  it('keeps no forbidden setting, no placeholder in values, no half character, and fails only by refusing', () => {
    freshDirectories()
    mkdirSync(join(workspace, 'src'))
    mkdirSync(join(workspace, 'lib'))
    const home = join(root, 'home')
    fc.assert(
      fc.property(settings, (settings) => {
        const { value: resolved, refusal = '' } = outcome(() =>
          resolveSettings(settings, workspace, home)
        )
        expect(refusal).toMatch(
          /^(?:.*no base directory in the checkout|Invalid module id.*)?$/s
        )
        const properties = resolved?.properties ?? new Map<string, string>()
        // The scanner expands placeholders in values only.
        for (const [key, value] of properties) {
          expect(placeholder.test(value)).toBe(false)
          expect(/\p{Cs}/u.test(key + value)).toBe(false)
        }
        for (const forbiddenKey of forbidden)
          for (const prefix of ['', 'm.', 'n.'])
            expect(properties.has(prefix + forbiddenKey)).toBe(false)
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
  'SONAR-PROJECT.PROPERTIES',
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
    // Climbing out of the checkout, into directories named node_modules on the way.
    {
      weight: 1,
      arbitrary: fc.constantFrom(
        '../node_modules/pkg',
        'node_modules/../../node_modules/pkg',
        'node_modules/../../../node_modules/pkg'
      )
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
        'g/hooks',
        'src/leak'
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
          // Out of the checkout through src/up, to Node's own realpathSync the decoy src/outside.
          mkdirSync(join(workspace, 'src/outside'))
          symlinkSync('..', join(workspace, 'src/up'))
          symlinkSync('up/../outside', join(workspace, 'src/leak'))
          file(join(workspace, 'README.md'))
          const realWorkspace = realpathSync.native(workspace)
          const before = snapshot(root)

          recreateLinks(workspace, links)

          for (const path of addedToCheckout(before, snapshot(root))) {
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
            const target = realpathSync.native(join(workspace, path))
            expect(statSync(target).isDirectory()).toBe(true)
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
    path: fc.array(segment, { maxLength: 4 }),
    name: fc.constantFrom(
      'Main.java',
      'report.xml',
      'index.d.ts',
      'package.json',
      'config',
      'README.md',
      'sonar-project.properties',
      'SONAR-PROJECT.PROPERTIES',
      'new.txt',
      'dangling'
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
          // A check that follows links would see nothing here, and write through it.
          symlinkSync(join(outside, 'new'), join(workspace, 'dangling'))
          const realSources = realpathSync.native(join(workspace, 'src'))
          const report = join(realSources, 'report.xml')
          const before = snapshot(root)

          unpackWorkspace(
            artifact,
            workspace,
            [join(workspace, 'src')],
            [report]
          )

          for (const path of addedToCheckout(before, snapshot(root))) {
            const segments = path.split(sep)
            expect(segments.some(isGit)).toBe(false)
            // The scanner reads settings from a file by that name in any case; a directory only
            // matters by its exact name, which is the one Linux has.
            const real = join(realpathSync.native(workspace), path)
            const isDirectory = lstatSync(real).isDirectory()
            const name = segments.at(-1) ?? ''
            expect(isDirectory ? name : name.toLowerCase()).not.toBe(
              'sonar-project.properties'
            )
            if (!within(real, realSources) || real === realSources) continue
            if (isDirectory) continue
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
