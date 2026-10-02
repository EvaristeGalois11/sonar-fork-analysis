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
    '/tmp/scannerwork'
  ).keys(),
  ...trustedProperties(
    { projectKey: 'key', organization: '', hostUrl: '' },
    { headSha: 'abc', branch: 'release' },
    '/tmp/scannerwork'
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
  fc.constantFrom(
    ...takers,
    'sonar',
    ' sonar ',
    ' sonar.sca',
    '.',
    '..',
    'a/b',
    'org.acme:app',
    'a',
    'a.b',
    '',
    '"sonar.sca"',
    '"a,b"',
    '\u0001sonar.sca',
    'sonar.sca\r',
    '\u3000sonar.sca',
    '\u00a0x'
  ),
  fc.string({ maxLength: 12 }).filter((id) => !id.includes(','))
)

// Module trees an artifact could declare, as sonar.modules lists at each level.
export const moduleSettings = fc
  .array(
    fc.tuple(
      fc.array(moduleId, { maxLength: 3 }),
      fc.array(moduleId, { maxLength: 4 })
    ),
    { maxLength: 6 }
  )
  .map(
    (levels) =>
      new Map(
        levels.map(([path, modules]) => [
          `${path.map((module) => `${module}.`).join('')}sonar.modules`,
          modules.join(',')
        ])
      )
  )

// What the engine trims from list entries: control characters and Unicode spaces but not no-break
// ones (measured on SonarQube's engine 13.7 and SonarCloud's 13.14, and checked against the real
// engine in real-scanner.test.ts).
export const engineTrim = (text: string): string =>
  text.replace(
    // eslint-disable-next-line no-control-regex
    /^[\x00-\x20\u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]+|[\x00-\x20\u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]+$/g,
    ''
  )
