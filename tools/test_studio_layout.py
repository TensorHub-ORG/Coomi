import json
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'build/studio-fix/ui'
MEMBERS = [{'id': mid, 'name': name, 'model': 'test-model', 'providerId': 'test', 'role': name, 'status': 'idle', 'toolPermission': 'ask'} for mid, name in [('host', '主持'), ('coder', '程序员')]]
STUDIO = {'id': 'fixture', 'name': '设计工作室', 'hostId': 'host', 'members': MEMBERS}
PROVIDER = {'id': 'test', 'name': 'UI Test', 'baseUrl': 'https://example.invalid/v1', 'type': 'openai-compatible', 'models': ['test-model'], 'model': 'test-model'}

def mock(route):
    path = urlparse(route.request.url).path
    data = {'sessions': [], 'tasks': [], 'studios': [], 'messages': [], 'workItems': [], 'providers': [PROVIDER], 'active': 'test', 'running': False}
    if path == '/api/studios/fixture': data = {'studio': STUDIO, 'messages': [], 'workItems': []}
    if path.endswith('/stop'): data = {'ok': True}
    if path == '/api/studios/fixture/messages' and route.request.method == 'POST':
        msg = {'id': 'user', 'senderId': 'user', 'senderName': '我', 'content': '检查界面', 'timestamp': 1720000000000, 'type': 'text', 'mentions': []}
        events = [{'event_type': 'studio_user_message', 'message': msg}]
        for mid in ['host', 'coder']:
            events += [{'event_type': 'studio_member_status', 'member_id': mid, 'status': 'thinking'}, {'event_type': 'studio_reasoning_delta', 'member_id': mid, 'content': '仔细检查布局。'}, {'event_type': 'studio_tool_start', 'member_id': mid, 'call_id': mid, 'tool_name': 'read_file', 'arguments': {'path': 'design.md'}}, {'event_type': 'studio_tool_done', 'member_id': mid, 'call_id': mid, 'tool_name': 'read_file', 'result_preview': '读取成功'}]
        # Completion arrives in the opposite order from execution start.
        for mid in ['coder', 'host']:
            message = {**msg, 'id': 'reply-' + mid, 'senderId': mid, 'senderName': next(m['name'] for m in MEMBERS if m['id'] == mid), 'content': '界面已检查；@程序员 请继续完善。'}
            events += [{'event_type': 'studio_message', 'message': message}, {'event_type': 'studio_member_status', 'member_id': mid, 'status': 'done'}]
        events += [{'event_type': 'studio_end'}]
        route.fulfill(status=200, content_type='text/event-stream', body=''.join('data: ' + json.dumps(e, ensure_ascii=False) + '\n\n' for e in events))
        return
    route.fulfill(status=200, content_type='application/json', body=json.dumps(data))

