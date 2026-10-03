import {
  type Dirent,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  statSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync
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
  REREAD_PATH,
  WILDCARD,
  filterSettings,
  isPathList,
  isReport,
  isShippedPath,
  isTypeInformation,
  moduleTree,
  type ModuleTree
} from './settings.js'

// Everything here handles an artifact built by code from a pull request, possibly a fork's, in a job
// that holds the Sonar token. Nothing in it is trusted: no path may leave the workspace or the
// private home, nothing may be overwritten, and no source may be added: only reports and type
// information join the source directories.

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

// Relative paths resolve against the module's base; an absolute one could point anywhere.
function mapEntry(
  entry: string,
  base: string,
  workspace: string,
  home: string
): string | undefined {
  if (entry.startsWith('{')) return mapPlaceholder(entry, workspace, home)
  if (isAbsolute(entry)) return undefined
  return inside(workspace, resolve(base, entry))
}

// The scanner replaces ${env.NAME} in a setting with that environment variable, where the Sonar token
// is, and ${name} with another setting, before using it; there is no way to escape either.
const PLACEHOLDER = /\$\{[\w.]+\}/

const LONE_SURROGATE = /\p{Cs}/u

export type Resolved = {
  properties: Map<string, string>
  sourceRoots: string[]
  // The report files the settings name, where they land in the checkout.
  reports: string[]
  warnings: string[]
}

// Where the analysis may find the files the settings name, as given and as really located.
type Places = {
  workspace: string
  home: string
  realWorkspace: string
  realHome: string
}

// Must run on the pristine checkout: sources and tests are only accepted if the checkout has them.
// Paths are compared by their real location, since the checkout may contain links.
export function resolveSettings(
  settings: Record<string, string>,
  workspace: string,
  home: string
): Resolved {
  const warnings: string[] = []
  const kept = allowedSettings(settings, warnings)
  const tree = moduleTree(kept)
  const places: Places = {
    workspace,
    home,
    realWorkspace: realpathSync(workspace),
    realHome: existsSync(home) ? realpathSync(home) : home
  }
  const bases = moduleBases(kept, tree, places)
  let sourceRoots: string[] = []
  let reports: string[] = []
  const properties = new Map<string, string>()
  const withSources = new Set<string>()
  for (const [key, value] of kept) {
    const { prefix, bareKey } = tree.split(key)
    if (
      !isShippedPath(bareKey) &&
      !OUTPUT_PATH_KEYS.has(bareKey) &&
      !CHECKOUT_PATH_KEYS.has(bareKey)
    ) {
      properties.set(key, value)
      continue
    }
    const base = bases.get(prefix) as string
    const paths = resolvePaths(key, bareKey, value, base, places, warnings)
    if (!paths) continue
    properties.set(key, paths.join(','))
    if (bareKey === 'sonar.sources' || bareKey === 'sonar.tests') {
      withSources.add(prefix)
      // concat, as a spread would put every entry on the stack, which a long list overflows.
      sourceRoots = sourceRoots.concat(paths.map((path) => realpathSync(path)))
    }
    if (isReport(bareKey))
      reports = reports.concat(
        paths
          .filter((path) => isWithin(path, workspace))
          .map((path) => join(places.realWorkspace, relative(workspace, path)))
      )
  }
  // Without either setting the scanner analyses the whole base directory.
  for (const [prefix, base] of bases) {
    if (!withSources.has(prefix)) sourceRoots.push(realpathSync(base))
  }
  return { properties, sourceRoots, reports, warnings }
}

// First of all, so the allowlist and everything after it read the same module tree: a value
// could quote the token, and sonar.modules decides how every other key is read.
function allowedSettings(
  settings: Record<string, string>,
  warnings: string[]
): Map<string, string> {
  const expandable = new Map<string, string>()
  for (const [key, value] of Object.entries(settings)) {
    if (PLACEHOLDER.test(value))
      warnings.push(
        `Dropped ${key}: it holds a placeholder the scanner would expand`
      )
    // Half of a surrogate pair: Node's file system reads it as U+FFFD, the scanner's Java as '?', so
    // a path checked here would not be the one used.
    else if (LONE_SURROGATE.test(key) || LONE_SURROGATE.test(value))
      warnings.push(
        `Dropped ${JSON.stringify(key)}: it holds half of a character`
      )
    else expandable.set(key, value)
  }
  const { kept, dropped, replaced, ignored } = filterSettings(expandable)
  // The build only ships what the allowlist keeps, so anything else was added to the artifact.
  const unexpected = [...dropped, ...replaced, ...ignored]
  if (unexpected.length > 0)
    warnings.push(
      `Dropped settings a build never ships: ${unexpected.join(', ')}`
    )
  return kept
}

