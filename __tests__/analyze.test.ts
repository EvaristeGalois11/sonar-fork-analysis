import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  existsSync,
  lstatSync,
  readlinkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import fc from 'fast-check'
import { identitiesUnder, landsOn } from '../__fixtures__/identity.js'
import { invalidUtf8It, posixIt } from '../__fixtures__/platform.js'
import {
  checkNoLinks,
  formatProperties,
  readManifest,
  recreateLinks,
  removeOutwardLinks,
  removeProjectSettings,
  resolveSettings,
  trustedProperties,
  unpackWorkspace
} from '../src/analyze.js'
import { parseProperties } from '../src/properties.js'
import { NO_FILE } from '../src/languages.js'
import { settingText, settingsWithoutPlaceholders } from './arbitraries.js'

let root: string
let workspace: string
let home: string
let artifact: string
let outside: string

function file(path: string, content = 'x'): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

beforeEach(() => {
  // The real path, as analyze compares them: macOS's temporary directory is behind a link.
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'analyze-')))
  workspace = join(root, 'work')
  home = join(root, 'home')
  artifact = join(root, 'artifact')
  outside = join(root, 'outside')
  for (const directory of [workspace, home, artifact, outside])
    mkdirSync(directory)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('resolveSettings', () => {
  it('maps placeholders onto the workspace and the private home', () => {
    file(join(workspace, 'app/src/main/java/App.java'))
    const resolved = resolveSettings(
      {
        'sonar.projectBaseDir': '{workspace}/app',
        'sonar.sources': '{workspace}/app/src/main/java',
        'sonar.java.binaries': '{workspace}/app/target/classes',
        'sonar.java.libraries': '{home}/.m2/junit.jar',
        'sonar.java.source': '21'
      },
      workspace,
      home
    )
    expect(Object.fromEntries(resolved.properties)).toEqual({
      'sonar.projectBaseDir': join(workspace, 'app'),
      'sonar.sources': join(workspace, 'app/src/main/java'),
      'sonar.java.binaries': join(workspace, 'app/target/classes'),
      'sonar.java.libraries': join(home, '.m2/junit.jar'),
      'sonar.java.source': '21'
    })
    expect(resolved.sourceRoots).toEqual([join(workspace, 'app/src/main/java')])
  })

  it('lists the report files where they land in the checkout', () => {
    const resolved = resolveSettings(
      {
        'sonar.sources': '.',
        'sonar.javascript.lcov.reportPaths': 'coverage/lcov.info'
      },
      workspace,
      home
    )
    expect(resolved.reports).toEqual([
      join(realpathSync.native(workspace), 'coverage/lcov.info')
    ])
  })

  it('takes a list too long to spread onto the stack', () => {
    const resolved = resolveSettings(
      {
        'sonar.sources': '.',
        'sonar.javascript.lcov.reportPaths': Array(200_000).fill('a').join(',')
      },
      workspace,
      home
    )
    expect(resolved.reports).toHaveLength(200_000)
  })

  it('drops settings the analysis decides itself', () => {
    const resolved = resolveSettings(
      {
        'sonar.sca.enabled': 'true',
        'sonar.sca.mavenOptions': '-Dexec=evil',
        'sonar.host.url': 'https://evil.example.com',
        'sonar.scanner.javaOpts': '-javaagent:x.jar',
        'sonar.projectKey': 'someone-else'
      },
      workspace,
      home
    )
    expect(resolved.properties.size).toBe(0)
    expect(resolved.warnings).toEqual([
      'Dropped settings a build never ships: sonar.sca.enabled, sonar.sca.mavenOptions, sonar.host.url, sonar.scanner.javaOpts, sonar.projectKey'
    ])
  })

  it('leaves patterns to the build, which ships what they match', () => {
    const resolved = resolveSettings(
      {
        'sonar.coverage.jacoco.xmlReportPaths':
          '**/jacoco.xml,{workspace}/target/jacoco.xml'
      },
      workspace,
      home
    )
    expect(
      resolved.properties.get('sonar.coverage.jacoco.xmlReportPaths')
    ).toBe(join(workspace, 'target/jacoco.xml'))
    expect(resolved.warnings).toEqual([
      'Dropped sonar.coverage.jacoco.xmlReportPaths entry: **/jacoco.xml'
    ])
  })

  posixIt('refuses patterns behind placeholders and in checkout paths', () => {
    mkdirSync(join(workspace, '**'))
    file(join(workspace, '**/tsconfig.json'))
    const resolved = resolveSettings(
      {
        'sonar.javascript.lcov.reportPaths':
          '{workspace}/**/lcov.info,{home}/*.info',
        'sonar.typescript.tsconfigPaths': '**/tsconfig.json'
      },
      workspace,
      home
    )
    expect(resolved.properties.get('sonar.javascript.lcov.reportPaths')).toBe(
      ''
    )
    expect(resolved.properties.get('sonar.typescript.tsconfigPaths')).toBe('')
    expect(resolved.warnings).toHaveLength(3)
  })

  posixIt(
    'refuses a base directory the scanner would read as a pattern',
    () => {
      mkdirSync(join(workspace, '**'))
      expect(() =>
        resolveSettings(
          {
            'sonar.projectBaseDir': '{workspace}/**',
            'sonar.coverage.jacoco.xmlReportPaths': 'jacoco.xml'
          },
          workspace,
          home
        )
      ).toThrow('no base directory in the checkout')
    }
  )

  it('refuses a base directory inside .git, also through a link', () => {
    mkdirSync(join(workspace, '.git/hooks'), { recursive: true })
    symlinkSync('.git', join(workspace, 'git'))
    for (const base of ['{workspace}/.git/hooks', '{workspace}/git/hooks'])
      expect(() =>
        resolveSettings(
          { 'sonar.modules': 'm', 'm.sonar.projectBaseDir': base },
          workspace,
          home
        )
      ).toThrow('gives module m no base directory in the checkout')
  })

  it('drops paths escaping the workspace or home', () => {
    const resolved = resolveSettings(
      {
        'sonar.java.binaries':
          '{workspace}/../outside,{home}/../../etc,/etc/passwd,../up'
      },
      workspace,
      home
    )
    expect(resolved.properties.get('sonar.java.binaries')).toBe('')
    expect(resolved.warnings).toHaveLength(4)
  })

  posixIt('drops paths through a link that climbs out of the checkout', () => {
    climbOut()
    const resolved = resolveSettings(
      { 'sonar.java.binaries': '{workspace}/a/leak' },
      workspace,
      home
    )
    expect(resolved.properties.get('sonar.java.binaries')).toBe('')
    expect(resolved.warnings).toHaveLength(1)
  })

  it('drops paths that would appear behind a link out of the checkout', () => {
    symlinkSync(outside, join(workspace, 'out'))
    const resolved = resolveSettings(
      { 'sonar.java.binaries': '{workspace}/out/classes' },
      workspace,
      home
    )
    expect(resolved.properties.get('sonar.java.binaries')).toBe('')
    expect(resolved.warnings).toHaveLength(1)
  })

  it('accepts build directories that only appear when unpacking', () => {
    const resolved = resolveSettings(
      {
        'sonar.sources': '',
        'sonar.projectBuildDir': '{workspace}/target',
        'sonar.java.binaries': '{workspace}/target/classes'
      },
      workspace,
      home
    )
    expect(resolved.properties.get('sonar.projectBuildDir')).toBe(
      join(workspace, 'target')
    )
    expect(resolved.warnings).toEqual([])
    expect(resolved.sourceRoots).toEqual([])
  })

  it('keeps build directories inside the workspace', () => {
    const resolved = resolveSettings(
      { 'sonar.projectBuildDir': '{home}/target' },
      workspace,
      home
    )
    expect(resolved.properties.get('sonar.projectBuildDir')).toBe('')
  })

  it('resolves relative entries against their module', () => {
    file(join(workspace, 'app/src/App.java'))
    const resolved = resolveSettings(
      {
        'sonar.modules': 'app',
        'app.sonar.projectBaseDir': '{workspace}/app',
        'app.sonar.sources': 'src',
        'app.sonar.java.binaries': 'target/classes'
      },
      workspace,
      home
    )
    expect(resolved.properties.get('app.sonar.sources')).toBe(
      join(workspace, 'app/src')
    )
    expect(resolved.properties.get('app.sonar.java.binaries')).toBe(
      join(workspace, 'app/target/classes')
    )
  })

  it('refuses a module without a base directory in the checkout', () => {
    // The scanner would place it under its parent by id.
    expect(() =>
      resolveSettings(
        { 'sonar.modules': 'app', 'app.sonar.sources': 'src' },
        workspace,
        home
      )
    ).toThrow(/module app no base directory/)
    expect(() =>
      resolveSettings(
        {
          'sonar.modules': 'app',
          'app.sonar.projectBaseDir': '{home}'
        },
        workspace,
        home
      )
    ).toThrow(/module app no base directory/)
  })

  it('refuses a module whose base goes to another module, as the engine assigns keys', () => {
    // a.b takes every a.b.* key before a does, so a's module b.c gets no base: the engine would
    // place it at a/b.c, unchecked.
    mkdirSync(join(workspace, 'a'))
    mkdirSync(join(workspace, 'ab'))
    mkdirSync(join(workspace, 'checked'))
    expect(() =>
      resolveSettings(
        {
          'sonar.modules': 'a,a.b',
          'a.sonar.modules': 'b.c',
          'a.sonar.projectBaseDir': '{workspace}/a',
          'a.b.sonar.projectBaseDir': '{workspace}/ab',
          'a.b.c.sonar.projectBaseDir': '{workspace}/checked'
        },
        workspace,
        home
      )
    ).toThrow(/module a\.b\.c no base directory/)
  })

  it('drops settings holding half of a character', () => {
    // Java reads a\ud800b as a?b, which the checkout could hold as a link.
    const resolved = resolveSettings(
      {
        'sonar.java.binaries': '{workspace}/a\ud800b',
        'sonar.exclusions\udfff': 'x',
        'sonar.java.source': '21'
      },
      workspace,
      home
    )
    expect([...resolved.properties.keys()]).toEqual(['sonar.java.source'])
    expect(resolved.warnings).toHaveLength(2)
  })

  it('follows links in the checkout before accepting a path', () => {
    file(join(workspace, 'gen/.keep'))
    symlinkSync(outside, join(workspace, 'leak'))
    symlinkSync(join(workspace, 'gen'), join(workspace, 'alias'))
    const resolved = resolveSettings(
      { 'sonar.sources': '{workspace}/leak,{workspace}/alias' },
      workspace,
      home
    )
    expect(resolved.properties.get('sonar.sources')).toBe(
      join(workspace, 'alias')
    )
    // Protected where the files really are, so nothing can be unpacked into gen/ either.
    expect(resolved.sourceRoots).toEqual([join(workspace, 'gen')])
  })

  it('protects the whole module when it names no sources', () => {
    expect(resolveSettings({}, workspace, home).sourceRoots).toEqual([
      workspace
    ])
  })

  it('drops values the scanner would expand, e.g. into the Sonar token', () => {
    file(join(workspace, 'src/App.java'))
    const resolved = resolveSettings(
      {
        'sonar.sources': '{workspace}/src',
        'sonar.projectDescription': '${env.SONAR_TOKEN}',
        'sonar.exclusions': '**/${sonar.login}/**',
        'sonar.links.homepage': 'https://x.example/${env.HOME}',
        'sonar.projectVersion': 'costs $5 {or more}'
      },
      workspace,
      home
    )
    expect(Object.fromEntries(resolved.properties)).toEqual({
      'sonar.sources': join(workspace, 'src'),
      'sonar.projectVersion': 'costs $5 {or more}'
    })
    expect(resolved.warnings).toHaveLength(3)
  })

  it('reads the module tree only after dropping placeholders', () => {
    // Otherwise b's keys would pass the allowlist as a module's and be written unchecked.
    const resolved = resolveSettings(
      { 'sonar.modules': 'b,${env.SONAR_TOKEN}', 'b.sonar.sources': '/etc' },
      workspace,
      home
    )
    expect(resolved.properties.has('b.sonar.sources')).toBe(false)
  })

  it('drops a placeholder before reading modules from it', () => {
    const resolved = resolveSettings(
      { 'sonar.modules': '${env.SONAR_TOKEN}' },
      workspace,
      home
    )
    expect(resolved.properties.has('sonar.modules')).toBe(false)
  })

  it('only accepts sources the checkout already has', () => {
    file(join(workspace, 'src/App.java'))
    const resolved = resolveSettings(
      { 'sonar.sources': '{workspace}/src,{workspace}/target/evil' },
      workspace,
      home
    )
    expect(resolved.properties.get('sonar.sources')).toBe(
      join(workspace, 'src')
    )
    expect(resolved.sourceRoots).toEqual([join(workspace, 'src')])
  })
})

