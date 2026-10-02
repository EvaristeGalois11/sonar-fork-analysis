// Gets the real scanner, the CLI the action pins and the engines Sonar serves, and asks it questions
// through ScannerProbe.java, which calls its code directly.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { crc32, inflateRawSync } from 'node:zlib'
import { installScanner } from '../src/scanner.js'

export async function cliJar(): Promise<string> {
  const lib = join(dirname(dirname(await installScanner())), 'lib')
  const jar = readdirSync(lib).find((name) =>
    name.startsWith('sonar-scanner-cli-')
  ) as string
  return join(lib, jar)
}

// The engine SonarCloud hands the scanner today, checked against the digest it publishes.
export async function sonarCloudEngine(work: string): Promise<string> {
  const response = await fetch('https://api.sonarcloud.io/analysis/engine', {
    headers: { Accept: 'application/json' }
  })
  const { filename, sha256, downloadUrl } = (await response.json()) as {
    filename: string
    sha256: string
    downloadUrl: string
  }
  const path = join(work, filename)
  if (!existsSync(path))
    writeFileSync(
      path,
      Buffer.from(await (await fetch(downloadUrl)).arrayBuffer())
    )
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex')
  if (actual !== sha256)
    throw new Error(`${filename} has SHA-256 ${actual}, expected ${sha256}`)
  return path
}

// The engine of the latest SonarQube release, which a SonarQube server hands the scanner. Only that
// jar is read out of the distribution, nearly a gigabyte, with range requests. Sonar publishes no
// digest for the jar alone: HTTPS and the archive's CRC are the checks.
export async function sonarQubeEngine(work: string): Promise<string> {
  const latest = await fetch(
    'https://github.com/SonarSource/sonarqube/releases/latest',
    { redirect: 'manual' }
  )
  const version = (latest.headers.get('location') ?? '').split('/').pop()
  if (!version) throw new Error('No latest SonarQube release found')
  const url = `https://binaries.sonarsource.com/Distribution/sonarqube/sonarqube-${version}.zip`
  const range = async (start: number, end: number): Promise<Buffer> => {
    const response = await fetch(url, {
      headers: { Range: `bytes=${start}-${end}` }
    })
    if (response.status !== 206)
      throw new Error(`${url} answered ${response.status} to a range request`)
    return Buffer.from(await response.arrayBuffer())
  }

  // The central directory, found through its end record within the last 64 KiB.
  const size = Number(
    (await fetch(url, { method: 'HEAD' })).headers.get('content-length')
  )
  const tail = await range(Math.max(0, size - 65_557), size - 1)
  const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const directorySize = tail.readUInt32LE(end + 12)
  const directoryOffset = tail.readUInt32LE(end + 16)
  if (directoryOffset === 0xffffffff)
    throw new Error(`${url} is a ZIP64 archive, which is not read here`)
  const directory = await range(
    directoryOffset,
    directoryOffset + directorySize - 1
  )
  for (let at = 0; at < directory.length;) {
    const nameLength = directory.readUInt16LE(at + 28)
    const name = directory.toString('utf8', at + 46, at + 46 + nameLength)
    if (/\/lib\/scanner\/sonar-scanner-engine[^/]*\.jar$/.test(name)) {
      const path = join(work, name.split('/').pop() as string)
      if (!existsSync(path)) {
        const method = directory.readUInt16LE(at + 10)
        const crc = directory.readUInt32LE(at + 16)
        const compressed = directory.readUInt32LE(at + 20)
        const offset = directory.readUInt32LE(at + 42)
        const local = await range(offset, offset + 29)
        const data =
          offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
        const raw = await range(data, data + compressed - 1)
        const jar = method === 8 ? inflateRawSync(raw) : raw
        if (crc32(jar) !== crc) throw new Error(`${name} fails its CRC`)
        writeFileSync(path, jar)
      }
      return path
    }
    at +=
      46 +
      nameLength +
      directory.readUInt16LE(at + 30) +
      directory.readUInt16LE(at + 32)
  }
  throw new Error(`${url} holds no scanner engine`)
}

// Strings travel to and from Java as UTF-16 code units in hex, so nothing is lost on the way.
const hex = (text: string): string =>
  'x' +
  [...Array(text.length).keys()]
    .map((index) => text.charCodeAt(index).toString(16).padStart(4, '0'))
    .join('')

const unhex = (text: string): string =>
  String.fromCharCode(
    ...(text.slice(1).match(/.{4}/g) ?? []).map((unit) => parseInt(unit, 16))
  )

export type ModuleWalk = { refused?: string; modules: string[]; root: string[] }

export class Probe {
  constructor(private readonly jars: string[]) {}

  // Each settings file, read the way the CLI reads project.settings.
  readSettingsFiles(files: string[]): Map<string, string>[] {
    const directory = mkdtempSync(join(tmpdir(), 'probe-'))
    try {
      files.forEach((content, index) =>
        writeFileSync(
          join(directory, `${String(index).padStart(5, '0')}.properties`),
          content
        )
      )
      const read: Map<string, string>[] = []
      for (const [kind, key, value] of this.run('cli', directory)) {
        if (kind === 'file') read.push(new Map())
        else read[read.length - 1].set(unhex(key), unhex(value))
      }
      return read
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }

  // Each value, split the way the engine splits list settings.
  splitLists(values: string[]): string[][] {
    return this.withInput(values.map(hex), (input) =>
      // An entry is at least an x, so an empty field is only the space after the word.
      this.run('csv', input).map(([, ...entries]) =>
        entries.filter((entry) => entry !== '').map(unhex)
      )
    )
  }

  // Each set of settings, walked into modules the way the engine builds the project.
  walkModules(cases: Map<string, string>[]): ModuleWalk[] {
    const lines = cases.flatMap((settings) => [
      'case',
      ...[...settings].map(([key, value]) => `${hex(key)} ${hex(value)}`)
    ])
    return this.withInput(lines, (input) => {
      const walks: ModuleWalk[] = []
      for (const [kind, value] of this.run('modules', input)) {
        if (kind === 'case') walks.push({ modules: [], root: [] })
        const walk = walks[walks.length - 1]
        if (kind === 'refused') walk.refused = unhex(value)
        if (kind === 'module') walk.modules.push(unhex(value))
        if (kind === 'root') walk.root.push(unhex(value))
      }
      return walks
    })
  }

  // The classes of a jar that can start a process.
  processClasses(jar: string): string[] {
    return this.run('processes', jar).map(([, name]) => name)
  }

  private withInput<T>(lines: string[], use: (input: string) => T): T {
    const directory = mkdtempSync(join(tmpdir(), 'probe-'))
    try {
      const input = join(directory, 'input')
      writeFileSync(input, lines.join('\n'))
      return use(input)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }

  // The probe's lines start with a word saying what they are; anything else is the scanner logging.
  private run(mode: string, input: string): string[][] {
    return execFileSync(
      'java',
      [
        '-cp',
        this.jars.join(delimiter),
        resolve('__tests__/java/ScannerProbe.java'),
        mode,
        input
      ],
      { encoding: 'utf8', maxBuffer: 1 << 28 }
    )
      .split('\n')
      .filter((line) =>
        /^(file|entry|split|case|refused|module|root|class)( |$)/.test(line)
      )
      .map((line) => line.split(' '))
  }
}
