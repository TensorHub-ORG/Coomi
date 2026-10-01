/**
 * JS 侧动效常量：给 motion（LazyMotion + m）用，值与 styles/theme.css 的令牌**一一对应**。
 *
 * 为什么需要它：CSS 那套令牌（--ease-* / --motion-*）JS 读不到，同一个界面里
 * CSS 动画与 JS 动画就会各走各的节奏（芯片用 180ms easeOut、旁边的提示条用 200ms out-quint，
 * 眼睛看得出一前一后）。这里只放「值」，不放判断——开关（[data-motion=off] /
 * prefers-reduced-motion）一律走 lib/motionPref.ts 的 motionOn()，两边判据必须同一份。
 *
 * 三条规矩：
 *  ① 需要「过冲」的地方（芯片出现、工具完成勾、排队徽标、状态落定）一律用 SPRING_*，
 *    不用 tween + duration：spring 由物理量（stiffness / damping）推时长，被打断时能从
 *    当前速度接着走；tween 被打断只能从头补时间，看起来永远是「卡一下再重来」。
 *    CSS 侧的 --ease-spring = cubic-bezier(.34,1.56,.64,1) 只是它的降级近似（CSS 没有真 spring）。
 *  ② 进入用 EASE_OUT_QUINT、退出用 EASE_IN_QUAD，大面板（整页 / 对话框）用 SEC_PAGE 档。
 *  ③ 时长只取下面四个 SEC_*，别再在组件里写 0.15 / 180 这种裸数字。
 */
import type { Transition } from 'motion/react'

/** 进入曲线：与 --ease-out-quint 同值（motion 的 ease 接受 [x1, y1, x2, y2]）。 */
export const EASE_OUT_QUINT: [number, number, number, number] = [0.23, 1, 0.32, 1]
/** 退出曲线：与 --ease-in-quad 同值。 */
export const EASE_IN_QUAD: [number, number, number, number] = [0.55, 0.085, 0.68, 0.53]

/** 时长（秒）：对齐 --motion-instant / --motion-fast / --motion-base / --motion-page。 */
export const SEC_INSTANT = 0.09
export const SEC_FAST = 0.14
export const SEC_BASE = 0.2
export const SEC_PAGE = 0.24

/** 真弹性 · 快档：芯片、开关这类小东西。damping < 2√stiffness，落下时约 8% 过冲。 */
export const SPRING_SNAP: Transition = { type: 'spring', stiffness: 500, damping: 28, mass: 0.9 }
/** 真弹性 · 落定档：状态一变就「弹一下」（完成勾、排队徽标）。稍硬一点，连点也不糊。 */
export const SPRING_POP: Transition = { type: 'spring', stiffness: 520, damping: 30 }

/** 入场：8px 上浮 + 淡入（与 CSS 的 rise-soft / --animate-bar 同一手感）。 */
export const RISE_IN = { opacity: 0, y: 8 }
/** 入场终态。 */
export const RISE_SHOWN = { opacity: 1, y: 0 }
