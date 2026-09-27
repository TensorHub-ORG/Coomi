/**
 * 界面演示模式。
 *
 * 引擎没起来（或者只想看界面）的时候，前端换一条脚本化的传输通道：假事件、
 * 真组件 —— 时间线、工具卡、授权弹层走的都是线上那条代码路径，不是另画一套。
 *
 * 两种打开方式：URL 带 ?demo=1，或设置页里的开关（存 localStorage）。
 * 不管哪种，界面上都必须有「演示」标记 —— 不能让人以为引擎真的在跑。
 */
const KEY = 'coomi.demo'

/** hash 路由会把 query 藏在 # 后面，所以两处都要找。 */
function param(name: string): string | null {
  const search = new URLSearchParams(location.search)
  if (search.has(name)) return search.get(name)
  const qi = location.hash.indexOf('?')
  if (qi >= 0) {
    const q = new URLSearchParams(location.hash.slice(qi + 1))
    if (q.has(name)) return q.get(name)
  }
  return null
}

function truthy(v: string | null): boolean {
  return v !== null && v !== '0' && v !== 'false' && v !== 'off'
}

let cached: boolean | null = null

export function isDemoMode(): boolean {
  if (cached !== null) return cached
  const fromUrl = param('demo')
  if (fromUrl !== null) cached = truthy(fromUrl)
  else {
    try { cached = localStorage.getItem(KEY) === '1' } catch { cached = false }
  }
  return cached
}

export function setDemoMode(on: boolean): void {
  try { localStorage.setItem(KEY, on ? '1' : '0') } catch { /* 隐私模式写不了，忽略 */ }
  cached = on
}

/** 演示模式默认自动播一轮，一进来就能看见瀑布流；?autoplay=0 关掉。 */
export function shouldAutoplay(): boolean {
  return isDemoMode() && truthy(param('autoplay') ?? '1')
}

/**
 * 无人值守演示（?auto=1）：授权和提问过一会儿自己替你答，整轮一直往下走。
 * 用来截图、录屏，或者把手机摆着自己演。默认关 —— 授权弹层本来就该等人点。
 */
export function isUnattended(): boolean {
  return isDemoMode() && truthy(param('auto'))
}

/** 自动播放用的那句话，同时也是空状态里的示例提问。 */
export const DEMO_PROMPT = '帮我看看 WebSocket 事件是怎么分发到界面上的，顺手把 tool_cache_hit 也接进状态栏'
