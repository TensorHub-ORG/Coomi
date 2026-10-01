/* ── 插件主题引擎：theme.json → <style data-plugin-theme> + 背景层 + 自定义 CSS + mascot 形象 + parts（v1.7）──
   主题引擎把插件声明的主题内容落进五处，卸载 / 切换时全部按标记摘掉、内置值原样回来：
   ① design tokens：一张 <style data-plugin-theme>，把 colors / radii / fonts 的 CSS 变量
      写进 :root 规则 —— 它永远排在内置样式之后，同样的变量由它收尾生效（浅色深色都覆盖）；
   ② 背景层：theme.background（v1.5）渲染一个 <div class='theme-bg'>（fixed inset-0、
      z-0、pointer-events-none，样式见 base.css），图片用 img + object-fit，
      渐变用 div + background-image，透明度 / 模糊由插件值以内联样式给出；
   ③ 自定义 CSS：theme.css（v1.5，string[]）逐条注入 <style data-plugin-css>（纯样式）；
   ④ mascot 形象（v1.6）：mascot.logo / avatar 直接换掉侧栏、空态 hero 与消息行助手头像的
      <img>（原 src 缓存进 dataset.themeOrig，卸载 / 清空恢复），mascot.composer 向 Composer
      输入框右侧的挂点注入一张图 —— 都经 convertFileSrc 转 asset://，见 applyMascot。
   ⑤ parts（v1.7）：theme.parts 把发送键 / 输入框 / 工具栏 / 侧栏 / 气泡的细节外观下发给
      React 组件 —— 引擎把它写成 <html> 上的 data-theme-part-* 自定义属性（见 applyParts），
      组件经 useThemeParts() 订阅读取并以内联样式 / 条件渲染落地，卸载 / 清空时还原。

   theme.json 的格式（与壳侧 / 文档同步）：
     { "name": "主题名",
       "colors": { "--surface": "#0b0f14", ... },
       "radii":  { "--r-md": "8px", ... },
       "fonts":  { "--font-sans": "...", ... },
       "background": { "image": "本地图片路径", "gradient": "linear-gradient(...)",
                       "fit": "cover|contain", "opacity": 0.85, "blur": 12 },
       "css": [ ".chat { margin: auto }" ] }
   键放行 --xxx 开头的自定义属性（CSS custom property 是惰性的，只有被 var() 引用才生效，
   所以不做白名单，只做键格式与 HTML 注入的轻防护）；值按「任意合法 CSS 值」透传。
   css 片段同样经 textContent 写入（不会被当 HTML 解析），再剥掉 </style 双保险。 */

import { useSyncExternalStore } from 'react'

export interface PluginThemeBackground {
  /** 本地图片路径（插件目录内的绝对路径；引擎在 Tauri 桌面端会自动转 asset://）。
      与 gradient 二选一，同时给时二者叠加（渐变在下、图片在上）。 */
  image?: string
  /** CSS 渐变串（如 "linear-gradient(180deg, #0b0f14, transparent)"）。 */
  gradient?: string
  /** 铺放方式：cover（默认，等比铺满裁剪）/ contain（完整放入，可能留白）。 */
  fit?: 'cover' | 'contain'
  /** 整层透明度 0–1（默认 1）。 */
  opacity?: number
  /** 高斯模糊半径（px，上限 100 —— 全屏大模糊极耗 GPU，必须封顶）。 */
  blur?: number
}

/** mascot 形象（v1.6）：给应用里几处固定出现品牌图的地方换上插件自己的图。
     logo / avatar 是「替换」：把挂点 <img> 的原 src 缓存进 dataset.themeOrig，
     卸载 / 清空时按缓存原样恢复；composer 是「注入」：向 Composer 内的
     [data-theme-composer-mascot] 挂点渲染一张图（空挂点不占位）。 */
export interface PluginThemeMascot {
  /** 品牌 logo：侧栏 logo 与空态 hero 的 logo（[data-theme-mascot="logo"]）。 */
  logo?: string
  /** 聊天助手默认头像：消息行助手头像（[data-theme-mascot="avatar"]）。 */
  avatar?: string
  /** Composer 输入框右侧的 mascot 图（[data-theme-composer-mascot] 挂点）。 */
  composer?: string
}

