#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地 Edge headless + CDP 复现移动端布局，验证 box-sizing 行为。"""
import json
import subprocess
import time
import urllib.request

import websocket

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
PORT = 9223
URL = "http://127.0.0.1:8088/#/"


def wait_pages(timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            pages = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json", timeout=3).read())
            target = [p for p in pages if "8088" in p.get("url", "")]
            if target:
                return target[0]["webSocketDebuggerUrl"]
        except Exception:
            pass
        time.sleep(1)
    raise SystemExit("no page")


def main():
    proc = subprocess.Popen([
        EDGE, "--headless=new", f"--remote-debugging-port={PORT}",
        "--window-size=369,800", "--disable-gpu", "--no-first-run",
        "--user-data-dir=" + "C:\\Temp\\edge-coomi-" + str(int(time.time())),
        URL,
    ])
    try:
        ws_url = wait_pages()
        ws = websocket.create_connection(ws_url, timeout=20, suppress_origin=True)
        mid = 0

        def cmd(method, params=None):
            nonlocal mid
            mid += 1
            ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
            while True:
                msg = json.loads(ws.recv())
                if msg.get("id") == mid:
                    return msg.get("result", {})

        time.sleep(3)  # 等 SPA 渲染
        expr = """JSON.stringify((() => {
          const inner = document.querySelector('.inner');
          const stream = document.querySelector('.stream');
          const input = document.querySelector('.input');
          const bubble = document.querySelector('.bubble');
          const empty = document.querySelector('.empty');
          const rect = el => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), left: Math.round(r.left), right: Math.round(r.right), clientW: el.clientWidth, scrollW: el.scrollWidth, box: getComputedStyle(el).boxSizing, pad: getComputedStyle(el).padding }; };
          return {
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            docScrollWidth: document.documentElement.scrollWidth,
            bodyScrollWidth: document.body.scrollWidth,
            stream: stream ? rect(stream) : null,
            inner: inner ? rect(inner) : null,
            input: input ? rect(input) : null,
            bubble: bubble ? rect(bubble) : null,
            empty: empty ? rect(empty) : null,
          };
        })())"""
        r = cmd("Runtime.evaluate", {"expression": expr, "returnByValue": True})
        print(json.dumps(json.loads(r.get("result", {}).get("value", "{}")), ensure_ascii=False, indent=2))
        ws.close()
    finally:
        proc.terminate()


if __name__ == "__main__":
    main()
