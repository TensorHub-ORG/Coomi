"""Production Web verification for persisted reasoning, process folding and updates."""
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys
import threading
from urllib.parse import urlparse
from playwright.sync_api import expect, sync_playwright
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools'))
from test_mobile_test2 import mock_api
SID = 'd46be1b7-6211-4654-83e2-c3ce354ed0d1'
OUT = ROOT / 'build/comax-batch23/ui'

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(SimpleHTTPRequestHandler, directory=str(ROOT/'apps/web/dist')))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    snapshot = {'session': {'cwd':'/project','messages':[
        {'id':'u','role':'user','content':'Inspect my project'},
        {'id':'a','role':'assistant','content':'Checking files','reasoning':'Persisted thought','reasoning_state':'complete','tool_calls':[{'id':'t','name':'read_file','arguments':{'path':'README.md'}}]},
        {'id':'tr','role':'tool','tool_call_id':'t','content':'file contents'},
        {'id':'f','role':'assistant','content':'Final answer remains visible','reasoning':'Final thought','reasoning_state':'complete'}]}, 'events':[], 'event_seq':0, 'running':False}
    def api(route):
        if urlparse(route.request.url).path == f'/api/sessions/{SID}/snapshot': route.fulfill(json=snapshot)
        else: mock_api(route)
    errors=[]
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(channel='chrome',headless=True)
            context=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
            context.add_init_script("""localStorage.setItem('coomi.activeSessionId.v1','"""+SID+"""');
window.CoomiAndroid={getAppVersionCode:()=>93,getAppVersionName:()=> '1.5.0-test.4',getThemeMode:()=> 'terminal',getTestUpdateDotEnabled:()=>true,setTestUpdateDotEnabled:v=>window.__testDot=v,getUpdateRemindersEnabled:()=>true,setUpdateRemindersEnabled:v=>window.__reminders=v,installApk:(url,version)=>window.__install={url,version}};""")
            context.route('**/api/**',api)
            context.route_web_socket('**/ws/**',lambda ws:ws.on_message(lambda _:None))
            notes='# v1.5.0-test.4 更新说明【测试】\nNew reasoning and context features\n\n# v1.5.0-test.1 更新说明【测试】\nHistorical release'
            context.route('https://updates.septemc.com/**/latest.json',lambda r:r.fulfill(json={'versionCode':94,'version':'1.5.0-test.4','file':'Coomi-Android-arm64-v1.5.0-test.4.apk','notes':notes,'date':'2026-10-19'}))
            page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
            base=f'http://127.0.0.1:{server.server_port}/'
            page.goto(base,wait_until='domcontentloaded')
            expect(page.get_by_text('Final answer remains visible',exact=True)).to_be_visible()
            expect(page.locator('.process-content')).to_have_count(0)
            expect(page.locator('.process-toggle')).to_have_count(1)
            page.locator('.process-toggle').click()
            expect(page.get_by_text('Checking files',exact=True)).to_be_visible()
            page.locator('.reasoning .toggle').first.click()
            expect(page.get_by_text('Persisted thought',exact=True)).to_be_visible()
            assert page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()")=='#000'
            assert page.locator('.row.user .bubble').evaluate('el=>getComputedStyle(el).color')=='rgb(0, 0, 0)'
            page.screenshot(path=str(OUT/'terminal-process.png'))
            for width in [320,390,430]:
                page.set_viewport_size({'width':width,'height':844})
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            snapshot.update(session={'cwd':'/project','messages':[{'id':'live','role':'user','content':'Live task'}]},events=[{'event_seq':1,'event_type':'reasoning_chunk','content':'Live thought\n'*40}],event_seq=1,running=True)
            page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
            expect(page.locator('.reasoning .preview')).to_have_count(1)
            page.wait_for_timeout(1250)
            expect(page.get_by_text('正在思考…',exact=True)).to_be_visible()
            height=page.locator('.reasoning .preview').bounding_box()['height']
            assert height <= 96,height
            page.emulate_media(reduced_motion='reduce')
            assert page.locator('.reasoning .live').evaluate('el=>getComputedStyle(el).animationName')=='none'
            page.goto(base+'#/updates',wait_until='domcontentloaded')
            expect(page.get_by_text('v1.5.0-test.4 更新说明【测试】',exact=False)).to_be_visible()
            expect(page.locator('.notes-history')).not_to_be_visible()
            page.get_by_role('button',name='展开全部更新记录',exact=False).click()
            expect(page.locator('.notes-history')).to_be_visible()
            page.get_by_role('button',name='下载并安装测试版',exact=True).click()
            assert '/android_test/' in page.evaluate('window.__install.url')
            page.locator('.test-dot-toggle input').first.uncheck()
            assert page.evaluate('window.__reminders') is False
            page.screenshot(path=str(OUT/'test-update-notes.png'))
            assert not errors,errors
            report={'persistedReasoning':True,'processCollapsedOnCompletion':True,'finalAnswerVisible':True,'livePreviewHeight':height,'eventDrivenAfterPause':True,'reducedMotion':True,'terminalTheme':True,'testChannelDefault':True,'updateHistoryToggle':True,'reminderPreference':True,'mobileWidths':[320,390,430],'pageErrors':errors}
            (OUT/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8');print(json.dumps(report))
            browser.close()
    finally: server.shutdown()
if __name__=='__main__': main()
