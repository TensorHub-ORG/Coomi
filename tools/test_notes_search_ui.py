"""Exercise personal TXT notes and search configuration on mobile."""
import json
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
from test_mobile_test2 import mock_api
OUT=Path(__file__).resolve().parents[1]/'build/notes/ui'
OUT.mkdir(parents=True,exist_ok=True)
notes={};key='';reads=[];writes=[]
def api(route):
    global key
    path=urlparse(route.request.url).path;method=route.request.method
    if path=='/api/settings/search':
        if method=='PUT':key=route.request.post_data_json['tavilyApiKey']
        route.fulfill(json={'tavilyConfigured':bool(key)})
    elif path=='/api/notes':route.fulfill(json={'notes':[v['note'] for v in notes.values()]})
    elif path.startswith('/api/notes/'):
        id=path.split('/')[-1]
        if method=='PUT':
            body=route.request.post_data_json
            notes[id]={'note':{'id':id,'title':body['title'],'revision':body['revision']+1,'updatedAt':'2026-10-09T12:00:00Z'},'content':body['content']}
            writes.append(id);route.fulfill(json=notes[id])
        elif method=='DELETE':notes.pop(id);route.fulfill(json={'ok':True})
        else:reads.append(id);route.fulfill(json=notes[id])
    else:mock_api(route)
def nav(page,path):
    page.evaluate('(path)=>window.dispatchEvent(new CustomEvent("coomi:navigate",{detail:{route:path}}))',path)
    page.wait_for_function('(path)=>location.hash==="#"+path',arg=path)
    page.wait_for_timeout(400)