/* ── parts：组件细节外观（v1.7）──
   与 design tokens 不同，parts 管的是**具体部件**的观感 / 显隐（发送键文案图标、
   输入框圆角高度、工具栏按钮显隐、侧栏 logo 圆角与图标颜色、消息气泡圆角阴影）。
   引擎把 parts 摊平成 <html> 上的 data-theme-part-* 属性（键名见 applyParts），
   同时把结构化快照留在 module 级 activeParts 并广播变更事件 —— 组件用
   useThemeParts() 订阅，读到的就是当前生效的 parts 对象。 */

/** 发送键（composer.sendButton）：文案 / 图标 / 位置 / 主色强调。 */
export interface PluginThemeSendButton {
  /** 按钮文案（缺省是纯图标按钮，没有文字）。 */
  label?: string
  /** 自定义发送图标：本地图片路径（经 resolveImagePath 转 asset://）或 URL，替换默认 ↑ 图标。 */
  icon?: string
  /** 按钮位置：'left' 换到输入行左侧（缺省在工具栏右下角）。 */
  position?: 'left' | 'right'
  /** accent=true：发送键常驻 primary 主色样式（缺省随「有没有输入」走，空输入是灰钮）。 */
  accent?: boolean
}

/** 输入框（composer.input）：占位文案 / 圆角 / 最小高度。 */
export interface PluginThemeComposerInput {
  /** 占位文案（缺省用内置的「描述你的任务，Enter 发送…」）。 */
  placeholder?: string
  /** 输入框与容器的圆角（px）。 */
  radius?: number
  /** 输入框与容器的最小高度（px）。 */
  minHeight?: number
}

/** 工具栏（composer.toolbar）：各按钮显隐，缺省全部显示。 */
export interface PluginThemeComposerToolbar {
  /** 附件按钮显隐（缺省 true）。 */
  showAttach?: boolean
  /** 模型选择按钮显隐（缺省 true）。 */
  showModel?: boolean
  /** 技能按钮显隐（缺省 true）。 */
  showSearch?: boolean
}

export interface PluginThemeComposer {
  sendButton?: PluginThemeSendButton
  input?: PluginThemeComposerInput
  toolbar?: PluginThemeComposerToolbar
}

/** 侧栏（rail）：logo 圆角与导航图标颜色。 */
export interface PluginThemeRail {
  /** logo 圆角（px 或任意 CSS 值，缺省用内置 rounded-xl）。 */
  logoRadius?: string | number
  /** 导航图标颜色（CSS 颜色值；引擎经 CSS 变量 --rail-icon 下发，缺省用内置 ink-3）。 */
  iconColor?: string
}

/** 气泡（bubbles.user / bubbles.assistant）：圆角与阴影。 */
export interface PluginThemeBubbleStyle {
  /** 气泡圆角（px）。 */
  radius?: number
  /** 气泡阴影（任意合法 CSS box-shadow 值）。 */
  shadow?: string
}

export interface PluginThemeBubbles {
  user?: PluginThemeBubbleStyle
  assistant?: PluginThemeBubbleStyle
}

/** parts 总表：composer / rail / bubbles 三块，全部可选，没写的保持内置。 */
export interface PluginThemeParts {
  composer?: PluginThemeComposer
  rail?: PluginThemeRail
  bubbles?: PluginThemeBubbles
}

export interface PluginTheme {
  /** 主题显示名（可选）。 */
  name?: string
  /** 颜色令牌：design tokens v2 变量名（--surface-* / --ink-* / --line-* / --primary-* …）。 */
  colors?: Record<string, string>
  /** 圆角令牌（--r-xs … --r-2xl / --radius-*）。 */
  radii?: Record<string, string>
  /** 字体令牌（--font-sans / --font-mono …）。 */
  fonts?: Record<string, string>
  /** v1.5：背景层（.theme-bg，fixed 垫底，见 base.css）。 */
  background?: PluginThemeBackground
  /** v1.5：自定义 CSS 片段（纯样式；逐条注入 <style data-plugin-css>）。 */
  css?: string[]
  /** v1.6：mascot 形象挂点（logo / avatar 替换、composer 注入，见 PluginThemeMascot）。 */
  mascot?: PluginThemeMascot
  /** v1.7：部件细节外观（发送键 / 输入框 / 工具栏 / 侧栏 / 气泡，见 PluginThemeParts）。 */
  parts?: PluginThemeParts
}