def navigate(page, path):
    page.evaluate('(path)=>window.dispatchEvent(new CustomEvent("coomi:navigate",{detail:{route:path}}))', path)
    page.wait_for_function('(path)=>location.hash==="#"+path', arg=path)
    page.wait_for_timeout(350)

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    passed=[]
    with sync_playwright() as p:
        browser=p.chromium.launch(channel='chrome', headless=True)
        context=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
        context.add_init_script('''window.__float=false;window.CoomiAndroid={openDashboard(){},closeHostActivity(){},getQuickCommands:()=>'',isAccessibilityEnabled:()=>true,isOverlayGranted:()=>true,isControlFloatRunning:()=>window.__float,startControlFloat:()=>{window.__float=true},stopControlFloat:()=>{window.__float=false},pushControlFloat(){},pushControlStatus(){}};''')
        context.route('**/api/**',mock)
        page=context.new_page(); errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto('http://127.0.0.1:4173/?demo=1&autoplay=0')
        page.locator('.composer').wait_for()
        navigate(page,'/collab/new')
        for width,height in [(320,640),(390,844),(430,844),(390,470)]:
            page.set_viewport_size({'width':width,'height':height})
            sheet=page.locator('.task-sheet')
            assert int(float(sheet.evaluate('e=>getComputedStyle(e).paddingLeft').removesuffix('px'))) >= 16
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            for select in page.locator('.role select').all():
                box=select.bounding_box(); assert box['x']>=16 and box['x']+box['width']<=width-16
            box=page.get_by_role('button',name='启动任务',exact=True).bounding_box()
            assert box['y']>=0 and box['y']+box['height']<=height
            page.screenshot(path=str(OUT/f'collab-{width}-{height}.png'))
        passed.append('task sheet padding, role selectors and sticky actions fit 320/390/430px and short viewport')
        page.set_viewport_size({'width':390,'height':844})
        navigate(page,'/studio/fixture/chat')
        page.get_by_role('button',name='提及成员',exact=True).wait_for()
        assert page.get_by_role('button',name='提及成员',exact=True).inner_text()=='@'
        page.locator('.input-row input').fill('检查界面')
        page.get_by_role('button',name='发送',exact=True).click()
        page.wait_for_function('document.querySelectorAll("article.entry").length===3')
        assert page.locator('article.entry .meta b').all_text_contents()==['我','主持','程序员']
        assert page.locator('.execution-toggle').count()==2
        assert page.locator('.execution-detail').count()==0
        assert page.locator('article.entry .content').count()==3
        page.screenshot(path=str(OUT/'studio-folded.png'))
        page.locator('.execution-toggle').first.click()
        assert page.locator('.tool-head').count()==1
        assert page.locator('.tool-detail').count()==0
        page.locator('.tool-head').click()
        assert page.locator('.tool-detail').count()==1
        assert 'design.md' in page.locator('.tool-detail').inner_text()
        page.screenshot(path=str(OUT/'studio-details.png'))
        passed.append('actual @ button, start-order waterfall, no duplicate live/final rows, nested tools default folded')
        navigate(page,'/')
        page.locator('.bar-toggle').click()
        page.locator('.mode-pop').wait_for()
        assert page.locator('.mode-pop .pill').count()==4
        assert page.locator('.mode-pop').evaluate('e=>getComputedStyle(e).backgroundColor')!='rgba(0, 0, 0, 0)'
        assert page.locator('.sbar').count()==0
        page.locator('.production-pill').click()
        page.locator('.mode-notice').wait_for()
        box=page.locator('.mode-notice').bounding_box()
        assert box['y']>844/2 and box['y']+box['height']<844-120
        page.screenshot(path=str(OUT/'overload-notice.png'))
        page.get_by_role('button',name='选择超载模型',exact=False).click()
        page.locator('#overload-model').wait_for()
        assert page.locator('.tabs button.on').inner_text()=='连接'
        assert page.locator('#overload-model').inner_text()=='超载模型'
        passed.append('opaque four-mode menu covers thinking, overload notice in lower middle opens correct model settings')
        navigate(page,'/')
        page.locator('textarea.input').fill('检查工具折叠')
        page.get_by_role('button',name='发送',exact=True).click()
        page.locator('.mini-tool').first.wait_for(timeout=30000)
        assert page.locator('.mini-list').count()==0
        page.locator('.mini-tool').first.click()
        page.locator('.mini-list .tool').first.wait_for()
        assert not page.locator('.mini-list .tool .body').first.is_visible()
        page.locator('.mini-list .tool .head').first.click()
        assert page.locator('.mini-list .tool .body').first.is_visible()
        page.locator('.mini-tool').first.click()
        page.locator('.mini-tool').first.click()
        assert page.locator('.mini-list .tool .body').first.is_visible()
        page.get_by_role('button',name='停止',exact=True).click()
        passed.append('main-session tools stay folded during execution; manual detail state survives group remount')
        page.locator('.bar-toggle').click(); page.locator('.control-pill').click()
        page.get_by_role('button',name='确认进入',exact=True).click()
        page.wait_for_function('window.__float===true')
        assert page.locator('.control-float').count()==0
        page.screenshot(path=str(OUT/'control-native-only.png'))
        passed.append('native control mode owns the controls; duplicate web panel is removed')
        assert not errors,errors
        (OUT/'report.json').write_text(json.dumps({'passed':passed,'pageErrors':errors},ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps({'passed':passed,'pageErrors':errors},ensure_ascii=False))
        browser.close()

if __name__=='__main__': main()
