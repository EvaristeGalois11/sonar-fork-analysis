import { existsSync } from 'node:fs'
import { join } from 'node:path'

export type BuildTool = {
  name: 'maven' | 'gradle'
  executable: string
}

const GRADLE_BUILD_FILES = ['settings.gradle.kts', 'settings.gradle', 'build.gradle.kts', 'build.gradle']

export function detectBuildTool(directory: string, requested = 'auto'): BuildTool {
  const maven = existsSync(join(directory, 'pom.xml'))
  const gradle = GRADLE_BUILD_FILES.some(file => existsSync(join(directory, file)))

  let name: BuildTool['name']
  if (requested === 'maven' || requested === 'gradle') {
    name = requested
  } else if (requested !== 'auto') {
    throw new Error(`Unknown build tool '${requested}', expected one of: auto, maven, gradle`)
  } else if (maven && gradle) {
    throw new Error(`Both Maven and Gradle build files found in '${directory}', set the build-tool input`)
  } else if (maven || gradle) {
    name = maven ? 'maven' : 'gradle'
  } else {
    throw new Error(`No Maven or Gradle build found in '${directory}', set the working-directory input`)
  }

  const wrapper = name === 'maven' ? 'mvnw' : 'gradlew'
  const executable = existsSync(join(directory, wrapper)) ? `./${wrapper}` : name === 'maven' ? 'mvn' : 'gradle'
  return { name, executable }
}
