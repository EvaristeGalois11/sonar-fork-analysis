import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectBuildTool } from '../src/build-tool.js'

function project(...files: string[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'build-tool-'))
  for (const file of files) writeFileSync(join(directory, file), '')
  return directory
}

describe('detectBuildTool', () => {
  it('prefers the Maven wrapper', () => {
    expect(detectBuildTool(project('pom.xml', 'mvnw'))).toEqual({ name: 'maven', executable: './mvnw' })
  })

  it('falls back to mvn without a wrapper', () => {
    expect(detectBuildTool(project('pom.xml'))).toEqual({ name: 'maven', executable: 'mvn' })
  })

  it('detects Gradle from a Kotlin settings file', () => {
    expect(detectBuildTool(project('settings.gradle.kts', 'gradlew'))).toEqual({ name: 'gradle', executable: './gradlew' })
  })

  it('asks for build-tool when both are present', () => {
    expect(() => detectBuildTool(project('pom.xml', 'build.gradle'))).toThrow(/set the build-tool input/)
  })

  it('uses the requested tool when both are present', () => {
    expect(detectBuildTool(project('pom.xml', 'build.gradle'), 'gradle').name).toBe('gradle')
  })

  it('points at working-directory when nothing is found', () => {
    expect(() => detectBuildTool(project('README.md'))).toThrow(/set the working-directory input/)
  })
})