describe('unpackWorkspace', () => {
  it('adds build output next to the checkout', () => {
    file(join(artifact, 'app/target/classes/App.class'), 'bytes')
    expect(unpackWorkspace(artifact, workspace, [])).toEqual([])
    expect(
      readFileSync(join(workspace, 'app/target/classes/App.class'), 'utf8')
    ).toBe('bytes')
  })

  it('never overwrites the checkout', () => {
    file(join(workspace, 'libs/tool.jar'), 'committed')
    file(join(artifact, 'libs/tool.jar'), 'from the fork')
    expect(unpackWorkspace(artifact, workspace, [])).toEqual([
      `Skipped ${join('libs', 'tool.jar')}: it already exists in the checkout`
    ])
    expect(readFileSync(join(workspace, 'libs/tool.jar'), 'utf8')).toBe(
      'committed'
    )
  })

  it('does not follow a symlink committed in the checkout', () => {
    symlinkSync(outside, join(workspace, 'target'))
    file(join(artifact, 'target/classes/App.class'))
    expect(unpackWorkspace(artifact, workspace, [])[0]).toMatch(/is a link/)
    expect(existsSync(join(outside, 'classes'))).toBe(false)
  })

  it('does not write through a dangling symlink', () => {
    symlinkSync(join(outside, 'missing'), join(workspace, 'target'))
    file(join(artifact, 'target/App.class'))
    expect(unpackWorkspace(artifact, workspace, [])[0]).toMatch(/is a link/)
    expect(existsSync(join(outside, 'missing'))).toBe(false)
  })

  it('does not write a file through a dangling symlink of its name', () => {
    symlinkSync(join(outside, 'missing'), join(workspace, 'App.class'))
    file(join(artifact, 'App.class'))
    expect(unpackWorkspace(artifact, workspace, [])).toEqual([
      'Skipped App.class: it already exists in the checkout'
    ])
    expect(existsSync(join(outside, 'missing'))).toBe(false)
  })

  it('keeps out of .git and the sources', () => {
    const sources = join(workspace, 'src')
    mkdirSync(sources)
    file(join(artifact, '.git/hooks/post-checkout'))
    file(join(artifact, 'src/Evil.java'))
    expect(unpackWorkspace(artifact, workspace, [sources]).sort()).toEqual([
      `Skipped ${join('.git', 'hooks', 'post-checkout')}: inside .git`,
      `Skipped ${join('src', 'Evil.java')}: inside the sources`
    ])
  })

  it('knows the sources by identity, not by the name they are reached through', () => {
    // As on a case-insensitive file system, where SRC is src.
    const sources = join(workspace, 'src')
    mkdirSync(sources)
    symlinkSync(sources, join(outside, 'alias'))
    file(join(artifact, 'src/Evil.ts'))
    expect(
      unpackWorkspace(artifact, workspace, [join(outside, 'alias')])
    ).toEqual([`Skipped ${join('src', 'Evil.ts')}: inside the sources`])
  })

  it('protects the sources when the checkout itself is reached through a link', () => {
    const linked = join(outside, 'checkout')
    symlinkSync(workspace, linked, 'dir')
    file(join(artifact, 'Evil.java'))
    expect(unpackWorkspace(artifact, linked, [linked])).toEqual([
      'Skipped Evil.java: inside the sources'
    ])
  })

  it('stays quiet about type information the checkout already has', () => {
    file(join(workspace, 'node_modules/fixture/index.d.ts'), 'committed')
    file(join(workspace, 'node_modules/fixture/index.js'), 'committed')
    file(join(artifact, 'node_modules/fixture/index.d.ts'))
    file(join(artifact, 'node_modules/fixture/index.js'))
    expect(unpackWorkspace(artifact, workspace, [])).toEqual([
      `Skipped ${join('node_modules', 'fixture', 'index.js')}: it already exists in the checkout`
    ])
  })

  it('lets only reports and type declarations join the sources', () => {
    // A Node project analysing the whole of it: sonar.sources=.
    const real = realpathSync.native(workspace)
    file(join(artifact, 'coverage/lcov.info'))
    file(join(artifact, 'node_modules/express/index.d.ts'))
    file(join(artifact, 'node_modules/express/package.json'))
    file(join(artifact, 'node_modules/@tsconfig/node22/tsconfig.json'))
    file(join(artifact, 'node_modules/express/index.js'))
    file(join(artifact, 'src/global.d.ts'))
    file(join(artifact, 'src/package.json'))
    expect(
      unpackWorkspace(
        artifact,
        workspace,
        [real],
        [join(real, 'coverage/lcov.info')]
      ).sort()
    ).toEqual([
      `Skipped ${join('node_modules', 'express', 'index.js')}: inside the sources`,
      `Skipped ${join('src', 'global.d.ts')}: inside the sources`,
      `Skipped ${join('src', 'package.json')}: inside the sources`
    ])
    expect(existsSync(join(workspace, 'coverage/lcov.info'))).toBe(true)
    expect(existsSync(join(workspace, 'node_modules/express/index.d.ts'))).toBe(
      true
    )
  })

  it.each([
    'app/.git/config',
    'app/.GIT/config',
    'app/.git./config',
    'GIT~1/x'
  ])('never plants a repository, such as %s', (path) => {
    file(join(artifact, path))
    expect(unpackWorkspace(artifact, workspace, [])).toEqual([
      `Skipped ${join(...path.split('/'))}: inside .git`
    ])
  })

  it('never adds scanner settings', () => {
    file(join(artifact, 'app/sonar-project.properties'))
    expect(unpackWorkspace(artifact, workspace, [])[0]).toMatch(
      /read it as settings/
    )
    expect(existsSync(join(workspace, 'app/sonar-project.properties'))).toBe(
      false
    )
  })
})

