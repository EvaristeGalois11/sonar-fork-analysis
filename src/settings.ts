// Analysis settings that may travel from the build to the analysis. Everything else in a dump is
// dropped: environment variables, JVM properties, and whatever the analysis must decide itself
// (server, token, organization, project key, scanner, branch and pull request settings).

// Paths to build output the analysis needs; the files are shipped with the settings.
export const SHIPPED_PATH_KEYS = new Set([
  'sonar.binaries',
  'sonar.libraries',
  'sonar.java.binaries',
  'sonar.java.libraries',
  'sonar.java.test.binaries',
  'sonar.java.test.libraries',
  'sonar.groovy.binaries',
  'sonar.junit.reportPaths',
  'sonar.junit.reportsPath',
  'sonar.surefire.reportsPath',
  'sonar.jacoco.reportPath',
  'sonar.jacoco.reportPaths',
  'sonar.coverage.jacoco.xmlReportPaths'
])

// Paths into the checked-out sources; never shipped, the analysis has its own checkout.
export const CHECKOUT_PATH_KEYS = new Set([
  'sonar.sources',
  'sonar.tests',
  'sonar.projectBaseDir',
  'sonar.kotlin.gradleProjectRoot'
])

// Build output directories: rewritten but never shipped whole, and not in the checkout.
export const OUTPUT_PATH_KEYS = new Set(['sonar.projectBuildDir'])

const PLAIN_KEYS = new Set([
  'sonar.modules',
  'sonar.moduleKey',
  'sonar.projectName',
  'sonar.projectDescription',
  'sonar.projectVersion',
  'sonar.sourceEncoding',
  'sonar.java.source',
  'sonar.java.target',
  'sonar.java.enablePreview',
  'sonar.inclusions',
  'sonar.exclusions',
  'sonar.test.inclusions',
  'sonar.test.exclusions',
  'sonar.coverage.exclusions',
  'sonar.cpd.exclusions'
])

const PLAIN_PREFIXES = [
  'sonar.issue.ignore.',
  'sonar.issue.enforce.',
  'sonar.links.'
]

export function isAllowed(bareKey: string): boolean {
  return (
    SHIPPED_PATH_KEYS.has(bareKey) ||
    CHECKOUT_PATH_KEYS.has(bareKey) ||
    OUTPUT_PATH_KEYS.has(bareKey) ||
    PLAIN_KEYS.has(bareKey) ||
    PLAIN_PREFIXES.some((prefix) => bareKey.startsWith(prefix))
  )
}

// Every module prefix, nested ones included: '', 'a.', 'a.b.'. Module ids may contain dots
// (groupId:artifactId), so prefixes come from each level's sonar.modules, never from splitting keys.
export function modulePrefixes(
  settings: Map<string, string>,
  prefix = ''
): string[] {
  const modules = (settings.get(`${prefix}sonar.modules`) ?? '')
    .split(',')
    .map((module) => module.trim())
    .filter((module) => module.length > 0)
  return [
    prefix,
    ...modules.flatMap((module) =>
      modulePrefixes(settings, `${prefix}${module}.`)
    )
  ]
}

export type SplitKey = { prefix: string; bareKey: string }

export function splitKey(key: string, prefixes: string[]): SplitKey {
  // Longest first, so a nested module wins over its parent.
  const prefix =
    [...prefixes]
      .sort((a, b) => b.length - a.length)
      .find((candidate) => candidate !== '' && key.startsWith(candidate)) ?? ''
  return { prefix, bareKey: key.slice(prefix.length) }
}

export function filterSettings(settings: Map<string, string>): {
  kept: Map<string, string>
  dropped: string[]
} {
  const prefixes = modulePrefixes(settings)
  const kept = new Map<string, string>()
  const dropped: string[] = []
  for (const [key, value] of settings) {
    const { bareKey } = splitKey(key, prefixes)
    if (isAllowed(bareKey)) kept.set(key, value)
    else if (bareKey.startsWith('sonar.')) dropped.push(key)
  }
  return { kept, dropped }
}
