// For what Windows doesn't have: file names it refuses, the executable bit.
export const posixIt = process.platform === 'win32' ? it.skip : it
