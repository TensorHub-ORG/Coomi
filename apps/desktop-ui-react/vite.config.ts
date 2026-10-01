import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/* ── 本地 React 运行时（给沙箱预览用）──
   富内容预览要在 iframe 里跑用户写的 TSX，需要一份 React/ReactDOM。
   React 19 起 node_modules 里已经没有 react/umd、react-dom/umd 这两份可以「拷贝到 public」的成品，
   所以这里在构建期用 esbuild 把 react + react-dom + react-dom/client 打成一个自包含 IIFE
   （执行后挂 window.React / window.ReactDOM），以虚拟模块 virtual:coomi-react-runtime 交给前端，
   再由预览把这段源码 inline 注进沙箱 iframe。

   为什么 inline 而不是给个 URL：预览 iframe 是 sandbox='allow-scripts' 的不透明源，
   跨源加载脚本在 Tauri 的资源协议下不可靠；inline 则完全不碰网络，断网也能预览。 */
const REACT_RUNTIME_ID = 'virtual:coomi-react-runtime'

function reactRuntimePlugin(): Plugin {
  let cached: string | null = null
  return {
    name: 'coomi-react-runtime',
    resolveId(id) {
      if (id === REACT_RUNTIME_ID) return '\0' + REACT_RUNTIME_ID
      return undefined
    },
    async load(id) {
      if (id !== '\0' + REACT_RUNTIME_ID) return undefined
      if (cached === null) {
        // 只跑一次；dev 与 build 共用同一条路径（首次预览时才会真正执行到这里）。
        const { build } = await import('esbuild')
        const entry = decodeURIComponent(new URL('./src/components/richtext/frame/runtime.ts', import.meta.url).pathname)
          .replace(/^\/([A-Za-z]:)/, '$1') // Windows 盘符前面的斜杠要去掉，esbuild 不认 /G:/...
        const result = await build({
          entryPoints: [entry],
          bundle: true,
          format: 'iife',
          minify: true,
          write: false,
          target: 'chrome120',
          legalComments: 'none',
          define: { 'process.env.NODE_ENV': '"production"' },
        })
        const file = result.outputFiles?.[0]
        if (!file) throw new Error('coomi-react-runtime: esbuild 没有产出内容')
        cached = file.text
      }
      // 作为字符串交给前端：这里不带 ?raw，直接返回一个默认导出的源码字符串。
      return 'export default ' + JSON.stringify(cached)
    },
  }
}

/* 依赖分包：把「每个页面都要、但半年也不会改」的库从主包里摘出去。
   不这么做的话首屏主包 = 应用代码 + react-dom + motion + virtuoso 全挤在一份 958KB 里，
   任何一次业务代码改动都会让整包 rehash，缓存整块失效。
   注意 matching 用**路径片段**而不是包名精确匹配：pnpm/npm 的嵌套 node_modules 里
   路径可能形如 node_modules/.pnpm/react-dom@19/node_modules/react-dom/...。
   返回 undefined 的模块交给 Vite 默认策略（页面级 chunk 由 import() 决定）。 */
function vendorChunk(id: string): string | undefined {
  if (!id.includes('node_modules')) return undefined
  // 路径归一化成 posix 再匹配，Windows 下的反斜杠不再需要转义两遍。
  const p = id.replace(/\\/g, '/')
  if (/(^|\/)node_modules\/(react|react-dom|scheduler)\//.test(p)) return 'vendor-react'
  if (/(^|\/)node_modules\/(motion|motion-dom|motion-utils|framer-motion)\//.test(p)) return 'vendor-motion'
  if (/(^|\/)node_modules\/react-virtuoso\//.test(p)) return 'vendor-virtuoso'
  if (/(^|\/)node_modules\/lucide-react\//.test(p)) return 'vendor-icons'
  return undefined
}

// Tauri 桌面壳：固定端口、禁用自动开浏览器、产物直接给壳用（相对路径）。
export default defineConfig({
  plugins: [react(), tailwindcss(), reactRuntimePlugin()],
  base: './',
  server: { port: 5273, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome120',
    rollupOptions: { output: { manualChunks: vendorChunk } },
  },
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
})
