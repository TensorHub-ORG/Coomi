"""Mobile regressions for compression settings and post-compression transcript restoration."""
import json
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
from test_mobile_test2 import mock_api
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'build/test150/ui';OUT.mkdir(parents=True,exist_ok=True)
settings={'providerRetryCount':2,'wsRetryCount':10,'reconnectInitialDelayMs':500,'reconnectMaxDelayMs':10000,'maxConcurrentTasks':5,'autoCompactPercent':80}
sid='ab872ed9-3e42-4639-b791-b6f9b9fc77f0';writes=[]
def message(id,role,content,summary=False):return {'id':id,'role':role,'content':content,'compaction_summary':summary}
archive=[message('u1','user','压缩前的用户任务'),message('a1','assistant','压缩前的已完成结果')]
active=[archive[0],message('summary','system','已完成前半部分，继续后半部分',True),message('u2','user','压缩后追加的任务'),message('a2','assistant','压缩后产生的新结果')]
def api(route):
 path=urlparse(route.request.url).path
 if path=='/api/settings/connection':
  if route.request.method=='PUT':settings.update(route.request.post_data_json);writes.append(dict(settings))
  route.fulfill(json=settings)
 elif path=='/api/sessions':route.fulfill(json={'sessions':[{'id':sid,'title':'压缩历史恢复测试','model':'mock','provider_id':'test','cwd':'/tmp','updated_at':'2026-10-10T01:00:00Z','created_at':'2026-10-10T01:00:00Z','mode':'agent'}]})
 elif path==f'/api/sessions/{sid}':route.fulfill(json={'messages':active,'archive':archive,'mode':'agent'})
 else:mock_api(route)
def nav(page,path):
 page.evaluate('(path)=>window.dispatchEvent(new CustomEvent("coomi:navigate",{detail:{route:path}}))',path)
 page.wait_for_function('(path)=>location.hash==="#"+path',arg=path);page.wait_for_timeout(250)
with sync_playwright() as p:
 browser=p.chromium.launch(channel='chrome',headless=True)
 context=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
 context.route('**/api/**',api);page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto('http://127.0.0.1:4173/');page.locator('.composer').wait_for()
 nav(page,'/settings');page.get_by_role('button',name='对话',exact=True).click()
 percent=page.get_by_label('自动压缩阈值（百分比）');expect(percent).to_have_value('80')
 percent.fill('55');page.locator('.compaction-settings').get_by_role('button',name='保存',exact=True).click()
 expect(page.locator('.compaction-settings').get_by_role('status')).to_have_text('已保存');assert settings['autoCompactPercent']==55 and settings['maxConcurrentTasks']==5
 nav(page,'/catalog');nav(page,'/settings');page.get_by_role('button',name='对话',exact=True).click();expect(percent).to_have_value('55')
 for value in ['9','96','50.5']:
  before=len(writes);percent.fill(value);page.locator('.compaction-settings').get_by_role('button',name='保存',exact=True).click();assert len(writes)==before
 percent.fill('55')
 for width in [320,390,430]:
  page.set_viewport_size({'width':width,'height':844});percent.scroll_into_view_if_needed()
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
  page.screenshot(path=str(OUT/f'compression-settings-{width}.png'))
 nav(page,'/sessions');page.locator('button.rmain').filter(has_text='压缩历史恢复测试').click();page.wait_for_function('location.hash==="#/"')
 for text in ['压缩前的用户任务','压缩前的已完成结果','压缩后追加的任务','压缩后产生的新结果']:expect(page.get_by_text(text,exact=True)).to_be_visible()
 expect(page.get_by_text('压缩前的用户任务',exact=True)).to_have_count(1)
 page.screenshot(path=str(OUT/'history-after-compaction.png'))
 assert not errors,errors
 report={'passed':['percentage saved and restored','other connection settings preserved','invalid percentages not sent','320/390/430 mobile widths','archive plus post-compaction messages restored without duplicates'],'pageErrors':errors}
 (OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(report,ensure_ascii=False))
 browser.close()
