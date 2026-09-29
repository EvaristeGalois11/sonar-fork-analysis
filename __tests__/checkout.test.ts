import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkoutCommit, verifyCheckout } from '../src/checkout.js'

let root: string
let server: string
let workspace: string
let first: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
    { cwd, encoding: 'utf8' }
  ).trim()
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'checkout-'))
  // Serves owner/repo from disk, standing in for https://github.com/owner/repo.
  server = join(root, 'server')
  const source = join(root, 'source')
  mkdirSync(source)
  git(source, 'init', '--quiet', '--initial-branch=main')
  writeFileSync(join(source, 'App.java'), 'class App {}')
  git(source, 'add', '.')
  git(source, 'commit', '--quiet', '-m', 'first')
  first = git(source, 'rev-parse', 'HEAD')
  writeFileSync(join(source, 'App.java'), 'class App { int x; }')
  git(source, 'commit', '--quiet', '-am', 'second')
  git(root, 'clone', '--quiet', '--bare', source, join(server, 'owner', 'repo'))
  workspace = join(root, 'workspace')
  mkdirSync(workspace)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('checkoutCommit', () => {
  it('checks out the exact commit with its history and no stored credentials', async () => {
    await checkoutCommit(
      workspace,
      `file://${server}`,
      'owner/repo',
      first,
      'a-token'
    )

    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(first)
    expect(git(workspace, 'rev-parse', '--is-shallow-repository')).toBe('false')
    await expect(verifyCheckout(workspace, first)).resolves.toBeUndefined()
  })

  it('refuses a workspace that already has a checkout', async () => {
    writeFileSync(join(workspace, 'pom.xml'), '')

    await expect(
      checkoutCommit(workspace, `file://${server}`, 'owner/repo', first, '')
    ).rejects.toThrow(/set checkout to false/)
  })
})

describe('verifyCheckout', () => {
  function clone(...args: string[]): void {
    git(
      root,
      'clone',
      '--quiet',
      ...args,
      `file://${join(server, 'owner', 'repo')}`,
      workspace
    )
  }

  it('rejects a checkout of another commit', async () => {
    clone()
    await expect(verifyCheckout(workspace, first)).rejects.toThrow(
      /check out that commit/
    )
  })

  it('rejects a shallow checkout', async () => {
    clone('--depth=1')
    const head = git(workspace, 'rev-parse', 'HEAD')
    await expect(verifyCheckout(workspace, head)).rejects.toThrow(
      /fetch-depth 0/
    )
  })

  it('rejects persisted credentials', async () => {
    clone()
    git(
      workspace,
      'config',
      'http.https://github.com/.extraheader',
      'AUTHORIZATION: basic secret'
    )
    const head = git(workspace, 'rev-parse', 'HEAD')
    await expect(verifyCheckout(workspace, head)).rejects.toThrow(
      /persist-credentials false/
    )
  })
})
