"""Check long auxiliary history, attachment previews and composer controls on mobile."""
import json
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
from test_mobile_test2 import mock_api

OUT = Path(__file__).resolve().parents[1] / 'build/fix5/ui/chat'
OUT.mkdir(parents=True, exist_ok=True)
PARENT = '11111111-1111-4111-8111-111111111111'
CHILD = '22222222-2222-4222-8222-222222222222'
metas = [dict(id=id, parent_session_id=parent, title=title, provider_id='test', model='test-model',
              cwd='/tmp', created_at='2026-10-09T00:00:00Z', updated_at='2026-10-09T01:00:00Z')
         for id, parent, title in [(PARENT, None, '主任务'), (CHILD, PARENT, '辅助任务')]]
messages = []
for i in range(20):
    messages += [dict(id=f'u{i}', role='user', content=f'第 {i} 轮任务'),
                 dict(id=f'a{i}', role='assistant', content=('完整的辅助回复，不应压缩或裁切。\n\n' * 4) + f'结果 {i}')]

def api(route):
    path = urlparse(route.request.url).path
    if path == '/api/sessions': route.fulfill(json={'sessions': metas})
    elif path == '/api/fs/raw':
        route.fulfill(content_type='image/svg+xml', body='<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><rect width="100" height="80" fill="blue"/></svg>')
    elif path in ['/api/sessions/' + PARENT, '/api/sessions/' + CHILD]:
        route.fulfill(json={'messages': messages, 'cwd': '/tmp'})
    else: mock_api(route)

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel='chrome', headless=True, args=['--disable-gpu', '--disable-renderer-backgrounding'])
    context = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, reduced_motion='reduce')
    context.add_init_script(f"localStorage.setItem('coomi.activeSessionId.v1', '{PARENT}');window.CoomiAndroid={{openDashboard(){{}},closeHostActivity(){{}},getQuickCommands:()=>''}};")
    context.route('**/api/**', api)
    page = context.new_page()
    page.set_default_timeout(10000)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto('http://127.0.0.1:4173/?demo=1&autoplay=0')
    page.locator('.composer').wait_for()
    page.get_by_role('button', name='会话历史', exact=True).click()
    child = page.locator('.drawer-root .aux-row').filter(has_text='辅助任务')
    expect(child).to_be_visible()
    expect(child).to_contain_text('辅助')
    expect(child.locator('xpath=ancestor::div[contains(@class,"session-entry")]')).to_contain_text('主任务')
    expect(page.locator('.drawer-root .row').filter(has_text='辅助任务')).to_have_count(0)
    child.click()
    panel = page.locator('.auxiliary-chat')
    expect(panel.get_by_label('辅助会话', exact=True)).to_have_value(CHILD)
    expect(panel.locator('.response-card')).to_have_count(20)
    assert page.evaluate("localStorage.getItem('coomi.activeSessionId.v1')") == PARENT
    for width, height in [(320, 640), (390, 844), (430, 844), (390, 470)]:
        page.set_viewport_size({'width': width, 'height': height})
        page.wait_for_timeout(400)
        transcript = panel.locator('.transcript')
        assert transcript.evaluate('e=>e.scrollHeight>e.clientHeight')
        assert panel.locator('.response-card').first.evaluate('e=>e.clientHeight>=e.scrollHeight-1')
        assert panel.locator('.response-card').first.bounding_box()['height'] > 120
        assert panel.locator('form').bounding_box()['y'] + panel.locator('form').bounding_box()['height'] <= height
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        page.screenshot(path=str(OUT / f'auxiliary-{width}-{height}.png'))
    page.set_viewport_size({'width': 390, 'height': 844})
    page.get_by_role('button', name='关闭快捷工具带', exact=True).click()
    paths = ['/tmp/image.png'] + [f'/tmp/附件-{i}.txt' for i in range(18)]
    page.evaluate("paths=>window.dispatchEvent(new CustomEvent('coomi:files-imported',{detail:{paths}}))", paths)
    expect(page.locator('.composer .attachment-chip')).to_have_count(19)
    content = page.locator('.composer-content')
    assert content.bounding_box()['height'] <= 133
    assert content.evaluate('e=>e.scrollHeight>e.clientHeight')
    page.wait_for_function("document.querySelector('.composer .attachment-chip img').naturalWidth>0")
    page.locator('.composer .attachment-chip').first.click()
    expect(page.get_by_role('dialog', name='附件预览：image.png')).to_be_visible()
    page.screenshot(path=str(OUT / 'attachment-preview.png'))
    assert page.evaluate('window.__coomiHandleSystemBack()')
    expect(page.get_by_role('dialog', name='附件预览：image.png')).to_have_count(0)
    page.screenshot(path=str(OUT / 'attachment-scroll.png'))
    # Load the parent timeline so the jump button is actually shown before opening modes.
    page.get_by_role('button', name='会话历史', exact=True).click()
    page.locator('.drawer-root .global-row').click()
    page.get_by_role('button', name='会话历史', exact=True).click()
    page.locator('.drawer-root .row').filter(has_text='主任务').click()
    expect(page.locator('.stream .response-card').first).to_be_attached()
    page.wait_for_timeout(700)
    page.locator('.stream').evaluate('e=>{e.scrollTop=0;e.dispatchEvent(new Event("scroll"))}')
    expect(page.locator('.to-bottom')).to_be_visible()
    page.locator('.bar-toggle').click()
    expect(page.locator('.mode-pop')).to_be_visible()
    expect(page.locator('.to-bottom')).to_have_count(0)
    expect(page.locator('.sbar')).to_have_count(0)
    assert page.locator('.mode-pop').bounding_box()['height'] <= 90
    card=page.locator('.mode-pop').bounding_box()
    page.wait_for_timeout(300)
    card=page.locator('.mode-pop').bounding_box()
    composer=page.locator('.composer .field').bounding_box()
    assert composer['y']-(card['y']+card['height']) >= 7.5, (card, composer)
    page.screenshot(path=str(OUT / 'compact-modes.png'))
    assert not errors, errors
    report = {'passed': ['auxiliary history selection preserves parent', '20 long replies scroll without shrinking',
                         '320/390/430px and short viewport', '19 attachments share bounded scroll',
                         'image thumbnail and expanded preview', 'system back closes preview',
                         'compact modes hide jump and thinking'], 'pageErrors': errors}
    (OUT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))
    browser.close()