/** style 元素的标记属性：卸载 / 切换时按它把上一张摘掉。 */
export const THEME_STYLE_ATTR = 'data-plugin-theme'
/** 自定义 CSS 片段的 style 标记（与令牌那张分开，卸载时各摘各的）。 */
export const THEME_CSS_ATTR = 'data-plugin-css'
/** 背景层容器的标记属性（querySelector 按它清场）。 */
export const THEME_BG_ATTR = 'data-plugin-theme-bg'
/** style / 背景层上的归属标记：当前内容来自哪个插件（排查用）。 */
const THEME_OWNER_ATTR = 'data-plugin-theme-owner'
/** <html> 上的当前插件主题标记（观测 / CSS 钩子）。 */
const THEME_DATASET_KEY = 'pluginTheme'
/** 背景层类名（base.css 提供定位与铺放样式）。 */
const THEME_BG_CLASS = 'theme-bg'
/** 背景成像层类名：图片（img）与渐变（div）共用一套铺满规则。 */
const THEME_LAYER_CLASS = 'theme-bg-layer'
/** 全屏背景的大模糊极耗 GPU：radius 封顶，防止插件一个数值把界面拖卡。 */
const THEME_BLUR_MAX = 100

/** logo / avatar 挂点的标记属性：引擎按它找 <img> 换上 mascot 图（卸载时恢复）。 */
export const MASCOT_LOGO_ATTR = 'data-theme-mascot'
/** Composer mascot 挂点容器的标记（空挂点零尺寸不占位，注入 img 后才出现）。 */
export const COMPOSER_MASCOT_ATTR = 'data-theme-composer-mascot'
/** 缓存「被替换前的 src」的 dataset 键（=== data-theme-orig，卸载 / 清空照它恢复）。 */
const MASCOT_ORIG_KEY = 'themeOrig'

/** 键格式：只放行 --xxx 形式的自定义属性名。 */
const TOKEN_KEY_RE = /^--[A-Za-z0-9][A-Za-z0-9_-]*$/

function sanitizeValue(value: string): string {
  // 文本经 textContent 写入、不会被当 HTML 解析，这里再剥掉 </style 只是双保险。
  return value.trim().replace(/<\/style/gi, '<\\/style')
}

/** 把插件声明的本地图片路径转成 WebView 能加载的地址：
    - http(s)/data:/blob:/asset:/file: 与 // 开头的原样透传（插件给的就是 URL）；
    - 其余当本地文件路径：Tauri 桌面端经 convertFileSrc 转 asset://（v2 全局在
      __TAURI__.core 下，兼容 v1 的 __TAURI__.convertFileSrc）；
    - 浏览器开发模式没有 Tauri 桥，原样返回路径（能不能显示由加载环境决定）。 */
export function resolveImagePath(path: string): string {
  if (/^(https?:|data:|blob:|asset:|file:|\/\/)/i.test(path)) return path
  const tauri = (window as unknown as {
    __TAURI__?: { convertFileSrc?: (p: string) => string; core?: { convertFileSrc?: (p: string) => string } }
  }).__TAURI__
  const convert = tauri?.core?.convertFileSrc ?? tauri?.convertFileSrc
  if (typeof convert === 'function') {
    try {
      return convert(path)
    } catch {
      // 转换失败就按原样路径给，不阻塞主题。
    }
  }
  return path
}

/** 把 theme.json 的三个分节拼成一条 :root 规则；没有可用键时返回空串。 */
export function buildPluginThemeCss(theme: PluginTheme | null | undefined): string {
  if (!theme) return ''
  const lines: string[] = []
  const pushSection = (section: Record<string, string> | undefined): void => {
    if (!section) return
    for (const [key, value] of Object.entries(section)) {
      const name = key.trim()
      if (!TOKEN_KEY_RE.test(name)) continue
      const val = sanitizeValue(value)
      if (!val) continue
      lines.push('  ' + name + ': ' + val + ';')
    }
  }
  pushSection(theme.colors)
  pushSection(theme.radii)
  pushSection(theme.fonts)
  return lines.length ? ':root {\n' + lines.join('\n') + '\n}' : ''
}

