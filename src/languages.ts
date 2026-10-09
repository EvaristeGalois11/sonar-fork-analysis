import { retry } from './retry.js'

// The languages whose analyzers the fixtures run under traps on both paths. Kubernetes and GitHub
// Actions files are YAML that iac classifies; the text and secrets scanners read whatever is indexed.
export const TESTED_LANGUAGES = [
  'java',
  'kotlin',
  'js',
  'ts',
  'css',
  'web',
  'xml',
  'yaml',
  'json',
  'docker',
  'kubernetes',
  'githubactions',
  'text',
  'secrets'
]

// No file of a checkout can match it: /dev/null has no children. A language given only this pattern
// detects no file, so the engine never loads its analyzer. It must not be empty: the engine then uses
// the language's own suffixes.
export const NO_FILE = 'file:/dev/null/never'

// The server the scanner will talk to, so the languages are the ones it detects files against.
export function languagesHost(
  hostUrl: string,
  buildArguments: string[]
): string {
  const argument = (key: string): string | undefined =>
    buildArguments
      .findLast((arg) => arg.startsWith(`-D${key}=`))
      ?.slice(`-D${key}=`.length)
  let host =
    argument('sonar.host.url') ||
    hostUrl ||
    process.env.SONAR_HOST_URL ||
    (argument('sonar.region') === 'us'
      ? 'https://sonarqube.us'
      : 'https://sonarcloud.io')
  while (host.endsWith('/')) host = host.slice(0, -1)
  return host
}

export async function serverLanguages(
  host: string,
  token: string
): Promise<string[]> {
  const response = await retry(async () => {
    const answer = await fetch(`${host}/api/languages/list?ps=0`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (answer.status >= 500)
      throw new Error(`${host} answered ${answer.status}`)
    return answer
  })
  if (!response.ok)
    throw new Error(
      `Could not get the server's languages: ${host} answered ${response.status}`
    )
  const { languages } = (await response.json()) as {
    languages?: { key?: unknown }[]
  }
  const keys = (languages ?? []).map(({ key }) => key)
  // Each key becomes part of a setting's name.
  if (
    keys.length === 0 ||
    !keys.every(
      (key): key is string => typeof key === 'string' && /^\w+$/.test(key)
    )
  )
    throw new Error(
      `Could not get the server's languages: ${host} listed none, or a name that is not a plain word`
    )
  return keys
}

export function untestedLanguages(languages: string[]): string[] {
  return languages.filter((language) => !TESTED_LANGUAGES.includes(language))
}