// The scanner resolves a module's relative paths against its base directory, and derives a missing
// one from the module id, so every module must come with a base checked here.
function moduleBases(
  kept: Map<string, string>,
  tree: ModuleTree,
  places: Places
): Map<string, string> {
  const bases = new Map<string, string>()
  for (const prefix of tree.prefixes) {
    const base = kept.get(tree.keyOf(prefix, 'sonar.projectBaseDir') ?? '')
    const mapped =
      base === undefined && prefix === ''
        ? places.workspace
        : base && mapPlaceholder(base, places.workspace, places.home)
    // The scanner reads patterns in report paths, and a checkout may hold a directory named **.
    if (
      !mapped ||
      mapped.includes(',') ||
      WILDCARD.test(mapped) ||
      REREAD_PATH.test(mapped) ||
      !existsSync(mapped) ||
      !isWithin(realpathSync(mapped), places.realWorkspace)
    ) {
      const subject = prefix ? `module ${prefix.slice(0, -1)}` : 'the project'
      throw new Error(
        `The artifact gives ${subject} no base directory in the checkout`
      )
    }
    bases.set(prefix, mapped)
  }
  return bases
}

// The entries of a path setting that pass the checks, or nothing when the setting itself fails.
function resolvePaths(
  key: string,
  bareKey: string,
  value: string,
  base: string,
  places: Places,
  warnings: string[]
): string[] | undefined {
  // Read as one path, the value would be none of the entries checked below.
  if (!isPathList(bareKey) && value.includes(',')) {
    warnings.push(`Dropped ${key}: the scanner reads it as one path`)
    return undefined
  }
  const paths: string[] = []
  for (const entry of value.split(',').filter((path) => path !== '')) {
    const path = acceptedPath(entry, bareKey, base, places)
    if (path === undefined) warnings.push(`Dropped ${key} entry: ${entry}`)
    else paths.push(path)
  }
  return paths
}

function acceptedPath(
  entry: string,
  bareKey: string,
  base: string,
  places: Places
): string | undefined {
  const path = mapEntry(entry, base, places.workspace, places.home)
  // The build expands patterns into the files it ships; the scanner would expand what is left
  // over files no check here has seen. Nor may the scanner read the path differently.
  if (!path || WILDCARD.test(path) || REREAD_PATH.test(path)) return undefined
  // Shipped paths may live in the private home; output directories appear when unpacking;
  // checkout paths must already be in the checkout.
  const shipped = isShippedPath(bareKey)
  let accepted: boolean
  if (existsSync(path)) {
    const real = realpathSync(path)
    accepted =
      isWithin(real, places.realWorkspace) ||
      (shipped && isWithin(real, places.realHome))
  } else {
    accepted =
      shipped ||
      (OUTPUT_PATH_KEYS.has(bareKey) && isWithin(path, places.workspace))
  }
  return accepted ? path : undefined
}

// Every entry under a directory, links included but never followed: Node's recursive readdir follows
// links to directories, out of the directory or round in circles.
function entriesUnder(directory: string): Dirent[] {
  const entries: Dirent[] = []
  const pending = [directory]
  for (let current = pending.pop(); current; current = pending.pop()) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      entries.push(entry)
      if (entry.isDirectory()) pending.push(join(current, entry.name))
    }
  }
  return entries
}

