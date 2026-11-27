/**
 * Model calls.
 *
 * Uses the Host `llm` service directly rather than `translator`: translation
 * here needs a custom system prompt (glossary plus skills) and structured
 * output, which the plain-text translator service cannot carry.
 *
 * @module @local/dsh-academic-translator/engine
 */

/**
 * Read the default model route of the running profile.
 * @param {any} ctx Cordis context
 * @returns {{ provider: string, model: string } | null}
 */
export function defaultRoute(ctx) {
  const service = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined
  if (service === undefined || service === null || typeof service.currentSelection !== 'function') return null
  try {
    const selection = service.currentSelection()
    if (selection === null || typeof selection !== 'object') return null
    const provider = typeof selection.provider === 'string' ? selection.provider : ''
    const model = typeof selection.model === 'string' ? selection.model : ''
    if (provider.length === 0 || model.length === 0) return null
    return { provider, model }
  } catch {
    return null
  }
}

/**
 * Resolve the route a project's settings ask for.
 * @param {any} ctx
 * @param {{ provider?: string, model?: string }} settings
 * @returns {{ provider: string, model: string }}
 */
export function resolveRoute(ctx, settings) {
  const configuredProvider = typeof settings.provider === 'string' ? settings.provider.trim() : ''
  const configuredModel = typeof settings.model === 'string' ? settings.model.trim() : ''
  if (configuredProvider.length > 0 && configuredModel.length > 0) {
    return { provider: configuredProvider, model: configuredModel }
  }
  const fallback = defaultRoute(ctx)
  if (fallback === null) {
    throw new Error('No model route is available. Pick a provider and model in the translator settings, or select a model for this session.')
  }
  return fallback
}

/**
 * Assemble one text answer from a stream.
 * @param {AsyncIterable<any>} chunks
 * @returns {Promise<{ text: string, finish: any }>}
 */
