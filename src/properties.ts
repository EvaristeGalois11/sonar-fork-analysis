// Parses the java.util.Properties format the Sonar plugins write their simulation dump in.
export function parseProperties(text: string): Map<string, string> {
  const properties = new Map<string, string>()
  const lines = text.split(/\r\n|\r|\n/)
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].replace(/^[ \t\f]+/, '')
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue
    // A line ending in an odd number of backslashes continues on the next one.
    while (/(^|[^\\])(\\\\)*\\$/.test(line) && i + 1 < lines.length) {
      line = line.slice(0, -1) + lines[++i].replace(/^[ \t\f]+/, '')
    }
    const [key, value] = splitEntry(line)
    properties.set(unescape(key), unescape(value))
  }
  return properties
}

function splitEntry(line: string): [string, string] {
  let i = 0
  while (i < line.length) {
    const c = line[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === '=' || c === ':' || c === ' ' || c === '\t' || c === '\f') break
    i++
  }
  const key = line.slice(0, i)
  let rest = line.slice(i).replace(/^[ \t\f]+/, '')
  if (rest.startsWith('=') || rest.startsWith(':'))
    rest = rest.slice(1).replace(/^[ \t\f]+/, '')
  return [key, rest]
}

const ESCAPES: Record<string, string> = { t: '\t', n: '\n', r: '\r', f: '\f' }

function unescape(text: string): string {
  return text.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, escaped: string) =>
    escaped.length === 5
      ? String.fromCodePoint(Number.parseInt(escaped.slice(1), 16))
      : (ESCAPES[escaped] ?? escaped)
  )
}
