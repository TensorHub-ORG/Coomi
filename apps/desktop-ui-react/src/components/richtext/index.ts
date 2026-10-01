/** 富内容渲染层的统一出口：Markdown 代码块与右侧栏预览页签都从这里取件。 */
export { CodeBlock } from './CodeBlock'
export { RichPreview } from './RichPreview'
export { detectRichBlock, KIND_EXT, KIND_LABEL, KIND_MIME, normalizeLang, stripMathShell } from './detect'
export type { RichDetection, RichKind } from './detect'
export { makeBlock, pickRichBlock, registerRichBlock, useRichStore } from './store'
export type { RichBlock } from './store'
export { copyText, downloadBlock, openBlockInNewWindow, saveBlockAsArtifact } from './actions'
/** 卡死防线相关的常量与开关：设置页可用 setRichSafeMode 接上「安全模式」。 */
export {
  HIGHLIGHT_MAX_CHARS, HIGHLIGHT_MAX_LINES, MATH_MAX_CHARS,
  MERMAID_MAX_CHARS, OVERSIZED_NOTE, RICH_BUDGET_MS, RICH_RECOGNIZE_MAX_CHARS,
  highlightAllowed, isOversized,
} from './limits'
export { isRichSafeMode, setRichSafeMode, subscribeRichSafeMode } from './safeMode'

/* ── 文件路径识别与文件预览 ──
   路径芯片（chat/FileChip）与右侧栏的文件预览器都从这里取件；
   注意 FilePreview 本体不在这里导出：它必须由使用方 lazy() 进来，挂在统一出口上会被主包吃进去。 */
export { filePathFromHref, fileLinkHref, remarkFilePaths, FILE_LINK_PREFIX } from './fileLink'
export {
  isAbsolutePathText, isHomePathText, joinRawPath, looksLikePath,
  normalizePath, resolvePath, scanPaths,
} from './filePath'
export type { PathSpan } from './filePath'
export { FILE_KIND_TITLE, filePreviewKind, formatBytes, isRichFileKind } from './fileTypes'
export type { FilePreviewKind } from './fileTypes'
export {
  copyFileAsArtifact, copyFilePath, fileRawUrl, formatSize, openFileWithSystem,
  readRawBuffer, revealFile, statSummary, useFilePeek, useFileStat, useFileStatStore,
  OversizedFileError,
} from './fileStore'
export type { FileStatEntry, FileStatState } from './fileStore'
