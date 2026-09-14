import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  attachmentFromPath,
  buildAttachmentRequest,
  normalizeAttachments,
  parseAttachmentRequest,
} from '../src/utils/attachments.ts'
import { normalizeDisplayScale } from '../src/utils/displayScale.ts'

test('attachment metadata keeps real paths while producing mobile-friendly labels', () => {
  assert.deepEqual(attachmentFromPath('/data/data/app/files/photo.webp'), {
    path: '/data/data/app/files/photo.webp', name: 'photo.webp', kind: 'image',
  })
  assert.equal(attachmentFromPath('C:\\Work\\report.pdf').name, 'report.pdf')
  assert.deepEqual(normalizeAttachments(['/tmp/a.png', '/tmp/a.png', '  /tmp/b.txt  ']).map(item => item.name), ['a.png', 'b.txt'])
})

test('attachment transport block is reversible and hidden from displayed text', () => {
  const attachments = normalizeAttachments(['/home/user/设计 图.png', '/home/user/spec.md'])
  const request = buildAttachmentRequest('请比较这两个文件', attachments)
  assert.match(request, /<coomi_attachments>/)
  assert.match(request, /设计 图\.png/)
  assert.deepEqual(parseAttachmentRequest(request), { text: '请比较这两个文件', attachments })
  assert.deepEqual(parseAttachmentRequest('普通消息'), { text: '普通消息', attachments: [] })
})

test('display scale clamps to the supported app-only range', () => {
  assert.equal(normalizeDisplayScale('0.85'), 0.85)
  assert.equal(normalizeDisplayScale(0.4), 0.75)
  assert.equal(normalizeDisplayScale(2), 1.1)
  assert.equal(normalizeDisplayScale('bad'), 1)
})

test('composer keeps imported attachments outside the visible prompt', () => {
  const composer = readFileSync(new URL('../src/components/Composer.vue', import.meta.url), 'utf8')
  const session = readFileSync(new URL('../src/stores/session.ts', import.meta.url), 'utf8')
  const bubble = readFileSync(new URL('../src/components/MessageBubble.vue', import.meta.url), 'utf8')
  assert.match(composer, /const attachments = ref<ChatAttachment\[\]>/)
  assert.doesNotMatch(composer, /insert\(`请读取这些已导入文件/)
  assert.match(composer, /session\.sendMessage\(text\.value, attachments\.value\)/)
  assert.match(session, /buildAttachmentRequest\(displayText, attachments\)/)
  assert.match(session, /parseAttachmentRequest\(m\.content\)/)
  assert.match(bubble, /<AttachmentStrip v-if="userAttachments\.length"/)
})

test('composer gives text and attachments one shared bounded scroll area', () => {
  const composer = readFileSync(new URL('../src/components/Composer.vue', import.meta.url), 'utf8')
  assert.match(composer, /class="composer-content"/)
  assert.match(composer, /\.composer-content\s*\{[^}]*max-height:[^;}]*132px[^}]*overflow-y:\s*auto/s)
  assert.doesNotMatch(composer, /textareaScrollable/)
})

test('display scale is persisted by Android and applied to web app content', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
  const appearance = readFileSync(new URL('../src/views/AppearanceView.vue', import.meta.url), 'utf8')
  const theme = readFileSync(new URL('../../coomi-app/app/src/main/java/app/coomi/CoomiTheme.java', import.meta.url), 'utf8')
  const bridge = readFileSync(new URL('../../coomi-app/app/src/main/java/com/termux/app/CoomiChatSession.java', import.meta.url), 'utf8')
  assert.match(main, /function applyDisplayScale/)
  assert.match(main, /body\.style\.zoom/)
  assert.match(main, /--coomi-display-viewport-height/)
  assert.match(readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8'), /var\(--coomi-display-viewport-height,\s*100dvh\)/)
  assert.match(appearance, /软件显示比例/)
  assert.match(theme, /getDisplayScale/)
  assert.match(theme, /root\.put\("displayScale"/)
  assert.match(bridge, /public void setDisplayScale\(double scale\)/)
})

test('appearance controls fit the app viewport without an inner page scrollbar', () => {
  const appearance = readFileSync(new URL('../src/views/AppearanceView.vue', import.meta.url), 'utf8')
  const nativeAppearance = readFileSync(new URL('../../coomi-app/app/src/main/res/layout/activity_coomi_appearance.xml', import.meta.url), 'utf8')
  assert.match(appearance, /\.body\s*\{[^}]*overflow:\s*hidden/s)
  assert.match(appearance, /\.theme-options\s*\{[^}]*grid-template-columns/s)
  assert.ok(nativeAppearance.indexOf('android:text="显示比例"') < nativeAppearance.indexOf('android:text="主题风格"'))
  assert.equal((nativeAppearance.match(/@\+id\/seek_display_scale/g) ?? []).length, 1)
})

test('auxiliary transcript applies a scoped compact density', () => {
  const auxiliary = readFileSync(new URL('../src/components/AuxiliaryChat.vue', import.meta.url), 'utf8')
  assert.match(auxiliary, /--aux-density:/)
  assert.match(auxiliary, /\.transcript\s*:deep\(\.bubble\)/)
  assert.match(auxiliary, /\.transcript\s*:deep\(\.tool\)/)
})

test('account-backed provider entries disclose account risk and keep Zhipu official key path', () => {
  const deepseek = readFileSync(new URL('../src/views/DeepSeekLoginView.vue', import.meta.url), 'utf8')
  const providers = readFileSync(new URL('../src/views/ProvidersView.vue', import.meta.url), 'utf8')
  const detail = readFileSync(new URL('../src/views/ProviderDetailView.vue', import.meta.url), 'utf8')
  assert.match(deepseek, /可能触发风控、限流或账号异常/)
  assert.match(deepseek, /我已了解风险/)
  assert.match(providers, /智谱账号 \/ API Key/)
  assert.match(providers, /router\.push\('\/providers\/zhipu'\)/)
  assert.match(detail, /智谱 Coding Plan/)
})