describe('readManifest', () => {
  const read = (manifest: unknown) =>
    readManifest(JSON.stringify(manifest), 'the artifact')

  it('takes text settings and leaves links and the pull request to their own checks', () => {
    expect(
      read({ format: 1, settings: { 'sonar.sources': 'src' }, links: 'x' })
    ).toEqual({
      settings: { 'sonar.sources': 'src' },
      links: 'x',
      pullRequest: undefined
    })
  })

  it('refuses another format or no object at all', () => {
    for (const manifest of [{ format: 2, settings: {} }, null, [], 'text'])
      expect(() => read(manifest)).toThrow(
        'the artifact was prepared by an incompatible version of this action'
      )
  })

  it('refuses settings that are not all text', () => {
    for (const settings of [
      null,
      ['sonar.sources'],
      { 'sonar.sources': ['src'] },
      { 'sonar.sources': 1 }
    ])
      expect(() => read({ format: 1, settings })).toThrow(
        'the artifact holds settings that are not all text'
      )
  })
})

describe('checkNoLinks', () => {
  it('rejects an artifact containing a symlink', () => {
    symlinkSync('/etc/passwd', join(artifact, 'passwd'))
    expect(() => {
      checkNoLinks(artifact)
    }).toThrow(/link or special file/)
  })

  it('accepts plain files and directories', () => {
    file(join(artifact, 'a/b.txt'))
    expect(() => {
      checkNoLinks(artifact)
    }).not.toThrow()
  })

  it('accepts names in any language', () => {
    for (const name of ['café', '日本語', '😀', 'x\uFFFD'])
      file(join(artifact, name, name))
    expect(() => {
      checkNoLinks(artifact)
    }).not.toThrow()
    for (const name of ['café', '日本語', '😀', 'x\uFFFD'])
      symlinkSync(outside, join(workspace, name))
    expect(removeOutwardLinks(workspace)).toHaveLength(4)
  })

  invalidUtf8It('rejects a file name that is not valid UTF-8', () => {
    const hidden = hideBehindDecoy(join(artifact, 'a'))
    symlinkSync('/etc/passwd', Buffer.concat([hidden, Buffer.from('/passwd')]))
    expect(() => {
      checkNoLinks(artifact)
    }).toThrow("A file name in a isn't valid UTF-8")
  })
})

