import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
const setup = 'G:/DSH/coomi-full-project/apps/desktop/target/release/bundle/nsis/Coomi_0.9.9-rc31_x64-setup.exe'
const buf = readFileSync(setup)
const sha256 = createHash('sha256').update(buf).digest('hex')
const notes = readFileSync('G:/DSH/coomi-full-project/scripts/rc31-notes.txt', 'utf8').trim()
const raw = 'https://raw.githubusercontent.com/TensorHub-ORG/Coomi/refs/heads/coomi-desktop/windows/Coomi_0.9.9-rc31_x64-setup.exe'
const manifest = {
  code: 217,
  name: 'Beta0.9.9-rc31',
  url: raw,
  size: buf.length,
  sha256,
  channel: 'beta',
  published_at: new Date().toISOString().slice(0, 10),
  notes,
  urls: [
    'https://gh-proxy.com/' + raw,
    'https://cdn.jsdelivr.net/gh/TensorHub-ORG/Coomi@coomi-desktop/windows/Coomi_0.9.9-rc31_x64-setup.exe',
    raw,
  ],
}
writeFileSync('G:/coomi-updates/windows/latest.json', JSON.stringify(manifest), 'utf8')
console.log('size=' + buf.length + ' sha256=' + sha256)