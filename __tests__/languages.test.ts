import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  TESTED_LANGUAGES,
  languagesHost,
  serverLanguages,
  untestedLanguages
} from '../src/languages.js'

const answer = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status })

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  delete process.env.SONAR_HOST_URL
})

describe('languagesHost', () => {
  it('asks the server the scanner talks to', () => {
    expect(languagesHost('', [])).toBe('https://sonarcloud.io')
    expect(languagesHost('', ['-Dsonar.region=us'])).toBe(
      'https://sonarqube.us'
    )
    process.env.SONAR_HOST_URL = 'https://env.example.com/'
    expect(languagesHost('', [])).toBe('https://env.example.com')
    expect(languagesHost('https://input.example.com', [])).toBe(
      'https://input.example.com'
    )
    // The scanner takes the last value it reads for a key.
    expect(
      languagesHost('https://input.example.com', [
        '-Dsonar.host.url=https://first.example.com',
        '-Dsonar.host.url=https://last.example.com//'
      ])
    ).toBe('https://last.example.com')
  })
})

describe('serverLanguages', () => {
  it('lists the language keys, asking with the token', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        answer({ languages: [{ key: 'java' }, { key: 'py' }] })
      )

    expect(await serverLanguages('https://sonar', 'token')).toEqual([
      'java',
      'py'
    ])
    expect(fetch).toHaveBeenCalledWith(
      'https://sonar/api/languages/list?ps=0',
      { headers: { Authorization: 'Bearer token' } }
    )
  })

  it('refuses at once when the server turns it down', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(answer({}, 401))

    await expect(serverLanguages('https://sonar', 'token')).rejects.toThrow(
      "Could not get the server's languages: https://sonar answered 401"
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('tries again when the server fails', async () => {
    vi.useFakeTimers()
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(answer({}, 503))
      .mockResolvedValueOnce(answer({ languages: [{ key: 'java' }] }))

    const languages = serverLanguages('https://sonar', 'token')
    await vi.runAllTimersAsync()

    expect(await languages).toEqual(['java'])
  })

  it.each([
    { languages: [] },
    {},
    { languages: [{ key: 'py' }, { key: 'x.y' }] },
    { languages: [{ key: 'py=1' }] },
    { languages: [{ key: 7 }] }
  ])('refuses an answer it cannot trust: %j', async (body) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer(body))

    await expect(serverLanguages('https://sonar', 'token')).rejects.toThrow(
      "Could not get the server's languages"
    )
  })
})

describe('untestedLanguages', () => {
  it('keeps every language but the tested ones', () => {
    expect(
      untestedLanguages(['java', 'py', 'ts', 'rust', 'secrets', 'terraform'])
    ).toEqual(['py', 'rust', 'terraform'])
    expect(untestedLanguages(TESTED_LANGUAGES)).toEqual([])
  })
})
