import { describe, expect, it } from 'vitest'
import { directArguments } from '../src/direct.js'

const settings = { hostUrl: 'https://sonarcloud.io', projectKey: 'key', organization: 'org' }
const versions = { maven: '5.8.0.7211', gradle: '7.5.0.8588' }

describe('directArguments', () => {
  it('builds and analyses Maven in one invocation', () => {
    expect(directArguments({ name: 'maven', executable: './mvnw' }, settings, versions, ['-Pci'], 'init.gradle')).toEqual([
      '-B',
      'verify',
      'org.sonarsource.scanner.maven:sonar-maven-plugin:5.8.0.7211:sonar',
      '-Dsonar.host.url=https://sonarcloud.io',
      '-Dsonar.projectKey=key',
      '-Dsonar.organization=org',
      '-Pci',
    ])
  })

  it('passes the init script to Gradle', () => {
    expect(directArguments({ name: 'gradle', executable: './gradlew' }, settings, versions, [], 'init.gradle')).toEqual([
      'check',
      'sonar',
      '--init-script',
      'init.gradle',
      '-Dsonar.host.url=https://sonarcloud.io',
      '-Dsonar.projectKey=key',
      '-Dsonar.organization=org',
    ])
  })

  it('omits an empty organization', () => {
    const args = directArguments({ name: 'maven', executable: 'mvn' }, { ...settings, organization: '' }, versions, [], '')
    expect(args.some(arg => arg.startsWith('-Dsonar.organization'))).toBe(false)
  })
})
