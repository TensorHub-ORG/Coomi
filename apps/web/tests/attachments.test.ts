import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeAttachments, buildAttachmentRequest, parseAttachmentRequest } from '../src/utils/attachments.ts'

test('uploads retain paths, image thumbnails and readable names without duplicate imports', () => {
  const files = normalizeAttachments(['/tmp/设计 图.png', '/tmp/report.pdf', '/tmp/设计 图.png'])
  assert.equal(files.length, 2)
  assert.equal(files[0].kind, 'image')
  assert.equal(files[0].name, '设计 图.png')
  const request = buildAttachmentRequest('请比较附件', files)
  assert.deepEqual(parseAttachmentRequest(request), { text: '请比较附件', attachments: files })
})

test('attachment-only tasks reload without exposing the transport instruction', () => {
  const files = normalizeAttachments(['/tmp/photo.webp'])
  assert.deepEqual(parseAttachmentRequest(buildAttachmentRequest('', files)), { text: '', attachments: files })
  assert.deepEqual(parseAttachmentRequest('请读取这些已导入文件：\n/tmp/photo.webp'), { text: '', attachments: files })
  assert.deepEqual(parseAttachmentRequest('分析图片\n\n请读取这些已导入文件：\n/tmp/photo.webp'), { text: '分析图片', attachments: files })
})

test('malformed attachment metadata does not consume user-authored content', () => {
  for (const content of ['普通内容', '<coomi_attachments>{bad}</coomi_attachments>', '<coomi_attachments>{"paths":[3]}</coomi_attachments>']) {
    assert.deepEqual(parseAttachmentRequest(content), { text: content, attachments: [] })
  }
})
