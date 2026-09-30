// See: https://rollupjs.org/introduction/

import commonjs from '@rollup/plugin-commonjs'
import json from '@rollup/plugin-json'
import nodeResolve from '@rollup/plugin-node-resolve'
import typescript from '@rollup/plugin-typescript'

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
    json()
  ]
}))

export default config