describe('removeProjectSettings', () => {
  it('removes settings files anywhere in the checkout', () => {
    const rootSettings = file(join(workspace, 'sonar-project.properties'))
    const moduleSettings = file(join(workspace, 'app/sonar-project.properties'))
    removeProjectSettings(workspace)
    expect(existsSync(rootSettings)).toBe(false)
    expect(existsSync(moduleSettings)).toBe(false)
    expect(lstatSync(workspace).isDirectory()).toBe(true)
  })

  it('removes a directory taking the name too, and leaves .git alone', () => {
    const named = join(workspace, 'app/sonar-project.properties')
    file(join(named, 'inside'))
    const inGit = file(join(workspace, '.git/sonar-project.properties'))
    removeProjectSettings(workspace)
    expect(existsSync(named)).toBe(false)
    expect(existsSync(inGit)).toBe(true)
  })

  it('runs again after unpacking', () => {
    const settings = file(join(workspace, 'app/sonar-project.properties'))
    file(join(artifact, 'app/target/App.class'))
    unpackWorkspace(artifact, workspace, [])
    expect(existsSync(settings)).toBe(false)
  })

  it('never reaches through a link', () => {
    const elsewhere = file(join(outside, 'sonar-project.properties'))
    symlinkSync(outside, join(workspace, 'linked'))
    file(join(workspace, 'module/sonar-project.properties'))

    removeProjectSettings(workspace)

    expect(existsSync(elsewhere)).toBe(true)
    expect(existsSync(join(workspace, 'module/sonar-project.properties'))).toBe(
      false
    )
  })
})