function walk(directory: string): string[] {
  return entriesUnder(directory).map((entry) =>
    join(entry.parentPath, entry.name)
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
  // Trimmed by hand: a regular expression anchored at the end takes quadratic time on a long run of
  // dots and spaces, and the segments come from the artifact.
  let end = segment.length
  while (end > 0 && (segment[end - 1] === '.' || segment[end - 1] === ' '))
    end--
  return /^(\.git|git~\d+)$/i.test(segment.slice(0, end))
}

// Type information prepare ships from node_modules, which the analyzers read but by default don't
// report on.
function isPackageTypeFile(rel: string): boolean {
  return (
    rel.split(sep).includes('node_modules') && isTypeInformation(basename(rel))
  )
}

// What may land in the sources: the files the settings name as reports, which projects analysing
// their whole directory keep among their sources, and type information. Never a source file of
// the pull request.
function mayJoinSources(rel: string, real: string, reports: string[]): boolean {
  return reports.includes(real) || isPackageTypeFile(rel)
}

// A directory's identity rather than its path: on case-insensitive file systems (macOS, Windows) SRC
// and src are the same directory under different names.
function identity(path: string, followLinks = false): string | undefined {
  const stats = (followLinks ? statSync : lstatSync)(path, {
    bigint: true,
    throwIfNoEntry: false
  })
  return stats?.isDirectory() ? `${stats.dev}:${stats.ino}` : undefined
}

// Whether a file at rel would land in one of the given directories, by walking the directories on
// the way that already exist; links among them are refused later anyway.
function insideAny(
  workspace: string,
  rel: string,
  roots: Set<string>
): boolean {
  let directory = workspace
  const segments = dirname(rel)
    .split(sep)
    .filter((segment) => segment !== '.')
  for (let i = 0; ; i++) {
    const id = identity(directory)
    if (id === undefined) return false
    if (roots.has(id)) return true
    if (i === segments.length) return false
    directory = join(directory, segments[i])
  }
}

function unpackFile(
  source: string,
  rel: string,
  workspace: string,
  protectedRoots: Set<string>,
  reports: string[]
): string | undefined {
  const target = join(workspace, rel)
  if (rel.split(sep).some(isGitDirectory)) return 'inside .git'
  if (basename(rel).toLowerCase() === 'sonar-project.properties')
    return 'the scanner would read it as settings'
  // Directories on the way are never links (checked below), so this is where the file really lands.
  const real = join(realpathSync(workspace), rel)
  if (
    insideAny(workspace, rel, protectedRoots) &&
    !mayJoinSources(rel, real, reports)
  )
    return 'inside the sources'
  const refused = makeDirectories(
    workspace,
    dirname(rel)
      .split(sep)
      .filter((s) => s !== '.')
  )
  if (refused) return refused
  try {
    copyFileSync(source, target, constants.COPYFILE_EXCL)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      // A repository committing node_modules fixtures would get a warning for each of them.
      return isPackageTypeFile(rel)
        ? undefined
        : 'it already exists in the checkout'
    throw error
  }
  return undefined
}

// A committed symlink (e.g. target -> /home/runner/.m2) must not redirect a write below it, so the
// directories on the way are made here and never followed.
function makeDirectories(
  workspace: string,
  segments: string[]
): string | undefined {
  let directory = workspace
  for (const segment of segments) {
    directory = join(directory, segment)
    const stats = lstatSync(directory, { throwIfNoEntry: false })
    if (!stats) mkdirSync(directory)
    else if (stats.isSymbolicLink() || !stats.isDirectory())
      return 'its directory is a link or a file in the checkout'
  }
  return undefined
}

// Unpacks the build output in place, next to the checkout, so default report locations keep working.
export function unpackWorkspace(
  from: string,
  workspace: string,
  protectedRoots: string[],
  reports: string[] = []
): string[] {
  const warnings: string[] = []
  if (!existsSync(from)) return warnings
  const roots = new Set(
    protectedRoots
      .map((root) => identity(root, true))
      .filter((id) => id !== undefined)
  )
  for (const source of walk(from)) {
    if (!lstatSync(source).isFile()) continue
    const rel = relative(from, source)
    const reason = unpackFile(source, rel, workspace, roots, reports)
    if (reason) warnings.push(`Skipped ${rel}: ${reason}`)
  }
  removeProjectSettings(workspace)
  return warnings
}

// The engine follows links into directories and only checks the path it reached a file by, so a link
// in the checkout to anywhere else, /proc/self for one, would have Sonar index and upload what is
// there. Links staying in the checkout are left to the checks on settings and the scanner's own.
export function removeOutwardLinks(workspace: string): string[] {
  const realWorkspace = realpathSync(workspace)
  const warnings: string[] = []
  const entries = entriesUnder(workspace)
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue
    const path = join(entry.parentPath, entry.name)
    let target: string | undefined
    try {
      target = realpathSync(path)
    } catch {
      target = undefined
    }
    if (target === undefined || !isWithin(target, realWorkspace)) {
      unlinkSync(path)
      warnings.push(
        `Removed ${relative(workspace, path)}: a link leading out of the checkout`
      )
    }
  }
  return warnings
}

// Makes the links a Node project's node_modules had again, without which TypeScript finds no package
// a workspace or pnpm links. Each one stays in a node_modules directory, leads to a directory in the
// checkout and never into .git, which keeps them to what a fork could commit itself.
export function recreateLinks(workspace: string, links: unknown): string[] {
  if (!Array.isArray(links)) return []
  const warnings: string[] = []
  const realWorkspace = realpathSync(workspace)
  for (const link of links) {
    const path = (link as { path?: unknown })?.path
    const target = (link as { target?: unknown })?.target
    if (typeof path !== 'string' || typeof target !== 'string') {
      warnings.push(
        `Skipped a link: ${JSON.stringify(link)} names no path and target`
      )
      continue
    }
    let reason: string | undefined
    try {
      reason = recreateLink(workspace, realWorkspace, path, target)
    } catch (error) {
      // A name the file system refuses, e.g. one with a NUL byte or too long for Windows.
      reason = error instanceof Error ? error.message : String(error)
    }
    if (reason) warnings.push(`Skipped link ${path}: ${reason}`)
  }
  return warnings
}

