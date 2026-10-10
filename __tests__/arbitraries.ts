// Generated inputs shared by the property tests and the checks against the real scanner.
import fc from 'fast-check'
import { trustedProperties } from '../src/analyze.js'

// Biased towards what the properties format treats specially, so random strings meet it often.
export const settingText = fc.string({
  unit: fc.oneof(
    fc.constantFrom(
      '\\',
      '\n',
      '\r',
      '\t',
      '\f',
      ' ',
      '=',
      ':',
      '#',
      '!',
      '$',
      '{',
      '}',
      '.',
      ',',
      '"',
      'u',
      'é',
      '😀',
      '\u3000',
      '\u00a0',
      // Lone surrogates, which a JSON artifact can carry.
      '\ud800',
      '\udfff'
    ),
    fc.string({ unit: 'binary', minLength: 1, maxLength: 1 })
  ),
  maxLength: 100
})

export const placeholder = /\$\{[\w.]+\}/

export const settingsWithoutPlaceholders = fc
  .uniqueArray(fc.tuple(settingText, settingText), { selector: ([key]) => key })
  .filter((entries) => entries.every(([, value]) => !placeholder.test(value)))

// Every setting the analysis sets on the project.
export const trustedKeys = [
  ...trustedProperties(
    { projectKey: 'key', organization: 'org', hostUrl: 'https://sonar' },
    {
      headSha: 'abc',
      pullRequest: { key: '7', branch: 'feature', base: 'main' }
    },
    '/tmp/scannerwork',
    ['java', 'py', 'rust']
  ).keys(),
  ...trustedProperties(
    { projectKey: 'key', organization: '', hostUrl: '' },
    { headSha: 'abc', branch: 'release' },
    '/tmp/scannerwork',
    ['java', 'py', 'rust']
  ).keys()
]

// Each dot-prefix of a trusted key, which a module id could take it by.
const takers = trustedKeys.flatMap((key) =>
  key
    .split('.')
    .slice(1, -1)
    .map((_, index, parts) => ['sonar', ...parts.slice(0, index + 1)].join('.'))
)

const moduleId = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.constantFrom(
      ...takers,
      'sonar',
      ' sonar ',
      ' sonar.sca',
      '.',
      '..',
      'a/b',
      'org.acme:app',
      // Ids that are each other's prefixes, where a key's longest prefix and the engine disagree.
      'a',
      'a.b',
      'a.b.c',
      'b',
      'b.c',
      'c',
      'X:core',
      'X:core.tests',
      '',
      '"sonar.sca"',
      '"a,b"',
      '\u0001sonar.sca',
      'sonar.sca\r',
      '\u3000sonar.sca',
      '\u00a0x'
    )
  },
  {
    weight: 1,
    arbitrary: fc.string({ maxLength: 12 }).filter((id) => !id.includes(','))
  }
)

type ModuleNode = { id: string; children: ModuleNode[] }

// Ids a real build could have, overlapping so that keys collide.
const plausibleModuleId = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.constantFrom(
      'a',
      'a.b',
      'a.b.c',
      'b',
      'b.c',
      'c',
      'X:core',
      'X:core.tests',
      'org.acme:app'
    )
  },
  { weight: 1, arbitrary: fc.stringMatching(/^[a-c][a-c.:]{0,5}$/) }
)

const moduleLevel = (
  id: fc.Arbitrary<string>,
  depth: number
): fc.Arbitrary<ModuleNode[]> =>
  fc.array(
    fc.record({
      id,
      children: depth > 1 ? moduleLevel(id, depth - 1) : fc.constant([])
    }),
    { maxLength: 3 }
  )

// Module trees an artifact could declare, built top-down: each module's list, base and one more
// setting, under the prefix its key would carry. Overlapping ids make keys collide, on purpose.
const treeSettings = (roots: ModuleNode[]): Map<string, string> => {
  const settings = new Map<string, string>()
  let count = 0
  const add = (prefix: string, nodes: ModuleNode[]): void => {
    if (nodes.length === 0) return
    settings.set(`${prefix}sonar.modules`, nodes.map(({ id }) => id).join(','))
    for (const { id, children } of nodes) {
      const nested = `${prefix}${id}.`
      settings.set(`${nested}sonar.projectBaseDir`, `/ws/${count++}`)
      settings.set(`${nested}sonar.exclusions`, `${count++}`)
      add(nested, children)
    }
  }
  add('', roots)
  return settings
}

export const moduleSettings = moduleLevel(moduleId, 3).map(treeSettings)

// Trees a real build could declare, which the analysis mostly accepts.
export const plausibleModuleSettings = moduleLevel(plausibleModuleId, 3).map(
  treeSettings
)

// How the engine trims a list entry, in two passes (SonarQube's engine 13.7 and SonarCloud's 13.14,
// checked against both in real-scanner.test.ts): its own, which strips everything up to a space and
// drops an entry left empty, then the CSV parser's, which strips Java whitespace, i.e. Unicode spaces
// but not no-break ones, plus a few control characters.
// eslint-disable-next-line no-control-regex -- control characters are what it trims
const upToSpace = /^[\x00-\x20]+|[\x00-\x20]+$/g
const javaWhitespace =
  // eslint-disable-next-line no-control-regex -- control characters are what it trims
  /^[\t\n\v\f\r\x1c-\x1f \u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]+|[\t\n\v\f\r\x1c-\x1f \u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]+$/g

// The entry the engine reads, or undefined when it drops it.
export const engineEntry = (text: string): string | undefined => {
  const own = text.replace(upToSpace, '')
  return own === '' ? undefined : own.replace(javaWhitespace, '')
}
