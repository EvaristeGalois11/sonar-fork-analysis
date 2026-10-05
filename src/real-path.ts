import { lstatSync, realpathSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

// Where the system, and the scanner with it, really lands. Node's own realpathSync applies a '..'
// after a link to the link's path rather than its target, so a/up/../x is a/x to it even when up
// leads elsewhere.
export const realPath = realpathSync.native

function present(path: string): boolean {
  try {
    return lstatSync(path, { throwIfNoEntry: false }) !== undefined
  } catch {
    // On the way through a file, say.
    return false
  }
}

// Where a path lands once it exists: its deepest existing part resolved, the rest added, since
// what is made later is made as plain directories. Undefined when that part is a link to nowhere.
export function realLocation(path: string): string | undefined {
  let existing = path
  while (!present(existing)) existing = dirname(existing)
  try {
    return join(realPath(existing), relative(existing, path))
  } catch {
    return undefined
  }
}
