#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Coomi 夜间主题令牌化（一次性完备版）：
1) colors_coomi.xml：夜间色板对齐前端 dark + 新增夜间颜色（GBK -> UTF-8）
2) drawable/color/*.xml：@color/coomi_* -> ?attr/coomiXxx
3) layout：白底/蓝 tint/危险色/分隔线 -> ?attr
统一写回 UTF-8 无 BOM。"""
import glob, os, re, sys

RES = "apps/coomi-app/app/src/main/res"

# ---------- 1) colors_coomi.xml ----------
COLOR_MAP = {
    '    <color name="coomi_night_bg">#121316</color>': '    <color name="coomi_night_bg">#131518</color>',
    '    <color name="coomi_night_page">#1A1C20</color>': '    <color name="coomi_night_page">#191C21</color>',
    '    <color name="coomi_night_fill">#23262C</color>': '    <color name="coomi_night_fill">#1A1D22</color>',
    '    <color name="coomi_night_border">#2E3239</color>': '    <color name="coomi_night_border">#252A32</color>',
    '    <color name="coomi_night_text">#E7E9ED</color>': '    <color name="coomi_night_text">#E7E9EE</color>',
    '    <color name="coomi_night_text_2">#9AA2AE</color>': '    <color name="coomi_night_text_2">#9AA2AF</color>',
    '    <color name="coomi_night_text_3">#6B7280</color>': '    <color name="coomi_night_text_3">#68717F</color>',
    '    <color name="coomi_night_blue_soft">#1E3357</color>': '    <color name="coomi_night_blue_soft">#1C2C50</color>',
    '    <color name="coomi_night_danger_soft">#40201D</color>': '    <color name="coomi_night_danger_soft">#3D241F</color>',
}
NEW_COLORS = [
    '    <color name="coomi_night_fill_strong">#22262D</color>',
    '    <color name="coomi_night_blue">#5B8BF0</color>',
    '    <color name="coomi_night_ok">#38B98A</color>',
    '    <color name="coomi_night_ok_soft">#1B362C</color>',
    '    <color name="coomi_night_danger">#E86A58</color>',
    '    <color name="coomi_night_warn_soft">#332C1C</color>',
    '    <color name="coomi_night_orange">#E08A6B</color>',
    '    <color name="coomi_night_orange_soft">#3A2821</color>',
    '    <color name="coomi_night_orange_border">#5E3B2E</color>',
]

def read_text(path):
    data = open(path, "rb").read()
    for enc in ("utf-8", "gbk"):
        try:
            return data.decode(enc), enc
        except UnicodeDecodeError:
            continue
    raise ValueError(f"undecodable: {path}")

def rewrite_colors():
    p = os.path.join(RES, "values", "colors_coomi.xml")
    text, enc = read_text(p)
    n = 0
    for old, new in COLOR_MAP.items():
        if old in text:
            text = text.replace(old, new)
            n += 1
    existing = set(re.findall(r'name="(coomi_night_[a-z0-9_]+)"', text))
    block = ''
    for nc in NEW_COLORS:
        name = re.search(r'name="([^"]+)"', nc).group(1)
        if name not in existing:
            block += nc + '\n'
    if block:
        text = text.rstrip()
        assert text.endswith('</resources>')
        text = text[: -len('</resources>')] + block + '</resources>\n'
    open(p, "w", encoding="utf-8", newline="\n").write(text)
    print(f"colors_coomi.xml: {n} value updates, {block.count('<color')} colors added (was {enc})")

# ---------- 2) drawable/color 通用替换 ----------
GENERIC_PAIRS = [
    ("@color/coomi_blue_disabled", "?attr/coomiBlueSoft"),
    ("@color/coomi_blue_border", "?attr/coomiBlue"),
    ("@color/coomi_blue_soft", "?attr/coomiBlueSoft"),
    ("@color/coomi_blue", "?attr/coomiBlue"),
    ("@color/coomi_ok_soft", "?attr/coomiOkSoft"),
    ("@color/coomi_ok", "?attr/coomiOk"),
    ("@color/coomi_danger_soft", "?attr/coomiDangerSoft"),
    ("@color/coomi_danger", "?attr/coomiDanger"),
    ("@color/coomi_text_2", "?attr/coomiText2"),
    ("@color/coomi_text_3", "?attr/coomiText3"),
    ("@color/coomi_border", "?attr/coomiBorder"),
    ("@color/coomi_fill", "?attr/coomiFill"),
    ("@color/coomi_orange_soft", "?attr/coomiOrangeSoft"),
    ("@color/coomi_orange_border", "?attr/coomiOrangeBorder"),
    ("@color/coomi_orange", "?attr/coomiOrange"),
    ("@color/coomi_warn_soft", "?attr/coomiWarnSoft"),
    # 卡片白底（仅 solid 标签；ripple mask 中的 white 也替换但无害）
    ('<solid android:color="@color/coomi_white"/>', '<solid android:color="?attr/coomiCard"/>'),
    # 危险按钮描边
    ('<stroke android:width="@dimen/coomi_stroke_thick" android:color="#F2C9C3"/>',
     '<stroke android:width="@dimen/coomi_stroke_thick" android:color="?attr/coomiDangerSoft"/>'),
    ('android:color="#F2C9C3"', 'android:color="?attr/coomiDangerSoft"'),
]

# ---------- 3) layout 专用 ----------
LAYOUT_PAIRS = [
    ('android:background="@color/coomi_white"', 'android:background="?attr/coomiPage"'),
    ('android:background="@color/coomi_divider"', 'android:background="?attr/coomiDivider"'),
    ('android:tint="@color/coomi_blue"', 'android:tint="?attr/coomiBlue"'),
    ('android:tint="@color/coomi_ok"', 'android:tint="?attr/coomiOk"'),
    ('android:tint="@color/coomi_danger"', 'android:tint="?attr/coomiDanger"'),
    ('android:tint="@color/coomi_text_3"', 'android:tint="?attr/coomiText3"'),
    ('android:textColor="@color/coomi_blue"', 'android:textColor="?attr/coomiBlue"'),
    ('android:textColor="@color/coomi_danger"', 'android:textColor="?attr/coomiDanger"'),
]

def apply_pairs(path, pairs):
    text, enc = read_text(path)
    n = 0
    for old, new in pairs:
        c = text.count(old)
        if c:
            text = text.replace(old, new)
            n += c
    if n:
        open(path, "w", encoding="utf-8", newline="\n").write(text)
    return n, enc

def main():
    rewrite_colors()
    total = 0
    for f in sorted(glob.glob(os.path.join(RES, "drawable", "*.xml"))
                    + glob.glob(os.path.join(RES, "color", "*.xml"))):
        if "botdrop" in os.path.basename(f):
            continue
        n, enc = apply_pairs(f, GENERIC_PAIRS)
        if n:
            print(f"OK[{enc}] drawable/{os.path.basename(f)}: {n}")
            total += n
    for f in sorted(glob.glob(os.path.join(RES, "layout", "activity_coomi*.xml"))
                    + glob.glob(os.path.join(RES, "layout", "fragment_coomi_*.xml"))):
        if "dashboard" in os.path.basename(f):
            continue
        n, enc = apply_pairs(f, LAYOUT_PAIRS)
        if n:
            print(f"OK[{enc}] layout/{os.path.basename(f)}: {n}")
            total += n
    print(f"TOTAL: {total}")

if __name__ == "__main__":
    main()
