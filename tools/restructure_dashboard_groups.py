# -*- coding: utf-8 -*-
"""把控制台“设置”大卡拆成 4 个分组卡片（权限管理/会话与体验/扩展与自动化/维护与支持）。

按行块（LinearLayout row + Divider）切分并重排，保持每块原文与缩进不变。
用法：python tools/restructure_dashboard_groups.py
"""
import io
import re
import sys

PATH = "apps/coomi-app/app/src/main/res/layout/activity_coomi_dashboard.xml"

GROUPS = [
    ("coomi_dash_section_permissions", [
        "btn_permission_settings", "btn_storage_settings"]),
    ("coomi_dash_section_experience", [
        "btn_web_providers", "btn_home_settings", "btn_web_runtime",
        "btn_appearance"]),
    ("coomi_dash_section_extensions", [
        "btn_web_catalog", "btn_web_workflows", "btn_web_hooks",
        "btn_web_memory", "btn_web_life"]),
    ("coomi_dash_section_service", [
        "btn_web_files", "btn_maintenance", "btn_usage",
        "btn_backup_data", "btn_check_update", "btn_feedback",
        "btn_custom_iteration"]),
]

LABEL_INDENT = "            "
LABEL_TEMPLATE = '''<TextView
    style="@style/Coomi.Text.SectionLabel"
    android:layout_width="wrap_content"
    android:layout_height="wrap_content"
    android:layout_marginTop="@dimen/coomi_space_l"
    android:text="@string/%s"/>'''
CARD_OPEN = "            <LinearLayout style=\"@style/Coomi.Card\">"
CARD_CLOSE = "            </LinearLayout>"
DIVIDER = "                <View style=\"@style/Coomi.Divider\"/>"


def main():
    with io.open(PATH, encoding="utf-8-sig") as f:
        text = f.read()
    lines = text.split("\n")

    # 1. 找设置区块：SectionLabel 行 ~ 大卡结束行
    label_idx = next(i for i, l in enumerate(lines)
                     if "@string/coomi_dash_section_settings" in l)
    label_start = label_idx
    while not re.match(r"\s*<TextView", lines[label_start]):
        label_start -= 1
    card_start = label_idx + 1
    while "Coomi.Card" not in lines[card_start]:
        card_start += 1
    assert "@style/Coomi.Card" in lines[card_start]

    # 2. 卡深度扫描：depth=1 时收集 row 块与 divider（先判行再折叠深度）
    depth = 0
    children = []          # (kind, line_start, line_end)  kind: row/divider
    i = card_start
    while i < len(lines):
        line = lines[i]
        if depth == 1:
            if line.startswith("                <LinearLayout"):
                # row 块：找匹配的 </LinearLayout>
                j = i
                d = 0
                while True:
                    d += lines[j].count("<LinearLayout")
                    d -= lines[j].count("</LinearLayout>")
                    if d == 0:
                        break
                    j += 1
                children.append(("row", i, j))
                i = j + 1
                continue
            if re.match(r"\s*<View style=\"@style/Coomi.Divider\"/>\s*$", line):
                children.append(("divider", i, i))
                i += 1
                continue
        depth += line.count("<LinearLayout")
        depth -= line.count("</LinearLayout>")
        if depth == 0:
            break
        i += 1
    card_end = i

    rows = {}
    block = {}
    order = []
    for kind, a, b in children:
        if kind == "divider":
            continue
        blk = "\n".join(lines[a:b + 1])
        m = re.search(r"@\+id/(btn_\w+)", blk)
        assert m, "row 块缺少 btn id"
        rid = m.group(1)
        rows[rid] = blk
        order.append(rid)
    print("rows found:", len(order), order)

    # 3. 组装新区块文本
    out = []
    for label, rids in GROUPS:
        missing = [r for r in rids if r not in rows]
        if missing:
            sys.exit("缺少行: %s" % missing)
        out.append(LABEL_INDENT + LABEL_TEMPLATE % label)
        out.append(CARD_OPEN)
        for k, rid in enumerate(rids):
            if k:
                out.append(DIVIDER)
            out.append(rows[rid])
        out.append(CARD_CLOSE)
    new_section = "\n".join(out)

    # 4. 替换 [card_start..card_end]（标签保留）
    new_lines = lines[:card_start] + new_section.split("\n") + lines[card_end + 1:]
    result = "\n".join(new_lines)

    # 5. 校验 XML
    import xml.etree.ElementTree as ET
    ET.fromstring(result)

    with io.open(PATH, "w", encoding="utf-8-sig") as f:
        f.write(result)
    print("done, lines:", len(lines), "->", len(new_lines))


if __name__ == "__main__":
    main()
