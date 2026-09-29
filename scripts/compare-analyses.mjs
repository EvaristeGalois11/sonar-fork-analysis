// Fails when two Sonar projects hold different results for the same code: the fixture analysed
// directly and through the fork path must look identical, or the fork path lost something.
//
// Usage: node scripts/compare-analyses.mjs <project key> <other project key>
// Environment: SONAR_TOKEN, SONAR_HOST_URL (default SonarQube Cloud), PULL_REQUEST (compare that pull
// request's analyses instead of the main branch's).
//
// Pull request analyses only keep issues on changed lines and list no files, so the comparison is
// complete on the main branch only.

const host = process.env.SONAR_HOST_URL || 'https://sonarcloud.io'
const pullRequest = process.env.PULL_REQUEST
const [first, second] = process.argv.slice(2)
if (!first || !second) {
  console.error('Usage: compare-analyses.mjs <project key> <other project key>')
  process.exit(2)
}

const METRICS = [
  'ncloc',
  'files',
  'classes',
  'functions',
  'complexity',
  'coverage',
  'line_coverage',
  'branch_coverage',
  'lines_to_cover',
  'uncovered_lines',
  'tests',
  'test_failures',
  'skipped_tests',
  'duplicated_lines',
  'bugs',
  'vulnerabilities',
  'code_smells',
  'security_hotspots'
]

async function api(path, parameters) {
  const url = new URL(path, host)
  for (const [name, value] of Object.entries(parameters))
    url.searchParams.set(name, value)
  const headers = process.env.SONAR_TOKEN
    ? { Authorization: `Bearer ${process.env.SONAR_TOKEN}` }
    : {}
  const response = await fetch(url, { headers })
  if (!response.ok) {
    throw new Error(
      `${url.pathname} answered ${response.status}: ${await response.text()}`
    )
  }
  return response.json()
}

// The analyses were submitted before this runs; the server may still be processing them.
async function processed(project) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const { queue } = await api('/api/ce/component', { component: project })
    if (queue.length === 0) return
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
  throw new Error(`${project} still has analyses waiting after 5 minutes`)
}

async function results(project) {
  const scope = pullRequest ? { pullRequest } : {}
  const { component } = await api('/api/measures/component', {
    component: project,
    metricKeys: METRICS.join(','),
    ...scope
  })
  const measures = component.measures
    .map((measure) => `${measure.metric} ${measure.value}`)
    .sort()
  const { issues } = await api('/api/issues/search', {
    // 'projects' is the one name SonarQube Cloud and SonarQube Server both accept.
    projects: project,
    resolved: 'false',
    ps: '500',
    ...scope
  })
  // Component keys are <project>:<path>; project-level issues carry the bare project key.
  const path = (key) =>
    key.includes(':') ? key.slice(key.indexOf(':') + 1) : ''
  const issueLines = issues
    .map(
      (issue) =>
        `${issue.rule} ${path(issue.component)}:${issue.line ?? '-'} ${issue.message}`
    )
    .sort()
  const { components } = await api('/api/measures/component_tree', {
    component: project,
    qualifiers: 'FIL,UTS',
    metricKeys: 'coverage',
    ps: '500',
    ...scope
  })
  const files = components
    .map(
      (file) =>
        `${file.path} ${file.measures.find((m) => m.metric === 'coverage')?.value ?? '-'}`
    )
    .sort()
  return { measures, issues: issueLines, files }
}

await Promise.all([processed(first), processed(second)])
const [expected, actual] = await Promise.all([results(first), results(second)])

let different = false
for (const kind of ['measures', 'issues', 'files']) {
  const missing = expected[kind].filter((line) => !actual[kind].includes(line))
  const extra = actual[kind].filter((line) => !expected[kind].includes(line))
  if (missing.length === 0 && extra.length === 0) {
    console.log(`${kind}: ${expected[kind].length} identical`)
    continue
  }
  different = true
  console.log(`${kind} differ:`)
  for (const line of missing) console.log(`  only in ${first}: ${line}`)
  for (const line of extra) console.log(`  only in ${second}: ${line}`)
}
process.exit(different ? 1 : 0)
