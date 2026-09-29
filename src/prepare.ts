import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { BuildTool } from './build-tool.js'
import {
  CHECKOUT_PATH_KEYS,
  OUTPUT_PATH_KEYS,
  SHIPPED_PATH_KEYS,
  modulePrefixes,
  splitKey
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

export function artifactName(id: string): string {
  if (id && !/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(
      `Invalid id '${id}': use letters, digits, dots, dashes or underscores`
    )
  }
  return id ? `sonar-fork-analysis-${id}` : 'sonar-fork-analysis'
}

export function missingDump(tool: BuildTool): string {
  return `The ${tool.name === 'maven' ? 'Maven' : 'Gradle'} build succeeded but its Sonar plugin wrote no analysis settings; the plugin may be too old to support simulation mode`
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
  buildTool: BuildTool['name']
): Staged {
  const prefixes = modulePrefixes(settings)
  const shipped = new Map<string, [Root, string]>()
  const warnings: string[] = []
  const out: Record<string, string> = {}

  const ship = ([root, rel]: [Root, string]): void => {
    shipped.set(`${root}:${rel}`, [root, rel])
  }

  for (const [key, value] of settings) {
    const { prefix, bareKey } = splitKey(key, prefixes)
    const isShipped = SHIPPED_PATH_KEYS.has(bareKey)
    if (
      !isShipped &&
      !CHECKOUT_PATH_KEYS.has(bareKey) &&
      !OUTPUT_PATH_KEYS.has(bareKey)
    ) {
      out[key] = value
      continue
    }
    const base =
      settings.get(`${prefix}sonar.projectBaseDir`) ?? roots.workspace
    const entries: string[] = []
    for (const entry of value.split(',').map((path) => path.trim())) {
      if (entry === '') continue
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

  for (const prefix of prefixes) {
    const base = settings.get(`${prefix}sonar.projectBaseDir`)
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
      { format: ARTIFACT_FORMAT, buildTool, settings: out },
      null,
      2
    )
  )
  return { settings: out, files: filesUnder(staging), warnings }
}
