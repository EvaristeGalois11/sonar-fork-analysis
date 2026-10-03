// Fails when two Sonar projects hold different results for the same code: the fixture analysed
// directly and through the fork path must look identical, or the fork path lost something.
//
// Usage: node scripts/compare-analyses.ts <project key> <other project key>
// Environment: SONAR_TOKEN, SONAR_HOST_URL (default SonarQube Cloud), PULL_REQUEST (compare that pull
// request's analyses instead of the main branch's), COMMIT (wait until both analysed this commit).
//
// Pull request analyses only keep issues on changed lines, list only changed files and have no blame,
// so the comparison is complete on the main branch only.

let host = process.env.SONAR_HOST_URL || 'https://sonarcloud.io'
while (host.endsWith('/')) host = host.slice(0, -1)
const pullRequest = process.env.PULL_REQUEST
const commit = process.env.COMMIT
const [first, second] = process.argv.slice(2)
if (!first || !second) {
  console.error('Usage: compare-analyses.ts <project key> <other project key>')
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

type Measure = { metric: string; value?: string }
type Issue = { rule: string; component: string; line?: number; message: string }
type File = { key: string; path: string; measures: Measure[] }
type Paging = { paging: { total: number } }
type Analysed = { key?: string; isMain?: boolean; commit?: { sha: string } }
type Results = Record<'measures' | 'issues' | 'files' | 'blame', string[]>

const sleep = (seconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000))

async function api<T>(
  path: string,
  parameters: Record<string, string>
): Promise<T> {
  // Appended, not resolved: the host may carry a context path, e.g. https://example.com/sonar.
  const url = new URL(`${host}${path}`)
  for (const [name, value] of Object.entries(parameters))
    url.searchParams.set(name, value)
  const headers = process.env.SONAR_TOKEN
    ? { Authorization: `Bearer ${process.env.SONAR_TOKEN}` }
    : {}
  // Retries wait for each other, so the awaits are in the loop on purpose.
  for (let attempt = 1; ; attempt++) {
    let response: Response | undefined
    try {
      response = await fetch(url, { headers }) // NOSONAR
    } catch (error) {
      if (attempt === 3) throw error
    }
    if (response?.ok) return (await response.json()) as T // NOSONAR
    if (response && (response.status < 500 || attempt === 3)) {
      throw new Error(
        `${url.pathname} answered ${response.status}: ${await response.text()}` // NOSONAR
      )
    }
    await sleep(5) // NOSONAR
  }
}

// Code-unit order, the same on every machine, unlike localeCompare.
function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}

function complete<T>(items: T[], { paging }: Paging, what: string): T[] {
  if (paging.total > items.length)
    throw new Error(
      `Only ${items.length} of ${paging.total} ${what} fit on a page`
    )
  return items
}

// The commit behind the project's latest analysis of this pull request or of the main branch.
async function analysedCommit(project: string): Promise<string | undefined> {
  const found: Analysed | undefined = pullRequest
    ? (
        await api<{ pullRequests: Analysed[] }>(
          '/api/project_pull_requests/list',
          { project }
        )
      ).pullRequests.find((pull) => pull.key === pullRequest)
    : (
        await api<{ branches: Analysed[] }>('/api/project_branches/list', {
          project
        })
      ).branches.find((branch) => branch.isMain)
  return found?.commit?.sha
}

// The analyses were submitted before this runs, but the server may still be processing them, and a
// project's latest results may be older ones, e.g. when the fork path skipped its analysis.
async function processed(project: string): Promise<void> {
  // Polling: each attempt waits for the one before.
  for (let attempt = 0; attempt < 60; attempt++) {
    const { queue } = await api<{ queue: unknown[] }>('/api/ce/component', {
      component: project
    })
    if (
      queue.length === 0 &&
      (!commit || (await analysedCommit(project)) === commit) // NOSONAR
    )
      return
    await sleep(5) // NOSONAR
  }
  throw new Error(
    commit
      ? `${project} has no processed analysis of ${commit} after 5 minutes`
      : `${project} still has analyses waiting after 5 minutes`
  )
}

async function results(project: string): Promise<Results> {
  const scope: Record<string, string> = pullRequest ? { pullRequest } : {}
  const { component } = await api<{ component: { measures: Measure[] } }>(
    '/api/measures/component',
    {
      component: project,
      metricKeys: METRICS.join(','),
      ...scope
    }
  )
  const measures = component.measures.map(
    (measure) => `${measure.metric} ${measure.value}`
  )
  const issueSearch = await api<{ issues: Issue[] } & Paging>(
    '/api/issues/search',
    {
      // 'projects' is the one name SonarQube Cloud and SonarQube Server both accept.
      projects: project,
      resolved: 'false',
      ps: '500',
      ...scope
    }
  )
  // Component keys are <project>:<path>; project-level issues carry the bare project key.
  const path = (key: string): string =>
    key.startsWith(`${project}:`) ? key.slice(project.length + 1) : ''
  const issues = complete(issueSearch.issues, issueSearch, 'issues').map(
    (issue) =>
      `${issue.rule} ${path(issue.component)}:${issue.line ?? '-'} ${issue.message}`
  )
  const tree = await api<{ components: File[] } & Paging>(
    '/api/measures/component_tree',
    {
      component: project,
      qualifiers: 'FIL,UTS',
      metricKeys: 'coverage',
      ps: '500',
      ...scope
    }
  )
  const components = complete(tree.components, tree, 'files')
  const files = components.map(
    (file) =>
      `${file.path} ${file.measures.find((m) => m.metric === 'coverage')?.value ?? '-'}`
  )
  // Without history, e.g. from a shallow checkout, the scanner only warns and everything above still
  // matches. Commit ids only: blame also carries author emails, which don't belong in a public log.
  // SonarQube Cloud serves no blame for a pull request's files, which it lists when the pull request
  // changes them.
  const blame = await Promise.all(
    (pullRequest ? [] : components).map(async (file) => {
      const { scm } = await api<{ scm: [number, string, string, string][] }>(
        '/api/sources/scm',
        { key: file.key, ...scope }
      )
      const commits = [...new Set(scm.map((line) => line[3]))].sort(byCodeUnit)
      return `${file.path} ${commits.join(',') || '-'}`
    })
  )
  return { measures, issues, files, blame }
}

// Counts, not sets: two identical issues on one line against one is a difference.
function difference(from: string[], to: string[]): string[] {
  const left = new Map<string, number>()
  for (const line of to) left.set(line, (left.get(line) ?? 0) + 1)
  return from.filter((line) => {
    const count = left.get(line) ?? 0
    left.set(line, count - 1)
    return count <= 0
  })
}

await Promise.all([processed(first), processed(second)])
const [expected, actual] = await Promise.all([results(first), results(second)])

let different = false
for (const kind of ['measures', 'issues', 'files', 'blame'] as const) {
  const missing = difference(expected[kind], actual[kind]).sort(byCodeUnit)
  const extra = difference(actual[kind], expected[kind]).sort(byCodeUnit)
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