// The segments of a relative path that stays below where it starts and out of .git.
function plainSegments(path: string): string[] | undefined {
  if (isAbsolute(path)) return undefined
  const segments = path.split('/')
  const plain = segments.every(
    (segment) =>
      segment !== '' &&
      segment !== '.' &&
      segment !== '..' &&
      // A Windows path separator, or an NTFS stream: .git::$INDEX_ALLOCATION is .git.
      !/[\\:]/.test(segment) &&
      !isGitDirectory(segment)
  )
  return plain ? segments : undefined
}

function recreateLink(
  workspace: string,
  realWorkspace: string,
  path: string,
  target: string
): string | undefined {
  const at = plainSegments(path)
  const to = plainSegments(target)
  if (!at || !to) return 'it leaves the checkout or enters .git'
  if (!at.slice(0, -1).includes('node_modules'))
    return 'it is not in a node_modules directory'
  // The scanner would take a directory by that name for a module's settings.
  if (
    at.some((segment) => segment.toLowerCase() === 'sonar-project.properties')
  )
    return 'it makes a sonar-project.properties'
  const destination = join(workspace, ...to)
  const real = existsSync(destination) ? realpathSync(destination) : undefined
  if (
    !real ||
    !statSync(real).isDirectory() ||
    real === realWorkspace ||
    !isWithin(real, realWorkspace) ||
    relative(realWorkspace, real).split(sep).some(isGitDirectory)
  )
    return 'it does not lead to a directory in the checkout'
  const refused = makeDirectories(workspace, at.slice(0, -1))
  if (refused) return refused
  const location = join(workspace, ...at)
  // Committed, or made by an earlier entry: the checkout's own stays.
  if (lstatSync(location, { throwIfNoEntry: false })) return undefined
  // Windows makes directory links as junctions, which need no privilege but an absolute target.
  // Elsewhere the link is relative to where it really sits: the workspace's path may itself run
  // through a link, e.g. macOS's /tmp, while the directories made above never do.
  if (process.platform === 'win32') symlinkSync(real, location, 'junction')
  else
    symlinkSync(
      relative(join(realWorkspace, ...at.slice(0, -1)), real),
      location,
      'dir'
    )
  return undefined
}

// The scanner reads one from every module directory, unchecked, so none may come from the pull
// request or the artifact. Deleting by name lets the file system match it the way the scanner's
// lookup will, e.g. SONAR-PROJECT.PROPERTIES on the case-insensitive file systems of macOS and
// Windows, which a comparison of names would miss.
export function removeProjectSettings(workspace: string): void {
  const directories = entriesUnder(workspace)
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter(
      (directory) =>
        !relative(workspace, directory).split(sep).some(isGitDirectory)
    )
  for (const directory of [workspace, ...directories])
    rmSync(join(directory, 'sonar-project.properties'), {
      force: true,
      recursive: true
    })
}

function escape(text: string, isKey: boolean): string {
  let escaped = text
    .replaceAll('\\', String.raw`\\`)
    .replaceAll('\n', String.raw`\n`)
    .replaceAll('\r', String.raw`\r`)
    .replaceAll('\t', String.raw`\t`)
    .replaceAll('\f', String.raw`\f`)
    // Correct whichever encoding the scanner reads the file with.
    .replaceAll(
      /[^\x20-\x7e]/g,
      (char) =>
        String.raw`\u${(char.codePointAt(0) as number).toString(16).padStart(4, '0')}`
    )
  if (isKey) escaped = escaped.replaceAll(/[:= #!]/g, String.raw`\$&`)
  else escaped = escaped.replace(/^ /, String.raw`\ `)
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
    ['sonar.working.directory', workingDirectory],
    // Sonar's dependency analysis lists dependencies by running the project's own build tools
    // (mvnw, gradlew, npm), i.e. the pull request's code, with the token in the environment.
    ['sonar.sca.enabled', 'false'],
    // So does the engine's build system autoconfiguration, which runs the checkout's mvnw; this turns
    // off all of it, including the readers deriving the project's layout from its build files
    // (SonarCloud engine 13.14, behind server-side feature flags).
    ['sonar.scanner.autoconfig.enabled', 'false']
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
