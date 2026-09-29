import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Origin } from './origin.js'
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

export type Resolved = {
  properties: Map<string, string>
  sourceRoots: string[]
  warnings: string[]
}

// Must run on the pristine checkout: sources and tests are only accepted if the checkout has them.
export function resolveSettings(
  settings: Record<string, string>,
  workspace: string,
  home: string
): Resolved {
  const { kept } = filterSettings(new Map(Object.entries(settings)))
  const prefixes = modulePrefixes(kept)
  const warnings: string[] = []
  const sourceRoots: string[] = []
  const properties = new Map<string, string>()

  const bases = new Map<string, string>()
  for (const prefix of prefixes) {
    const base = kept.get(`${prefix}sonar.projectBaseDir`)
    const mapped = base && mapPlaceholder(base, workspace, home)
    if (mapped && isWithin(mapped, workspace) && existsSync(mapped))
      bases.set(prefix, mapped)
  }

  for (const [key, value] of kept) {
    const { prefix, bareKey } = splitKey(key, prefixes)
    const shipped = SHIPPED_PATH_KEYS.has(bareKey)
    const output = OUTPUT_PATH_KEYS.has(bareKey)
    if (!shipped && !output && !CHECKOUT_PATH_KEYS.has(bareKey)) {
      properties.set(key, value)
      continue
    }
    const base = bases.get(prefix) ?? workspace
    const entries: string[] = []
    for (const entry of value.split(',').filter((path) => path !== '')) {
      const path = entry.startsWith('{')
        ? mapPlaceholder(entry, workspace, home)
        : isAbsolute(entry)
          ? undefined
          : inside(workspace, resolve(base, entry))
      // Shipped paths may live in the private home; output directories appear when unpacking;
      // checkout paths must already be in the checkout.
      const accepted =
        path !== undefined &&
        (shipped || (isWithin(path, workspace) && (output || existsSync(path))))
      if (!accepted) {
        warnings.push(`Dropped ${key} entry: ${entry}`)
        continue
      }
      entries.push(entry.startsWith('{') ? path : entry)
      if (bareKey === 'sonar.sources' || bareKey === 'sonar.tests')
        sourceRoots.push(path)
    }
    properties.set(key, entries.join(','))
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

function unpackFile(
  source: string,
  rel: string,
  workspace: string,
  protectedRoots: string[]
): string | undefined {
  const target = join(workspace, rel)
  if (rel.split(sep)[0] === '.git') return 'inside .git'
  if (protectedRoots.some((root) => isWithin(target, root)))
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
  if (isKey) escaped = escaped.replace(/[:= #!]/g, '\\$&')
  else escaped = escaped.replace(/^ /, '\\ ')
  return escaped
}

export function formatProperties(properties: Map<string, string>): string {
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

// Set by the trusted side only; they override anything that came with the artifact.
export function trustedProperties(
  target: Target,
  origin: Origin
): Map<string, string> {
  const properties = new Map([
    ['sonar.projectKey', target.projectKey],
    ['sonar.scm.revision', origin.headSha]
  ])
  if (target.organization)
    properties.set('sonar.organization', target.organization)
  if (target.hostUrl) properties.set('sonar.host.url', target.hostUrl)
  if (origin.pullRequest) {
    properties.set('sonar.pullrequest.key', origin.pullRequest.key)
    properties.set('sonar.pullrequest.branch', origin.pullRequest.branch)
    properties.set('sonar.pullrequest.base', origin.pullRequest.base)
  } else if (origin.branch) {
    properties.set('sonar.branch.name', origin.branch)
  }
  return properties
}
