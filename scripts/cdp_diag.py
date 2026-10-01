#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CDP 诊断：连接真机 WebView，输出页面布局诊断（视口、滚动容器、超宽元素）。"""
import json
import sys
import urllib.request

import websocket

WS = sys.argv[1] if len(sys.argv) > 1 else None


def get_json(url):
    with urllib.request.urlopen(url, timeout=5) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    if WS is None:
        pages = get_json("http://127.0.0.1:9222/json")
        for p in pages:
            print("PAGE:", p.get("type"), p.get("title"), p.get("url"))
            print("  WS:", p.get("webSocketDebuggerUrl"))
        if not pages:
            print("NO_PAGES")
            return
        ws_url = pages[0]["webSocketDebuggerUrl"]
    else:
        ws_url = WS

    ws = websocket.create_connection(ws_url, timeout=15, suppress_origin=True)
    mid = 0

    def cmd(method, params=None):
        nonlocal mid
        mid += 1
        ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(ws.recv())
            if msg.get("id") == mid:
                return msg.get("result", {})

    # 页面基础信息
    r = cmd("Runtime.evaluate", {
        "expression": """JSON.stringify({
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          dpr: window.devicePixelRatio,
          docClientWidth: document.documentElement.clientWidth,
          docScrollWidth: document.documentElement.scrollWidth,
          bodyScrollWidth: document.body.scrollWidth,
          bodyClientWidth: document.body.clientWidth,
          url: location.href,
          boxChecks: {
            innerBox: getComputedStyle(document.querySelector('.inner')).boxSizing,
            inputBox: getComputedStyle(document.querySelector('.input')).boxSizing,
            starRule: (() => { for (const s of document.styleSheets) { try { for (const r of s.cssRules) { if (r.selectorText === '*') return r.style.boxSizing + ' @ ' + s.href; } } catch (e) {} } return 'not-found'; })(),
            innerCssText: (() => { const el = document.querySelector('.inner'); if (!el) return ''; for (const s of document.styleSheets) { try { for (const r of s.cssRules) { if (r.selectorText && r.selectorText.includes('inner')) return r.cssText.slice(0, 260); } } catch (e) {} } return ''; })()
          },
          shell: (() => { const el = document.querySelector('.shell'); if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, transform: getComputedStyle(el).transform }; })(),
          stream: (() => { const el = document.querySelector('.stream'); if (!el) return null; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return { left: r.left, right: r.right, clientW: el.clientWidth, scrollW: el.scrollWidth, overflowX: s.overflowX, scrollbarW: el.offsetWidth - el.clientWidth }; })(),
          inner: (() => { const el = document.querySelector('.inner'); if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, clientW: el.clientWidth, scrollW: el.scrollWidth, pad: getComputedStyle(el).padding, box: getComputedStyle(el).boxSizing }; })(),
          wideEls: (() => { const out = []; document.querySelectorAll('*').forEach(el => { if (el.scrollWidth > el.clientWidth + 2) { const r = el.getBoundingClientRect(); out.push({ tag: el.tagName, cls: (el.className||'').toString().slice(0,60), clientW: el.clientWidth, scrollW: el.scrollWidth, left: Math.round(r.left), right: Math.round(r.right), overflowX: getComputedStyle(el).overflowX }); } }); return out.slice(0, 25); })(),
          bodyChildren: (() => { const el = document.querySelector('.chat'); if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, clientW: el.clientWidth }; })()
        })""",
        "returnByValue": True,
    })
    val = r.get("result", {}).get("value", "{}")
    data = json.loads(val)
    print(json.dumps(data, ensure_ascii=False, indent=2))
    ws.close()


if __name__ == "__main__":
    main()
