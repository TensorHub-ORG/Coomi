import argparse
import json
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'build/release-test2/ui'
PROVIDER = {'id': 'test', 'name': 'UI Test', 'baseUrl': 'https://example.invalid/v1',
            'apiKey': 'test-only', 'type': 'openai-compatible', 'models': ['test-model'],
            'model': 'test-model', 'contextWindow': 128000}


def mock_api(route):
    path = urlparse(route.request.url).path
    data = {'sessions': [], 'tasks': [], 'studios': [], 'rooms': [], 'messages': [], 'items': [],
            'entries': [], 'providers': [PROVIDER], 'active': 'test', 'cwd': '/tmp',
            'enabled': False, 'running': False, 'connected': True, 'status': 'ok',
            'path': parse_qs(urlparse(route.request.url).query).get('path', ['/'])[0]}
    if path == '/api/ux-program':
        data = {'consent': 'undecided', 'auto_update': True, 'has_profile': False, 'busy': False}
    route.fulfill(status=200, content_type='application/json', body=json.dumps(data))


def wait_route(page, path):
    page.wait_for_function('(path) => location.hash.split("?")[0] === "#" + path', arg=path)
    page.wait_for_timeout(400)


def hardware_back(page, path=None):
    assert page.evaluate('window.__coomiHandleSystemBack()') is True
    if path:
        wait_route(page, path)
    else:
        page.wait_for_timeout(400)


def open_settings(page):
    page.get_by_role('button', name='会话历史', exact=True).click()
    page.get_by_role('button', name='设置', exact=True).click()
    wait_route(page, '/settings')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', default='http://127.0.0.1:4173')
    args = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    passed = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel='chrome', headless=True)
        context = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True,
                                      device_scale_factor=1, reduced_motion='no-preference')
        context.add_init_script('''window.__consoleOpens=0;window.__nativeCloses=0;
window.CoomiAndroid={openDashboard:()=>window.__consoleOpens++,closeHostActivity:()=>window.__nativeCloses++,
getQuickCommands:()=>localStorage.getItem("test.nativeQuickCommands")||"",
setQuickCommands:value=>{localStorage.setItem("test.nativeQuickCommands",value);return true;}};''')
        context.route('**/api/**', mock_api)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(error.stack or str(error)))
        page.goto(args.url + '/?demo=1&autoplay=0')
        page.locator('.suggestion').first.wait_for()
        assert page.locator('.suggestion').count() == 4
        for width in [320, 390, 430]:
            page.set_viewport_size({'width': width, 'height': 844})
            page.wait_for_timeout(350)
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            assert page.locator('.art-root').evaluate('element => getComputedStyle(element).visibility') == 'hidden'
            assert page.locator('.art-root .panel').evaluate('element => getComputedStyle(element).boxShadow') == 'none'
            assert page.locator('.stream').evaluate('element => getComputedStyle(element).overflowY') == 'auto'
            page.screenshot(path=str(OUTPUT / f'chat-{width}.png'))
        passed.append('320/390/430px layouts, no closed-drawer shadow, scrollbar retained')
        page.set_viewport_size({'width': 390, 'height': 844})
        page.get_by_role('button', name='快捷指令', exact=True).click()
        page.locator('.reasoning-options button[data-effort="high"]').click()
        assert page.locator('.effort-particle').count() == 6
        hardware_back(page)
        assert page.locator('.quick').count() == 0
        passed.append('1.4.8 effort particles and quick panel system-back')
        page.get_by_role('button', name='展开快捷工具', exact=True).click()
        assert page.locator('.orbit-tool').count() == 8
        page.get_by_role('button', name='上下文用量', exact=True).click()
        assert page.locator('.orbit-card').count() == 1
        hardware_back(page)
        assert page.locator('.orbit-card').count() == 0
        assert page.locator('.orbit-band').count() == 1
        hardware_back(page)
        assert page.locator('.orbit-band').count() == 0
        passed.append('fan returns card -> band -> session without opening console')
        page.locator('textarea.input').fill('保留会话草稿')
        open_settings(page)
        page.locator('.tabs button').filter(has_text='应用').click()
        page.get_by_role('button').filter(has_text='主题、颜色、背景与显示比例').click()
        wait_route(page, '/appearance')
        hardware_back(page, '/settings')
        assert page.locator('.tabs button.on').inner_text() == '应用'
        page.get_by_role('button', name='返回', exact=True).click()
        wait_route(page, '/')
        assert page.locator('textarea.input').input_value() == '保留会话草稿'
        assert page.evaluate('window.__consoleOpens') == 0
        passed.append('settings -> appearance -> settings -> chat preserves module and draft')
        for title, path in [('AI 工作室·预览', '/studio'), ('协同工作台·预览', '/collab'), ('文件', '/files'), ('浏览器', '/browser')]:
            page.get_by_role('button', name='会话历史', exact=True).click()
            page.locator('.entry').filter(has_text=title).click()
            wait_route(page, path)
            hardware_back(page, '/')
        passed.append('sidebar studio/collaboration/files/browser return to originating session')
        page.evaluate('window.dispatchEvent(new CustomEvent("coomi:navigate",{detail:{route:"/providers"}}))')
        wait_route(page, '/providers')
        page.get_by_role('button', name='添加提供商', exact=True).click()
        wait_route(page, '/providers/new')
        page.get_by_placeholder('例如 OpenAI').fill('未保存配置')
        hardware_back(page)
        assert page.get_by_text('放弃未保存的修改？', exact=True).is_visible()
        hardware_back(page)
        assert not page.get_by_text('放弃未保存的修改？', exact=True).is_visible()
        page.get_by_role('button', name='返回', exact=True).click()
        page.get_by_role('button', name='放弃修改', exact=True).click()
        wait_route(page, '/providers')
        hardware_back(page)
        assert page.evaluate('window.__consoleOpens') == 1
        passed.append('provider native entry, dirty confirmation, details -> list -> console')
        page.evaluate('window.dispatchEvent(new CustomEvent("coomi:navigate",{detail:{route:"/quick-commands?native=1"}}))')
        wait_route(page, '/quick-commands')
        page.locator('.name-field input').first.fill('我的快捷测试')
        page.locator('.content-field textarea').first.fill('测试指令内容')
        page.get_by_role('button', name='保存当前方案', exact=True).click()
        hardware_back(page)
        assert page.evaluate('window.__nativeCloses') == 1
        page.evaluate('window.dispatchEvent(new CustomEvent("coomi:navigate",{detail:{route:"/"}}))')
        wait_route(page, '/')
        assert page.locator('.suggestion').first.inner_text() == '我的快捷测试'
        passed.append('native quick-command editor persists and updates the four session shortcuts')
        page.locator('textarea.input').fill('测试波纹')
        page.get_by_role('button', name='发送', exact=True).click()
        assert page.locator('.send-ripple').count() == 1
        page.wait_for_timeout(600)
        assert page.locator('.send-ripple').count() == 0
        passed.append('transparent send ripple appears and cleans up without a flying droplet')
        report = {'passed': passed, 'pageErrors': errors}
        (OUTPUT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        assert not errors, errors
        print(json.dumps(report, ensure_ascii=False, indent=2))
        browser.close()


if __name__ == '__main__':
    main()
