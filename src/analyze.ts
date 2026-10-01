import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync
} from 'node:fs'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from 'node:path'
import type { PullRequest } from './origin.js'
import {
  CHECKOUT_PATH_KEYS,
  OUTPUT_PATH_KEYS,
  SHIPPED_PATH_KEYS,
  filterSettings,
  modulePrefixes,
  splitKey
} from './settings.js'

// Everything here handles an artifact built by code from a pull request, possibly a fork's, in a job
// that holds the Sonar token. Nothing in it is trusted: no path may leave the workspace or the
// private home, nothing may be overwritten, and no source may be added.

function inside(root: string, path: string): string | undefined {
  const resolved = resolve(root, path)
  const rel = relative(root, resolved)
  return rel.startsWith('..') || isAbsolute(rel) ? undefined : resolved
}

function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep)
}

function mapPlaceholder(
  entry: string,
  workspace: string,
  home: string
): string | undefined {
  if (entry === '{workspace}') return workspace
  if (entry.startsWith('{workspace}/'))
    return inside(workspace, `.${entry.slice('{workspace}'.length)}`)
  if (entry.startsWith('{home}/'))
    return inside(home, `.${entry.slice('{home}'.length)}`)
  return undefined
}

// The scanner replaces ${env.NAME} in a setting with that environment variable, where the Sonar token
// is, and ${name} with another setting, before using it; there is no way to escape either.
const PLACEHOLDER = /\$\{[\w.]+\}/

export type Resolved = {
  properties: Map<string, string>
  sourceRoots: string[]
  warnings: string[]
}

// Must run on the pristine checkout: sources and tests are only accepted if the checkout has them.
// Paths are compared by their real location, since the checkout may contain links.
export function resolveSettings(
  settings: Record<string, string>,
  workspace: string,
  home: string
): Resolved {
  const warnings: string[] = []
  // Before anything reads them, the module ids included: a value could quote the token.
  const kept = new Map<string, string>()
  for (const [key, value] of filterSettings(new Map(Object.entries(settings)))
    .kept) {
    if (PLACEHOLDER.test(value))
      warnings.push(
        `Dropped ${key}: it holds a placeholder the scanner would expand`
      )
    else kept.set(key, value)
  }
  const prefixes = modulePrefixes(kept)
  const sourceRoots: string[] = []
  const properties = new Map<string, string>()
  const realWorkspace = realpathSync(workspace)
  const realHome = existsSync(home) ? realpathSync(home) : home
  const inCheckout = (path: string): boolean =>
    existsSync(path) && isWithin(realpathSync(path), realWorkspace)

  // The scanner resolves a module's relative paths against its base directory, and derives a missing
  // one from the module id, so every module must come with a base checked here.
  const bases = new Map<string, string>()
  for (const prefix of prefixes) {
    const base = kept.get(`${prefix}sonar.projectBaseDir`)
    const mapped =
      base === undefined && prefix === ''
        ? workspace
        : base && mapPlaceholder(base, workspace, home)
    if (!mapped || !inCheckout(mapped)) {
      throw new Error(
        `The artifact gives ${prefix ? `module ${prefix.slice(0, -1)}` : 'the project'} no base directory in the checkout`
      )
    }
    bases.set(prefix, mapped)
  }

  const withSources = new Set<string>()
  for (const [key, value] of kept) {
    const { prefix, bareKey } = splitKey(key, prefixes)
    const shipped = SHIPPED_PATH_KEYS.has(bareKey)
    const output = OUTPUT_PATH_KEYS.has(bareKey)
    if (!shipped && !output && !CHECKOUT_PATH_KEYS.has(bareKey)) {
      properties.set(key, value)
      continue
    }
    const base = bases.get(prefix) as string
    if (bareKey === 'sonar.sources' || bareKey === 'sonar.tests')
      withSources.add(prefix)
    const entries: string[] = []
    for (const entry of value.split(',').filter((path) => path !== '')) {
      const path = entry.startsWith('{')
        ? mapPlaceholder(entry, workspace, home)
        : isAbsolute(entry)
          ? undefined
          : inside(workspace, resolve(base, entry))
      // Shipped paths may live in the private home; output directories appear when unpacking;
      // checkout paths must already be in the checkout.
      let accepted = false
      if (path !== undefined && existsSync(path)) {
        const real = realpathSync(path)
        accepted =
          isWithin(real, realWorkspace) || (shipped && isWithin(real, realHome))
      } else if (path !== undefined) {
        accepted = shipped || (output && isWithin(path, workspace))
      }
      if (!accepted) {
        warnings.push(`Dropped ${key} entry: ${entry}`)
        continue
      }
      entries.push(path as string)
      if (bareKey === 'sonar.sources' || bareKey === 'sonar.tests')
        sourceRoots.push(realpathSync(path as string))
    }
    properties.set(key, entries.join(','))
  }
  // Without either setting the scanner analyses the whole base directory.
  for (const [prefix, base] of bases) {
    if (!withSources.has(prefix)) sourceRoots.push(realpathSync(base))
  }
  return { properties, sourceRoots, warnings }
}

