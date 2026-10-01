/**
 * HTML / CSS / JS 预览：内容进沙箱 iframe（sandbox='allow-scripts'，不给 allow-same-origin）。
 *
 * - html：完整文档会被拆成 head / body 两段再注入（保留 <style> 与 <script>，注入的是原文，
 *   所以脚本照常执行）；片段则整段当 body。
 * - js：代码作为内联脚本注入；含 import/export 的代码自动按 <script type="module"> 注入，
 *   否则内联 classic script 会直接语法报错。
 * - css：光有样式没有 DOM 什么也看不到，所以套在一组常见元素（标题 / 段落 / 按钮 / 卡片 / 列表 /
 *   表单 / 表格）上做「样式试验台」，并在工具条上写明这是试验台而不是用户自己的页面。
 * 外部资源（外链脚本 / 样式 / 图片 / fetch）一律被 CSP 的 default-src 'none' 与 connect-src 'none' 拦掉，
 * 这正是「预览不联网」的保证。
 */
import { useMemo, useState } from 'react'
import { ExternalLink, RotateCcw, ShieldCheck } from 'lucide-react'
import { Button } from '../../ui/Button'
import { Tip } from '../../ui/Overlay'
import { SandboxFrame } from './SandboxFrame'
import { buildFrameDocument, hasModuleSyntax, splitHtmlDocument } from './frame'
import { openBlockInNewWindow } from '../actions'
import type { RichBlock } from '../store'

/** CSS 试验台：一组常见元素，用来观察样式效果（不是用户自己的页面，工具条上会写明）。 */
const CSS_LAB = [
  '<h1>标题一 H1</h1><h2>标题二 H2</h2>',
  '<p>正文段落：用来观察字号、行高、颜色与字间距。链接 <a href="#">示例链接</a> 也会跟着变。</p>',
  '<p><button>主要按钮</button> <button class="secondary">次要按钮</button></p>',
  '<div class="card"><strong>卡片标题</strong><p>卡片正文，观察边框、圆角、内边距与阴影。</p></div>',
  '<ul><li>列表项一</li><li>列表项二</li></ul>',
  '<form><label>输入框 <input value="示例文本" /></label> <label><input type="checkbox" checked /> 勾选项</label></form>',
  '<table><thead><tr><th>列 A</th><th>列 B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table>',
  '<pre><code>const demo = 1</code></pre>',
].join('')

export function HtmlPreview({ block }: { block: RichBlock }) {
  const [reload, setReload] = useState(0)
  // token 每次挂载换一次：父页面只认自己这一帧的消息，多个预览同时存在也不会串台。
  const token = useMemo(() => 'html-' + block.id + '-' + Math.random().toString(36).slice(2, 8), [block.id])

  const doc = useMemo(() => {
    if (block.kind === 'js') {
      return buildFrameDocument({
        token,
        title: 'JS 预览',
        scripts: [{ code: block.code, module: hasModuleSyntax(block.code) }],
      })
    }
    if (block.kind === 'css') {
      return buildFrameDocument({
        token,
        title: 'CSS 预览',
        // </style 必须打断，否则样式里的这个串会把宿主文档撕开。
        headHtml: '<style>' + block.code.replace(/<\/style/gi, '<\\/style') + '</style>',
        bodyHtml: CSS_LAB,
      })
    }
    const parts = splitHtmlDocument(block.code)
    return buildFrameDocument({
      token,
      title: 'HTML 预览',
      headHtml: parts.headHtml,
      bodyHtml: parts.bodyHtml,
    })
  }, [block.kind, block.code, token])

  return (
    <div className='flex min-h-0 min-w-0 flex-col'>
      <div className='flex items-center gap-1.5 border-b border-line px-2 py-1'>
        <Tip label='沙箱：allow-scripts，无同源、无联网、无顶层跳转'>
          <span className='flex items-center gap-1 text-11 text-ink-4'><ShieldCheck size={12} />沙箱预览</span>
        </Tip>
        {block.kind === 'css' ? <span className='text-11 text-ink-4'>样式试验台：把这段 CSS 套在一组常见元素上（不是你的页面）</span> : null}
        <div className='flex-1' />
        <Button variant='ghost' size='icon-sm' className='h-6 w-6' title='重新运行' onClick={() => setReload((v) => v + 1)}>
          <RotateCcw size={12} />
        </Button>
        <Button
          variant='ghost'
          size='icon-sm'
          className='h-6 w-6'
          title='在新窗口打开（独立文档，不受沙箱限制）'
          onClick={() => void openBlockInNewWindow(block)}
        >
          <ExternalLink size={12} />
        </Button>
      </div>
      <SandboxFrame doc={doc} token={token} title='HTML 预览' reloadSignal={reload} height={300} />
    </div>
  )
}