/** 背景层内容是否可用（image / gradient 至少有一个）。 */
function backgroundUsable(background: PluginThemeBackground | undefined | null): background is PluginThemeBackground {
  if (!background) return false
  return Boolean(
    (typeof background.image === 'string' && background.image.trim()) ||
    (typeof background.gradient === 'string' && background.gradient.trim()),
  )
}

/** 由插件的 background 字段构建 <div class="theme-bg"> 容器；
    没有可用内容（image / gradient 都空）时返回 null。 */
function buildBackgroundLayer(pluginId: string, background: PluginThemeBackground): HTMLElement | null {
  if (!backgroundUsable(background)) return null
  const image = typeof background.image === 'string' ? background.image.trim() : ''
  const gradient = typeof background.gradient === 'string' ? background.gradient.trim() : ''
  const fit = background.fit === 'contain' ? 'contain' : 'cover'
  const opacity = typeof background.opacity === 'number' && Number.isFinite(background.opacity)
    ? Math.min(1, Math.max(0, background.opacity))
    : 1
  const blur = typeof background.blur === 'number' && Number.isFinite(background.blur) && background.blur > 0
    ? Math.min(background.blur, THEME_BLUR_MAX)
    : 0

  const wrap = document.createElement('div')
  wrap.className = THEME_BG_CLASS
  wrap.setAttribute(THEME_BG_ATTR, '')
  wrap.setAttribute(THEME_OWNER_ATTR, pluginId)

  /** 每一层成像元素：透明度 / 模糊由插件值以内联样式给出（铺放规则见 base.css）。 */
  const finish = (element: HTMLElement): HTMLElement => {
    if (opacity < 1) element.style.opacity = String(opacity)
    if (blur > 0) element.style.filter = 'blur(' + blur + 'px)'
    return element
  }
  if (gradient) {
    const layer = document.createElement('div')
    layer.className = THEME_LAYER_CLASS
    layer.style.backgroundImage = gradient
    layer.style.backgroundSize = fit
    wrap.appendChild(finish(layer))
  }
  if (image) {
    const img = document.createElement('img')
    img.className = THEME_LAYER_CLASS
    img.alt = ''
    img.draggable = false
    img.decoding = 'async'
    img.src = resolveImagePath(image)
    img.style.objectFit = fit
    wrap.appendChild(finish(img))
  }
  return wrap
}

/** 摘掉当前插件主题（卸载 / 切回内置时调用）：移除令牌 style、自定义 CSS 的
    style、背景层后，内置样式与画布原样回来 —— 不需要记「被覆盖前的值」。 */
export function clearPluginTheme(): void {
  document.head.querySelectorAll('style[' + THEME_STYLE_ATTR + ']').forEach((el) => el.remove())
  document.head.querySelectorAll('style[' + THEME_CSS_ATTR + ']').forEach((el) => el.remove())
  document.body.querySelectorAll('[' + THEME_BG_ATTR + ']').forEach((el) => el.remove())
  // v1.6：mascot 挂点一并摘下（恢复原 src / 移除注入图）。
  clearMascot()
  // v1.7：parts 属性一并摘掉（组件经 useThemeParts 收到空快照，自动还原内置外观）。
  clearParts()
  delete document.documentElement.dataset[THEME_DATASET_KEY]
}

/* ── mascot 形象挂点（v1.6）── */

/** 当前生效的 mascot（module 级保存：挂点重挂载补偿的观察器也读它）。 */
let activeMascot: PluginThemeMascot | null = null
/** 当前 mascot 归属哪个插件（注入的 composer img 打 owner 标，排查用）。 */
let activeMascotOwner = ''
/** 挂点重挂载补偿：React 卸载 / 重挂会让换好的 <img> 回到默认图，观察器在挂点
    （重新）出现时按当前 mascot 补换一次。childList-only：换 src / 写 dataset 是
    属性变更，不会自我触发，天然无环。 */
let mascotObserver: MutationObserver | null = null

