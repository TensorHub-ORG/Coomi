/**
 * 帮助中心：**左侧目录 + 右侧正文 + 顶部搜索**。
 *
 * 六篇正文放在 src/content/help/*.md，用 vite 的 ?raw 在**构建期**就地变成字符串：
 * 帮助内容因此不进任何网络请求、断网可看，也不需要在运行期做任何 IO 或解析。
 * 渲染复用对话那套 Markdown 管线（components/chat/Markdown，非流式＝整段一次性解析），
 * 帮助里不会出现流式正文，也就不会碰到「流式期间只画纯文本」那条口径。
 *
 * 搜索的口径：每次按键都要跑一遍，所以六篇的检索文本（标题 + 正文，大小写折叠）在模块
 * 加载时**只算一次**（INDEX），按键时只做 includes。命中后目录与正文一起收窄到命中的篇，
 * 右侧给出明确的命中数——搜不到东西时不留一片空白让人以为"搜索没反应"。
 *
 * 它由左侧导航栏（components/shell/Rail）打开，通过 Radix 的 Portal 渲染到 body 上：
 * 导航条本身只有 60px 宽、外层还带着 overflow:hidden 的面板，不 Portal 出去就会被裁掉。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import * as RadixDialog from '@radix-ui/react-dialog'
import { BookOpen, Search, X } from 'lucide-react'
import { Markdown } from '../components/chat/Markdown'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { cn } from '../lib/cn'
import { withDisplayName } from '../lib/stormProbe'

// ?raw：构建期就把文件内容变成这个模块的默认导出（字符串）。
import gettingStarted from '../content/help/getting-started.md?raw'
import featureMap from '../content/help/feature-map.md?raw'
import faq from '../content/help/faq.md?raw'
import shortcuts from '../content/help/shortcuts.md?raw'
import troubleshooting from '../content/help/troubleshooting.md?raw'
import privacy from '../content/help/privacy.md?raw'

interface HelpDoc {
  /** 与正文 H1 对应的稳定 id：目录项、正文锚点、测试选择器都用它。 */
  id: string
  /** 目录里的标题（正文里那份 H1 由 md 自己带，不重复渲染）。 */
  title: string
  /** 目录标题下面的一行摘要（取自正文第一段非标题行）。 */
  summary: string
  /** 检索文本：标题 + 正文，已折叠成小写。 */
  haystack: string
  body: string
}

/** 正文第一段非标题行 → 目录摘要（去掉 markdown 记号，截断到 48 字）。 */
function summaryOf(body: string): string {
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('|') || line.startsWith('>')) continue
    // 去掉行内记号：行内代码的反引号、粗体星号、斜体下划线、引用号与井号。
    return line.split('`').join('').replace(/[*_>#]/g, '').replace(/\s+/g, ' ').trim().slice(0, 48)
  }
  return ''
}

const DOCS: readonly HelpDoc[] = [
  { id: 'getting-started', title: '快速上手', body: gettingStarted },
  { id: 'feature-map', title: '功能地图', body: featureMap },
  { id: 'faq', title: '常见问题', body: faq },
  { id: 'shortcuts', title: '快捷键', body: shortcuts },
  { id: 'troubleshooting', title: '故障排查', body: troubleshooting },
  { id: 'privacy', title: '隐私与数据', body: privacy },
].map((doc) => ({
  ...doc,
  summary: summaryOf(doc.body),
  haystack: (doc.title + '\n' + doc.body).toLowerCase(),
}))

/** 某个词在一篇里出现几次（顺着 indexOf 走，不建正则、不切数组）。 */
function countHits(haystack: string, needle: string): number {
  let count = 0
  let at = haystack.indexOf(needle)
  while (at >= 0) {
    count += 1
    at = haystack.indexOf(needle, at + needle.length)
  }
  return count
}

