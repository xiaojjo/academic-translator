/**
 * Durable storage for academic-translator projects.
 *
 * The plugin keeps its own JSON document per profile. It never reads or rewrites
 * the profile's cordis.patch.yml: that file belongs to the user.
 *
 * @module @local/dsh-academic-translator/store
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** Bumped when the stored document shape changes incompatibly. */
export const STORE_VERSION = 1

/**
 * Directory holding this plugin's data for the active profile.
 * @returns {string} absolute directory path, not necessarily existing.
 */
export function dataDirectory() {
  const profileDir = process.env.DSH_PROFILE_DIR
  if (typeof profileDir === 'string' && profileDir.length > 0) {
    return path.join(profileDir, 'data', 'academic-translator')
  }
  const home = process.env.DSH_HOME ?? os.homedir()
  const base = home === os.homedir() ? path.join(home, '.dsh') : home
  return path.join(base, 'data', 'academic-translator')
}

/** Default settings for a profile without a stored document. */
export function defaultSettings() {
  return {
    /** Empty provider/model means "follow the session's default model". */
    provider: '',
    model: '',
    /** Translation target language tag. */
    targetLanguage: 'zh-CN',
    /** Segments sent to the model in one request. */
    batchSize: 4,
    /** Character budget for one request; batches are split further if needed. */
    maxCharsPerBatch: 4500,
    /** Upper bound for one terminology extraction request. */
    maxTerms: 60,
    /** Per-request timeout. */
    timeoutMs: 120000,
    /** Free-form instructions the user wants the translation model to obey. */
    instructions: '',
    /** Reasoning effort id for model calls; empty follows the model default. */
    reasoningEffort: '',
  }
}

/** @returns {object} a document with no projects. */
export function emptyStore() {
  return { version: STORE_VERSION, settings: defaultSettings(), glossary: [], projects: {} }
}

/** @param {string} file */
function readJson(file) {
  const text = fs.readFileSync(file, 'utf8')
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object') throw new Error('store is not an object')
  return parsed
}

/**
 * Normalize one glossary row.
 * @param {object} item
 * @returns {{ en: string, zh: string, note: string, approved: boolean, origin: string } | null}
 */
export function normalizeTerm(item) {
  if (item === null || typeof item !== 'object') return null
  const en = typeof item.en === 'string' ? item.en.trim() : ''
  const zh = typeof item.zh === 'string' ? item.zh.trim() : ''
  if (en.length === 0 && zh.length === 0) return null
  return {
    en,
    zh,
    note: typeof item.note === 'string' ? item.note.trim() : '',
    approved: item.approved !== false,
    origin: item.origin === 'extracted' ? 'extracted' : 'manual',
  }
}

/**
 * Merge glossary rows into a table, keeping the first occurrence of a source
 * form. Used for the one-time migration from per-paper tables.
 * @param {Array<object>} table mutated in place
 * @param {Array<object>} rows
 */
export function mergeTerms(table, rows) {
  const known = new Set(table.map((entry) => entry.en.toLowerCase()))
  for (const row of rows) {
    const term = normalizeTerm(row)
    if (term === null || term.zh.length === 0) continue
    const key = term.en.toLowerCase()
    if (known.has(key)) continue
    known.add(key)
    table.push(term)
  }
}

/**
 * Fill in fields a stored document may predate.
 * @param {object} raw
 * @returns {object} a complete document.
 */
function normalize(raw) {
  const store = emptyStore()
  if (typeof raw.settings === 'object' && raw.settings !== null) {
    store.settings = { ...store.settings, ...raw.settings }
  }
  // The glossary is one table for the whole profile. Older documents kept one
  // per paper, so those tables are merged in once, first wins.
  if (Array.isArray(raw.glossary)) {
    for (const row of raw.glossary) {
      const term = normalizeTerm(row)
      if (term === null) continue
      store.glossary.push(term)
    }
  }
  const projects = raw.projects !== null && typeof raw.projects === 'object' ? raw.projects : {}
  for (const [id, project] of Object.entries(projects)) {
    if (project === null || typeof project !== 'object') continue
    const normalized = normalizeProject(project, id)
    mergeTerms(store.glossary, normalized.glossary)
    store.projects[id] = normalized
  }
  return store
}

