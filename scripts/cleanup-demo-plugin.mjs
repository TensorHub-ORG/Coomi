import { readFileSync, writeFileSync } from 'node:fs'
const path = 'C:/Users/Monai-Bob/AppData/Roaming/Coomi/plugins.json'
const map = JSON.parse(readFileSync(path, 'utf8'))
delete map['demo-page']
writeFileSync(path, JSON.stringify(map), 'utf8')
console.log('plugins.json =', JSON.stringify(map))