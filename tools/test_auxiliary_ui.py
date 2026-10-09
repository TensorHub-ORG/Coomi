"""Exercise auxiliary creation, refresh, switching, drafts and deletion in mobile UI."""
import json
import uuid
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
from test_mobile_test2 import mock_api

OUT = Path(__file__).resolve().parents[1] / 'build/fix5/ui/auxiliary'
OUT.mkdir(parents=True, exist_ok=True)
sessions = []


def api(route):
    path = urlparse(route.request.url).path
    method = route.request.method
    if path == '/api/sessions':
        route.fulfill(json={'sessions': sessions})
    elif path.endswith('/children') and method == 'POST':
        parent = path.split('/')[3]
        child = dict(id=str(uuid.uuid4()), parent_session_id=parent, title='辅助对话',
                     provider_id='test', model='test-model', cwd='/tmp',
                     created_at='2026-10-08T00:00:00Z', updated_at='2026-10-08T00:00:00Z')
        sessions.append(child)
        route.fulfill(json=child)
    elif path.startswith('/api/sessions/'):
        if method == 'DELETE':
            sessions[:] = [s for s in sessions if s['id'] != path.split('/')[3]]
        route.fulfill(json={'messages': [], 'deleted': True})
    else:
        mock_api(route)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel='chrome', headless=True, args=['--disable-gpu', '--disable-renderer-backgrounding'])
    context = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, reduced_motion='reduce')
    context.add_init_script('window.CoomiAndroid={openDashboard:()=>{},closeHostActivity:()=>{},getQuickCommands:()=>""};')
    context.route('**/api/**', api)
    page = context.new_page()
    page.set_default_timeout(10000)
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://127.0.0.1:4173/?demo=1&autoplay=0')
    page.get_by_role('button', name='展开快捷工具', exact=True).click()
    page.get_by_role('button', name='辅助会话', exact=True).click()
    panel = page.locator('.auxiliary-chat')
    panel.get_by_role('button', name='开始辅助对话', exact=True).click()
    expect(panel.get_by_label('辅助对话消息')).to_be_visible()
    first = panel.get_by_label('辅助会话', exact=True).input_value()
    main = page.evaluate("localStorage.getItem('coomi.activeSessionId.v1')")
    panel.get_by_label('辅助对话消息').fill('第一条辅助草稿')
    panel.get_by_role('button', name='新建', exact=True).click()
    expect(panel.get_by_label('辅助会话', exact=True)).not_to_have_value(first)
    second = panel.get_by_label('辅助会话', exact=True).input_value()
    expect(panel.get_by_label('辅助对话消息')).to_have_value('')
    panel.get_by_label('辅助对话消息').fill('第二条辅助草稿')
    panel.get_by_label('辅助会话', exact=True).select_option(first)
    expect(panel.get_by_label('辅助对话消息')).to_have_value('第一条辅助草稿')
    assert page.evaluate("localStorage.getItem('coomi.activeSessionId.v1')") == main
    page.evaluate('window.__coomiHandleSystemBack()')
    page.get_by_role('button', name='辅助会话', exact=True).click()
    expect(panel.get_by_label('辅助会话', exact=True)).to_have_value(first)
    expect(panel.get_by_label('辅助对话消息')).to_have_value('第一条辅助草稿')
    panel.get_by_label('辅助会话', exact=True).select_option(second)
    expect(panel.get_by_label('辅助对话消息')).to_have_value('第二条辅助草稿')
    panel.get_by_role('button', name='删除', exact=True).click()
    panel.get_by_role('button', name='确认删除', exact=True).click()
    expect(panel.get_by_label('辅助会话', exact=True)).to_have_value(first)
    assert len(sessions) == 1
    assert not errors, errors
    page.screenshot(path=str(OUT / 'auxiliary-chat.png'))
    # Explicitly disabling minimal UI survives a complete page reload.
    page.evaluate("localStorage.setItem('coomi.minimalUi','0')")
    page.reload()
    expect(page.locator('.chat')).not_to_have_class(__import__('re').compile('minimal-ui'))
    page.emulate_media(reduced_motion='reduce')
    page.get_by_role('button', name='展开快捷开始', exact=True).click()
    expect(page.locator('.suggestions-reveal')).to_have_css('opacity', '1')
    page.get_by_role('button', name='收起快捷开始', exact=True).click()
    expect(page.locator('.suggestions-reveal')).to_have_count(0)
    report = dict(passed=['create two children', 'switch and preserve drafts', 'close and reopen', 'delete child', 'main session isolated', 'explicit minimal UI off persists', 'reduced motion'], pageErrors=errors)
    (OUT / 'auxiliary-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))
    browser.close()
