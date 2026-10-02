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

// The scanner trims values of everything up to a space, and reads lists as CSV: quotes group entries,
// \r turns into \n, and entries lose control characters and Unicode spaces (except no-break ones) at
// either end (scanner CLI 8.1, engine 13.7). A list with these is not read the way it was checked.
// In module lists any whitespace but a space is refused, so both sides trim the same ids the same way.
// eslint-disable-next-line no-control-regex
export const REREAD_IN_LIST = /["\x00-\x1f]|[^\S ]/
// eslint-disable-next-line no-control-regex
export const REREAD_PATH = /["\x00-\x1f]|^\s|\s$/

export function isShippedPath(bareKey: string): boolean {
  return SHIPPED_PATH_KEYS.has(bareKey) || REPORT_KEY.test(bareKey)
}

// The scanner reads these and every setting named ...Paths as lists; any other path setting as a
// single path, commas included (sonar.projectBaseDir is a plain new File(value), engine 13.7).
const LIST_PATH_KEYS = new Set([
  'sonar.sources',
  'sonar.tests',
  ...SHIPPED_PATH_KEYS
])

export function isPathList(bareKey: string): boolean {
  return LIST_PATH_KEYS.has(bareKey) || /paths$/i.test(bareKey)
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
  // Emitted by the Gradle plugin for Android projects.
  'sonar.android.detected',
  'sonar.android.minsdkversion.min',
  'sonar.android.minsdkversion.max',
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

// Dropped without a warning: what every build emits for its own scanner, which the analysis
// replaces, and switches the build plugin has already applied.
const REPLACED_KEYS = new Set([
  'sonar.host.url',
  'sonar.token',
  'sonar.login',
  'sonar.organization',
  'sonar.projectKey',
  'sonar.working.directory',
  'sonar.userHome',
  'sonar.java.jdkHome',
  'sonar.skip',
  'sonar.maven.scanAll',
  'sonar.gradle.scanAll'
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

export type SplitKey = { prefix: string; bareKey: string }

export type ModuleTree = {
  // Every module, as the prefix of the keys the engine gives it: '', 'a.', 'a.b.'.
  prefixes: string[]
  // The module the engine gives a key to, and the key within it.
  split(key: string): SplitKey
  // The key the engine gives a module as the given one, if any.
  keyOf(prefix: string, bareKey: string): string | undefined
}

// The modules and their keys, assigned the way the engine does (ProjectReactorBuilder, now
// ProjectStructureBuilder.extractPropertiesByModule): each level's sonar.modules, in reverse sorted
// order, and each module takes the keys starting with its id from what its earlier siblings left.
// Module ids may contain dots (groupId:artifactId), so a key's longest matching prefix can name a
// different module than the engine's; see real-scanner.test.ts.
export function moduleTree(settings: Map<string, string>): ModuleTree {
  const assigned = new Map<string, SplitKey>()
  const prefixes: string[] = []
  const walk = (prefix: string, keys: Map<string, string>): void => {
    prefixes.push(prefix)
    const listKey = keys.get('sonar.modules')
    const list = (listKey !== undefined && settings.get(listKey)) || ''
    // Quoted, "sonar.sca" would pass the check below and still name the module sonar.sca.
    if (REREAD_IN_LIST.test(list))
      throw new Error(`Invalid module id in ${JSON.stringify(list)}`)
    const modules = list
      .split(',')
      .map((module) => module.trim())
      .filter((module) => module.length > 0)
    for (const module of modules.sort().reverse()) {
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
      // The engine refuses a module path it has seen, e.g. a,a or a,a.b next to a's own b.
      if (prefixes.includes(nested))
        throw new Error(`Invalid module id: ${module} repeats ${nested}`)
      const own = new Map<string, string>()
      for (const [relative, original] of keys) {
        if (relative.startsWith(`${module}.`)) {
          own.set(relative.slice(module.length + 1), original)
          keys.delete(relative)
        }
      }
      walk(nested, own)
    }
    for (const [relative, original] of keys)
      assigned.set(original, { prefix, bareKey: relative })
  }
  walk('', new Map([...settings.keys()].map((key) => [key, key])))

  const byModule = new Map<string, Map<string, string>>()
  for (const [key, { prefix, bareKey }] of assigned) {
    if (!byModule.has(prefix)) byModule.set(prefix, new Map())
    byModule.get(prefix)?.set(bareKey, key)
  }
  return {
    prefixes,
    split: (key) => assigned.get(key) ?? { prefix: '', bareKey: key },
    keyOf: (prefix, bareKey) => byModule.get(prefix)?.get(bareKey)
  }
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
  const tree = moduleTree(settings)
  const filtered: Filtered = {
    kept: new Map(),
    dropped: [],
    replaced: [],
    ignored: []
  }
  for (const [key, value] of settings) {
    const { bareKey } = tree.split(key)
    if (isAllowed(bareKey)) filtered.kept.set(key, value)
    else if (!bareKey.startsWith('sonar.')) filtered.ignored.push(key)
    else if (REPLACED_KEYS.has(bareKey) || bareKey.startsWith('sonar.scanner.'))
      filtered.replaced.push(key)
    else filtered.dropped.push(key)
  }
  return filtered
}
