import { build } from 'esbuild'
import { resolve } from 'node:path'

const { outputFiles } = await build({
  entryPoints: ['scripts/openai.test.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  alias: { '@shared': resolve('src/shared') }
})
await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`)
