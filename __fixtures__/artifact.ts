import type * as artifact from '@actions/artifact'
import { jest } from '@jest/globals'

export const uploadArtifact =
  jest.fn<artifact.ArtifactClient['uploadArtifact']>()
export const getArtifact = jest.fn<artifact.ArtifactClient['getArtifact']>()
export const listArtifacts = jest.fn<artifact.ArtifactClient['listArtifacts']>()
export const downloadArtifact =
  jest.fn<artifact.ArtifactClient['downloadArtifact']>()

export class ArtifactNotFoundError extends Error {}
export class GHESNotSupportedError extends Error {}

export class DefaultArtifactClient {
  uploadArtifact = uploadArtifact
  getArtifact = getArtifact
  listArtifacts = listArtifacts
  downloadArtifact = downloadArtifact
}