async function collectText(chunks) {
  let text = ''
  let finish = { kind: 'stop' }
  for await (const chunk of chunks) {
    if (chunk === null || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    else if (chunk.type === 'finish') finish = chunk.reason ?? { kind: 'stop' }
  }
  return { text, finish }
}

/**
 * One model call that returns text.
 * @param {any} ctx
 * @param {{ provider: string, model: string }} route
 * @param {{ system: string, user: string, maxTokens?: number, timeoutMs?: number, signal?: AbortSignal, reasoningEffort?: string }} request
 * @returns {Promise<string>}
 */
export async function callModel(ctx, route, request) {
  const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
  if (llm === undefined || llm === null || typeof llm.prepareCall !== 'function') {
    throw new Error('The llm service is not available in this profile.')
  }
  const controller = new AbortController()
  const onAbort = () => controller.abort(request.signal?.reason)
  if (request.signal !== undefined) {
    if (request.signal.aborted) controller.abort(request.signal.reason)
    else request.signal.addEventListener('abort', onAbort, { once: true })
  }
  const timeoutMs = typeof request.timeoutMs === 'number' && request.timeoutMs > 0 ? request.timeoutMs : 120000
  const timer = setTimeout(() => controller.abort(new Error('Translation request timed out')), timeoutMs)
  timer.unref?.()
  try {
    const call = await llm.prepareCall(
      { ...route, maxTokens: request.maxTokens ?? 4096 },
      controller.signal,
      (controls, model) => {
        // Never pass an effort the model does not advertise: DSH rejects an
        // explicit reasoningEffort outside `reasoning.efforts` with
        // UNSUPPORTED_REASONING_EFFORT. Prefer the user's saved choice when it
        // is valid, then the model's own default, then its first listed effort.
        const efforts = model?.reasoning?.efforts
        if (!Array.isArray(efforts) || efforts.length === 0) return controls
        const ids = efforts.map((entry) => entry?.id).filter((id) => typeof id === 'string' && id.length > 0)
        if (ids.length === 0) return controls
        const requested = typeof request.reasoningEffort === 'string' && request.reasoningEffort.length > 0
          ? request.reasoningEffort
          : undefined
        const fallback = model?.reasoning?.defaultEffort
        const chosen = requested !== undefined && ids.includes(requested)
          ? requested
          : typeof fallback === 'string' && ids.includes(fallback)
            ? fallback
            : ids[0]
        return chosen === undefined ? controls : { ...controls, reasoningEffort: chosen }
      },
    )
    const messages = [
      { role: 'user', content: [{ type: 'text', text: request.user }] },
    ]
    const { text, finish } = await collectText(
      call.stream({ ...call.config, messages, system: request.system, signal: controller.signal }),
    )
    if (finish?.kind === 'error' || finish?.kind === 'aborted') {
      const message = finish?.failure?.message ?? 'The model call failed.'
      throw new Error(message)
    }
    if (finish?.kind === 'max-tokens') {
      throw new Error('The model hit its output token limit; translate a smaller batch.')
    }
    return text
  } finally {
    clearTimeout(timer)
    if (request.signal !== undefined) request.signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Pull the first balanced JSON value (object or array) out of a model answer.
 * @param {string} text
 * @returns {any | null}
 */
export function extractJsonObject(text) {
  const source = text.trim().replace(/^```(?:json)?/iu, '').replace(/```$/u, '').trim()
  const objectStart = source.indexOf('{')
  const arrayStart = source.indexOf('[')
  let start = objectStart
  if (start < 0 || (arrayStart >= 0 && arrayStart < start)) start = arrayStart
  if (start < 0) return null
  const opener = source[start]
  const closer = opener === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === opener) depth += 1
    else if (char === closer) {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, index + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/**
 * Normalize a model answer into `id -> translation`.
 * Accepts `{"translations":[...]}`, a bare array, or a map of id to text.
 * @param {string} text
 * @param {string[]} ids expected ids
 * @returns {Record<string, string> | null} null when nothing usable was found
 */
export function parseTranslations(text, ids) {
  const parsed = extractJsonObject(text)
  const wanted = new Set(ids)
  /** @type {Record<string, string>} */
  const out = {}
  const take = (id, value) => {
    if (typeof id !== 'string' || typeof value !== 'string') return
    if (!wanted.has(id)) return
    if (value.trim().length === 0) return
    out[id] = value.trim()
  }
  const rows = Array.isArray(parsed?.translations)
    ? parsed.translations
    : Array.isArray(parsed)
      ? parsed
      : null
  if (rows !== null) {
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue
      take(row.id, row.out ?? row.zh ?? row.en ?? row.zh_cn ?? row.translation ?? row.target)
    }
  } else if (parsed !== null && typeof parsed === 'object') {
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === 'string') take(id, value)
      else if (value !== null && typeof value === 'object') take(id, value.out ?? value.zh ?? value.en ?? value.translation)
    }
  }
  if (Object.keys(out).length === 0) return null
  return out
}

/**
 * Normalize a terminology extraction answer.
 * Accepts `{source,target}` (direction-neutral) and the older `{en,zh}`.
 * @param {string} text
 * @returns {Array<{ en: string, zh: string, note: string }>} `en` is the source form, `zh` the rendering
 */
export function parseTerms(text) {
  const parsed = extractJsonObject(text)
  const rows = Array.isArray(parsed?.terms) ? parsed.terms : Array.isArray(parsed) ? parsed : []
  /** @type {Array<{ en: string, zh: string, note: string }>} */
  const terms = []
  const seen = new Set()
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const source = firstString(row.source, row.en, row.term)
    const target = firstString(row.target, row.zh, row.translation)
    if (source === null || target === null) continue
    const key = source.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    terms.push({ en: source, zh: target, note: typeof row.note === 'string' ? row.note.trim() : '' })
  }
  return terms
}

/**
 * Parse user-pasted terminology text into glossary rows.
 * Accepts Markdown tables (`| en | zh | note | usage |`), tab/comma-separated
 * columns, and simple `en=zh` lines. Header rows, Markdown separators, section
 * headings and bullet-only lines are ignored. The first two columns are the
 * source form and the required rendering; any third column becomes the note.
 * @param {string} text
 * @returns {Array<{ en: string, zh: string, note: string, approved: boolean, origin: string }>}
 */