/**
 * @param {object} raw stored project
 * @param {string} id fallback id
 */
export function normalizeProject(raw, id) {
  const paragraphs = Array.isArray(raw.paragraphs)
    ? raw.paragraphs
        .filter((item) => item !== null && typeof item === 'object' && typeof item.source === 'string')
        .map((item, index) => ({ id: typeof item.id === 'string' ? item.id : `p${index + 1}`, source: item.source }))
    : []
  const translations = raw.translations !== null && typeof raw.translations === 'object' ? raw.translations : {}
  const glossary = Array.isArray(raw.glossary)
    ? raw.glossary
        .filter((item) => item !== null && typeof item === 'object' && typeof item.en === 'string')
        .map((item) => ({
          en: item.en,
          zh: typeof item.zh === 'string' ? item.zh : '',
          note: typeof item.note === 'string' ? item.note : '',
          approved: item.approved !== false,
          origin: item.origin === 'extracted' ? 'extracted' : 'manual',
        }))
    : []
  return {
    id: typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : id,
    title: typeof raw.title === 'string' && raw.title.trim().length > 0 ? raw.title : 'Untitled paper',
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
    granularity: raw.granularity === 'sentence' ? 'sentence' : 'paragraph',
    direction: normalizeDirection(raw.direction),
    view: normalizeView(raw.view),
    paragraphs,
    translations: normalizeTranslations(raw.translations),
    reviews: normalizeReviews(raw.reviews),
    enforcements: normalizeEnforcements(raw.enforcements),
    glossary,
    skills: Array.isArray(raw.skills) ? raw.skills.filter((name) => typeof name === 'string') : [],
    strictTerms: raw.strictTerms !== false,
  }
}

/** Supported translation directions. `zh-en` means Chinese source, English output. */
export const DIRECTIONS = ['en-zh', 'zh-en']

/**
 * @param {unknown} value
 * @returns {'en-zh' | 'zh-en'}
 */
export function normalizeDirection(value) {
  return value === 'zh-en' ? 'zh-en' : 'en-zh'
}

/**
 * Reading layout. The older `zh`/`en` names meant "translation only" and
 * "source only", which now depend on the direction, so they map onto the
 * direction-neutral names.
 * @param {unknown} value
 * @returns {'bilingual' | 'source' | 'target'}
 */
export function normalizeView(value) {
  if (value === 'source' || value === 'en') return 'source'
  if (value === 'target' || value === 'zh') return 'target'
  return 'bilingual'
}

/**
 * Language tags for one direction.
 * @param {'en-zh' | 'zh-en'} direction
 */
export function languagesOf(direction) {
  return direction === 'zh-en'
    ? { sourceLanguage: 'zh-CN', targetLanguage: 'en' }
    : { sourceLanguage: 'en', targetLanguage: 'zh-CN' }
}

/**
 * Accept either the current per-direction shape or the older flat shape,
 * which belonged to `en-zh`.
 * @param {object} raw
 */
function normalizeTranslations(raw) {
  /** @type {Record<string, Record<string, { text: string, at: number }>>} */
  const out = { 'en-zh': {}, 'zh-en': {} }
  if (raw === null || typeof raw === 'object') {
    const flat = {}
    let nested = false
    for (const [key, value] of Object.entries(raw)) {
      if (value === null || typeof value !== 'object') continue
      if (typeof value.text === 'string') {
        flat[key] = value
        continue
      }
      // A nested map keyed by segment id.
      if (DIRECTIONS.includes(key)) {
        nested = true
        const bucket = /** @type {Record<string, { text: string, at: number }>} */ (out[key])
        for (const [segmentId, entry] of Object.entries(value)) {
          if (entry === null || typeof entry !== 'object') continue
          if (typeof entry.text !== 'string') continue
          bucket[segmentId] = { text: entry.text, at: typeof entry.at === 'number' ? entry.at : Date.now() }
        }
      }
    }
    if (!nested) {
      for (const [segmentId, entry] of Object.entries(flat)) {
        out['en-zh'][segmentId] = {
          text: entry.text,
          at: typeof entry.at === 'number' ? entry.at : Date.now(),
        }
      }
    }
  }
  return out
}

