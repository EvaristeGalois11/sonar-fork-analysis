import {
  directArguments,
  gradleInitScript,
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
    expect(
      directArguments(maven, [], properties, ['-Pci'], '5.8.0.7211', '')
    ).toEqual([
      '-B',
      'verify',
      'org.sonarsource.scanner.maven:sonar-maven-plugin:5.8.0.7211:sonar',
      '-Dsonar.projectKey=key',
      '-Pci'
    ])
  })

  it('runs custom Maven goals before the analysis', () => {
    const args = directArguments(
      maven,
      ['clean', 'verify', 'org.jacoco:jacoco-maven-plugin:report'],
      properties,
      [],
      '5.8.0.7211',
      ''
    )
    expect(args.slice(0, 5)).toEqual([
      '-B',
      'clean',
      'verify',
      'org.jacoco:jacoco-maven-plugin:report',
      'org.sonarsource.scanner.maven:sonar-maven-plugin:5.8.0.7211:sonar'
    ])
  })

  it('passes the init script to Gradle after its tasks', () => {
    expect(
      directArguments(
        gradle,
        ['test', 'jacocoTestReport'],
        properties,
        [],
        '',
        'init.gradle.kts'
      )
    ).toEqual([
      'test',
      'jacocoTestReport',
      'sonar',
      '--init-script',
      'init.gradle.kts',
      '-Dsonar.projectKey=key'
    ])
  })

  it('runs a non-executable wrapper through sh', () => {
    const args = directArguments(
      { name: 'gradle', executable: 'sh', prefix: ['gradlew'] },
      [],
      properties,
      [],
      '',
      'init.gradle.kts'
    )
    expect(args.slice(0, 3)).toEqual(['gradlew', 'check', 'sonar'])
  })
})

describe('gradleInitScript', () => {
  const script = gradleInitScript('7.5.0.8588')

  it('pins the plugin version', () => {
    expect(script).toContain(
      'classpath("org.sonarsource.scanner.gradle:sonarqube-gradle-plugin:7.5.0.8588")'
    )
  })

  it('applies the plugin only when no project applies it', () => {
    expect(script).toContain(
      'rootProject.allprojects.none { it.pluginManager.hasPlugin("org.sonarqube") }'
    )
  })

  it('leaves buildSrc and included builds alone', () => {
    expect(script).toContain('if (parent != null) return@projectsEvaluated')
  })
})
