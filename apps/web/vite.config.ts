import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'url'

export default defineConfig(({ mode }) => {
  const isProduction = mode === 'production'

  return {
    plugins: [vue()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    base: '/',
    // Keep development diagnostics available, but never ship console/debugger calls
    // in the WebView bundle embedded in release APKs.
    esbuild: isProduction ? { drop: ['console', 'debugger'] } : undefined,
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      minify: 'esbuild',
    },
  }
})
