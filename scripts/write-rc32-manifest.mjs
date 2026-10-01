import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
const setup = 'G:/DSH/coomi-full-project/apps/desktop/target/release/bundle/nsis/Coomi_0.9.9-rc32_x64-setup.exe'
const buf = readFileSync(setup)
const sha256 = createHash('sha256').update(buf).digest('hex')
const notes = readFileSync('G:/DSH/coomi-full-project/scripts/rc32-notes.txt', 'utf8').trim()
const raw = 'https://raw.githubusercontent.com/TensorHub-ORG/Coomi/refs/heads/coomi-desktop/windows/Coomi_0.9.9-rc32_x64-setup.exe'
writeFileSync('G:/coomi-updates/windows/latest.json', JSON.stringify({
  code: 218, name: 'Beta0.9.9-rc32', url: raw, size: buf.length, sha256, channel: 'beta',
  published_at: new Date().toISOString().slice(0, 10), notes,
  urls: ['https://gh-proxy.com/' + raw, 'https://cdn.jsdelivr.net/gh/TensorHub-ORG/Coomi@coomi-desktop/windows/Coomi_0.9.9-rc32_x64-setup.exe', raw],
}), 'utf8')
console.log('size=' + buf.length + ' sha256=' + sha256)