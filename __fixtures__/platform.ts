// For what Windows doesn't have: file names it refuses, the executable bit.
export const posixIt = process.platform === 'win32' ? it.skip : it

// For file names that aren't valid UTF-8, which macOS refuses. NTFS holds them as lone surrogates.
export const invalidUtf8It = process.platform === 'darwin' ? it.skip : it
