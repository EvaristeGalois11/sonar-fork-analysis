import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
        'sonar.host.url': 'https://evil.example.com',
        'sonar.scanner.javaOpts': '-javaagent:x.jar',
        'sonar.projectKey': 'someone-else'
      },
      workspace,
      home
    )
    expect(resolved.properties.size).toBe(0)
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
      'sonar.organization': 'org',
      'sonar.pullrequest.key': '7',
      'sonar.pullrequest.branch': 'feature',
      'sonar.pullrequest.base': 'main'
    })
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
