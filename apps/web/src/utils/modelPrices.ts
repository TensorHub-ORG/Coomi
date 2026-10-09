/** Public per-million-token reference prices; provider quotations take precedence. Unknown is not zero. */
import catalog from './modelPriceCatalog.json'
export interface ModelPrice { in: number; out: number; cached?: number | null; currency: string; source: string; url?: string; retrievedAt?: string; note?: string }
export const MODEL_PRICES = catalog as Record<string, ModelPrice>
export function priceFor(model: string): ModelPrice | null {
  const key = model.trim().toLowerCase()
  if (MODEL_PRICES[key]) return MODEL_PRICES[key]
  // Longest match first, with a version delimiter: gpt-4 must not match gpt-4o-mini.
  return Object.entries(MODEL_PRICES).sort(([a],[b]) => b.length-a.length).find(([name]) => key.startsWith(name+'-') || key.endsWith('/'+name))?.[1] ?? null
}
export function costWithPrice(price: ModelPrice | null, input: number, output: number, cached = 0): number | null {
  if (!price) return null
  const i = Math.max(0,input), o = Math.max(0,output), c = Math.max(0,Math.min(i,cached))
  return ((i-c)*price.in + c*(price.cached ?? price.in) + o*price.out)/1e6
}
export function costUsd(model: string, input: number, output: number, cached=0): number | null {
  const p=priceFor(model); return p?.currency === 'USD' ? costWithPrice(p,input,output,cached) : null
}
export const CNY_PER_USD=7.2 // Only a user-visible reference conversion, never balance accounting.
export function costCny(model: string, input:number, output:number, cached=0):number|null {
  const cost=costUsd(model,input,output,cached);return cost == null ? null : cost*CNY_PER_USD
}
export function fmtMoney(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '未提供'
  return value.toFixed(6).replace(/0+$/, '').replace(/\.$/,'') || '0'
}