/** mascot 是否有可用内容（logo / avatar / composer 至少一个非空路径）。 */
export function mascotUsable(mascot: PluginThemeMascot | null | undefined): mascot is PluginThemeMascot {
  if (!mascot || typeof mascot !== 'object') return false
  return Boolean(
    (typeof mascot.logo === 'string' && mascot.logo.trim()) ||
    (typeof mascot.avatar === 'string' && mascot.avatar.trim()) ||
    (typeof mascot.composer === 'string' && mascot.composer.trim()),
  )
}

/** 取 mascot 某键的可用 src（本地路径经 resolveImagePath 转 asset://；空值返回 null）。 */
function mascotSrc(key: keyof PluginThemeMascot): string | null {
  const v = activeMascot?.[key]
  if (typeof v !== 'string' || !v.trim()) return null
  return resolveImagePath(v.trim())
}

/** 把一枚挂点 <img> 换成 mascot 图；已按当前主题换过（themeOrig 已在）的不再动，
    避免观察器 / 重复调用来回刷。 */
function swapMascotImg(el: Element, src: string): void {
  if (!(el instanceof HTMLImageElement)) return
  if (el.dataset[MASCOT_ORIG_KEY]) return
  el.dataset[MASCOT_ORIG_KEY] = el.src
  el.src = src
}

/** 恢复一枚挂点 <img> 的原始 src（按 themeOrig 缓存；没换过就什么都不做）。 */
function restoreMascotImg(el: Element): void {
  if (!(el instanceof HTMLImageElement)) return
  const orig = el.dataset[MASCOT_ORIG_KEY]
  if (!orig) return
  el.src = orig
  delete el.dataset[MASCOT_ORIG_KEY]
}

/** 把 mascot 图注入 composer 挂点（挂点里已有注入的 img 就不重复建）。 */
function hydrateComposerHost(host: Element, src: string): void {
  if (host instanceof HTMLImageElement) return
  if (host.querySelector('img[' + COMPOSER_MASCOT_ATTR + ']')) return
  const img = document.createElement('img')
  img.setAttribute(COMPOSER_MASCOT_ATTR, '')
  img.setAttribute(THEME_OWNER_ATTR, activeMascotOwner)
  img.alt = ''
  img.draggable = false
  img.decoding = 'async'
  img.src = src
  host.appendChild(img)
}

/** 在某个（可能是刚挂载的）子树里把当前 mascot 补到挂点上。 */
function applyMascotToTree(root: Element): void {
  const logoSrc = mascotSrc('logo')
  const avatarSrc = mascotSrc('avatar')
  const composerSrc = mascotSrc('composer')
  if (logoSrc) {
    if (root.matches('[' + MASCOT_LOGO_ATTR + '="logo"]')) swapMascotImg(root, logoSrc)
    root.querySelectorAll('[' + MASCOT_LOGO_ATTR + '="logo"]').forEach((el) => swapMascotImg(el, logoSrc))
  }
  if (avatarSrc) {
    if (root.matches('[' + MASCOT_LOGO_ATTR + '="avatar"]')) swapMascotImg(root, avatarSrc)
    root.querySelectorAll('[' + MASCOT_LOGO_ATTR + '="avatar"]').forEach((el) => swapMascotImg(el, avatarSrc))
  }
  if (composerSrc) {
    if (root.matches('[' + COMPOSER_MASCOT_ATTR + ']')) hydrateComposerHost(root, composerSrc)
    root.querySelectorAll('[' + COMPOSER_MASCOT_ATTR + ']').forEach((el) => hydrateComposerHost(el, composerSrc))
  }
}

