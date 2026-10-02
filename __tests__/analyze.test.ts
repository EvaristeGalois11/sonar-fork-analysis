import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import fc from 'fast-check'
import {
  checkNoLinks,
  formatProperties,
  removeProjectSettings,
  resolveSettings,
  trustedProperties,
  unpackWorkspace
} from '../src/analyze.js'
import { parseProperties } from '../src/properties.js'

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
  root = mkdtempSync(join(tmpdir(), 'analyze-'))
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

  it('refuses patterns behind placeholders and in checkout paths', () => {
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

  it('refuses a base directory the scanner would read as a pattern', () => {
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

describe('checkNoLinks', () => {
  it('rejects an artifact containing a symlink', () => {
    symlinkSync('/etc/passwd', join(artifact, 'passwd'))
    expect(() => checkNoLinks(artifact)).toThrow(/link or special file/)
  })

  it('accepts plain files and directories', () => {
    file(join(artifact, 'a/b.txt'))
    expect(() => checkNoLinks(artifact)).not.toThrow()
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
})

describe('resolveSettings and the scanner', () => {
  it('refuses paths the scanner would read as others', () => {
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

  it('reads single paths whole, commas included', () => {
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
    fc.constantFrom('{workspace}', '{home}', '{other}/a')
  )
  // How the scanner reads each kind of setting, written out here rather than taken from the code:
  // lists or single paths, and whether the private home may hold what they point to.
  const kinds: Record<string, { list: boolean; home: boolean }> = {
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
  // by the engine's list parser (Unicode spaces too), and with that parser's \r read as \n.
  const readings = (path: string): string[] => {
    // eslint-disable-next-line no-control-regex
    const trimmed = path.replace(/^[\x00-\x20\s]+|[\x00-\x20\s]+$/g, '')
    return [path, trimmed, trimmed.replace(/\r/g, '\n')]
  }

  it('never lets a path out of the workspace or the private home', () => {
    // Links the checkout could hold, to a file the analysis must never read.
    file(join(outside, 'secret'))
    symlinkSync(outside, join(workspace, 'out'))
    mkdirSync(join(workspace, 'a'))
    mkdirSync(join(workspace, 'b'))
    // Names the scanner reads as the links next to them: trimmed, and \r as \n.
    mkdirSync(join(workspace, 'x '))
    symlinkSync(outside, join(workspace, 'x'))
    mkdirSync(join(workspace, 'a\r'))
    symlinkSync(outside, join(workspace, 'a\n'))
    // The analysis creates the private home only after resolving, when it unpacks the artifact.
    rmSync(home, { recursive: true })
    const realWorkspace = realpathSync(workspace)
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
            const roots = kind.home
              ? [workspace, realWorkspace, home]
              : [workspace, realWorkspace]
            for (const read of readings(path)) {
              const real = existsSync(read) ? realpathSync(read) : read
              expect(roots.some((root) => within(real, root))).toBe(true)
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

  // Biased towards what the format treats specially, so random strings meet it often.
  const text = fc.string({
    unit: fc.oneof(
      fc.constantFrom(
        '\\',
        '\n',
        '\r',
        '\t',
        '\f',
        ' ',
        '=',
        ':',
        '#',
        '!',
        '$',
        '{',
        '}',
        '.',
        'u',
        'é',
        '😀',
        // Lone surrogates, which a JSON artifact can carry.
        '\ud800',
        '\udfff'
      ),
      fc.string({ unit: 'binary', minLength: 1, maxLength: 1 })
    ),
    maxLength: 100
  })
  const placeholder = /\$\{[\w.]+\}/

  it('gives back exactly the settings it wrote, one per line', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.tuple(text, text), { selector: ([key]) => key }),
        (entries) => {
          fc.pre(entries.every(([, value]) => !placeholder.test(value)))
          const formatted = formatProperties(new Map(entries))
          expect(formatted).toMatch(/^[\x20-\x7e\n]*$/)
          expect(
            formatted.split('\n').filter((line) => line !== '')
          ).toHaveLength(entries.length)
          expect(parseProperties(formatted)).toEqual(new Map(entries))
        }
      ),
      { numRuns: 1000 }
    )
  })

  // The scanner CLI reads the file with java.util.Properties itself, so the round trip above is
  // checked against Java too. Without Java the check is skipped, except on CI, where it must run.
  const hasJava = spawnSync('java', ['-version']).status === 0
  const withJava = hasJava || process.env.CI ? it : it.skip

  withJava(
    'is read back by the scanner CLI as written, values trimmed',
    () => {
      const seed = Date.now()
      const samples = fc.sample(
        fc
          .uniqueArray(fc.tuple(text, text), { selector: ([key]) => key })
          .filter((entries) =>
            entries.every(([, value]) => !placeholder.test(value))
          ),
        { numRuns: 1000, seed }
      )
      const directory = join(root, 'settings')
      mkdirSync(directory)
      const names = samples.map((entries, index) => {
        const name = `${String(index).padStart(4, '0')}.properties`
        writeFileSync(join(directory, name), formatProperties(new Map(entries)))
        return name
      })

      const output = execFileSync(
        'java',
        [resolve('__tests__/java/ReadSettings.java'), directory],
        { encoding: 'utf8', maxBuffer: 1 << 28 }
      )
      const unhex = (text: string): string =>
        String.fromCharCode(
          ...(text.slice(1).match(/.{4}/g) ?? []).map((unit) =>
            parseInt(unit, 16)
          )
        )
      const read = new Map<string, Map<string, string>>()
      let current = new Map<string, string>()
      for (const line of output.split('\n').filter((line) => line !== '')) {
        if (line.startsWith('file ')) {
          current = new Map()
          read.set(line.slice('file '.length), current)
        } else {
          const [key, value] = line.split(' ').map(unhex)
          current.set(key, value)
        }
      }

      // Like String.trim: everything up to a space goes at both ends.
      const trim = (text: string): string =>
        // eslint-disable-next-line no-control-regex
        text.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '')
      samples.forEach((entries, index) => {
        const expected = new Map(
          entries.map(([key, value]) => [key, trim(value)])
        )
        expect({ seed, entries, read: read.get(names[index]) }).toEqual({
          seed,
          entries,
          read: expected
        })
      })
    },
    60_000
  )

  it('refuses a placeholder wherever it is', () => {
    const name = fc.stringMatching(/^[\w.]+$/)
    fc.assert(
      fc.property(text, name, text, (before, name, after) => {
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
          '/tmp/scannerwork'
        )
      )
    ).toEqual({
      'sonar.projectKey': 'key',
      'sonar.scm.revision': 'abc',
      'sonar.working.directory': '/tmp/scannerwork',
      'sonar.sca.enabled': 'false',
      'sonar.organization': 'org',
      'sonar.pullrequest.key': '7',
      'sonar.pullrequest.branch': 'feature',
      'sonar.pullrequest.base': 'main'
    })
  })

  it('keeps dependency analysis off on branches too', () => {
    expect(
      trustedProperties(
        target,
        { headSha: 'abc', branch: 'release' },
        '/tmp/scannerwork'
      ).get('sonar.sca.enabled')
    ).toBe('false')
  })

  it('names branches other than the default one', () => {
    expect(
      trustedProperties(
        target,
        { headSha: 'abc', branch: 'release' },
        '/tmp/scannerwork'
      ).get('sonar.branch.name')
    ).toBe('release')
  })
})
