/**
 * 界面字号五档（设置页「外观」分组里的那一格）。
 *
 * 为什么单开一个文件：
 *  · 档位值（1 / 1.08 / 1.18 / 1.28 / 1.40）要同时给「选项表」与「旧值归一」两处用，
 *    写在视图里会漂；
 *  · 「实际生效」仍然走既有的外观设置那一套 —— useUi.setFontScale() 把值写进
 *    document.documentElement 的 --ui-font-scale 并落 localStorage（键 coomi.fontScale），
 *    与主题 / 字体 / 密度同一条路，组件不各存一份、也不各写一套 DOM 写入。
 *
 * 档位与「默认值」是两件事：默认值是 1.15（见 stores/ui.ts 的两处回落），
 * 它落在「较大」(1.08) 与「最大」(1.18) 之间，**不在下面这张表里** ——
 * 表只回答「用户能选哪几档」。设置页用 nearestFontScale 把 1.15 归到最近的 1.18 显示，
 * 用户点一下任一档位才会被改写成表里的值（不悄悄改用户已落盘的数）。
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

/** 五档：标准 / 稍大 / 大 / 更大 / 超大。顺序即显示顺序，标签必须**单调递增** ——
    之前 1.18 叫「最大」而后面还跟着「更大 / 超大」，读起来是错的。
    **默认档（1.18）必须在这张表里**：默认值若不是档位值，设置页的高亮会与实际字号对不上
    （nearestFontScale 只能选最接近的档，会显示成另一档）。 */
export const UI_FONT_SCALES: readonly FontScaleOption[] = [
  { value: 1, label: '标准' },
  { value: 1.08, label: '稍大' },
  { value: 1.18, label: '大' },
  { value: 1.28, label: '更大' },
  { value: 1.40, label: '超大' },
]

/**
 * 旧版本存过 0.92 / 1.16 这类已不在档位里的值：归一到最近的档位。
 * 只影响「哪一档高亮」，**不改已落盘的数** —— 用户点一下别的档位才会重写。
 * 取「最近」而不是「四舍五入到某一档」：0.92 与 1 只差 0.08，显示成「标准」比显示成空档合理。
 *
 * 非有限数的兜底取 UI_FONT_SCALES[1]＝「稍大」(1.08)：这是五档里偏保守的中间值。
 * 注意**默认档（1.18）本身也在表里** —— 兜底值必须是档位值，否则 Segmented 选不中任何一项。
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
