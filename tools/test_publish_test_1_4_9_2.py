import unittest
from publish_test_1_4_9_2 import build_site, element_span, HEADING, NAME


class SiteUpdateTests(unittest.TestCase):
    def test_latest_only_and_stable_preserved(self):
        previous = {'version': '1.4.9-test.1', 'date': '2026-10-07', 'notes': 'v1.4.9-test.1 更新说明【测试】\n旧版说明'}
        site = '''<a href="old.apk" data-stat-action="download-test">下载测试版</a>
<div class="rel-head"><strong>v1.4.9-test.1 更新说明【测试】</strong></div><ul class="rel-list"><li>旧说明</li></ul>
<div data-channel-panel="stable"><h2>稳定版</h2><div>保持不变</div></div>
<div data-channel-panel="test" hidden><h2>v1.4.8-test.8 更新说明【测试】</h2><ul><li>历史</li></ul>
<details class="changelog-history"><summary>展开全部更新记录</summary><div class="history-inner"><h3>更早的版本</h3><details><summary>旧折叠</summary><div>历史内容</div></details></div></details>
<details class="changelog-history"><summary>历史版本安装包下载</summary><div data-versions="android_test"></div></details></div>'''
        updated = build_site(site, previous, HEADING + '\n\n- 修复返回\n- 修复阴影')
        self.assertIn(NAME, updated)
        self.assertNotIn('rel-head', updated)
        self.assertIn('<div data-channel-panel="stable"><h2>稳定版</h2><div>保持不变</div></div>', updated)
        start, open_end, close_start, end = element_span(updated, 'div', 'data-channel-panel', 'test')
        body = updated[open_end:close_start]
        history_start, history_open, history_close, history_end = element_span(body, 'details', 'class', 'changelog-history')
        self.assertIn(HEADING, body[:history_start])
        self.assertNotIn('1.4.8-test.8', body[:history_start])
        self.assertNotIn('1.4.9-test.1', body[:history_start])
        self.assertIn('1.4.9-test.1', body[history_open:history_close])
        self.assertIn('1.4.8-test.8', body[history_open:history_close])
        self.assertIn('历史版本安装包下载', body[history_end:])
        self.assertEqual(build_site(updated, previous, HEADING + '\n\n- 修复返回'), updated)


if __name__ == '__main__':
    unittest.main()
