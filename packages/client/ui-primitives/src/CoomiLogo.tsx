// Coomi brand mark: the transparent coomi-agent.png raster. The white regions
// enclosed by the blue mark remain opaque on light and dark surfaces.

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
