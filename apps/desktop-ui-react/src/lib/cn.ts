import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// Numeric typography tokens in theme.css are font sizes, not text colors.
const twMerge = extendTailwindMerge({
  extend: { theme: { text: ['10', '11', '12', '13', '14', '15', '16', '17', '18', '20', '22', '24', '28'] } },
})

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