with sync_playwright() as p:
    browser=p.chromium.launch(channel='chrome',headless=True,args=['--disable-gpu','--disable-renderer-backgrounding'])
    context=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
    context.add_init_script('window.CoomiAndroid={getQuickCommands:()=>"",openDashboard(){},closeHostActivity(){}}')
    context.route('**/api/**',api)
    page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto('http://127.0.0.1:4173/?demo=1&autoplay=0');page.locator('.composer').wait_for()
    nav(page,'/catalog');page.get_by_role('button',name='联网',exact=True).click()
    expect(page.get_by_text('tavily（联网搜索）',exact=True)).to_be_visible()
    page.get_by_label('API 密钥').fill('tvly-fixture-key');page.get_by_role('button',name='保存',exact=True).click()
    expect(page.get_by_text('已配置',exact=True)).to_be_visible();assert key=='tvly-fixture-key'
    expect(page.get_by_label('API 密钥')).to_have_value('')
    nav(page,'/notes');page.get_by_role('button',name='新建笔记').click()
    page.get_by_label('笔记名称').fill('出行备忘');page.get_by_label('笔记内容').fill('地址、时间及需要携带的材料。\n第二行内容。')
    for width,height in [(320,640),(390,844),(430,844),(390,470)]:
        page.set_viewport_size({'width':width,'height':height});page.wait_for_timeout(200)
        editor=page.get_by_role('dialog',name='编辑笔记');assert editor.bounding_box()['height']==height
        assert page.get_by_label('笔记内容').bounding_box()['height']>80
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        page.screenshot(path=str(OUT/f'editor-{width}-{height}.png'))
    page.set_viewport_size({'width':390,'height':844});page.get_by_role('button',name='保存',exact=True).click()
    expect(page.locator('.note-row')).to_have_count(1);first=next(iter(notes))
    assert notes[first]['content'].startswith('地址')
    page.get_by_role('button',name='新建笔记').click();page.get_by_label('笔记名称').fill('工作记录');page.get_by_label('笔记内容').fill('会议事项');page.get_by_role('button',name='保存',exact=True).click()
    expect(page.locator('.note-row')).to_have_count(2)
    page.get_by_label('搜索笔记').fill('出行');expect(page.locator('.note-row')).to_have_count(1)
    page.locator('.note-main').click();page.get_by_label('笔记内容').fill('尚未保存的修改')
    page.get_by_role('button',name='返回笔记列表').click();expect(page.get_by_role('dialog',name='放弃修改',exact=True)).to_be_visible()
    page.get_by_role('button',name='取消',exact=True).click();expect(page.get_by_label('笔记内容')).to_have_value('尚未保存的修改')
    page.get_by_role('button',name='返回笔记列表').click();page.get_by_role('button',name='放弃修改',exact=True).click()
    before=len(reads);page.get_by_role('button',name='读取笔记',exact=True).click()
    page.locator('.composer textarea').wait_for();expect(page.locator('.composer textarea')).to_contain_text('')
    text=page.locator('.composer textarea').input_value();assert '出行备忘' in text and first in text and 'read_note' in text
    assert len(reads)==before,'Selecting read must only prefill, without fetching contents or sending'
    page.get_by_role('button',name='展开快捷工具',exact=True).click()
    expect(page.locator('.orbit-tool').filter(has_text='任务')).to_have_count(0)
    page.get_by_role('button',name='笔记',exact=True).click();expect(page.locator('.note-library.embedded')).to_be_visible()
    icons=[page.get_by_role('button',name=name,exact=True).locator('svg path').get_attribute('d') for name in ['笔记','版本工具','上下文用量','提示词']]
    assert len(set(icons))==4,'Shortcut icons must have distinct identities'
    assert 'M4 16h3' not in icons[0] and icons[2].startswith('M4 15a7')
    # Touches inside teleported editors and confirmations must not dismiss the parent card.
    page.locator('.note-main').filter(has_text='出行备忘').tap()
    expect(page.get_by_role('dialog',name='编辑笔记')).to_be_visible()
    page.get_by_label('笔记内容').tap()
    page.get_by_label('笔记内容').fill('会话内编辑后保存')
    page.get_by_label('笔记内容').press('Escape')
    expect(page.get_by_role('dialog',name='放弃修改',exact=True)).to_be_visible()
    page.get_by_role('button',name='取消',exact=True).tap()
    page.get_by_role('button',name='保存',exact=True).tap()
    expect(page.locator('.note-library.embedded')).to_be_visible()
    assert notes[first]['content']=='会话内编辑后保存'
    page.get_by_role('button',name='新建笔记').tap()
    page.get_by_label('笔记名称').tap();page.get_by_label('笔记名称').fill('未保存笔记')
    page.get_by_label('笔记内容').tap();page.get_by_label('笔记内容').fill('未保存内容')
    page.get_by_role('button',name='返回笔记列表').tap()
    page.get_by_role('button',name='取消',exact=True).tap()
    expect(page.get_by_label('笔记内容')).to_have_value('未保存内容')
    page.get_by_role('button',name='返回笔记列表').tap()
    page.get_by_role('button',name='放弃修改',exact=True).tap()
    expect(page.locator('.note-library.embedded')).to_be_visible()
    page.get_by_role('button',name='删除笔记').first.tap()
    page.get_by_role('button',name='取消',exact=True).tap()
    expect(page.locator('.note-row')).to_have_count(2)
    page.screenshot(path=str(OUT/'notes-fan.png'))
    for theme in ['light','dark','book','orange','ink','abyss','ember','celadon','linen']:
        page.evaluate('(theme)=>document.documentElement.dataset.theme=theme',theme)
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        page.screenshot(path=str(OUT/f'notes-{theme}.png'))
    nav(page,'/notes');page.get_by_role('button',name='删除笔记').first.click();page.get_by_role('button',name='删除',exact=True).click();expect(page.locator('.note-row')).to_have_count(1)
    nav(page,'/catalog');page.get_by_role('button',name='联网',exact=True).click();expect(page.get_by_text('已配置',exact=True)).to_be_visible()
    page.get_by_role('button',name='移除密钥',exact=True).click();expect(page.get_by_text('未配置',exact=True)).to_be_visible();assert not key
    for width in [320,390,430]:
        page.set_viewport_size({'width':width,'height':844});assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        page.screenshot(path=str(OUT/f'search-{width}.png'))
    assert not errors,errors
    report={'passed':['search key save, masked reload and removal','two notes save as separate entries','full screen editor at mobile sizes','search, discard confirmation and delete','read prefills name and ID without fetching or sending','fan notes replace tasks','embedded editor touch, save, discard and deletion confirmation','editor Escape preserves parent panel','distinct notebook, Git and usage icons','all nine palettes'],'pageErrors':errors}
    (OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(report,ensure_ascii=False))
    browser.close()
