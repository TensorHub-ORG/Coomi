/** vite.config.ts 的 coomi-react-runtime 插件提供的虚拟模块：内容是一段自包含的 React IIFE 源码。 */
declare module 'virtual:coomi-react-runtime' {
  const source: string
  export default source
}
