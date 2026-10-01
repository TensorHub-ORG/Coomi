#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CDP 深度诊断：找出 .inner 内把容器撑宽的具体子元素与内容。"""
import json
import urllib.request

import websocket


def get_json(url):
    with urllib.request.urlopen(url, timeout=5) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    pages = get_json("http://127.0.0.1:9222/json")
    ws_url = pages[0]["webSocketDebuggerUrl"]
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

    expr = r"""JSON.stringify((() => {
      const inner = document.querySelector('.inner');
      if (!inner) return { err: 'no .inner' };
      const out = [];
      const walk = (el, depth) => {
        if (depth > 4) return;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        out.push({
          depth,
          tag: el.tagName,
          cls: (typeof el.className === 'string' ? el.className : '').slice(0, 40),
          w: Math.round(r.width),
          left: Math.round(r.left),
          right: Math.round(r.right),
          scrollW: el.scrollWidth,
          clientW: el.clientWidth,
          whiteSpace: cs.whiteSpace,
          text: (el.textContent || '').trim().slice(0, 40).replace(/\n/g, '\\n'),
          childCount: el.children.length,
        });
        for (const c of el.children) walk(c, depth + 1);
      };
      // 只遍历最宽分支：先找直接子元素里 rect 最宽的
      const direct = [...inner.children].map(c => ({ el: c, r: c.getBoundingClientRect() }));
      direct.sort((a, b) => b.r.width - a.r.width);
      for (const d of direct.slice(0, 4)) walk(d.el, 1);
      return {
        innerW: inner.getBoundingClientRect().width,
        viewportW: window.innerWidth,
        widest: out.sort((a, b) => b.w - a.w).slice(0, 12),
      };
    })())"""
    r = cmd("Runtime.evaluate", {"expression": expr, "returnByValue": True})
    print(json.dumps(json.loads(r.get("result", {}).get("value", "{}")), ensure_ascii=False, indent=2))
    ws.close()


if __name__ == "__main__":
    main()
