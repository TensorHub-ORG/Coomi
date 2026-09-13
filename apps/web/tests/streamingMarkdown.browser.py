"""Run against Vite on 5178: python apps/web/tests/streamingMarkdown.browser.py.
Exercises actual chat components and Pinia state without model/network requests.
"""
import os
from playwright.sync_api import sync_playwright, expect

origin = os.environ.get('COOMI_WEB_URL', 'http://127.0.0.1:5178')
with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    page = browser.new_page(viewport={'width': 390, 'height': 844})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.route('**/api/**', lambda route: route.fulfill(status=503, json={'error': 'offline fixture'}))
    page.goto(origin + '/?demo=1&autoplay=0')
    page.wait_for_selector('.composer')
    result = page.evaluate('''async () => {
      const { nextTick } = await import('/node_modules/.vite/deps/vue.js');
      const { renderMarkdown } = await import('/src/utils/markdown.ts');
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const assert = (value, label) => { if (!value) throw new Error(label); };
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
      const session = pinia._s.get('session');
      assert(session, 'session store is mounted');
      session.timeline = [{kind:'assistant', id:'stream-test', mid:'test', streaming:true,
        content:'Stable **bold** paragraph.\\n\\n```text\\nline one\\n'}];
      await nextTick(); await sleep(180);
      const root = document.querySelector('.assistant .md');
      assert(root, 'markdown mounted');
      const paragraph = root.querySelector('p'), bold = root.querySelector('strong');
      const code = root.querySelector('code'), text = code.firstChild;
      const animations = [];
      document.querySelector('.virtual-stream').addEventListener('animationstart', event => {
        if (['rise-in','coomi-cascade'].includes(event.animationName)) animations.push(event.animationName);
      });
      let renders = 0;
      const observer = new MutationObserver(() => { renders++; });
      observer.observe(root, {subtree:true, childList:true, characterData:true});
      for (let i = 0; i < 90; i++) {
        session.timeline[0].content += String(i % 10);
        await sleep(10);
        assert(root.querySelector('p') === paragraph && root.querySelector('strong') === bold,
          'completed paragraph DOM replaced during delta ' + i);
        assert(root.querySelector('code') === code && code.firstChild === text,
          'growing fenced code DOM replaced during delta ' + i);
      }
      session.timeline[0].content += '\\n```\\n\\nAfter code.\\n\\n- First item\\n\\n- Second item\\n\\n[Reference][doc]\\n\\n[doc]: https://example.com\\n\\n<script>alert(1)</script>';
      session.timeline[0].streaming = false;
      await nextTick(); await sleep(180);
      observer.disconnect();
      assert(renders >= 8, 'test must exercise multiple render batches');
      assert(root.querySelector('p') === paragraph && root.querySelector('code') === code,
        'completed prefix replaced on stream completion');
      assert(root.querySelector('ul').querySelectorAll(':scope > li').length === 2, 'loose list split');
      assert(root.querySelector('a').href === 'https://example.com/', 'cross-block reference unresolved');
      assert(root.querySelector('.code-wrap').querySelectorAll('p').length === 0, 'unclosed code wrapper');
      assert(!root.querySelector('script'), 'unsafe markdown survived');
      const expected = document.createElement('div');
      expected.innerHTML = renderMarkdown(session.timeline[0].content);
      assert(root.innerHTML === expected.innerHTML, 'completed markdown differs from full parser');
      assert(animations.length === 0, 'entry animations replayed during streaming');
      assert(getComputedStyle(root).animationName === 'none', 'markdown still animates on remount');
      const rows = Array.from({length:100}, (_, i) => ({kind:'assistant', id:'history-'+i,
        mid:'history-'+i, content:'History '+i+'\\n\\nCompleted paragraph.', streaming:false}));
      session.timeline = rows;
      await nextTick(); await sleep(180);
      const scroller = document.querySelector('.virtual-stream');
      for (const position of [0, 1e6, 0, 1e6]) {
        scroller.scrollTop = position;
        scroller.dispatchEvent(new Event('scroll'));
        await sleep(120);
      }
      assert(animations.length === 0, 'entry fades replayed when recycling history');
      assert(!document.querySelector('.search-toggle'), 'floating search button remains');
      return {renderBatches:renders, deltas:90, recycledRows:100};
    }''')
    page.keyboard.press('Control+f')
    expect(page.locator('.search-bar')).to_be_visible()
    page.keyboard.press('Escape')
    expect(page.locator('.search-bar')).to_have_count(0)
    assert not errors, errors
    print('PASS:', result, 'keyboard search retained; floating button removed')
    browser.close()
