// 仅在已结束的正文包含数学分隔符时加载，KaTeX 不增加空闲首页的启动负担。
import ReactMarkdown, { type Components, type UrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import type { PluggableList } from 'unified'
import { remarkFilePaths } from '../richtext/fileLink'
import 'katex/dist/katex.min.css'

interface MathNode {
  type: string
  position?: { start: { offset?: number } }
  data?: { hProperties?: { className?: string[] } }
  children?: MathNode[]
}

// 单行 $$公式$$ 也按块公式显示。只处理数学节点，代码里的美元符号保持原样。
function remarkDisplayMath() {
  return (tree: MathNode, file: { value: unknown }): void => {
    const source = String(file.value)
    const walk = (node: MathNode): void => {
      const start = node.position?.start.offset
      if (node.type === 'inlineMath' && start !== undefined && source.slice(start, start + 2) === '$$') {
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, className: ['language-math', 'math-display'] } }
      }
      node.children?.forEach(walk)
    }
    walk(tree)
  }
}

const REMARK_PLUGINS = [remarkGfm, remarkMath, remarkDisplayMath, remarkFilePaths]
const REHYPE_PLUGINS: PluggableList = [[rehypeKatex, {
  throwOnError: false, strict: 'ignore', trust: false, maxExpand: 1000, maxSize: 100,
}]]

export default function MathMarkdown({ text, components, urlTransform }: {
  text: string
  components: Components
  urlTransform: UrlTransform
}) {
  return <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={components} urlTransform={urlTransform}>{text}</ReactMarkdown>
}
