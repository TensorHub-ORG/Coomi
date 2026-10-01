/**
 * Shiki 高亮器（从 chat/Markdown.tsx 原样搬过来，行为不变）：
 * 动态引入，语法文件静态列出 —— 用模板字符串会让 Vite 把 shiki 全部 40+ 种语言打进包（多出 7MB）。
 */
export type Highlighter = {
  codeToHtml: (code: string, opts: Record<string, unknown>) => string
  getLoadedLanguages: () => string[]
}

let hlPromise: Promise<Highlighter> | null = null

export function loadHighlighter(): Promise<Highlighter> {
  hlPromise ??= (async () => {
    const [{ createHighlighterCore }, { createOnigurumaEngine }] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/oniguruma'),
    ])
    const core = await createHighlighterCore({
      themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')],
      langs: [
        import('shiki/langs/javascript.mjs'), import('shiki/langs/typescript.mjs'),
        import('shiki/langs/tsx.mjs'), import('shiki/langs/jsx.mjs'),
        import('shiki/langs/json.mjs'), import('shiki/langs/bash.mjs'),
        import('shiki/langs/python.mjs'), import('shiki/langs/rust.mjs'),
        import('shiki/langs/go.mjs'), import('shiki/langs/java.mjs'),
        import('shiki/langs/c.mjs'), import('shiki/langs/cpp.mjs'),
        import('shiki/langs/html.mjs'), import('shiki/langs/css.mjs'),
        import('shiki/langs/markdown.mjs'), import('shiki/langs/yaml.mjs'),
        import('shiki/langs/sql.mjs'), import('shiki/langs/diff.mjs'),
        import('shiki/langs/powershell.mjs'), import('shiki/langs/mermaid.mjs'),
      ],
      engine: createOnigurumaEngine(import('shiki/wasm')),
    })
    return core as unknown as Highlighter
  })()
  return hlPromise
}
