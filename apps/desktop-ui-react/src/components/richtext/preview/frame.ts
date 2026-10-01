/**
 * 沙箱帧的协议层：生成 iframe 的 srcdoc，并定义父子之间的消息格式。
 *
 * 安全边界（四道，缺一不可）：
 *   1) sandbox='allow-scripts' —— 只给脚本权限，**不给 allow-same-origin**。
 *      帧内因此是「不透明源」：读不到父页面的 DOM / localStorage / cookie，父页面也读不到它；
 *      同时 allow-top-navigation 没给，帧内无法跳转顶层页面。
 *   2) meta CSP：default-src 'none' + connect-src 'none' + form-action 'none' + base-uri 'none'，
 *      联网（fetch/XHR/WebSocket/EventSource）、表单外发、外链资源全部被封死；
 *      只有 inline script/style 与 data:/blob: 图片放行 —— 预览本身就是本地内容。
 *   3) 帧内兜底脚本：拦 window.open、拦 a[target=_top|_parent|_blank] 与新窗口，拦表单提交。
 *   4) 父页面 5s 看门狗（见 SandboxFrame.tsx）：帧内死循环不会拖住主界面，超时可直接强制关闭。
 *
 * 这里不引入任何网络资源：React 运行时由 vite 在构建期从 node_modules 打成一段本地 IIFE 源码，
 * 以 inline <script> 注入，因此预览断网也能跑（也没有 CDN 可依赖）。
 */

export const FRAME_KEY = '__coomi_preview__'

/** 帧 → 父 的消息。 */
export interface FrameEvent {
  k: string
  token: string
  type: 'boot' | 'log' | 'error' | 'idle'
  level?: string
  text?: string
  at?: number
}

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug' | 'system'

export interface ConsoleEntry {
  id: number
  level: ConsoleLevel
  text: string
  at: number
}

export interface FrameDocOptions {
  token: string
  title?: string
  /** 注入到 <head> 末尾的原始 HTML（用户自己的 <style> 等）。 */
  headHtml?: string
  /** <body> 的原始 HTML：原样注入，里面的 <script> 会被正常执行。 */
  bodyHtml?: string
  /** 依序执行的内联脚本；module=true 时按 ES 模块注入（顶层 import/export 必须走这条）。 */
  scripts?: Array<{ code: string; module?: boolean }>
  /** 帧内 body 的额外样式（预览容器的留白）。 */
  bodyStyle?: string
}

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
].join('; ')

/** 内联脚本转义：代码里出现 </script 就会把宿主文档撕开，必须先打断它。 */
export function inlineScript(code: string, module = false): string {
  const safe = code.replace(/<\/script/gi, '<\\/script')
  return '<script' + (module ? ' type="module"' : '') + '>' + safe + '</script>'
}

