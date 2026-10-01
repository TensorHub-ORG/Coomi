# -*- coding: utf-8 -*-
"""解析 uiautomator dump，输出可见按钮文字与 bounds。"""
import re
import sys

t = open(sys.argv[1], encoding="utf-8").read()
items = re.findall(r'text="([^"]*)"[^>]*bounds="(\[[^"]+\])"', t)
for text, bounds in items:
    if text.strip():
        print(f"{text.strip()}  {bounds}")
