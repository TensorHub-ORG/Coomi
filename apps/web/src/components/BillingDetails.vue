<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue'
import { useSessionStore } from '@/stores/session'
import { useConfigStore } from '@/stores/config'
import { apiGet } from '@/bridge/http'
import { costWithPrice, fmtMoney, priceFor, type ModelPrice } from '@/utils/modelPrices'
const session = useSessionStore()
const config = useConfigStore()
// Currency and prices come from the currently selected session provider, not global active config.
const balanceOpen = ref(true)
const balances = ref<Array<{ currency: string; amount: number }>>([])
const balanceLoading = ref(false), balanceError = ref('')
const livePrice = ref<ModelPrice | null>(null)
const priceLoading = ref(false)
const modelUnit = computed(() => livePrice.value ?? priceFor(config.currentModel))
interface BillingRecord { turn_id: string; provider_id: string; model: string; input_tokens: number; cached_input_tokens: number; output_tokens: number }
const billingRecords = ref<BillingRecord[]>([])
const billingNote = ref(''), billingError = ref('')
let fetchVersion = 0
async function fetchBalance() {
  const version = ++fetchVersion, provider = config.currentProviderId, model = config.currentModel, id = session.sessionId
  balanceLoading.value = true; priceLoading.value = true; balanceError.value = ''; billingError.value = ''
  const query = `provider_id=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`
  await Promise.all([
    apiGet<{ ok: boolean; balances: Array<{ currency: string; amount: number }> }>(`/api/balance?${query}`)
      .then(data => { if (version===fetchVersion) balances.value = data.balances ?? [] })
      .catch(e => { if (version===fetchVersion) { balances.value=[]; balanceError.value=String(e) } })
      .finally(() => {if(version===fetchVersion) balanceLoading.value=false}),
    apiGet<ModelPrice>(`/api/model-pricing?${query}`)
      .then(data => {if(version===fetchVersion) livePrice.value=data})
      .catch(() => {if(version===fetchVersion) livePrice.value=null})
      .finally(() => {if(version===fetchVersion) priceLoading.value=false}),
    apiGet<{ records: BillingRecord[]; note: string }>(`/api/sessions/${id}/billing`)
      .then(data => {if(version===fetchVersion) {billingRecords.value=data.records;billingNote.value=data.note}})
      .catch(e => {if(version===fetchVersion) {billingRecords.value=[];billingError.value=String(e)}}),
  ])
}
function totals(records: BillingRecord[]): { amounts: Record<string,number>; unknown: number } {
  const amounts:Record<string,number>={};let unknown=0
  for(const record of records) {
    const p = record.model===config.currentModel && record.provider_id===config.currentProviderId ? modelUnit.value : priceFor(record.model)
    const cost=costWithPrice(p,record.input_tokens,record.output_tokens,record.cached_input_tokens)
    if(cost==null||!p) {unknown++;continue}
    amounts[p.currency]=(amounts[p.currency]??0)+cost
  }
  return {amounts,unknown}
}
const sessionCost = computed(() => totals(billingRecords.value))
const turnCost = computed(() => {
  const last=billingRecords.value[billingRecords.value.length - 1]?.turn_id
  return totals(billingRecords.value.filter(r=>r.turn_id===last))
})
watch([()=>config.currentProviderId,()=>config.currentModel,()=>session.sessionId],()=>{livePrice.value=null;balances.value=[];billingRecords.value=[];if(balanceOpen.value)void fetchBalance()})
watch(()=>session.runState,(v)=>{if(v==='idle'&&balanceOpen.value)void fetchBalance()})

onMounted(() => { void fetchBalance() })
</script>
<template>
      <section class="billing-details" aria-label="余额与计费">
        <p class="usage-title">余额与计费</p>
        <div class="balance-row"><span>{{ config.currentProviderId }}</span><button @click="fetchBalance">刷新</button></div>
        <p v-if="balanceLoading" class="usage-empty">余额查询中…</p>
        <p v-else-if="balanceError" class="usage-empty">{{ balanceError }}</p>
        <div v-for="item in balances" :key="item.currency" class="balance-row"><span>账户余额 · {{ item.currency }}</span><strong>{{ fmtMoney(item.amount) }}</strong></div>
        <p class="usage-subtitle">当前模型单价 · 每百万 Token</p>
        <template v-if="modelUnit">
          <div class="balance-row"><span>输入 / 输出</span><strong>{{ modelUnit.currency }} {{ fmtMoney(modelUnit.in) }} / {{ fmtMoney(modelUnit.out) }}</strong></div>
          <div class="balance-row"><span>缓存命中输入</span><strong>{{ modelUnit.cached == null ? '未公布，按普通输入估算' : modelUnit.currency+' '+fmtMoney(modelUnit.cached) }}</strong></div>
          <p class="usage-empty">{{ modelUnit.source }} · {{ modelUnit.note || '参考单价；最终扣费以服务商账单为准' }}</p>
        </template>
        <p v-else class="usage-empty">{{ priceLoading ? '价格查询中…' : '该服务商未公布单价，且本地未收录；不会使用虚构默认价' }}</p>
        <p class="usage-subtitle">本轮消耗 · 含输入、输出、缓存</p>
        <div v-for="(cost,currency) in turnCost.amounts" :key="currency" class="balance-row"><span>{{ currency }}</span><strong>≈ {{ fmtMoney(cost) }}</strong></div>
        <p v-if="turnCost.unknown" class="usage-empty">{{ turnCost.unknown }} 次请求缺少单价，未计入估算</p>
        <p class="usage-subtitle">当前会话消耗 · 按实际调用模型累计</p>
        <div v-for="(cost,currency) in sessionCost.amounts" :key="currency" class="balance-row"><span>{{ currency }}</span><strong>≈ {{ fmtMoney(cost) }}</strong></div>
        <p v-if="sessionCost.unknown" class="usage-empty">{{ sessionCost.unknown }} 次请求缺少单价，未计入估算</p>
        <p class="usage-empty">{{ billingError || billingNote || '尚无已记录的 API 请求' }}</p>
      </section>
</template>
<style scoped>
.billing-details { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); }
.usage-title { font-size: 12px; font-weight: 650; color: var(--text-2); }
.usage-subtitle { margin: 12px 0 6px; font-size: 11.5px; font-weight: 650; }
.usage-empty { font-size: 11px; line-height: 1.6; color: var(--text-3); overflow-wrap: anywhere; }
.balance-row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin: 7px 0; font-size: 12px; }
.balance-row strong { font-family: var(--font-mono); overflow-wrap: anywhere; text-align: right; }
.balance-row button { background: var(--blue-soft); color: var(--blue); padding: 4px 8px; border-radius: 7px; }
</style>