describe('removeOutwardLinks', () => {
  posixIt(
    'removes a link that climbs out of the checkout through another link',
    () => {
      climbOut()
      expect(removeOutwardLinks(workspace)).toEqual([
        `Removed ${join('a', 'leak')}: a link leading out of the checkout`
      ])
      expect(lstatSync(join(workspace, 'a/up')).isSymbolicLink()).toBe(true)
    }
  )

  invalidUtf8It(
    'refuses a checkout with a file name that is not valid UTF-8',
    () => {
      const hidden = hideBehindDecoy(join(workspace, 'src'))
      symlinkSync('/proc/self', Buffer.concat([hidden, Buffer.from('/proc')]))
      expect(() => removeOutwardLinks(workspace)).toThrow(
        "A file name in src isn't valid UTF-8"
      )
    }
  )

  it('removes links leading out of the checkout, and keeps the others', () => {
    file(join(workspace, 'src/A.java'))
    symlinkSync(outside, join(workspace, 'src/leak'))
    symlinkSync('/proc/self', join(workspace, 'proc'))
    symlinkSync(join(workspace, 'missing'), join(workspace, 'dangling'))
    // Inside the checkout, but on to the link that leaves it.
    symlinkSync(join(workspace, 'src/leak'), join(workspace, 'chain'))
    symlinkSync(join(workspace, 'src'), join(workspace, 'sources'))

    const warnings = removeOutwardLinks(workspace)

    const left = (name: string): boolean =>
      lstatSync(join(workspace, name), { throwIfNoEntry: false }) !== undefined
    expect(['src/leak', 'proc', 'dangling', 'chain'].map(left)).toEqual([
      false,
      false,
      false,
      false
    ])
    expect(left('sources')).toBe(true)
    expect(existsSync(join(outside))).toBe(true)
    expect(warnings).toHaveLength(4)
  })
})

describe('resolveSettings and the scanner', () => {
  posixIt('refuses paths the scanner would read as others', () => {
    mkdirSync(join(workspace, 'x '))
    symlinkSync(outside, join(workspace, 'x'))
    mkdirSync(join(workspace, 'a\r'))
    const resolved = resolveSettings(
      {
        'sonar.sources': '{workspace}/x ',
        'sonar.java.binaries': '{workspace}/a\r,{workspace}/"b"',
        'sonar.tests': '{workspace}/x\u3000'
      },
      workspace,
      home
    )
    expect(resolved.properties.get('sonar.sources')).toBe('')
    expect(resolved.properties.get('sonar.java.binaries')).toBe('')
    expect(resolved.properties.get('sonar.tests')).toBe('')
    expect(resolved.warnings).toHaveLength(4)
  })

  posixIt('reads single paths whole, commas included', () => {
    // The scanner reads <workspace>/a,<workspace>/b as one path: here, through the link a, to outside.
    mkdirSync(join(workspace, 'a'))
    mkdirSync(join(workspace, 'b'))
    mkdirSync(join(workspace, `a,${workspace}`), { recursive: true })
    symlinkSync(outside, join(workspace, `a,${workspace}`, 'b'))
    const both = '{workspace}/a,{workspace}/b'
    const resolved = resolveSettings(
      { 'sonar.projectBuildDir': both, 'sonar.jacoco.reportPath': both },
      workspace,
      home
    )
    expect(resolved.properties.has('sonar.projectBuildDir')).toBe(false)
    expect(resolved.properties.has('sonar.jacoco.reportPath')).toBe(false)
    expect(() =>
      resolveSettings({ 'sonar.projectBaseDir': both }, workspace, home)
    ).toThrow('no base directory in the checkout')
  })

  it('refuses such a base directory', () => {
    mkdirSync(join(workspace, 'x '))
    symlinkSync(outside, join(workspace, 'x'))
    expect(() =>
      resolveSettings(
        { 'sonar.projectBaseDir': '{workspace}/x ' },
        workspace,
        home
      )
    ).toThrow('no base directory in the checkout')
  })
})

