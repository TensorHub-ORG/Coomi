"""Browser regression checks; run Vite on 5178, then python this file.
Uses installed Chrome/Edge via Playwright. No model requests are made.
"""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

origin = os.environ.get('COOMI_WEB_URL', 'http://127.0.0.1:5178')
artifacts = Path(__file__).resolve().parents[1] / 'test-results' / 'context-tools'
artifacts.mkdir(parents=True, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    context = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=1)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.route('**/api/**', lambda route: route.fulfill(status=503, json={'error': 'Offline UI regression fixture'}))
    saved_prompts = {'prompts': []}
    def prompt_api(route):
        if route.request.method == 'PUT':
            saved_prompts['prompts'] = route.request.post_data_json['prompts']
        route.fulfill(json=saved_prompts)
    page.route('**/api/prompts', prompt_api)
    page.route('**/api/git/status', lambda route: route.fulfill(json={'is_repo': False, 'branch': None, 'ahead': 0, 'behind': 0, 'staged': [], 'unstaged': [], 'untracked': [], 'conflicted': []}))
    page.route('**/api/git/project-info', lambda route: route.fulfill(json={'detected': [], 'gitignore': None}))
    page.route('**/api/git/contributions*', lambda route: route.fulfill(json={'authors': [], 'total_commits': 0, 'first_commit_at': None, 'last_commit_at': None, 'by_day': []}))
    page.goto(origin + '/?demo=1&autoplay=0')
    expect(page.get_by_role('button', name='展开快捷工具')).to_be_visible()
    for width in [240, 280, 320, 390, 430]:
        page.set_viewport_size({'width': width, 'height': 844})
        boxes = page.locator('.composer .bar button').evaluate_all('(els) => els.map(el => {const r=el.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})')
        assert len(boxes) == 5, boxes
        centers = [b['y'] + b['h'] / 2 for b in boxes]
        assert max(centers) - min(centers) < 2, (width, boxes)
        assert all(b['x'] >= 0 and b['x'] + b['w'] <= width for b in boxes), (width, boxes)
        assert page.locator('.composer .bar-left span').evaluate_all('(els)=>els.every(e=>e.scrollWidth <= e.clientWidth + 1)'), width
    page.set_viewport_size({'width': 390, 'height': 844})
    page.get_by_role('button', name='展开快捷工具').click()
    expect(page.get_by_role('navigation', name='快捷工具带')).to_be_visible()
    page.get_by_role('button', name='提示词', exact=True).click()
    expect(page.get_by_role('dialog', name='提示词', exact=True)).to_be_visible()
    page.screenshot(path=str(artifacts / 'prompts-390.png'))
    page.mouse.click(384, 700)
    expect(page.locator('.orbit-card')).to_have_count(0)
    expect(page.get_by_role('navigation', name='快捷工具带')).to_be_visible()
    page.get_by_role('button', name='提示词', exact=True).click()
    page.get_by_role('button', name='新建提示词', exact=True).click()
    page.get_by_label('名称', exact=True).fill('浏览器回归提示词')
    page.get_by_label('分类标签', exact=True).fill('开发，测试')
    page.get_by_label('内容', exact=True).fill('请检查输入框布局，不要自动发送。')
    page.get_by_role('button', name='保存', exact=True).click()
    page.get_by_role('article').filter(has_text='浏览器回归提示词').get_by_role('button', name='填入', exact=True).click()
    expect(page.locator('.composer textarea')).to_have_value('请检查输入框布局，不要自动发送。')
    expect(page.get_by_role('navigation', name='快捷工具带')).to_be_visible()
    page.get_by_role('button', name='关闭快捷工具带').click()
    expect(page.get_by_role('navigation', name='快捷工具带')).to_have_count(0)
    page.goto(origin + '/?demo=1&autoplay=0#/prompts')
    expect(page.get_by_text('浏览器回归提示词', exact=True)).to_be_visible()
    page.goto(origin + '/?demo=1&autoplay=0#/data')
    expect(page.get_by_role('heading', name='数据工具', exact=True)).to_be_visible()
    expect(page.get_by_role('button', name='返回', exact=True)).to_be_visible()
    box = page.get_by_role('button', name='返回', exact=True).bounding_box()
    assert box['width'] >= 30 and box['height'] >= 30, box
    page.screenshot(path=str(artifacts / 'data-390.png'))
    page.goto(origin + '/?demo=1&autoplay=0')
    page.get_by_role('button', name='展开快捷工具').click()
    page.get_by_role('button', name='版本工具', exact=True).click()
    expect(page.get_by_text('尚未建立 Git 仓库')).to_be_visible()
    page.screenshot(path=str(artifacts / 'git-390.png'))
    for label in ['Git 面板', '一键还原', '运维诊断', '数据工具']:
        page.get_by_role('navigation', name='版本管理工具').get_by_role('button', name=label, exact=True).click()
        expect(page.get_by_role('dialog', name='版本工具', exact=True)).to_be_visible()
        assert page.url.endswith('autoplay=0') or page.url.endswith('autoplay=0#/'), page.url
    page.screenshot(path=str(artifacts / 'tools-390.png'))
    page.get_by_role('button', name='辅助会话', exact=True).click()
    expect(page.get_by_role('button', name='开始辅助对话')).to_be_visible()
    page.screenshot(path=str(artifacts / 'auxiliary-390.png'))
    page.get_by_role('button', name='提示词', exact=True).click()
    for width, height in [(280, 640), (320, 480), (390, 400)]:
        page.set_viewport_size({'width': width, 'height': height})
        page.wait_for_timeout(80)
        rect = page.locator('.orbit-card').bounding_box()
        assert rect['x'] >= 0 and rect['x'] + rect['width'] <= width, rect
        assert rect['y'] + rect['height'] <= height, rect
        expect(page.get_by_role('button', name='新建提示词')).to_be_visible()
        assert page.locator('.card-content').evaluate('(e)=>e.clientHeight >= 150'), (width, height)
    page.set_viewport_size({'width': 390, 'height': 844})
    page.get_by_role('button', name='上下文 0%').click()
    expect(page.get_by_role('dialog', name='上下文用量', exact=True)).to_be_visible()
    expect(page.get_by_text('此对话尚无用量数据')).to_be_visible()
    page.evaluate("document.documentElement.setAttribute('data-theme','dark')")
    page.screenshot(path=str(artifacts / 'usage-dark-390.png'))
    page.evaluate("window.dispatchEvent(new CustomEvent('coomi:floating-state',{detail:true}))")
    expect(page.get_by_role('navigation', name='快捷工具带')).to_have_count(0)
    expect(page.get_by_role('button', name='展开快捷工具')).to_have_count(0)
    expect(page.get_by_role('button', name='上下文用量', exact=True)).to_be_visible()
    assert not errors, errors
    browser.close()
print(json.dumps({'passed': True, 'artifacts': str(artifacts)}))
