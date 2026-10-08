import * as core from '@actions/core'
import { getExecOutput } from '@actions/exec'
import { readdirSync } from 'node:fs'
import { toolEnvironment } from './environment.js'
import { retry } from './retry.js'

// Never wait for a password, and never let the checkout's attributes send git-lfs to a server.
const QUIET_GIT = { GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' }

async function git(
  workspace: string,
  args: string[],
  env: Record<string, string> = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return getExecOutput('git', args, {
    cwd: workspace,
    env: { ...toolEnvironment(), ...QUIET_GIT, ...env },
    ignoreReturnCode: true,
    silent: true
  })
}

async function required(
  workspace: string,
  args: string[],
  env?: Record<string, string>
): Promise<string> {
  const { exitCode, stdout, stderr } = await git(workspace, args, env)
  if (exitCode !== 0) {
    throw new Error(
      `git ${args[0] ?? ''} failed with exit code ${exitCode}: ${stderr.trim()}`
    )
  }
  return stdout.trim()
}

export type Checkout = {
  serverUrl: string
  // This repository, whose branches a pull request is compared with.
  repository: string
  sha: string
  token: string
}

// Fetches the analysed commit the way a safe checkout step would: the exact commit, full history for
// blame, and credentials handed to git through its environment only, so none are written to disk.
export async function checkoutCommit(
  workspace: string,
  { serverUrl, repository, sha, token }: Checkout
): Promise<void> {
  if (readdirSync(workspace).length > 0) {
    throw new Error(
      'The workspace is not empty: remove your checkout step, or set checkout to false to keep it'
    )
  }
  const env: Record<string, string> = {}
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
    core.setSecret(basic)
    Object.assign(env, {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `http.${serverUrl}/.extraheader`,
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`
    })
  }
  core.info(`Checking out ${sha}`)
  await required(workspace, ['init', '--quiet'])
  // Sonar finds a pull request's base branch as origin/<base>. A fork's copy of that branch could be
  // anything. So origin is this repository.
  await required(workspace, [
    'remote',
    'add',
    'origin',
    `${serverUrl}/${repository}`
  ])
  const fetch = ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules']
  // The only network operations, so the only ones worth retrying, as actions/checkout does.
  await retry(() =>
    required(
      workspace,
      [...fetch, 'origin', '+refs/heads/*:refs/remotes/origin/*'],
      env
    )
  )
  // GitHub keeps every pull request's head here too, as refs/pull/<number>/head. It's there even when
  // the fork is private or gone. Nothing the fork controls gets contacted.
  await retry(() => required(workspace, [...fetch, 'origin', sha], env))
  await required(workspace, ['checkout', '--quiet', '--detach', sha])
}

export async function verifyCheckout(
  workspace: string,
  sha: string
): Promise<void> {
  const head = await required(workspace, ['rev-parse', 'HEAD'])
  if (head !== sha) {
    throw new Error(
      `The checkout is at ${head} but the analysis is for ${sha}: check out that commit`
    )
  }
  if (
    (await required(workspace, ['rev-parse', '--is-shallow-repository'])) ===
    'true'
  ) {
    throw new Error(
      'The checkout is shallow, so Sonar would get no history: fetch it with fetch-depth 0'
    )
  }
  // The analysed code may come from a fork; a stored token would sit right next to it. Newer
  // actions/checkout versions keep it in a file that .git/config includes.
  const { stdout } = await git(workspace, [
    'config',
    '--local',
    '--includes',
    '--get-regexp',
    String.raw`^http\..*\.extraheader$`
  ])
  if (stdout.trim() !== '') {
    throw new Error(
      'The checkout stored credentials in .git/config: check out with persist-credentials false'
    )
  }
}
