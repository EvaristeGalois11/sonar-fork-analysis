import { vi } from 'vitest'
import type * as artifact from '@actions/artifact'

export const uploadArtifact = vi.fn<artifact.ArtifactClient['uploadArtifact']>()
export const getArtifact = vi.fn<artifact.ArtifactClient['getArtifact']>()
export const listArtifacts = vi.fn<artifact.ArtifactClient['listArtifacts']>()
export const downloadArtifact =
  vi.fn<artifact.ArtifactClient['downloadArtifact']>()

export class ArtifactNotFoundError extends Error {}
export class GHESNotSupportedError extends Error {}

export class DefaultArtifactClient {
  uploadArtifact = uploadArtifact
  getArtifact = getArtifact
  listArtifacts = listArtifacts
  downloadArtifact = downloadArtifact
}
