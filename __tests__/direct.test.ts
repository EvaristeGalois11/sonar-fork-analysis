import {
  buildFailure,
  directArguments,
  sonarProperties
} from '../src/direct.js'

const maven = { name: 'maven' as const, executable: './mvnw', prefix: [] }
const gradle = { name: 'gradle' as const, executable: './gradlew', prefix: [] }
const properties = ['-Dsonar.projectKey=key']

describe('sonarProperties', () => {
  it('passes host and organization only when set', () => {
    expect(
      sonarProperties({ hostUrl: '', projectKey: 'key', organization: '' })
    ).toEqual(['-Dsonar.projectKey=key'])
    expect(
      sonarProperties({
        hostUrl: 'https://sonar.example.com',
        projectKey: 'key',
        organization: 'org'
      })
    ).toEqual([
      '-Dsonar.projectKey=key',
      '-Dsonar.host.url=https://sonar.example.com',
      '-Dsonar.organization=org'
    ])
  })
})

describe('directArguments', () => {
  it('builds and analyses Maven in one invocation, analysis last', () => {
    expect(directArguments(maven, [], properties, ['-Pci'])).toEqual([
      '-B',
      'verify',
      'org.sonarsource.scanner.maven:sonar-maven-plugin:sonar',
      '-Dsonar.projectKey=key',
      '-Pci'
    ])
  })

  it('runs custom Maven goals before the analysis', () => {
    const args = directArguments(
      maven,
      ['clean', 'verify', 'org.jacoco:jacoco-maven-plugin:report'],
      properties,
      []
    )
    expect(args.slice(0, 5)).toEqual([
      '-B',
      'clean',
      'verify',
      'org.jacoco:jacoco-maven-plugin:report',
      'org.sonarsource.scanner.maven:sonar-maven-plugin:sonar'
    ])
  })

  it('runs custom Gradle tasks before the analysis', () => {
    expect(
      directArguments(gradle, ['test', 'jacocoTestReport'], properties, [])
    ).toEqual(['test', 'jacocoTestReport', 'sonar', '-Dsonar.projectKey=key'])
  })

  it('runs a non-executable wrapper through sh', () => {
    const args = directArguments(
      { name: 'gradle', executable: 'sh', prefix: ['gradlew'] },
      [],
      properties,
      []
    )
    expect(args.slice(0, 3)).toEqual(['gradlew', 'check', 'sonar'])
  })
})

describe('buildFailure', () => {
  it('explains a Gradle build without the Sonar plugin', () => {
    const output =
      "* What went wrong:\nSelection failed\n  Task 'sonar' not found in root project 'app' and its subprojects."
    expect(buildFailure(gradle, 1, output)).toMatch(
      /apply the org\.sonarqube plugin, see https:\/\/docs\.sonarsource\.com\//
    )
  })

  it('reports the exit code otherwise', () => {
    expect(buildFailure(gradle, 1, 'compilation failed')).toBe(
      'The gradle build failed with exit code 1'
    )
    expect(buildFailure(maven, 2, "Task 'sonar' not found")).toBe(
      'The maven build failed with exit code 2'
    )
  })
})
