import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'url'

export default defineConfig(({ mode }) => {
  const isProduction = mode === 'production'
  const dev = loadEnv(mode, process.cwd(), 'COOMI_DEV_')
  const engine = dev.COOMI_DEV_ENGINE || 'http://127.0.0.1:8765'
  const frontendPort = Number(dev.COOMI_DEV_PORT || 5173)

  return {
    plugins: [vue()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    base: '/',
    server: {
      host: '127.0.0.1',
      port: frontendPort,
      strictPort: true,
      proxy: {
        '/api': { target: engine, changeOrigin: true },
        '/ws/': {
          target: engine,
          changeOrigin: true,
          ws: true,
          configure(proxy) {
            proxy.on('proxyReqWs', (request, incoming, socket) => {
              const origin = incoming.headers.origin
              if (origin !== `http://127.0.0.1:${frontendPort}` && origin !== `http://localhost:${frontendPort}`) {
                socket.destroy()
                return
              }
              request.setHeader('Origin', engine)
            })
          },
        },
      },
    },
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
