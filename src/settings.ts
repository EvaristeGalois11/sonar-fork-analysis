// Analysis settings that may travel from the build to the analysis. Everything else in a dump is
// dropped: environment variables, JVM properties, and whatever the analysis must decide itself
// (server, token, organization, project key, scanner, branch and pull request settings).

// Paths to build output the analysis needs; the files are shipped with the settings.
const SHIPPED_PATH_KEYS = new Set([
  'sonar.binaries',
  'sonar.libraries',
  'sonar.java.binaries',
  'sonar.java.libraries',
  'sonar.java.test.binaries',
  'sonar.java.test.libraries',
  'sonar.groovy.binaries'
])

// Reports only feed the analysis data, so any key named like one is shipped, including those of
// tools Sonar adds later: sonar.coverageReportPaths, sonar.python.ruff.reportPaths, ...
const REPORT_KEY = /reports?paths?$/i

// Sonar's path patterns: * and ? within a directory, ** across directories.
export const WILDCARD = /[*?]/

export function isShippedPath(bareKey: string): boolean {
  return SHIPPED_PATH_KEYS.has(bareKey) || REPORT_KEY.test(bareKey)
}

// Paths into the checked-out sources; never shipped, the analysis has its own checkout.
export const CHECKOUT_PATH_KEYS = new Set([
  'sonar.sources',
  'sonar.tests',
  'sonar.projectBaseDir',
  'sonar.kotlin.gradleProjectRoot',
  'sonar.typescript.tsconfigPaths',
  'sonar.dre.mulesoft.muleArtifactPath'
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
  'sonar.cpd.exclusions',
  'sonar.java.ignoreUnnamedModuleForSplitPackage',
  'sonar.kotlin.source.version',
  'sonar.python.version',
  'sonar.python.xunit.skipDetails',
  'sonar.javascript.environments',
  'sonar.javascript.globals',
  'sonar.javascript.ecmaScriptVersion',
  'sonar.javascript.disableTypeChecking',
  'sonar.javascript.createTSProgramForOrphanFiles',
  'sonar.javascript.detectBundles',
  'sonar.php.frameworkDetection',
  'sonar.terraform.provider.aws.version',
  'sonar.terraform.provider.azure.version',
  'sonar.text.inclusions',
  'sonar.secrets.disableEntropyFilter',
  'sonar.secrets.disableKnownFakeSecretFilter',
  'sonar.secrets.disableTestFileDetection'
])

const PLAIN_PREFIXES = [
  'sonar.issue.ignore.',
  'sonar.issue.enforce.',
  'sonar.links.',
  'sonar.lang.patterns.'
]

// Settings every language has its own copy of, so new languages need no release.
const PLAIN_SUFFIXES = [
  '.file.suffixes',
  '.file.patterns',
  '.file.identifier',
  '.activate',
  '.exclusions',
  '.ignoreHeaderComments'
]

// Never carried, whatever the patterns above match: these run programs (dependency analysis, JDBC
// drivers), point the scanner elsewhere, or describe the analysis rather than the project.
const DENIED_PREFIXES = [
  'sonar.sca.',
  'sonar.scanner.',
  'sonar.scm.',
  'sonar.branch.',
  'sonar.pullrequest.',
  'sonar.qualitygate.',
  'sonar.analysis.',
  'sonar.plsql.jdbc.',
  'sonar.featureflag.'
]

// Every build sets these, and the analysis sets its own: dropping them is no news.
const REPLACED_KEYS = new Set([
  'sonar.host.url',
  'sonar.token',
  'sonar.login',
  'sonar.organization',
  'sonar.region',
  'sonar.projectKey',
  'sonar.working.directory',
  'sonar.userHome',
  'sonar.java.jdkHome'
])

export function isAllowed(bareKey: string): boolean {
  if (
    !bareKey.startsWith('sonar.') ||
    DENIED_PREFIXES.some((prefix) => bareKey.startsWith(prefix))
  )
    return false
  return (
    isShippedPath(bareKey) ||
    CHECKOUT_PATH_KEYS.has(bareKey) ||
    OUTPUT_PATH_KEYS.has(bareKey) ||
    PLAIN_KEYS.has(bareKey) ||
    PLAIN_PREFIXES.some((prefix) => bareKey.startsWith(prefix)) ||
    PLAIN_SUFFIXES.some((suffix) => bareKey.endsWith(suffix))
  )
}

// Every module prefix, nested ones included: '', 'a.', 'a.b.'. Module ids may contain dots
// (groupId:artifactId), so prefixes come from each level's sonar.modules, never from splitting keys.
// Each prefix is visited once: repeated or overlapping ids would otherwise multiply the walk.
export function modulePrefixes(settings: Map<string, string>): string[] {
  const prefixes = ['']
  const seen = new Set(prefixes)
  for (let index = 0; index < prefixes.length; index++) {
    const prefix = prefixes[index]
    const modules = (settings.get(`${prefix}sonar.modules`) ?? '')
      .split(',')
      .map((module) => module.trim())
      .filter((module) => module.length > 0)
    for (const module of modules) {
      // The scanner turns a module id into a directory under its parent's, and moves every key
      // starting with the id out of the parent: 'sonar.sca' would take the trusted sonar.sca.enabled.
      if (
        module === '.' ||
        module === '..' ||
        /[/\\]/.test(module) ||
        module === 'sonar' ||
        module.startsWith('sonar.')
      )
        throw new Error(`Invalid module id: ${module}`)
      const nested = `${prefix}${module}.`
      if (!seen.has(nested)) {
        seen.add(nested)
        prefixes.push(nested)
      }
    }
  }
  return prefixes
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

export type Filtered = {
  kept: Map<string, string>
  // Analysis settings the fork path does not carry.
  dropped: string[]
  // Analysis settings the analysis sets itself.
  replaced: string[]
  // Environment variables and JVM properties.
  ignored: string[]
}

export function filterSettings(settings: Map<string, string>): Filtered {
  const prefixes = modulePrefixes(settings)
  const filtered: Filtered = {
    kept: new Map(),
    dropped: [],
    replaced: [],
    ignored: []
  }
  for (const [key, value] of settings) {
    const { bareKey } = splitKey(key, prefixes)
    if (isAllowed(bareKey)) filtered.kept.set(key, value)
    else if (!bareKey.startsWith('sonar.')) filtered.ignored.push(key)
    else if (REPLACED_KEYS.has(bareKey) || bareKey.startsWith('sonar.scanner.'))
      filtered.replaced.push(key)
    else filtered.dropped.push(key)
  }
  return filtered
}
