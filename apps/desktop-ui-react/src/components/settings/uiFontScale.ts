/**
 * 界面字号三档（设置页「外观」分组里的那一格）。
 *
 * 为什么单开一个文件：
 *  · 档位值（1 / 1.08 / 1.18）要同时给「选项表」与「旧值归一」两处用，写在视图里会漂；
 *  · 「实际生效」仍然走既有的外观设置那一套 —— useUi.setFontScale() 把值写进
 *    document.documentElement 的 --ui-font-scale 并落 localStorage（键 coomi.fontScale），
 *    与主题 / 字体 / 密度同一条路，组件不各存一份、也不各写一套 DOM 写入。
 *
 * 默认档是「较大」(1.08)：theme.css 的 --ui-font-scale 默认值与 stores/ui.ts 的回落值
 * 都按 1.08，于是正文 12px→约 13px、13px→约 14px。
 *
 * 注：生效的默认值最终由 stores/ui.ts 决定（applyStoredAppearance 每次都把
 * localStorage 里的值写进 html 内联样式，内联样式会覆盖 theme.css 的默认值）。
 * 本文件只负责「选项与显示归一」，不改那一层。
 */

/** 单个档位：value 是写进 --ui-font-scale 的缩放系数（1 = 100%）。 */
export interface FontScaleOption {
  value: number
  label: string
}

/** 三档：标准 / 较大（默认）/ 最大。顺序即显示顺序。 */
export const UI_FONT_SCALES: readonly FontScaleOption[] = [
  { value: 1, label: '标准' },
  { value: 1.08, label: '较大' },
  { value: 1.18, label: '最大' },
]

/**
 * 旧版本存过 0.92 / 1.16 这类已不在档位里的值：归一到最近的档位。
 * 只影响「哪一档高亮」，**不改已落盘的数** —— 用户点一下别的档位才会重写。
 * 取「最近」而不是「四舍五入到某一档」：0.92 与 1 只差 0.08，显示成「标准」比显示成空档合理。
 */
export function nearestFontScale(value: number): number {
  if (!Number.isFinite(value)) return UI_FONT_SCALES[1].value
  let best = UI_FONT_SCALES[0].value
  let bestGap = Number.POSITIVE_INFINITY
  for (const option of UI_FONT_SCALES) {
    const gap = Math.abs(option.value - value)
    if (gap < bestGap) {
      bestGap = gap
      best = option.value
    }
  }
  return best
}
