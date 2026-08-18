import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [vue()],
  // 站点发布到 BFF 根路径
  base: './',
  build: {
    outDir: resolve(__dirname, '..', 'dist-web'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // 开发期代理到 BFF，让前端可以直连 localhost:8787 的 API/SSE
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      '/v1': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
})