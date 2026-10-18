"""Validate the prepared website without writing production analytics."""
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'build/comax-batch23'
def main():
    server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(SimpleHTTPRequestHandler,directory=str(OUT)))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(channel='chrome',headless=True)
            page=browser.new_page(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
            def route(r):
                if urlparse(r.request.url).hostname=='127.0.0.1' and not '/api/' in r.request.url:r.continue_()
                else:r.fulfill(json={'ok':True,'total':0,'versions':[]})
            page.route('**/*',route)
            page.goto(f'http://127.0.0.1:{server.server_port}/website-preview.html',wait_until='networkidle')
            test=page.locator('[data-test-download="android"]')
            expect(test).to_be_visible(); assert 'v1.5.0-test.4.apk' in test.get_attribute('href')
            assert 'v1.5.0-test.4' in test.inner_text()
            stable=page.locator('#downloadButtonAndroid').get_attribute('href'); assert 'v1.4.9-fix.6.apk' in stable
            page.locator('[data-channel-tab="test"]').click()
            panel=page.locator('[data-channel-panel="test"]')
            expect(panel.locator(':scope > h2.changelog-title')).to_have_count(1)
            expect(panel.locator(':scope > h2.changelog-title')).to_have_text('v1.5.0-test.4 更新说明【测试】')
            history=panel.locator('details.changelog-history').first
            assert history.get_attribute('open') is None
            expect(history.get_by_text('v1.5.0-test.1 更新说明【测试】',exact=True)).not_to_be_visible()
            history.locator('summary').first.click()
            expect(history.get_by_text('v1.5.0-test.1 更新说明【测试】',exact=True)).to_be_visible()
            for width in [390,1440]:
                page.set_viewport_size({'width':width,'height':900})
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            assert 'Coomi_1.0.0-test.3_x64-setup.exe' in page.locator('#downloadButtonDesktop').get_attribute('href')
            report={'latestHeading':'v1.5.0-test.4 更新说明【测试】','latestOnlyByDefault':True,'historyExpands':True,'testDownloadUpdated':True,'stableDownloadPreserved':stable,'desktopDownloadPreserved':True,'responsiveWidths':[390,1440]}
            (OUT/'site-ui-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
            print(json.dumps(report,ensure_ascii=False));browser.close()
    finally:server.shutdown()
if __name__=='__main__':main()
