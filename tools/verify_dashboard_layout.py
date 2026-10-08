"""Check dashboard containment; valid XML alone cannot detect nested row regressions."""
from collections import Counter
from pathlib import Path
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
ANDROID = '{http://schemas.android.com/apk/res/android}'


def verify():
    root = ET.parse(ROOT / 'apps/coomi-app/app/src/main/res/layout/activity_coomi_dashboard.xml').getroot()
    ids = Counter(node.get(ANDROID + 'id') for node in root.iter() if node.get(ANDROID + 'id'))
    assert all(count == 1 for count in ids.values()), 'Duplicate dashboard IDs'
    for row in root.iter('LinearLayout'):
        if row.get('style') != '@style/Coomi.Row':
            continue
        for child in row.iter():
            if child is row:
                continue
            assert child.get('style') not in ('@style/Coomi.Row', '@style/Coomi.Card', '@style/Coomi.Text.SectionLabel'), f'Row contains another row/group: {row.get(ANDROID + "id")}'
    content = root.find('ScrollView/LinearLayout')
    groups = {'permissions': 2, 'experience': 5, 'extensions': 5, 'service': 8}
    children = list(content)
    for name, expected_rows in groups.items():
        label = next(i for i, node in enumerate(children) if node.get(ANDROID + 'text') == '@string/coomi_dash_section_' + name)
        card = children[label + 1]
        assert card.get('style') == '@style/Coomi.Card', name
        rows = [node for node in card if node.get('style') == '@style/Coomi.Row']
        assert len(rows) == expected_rows, (name, len(rows))
        assert len(list(card)) == expected_rows * 2 - 1, f'Unexpected children/dividers: {name}'
    print('Dashboard: unique IDs, flat rows, four sibling groups, 20 settings entries verified.')


if __name__ == '__main__':
    verify()
