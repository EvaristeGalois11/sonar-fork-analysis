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
  if (tool.name === 'scanner') {
    // The settings come from sonar-project.properties, not from a build, so the action runs after the
    // workflow's own build and test steps and only starts the scanner.
    if (goals.length > 0)
      throw new Error(
        'build-goals does not apply when the action runs the scanner: build and test in your own steps before the action'
      )
    return [...properties, ...buildArguments]
  }
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
    /Task 'sonar' (?:not found|is ambiguous)/.test(errorOutput)
  ) {
    return `The Gradle build has no 'sonar' task: apply the org.sonarqube plugin, see ${GRADLE_PLUGIN_GUIDE}`
  }
  if (tool.name === 'scanner')
    return `The Sonar scanner failed with exit code ${exitCode}`
  return `The ${TOOL_NAMES[tool.name]} build failed with exit code ${exitCode}`
}

export function missingAnalysis(tool: BuildTool): string {
  // The scanner CLI leaves a report whenever it succeeds, unless it wrote it elsewhere.
  if (tool.name === 'scanner')
    return 'The Sonar scanner succeeded but left no report in the working directory: check that sonar.projectBaseDir and sonar.working.directory stay inside it'
  const message = `The ${TOOL_NAMES[tool.name]} build succeeded but no Sonar analysis ran`
  // Gradle runs any single task whose name starts with 'sonar' when the plugin is missing.
  return tool.name === 'gradle'
    ? `${message}: apply the org.sonarqube plugin, see ${GRADLE_PLUGIN_GUIDE}`
    : `${message}: check that sonar.skip is not set`
}