describe('resolveSettings on any artifact', () => {
  const segment = fc.constantFrom(
    '..',
    '.',
    '',
    'a',
    'b',
    'out',
    'secret',
    'up',
    'leak',
    'outside',
    'a\ud800',
    'x',
    'x ',
    ' ',
    'a\r',
    '"',
    '\u3000',
    '\u00a0',
    '*',
    '**',
    '?',
    '~'
  )
  const relativePath = fc
    .array(segment, { maxLength: 5 })
    .map((segments) => segments.join('/'))
  const entry = fc.oneof(
    relativePath,
    relativePath.map((path) => `{workspace}/${path}`),
    relativePath.map((path) => `{home}/${path}`),
    relativePath.map((path) => `/${path}`),
    fc.constantFrom(
      '{workspace}',
      '{home}',
      '{other}/a',
      '{workspace}/a/leak',
      '{workspace}/a/leak/secret'
    )
  )
  // How the scanner reads each kind of setting, written out here rather than taken from the code:
  // lists or single paths, and whether the private home may hold what they point to.
  const kinds: Partial<Record<string, { list: boolean; home: boolean }>> = {
    'sonar.java.binaries': { list: true, home: true },
    'sonar.coverageReportPaths': { list: true, home: true },
    'sonar.jacoco.reportPath': { list: false, home: true },
    'sonar.sources': { list: true, home: false },
    'sonar.projectBuildDir': { list: false, home: false },
    'sonar.kotlin.gradleProjectRoot': { list: false, home: false },
    'sonar.projectBaseDir': { list: false, home: false }
  }
  const artifact = fc
    .record({
      key: fc.constantFrom(...Object.keys(kinds)),
      entries: fc.array(entry, { maxLength: 4 }),
      module: fc.option(fc.array(entry, { minLength: 1, maxLength: 2 }))
    })
    .map(({ key, entries, module }): Record<string, string> =>
      module === null
        ? { [key]: entries.join(',') }
        : {
            'sonar.modules': 'm',
            'm.sonar.projectBaseDir': module.join(','),
            [`m.${key}`]: entries.join(',')
          }
    )

  // Every way the scanner might read a path: as written, trimmed by the CLI (up to a space), trimmed
  // by the engine's list parser (Unicode spaces too), with that parser's \r read as \n, and with
  // half a character pair read as '?' by Java.
  const readings = (path: string): string[] => {
    // eslint-disable-next-line no-control-regex -- control characters are what it trims
    const ends = /^[\s\0-\x08\x0e-\x1f]+|[\s\0-\x08\x0e-\x1f]+$/g
    const trimmed = path.replace(ends, '')
    return [path, trimmed, trimmed.replace(/\r/g, '\n')].flatMap((read) => [
      read,
      read.replace(/\p{Cs}/gu, '?')
    ])
  }

  it('never lets a path out of the workspace or the private home', () => {
    // Links the checkout could hold, to a file the analysis must never read.
    file(join(outside, 'secret'))
    symlinkSync(outside, join(workspace, 'out'))
    // a/leak climbs out through a/up, except on Windows, which leads it to the decoy a/outside.
    climbOut()
    mkdirSync(join(workspace, 'b'))
    // Names the scanner reads as the links next to them: trimmed, and \r as \n.
    mkdirSync(join(workspace, 'x '))
    symlinkSync(outside, join(workspace, 'x'))
    // Names Windows refuses.
    if (process.platform !== 'win32') {
      mkdirSync(join(workspace, 'a\r'))
      symlinkSync(outside, join(workspace, 'a\n'))
      // Where Java reads half a character pair as '?'.
      symlinkSync(outside, join(workspace, 'a?'))
    }
    // The analysis creates the private home only after resolving, when it unpacks the artifact.
    rmSync(home, { recursive: true })
    const inCheckout = identitiesUnder(workspace)
    const within = (path: string, root: string): boolean =>
      path === root || path.startsWith(root + sep)

    fc.assert(
      fc.property(artifact, (settings) => {
        let resolved
        try {
          resolved = resolveSettings(settings, workspace, home)
        } catch (error) {
          // Refusing the artifact is the other safe outcome.
          if ((error as Error).message.includes('no base directory')) return
          throw error
        }
        for (const [key, value] of resolved.properties) {
          const kind = kinds[key.replace(/^m\./, '')]
          if (!kind) continue
          const paths = kind.list ? value.split(',') : [value]
          for (const path of paths.filter((path) => path !== '')) {
            expect(path).toBe(resolve(path))
            expect(/[*?]/.test(path)).toBe(false)
            expect(kind.list && path.includes('"')).toBe(false)
            for (const read of readings(path)) {
              // The analysis makes the private home, fresh, only after resolving.
              if (kind.home && within(read, home)) continue
              const lands = landsOn(read)
              expect({
                read,
                inCheckout: lands && inCheckout.has(lands)
              }).toEqual({ read, inCheckout: true })
            }
          }
        }
      }),
      { numRuns: 1000 }
    )
  })
})

describe('formatProperties', () => {
  it('writes what the properties parser reads back', () => {
    const properties = new Map([
      ['org.acme:app.sonar.sources', '/work/app/src'],
      ['sonar.projectName', ' Leading space, tab\tand\nnewline'],
      ['path', 'C:\\dir'],
      ['sonar.projectDescription', 'Caffè ☕ 😀']
    ])
    const formatted = formatProperties(properties)
    expect(formatted).toMatch(/^[\x20-\x7e\n]*$/)
    expect(parseProperties(formatted)).toEqual(properties)
  })

  it('gives back exactly the settings it wrote, one per line', () => {
    fc.assert(
      fc.property(settingsWithoutPlaceholders, (entries) => {
        const formatted = formatProperties(new Map(entries))
        expect(formatted).toMatch(/^[\x20-\x7e\n]*$/)
        expect(
          formatted.split('\n').filter((line) => line !== '')
        ).toHaveLength(entries.length)
        expect(parseProperties(formatted)).toEqual(new Map(entries))
      }),
      { numRuns: 1000 }
    )
  })

  it('refuses a placeholder wherever it is', () => {
    const name = fc.stringMatching(/^[\w.]+$/)
    fc.assert(
      fc.property(settingText, name, settingText, (before, name, after) => {
        const value = `${before}\${${name}}${after}`
        expect(() =>
          formatProperties(new Map([['sonar.projectName', value]]))
        ).toThrow(/holds a placeholder/)
      }),
      { numRuns: 1000 }
    )
  })
})

describe('formatProperties with placeholders', () => {
  it('refuses a placeholder from any source', () => {
    expect(() =>
      formatProperties(
        new Map([['sonar.pullrequest.branch', '${env.SONAR_TOKEN}']])
      )
    ).toThrow(/sonar.pullrequest.branch holds a placeholder/)
  })

  it('keeps dollar signs and braces that are no placeholder', () => {
    for (const branch of ['feature/$money', 'a/${unclosed', 'b/$ {x}', 'c/${}'])
      expect(() =>
        formatProperties(new Map([['sonar.pullrequest.branch', branch]]))
      ).not.toThrow()
  })
})