export function parseTermText(text) {
  /** @type {Array<{ en: string, zh: string, note: string, approved: boolean, origin: string }>} */
  const rows = []
  const seen = new Set()
  const skip = /^(en|english|原文|术语|term|source)?\s*(\||,|\t)?\s*(zh|chinese|译名|中文|target|rendering)/iu
  for (const rawLine of String(text ?? '').split(/\r?\n/u)) {
    let line = rawLine.trim()
    if (line.length === 0) continue
    // Markdown bullet or numbered list prefix.
    line = line.replace(/^[-*+]\s+|^\d+[.)]\s+/u, '').trim()
    // Markdown table: drop leading/trailing pipes and split on pipes.
    if (line.startsWith('|')) line = line.replace(/^\||\|$/gu, '')
    // Separator row like | --- | --- | or |:--|--:|.
    if (/^[\s|:-]+$/u.test(line)) continue
    let parts
    if (line.includes('\t')) parts = line.split('\t')
    else if (line.includes('|')) parts = line.split('|')
    else if (line.includes('=')) parts = line.split('=')
    else if (line.includes(',')) parts = line.split(',')
    else parts = line.split(/\s{2,}/u)
    parts = parts.map((part) => part.trim()).filter((part) => part.length > 0)
    if (parts.length < 2) continue
    const en = parts[0]
    const zh = parts[1]
    // Skip a header row such as "en | zh | note | 推荐使用场景".
    if (skip.test(`${en} ${zh}`)) continue
    if (en.length === 0 || zh.length === 0) continue
    const key = en.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    rows.push({ en, zh, note: parts.slice(2).join(' '), approved: true, origin: 'manual' })
  }
  return rows
}

/**
 * First non-empty trimmed string.
 * @param {...unknown} values
 * @returns {string | null}
 */
function firstString(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed.length > 0) return trimmed
  }
  return null
}

/**
 * Normalize a scoring answer.
 * @param {string} text
 * @param {string[]} ids expected ids
 * @returns {Record<string, { score: number, issues: string[], suggestion: string, breakdown: object | null }> | null}
 */
export function parseReviews(text, ids) {
  const parsed = extractJsonObject(text)
  const wanted = new Set(ids)
  /** @type {Record<string, { score: number, issues: string[], suggestion: string, breakdown: object | null }>} */
  const out = {}
  const rows = Array.isArray(parsed?.reviews)
    ? parsed.reviews
    : Array.isArray(parsed?.scores)
      ? parsed.scores
      : Array.isArray(parsed)
        ? parsed
        : []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const id = typeof row.id === 'string' ? row.id : ''
    if (!wanted.has(id)) continue
    const rawScore = Number(row.score)
    if (!Number.isFinite(rawScore)) continue
    const dims = [
      ['fidelity', 30],
      ['terminology', 25],
      ['register', 20],
      ['fluency', 15],
      ['format', 10],
    ]
    const source = row.breakdown && typeof row.breakdown === 'object' ? row.breakdown : row
    /** @type {Record<string, number>} */
    const breakdown = {}
    let sum = 0
    let complete = true
    for (const [key, max] of dims) {
      const value = Number(source[key])
      if (!Number.isFinite(value)) {
        complete = false
        break
      }
      const clamped = Math.max(0, Math.min(max, Math.round(value)))
      breakdown[key] = clamped
      sum += clamped
    }
    const normalizedBreakdown = complete ? breakdown : null
    out[id] = {
      score: Math.max(0, Math.min(100, Math.round(rawScore))),
      breakdown: normalizedBreakdown,
      issues: Array.isArray(row.issues)
        ? row.issues.filter((item) => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()).slice(0, 12)
        : typeof row.issue === 'string' && row.issue.trim().length > 0
          ? [row.issue.trim()]
          : [],
      suggestion: firstString(row.suggestion, row.revised, row.improved, row.translation) ?? '',
    }
  }
  if (Object.keys(out).length === 0) return null
  return out
}