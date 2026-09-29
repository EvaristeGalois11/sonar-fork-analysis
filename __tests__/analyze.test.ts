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
      ['path', 'C:\\dir']
    ])
    expect(parseProperties(formatProperties(properties))).toEqual(properties)
  })
})

describe('trustedProperties', () => {
  const target = { projectKey: 'key', organization: 'org', hostUrl: '' }

  it('describes a pull request', () => {
    expect(
      Object.fromEntries(
        trustedProperties(target, {
          headSha: 'abc',
          pullRequest: { key: '7', branch: 'feature', base: 'main' }
        })
      )
    ).toEqual({
      'sonar.projectKey': 'key',
      'sonar.scm.revision': 'abc',
      'sonar.organization': 'org',
      'sonar.pullrequest.key': '7',
      'sonar.pullrequest.branch': 'feature',
      'sonar.pullrequest.base': 'main'
    })
  })

  it('names branches other than the default one', () => {
    expect(
      trustedProperties(target, { headSha: 'abc', branch: 'release' }).get(
        'sonar.branch.name'
      )
    ).toBe('release')
  })
})