function walk(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' }).map(
    (entry) => join(directory, entry)
  )
}

// The artifact download should never produce links, but it is not ours to trust.
export function checkNoLinks(directory: string): void {
  for (const path of walk(directory)) {
    const stats = lstatSync(path)
    if (!stats.isFile() && !stats.isDirectory()) {
      throw new Error(
        `The artifact contains a link or special file: ${relative(directory, path)}`
      )
    }
  }
}

// Git would take a planted repository's config and history when Sonar runs it on the checkout.
// Case and Windows aliases (trailing dots, 8.3 short names) matter on some runners.
function isGitDirectory(segment: string): boolean {
  return /^(\.git|git~\d+)$/i.test(segment.replace(/[. ]+$/, ''))
}

function unpackFile(
  source: string,
  rel: string,
  workspace: string,
  protectedRoots: string[]
): string | undefined {
  const target = join(workspace, rel)
  if (rel.split(sep).some(isGitDirectory)) return 'inside .git'
  if (basename(rel).toLowerCase() === 'sonar-project.properties')
    return 'the scanner would read it as settings'
  // Directories on the way are never links (checked below), so this is where the file really lands.
  const real = join(realpathSync(workspace), rel)
  if (protectedRoots.some((root) => isWithin(real, root)))
    return 'inside the sources'
  // A committed symlink (e.g. target -> /home/runner/.m2) must not redirect the write.
  let directory = workspace
  for (const segment of dirname(rel)
    .split(sep)
    .filter((s) => s !== '.')) {
    directory = join(directory, segment)
    if (!existsSync(directory) && !isSymbolicLink(directory)) {
      mkdirSync(directory)
      continue
    }
    const stats = lstatSync(directory)
    if (stats.isSymbolicLink() || !stats.isDirectory())
      return 'its directory is a link or a file in the checkout'
  }
  try {
    copyFileSync(source, target, constants.COPYFILE_EXCL)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      return 'it already exists in the checkout'
    throw error
  }
  return undefined
}

function isSymbolicLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

// Unpacks the build output in place, next to the checkout, so default report locations keep working.
export function unpackWorkspace(
  from: string,
  workspace: string,
  protectedRoots: string[]
): string[] {
  const warnings: string[] = []
  if (!existsSync(from)) return warnings
  for (const source of walk(from)) {
    if (!lstatSync(source).isFile()) continue
    const rel = relative(from, source)
    const reason = unpackFile(source, rel, workspace, protectedRoots)
    if (reason) warnings.push(`Skipped ${rel}: ${reason}`)
  }
  return warnings
}

// The scanner would otherwise read these from the checkout, i.e. from the pull request.
export function removeProjectSettings(workspace: string): void {
  for (const path of walk(workspace)) {
    if (
      path.endsWith(`${sep}sonar-project.properties`) &&
      !path.includes(`${sep}.git${sep}`)
    )
      rmSync(path, { force: true })
  }
}

function escape(text: string, isKey: boolean): string {
  let escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/\f/g, '\\f')
    // Correct whichever encoding the scanner reads the file with.
    .replace(
      /[^\x20-\x7e]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
    )
  if (isKey) escaped = escaped.replace(/[:= #!]/g, '\\$&')
  else escaped = escaped.replace(/^ /, '\\ ')
  return escaped
}

// Refuses a placeholder from any source, e.g. a pull request's branch name, which its author chooses.
export function formatProperties(properties: Map<string, string>): string {
  for (const [key, value] of properties) {
    if (PLACEHOLDER.test(value)) {
      throw new Error(
        `${key} holds a placeholder the Sonar scanner would expand: ${value}`
      )
    }
  }
  return [...properties]
    .map(([key, value]) => `${escape(key, true)}=${escape(value, false)}`)
    .join('\n')
    .concat('\n')
}

export type Target = {
  projectKey: string
  organization: string
  hostUrl: string
}

export type Analysed = {
  headSha: string
  pullRequest?: PullRequest
  branch?: string
}

// Set by the trusted side only; they override anything that came with the artifact.
export function trustedProperties(
  target: Target,
  analysed: Analysed,
  workingDirectory: string
): Map<string, string> {
  const properties = new Map([
    ['sonar.projectKey', target.projectKey],
    ['sonar.scm.revision', analysed.headSha],
    // The scanner empties its working directory, which by default is a name the checkout could link.
    ['sonar.working.directory', workingDirectory]
  ])
  if (target.organization)
    properties.set('sonar.organization', target.organization)
  if (target.hostUrl) properties.set('sonar.host.url', target.hostUrl)
  if (analysed.pullRequest) {
    properties.set('sonar.pullrequest.key', analysed.pullRequest.key)
    properties.set('sonar.pullrequest.branch', analysed.pullRequest.branch)
    properties.set('sonar.pullrequest.base', analysed.pullRequest.base)
  } else if (analysed.branch) {
    properties.set('sonar.branch.name', analysed.branch)
  }
  return properties
}
