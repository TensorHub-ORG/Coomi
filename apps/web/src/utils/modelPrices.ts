/**
 * 内置模型价格表（单位：美元 / 每 1M token）。
 * 输入=标准输入价；输出=输出价；命中缓存输入按 20% 计（各厂商惯例近似值）。
 * 未收录的模型按 DEFAULT 计价，方便用户估个大概。
 */
export interface ModelPrice {
  in: number
  out: number
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  // OpenAI
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4.1': { in: 2, out: 8 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 },
  'gpt-4.1-nano': { in: 0.1, out: 0.4 },
  'gpt-4-turbo': { in: 10, out: 30 },
  'gpt-4': { in: 30, out: 60 },
  'gpt-3.5-turbo': { in: 0.5, out: 1.5 },
  'o1': { in: 15, out: 60 },
  'o1-mini': { in: 3, out: 12 },
  'o3': { in: 2, out: 8 },
  'o3-mini': { in: 1.1, out: 4.4 },
  'o4-mini': { in: 1.1, out: 4.4 },
  'gpt-4o-realtime': { in: 5, out: 20 },
  'gpt-4o-audio': { in: 2.5, out: 10 },
  'chatgpt-4o-latest': { in: 5, out: 15 },

  // Anthropic Claude
  'claude-3-opus-20240229': { in: 15, out: 75 },
  'claude-3-sonnet-20240229': { in: 3, out: 15 },
  'claude-3-haiku-20240307': { in: 0.25, out: 1.25 },
  'claude-3-5-sonnet-20240620': { in: 3, out: 15 },
  'claude-3-5-sonnet-20241022': { in: 3, out: 15 },
  'claude-3-5-haiku-20241022': { in: 0.8, out: 4 },
  'claude-3-7-sonnet-20250219': { in: 3, out: 15 },
  'claude-sonnet-4-20250514': { in: 3, out: 15 },
  'claude-opus-4-20250514': { in: 15, out: 75 },
  'claude-opus-4-1': { in: 15, out: 75 },
  'claude-sonnet-4-5': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },

  // DeepSeek
  'deepseek-chat': { in: 0.27, out: 1.1 },
  'deepseek-reasoner': { in: 0.55, out: 2.19 },
  'deepseek-v3': { in: 0.27, out: 1.1 },
  'deepseek-r1': { in: 0.55, out: 2.19 },
  'deepseek-v3.2': { in: 0.28, out: 0.42 },
  'deepseek-v3.1': { in: 0.27, out: 1.1 },

  // Gemini
  'gemini-1.5-pro': { in: 1.25, out: 5 },
  'gemini-1.5-flash': { in: 0.075, out: 0.3 },
  'gemini-1.5-flash-8b': { in: 0.0375, out: 0.15 },
  'gemini-2.0-flash': { in: 0.1, out: 0.4 },
  'gemini-2.0-flash-lite': { in: 0.075, out: 0.3 },
  'gemini-2.5-pro': { in: 1.25, out: 10 },
  'gemini-2.5-flash': { in: 0.3, out: 2.5 },
  'gemini-2.5-flash-lite': { in: 0.1, out: 0.4 },
  'gemini-2.5-flash-preview': { in: 0.3, out: 2.5 },
  'gemini-exp-1206': { in: 1.25, out: 5 },
  'gemini-2.0-flash-thinking': { in: 0.3, out: 2.5 },

  // 智谱 GLM
  'glm-4': { in: 0.1, out: 0.1 },
  'glm-4-plus': { in: 0.05, out: 0.05 },
  'glm-4-air': { in: 0.001, out: 0.001 },
  'glm-4-flash': { in: 0, out: 0 },
  'glm-4-long': { in: 0.1, out: 0.1 },
  'glm-4.5': { in: 0.1, out: 0.1 },
  'glm-4.5-air': { in: 0.001, out: 0.001 },
  'glm-4.6': { in: 0.1, out: 0.1 },
  'glm-z1': { in: 0.05, out: 0.05 },
  'glm-z1-air': { in: 0.001, out: 0.001 },

  // 阿里 Qwen
  'qwen-max': { in: 2.4, out: 9.6 },
  'qwen-plus': { in: 0.8, out: 2 },
  'qwen-turbo': { in: 0.3, out: 0.6 },
  'qwen-long': { in: 0.5, out: 2 },
  'qwen2.5-max': { in: 2.4, out: 9.6 },
  'qwen2.5-plus': { in: 0.8, out: 2 },
  'qwen2.5-turbo': { in: 0.3, out: 0.6 },
  'qwen3-max': { in: 1.2, out: 6 },
  'qwen3-plus': { in: 0.5, out: 1.6 },
  'qwen3-turbo': { in: 0.1, out: 0.3 },
  'qwen-vl-max': { in: 3, out: 9 },
  'qwen-vl-plus': { in: 1.5, out: 4.5 },

  // 字节豆包
  'doubao-pro-32k': { in: 0.8, out: 2 },
  'doubao-pro-128k': { in: 2, out: 5 },
  'doubao-lite-32k': { in: 0.3, out: 0.8 },
  'doubao-1.5-pro-32k': { in: 0.8, out: 2 },
  'doubao-1.5-pro-256k': { in: 2, out: 5 },
  'doubao-1.5-lite-32k': { in: 0.3, out: 0.8 },

  // 月之暗面 Kimi
  'moonshot-v1-8k': { in: 1.2, out: 6 },
  'moonshot-v1-32k': { in: 1.2, out: 6 },
  'moonshot-v1-128k': { in: 6, out: 6 },
  'moonshot-v1-auto': { in: 1.2, out: 6 },
  'kimi-latest': { in: 1.2, out: 6 },
  'kimi-k2-0711': { in: 0.6, out: 2.5 },
  'kimi-k2-turbo': { in: 0.4, out: 8 },
  'kimi-thinking': { in: 1.2, out: 6 },

  // 百度文心
  'ernie-4.0-turbo-8k': { in: 0.6, out: 2 },
  'ernie-4.0-8k': { in: 0.6, out: 2 },
  'ernie-3.5-8k': { in: 0.12, out: 0.4 },
  'ernie-speed-8k': { in: 0.06, out: 0.06 },
  'ernie-speed-128k': { in: 0.03, out: 0.06 },

  // 腾讯混元
  'hunyuan-turbo': { in: 0.2, out: 0.6 },
  'hunyuan-pro': { in: 0.2, out: 0.6 },
  'hunyuan-standard': { in: 0.1, out: 0.3 },
  'hunyuan-lite': { in: 0.03, out: 0.03 },

  // Grok / xAI
  'grok-3': { in: 3, out: 15 },
  'grok-3-mini': { in: 0.3, out: 0.5 },
  'grok-3-fast': { in: 3, out: 15 },
  'grok-2': { in: 2, out: 10 },
  'grok-2-mini': { in: 0.2, out: 1 },
  'grok-4': { in: 3, out: 15 },
  'grok-4-6': { in: 3, out: 15 },
  'grok-4-fast': { in: 3, out: 15 },

  // Mistral
  'mistral-large-latest': { in: 2, out: 6 },
  'mistral-small-latest': { in: 0.2, out: 0.6 },
  'codestral-latest': { in: 0.3, out: 0.9 },

  // Llama（各家托管价近似）
  'llama-3.3-70b': { in: 0.6, out: 0.8 },
  'llama-3.1-8b': { in: 0.1, out: 0.1 },
  'llama-3.1-405b': { in: 3, out: 3 },
  'llama-4-scout': { in: 0.15, out: 0.6 },
  'llama-4-maverick': { in: 0.2, out: 0.8 },

  // 其他常见
  'command-r-plus': { in: 2.5, out: 10 },
  'command-r': { in: 0.5, out: 1.5 },
  'jamba-1.5-large': { in: 2, out: 8 },
  'nemotron-4-340b': { in: 4, out: 4 },
}

