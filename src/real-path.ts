import { realpathSync } from 'node:fs'

// Where the system, and the scanner with it, really lands. Node's own realpathSync applies a '..'
// after a link to the link's path rather than its target, so a/up/../x is a/x to it even when up
// leads elsewhere.
export const realPath = realpathSync.native
