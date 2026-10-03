// See: https://rollupjs.org/introduction/

import commonjs from '@rollup/plugin-commonjs'
import json from '@rollup/plugin-json'
import nodeResolve from '@rollup/plugin-node-resolve'
import typescript from '@rollup/plugin-typescript'
import license from 'rollup-plugin-license'

// Writes the licences of the packages bundled into an entry, which require their notices to travel
// with the code. The plugin learns what is bundled in renderChunk, where it also rewrites the chunk to
// add a banner; there is none here, so the rewrite is dropped: its map would bloat dist's threefold.
function licenses(entry) {
  const plugin = license({
    thirdParty: { output: { file: `dist/${entry}.licenses.txt` } }
  })
  return {
    ...plugin,
    renderChunk(...args) {
      plugin.renderChunk.apply(this, args)
      return null
    }
  }
}

// The action's main step, and its post step, which runs even when the job is cancelled.
const config = ['index', 'post'].map((entry) => ({
  input: `src/${entry}.ts`,
  output: {
    esModule: true,
    file: `dist/${entry}.js`,
    format: 'es',
    sourcemap: true
  },
  plugins: [
    typescript(),
    nodeResolve({ preferBuiltins: true }),
    commonjs(),
    // @actions/artifact imports its own package.json.
    json(),
    licenses(entry)
  ]
}))

export default config