/** 未收录模型的兜底价（美元/M）。 */
const DEFAULT_PRICE: ModelPrice = { in: 1, out: 2 }

/** 人民币汇率（估算，仅用于本地展示）。 */
export const CNY_PER_USD = 7.2

/** 缓存命中输入按 20% 计价（近似）。 */
export const CACHE_INPUT_RATE = 0.2

export function priceFor(model: string): ModelPrice {
  // 去掉可能的厂商前缀 / 版本后缀再匹配
  const bare = model.trim().toLowerCase()
  const direct = MODEL_PRICES[bare]
  if (direct) return direct
  for (const [key, price] of Object.entries(MODEL_PRICES)) {
    if (bare.startsWith(key)) return price
  }
  return DEFAULT_PRICE
}

/**
 * 计算 token 消耗金额（美元）。
 * inputTokens 已含缓存命中（cached 单独传入）。
 */
export function costUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
): number {
  const p = priceFor(model)
  const paidInput = Math.max(0, inputTokens - cachedInputTokens)
  const cacheInput = Math.max(0, cachedInputTokens)
  const cost =
    (paidInput / 1e6) * p.in +
    (cacheInput / 1e6) * p.in * CACHE_INPUT_RATE +
    (outputTokens / 1e6) * p.out
  return cost
}

export function costCny(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
): number {
  return costUsd(model, inputTokens, outputTokens, cachedInputTokens) * CNY_PER_USD
}

/** 金额格式化：保留 4 位有效小数，去尾零。 */
export function fmtMoney(value: number): string {
  if (!Number.isFinite(value)) return '0'
  if (value === 0) return '0'
  if (value >= 100) return value.toFixed(2)
  if (value >= 1) return value.toFixed(3)
  return value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
}