describe('trustedProperties', () => {
  const target = { projectKey: 'key', organization: 'org', hostUrl: '' }

  it('describes a pull request', () => {
    expect(
      Object.fromEntries(
        trustedProperties(
          target,
          {
            headSha: 'abc',
            pullRequest: { key: '7', branch: 'feature', base: 'main' }
          },
          '/tmp/scannerwork',
          ['java', 'py', 'rust']
        )
      )
    ).toEqual({
      'sonar.projectKey': 'key',
      'sonar.scm.revision': 'abc',
      'sonar.working.directory': '/tmp/scannerwork',
      'sonar.sca.enabled': 'false',
      'sonar.scanner.autoconfig.enabled': 'false',
      'sonar.lang.patterns.py': NO_FILE,
      'sonar.lang.patterns.rust': NO_FILE,
      'sonar.organization': 'org',
      'sonar.pullrequest.key': '7',
      'sonar.pullrequest.branch': 'feature',
      'sonar.pullrequest.base': 'main'
    })
  })

  it('keeps everything that runs build tools off on branches too', () => {
    const properties = trustedProperties(
      target,
      { headSha: 'abc', branch: 'release' },
      '/tmp/scannerwork',
      ['java']
    )
    expect(properties.get('sonar.sca.enabled')).toBe('false')
    expect(properties.get('sonar.scanner.autoconfig.enabled')).toBe('false')
  })

  it('blocks untested languages on branches too, and only those', () => {
    const properties = trustedProperties(
      target,
      { headSha: 'abc', branch: 'release' },
      '/tmp/scannerwork',
      ['java', 'kotlin', 'py']
    )
    expect(
      [...properties.keys()].filter((key) =>
        key.startsWith('sonar.lang.patterns.')
      )
    ).toEqual(['sonar.lang.patterns.py'])
  })

  it('names branches other than the default one', () => {
    expect(
      trustedProperties(
        target,
        { headSha: 'abc', branch: 'release' },
        '/tmp/scannerwork',
        ['java']
      ).get('sonar.branch.name')
    ).toBe('release')
  })
})

