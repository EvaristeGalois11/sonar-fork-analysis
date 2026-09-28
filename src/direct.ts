import type { BuildTool } from './build-tool.js'

export type SonarSettings = {
  hostUrl: string
  projectKey: string
  organization: string
}

const DEFAULT_GOALS = { maven: ['verify'], gradle: ['check'] }

export function sonarProperties(settings: SonarSettings): string[] {
  const properties = [`-Dsonar.projectKey=${settings.projectKey}`]
  // Without a host the scanner defaults to SonarQube Cloud and honours SONAR_HOST_URL, which an
  // explicit -D would override.
  if (settings.hostUrl) properties.push(`-Dsonar.host.url=${settings.hostUrl}`)
  if (settings.organization)
    properties.push(`-Dsonar.organization=${settings.organization}`)
  return properties
}

export function directArguments(
  tool: BuildTool,
  goals: string[],
  properties: string[],
  buildArguments: string[],
  mavenPluginVersion: string,
  gradleInitScript: string
): string[] {
  const buildGoals = goals.length > 0 ? goals : DEFAULT_GOALS[tool.name]
  if (tool.name === 'maven') {
    // One invocation on purpose: a separate `sonar:sonar` run cannot resolve the reactor's own modules
    // unless they were installed, and silently analyses without them.
    const sonar = `org.sonarsource.scanner.maven:sonar-maven-plugin:${mavenPluginVersion}:sonar`
    return [
      ...tool.prefix,
      '-B',
      ...buildGoals,
      sonar,
      ...properties,
      ...buildArguments
    ]
  }
  return [
    ...tool.prefix,
    ...buildGoals,
    'sonar',
    '--init-script',
    gradleInitScript,
    ...properties,
    ...buildArguments
  ]
}

// Applies the Sonar plugin only to builds that apply it nowhere themselves. Applied to the root, the
// plugin registers its extension on every project, so a subproject that already has it would fail.
// The check has to wait for projectsEvaluated: done earlier, a project applying its own version ends
// up with both, and Gradle fails with a ClassCastException between the two SonarExtension classes.
// Kotlin rather than Groovy: Gradle's Groovy lags behind new JDKs ("Unsupported class file major
// version") while its Kotlin compiler still copes.
export function gradleInitScript(pluginVersion: string): string {
  return `initscript {
    repositories { gradlePluginPortal() }
    dependencies { classpath("org.sonarsource.scanner.gradle:sonarqube-gradle-plugin:${pluginVersion}") }
}

gradle.projectsEvaluated {
    // buildSrc and included builds have a parent; only the main build is analysed.
    if (parent != null) return@projectsEvaluated
    if (rootProject.allprojects.none { it.pluginManager.hasPlugin("org.sonarqube") }) {
        rootProject.pluginManager.apply(org.sonarqube.gradle.SonarQubePlugin::class.java)
    }
}
`
}
