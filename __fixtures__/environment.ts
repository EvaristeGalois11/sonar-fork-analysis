// The runner's GITHUB_ variables describe the run executing the tests, its event among them, and must
// not reach the code under test: each test sets the ones it needs.
for (const name of Object.keys(process.env))
  if (name.startsWith('GITHUB_')) Reflect.deleteProperty(process.env, name)
