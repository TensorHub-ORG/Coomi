// 临时构建配置：生成单文件 index000.html（浏览器 F12 人工排查用）。
// 相对路径 + 不剔除 console + 合并动态导入 + 不压缩，保证 file:// 直开可读。
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'url'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  base: './',
  esbuild: undefined,
  build: {
    outDir: 'dist-single',
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        manualChunks: undefined,
      },
    },
  },
})
