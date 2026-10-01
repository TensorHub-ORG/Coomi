/**
 * iframe 里的 React 运行时入口（**不参与应用打包**）。
 *
 * React 19 起，node_modules 里已经没有 react/umd 与 react-dom/umd 这两份可直接拷贝的 UMD 文件了，
 * 所以这里给出等价物：把 react + react-dom + react-dom/client 打成一个自包含 IIFE，
 * 执行后往 globalThis 上挂 React / ReactDOM / ReactDOMClient，行为和当年的 UMD 完全一致。
 *
 * 谁在打它：vite.config.ts 里的 `coomi-react-runtime` 插件（构建期用 esbuild 打成一段源码字符串），
 * 通过虚拟模块 virtual:coomi-react-runtime 交给前端，再由预览把这段源码 inline 注进沙箱 iframe。
 * 全程不碰网络，也不依赖任何 CDN。
 */
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'

const target = globalThis as unknown as Record<string, unknown>

target.React = React
// 合并成一份：预览代码里 ReactDOM.createRoot(...) 和 ReactDOM.render(...) 两种写法都能跑。
target.ReactDOM = { ...ReactDOM, ...ReactDOMClient }
target.ReactDOMClient = ReactDOMClient
