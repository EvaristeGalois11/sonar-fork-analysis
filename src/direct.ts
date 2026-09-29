import type { BuildTool } from './build-tool.js'

export type SonarSettings = {
  hostUrl: string
  projectKey: string
  organization: string
}

const DEFAULT_GOALS = { maven: ['verify'], gradle: ['check'] }

const GRADLE_PLUGIN_GUIDE =
  'https://docs.sonarsource.com/sonarqube-cloud/advanced-setup/ci-based-analysis/sonarscanner-for-gradle'

export function sonarProperties(settings: SonarSettings): string[] {
  const properties = [`-Dsonar.projectKey=${settings.projectKey}`]
  // Without a host the scanner defaults to SonarQube Cloud and honours SONAR_HOST_URL, which an
  // explicit -D would override.
  if (settings.hostUrl) properties.push(`-Dsonar.host.url=${settings.hostUrl}`)
  if (settings.organization)
    properties.push(`-Dsonar.organization=${settings.organization}`)
  return properties
}

export function sonarBuildArguments(
  tool: BuildTool,
  goals: string[],
  properties: string[],
  buildArguments: string[]
): string[] {
  const buildGoals = goals.length > 0 ? goals : DEFAULT_GOALS[tool.name]
  if (tool.name === 'maven') {
    // One invocation on purpose: a separate `sonar:sonar` run cannot resolve the reactor's own modules
    // unless they were installed, and silently analyses without them.
    // No version: Maven uses the one pinned in the project, where Dependabot can update it, or the
    // latest release.
    const sonar = 'org.sonarsource.scanner.maven:sonar-maven-plugin:sonar'
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
    ...properties,
    ...buildArguments
  ]
}

const TOOL_NAMES = { maven: 'Maven', gradle: 'Gradle' }

export function buildFailure(
  tool: BuildTool,
  exitCode: number,
  errorOutput: string
): string {
  if (
    tool.name === 'gradle' &&
    /Task 'sonar' (not found|is ambiguous)/.test(errorOutput)
  ) {
    return `The Gradle build has no 'sonar' task: apply the org.sonarqube plugin, see ${GRADLE_PLUGIN_GUIDE}`
  }
  return `The ${TOOL_NAMES[tool.name]} build failed with exit code ${exitCode}`
}

export function missingAnalysis(tool: BuildTool): string {
  const message = `The ${TOOL_NAMES[tool.name]} build succeeded but no Sonar analysis ran`
  // Gradle runs any single task whose name starts with 'sonar' when the plugin is missing.
  return tool.name === 'gradle'
    ? `${message}: apply the org.sonarqube plugin, see ${GRADLE_PLUGIN_GUIDE}`
    : `${message}: check that sonar.skip is not set`
}