export function HelpView({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(DOCS[0].id)
  const articleRef = useRef<HTMLDivElement | null>(null)
  const needle = query.trim().toLowerCase()

  /// 命中篇：空搜索词＝全部六篇。DOCS 是模块级常量（检索文本也已在模块加载时算好），
  /// 所以按键时这里只做一次 includes 过滤，不重扫全文。
  const matched = useMemo(
    () => (needle ? DOCS.filter((doc) => doc.haystack.includes(needle)) : DOCS),
    [needle],
  )
  /// 搜索时正文也只留命中的篇：文章里全是没命中的内容，等于搜索没生效。
  const shown = needle ? matched : DOCS
  /// 目录高亮：当前那一篇被搜索筛掉时，高亮落到第一个命中上（否则整列一个亮的都没有，
  /// 看起来像「选中丢了」）。
  const activeId = matched.some((doc) => doc.id === active) ? active : (matched[0]?.id ?? active)
  /// 关掉时把状态收干净：下次打开不该还留着上一次的搜索词（那会看起来像"没命中"）。
  useEffect(() => {
    if (open) return
    setQuery('')
    setActive(DOCS[0].id)
  }, [open])

  const jump = (id: string): void => {
    setActive(id)
    const target = articleRef.current?.querySelector<HTMLElement>('[data-help-doc="' + id + '"]')
    // 目录与正文共用一个滚动容器：scrollIntoView 会自己找最近的可滚动祖先，不用手算 offset。
    target?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  return (
    <RadixDialog.Root open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <RadixDialog.Portal>
        {/* 遮罩与对话框同一套（.dialog-scrim / .dialog-surface，见 styles/base.css）：
            帮助是一块"盖住整屏的大面板"，但仍然是浮层，进出的动效、Esc、焦点锁全走 Radix。 */}
        <RadixDialog.Overlay className='dialog-scrim fixed inset-0 z-40 bg-black/35' />
        <RadixDialog.Content
          data-help-center
          style={{ width: 'min(1180px, calc(100vw - 40px))', height: 'min(86vh, 880px)' }}
          className={cn(
            'dialog-surface fixed left-1/2 top-1/2 z-50 flex -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden',
            'rounded-lg border border-line bg-overlay shadow-elev-4',
          )}
        >
          <div className='flex min-w-0 items-center gap-3 border-b border-line-soft px-5 py-3'>
            <BookOpen size={16} className='shrink-0 text-primary' />
            <div className='min-w-0 flex-1'>
              <RadixDialog.Title className='text-15 font-semibold text-ink'>帮助中心</RadixDialog.Title>
              <RadixDialog.Description className='mt-0.5 text-11 text-ink-3'>
                快速上手 · 功能地图 · 常见问题 · 快捷键 · 故障排查 · 隐私与数据
              </RadixDialog.Description>
            </div>
            <div className='relative shrink-0'>
              <Search size={13} className='pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-4' />
              <Input
                autoFocus
                value={query}
                data-help-search
                aria-label='搜索帮助'
                placeholder='搜索帮助（Enter 跳到首个命中）'
                className='w-[280px] pl-7'
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  e.preventDefault()
                  const first = matched[0]
                  if (first) jump(first.id)
                }}
              />
            </div>
            <RadixDialog.Close asChild>
              <Button variant='ghost' size='icon-sm' aria-label='关闭帮助' className='shrink-0 text-ink-4 hover:text-ink'>
                <X size={14} />
              </Button>
            </RadixDialog.Close>
          </div>

          <div className='flex min-h-0 flex-1'>
            {/* 目录：命中时只列命中的篇，每项右边的数字是"这一篇里出现了几次"。 */}
            <nav data-help-toc className='flex w-[212px] shrink-0 flex-col gap-0.5 overflow-y-auto overscroll-contain border-r border-line-soft px-2 py-3'>
              <p className='px-2 pb-1 text-11 text-ink-4'>
                {needle ? '命中 ' + matched.length + ' / ' + DOCS.length + ' 篇' : '共 ' + DOCS.length + ' 篇'}
              </p>
              {matched.map((doc, i) => {
                const on = doc.id === activeId
                return (
                  <button
                    key={doc.id}
                    type='button'
                    onClick={() => jump(doc.id)}
                    aria-current={on ? 'true' : undefined}
                    className={cn(
                      'rounded-md px-2 py-1.5 text-left transition-colors duration-[var(--motion-fast)]',
                      on ? 'bg-selected text-ink' : 'text-ink-2 hover:bg-hover hover:text-ink',
                    )}
                  >
                    <span className='flex items-center gap-1.5'>
                      <span className='w-4 shrink-0 font-mono text-11 text-ink-4'>{i + 1}</span>
                      <span className='min-w-0 flex-1 truncate text-13'>{doc.title}</span>
                      {needle ? (
                        <span className='shrink-0 rounded bg-sunken px-1 font-mono text-10 text-ink-4'>
                          {countHits(doc.haystack, needle)}
                        </span>
                      ) : null}
                    </span>
                    <span className='mt-0.5 block pl-[22px] text-11 leading-[1.5] text-ink-4'>{doc.summary}</span>
                  </button>
                )
              })}
            </nav>

            {/* 正文：只有这一个滚动容器。每篇一个 section，锚点 id 与目录项一一对应。 */}
            <div
              ref={articleRef}
              data-help-body
              className='min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-7 py-5'
            >
              {shown.length === 0 ? (
                <div className='flex flex-col items-center justify-center gap-2 py-20 text-center'>
                  <Search size={22} className='text-ink-4' />
                  <p className='text-13 text-ink-2'>没有找到「{query.trim()}」</p>
                  <p className='max-w-[360px] text-12 leading-[1.6] text-ink-3'>
                    换个词试试：引擎、模型、技能、上下文、记忆、备份、快捷键都是这里的常用条目。
                  </p>
                  <Button variant='secondary' size='sm' onClick={() => setQuery('')}>清空搜索</Button>
                </div>
              ) : (
                shown.map((doc) => (
                  <section
                    key={doc.id}
                    data-help-doc={doc.id}
                    className='mb-7 border-b border-line-soft pb-7 last:mb-0 last:border-b-0 last:pb-0'
                  >
                    <Markdown text={doc.body} className='max-w-[760px]' />
                  </section>
                ))
              )}
            </div>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

/* #185 的报错栈里显示真名（生产构建会压掉函数名）。 */
withDisplayName(HelpView, 'HelpView')