/**
 * Review records, also accepted in the older flat shape.
 * @param {object} raw
 */
function normalizeReviews(raw) {
  /** @type {Record<string, Record<string, object>>} */
  const out = { 'en-zh': {}, 'zh-en': {} }
  if (raw === null || typeof raw !== 'object') return out
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || typeof value !== 'object') continue
    const target = DIRECTIONS.includes(key) && typeof value === 'object' && Object.values(value).every((item) => item !== null && typeof item === 'object' && ('score' in item || 'suggestion' in item))
      ? key
      : null
    if (target === null) continue
    const bucket = /** @type {Record<string, object>} */ (out[target])
    for (const [segmentId, entry] of Object.entries(value)) {
      if (entry === null || typeof entry !== 'object') continue
      const score = Number(entry.score)
      bucket[segmentId] = {
        score: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 0,
        issues: Array.isArray(entry.issues) ? entry.issues.filter((item) => typeof item === 'string').slice(0, 12) : [],
        suggestion: typeof entry.suggestion === 'string' ? entry.suggestion : '',
        status: entry.status === 'accepted' || entry.status === 'rejected' ? entry.status : 'open',
        at: typeof entry.at === 'number' ? entry.at : Date.now(),
        model: typeof entry.model === 'string' ? entry.model : '',
      }
    }
  }
  return out
}

/**
 * Enforcement records, one bucket per direction.
 * @param {object} raw
 */
function normalizeEnforcements(raw) {
  /** @type {Record<string, Record<string, object>>} */
  const out = { 'en-zh': {}, 'zh-en': {} }
  if (raw === null || typeof raw !== 'object') return out
  for (const [key, value] of Object.entries(raw)) {
    if (!DIRECTIONS.includes(key) || value === null || typeof value !== 'object') continue
    const bucket = /** @type {Record<string, object>} */ (out[key])
    for (const [segmentId, entry] of Object.entries(value)) {
      if (entry === null || typeof entry !== 'object') continue
      const status = entry.status === 'repaired' || entry.status === 'failed' || entry.status === 'clean' ? entry.status : 'clean'
      bucket[segmentId] = {
        status,
        attempts: Number.isFinite(Number(entry.attempts)) ? Number(entry.attempts) : 0,
        applied: Number.isFinite(Number(entry.applied)) ? Number(entry.applied) : 0,
        unresolved: Array.isArray(entry.unresolved)
          ? entry.unresolved
              .filter((item) => item !== null && typeof item === 'object' && typeof item.sourceTerm === 'string')
              .map((item) => ({ sourceTerm: item.sourceTerm, required: typeof item.required === 'string' ? item.required : '' }))
          : [],
        at: typeof entry.at === 'number' ? entry.at : Date.now(),
      }
    }
  }
  return out
}

/**
 * Load the document, or an empty one when absent or unreadable.
 * @param {string} directory
 */
export function loadStore(directory) {
  const file = path.join(directory, 'projects.json')
  try {
    return normalize(readJson(file))
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return emptyStore()
    // A corrupt document must not brick the plugin: keep a copy and start clean.
    try {
      const backup = `${file}.broken-${Date.now()}`
      fs.copyFileSync(file, backup)
    } catch {
      /* best effort */
    }
    return emptyStore()
  }
}

/**
 * Write the document atomically.
 * @param {string} directory
 * @param {object} store
 */
export function saveStore(directory, store) {
  fs.mkdirSync(directory, { recursive: true })
  const file = path.join(directory, 'projects.json')
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(temporary, JSON.stringify(store, null, 1), 'utf8')
  fs.renameSync(temporary, file)
}