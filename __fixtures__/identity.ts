import { lstatSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Where checks rest on identities rather than paths, no path resolution is involved: a test checking
// this way can't share a blind spot with the resolver under test.

function identity(stats: { dev: bigint; ino: bigint }): string {
  return `${String(stats.dev)}:${String(stats.ino)}`
}

// A directory and everything under it but links, found without following any.
export function identitiesUnder(
  directory: string,
  skip: (path: string) => boolean = () => false
): Set<string> {
  const found = new Set<string>()
  const visit = (path: string): void => {
    const stats = lstatSync(path, { bigint: true })
    if (stats.isSymbolicLink() || skip(path)) return
    found.add(identity(stats))
    if (stats.isDirectory())
      for (const name of readdirSync(path)) visit(join(path, name))
  }
  visit(directory)
  return found
}

// What the system reaches for a path, following links, or for its deepest existing ancestor when it
// doesn't exist; undefined when it can't be reached, e.g. through a loop of links.
export function landsOn(path: string): string | undefined {
  try {
    const stats = statSync(path, { bigint: true, throwIfNoEntry: false })
    if (stats) return identity(stats)
  } catch {
    return undefined
  }
  const parent = dirname(path)
  return parent === path ? undefined : landsOn(parent)
}
