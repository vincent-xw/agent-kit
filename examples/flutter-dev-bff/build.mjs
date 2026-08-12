/**
 * esbuild 打包配置：把 BFF 的所有 JS（含 workspace 包、hono、zod）打成一个单文件 CJS bundle。
 * node:* 模块全部 externalize。
 */
import { build } from 'esbuild'

const result = await build({
  entryPoints: ['dist/server.js'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: 'dist/server.bundle.cjs',
  external: ['node:*'],
  sourcemap: true,
  minify: false,
  logLevel: 'info',
})

console.log('Bundle 完成：dist/server.bundle.cjs')
