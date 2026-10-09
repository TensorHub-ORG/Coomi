import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (file) => readFileSync(new URL(file, root), 'utf8')
const catalog = JSON.parse(read('src/utils/modelPriceCatalog.json'))
test('unknown prices have no invented fallback; cached tokens bounded', () => {
 const source = read('src/utils/modelPrices.ts')
 assert(!source.includes('DEFAULT_PRICE'))
 assert(source.includes('Math.min(i,cached)'))
 assert(Object.keys(catalog).length > 200)
 for(const item of Object.values(catalog)) {assert(Number.isFinite(item.in));assert(Number.isFinite(item.out));assert(item.source.startsWith('models.dev/'))}
})
test('balance toggle opens visible currency-preserving panel', () => {
 const top=read('src/components/BillingDetails.vue')
 assert(top.includes('class="billing-details"'))
 assert(top.includes('provider_id=${encodeURIComponent(provider)}'))
 assert(top.includes('item.currency'))
 assert(!top.includes('amount * 7.2'))
 assert(top.includes('record.input_tokens,record.output_tokens,record.cached_input_tokens'))
})
test('DeepTrace injection removed; permission default synced before commands', () => {
 const html=read('index.html'), session=read('src/stores/session.ts')
 assert(!html.includes('deeptrace')); assert(!html.includes('coomi-patch'))
 assert(session.includes('await config.syncStartupPermission()'))
})

test('global animation off disables UI switch and remains reversible',()=>{
 const app=read('src/App.vue'),config=read('src/stores/config.ts'),settings=read('src/views/SettingsView.vue')
 assert(app.includes('getChildren(true, true, true)'))
 assert(!app.includes('globalTimeline?.kill()'))
 assert(config.includes("sendMorphAnimation.value = false"))
 assert(settings.includes(':disabled="config.allAnimationsOff"'))
 assert(read('src/composables/useGsap.ts').includes('allAnimationsOff'))
})
