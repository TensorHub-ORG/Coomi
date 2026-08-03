/// <reference types="vite/client" />

interface Window {
  CoomiAndroid?: {
    openDashboard(): void
    importFiles?(): void
    importFilesForRequest?(requestId: string): void
    authorizeFolder?(): void
    exportFile?(path: string, suggestedName: string): void
    exportFileForRequest?(requestId: string, path: string, suggestedName: string): void
    openFile?(path: string): void
    /** 保存图片（data URL）到相册或下载目录。 */
    saveImageData?(dataUrl: string, fileName: string): void
  }
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}