function ensureMascotObserver(): void {
  if (mascotObserver || typeof MutationObserver === 'undefined') return
  const observer = new MutationObserver((records) => {
    if (!activeMascot) return
    for (const record of records) {
      if (record.type !== 'childList') continue
      for (const node of record.addedNodes) {
        if (node instanceof Element) applyMascotToTree(node)
      }
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })
  mascotObserver = observer
}

/** 摘掉 mascot 形象：logo / avatar 挂点按缓存的 themeOrig 恢复原 src，
    composer 挂点里注入的 img 移除（卸载 / 切回内置主题时调用）。 */
export function clearMascot(): void {
  activeMascot = null
  activeMascotOwner = ''
  document.querySelectorAll('[' + MASCOT_LOGO_ATTR + ']').forEach((el) => restoreMascotImg(el))
  document.querySelectorAll('img[' + COMPOSER_MASCOT_ATTR + ']').forEach((el) => el.remove())
}

/** 应用 mascot 形象（theme.json 的 mascot 字段，v1.6）：
    - logo：把 [data-theme-mascot="logo"] 的 <img>（侧栏 + 空态 hero）换成 mascot.logo；
    - avatar：同理换掉消息行助手头像 [data-theme-mascot="avatar"]；
    - composer：向 Composer 的 [data-theme-composer-mascot] 挂点注入一张图（空挂点不占位）。
    原 src 一律缓存进 dataset.themeOrig，clearMascot 时恢复；mascot 为空时等同清除。 */
export function applyMascot(pluginId: string, mascot: PluginThemeMascot | null | undefined): void {
  clearMascot()
  if (!mascotUsable(mascot)) return
  activeMascot = mascot
  activeMascotOwner = pluginId
  applyMascotToTree(document.body)
  ensureMascotObserver()
}

/** 应用插件主题：① 令牌 style（<style data-plugin-theme>）② 自定义 CSS 片段
    （<style data-plugin-css>，逐条注入）③ 背景层（.theme-bg）④ mascot 形象。
    theme 为空（没有任何可用内容）时等同清除。返回是否真的注入了内容。 */
export function applyPluginTheme(pluginId: string, theme: PluginTheme | null | undefined): boolean {
  clearPluginTheme()
  let injected = false

  const tokens = buildPluginThemeCss(theme)
  if (tokens) {
    const style = document.createElement('style')
    style.setAttribute(THEME_STYLE_ATTR, '')
    style.setAttribute(THEME_OWNER_ATTR, pluginId)
    style.textContent = tokens
    document.head.appendChild(style)
    injected = true
  }

  if (theme?.css) {
    for (const snippet of theme.css) {
      const text = sanitizeValue(snippet)
      if (!text) continue
      const style = document.createElement('style')
      style.setAttribute(THEME_CSS_ATTR, '')
      style.setAttribute(THEME_OWNER_ATTR, pluginId)
      style.textContent = text
      document.head.appendChild(style)
      injected = true
    }
  }

  if (backgroundUsable(theme?.background)) {
    const wrap = buildBackgroundLayer(pluginId, theme.background as PluginThemeBackground)
    if (wrap) {
      document.body.prepend(wrap)
      injected = true
    }
  }

  // v1.6：mascot 形象挂点 —— 独立于样式层，最后应用（清空时由 clearPluginTheme 一起恢复）。
  applyMascot(pluginId, theme?.mascot)
  if (mascotUsable(theme?.mascot)) injected = true

  // v1.7：parts 部件外观 —— 摊平成 <html> 上的 data-theme-part-* 属性 + 广播变更事件，
  // 清空时由 clearPluginTheme 一起摘掉（clearParts 恢复内置外观）。
  if (applyParts(theme?.parts)) injected = true

  if (injected) document.documentElement.dataset[THEME_DATASET_KEY] = pluginId
  return injected
}

/* ── parts 部件外观（v1.7）── */

/** parts 自定义属性的统一前缀：data-theme-part-*（挂在 <html> 上，CSS 钩子 / 排查用）。 */
export const PARTS_ATTR_PREFIX = 'data-theme-part'
/** parts 变更事件：applyParts / clearParts 都广播它，useThemeParts 据此重渲染。 */
export const PARTS_CHANGE_EVENT = 'coomi:theme-parts-change'

/** 当前生效的 parts（module 级快照：组件经 useThemeParts 订阅的就是它）。 */
let activeParts: PluginThemeParts | null = null

/** 完整属性名：data-theme-part-<key>。 */
function partsAttr(key: string): string {
  return PARTS_ATTR_PREFIX + '-' + key
}

/** parts 是否有可用内容（任何一节有值都算）。 */
export function partsUsable(parts: PluginThemeParts | null | undefined): parts is PluginThemeParts {
  if (!parts || typeof parts !== 'object') return false
  const s = parts.composer?.sendButton
  const i = parts.composer?.input
  const t = parts.composer?.toolbar
  return Boolean(
    s && (s.label !== undefined || s.icon !== undefined || s.position !== undefined || s.accent !== undefined) ||
    i && (i.placeholder !== undefined || i.radius !== undefined || i.minHeight !== undefined) ||
    t && (t.showAttach !== undefined || t.showModel !== undefined || t.showSearch !== undefined) ||
    parts.rail && (parts.rail.logoRadius !== undefined || parts.rail.iconColor !== undefined) ||
    parts.bubbles?.user && (parts.bubbles.user.radius !== undefined || parts.bubbles.user.shadow !== undefined) ||
    parts.bubbles?.assistant && (parts.bubbles.assistant.radius !== undefined || parts.bubbles.assistant.shadow !== undefined),
  )
}

/** 摘掉 parts：移除 <html> 上全部 data-theme-part-* 属性、清空快照并广播事件
    （组件收到空快照后自动还原内置外观；卸载 / 切回内置主题时调用）。 */
export function clearParts(): void {
  const root = document.documentElement
  const doomed: string[] = []
  for (const attr of Array.from(root.attributes)) {
    if (attr.name.startsWith(PARTS_ATTR_PREFIX + '-')) doomed.push(attr.name)
  }
  doomed.forEach((name) => root.removeAttribute(name))
  activeParts = null
  window.dispatchEvent(new CustomEvent(PARTS_CHANGE_EVENT))
}

/** 把 parts 应用为 <html> 上的 data-theme-part-* 自定义属性（组件读取 / CSS 钩子），
    同时更新 module 级快照并广播变更事件。parts 为空（或任何键都是 undefined）时等同清除。
    返回是否真的写入了属性。 */
export function applyParts(parts: PluginThemeParts | null | undefined): boolean {
  clearParts()
  if (!parts || typeof parts !== 'object') return false
  const root = document.documentElement
  let applied = false
  /** 写一个属性：undefined / 空串跳过；布尔值写成 '1' / '0'。 */
  const set = (key: string, value: string | number | boolean | undefined): void => {
    if (value === undefined || value === null || value === '') return
    root.setAttribute(partsAttr(key), typeof value === 'boolean' ? (value ? '1' : '0') : String(value))
    applied = true
  }
  set('composer-send-label', parts.composer?.sendButton?.label)
  set('composer-send-icon', parts.composer?.sendButton?.icon)
  set('composer-send-position', parts.composer?.sendButton?.position)
  set('composer-send-accent', parts.composer?.sendButton?.accent)
  set('composer-input-placeholder', parts.composer?.input?.placeholder)
  set('composer-input-radius', parts.composer?.input?.radius)
  set('composer-input-minheight', parts.composer?.input?.minHeight)
  set('composer-toolbar-attach', parts.composer?.toolbar?.showAttach)
  set('composer-toolbar-model', parts.composer?.toolbar?.showModel)
  set('composer-toolbar-search', parts.composer?.toolbar?.showSearch)
  set('rail-logo-radius', parts.rail?.logoRadius)
  set('rail-icon-color', parts.rail?.iconColor)
  set('bubbles-user-radius', parts.bubbles?.user?.radius)
  set('bubbles-user-shadow', parts.bubbles?.user?.shadow)
  set('bubbles-assistant-radius', parts.bubbles?.assistant?.radius)
  set('bubbles-assistant-shadow', parts.bubbles?.assistant?.shadow)
  activeParts = parts
  if (applied) window.dispatchEvent(new CustomEvent(PARTS_CHANGE_EVENT))
  return applied
}

/** parts 变更事件订阅：useSyncExternalStore 的 subscribe（组件读快照用）。 */
function subscribeParts(onChange: () => void): () => void {
  window.addEventListener(PARTS_CHANGE_EVENT, onChange)
  return () => window.removeEventListener(PARTS_CHANGE_EVENT, onChange)
}

/** parts 当前快照（useSyncExternalStore 的 getSnapshot：identity 由 applyParts / clearParts 掌控）。 */
function getActiveParts(): PluginThemeParts | null {
  return activeParts
}

/** React 钩子：订阅当前生效的 theme.parts（applyParts / clearParts 触发重渲染）。
    返回 null 表示没有 parts 在生效，组件按内置外观渲染。 */
export function useThemeParts(): PluginThemeParts | null {
  return useSyncExternalStore(subscribeParts, getActiveParts)
}
