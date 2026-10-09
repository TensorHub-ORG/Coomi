/**
 * 首帧只画外壳：把「重内容」推到外壳画过之后再渲染。
 *
 *  为什么需要它：App 的切页正文是走 startTransition 挂的（App.tsx 的「先播动画再挂内容」），
 * 而 React 会把一整棵子树在**同一帧**里算完再提交 —— 设置页那种两百多个格子、
 * 每个 Segmented 还要各量一次几何的页面，这一帧就是一秒起步。
 * 在那之前屏幕上拿不到任何新内容，用户看到的就是「点了没反应，卡住一会儿才出界面」。
 *
 *  拆成「首帧画骨架 → 下一帧画正文」之后，点下去立刻有东西出现，
 * 重活挪到骨架之后的那一帧，视觉上读作「加载中」而不是「卡死」。
 *
 *  两条用法约定：
 *  ① 骨架必须是**同一个根 + 同样的外壳层**（页头 / 左列导航 / 滚动容器照常画）。
 *     外壳一换，切换那一帧的布局就会跳一下 —— 那比卡顿更难看。
 *  ② 它只推迟**渲染**，不推迟取数：各页的 effect 照旧从挂载那一刻起并行发请求，
 *     数据回来时正好赶上正文那一帧，不会白等一轮网络。
 */
import { useEffect, useState } from 'react'

/** 这一帧之前（false）只画外壳；画过一次之后（true）渲染真身。
 *
 *  用的是**双** rAF 而不是单个：单帧时外壳的布局与绘制可能还没提交，
 *  骨架与正文就落进了同一帧，拆分等于白做。多等一帧（约 16ms）换来一次真实的「先出壳、再填内容」。 */
export function useFirstFrame(): boolean {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let inner = 0
    const outer = window.requestAnimationFrame(() => {
      inner = window.requestAnimationFrame(() => setReady(true))
    })
    return () => {
      window.cancelAnimationFrame(outer)
      if (inner) window.cancelAnimationFrame(inner)
    }
  }, [])

  return ready
}
