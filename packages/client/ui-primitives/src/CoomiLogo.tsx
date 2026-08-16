// Coomi brand mark: the coomi-agent.png tile. Ink-independent raster so the
// same white-and-blue tile reads on both light and dark surfaces.

import { COOMI_AGENT_DATA_URI } from './coomi-mark.ts'
import type { IconProps } from './icons/props.ts'

/**
 * Render the Coomi agent mark as an inline image.
 * @param props.size - tile side in px (default 24).
 * @param props.className - extra class for layout placement.
 * @returns the mark img (aria-hidden decorative brand art).
 */
export function CoomiLogo({ size = 24, className }: IconProps) {
  return (
    <img
      src={COOMI_AGENT_DATA_URI}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      className={className}
      draggable={false}
      style={{ display: 'block' }}
    />
  )
}