/** Editable defaults only. Saved user values and upstream metadata take priority.
 * Exact IDs/dated aliases avoid guessing capabilities of unknown future models.
 * References: platform.openai.com/docs/models, docs.anthropic.com,
 * ai.google.dev/gemini-api/docs/models, api-docs.deepseek.com, docs.mistral.ai.
 */
export const DEFAULT_MODEL_CONTEXT = 262_144
export const MODEL_CONTEXT_DEFAULTS: Record<string, number> = {
  'gpt-4o': 128_000, 'gpt-4o-mini': 128_000, 'gpt-4-turbo': 128_000,
  'gpt-4.1': 1_047_576, 'gpt-4.1-mini': 1_047_576, 'gpt-4.1-nano': 1_047_576,
  'o1': 200_000, 'o3': 200_000, 'o3-mini': 200_000, 'o4-mini': 200_000,
  'gpt-5': 400_000, 'gpt-5-mini': 400_000, 'gpt-5-nano': 400_000,
  'claude-3-5-sonnet': 200_000, 'claude-3-5-haiku': 200_000,
  'claude-3-7-sonnet': 200_000, 'claude-sonnet-4': 200_000, 'claude-opus-4': 200_000,
  'gemini-2.0-flash': 1_048_576, 'gemini-2.0-flash-lite': 1_048_576,
  'gemini-2.5-flash': 1_048_576, 'gemini-2.5-pro': 1_048_576,
  'deepseek-chat': 128_000, 'deepseek-reasoner': 128_000,
  'qwen2.5-72b-instruct': 131_072, 'qwen2.5-coder-32b-instruct': 131_072,
  'qwen3-32b': 131_072, 'qwen3-235b-a22b': 131_072,
  'qwen3-235b-a22b-instruct-2507': 262_144, 'qwen3-coder-480b-a35b-instruct': 262_144,
  'glm-4-9b-chat': 128_000, 'glm-4-plus': 128_000,
  'moonshot-v1-32k': 32_768, 'moonshot-v1-128k': 131_072,
  'kimi-k2-0711-preview': 131_072, 'kimi-k2-0905-preview': 262_144,
  'mistral-large-2411': 128_000, 'codestral-2501': 262_144,
}
export function modelContextDefault(modelId: string): number {
  const id = modelId.trim().toLowerCase().split('/').at(-1) ?? ''
  if (MODEL_CONTEXT_DEFAULTS[id]) return MODEL_CONTEXT_DEFAULTS[id]
  const dated = id.replace(/-\d{4}-\d{2}-\d{2}$|-\d{8}$/, '')
  return MODEL_CONTEXT_DEFAULTS[dated] ?? DEFAULT_MODEL_CONTEXT
}
