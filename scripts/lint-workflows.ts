// Validates the workflows and action definitions against GitHub's own schema. Unlike actionlint's,
// it follows what GitHub accepts today, and it covers action.yml files too.
//
// Usage: node scripts/lint-workflows.ts

import { readdirSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import type { TemplateParseResult } from '@actions/workflow-parser'

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
const { NoOperationTraceWriter, convertWorkflowTemplate, parseWorkflow } =
  await import('@actions/workflow-parser')
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

for (const path of workflows) {
  const result = parseWorkflow(
    { name: path, content: readFileSync(path, 'utf8') },
    trace
  )
  // Conversion checks what the schema cannot, e.g. needs: naming a job that does not exist.
  if (result.value) await convertWorkflowTemplate(result.context, result.value)
  report(path, result)
}
for (const path of actions) {
  report(
    path,
    parseAction({ name: path, content: readFileSync(path, 'utf8') }, trace)
  )
}

console.log(
  `${workflows.length} workflows and ${actions.length} actions checked${failed ? '' : ', no errors'}`
)
process.exit(failed ? 1 : 0)
