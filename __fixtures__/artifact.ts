import type * as artifact from '@actions/artifact'
import { jest } from '@jest/globals'

export const uploadArtifact =
  jest.fn<artifact.ArtifactClient['uploadArtifact']>()

export class DefaultArtifactClient {
  uploadArtifact = uploadArtifact
}
