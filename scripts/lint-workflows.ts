// Validates the workflows and action definitions against GitHub's own schema. Unlike actionlint's,
// it follows what GitHub accepts today, and it covers action.yml files too.
//
// Usage: node scripts/lint-workflows.ts

import { readdirSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import type { TemplateParseResult } from '@actions/workflow-parser'
import type { TemplateToken } from '@actions/workflow-parser/templates/tokens/template-token'

// The library imports its JSON schemas without the attribute Node requires, as it is built for
// bundlers (actions/languageservices#387), so this supplies it; the library must load afterwards.
registerHooks({
  load: (url, context, nextLoad) =>
    nextLoad(
      url,
      url.endsWith('.json')
        ? { ...context, importAttributes: { type: 'json' } }
        : context
    )
})
const {
  NoOperationTraceWriter,
  convertWorkflowTemplate,
  isMapping,
  isSequence,
  isString,
  parseWorkflow
} = await import('@actions/workflow-parser')
const { parseAction } =
  await import('@actions/workflow-parser/actions/action-parser')

const yaml = (name: string): boolean => /\.ya?ml$/.test(name)
const workflows = readdirSync('.github/workflows')
  .filter(yaml)
  .map((name) => join('.github/workflows', name))
const actions = [
  'action.yml',
  ...readdirSync('.github', { recursive: true, encoding: 'utf8' })
    .filter((path) => /(^|\/)action\.ya?ml$/.test(path))
    .map((path) => join('.github', path))
]

const trace = new NoOperationTraceWriter()
let failed = false

function report(path: string, result: TemplateParseResult): void {
  for (const error of result.context.errors.getErrors()) {
    // The message already names the file and position when the parser knows them.
    console.log(error.prefix ? error.message : `${path}: ${error.message}`)
    failed = true
  }
}

// The inputs of each action, by the `uses: $/…` reference that names it. Input names ignore case.
function reference(uses: string): string {
  let trimmed = uses
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1)
  return trimmed
}
const inputs = new Map<string, Set<string>>()
for (const path of actions) {
  const result = parseAction(
    { name: path, content: readFileSync(path, 'utf8') },
    trace
  )
  report(path, result)
  const declared =
    result.value && isMapping(result.value)
      ? result.value.find('inputs')
      : undefined
  const names = new Set<string>()
  if (declared && isMapping(declared))
    for (const { key } of declared) names.add(key.toString().toLowerCase())
  inputs.set(
    reference(`$/${dirname(path) === '.' ? '' : dirname(path)}`),
    names
  )
}

// actionlint checked the inputs of `./` steps against action.yml but cannot read `$/` ones, and the
// parser does not look at action inputs: a mistyped input would otherwise only warn at run time.
function checkInputs(path: string, token: TemplateToken): void {
  if (isSequence(token)) {
    for (const item of token) checkInputs(path, item)
    return
  }
  if (!isMapping(token)) return
  const uses = token.find('uses')
  const given = token.find('with')
  if (uses && isString(uses) && given && isMapping(given)) {
    const known = inputs.get(reference(uses.value))
    for (const { key } of known ? given : []) {
      if (known?.has(key.toString().toLowerCase())) continue
      const at = key.range?.start
      console.log(
        `${path} (Line: ${at?.line}, Col: ${at?.column}): ${uses.value} has no input '${key}'`
      )
      failed = true
    }
  }
  for (const { value } of token) checkInputs(path, value)
}

for (const path of workflows) {
  const result = parseWorkflow(
    { name: path, content: readFileSync(path, 'utf8') },
    trace
  )
  // Conversion checks what the schema cannot, e.g. needs: naming a job that does not exist.
  if (result.value) {
    await convertWorkflowTemplate(result.context, result.value)
    checkInputs(path, result.value)
  }
  report(path, result)
}

console.log(
  `${workflows.length} workflows and ${actions.length} actions checked${failed ? '' : ', no errors'}`
)
process.exit(failed ? 1 : 0)
