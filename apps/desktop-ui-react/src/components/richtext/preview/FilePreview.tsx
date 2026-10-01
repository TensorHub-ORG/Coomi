/**
 * 文件预览分发器：按扩展名挑预览实现，并把「重库」按需加载。
 *
 * 体积口径（需求里的「主包增量 ≤20KB」就靠这里守住）：
 *   · 本文件自己不 import 任何重库，只 import 类型判定与懒加载壳；
 *   · SheetJS（xlsx）/ Mammoth（docx）/ fflate（zip）全部写在下面几个 import() 里，
 *     只有**真正预览过这一类文件**才会被下载；
 *   · 所以主包（对话渲染路径）里一行相关代码都没有，PDF 与二进制预览更是纯本地实现。
 *
 * 「不可见时不解析」是每个子预览器各自实现的（useInView），分发器只负责挑实现。
 */
import { Suspense, lazy } from 'react'
import { FILE_KIND_TITLE, filePreviewKind } from '../fileTypes'
import { PreviewLoading } from './common'
import { FileInfoPanel } from './BinaryPreview'

const SheetPreview = lazy(() => import('./SheetPreview').then((m) => ({ default: m.SheetPreview })))
const ZipPreview = lazy(() => import('./ZipPreview').then((m) => ({ default: m.ZipPreview })))
const DocxPreview = lazy(() => import('./DocxPreview').then((m) => ({ default: m.DocxPreview })))
const PdfPreview = lazy(() => import('./PdfPreview').then((m) => ({ default: m.PdfPreview })))
const HtmlFilePreview = lazy(() => import('./HtmlFilePreview').then((m) => ({ default: m.HtmlFilePreview })))

export function FilePreview({ path, name }: {
  /** 绝对路径（右侧栏拿到的已经是解析完的绝对路径）。 */
  path: string
  /** 文件名：标题与导出用。 */
  name: string
}) {
  const kind = filePreviewKind(path || name)
  const loading = <PreviewLoading label={'加载' + FILE_KIND_TITLE[kind] + '器…'} />

  switch (kind) {
    case 'sheet':
      return <Lazy fallback={loading}><SheetPreview path={path} name={name} /></Lazy>
    case 'pdf':
      return <Lazy fallback={loading}><PdfPreview path={path} name={name} /></Lazy>
    case 'zip':
      return <Lazy fallback={loading}><ZipPreview path={path} name={name} /></Lazy>
    case 'docx':
      return <Lazy fallback={loading}><DocxPreview path={path} name={name} /></Lazy>
    case 'html':
      return <Lazy fallback={loading}><HtmlFilePreview path={path} name={name} /></Lazy>
    default:
      // 图片 / Markdown / 纯文本由 PreviewPanel 直接渲染（那几条路更轻），
      // 走到这里的只剩「认不出的二进制」：给文件信息 + 用系统打开。
      return <FileInfoPanel path={path} name={name} />
  }
}

/** 懒加载壳：把 React.lazy 的 Suspense 收敛到一个地方，免得每个分支各写一遍。 */
function Lazy({ fallback, children }: { fallback: React.ReactNode; children: React.ReactNode }) {
  return <Suspense fallback={fallback}>{children}</Suspense>
}