/** 代码里是否含 ES 模块语法：有就必须按 module 注入，否则内联脚本直接语法报错。 */
export function hasModuleSyntax(code: string): boolean {
  return /^\s*(import|export)[\s{*'"]/m.test(code)
}

/** 父 → 帧：目前只有 ping（帧内目前不需要指令，刷新靠重建 iframe）。 */
export function framePing(win: Window | null, token: string): void {
  try { win?.postMessage({ k: FRAME_KEY, token, type: 'ping' }, '*') } catch { /* 帧已卸载 */ }
}

/** 帧内引导脚本：装 console 代理、错误捕获与跳转拦截，再把事件 postMessage 给父页面。 */
export function frameHarness(token: string): string {
  return '(function(){'
    + 'var KEY=' + JSON.stringify(FRAME_KEY) + ',TOKEN=' + JSON.stringify(token) + ',MAX=200,SENT=0;'
    + 'function send(type,level,text){if(SENT>MAX)return;SENT++;'
    + 'try{window.parent.postMessage({k:KEY,token:TOKEN,type:type,level:level||"",text:text||"",at:Date.now()},"*")}catch(e){}}'
    + 'function fmt(v,d){d=d||0;try{'
    + 'if(v===null)return "null";if(v===undefined)return "undefined";'
    + 'var t=typeof v;'
    + 'if(t==="string")return d?JSON.stringify(v):v;'
    + 'if(t==="number"||t==="boolean")return String(v);'
    + 'if(t==="bigint")return String(v)+"n";'
    + 'if(t==="function")return "ƒ "+(v.name||"anonymous")+"()";'
    + 'if(t==="symbol")return v.toString();'
    + 'if(v instanceof Error)return (v.name||"Error")+": "+v.message;'
    + 'if(typeof Element!=="undefined"&&v instanceof Element)return "<"+v.tagName.toLowerCase()+(v.id?"#"+v.id:"")+">";'
    + 'if(d>=2)return Array.isArray(v)?"[…]":"{…}";'
    + 'if(Array.isArray(v)){var head=v.slice(0,20).map(function(x){return fmt(x,d+1)}).join(", ");return "["+head+(v.length>20?", …("+v.length+")":"")+"]"}'
    + 'var ks=Object.keys(v);var body=ks.slice(0,20).map(function(k){return k+": "+fmt(v[k],d+1)}).join(", ");'
    + 'return "{ "+body+(ks.length>20?", …("+ks.length+")":"")+" }"'
    + '}catch(e){return "[无法序列化]"}}'
    + 'var levels=["log","info","warn","error","debug"];'
    + 'for(var i=0;i<levels.length;i++){(function(lv){var orig=console[lv];'
    + 'console[lv]=function(){var parts=[];for(var j=0;j<arguments.length;j++)parts.push(fmt(arguments[j]));'
    + 'send("log",lv,parts.join(" "));try{orig.apply(console,arguments)}catch(e){}}})(levels[i])}'
    + 'window.addEventListener("error",function(e){'
    + 'var where=e.filename?(" @ "+(e.lineno||0)+":"+(e.colno||0)):"";'
    + 'send("error","error",(e.message||"脚本错误")+where)});'
    + 'window.addEventListener("unhandledrejection",function(e){send("error","error","未处理的 Promise 拒绝："+fmt(e.reason))});'
    + 'window.open=function(){send("log","warn","已拦截 window.open：预览里不允许打开新窗口");return null};'
    + 'document.addEventListener("click",function(e){var el=e.target;'
    + 'while(el&&el.tagName!=="A")el=el.parentElement;if(!el)return;'
    + 'var href=el.getAttribute("href")||"",target=el.getAttribute("target")||"";'
    + 'if(target==="_top"||target==="_parent"||target==="_blank"||/^[a-z]+:/i.test(href)||href.charAt(0)==="/"){'
    + 'e.preventDefault();send("log","warn","已拦截预览里的跳转："+(href||"(空)"))}},true);'
    + 'document.addEventListener("submit",function(e){e.preventDefault();send("log","warn","已拦截表单提交：预览里不能外发数据")},true);'
    + 'send("boot");'
    // 心跳走 rAF + setTimeout 两条路：跨源（不透明源）iframe 里的 rAF 可能被节流，
    // 只靠它会出现「其实跑完了但被判超时」。两条都在同一个线程上，所以真死循环时一条都不会到。
    + 'var done=false;function idle(){if(done)return;done=true;send("idle")}'
    + 'window.addEventListener("load",function(){requestAnimationFrame(idle);setTimeout(idle,60)});'
    + '})();'
}

/** 组装 srcdoc。 */
export function buildFrameDocument(options: FrameDocOptions): string {
  const head = [frameHarness(options.token), options.headHtml ?? ''].join('')
  const scripts = (options.scripts ?? []).map((s) => inlineScript(s.code, s.module === true)).join('')
  const bodyStyle = options.bodyStyle ?? 'margin:0;padding:12px;font:13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;color:#111;background:#fff'
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="' + CSP + '">'
    + '<title>' + (options.title ?? 'Coomi 预览') + '</title>'
    + '<style>html,body{' + bodyStyle + '}img,svg,video{max-width:100%}</style>'
    + head
    + '</head><body>' + (options.bodyHtml ?? '') + scripts + '</body></html>'
}

/** 从完整的 HTML 文档里抽出 head / body 片段：抽不出来时整份当 body（照样能渲染）。 */
export function splitHtmlDocument(code: string): { headHtml: string; bodyHtml: string } {
  if (!/<html|<head|<body/i.test(code)) return { headHtml: '', bodyHtml: code }
  const head = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(code)
  const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(code)
  if (body) return { headHtml: head?.[1] ?? '', bodyHtml: body[1] ?? '' }
  // 有 <head> 没 <body>（或没有闭合标签）：head 之后的内容全部当 body 注入。
  if (head) return { headHtml: head[1] ?? '', bodyHtml: code.slice(head.index + head[0].length).replace(/<\/html>/i, '') }
  return { headHtml: '', bodyHtml: code.replace(/^[\s\S]*?<body[^>]*>/i, '') }
}
