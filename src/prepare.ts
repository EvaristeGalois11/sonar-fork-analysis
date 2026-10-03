import {
  cpSync,
  existsSync,
  globSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
  type Dirent
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { BuildTool } from './build-tool.js'
import {
  CHECKOUT_PATH_KEYS,
  OUTPUT_PATH_KEYS,
  WILDCARD,
  isPathList,
  isShippedPath,
  isTypeInformation,
  moduleTree
} from './settings.js'

export const ARTIFACT_FORMAT = 1

// A port that refuses connections: if the plugin ignored the simulation property, the build fails
// instead of reaching a real server.
const OFFLINE_HOST = 'http://127.0.0.1:9'

// Reports sensors look for on their own when no path is configured, relative to each module.
const IMPLICIT_REPORTS = [
  'target/site/jacoco/jacoco.xml',
  'target/site/jacoco-it/jacoco.xml',
  'build/reports/jacoco/test/jacocoTestReport.xml'
]

export type Root = 'workspace' | 'home'
export type Roots = Record<Root, string>

export function simulationProperties(dumpFile: string): string[] {
  // Older plugins read the first name, current ones the second.
  return [
    `-Dsonar.host.url=${OFFLINE_HOST}`,
    `-Dsonar.scanner.dumpToFile=${dumpFile}`,
    `-Dsonar.scanner.internal.dumpToFile=${dumpFile}`
  ]
}

// Named after the project, so the build and the analysis agree without further settings, and every
// project of a monorepo gets its own. Artifact names cannot hold ':', which project keys may.
export const ARTIFACT_PREFIX = 'sonar-fork-analysis-'

export function artifactName(projectKey: string): string {
  if (!/^[A-Za-z0-9._:-]+$/.test(projectKey)) {
    throw new Error(`Invalid project key '${projectKey}'`)
  }
  return `${ARTIFACT_PREFIX}${projectKey.replaceAll(':', '_')}`
}

// '+' cannot occur in a project key, so no prepared artifact can take this name.
export function directArtifactName(projectKey: string): string {
  return `${artifactName(projectKey)}+direct`
}

// The first releases whose simulation mode writes the settings (checked 2026-10-03).
const MINIMUM_PLUGIN = {
  maven: 'sonar-maven-plugin 3.2',
  gradle: 'the org.sonarqube plugin 2.1'
}

export function missingDump(tool: BuildTool): string {
  if (tool.name === 'scanner')
    return 'The Sonar scanner succeeded but wrote no analysis settings'
  return `The ${tool.name === 'maven' ? 'Maven' : 'Gradle'} build succeeded but its Sonar plugin wrote no analysis settings; the fork path needs ${MINIMUM_PLUGIN[tool.name]} or later`
}

// A link in node_modules, both paths relative to the workspace, with forward slashes.
export type PackageLink = { path: string; target: string }

export type TypeInformation = {
  files: string[]
  links: PackageLink[]
  // Links to directories outside the workspace, e.g. npm link or pnpm's global store, left out.
  outside: number
}

// The analysis has no node_modules, as nothing may install the pull request's dependencies there, so
// TypeScript would resolve fewer types and type-aware rules report less. This is what it reads there,
// from the project's node_modules and those of the directories above it up to the workspace, where
// npm and Yarn workspaces install. Links are not followed but recorded, when they lead to a directory
// in the workspace, so the analysis can make them again: workspaces link their own packages, pnpm
// every package. A workspace package a link leads to keeps its own dependencies in its node_modules,
// unhoisted with pnpm, so that is read too. A directory the build can't read is skipped.
export function typeInformation(
  directory: string,
  workspace: string
): TypeInformation {
  const files: string[] = []
  const links: PackageLink[] = []
  let outside = 0
  const realWorkspace = realpathSync(workspace)
  const posix = (path: string): string => path.split(sep).join('/')
  const seen = new Set<string>()
  const packages: string[] = []
  const visit = (path: string, inPackages: boolean): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(path, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '.git') continue
        if (!inPackages && entry.name === 'node_modules') {
          if (seen.has(realpathSync(child))) continue
          seen.add(realpathSync(child))
        }
        visit(child, inPackages || entry.name === 'node_modules')
      } else if (inPackages && entry.isSymbolicLink()) {
        const target = linkTarget(child, realWorkspace)
        if (target === 'outside') outside++
        else if (target) {
          links.push({
            path: posix(relative(workspace, child)),
            target: posix(target)
          })
          if (!target.split(sep).includes('node_modules'))
            packages.push(join(realWorkspace, target, 'node_modules'))
        }
      } else if (
        inPackages &&
        entry.isFile() &&
        isTypeInformation(entry.name)
      ) {
        files.push(child)
      }
    }
  }
  const visitPackages = (path: string): void => {
    if (!lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) return
    const real = realpathSync(path)
    if (seen.has(real)) return
    seen.add(real)
    visit(path, true)
  }
  visit(directory, false)
  for (
    let above = dirname(directory);
    locate(above, { workspace, home: workspace });
    above = dirname(above)
  ) {
    visitPackages(join(above, 'node_modules'))
    if (above === dirname(above)) break
  }
  for (let next = packages.shift(); next; next = packages.shift())
    visitPackages(join(workspace, relative(realWorkspace, next)))
  return { files, links, outside }
}

