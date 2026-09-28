import type { BuildTool } from './build-tool.js'

export type SonarSettings = {
  hostUrl: string
  projectKey: string
  organization: string
}

export type PluginVersions = {
  maven: string
  gradle: string
}

export function sonarProperties(settings: SonarSettings): string[] {
  const properties = [
    `-Dsonar.host.url=${settings.hostUrl}`,
    `-Dsonar.projectKey=${settings.projectKey}`
  ]
  if (settings.organization)
    properties.push(`-Dsonar.organization=${settings.organization}`)
  return properties
}

export function directArguments(
  tool: BuildTool,
  settings: SonarSettings,
  versions: PluginVersions,
  extraArguments: string[],
  gradleInitScript: string
): string[] {
  const properties = sonarProperties(settings)
  if (tool.name === 'maven') {
    // One invocation on purpose: a separate `sonar:sonar` run cannot resolve the reactor's own modules
    // unless they were installed, and silently analyses without them.
    const goal = `org.sonarsource.scanner.maven:sonar-maven-plugin:${versions.maven}:sonar`
    return ['-B', 'verify', goal, ...properties, ...extraArguments]
  }
  return [
    'check',
    'sonar',
    '--init-script',
    gradleInitScript,
    ...properties,
    ...extraArguments
  ]
}

// Applies the Sonar plugin only to builds that do not apply it themselves. The check has to wait for
// projectsEvaluated: done earlier, a project applying its own version ends up with both, and Gradle
// fails with a ClassCastException between the two SonarExtension classes.
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
    if (!rootProject.pluginManager.hasPlugin("org.sonarqube")) {
        rootProject.pluginManager.apply(org.sonarqube.gradle.SonarQubePlugin::class.java)
    }
}
`
}
