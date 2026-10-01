/**
 * Markdown 的组件映射表：块级样式、链接、行内代码、代码块都在这里。
 *
 * 为什么单独一个文件：它被两处共用 —— 真正渲染消息的 Markdown.tsx，以及
 * 冒烟脚本（scripts/smoke-incremental.mjs）里用来验证「增量切块渲染 == 一次性渲染」的渲染器。
 * 两边共用同一张表，冒烟比对的才是真实产物，而不是另写一套近似实现。
 *
 * 注意：这张表**不含 streaming 之类的易变状态**（那样每次流式都会换掉整棵子树的 props 身份，
 * memo 全部失效）。需要知道上下文的只有代码块，它从 MarkdownChunk 的 context 里现取；
 * 独立渲染（没有 Provider）时给一份安全的默认值：不流式、不是活动块。
 */
import { createContext, useContext } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ipc } from '../../lib/ipc'
import { cn } from '../../lib/cn'
import { CodeBlock } from '../richtext/CodeBlock'

/** 代码块在本次渲染里所处的上下文：是否流式、是不是那个还在长的活动块。 */
export interface MarkdownCodeContext {
  streaming: boolean
  isLive: (lang: string, code: string) => boolean
}

const DEFAULT_CODE_CONTEXT: MarkdownCodeContext = { streaming: false, isLive: () => false }

export const MarkdownCodeCtx = createContext<MarkdownCodeContext>(DEFAULT_CODE_CONTEXT)

/** 独立的 Markdown（不带切块、不带上下文）：右侧栏预览之类的一次性渲染用它。 */
export function markdownComponents(): Components {
  return COMPONENTS
}

const COMPONENTS: Components = {
  code({ className: cls, children, ...props }: any) {
    const ctx = useContext(MarkdownCodeCtx)
    const raw = String(children ?? '')
    const match = /language-([\w+-]+)/.exec(cls ?? '')
    if (!match && !raw.includes('\n')) {
      return <code className={cn('rounded bg-code px-1 py-0.5 font-mono text-[0.92em] text-code-fg', cls)} {...props}>{raw}</code>
    }
    // 代码块的识别 / 动作条 / 预览都在 richtext/CodeBlock 里；这里只负责把上下文（语言、是否流式、
    // 围栏是否闭合）传下去。isLive 为 true 表示这块还没闭合：流式期间只显示纯等宽文本，不做高亮。
    const code = raw.replace(/\n$/, '')
    const lang = match?.[1] ?? ''
    return (
      <CodeBlock
        code={code}
        lang={lang}
        streaming={ctx.streaming}
        live={ctx.isLive(lang, code)}
        origin='对话里的代码块'
      />
    )
  },
  pre({ children }: any) { return <>{children}</> },
  a({ href, children }) {
    return (
      <a
        href={href}
        className='text-primary underline-offset-2 hover:underline'
        onClick={(e) => { e.preventDefault(); if (href) void ipc('open_external', { url: String(href) }).catch(() => {}) }}
      >
        {children}
      </a>
    )
  },
  p({ children }) { return <p className='my-2 leading-[1.7]'>{children}</p> },
  ul({ children }) { return <ul className='my-2 list-disc space-y-1 pl-5'>{children}</ul> },
  ol({ children }) { return <ol className='my-2 list-decimal space-y-1 pl-5'>{children}</ol> },
  li({ children }) { return <li className='leading-[1.7]'>{children}</li> },
  h1({ children }) { return <h1 className='mt-4 mb-2 text-18 font-semibold'>{children}</h1> },
  h2({ children }) { return <h2 className='mt-4 mb-2 text-16 font-semibold'>{children}</h2> },
  h3({ children }) { return <h3 className='mt-3 mb-1.5 text-14 font-semibold'>{children}</h3> },
  blockquote({ children }) {
    return <blockquote className='my-2 border-l-2 border-line-strong pl-3 text-ink-2'>{children}</blockquote>
  },
  table({ children }) {
    return (
      <div className='my-3 overflow-x-auto rounded-lg border border-line'>
        <table className='w-full border-collapse text-12'>{children}</table>
      </div>
    )
  },
  th({ children }) { return <th className='border-b border-line bg-muted px-3 py-1.5 text-left font-medium'>{children}</th> },
  td({ children }) { return <td className='border-b border-line-soft px-3 py-1.5 align-top'>{children}</td> },
  hr() { return <hr className='my-4 border-line' /> },
}

export { ReactMarkdown, remarkGfm }
