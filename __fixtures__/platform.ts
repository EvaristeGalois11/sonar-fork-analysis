// For what Windows doesn't have: file names it refuses, the executable bit, a '..' after a link that
// leads where the link does rather than back where the link sits.
export const posixIt = process.platform === 'win32' ? it.skip : it

// For file names that aren't valid UTF-8, which macOS refuses. NTFS holds them as lone surrogates.
export const invalidUtf8It = process.platform === 'darwin' ? it.skip : it

// For /proc.
export const linuxIt = process.platform === 'linux' ? it : it.skip
