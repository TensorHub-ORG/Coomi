import { readFileSync } from 'node:fs'
const buf = readFileSync('G:/CoomiN/coomi.exe')
const needles = ['【以下是', '历史背景', '不是当前问题', 'github_prefix', 'COOMI_DISABLE_PROMPT_CACHE']
for (const n of needles) {
  console.log(n + ' => ' + buf.includes(Buffer.from(n, 'utf8')))
}
// 技能安装那条镜像路径：确认内置目录安装也带上前缀（模板串 '${}https://codeload.github.com/'）
console.log('codeload 模板 => ' + buf.includes(Buffer.from('codeload.github.com/', 'utf8')))