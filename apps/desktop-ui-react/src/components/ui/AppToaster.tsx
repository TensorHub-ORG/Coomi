import { useEffect, useState } from 'react'
import { Toaster } from 'sonner'

/** Portaled notifications use the same resolved theme as the application. */
export function AppToaster() {
  const read = () => document.documentElement.dataset.theme === 'dark' ? 'dark' as const : 'light' as const
  const [theme, setTheme] = useState(read)
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return <Toaster position='bottom-right' theme={theme} closeButton toastOptions={{ className: 'coomi-toast', closeButtonAriaLabel: '关闭提示' }} />
}
