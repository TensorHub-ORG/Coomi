// Coomi wordmark: agent mark + COOMI letterforms in one inline row.

import type { CSSProperties } from 'react'
import { CoomiLogo } from './CoomiLogo.tsx'
import type { IconProps } from './icons/props.ts'

/**
 * Render the full Coomi wordmark (mark + "Coomi").
 * @param props.size - mark height in px (default 24); the wordmark row
 *   scales proportionally.
 * @param props.className - extra class for layout placement.
 * @returns the wordmark row (aria-hidden decorative brand art).
 */
export function CoomiWordmark({ size = 24, className }: IconProps) {
  const style: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: Math.round(size * 0.3),
    height: size,
    color: 'inherit',
  }
  return (
    <span className={className} style={style} aria-hidden="true">
      <CoomiLogo size={size} />
      <span
        style={{
          fontSize: Math.round(size * 0.62),
          fontWeight: 600,
          lineHeight: 1,
          letterSpacing: Math.round(size * 0.03),
          whiteSpace: 'nowrap',
        }}
      >
        Coomi
      </span>
    </span>
  )
}