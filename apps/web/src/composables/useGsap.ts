/**
 * GSAP 在 Vue 里的统一入口。
 *
 * 三个约定，避免动画变成性能与内存问题：
 * 1. 全部动效都跑在 gsap.context() 里，组件卸载时 revert()，不留悬挂的 tween；
 * 2. 尊重 prefers-reduced-motion —— 用户关掉动画时直接不注册，而不是跑一个「很快」的动画；
 * 3. 只动 transform / opacity，不动 top / width 这类会触发重排的属性
 *    （Android WebView 里重排的代价比合成高一个数量级，长列表会直接掉帧）。
 */
import { onBeforeUnmount, onMounted, type Ref } from 'vue'
import gsap from 'gsap'

/** 用户是否要求减少动效；WebView 里这个查询也支持。 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * 在组件的某个根元素里建立一个 GSAP 作用域。
 *
 * @param scope 作用域根元素，选择器只在这个子树里生效
 * @param setup 在作用域内创建动画；返回的 tween/timeline 由 context 统一管理
 * @param options.immediate 为 true 时在 onMounted 之前也不执行（默认即为挂载后执行）
 */
export function useGsapScope(
  scope: Ref<HTMLElement | null | undefined>,
  setup: (context: gsap.Context, element: HTMLElement) => void,
  options: { skipWhenReducedMotion?: boolean } = {},
): void {
  const { skipWhenReducedMotion = true } = options
  let context: gsap.Context | null = null

  onMounted(() => {
    if (skipWhenReducedMotion && prefersReducedMotion()) return
    const element = scope.value
    if (!element) return
    context = gsap.context(() => setup(context as gsap.Context, element), element)
  })

  onBeforeUnmount(() => {
    context?.revert()
    context = null
  })
}

/** 直接拿到 gsap，方便在事件回调里补一个即时动画。 */
export { gsap }
