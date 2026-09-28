import { readFileSync } from 'node:fs'
import { DEFAULTS, readInputs } from '../src/inputs.js'

function actionYmlDefaults(): Record<string, string> {
  const defaults: Record<string, string> = {}
  let input = ''
  for (const line of readFileSync('action.yml', 'utf8').split('\n')) {
    const name = line.match(/^ {2}([a-z-]+):\s*$/)
    if (name) input = name[1]
    const value = line.match(/^ {4}default: (.*)$/)
    if (value && input) defaults[input] = value[1].replace(/^'(.*)'$/, '$1')
  }
  return defaults
}

describe('readInputs', () => {
  const saved = { ...process.env }

  afterEach(() => {
    process.env = { ...saved }
  })

  it('falls back to the defaults for inputs passed as empty strings', () => {
    for (const name of Object.keys(DEFAULTS))
      process.env[`INPUT_${name.toUpperCase()}`] = ''
    const inputs = readInputs()
    expect(inputs.mode).toBe('auto')
    expect(inputs.workingDirectory).toBe('.')
    expect(inputs.buildTool).toBe('auto')
  })

  it('reads goals and arguments one per line', () => {
    process.env['INPUT_BUILD-GOALS'] = 'clean\n\n    \n verify \n'
    process.env['INPUT_BUILD-ARGUMENTS'] = '-Pci\n-Dfoo=bar baz'
    const inputs = readInputs()
    expect(inputs.buildGoals).toEqual(['clean', 'verify'])
    expect(inputs.buildArguments).toEqual(['-Pci', '-Dfoo=bar baz'])
  })
})

describe('DEFAULTS', () => {
  it('matches the defaults declared in action.yml, both ways', () => {
    const declared = Object.fromEntries(
      Object.entries(actionYmlDefaults()).filter(([, value]) => value !== '')
    )
    expect(DEFAULTS).toEqual(declared)
  })
})
