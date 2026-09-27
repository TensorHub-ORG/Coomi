/// <reference types="vite/client" />

interface Window {
  __coomiHandleSystemBack?: () => boolean
  __coomiApplyAppearance?: (config: AppearanceConfig) => void
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
    /** 通知原生层任务运行状态（更新通知栏：执行中 / 已完成）。 */
    updateTaskStatus?(status: string): void
    /** 获取设备与 App 诊断信息（报错反馈使用，不含对话内容）。 */
    getDiagnostics?(): string
    /** 原生上报报错反馈（绕过 WebView CORS）：json 为反馈体，callbackId 用于异步回调。 */
    sendFeedback?(json: string, callbackId: string): void
    getThemeMode?(): string
    setThemeMode?(mode: string): void
    getDigitalLifeEnabled?(): boolean
    setDigitalLifeEnabled?(enabled: boolean): void
    getAppearanceConfig?(): string
    /** 当前安装的 versionCode（检查更新页对比用）。 */
    getAppVersionCode?(): number
    /** 下载并安装更新 APK（url 为 APK 直链，version 用于文件名/提示）。 */
    installApk?(url: string, version: string): void
  }
}

interface AppearanceConfig {
  customEnabled?: boolean
  colors?: Record<string, string>
  chatBackground?: boolean
  chatMask?: number
  revision?: number
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

declare module 'vue-virtual-scroller' {
  import type { DefineComponent } from 'vue'

  export const DynamicScroller: DefineComponent
  export const DynamicScrollerItem: DefineComponent
}
