import {
  cpSync,
  existsSync,
  globSync,
  mkdirSync,
  readdirSync,
  writeFileSync
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { BuildTool } from './build-tool.js'
import {
  CHECKOUT_PATH_KEYS,
  OUTPUT_PATH_KEYS,
  WILDCARD,
  isPathList,
  isShippedPath,
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
  return `The ${tool.name === 'maven' ? 'Maven' : 'Gradle'} build succeeded but its Sonar plugin wrote no analysis settings; the fork path needs ${MINIMUM_PLUGIN[tool.name]} or later`
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
  pullRequest?: number
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
      { format: ARTIFACT_FORMAT, buildTool, pullRequest, settings: out },
      null,
      2
    )
  )
  return { settings: out, files: filesUnder(staging), warnings }
}
