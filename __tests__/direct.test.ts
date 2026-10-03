import {
  buildFailure,
  sonarBuildArguments,
  missingAnalysis,
  sonarProperties
} from '../src/direct.js'

const maven = { name: 'maven' as const, executable: './mvnw', prefix: [] }
const gradle = { name: 'gradle' as const, executable: './gradlew', prefix: [] }
const node = { name: 'node' as const, executable: '', prefix: [] }
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

describe('sonarBuildArguments', () => {
  it('builds and analyses Maven in one invocation, analysis last', () => {
    expect(sonarBuildArguments(maven, [], properties, ['-Pci'])).toEqual([
      '-B',
      'verify',
      'org.sonarsource.scanner.maven:sonar-maven-plugin:sonar',
      '-Dsonar.projectKey=key',
      '-Pci'
    ])
  })

  it('runs custom Maven goals before the analysis', () => {
    const args = sonarBuildArguments(
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
      sonarBuildArguments(gradle, ['test', 'jacocoTestReport'], properties, [])
    ).toEqual(['test', 'jacocoTestReport', 'sonar', '-Dsonar.projectKey=key'])
  })

  it('runs a non-executable wrapper through sh', () => {
    const args = sonarBuildArguments(
      { name: 'gradle', executable: 'sh', prefix: ['gradlew'] },
      [],
      properties,
      []
    )
    expect(args.slice(0, 3)).toEqual(['gradlew', 'check', 'sonar'])
  })
})

describe('sonarBuildArguments for Node', () => {
  it('only starts the scanner, which reads the build-arguments too', () => {
    expect(
      sonarBuildArguments(node, [], properties, ['-Dsonar.projectName=App'])
    ).toEqual(['-Dsonar.projectKey=key', '-Dsonar.projectName=App'])
  })

  it('refuses build goals, as the action runs after the build', () => {
    expect(() => sonarBuildArguments(node, ['test'], properties, [])).toThrow(
      'build-goals does not apply to Node projects: install and test in your own steps before the action'
    )
  })

  it('reports a failed scanner as such', () => {
    expect(buildFailure(node, 2, '')).toBe(
      'The Sonar scanner failed with exit code 2'
    )
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

  it('explains a Gradle build where sonar is ambiguous', () => {
    const output =
      "Task 'sonar' is ambiguous in root project 'app'. Candidates are: 'sonarlintMain', 'sonarlintTest'."
    expect(buildFailure(gradle, 1, output)).toMatch(/apply the org\.sonarqube/)
  })

  it('reports the exit code otherwise', () => {
    expect(buildFailure(gradle, 1, 'compilation failed')).toBe(
      'The Gradle build failed with exit code 1'
    )
    expect(buildFailure(maven, 2, "Task 'sonar' not found")).toBe(
      'The Maven build failed with exit code 2'
    )
  })
})

describe('missingAnalysis', () => {
  it('points Gradle users at the plugin', () => {
    expect(missingAnalysis(gradle)).toMatch(
      /^The Gradle build succeeded but no Sonar analysis ran: apply the org\.sonarqube plugin/
    )
  })

  it('points Node users at where the scanner wrote its report', () => {
    expect(missingAnalysis(node)).toMatch(
      /left no report in the working directory: check that sonar\.projectBaseDir and sonar\.working\.directory/
    )
  })

  it('points Maven users at sonar.skip', () => {
    expect(missingAnalysis(maven)).toMatch(/sonar\.skip/)
  })
})
