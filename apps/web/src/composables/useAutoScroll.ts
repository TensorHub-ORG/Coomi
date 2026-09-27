import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

/**
 * 瀑布流跟随滚动。
 *
 * - 默认贴底：每次内容增长用 rAF 合并一次滚动，流式输出下不会一秒 setState 几十次；
 * - 用户往上滑超过阈值就脱离跟随（不再跟着往下跑），并露出「回到底部」；
 * - 重新滑到底部自动恢复跟随。
 */
const DETACH_PX = 40
const REATTACH_PX = 14
/** scrollTop 是小数，写进去再读回来可能差一点点。 */
const SAME_POS_PX = 2
/** 「回到底部」的平滑滚动期间不判定脱离 —— 那一路的 scroll 事件都是我们自己发的。 */
const SMOOTH_MS = 800

export function useAutoScroll(target: Ref<HTMLElement | null>) {
  const following = ref(true)
  let raf = 0
  /** 我们自己最后一次把 scrollTop 写成了多少。 */
  let pinnedTop = -1
  let suppressUntil = 0

  function distanceFromBottom(el: HTMLElement): number {
    return el.scrollHeight - el.scrollTop - el.clientHeight
  }

  /**
   * 只有 scrollTop 真的被别人动过，才算「用户往上滑了」。
   *
   * 内容自己长高的时候 scrollTop 不动、距底变大：只看距离会把长回答刷到一半
   * 误判成脱离跟随 —— 于是瀑布流卡在中间，剩下的字都在屏幕外面。
   */
  function onScroll() {
    const el = target.value
    if (!el) return
    const d = distanceFromBottom(el)
    if (following.value) {
      const moved = Math.abs(el.scrollTop - pinnedTop) > SAME_POS_PX
      if (moved && d > DETACH_PX && performance.now() >= suppressUntil) following.value = false
    } else if (d < REATTACH_PX) {
      following.value = true
    }
  }

  /** 内容变化后调用；只在跟随态生效。 */
  function follow() {
    if (!following.value) return
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      const el = target.value
      if (!el || !following.value) return
      el.scrollTop = el.scrollHeight
      pinnedTop = el.scrollTop
    })
  }

  function jumpToBottom() {
    const el = target.value
    if (!el) return
    following.value = true
    suppressUntil = performance.now() + SMOOTH_MS
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  onMounted(() => {
    target.value?.addEventListener('scroll', onScroll, { passive: true })
    follow()
  })

  onBeforeUnmount(() => {
    target.value?.removeEventListener('scroll', onScroll)
    if (raf) cancelAnimationFrame(raf)
  })

  return { following, follow, jumpToBottom }
}