describe('recreateLinks', () => {
  const link = (path: string): string | undefined =>
    lstatSync(join(workspace, path), {
      throwIfNoEntry: false
    })?.isSymbolicLink()
      ? readlinkSync(join(workspace, path))
      : undefined

  it("makes a workspace's and pnpm's links again, relative and inside the checkout", () => {
    mkdirSync(join(workspace, 'packages/shared'), { recursive: true })
    const store = 'node_modules/.pnpm/express@5/node_modules/express'
    mkdirSync(join(workspace, store), { recursive: true })
    expect(
      recreateLinks(workspace, [
        { path: 'node_modules/@app/shared', target: 'packages/shared' },
        { path: 'node_modules/express', target: store }
      ])
    ).toEqual([])
    // Windows makes junctions, whose target is absolute.
    const windows = process.platform === 'win32'
    expect(link('node_modules/@app/shared')).toBe(
      windows
        ? join(workspace, 'packages', 'shared')
        : join('..', '..', 'packages', 'shared')
    )
    expect(link('node_modules/express')).toBe(
      windows
        ? join(workspace, store)
        : join('.pnpm', 'express@5', 'node_modules', 'express')
    )
  })

  posixIt(
    'refuses a target that climbs out of the checkout through another link',
    () => {
      climbOut()
      expect(
        recreateLinks(workspace, [{ path: 'node_modules/x', target: 'a/leak' }])
      ).toEqual([
        'Skipped link node_modules/x: it does not lead to a directory in the checkout'
      ])
    }
  )

  it('refuses links leaving the checkout, entering .git or outside node_modules', () => {
    mkdirSync(join(workspace, '.git/hooks'), { recursive: true })
    mkdirSync(join(workspace, 'src'))
    symlinkSync(outside, join(workspace, 'out'))
    expect(
      recreateLinks(workspace, [
        { path: 'node_modules/a', target: '../outside' },
        { path: 'node_modules/b', target: '/etc' },
        { path: 'node_modules/c', target: '.git/hooks' },
        { path: 'node_modules/d', target: 'out' },
        { path: 'src/e', target: 'src' },
        { path: 'node_modules/.git', target: 'src' },
        { path: 'node_modules/f', target: 'missing' },
        { path: 'node_modules/g', target: 'node_modules\\..\\..' },
        { path: 'node_modules/h' }
      ])
    ).toEqual([
      'Skipped link node_modules/a: it leaves the checkout or enters .git',
      'Skipped link node_modules/b: it leaves the checkout or enters .git',
      'Skipped link node_modules/c: it leaves the checkout or enters .git',
      'Skipped link node_modules/d: it does not lead to a directory in the checkout',
      'Skipped link src/e: it is not in a node_modules directory',
      'Skipped link node_modules/.git: it leaves the checkout or enters .git',
      'Skipped link node_modules/f: it does not lead to a directory in the checkout',
      'Skipped link node_modules/g: it leaves the checkout or enters .git',
      'Skipped a link: {"path":"node_modules/h"} names no path and target'
    ])
    expect(readdirOrEmpty(join(workspace, 'node_modules'))).toEqual([])
  })

  it('refuses links inside their own target, which would lead back to themselves', () => {
    mkdirSync(join(workspace, 'node_modules/x'), { recursive: true })
    // X is x on the file systems of macOS and Windows, which ignore case.
    const caseless = existsSync(join(workspace, 'node_modules/X'))
    expect(
      recreateLinks(workspace, [
        // On macOS, a link with an empty target, which leads nowhere.
        { path: 'node_modules/pkg', target: 'node_modules' },
        { path: 'node_modules/a/b', target: 'node_modules' },
        { path: 'node_modules/X/c', target: 'node_modules/x' }
      ])
    ).toEqual([
      'Skipped link node_modules/pkg: it does not lead to a directory in the checkout',
      'Skipped link node_modules/a/b: it does not lead to a directory in the checkout',
      ...(caseless
        ? [
            'Skipped link node_modules/X/c: it does not lead to a directory in the checkout'
          ]
        : [])
    ])
    expect(new Set(readdirOrEmpty(join(workspace, 'node_modules')))).toEqual(
      new Set(caseless ? ['x'] : ['X', 'x'])
    )
  })

  it("refuses Windows' aliases of .git, and checks a long segment quickly", () => {
    mkdirSync(join(workspace, 'src'))
    // A regular expression for the trailing dots and spaces took 20 seconds on this one.
    const long = `${' '.repeat(100_000)}x`
    const started = Date.now()
    expect(
      recreateLinks(workspace, [
        { path: 'node_modules/.git. .', target: 'src' },
        { path: 'node_modules/GIT~1', target: 'src' },
        { path: 'node_modules/a', target: `src/${long}` }
      ])
    ).toEqual([
      'Skipped link node_modules/.git. .: it leaves the checkout or enters .git',
      'Skipped link node_modules/GIT~1: it leaves the checkout or enters .git',
      'Skipped link node_modules/a: it does not lead to a directory in the checkout'
    ])
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('refuses what only resolving the target reveals: .git through a committed link, a file, the root', () => {
    mkdirSync(join(workspace, '.git'))
    symlinkSync('.git', join(workspace, 'g'))
    file(join(workspace, 'README.md'))
    symlinkSync('.', join(workspace, 'r'))
    expect(
      recreateLinks(workspace, [
        { path: 'node_modules/a', target: 'g' },
        { path: 'node_modules/b', target: 'README.md' },
        { path: 'node_modules/c', target: 'packages/..' },
        { path: 'node_modules/d', target: 'r' }
      ])
    ).toEqual([
      'Skipped link node_modules/a: it does not lead to a directory in the checkout',
      'Skipped link node_modules/b: it does not lead to a directory in the checkout',
      'Skipped link node_modules/c: it leaves the checkout or enters .git',
      'Skipped link node_modules/d: it does not lead to a directory in the checkout'
    ])
  })

  it('refuses NTFS streams, settings files and names the file system rejects', () => {
    mkdirSync(join(workspace, 'packages/app'), { recursive: true })
    const warnings = recreateLinks(workspace, [
      { path: 'node_modules/a', target: '.git::$INDEX_ALLOCATION' },
      { path: '.git::$INDEX_ALLOCATION/node_modules/b', target: 'packages' },
      {
        path: 'packages/app/sonar-project.properties/node_modules/c',
        target: 'packages'
      },
      { path: 'node_modules/d\0', target: 'packages' }
    ])
    expect(warnings.slice(0, 3)).toEqual([
      'Skipped link node_modules/a: it leaves the checkout or enters .git',
      'Skipped link .git::$INDEX_ALLOCATION/node_modules/b: it leaves the checkout or enters .git',
      'Skipped link packages/app/sonar-project.properties/node_modules/c: it makes a sonar-project.properties'
    ])
    expect(warnings[3]).toMatch(/^Skipped link node_modules\/d\0: /)
    expect(
      existsSync(join(workspace, 'packages/app/sonar-project.properties'))
    ).toBe(false)
  })

  it('points a link at where its target really is, whatever path leads to the workspace', () => {
    const real = join(root, 'real')
    mkdirSync(join(real, 'packages/shared'), { recursive: true })
    symlinkSync(real, join(root, 'via'))
    const viaLink = join(root, 'via')
    expect(
      recreateLinks(viaLink, [
        { path: 'node_modules/@app/shared', target: 'packages/shared' }
      ])
    ).toEqual([])
    expect(realpathSync.native(join(viaLink, 'node_modules/@app/shared'))).toBe(
      realpathSync.native(join(real, 'packages/shared'))
    )
  })

  it('never makes a link through a link the checkout commits', () => {
    mkdirSync(join(workspace, 'packages/shared'), { recursive: true })
    symlinkSync(outside, join(workspace, 'node_modules'))
    expect(
      recreateLinks(workspace, [
        { path: 'node_modules/shared', target: 'packages/shared' }
      ])
    ).toEqual([
      'Skipped link node_modules/shared: its directory is a link or a file in the checkout'
    ])
    expect(existsSync(join(outside, 'shared'))).toBe(false)
  })

  it("leaves the checkout's own entries alone", () => {
    mkdirSync(join(workspace, 'packages/shared'), { recursive: true })
    file(join(workspace, 'node_modules/shared/package.json'), 'committed')
    expect(
      recreateLinks(workspace, [
        { path: 'node_modules/shared', target: 'packages/shared' }
      ])
    ).toEqual([])
    expect(link('node_modules/shared')).toBeUndefined()
  })

  it('ignores a manifest without links', () => {
    expect(recreateLinks(workspace, undefined)).toEqual([])
  })
})

// a/leak leads out of the checkout: up leads to the checkout, and .. leaves it from there. Node's own
// realpathSync drops up/.. first, so it finds the decoy a/outside. Windows reads the target that way
// too, so there the link really leads to the decoy.
function climbOut(): void {
  mkdirSync(join(workspace, 'a/outside'), { recursive: true })
  symlinkSync('..', join(workspace, 'a/up'))
  symlinkSync('up/../outside', join(workspace, 'a/leak'))
}

// Makes a directory whose name isn't valid UTF-8, next to a decoy named as Node reads both.
function hideBehindDecoy(parent: string): Buffer {
  // A byte UTF-8 never has, or on Windows a lone surrogate, which NTFS holds and Node reads as these
  // bytes.
  const bad = Buffer.from(
    process.platform === 'win32' ? [0xed, 0xa0, 0x80] : [0xff]
  )
  mkdirSync(join(parent, `x${bad.toString()}`), { recursive: true })
  const hidden = Buffer.concat([Buffer.from(join(parent, 'x')), bad])
  mkdirSync(hidden)
  return hidden
}

function readdirOrEmpty(directory: string): string[] {
  return existsSync(directory) ? readdirSync(directory) : []
}
