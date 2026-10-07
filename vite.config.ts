import { defineConfig } from 'vitest/config'

export default defineConfig({
  build: {
    // Bundle everything. The runner never runs npm install for dist/.
    ssr: true,
    target: 'node24',
    outDir: 'dist',
    sourcemap: true,
    // The bundled packages' licences require their notices to travel with the code.
    license: { fileName: 'licenses.md' },
    rolldownOptions: {
      // The action's main step and its post step. The post step runs even when the job is cancelled.
      input: { index: 'src/index.ts', post: 'src/post.ts' },
      output: { entryFileNames: '[name].js', chunkFileNames: 'shared.js' }
    }
  },
  ssr: { noExternal: true },
  test: {
    include: ['__tests__/**/*.test.ts'],
    setupFiles: ['__fixtures__/environment.ts'],
    clearMocks: true,
    coverage: {
      enabled: true,
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text', 'lcov', 'json-summary']
    }
  }
})