// Where a link leads, relative to the workspace, if that is a directory inside it; 'outside' for a
// directory elsewhere. Links to files, such as node_modules/.bin, and broken ones don't count.
function linkTarget(
  link: string,
  realWorkspace: string
): string | 'outside' | undefined {
  try {
    const target = realpathSync(link)
    if (!statSync(target).isDirectory()) return undefined
    const rel = relative(realWorkspace, target)
    if (rel === '') return undefined
    return rel.startsWith('..') || isAbsolute(rel) ? 'outside' : rel
  } catch {
    return undefined
  }
}

function locate(path: string, roots: Roots): [Root, string] | undefined {
  for (const root of ['workspace', 'home'] as const) {
    const rel = relative(roots[root], path)
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)))
      return [root, rel]
  }
  return undefined
}

function token(root: Root, rel: string): string {
  return rel === '' ? `{${root}}` : `{${root}}/${rel.split(sep).join('/')}`
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

export type Staged = {
  settings: Record<string, string>
  files: string[]
  warnings: string[]
}

// Rewrites paths to {workspace}/… and {home}/… so the analysis can map them onto its own
// directories, and copies the build output they point to into the staging directory.
export function stageAnalysis(
  settings: Map<string, string>,
  roots: Roots,
  staging: string,
  buildTool: BuildTool['name'],
  pullRequest?: number,
  extraFiles: string[] = [],
  links: PackageLink[] = []
): Staged {
  const tree = moduleTree(settings)
  const shipped = new Map<string, [Root, string]>()
  const warnings: string[] = []
  const out: Record<string, string> = {}

  const ship = ([root, rel]: [Root, string]): void => {
    shipped.set(`${root}:${rel}`, [root, rel])
  }

  for (const [key, value] of settings) {
    const { prefix, bareKey } = tree.split(key)
    const isShipped = isShippedPath(bareKey)
    if (
      !isShipped &&
      !CHECKOUT_PATH_KEYS.has(bareKey) &&
      !OUTPUT_PATH_KEYS.has(bareKey)
    ) {
      out[key] = value
      continue
    }
    const base =
      settings.get(tree.keyOf(prefix, 'sonar.projectBaseDir') ?? '') ??
      roots.workspace
    const entries: string[] = []
    // The scanner reads only lists as comma-separated, any other path setting as one path.
    const listed = (isPathList(bareKey) ? value.split(',') : [value])
      .map((path) => path.trim())
      .filter((path) => path !== '')
    // Only the matching files are shipped, so the analysis gets them listed instead of the pattern.
    const expanded = listed.flatMap((entry) =>
      isShipped && WILDCARD.test(entry)
        ? globSync(entry, { cwd: base })
            .map((match) => match.split(sep).join('/'))
            .sort()
        : [entry]
    )
    for (const entry of expanded) {
      const path = resolve(base, entry)
      if (isShipped && !existsSync(path)) continue
      const located = locate(path, roots)
      if (!located) {
        warnings.push(`Dropped ${key} entry outside the workspace: ${entry}`)
        continue
      }
      if (isShipped) ship(located)
      // Relative entries stay relative: they resolve against the module the same way on both sides.
      entries.push(isAbsolute(entry) ? token(...located) : entry)
    }
    if (entries.length > 0 || !isShipped) out[key] = entries.join(',')
  }

  for (const prefix of tree.prefixes) {
    const base = settings.get(tree.keyOf(prefix, 'sonar.projectBaseDir') ?? '')
    if (!base) continue
    for (const report of IMPLICIT_REPORTS) {
      const path = join(base, report)
      const located = existsSync(path) && locate(path, roots)
      if (located) ship(located)
    }
  }

  for (const path of extraFiles) {
    const located = locate(path, roots)
    if (located) ship(located)
  }

  mkdirSync(staging, { recursive: true })
  for (const [root, rel] of shipped.values()) {
    cpSync(join(roots[root], rel), join(staging, root, rel), {
      recursive: true,
      dereference: true
    })
  }
  writeFileSync(
    join(staging, 'settings.json'),
    JSON.stringify(
      { format: ARTIFACT_FORMAT, buildTool, pullRequest, settings: out, links },
      null,
      2
    )
  )
  return { settings: out, files: filesUnder(staging), warnings }
}
