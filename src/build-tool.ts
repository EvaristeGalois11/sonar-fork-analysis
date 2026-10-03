import { accessSync, constants, existsSync } from 'node:fs'
import { join } from 'node:path'

export type BuildTool = {
  name: 'maven' | 'gradle' | 'scanner'
  // For the scanner, empty: there is no build to run, the action runs the scanner CLI.
  executable: string
  // Arguments that must precede the build's own, e.g. the wrapper script run through sh.
  prefix: string[]
}

const GRADLE_BUILD_FILES = [
  'settings.gradle.kts',
  'settings.gradle',
  'build.gradle.kts',
  'build.gradle'
]

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function detectBuildTool(
  directory: string,
  requested = 'auto'
): BuildTool {
  const maven = existsSync(join(directory, 'pom.xml'))
  const gradle = GRADLE_BUILD_FILES.some((file) =>
    existsSync(join(directory, file))
  )

  let name: BuildTool['name']
  if (
    requested === 'maven' ||
    requested === 'gradle' ||
    requested === 'scanner'
  ) {
    name = requested
  } else if (requested !== 'auto') {
    throw new Error(
      `Unknown build tool '${requested}', expected one of: auto, maven, gradle, scanner`
    )
  } else if (maven && gradle) {
    throw new Error(
      `Both Maven and Gradle build files found in '${directory}', set the build-tool input`
    )
  } else if (maven || gradle) {
    // A Java project's frontend is analysed with build-tool: scanner, under its own project key.
    name = maven ? 'maven' : 'gradle'
  } else if (
    existsSync(join(directory, 'sonar-project.properties')) ||
    // A Node project without its settings yet, which the action then warns about.
    existsSync(join(directory, 'package.json'))
  ) {
    name = 'scanner'
  } else {
    throw new Error(
      `No Maven or Gradle build, sonar-project.properties or package.json found in '${directory}', set the working-directory input`
    )
  }

  if (name === 'scanner') return { name, executable: '', prefix: [] }
  const wrapper = name === 'maven' ? 'mvnw' : 'gradlew'
  if (!existsSync(join(directory, wrapper))) {
    return { name, executable: name === 'maven' ? 'mvn' : 'gradle', prefix: [] }
  }
  // Wrappers committed from Windows often lack the executable bit.
  return isExecutable(join(directory, wrapper))
    ? { name, executable: `./${wrapper}`, prefix: [] }
    : { name, executable: 'sh', prefix: [wrapper] }
}
