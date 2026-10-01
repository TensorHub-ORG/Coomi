/**
 * 浏览器内 TSX/JSX 编译：用 sucrase 剥类型 + 转 JSX，产出能直接跑的普通 JS。
 *
 * 为什么是 sucrase 而不是 esbuild-wasm：
 *   - sucrase 是纯 JS、压缩后约 300KB，且只在「点了 React 预览」时才动态加载；
 *   - esbuild-wasm 光 wasm 就是 8MB 上下，为了一个预览入口把包撑大一个数量级，不划算。
 *
 * 编译前还会做一次「预览友好化」改写（见 rewriteForPreview）：
 * 沙箱帧里没有模块系统，裸 import 一定会失败，所以本文件把 react/react-dom 的 import
 * 改写成从全局常量取，对其它 import 直接丢弃并回报一条警告（不静默吞掉）。
 */

export interface CompileResult {
  /** 编译后的 JS（classic script 可直接执行）。 */
  code: string
  /** 展示在预览下方的警告（被忽略的 import 等）。 */
  warnings: string[]
  /** 注入的渲染引导：需要由父组件决定是否追加。 */
  bootstrap: string
}

const REACT_NAMED = /^\s*import\s+(?:React\s*,?\s*)?\{([^}]*)\}\s*from\s*['"]react['"]\s*;?\s*$/
const REACT_DEFAULT = /^\s*import\s+(?:React\s*,?|\*\s+as\s+React)\s*from\s*['"]react['"]\s*;?\s*$/
const REACT_NAMESPACE = /^\s*import\s+\*\s+as\s+(\w+)\s+from\s*['"]react['"]\s*;?\s*$/
const DOM_NAMED = /^\s*import\s+(?:ReactDOM\s*,?\s*)?\{([^}]*)\}\s*from\s*['"]react-dom(?:\/client)?['"]\s*;?\s*$/
const DOM_DEFAULT = /^\s*import\s+(?:ReactDOM\s*,?|\*\s+as\s+ReactDOM)\s*from\s*['"]react-dom(?:\/client)?['"]\s*;?\s*$/
const ANY_IMPORT = /^\s*import\s+(?:[^'"]*from\s*)?['"]([^'"]+)['"]\s*;?\s*$/
const EXPORT_DEFAULT_FN = /^(\s*)export\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)?/
const EXPORT_DEFAULT_CLASS = /^(\s*)export\s+default\s+class\s+([A-Za-z_$][\w$]*)?/
const EXPORT_DEFAULT_EXPR = /^(\s*)export\s+default\s+(.+?)\s*;?\s*$/
const EXPORT_PREFIX = /^(\s*)export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)/
const EXPORT_LIST = /^\s*export\s*\{[^}]*\}\s*;?\s*$/
const EXPORT_FROM = /^\s*export\s+(?:\*|\{[^}]*\})\s+from\s*['"][^'"]+['"]\s*;?\s*$/

/** 预览友好化改写：返回改写后的源码 + 警告 + 默认导出表达式名。 */
export function rewriteForPreview(source: string): { code: string; warnings: string[]; defaultName: string } {
  const warnings: string[] = []
  let defaultName = ''
  const out: string[] = []

  for (const raw of source.split('\n')) {
    const line = raw
    let match: RegExpExecArray | null

    if ((match = REACT_NAMED.exec(line))) {
      out.push('const {' + (match[1] ?? '') + '} = React;')
      continue
    }
    if (REACT_NAMESPACE.test(line) || REACT_DEFAULT.test(line)) continue // React 已是全局
    if ((match = DOM_NAMED.exec(line))) {
      out.push('const {' + (match[1] ?? '') + '} = ReactDOM;')
      continue
    }
    if (DOM_DEFAULT.test(line)) continue // ReactDOM 已是全局

    if (EXPORT_FROM.test(line) || EXPORT_LIST.test(line)) {
      warnings.push('已忽略重导出：' + line.trim())
      continue
    }
    if ((match = ANY_IMPORT.exec(line))) {
      warnings.push('预览不支持模块解析，已忽略 import：' + (match[1] ?? ''))
      continue
    }

    if ((match = EXPORT_DEFAULT_FN.exec(line)) || (match = EXPORT_DEFAULT_CLASS.exec(line))) {
      defaultName = match[2] ?? ''
      out.push((match[1] ?? '') + line.replace(/^\s*export\s+default\s+/, ''))
      continue
    }
    if ((match = EXPORT_DEFAULT_EXPR.exec(line))) {
      defaultName = '__PREVIEW_DEFAULT__'
      out.push('var __PREVIEW_DEFAULT__ = ' + (match[2] ?? '') + ';')
      continue
    }
    if (EXPORT_PREFIX.test(line)) {
      out.push(line.replace(/^(\s*)export\s+/, '$1'))
      continue
    }
    out.push(line)
  }

  return { code: out.join('\n'), warnings, defaultName }
}

/** 找根组件：显式默认导出 > 名字叫 App > 最后一个大写开头的组件声明。 */
export function pickRootComponent(code: string, defaultName: string): { expr: string; reason: string } | null {
  if (defaultName) return { expr: defaultName, reason: '默认导出 ' + defaultName }
  // 代码自己已经把东西挂上去了（例如 createRoot(...).render(...)）：不再注入引导，避免渲染两次。
  if (/createRoot\s*\(|ReactDOM\.render\s*\(/.test(code)) return null
  const names: string[] = []
  const fn = /(?:^|\n)\s*(?:async\s+)?function\s+([A-Z][\w$]*)\s*\(/g
  const arrow = /(?:^|\n)\s*(?:const|let|var)\s+([A-Z][\w$]*)\s*=\s*(?:\(|async|function|[A-Za-z_$][\w$]*\s*=>)/g
  const cls = /(?:^|\n)\s*class\s+([A-Z][\w$]*)\s+extends\s+(?:React\.)?(?:Pure)?Component/g
  for (const re of [fn, arrow, cls]) {
    let m: RegExpExecArray | null
    while ((m = re.exec(code))) names.push(m[1] ?? '')
  }
  const unique = names.filter((name) => name && name !== 'React' && name !== 'ReactDOM')
  if (!unique.length) return null
  const app = unique.findLast ? unique.findLast((name) => name === 'App') : unique.filter((n) => n === 'App').pop()
  if (app) return { expr: 'App', reason: '组件 App' }
  const last = unique[unique.length - 1] ?? ''
  return last ? { expr: last, reason: '最后一个组件 ' + last } : null
}

/** 主入口：TSX/JSX → 可在沙箱帧里直接执行的脚本。 */
export async function compileReactPreview(source: string): Promise<CompileResult> {
  const { transform } = await import('sucrase')
  const rewritten = rewriteForPreview(source)
  let code: string
  try {
    code = transform(rewritten.code, {
      transforms: ['typescript', 'jsx'],
      jsxRuntime: 'classic',
      jsxPragma: 'React.createElement',
      jsxFragmentPragma: 'React.Fragment',
      filePath: 'preview.tsx',
      // React 19 不再需要（也不该收到）__self / __source 这两个开发期属性：
      // production:true 让 sucrase 不再往 createElement 里塞它们，产出更小、也更贴近线上形态。
      production: true,
      disableESTransforms: true,
    }).code
  } catch (error) {
    throw new Error('编译失败：' + (error instanceof Error ? error.message : String(error)))
  }

  const root = pickRootComponent(code, rewritten.defaultName)
  const bootstrap = root
    ? '(function(){try{var C=' + root.expr + ';if(typeof C!=="function"&&typeof C!=="object")throw new Error("根组件不是组件");'
      + 'ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(C))}'
      + 'catch(e){console.error("渲染失败："+(e&&e.message||e))}})();'
    : ''

  return { code, warnings: rewritten.warnings, bootstrap }
}
