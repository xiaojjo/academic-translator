/**
 * Deterministic glossary enforcement.
 *
 * The glossary is a contract, not advice: after a segment is translated, every
 * approved entry whose source form occurs must appear with exactly its required
 * rendering. This module decides what is missing, asks the model for *exact
 * replacement pairs only*, applies them itself, and verifies again. The model
 * never gets to rewrite the whole segment unnoticed, and nothing is accepted
 * that does not literally contain the required rendering.
 *
 * @module @local/dsh-academic-translator/enforce
 */

import { escapeRegExp } from './segment.js'

/** Attempts before a segment is reported as unresolved. */
export const MAX_ENFORCE_ATTEMPTS = 3

/**
 * Build the matcher for one term on one side of the translation.
 * Latin script is matched on word boundaries; CJK is matched as a substring.
 * @param {string} term
 * @param {string} flags
 * @returns {RegExp}
 */
function matcherOf(term, flags) {
  const escaped = escapeRegExp(term)
  if (!/[A-Za-z]/u.test(term)) return new RegExp(escaped, flags)
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, flags)
}

/**
 * Count occurrences of one term in a text.
 * A Latin term also accepts its regular English plural, because a correct
 * translation legitimately writes "ectotherms" for the glossary form
 * "ectotherm". Nothing looser is accepted: the head word must still match on a
 * boundary, so "range" never satisfies "range shift".
 * @param {string} text
 * @param {string} term
 * @returns {number} occurrences, 0 when absent
 */
export function countTerm(text, term) {
  return locateTerm(text, term).length
}

/**
 * Every occurrence of one term in a text, as half-open [start, end) ranges.
 * The same matching rules as the counter above decide what counts, so a mark
 * on screen and a violation in the report can never disagree.
 * @param {string} text
 * @param {string} term
 * @returns {Array<{ start: number, end: number }>}
 */
export function locateTerm(text, term) {
  const trimmed = term.trim()
  if (trimmed.length === 0 || text.length === 0) return []
  if (!/[A-Za-z]/u.test(trimmed)) {
    /** @type {Array<{ start: number, end: number }>} */
    const ranges = []
    let from = 0
    while (true) {
      const at = text.indexOf(trimmed, from)
      if (at < 0) break
      ranges.push({ start: at, end: at + trimmed.length })
      from = at + trimmed.length
    }
    return ranges
  }
  // Boundary groups consume their characters, so adjacent repeats ("heat, heat")
  // would otherwise be counted once; walk the matches instead of counting them.
  const escaped = escapeRegExp(trimmed)
  // Hyphen and space are interchangeable inside a term ("trade-off"/"trade off").
  const flexible = escaped.replace(/\\?-|\\?\s/gu, '[-\\s]?')
  const pluralWord = /[^aeiou]y$/iu.test(trimmed) ? `${flexible.slice(0, -1)}ies` : `${flexible}(?:es|s)?`
  const pattern = new RegExp(`(^|[^A-Za-z0-9])(?:${flexible}|${pluralWord})(?=[^A-Za-z0-9]|$)`, 'giu')
  /** @type {Array<{ start: number, end: number }>} */
  const ranges = []
  let match
  while ((match = pattern.exec(text)) !== null) {
    const prefix = match[1] === undefined ? 0 : match[1].length
    const start = match.index + prefix
    ranges.push({ start, end: match.index + match[0].length })
    if (match.index === pattern.lastIndex) pattern.lastIndex += 1
  }
  return ranges
}

/**
 * Decide which glossary entries a translation violates.
 * A violation means: the source mentions the term, and the translation does not
 * contain the required rendering at all.
 * @param {Array<{ en: string, zh: string, note?: string, approved?: boolean }>} glossary
 * @param {string} source
 * @param {string} translation
 * @param {'en-zh' | 'zh-en'} direction
 * @returns {Array<{ sourceTerm: string, required: string, sourceCount: number, targetCount: number, note: string }>}
 */
export function findViolations(glossary, source, translation, direction) {
  if (translation.trim().length === 0) return []
  /** @type {Array<{ sourceTerm: string, required: string, sourceCount: number, targetCount: number, note: string }>} */
  const violations = []
  for (const entry of glossary) {
    if (entry.approved === false) continue
    const sourceTerm = (direction === 'zh-en' ? entry.zh : entry.en).trim()
    const required = (direction === 'zh-en' ? entry.en : entry.zh).trim()
    if (sourceTerm.length === 0 || required.length === 0) continue
    const sourceCount = countTerm(source, sourceTerm)
    if (sourceCount === 0) continue
    const targetCount = countTerm(translation, required)
    if (targetCount > 0) continue
    violations.push({ sourceTerm, required, sourceCount, targetCount, note: entry.note ?? '' })
  }
  return violations
}

/**
 * System prompt for the repair request.
 * The model may only propose literal substring replacements.
 * @param {'en-zh' | 'zh-en'} direction
 * @returns {string}
 */
export function enforceSystemPrompt(direction) {
  const targetName = direction === 'zh-en' ? 'English' : 'Chinese'
  return [
    `You repair terminology violations in an existing ${targetName} academic translation.`,
    `You are given one source text, one current translation, and a list of terms whose required ${targetName} rendering is missing from the translation.`,
    'For each listed term, find the substring in the current translation that the translator used instead, and produce a replacement pair.',
    'Rules:',
    '1. `from` must be a substring that occurs literally in the current translation, copied exactly (same characters, same case).',
    '2. `to` must equal the required rendering exactly, with no additions, no quotes, and no surrounding spaces.',
    '3. Change nothing else: do not fix style, do not reorder sentences, do not merge or split sentences. Only the term wording may change.',
    '4. If the translation put the term and a neighbouring word together, include exactly the characters that must change in `from`, and keep the rest in `to`.',
    '5. If you cannot find the offending substring, return an empty replacements array for that term.',
    'Output one JSON object only, no prose and no code fences, shaped as:',
    '{"replacements":[{"from":"<exact substring>","to":"<required rendering>"}],"rewrite":"<full corrected translation, or empty>"}',
    'Fill `rewrite` only when no substring replacement can express the fix.',
  ].join('\n')
}

/**
 * User message for the repair request.
 * @param {{ source: string, translation: string, violations: Array<{ sourceTerm: string, required: string }> }} payload
 * @returns {string}
 */
export function enforceUserMessage(payload) {
  return [
    'Repair the terminology of this item.',
    '',
    `SOURCE:\n${payload.source}`,
    '',
    `CURRENT TRANSLATION:\n${payload.translation}`,
    '',
    'TERMS WHOSE REQUIRED RENDERING IS MISSING:',
    ...payload.violations.map((violation) => `- source term "${violation.sourceTerm}" must be rendered exactly as "${violation.required}"`),
  ].join('\n')
}

/**
 * Parse a repair answer.
 * @param {string} text
 * @returns {{ replacements: Array<{ from: string, to: string }>, rewrite: string } | null}
 */
export function parseRepair(text) {
  let parsed = null
  const trimmed = text.trim().replace(/^```(?:json)?/iu, '').replace(/```$/u, '').trim()
  const start = trimmed.indexOf('{')
  if (start < 0) return null
  // Sandbox-style extraction: take the first balanced object.
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < trimmed.length; index += 1) {
    const char = trimmed[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          parsed = JSON.parse(trimmed.slice(start, index + 1))
        } catch {
          // The first balanced-looking object may still be malformed JSON
          // (trailing commas, unescaped quotes). Fall through to the raw-slice
          // retry below instead of giving up on the whole answer.
          parsed = null
        }
        break
      }
    }
  }
  if (parsed === null) {
    // Last resort: take everything from the first `{` to the last `}` and let
    // JSON.parse see that raw slice — handles answers padded with prose or
    // trailing chatter around a single object.
    const closing = trimmed.lastIndexOf('}')
    if (closing > start) {
      try {
        parsed = JSON.parse(trimmed.slice(start, closing + 1))
      } catch {
        parsed = null
      }
    }
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const replacements = Array.isArray(parsed.replacements)
    ? parsed.replacements
        .filter((row) => row !== null && typeof row === 'object')
        .map((row) => ({ from: typeof row.from === 'string' ? row.from : '', to: typeof row.to === 'string' ? row.to : '' }))
        .filter((row) => row.from.length > 0 && row.to.length > 0)
    : []
  const rewrite = typeof parsed.rewrite === 'string' ? parsed.rewrite.trim() : ''
  return { replacements, rewrite }
}

/**
 * Apply only the replacement pairs that are verifiably correct.
 * A pair is accepted when its `to` equals a required rendering and its `from`
 * actually occurs in the current translation. Everything else is rejected and
 * reported, never guessed at.
 * @param {string} translation
 * @param {Array<{ from: string, to: string }>} replacements
 * @param {Array<{ required: string }>} violations
 * @returns {{ text: string, applied: number, rejected: Array<{ from: string, to: string, reason: string }> }}
 */
export function applyReplacements(translation, replacements, violations) {
  const requiredByFold = new Map(violations.map((violation) => [violation.required.trim().toLowerCase(), violation.required.trim()]))
  let text = translation
  let applied = 0
  const rejected = []
  for (const pair of replacements) {
    const required = requiredByFold.get(pair.to.trim().toLowerCase())
    if (required === undefined) {
      rejected.push({ from: pair.from, to: pair.to, reason: 'target is not a required rendering' })
      continue
    }
    if (!text.includes(pair.from)) {
      rejected.push({ from: pair.from, to: pair.to, reason: 'source substring not present' })
      continue
    }
    // Keep the required casing rather than whatever the model typed.
    text = text.split(pair.from).join(required)
    applied += 1
  }
  return { text, applied, rejected }
}

/**
 * One enforcement outcome for a segment.
 * @typedef {{
 *   status: 'clean' | 'repaired' | 'failed',
 *   attempts: number,
 *   applied: number,
 *   unresolved: Array<{ sourceTerm: string, required: string }>,
 *   error?: string,
 *   at: number,
 * }} EnforceResult
 */

/**
 * Enforce the glossary on one translation, asking the model for exact
 * replacements when the rendering is missing.
 * @param {object} options
 * @param {Array<object>} options.glossary
 * @param {string} options.source
 * @param {string} options.translation
 * @param {'en-zh' | 'zh-en'} options.direction
 * @param {(payload: { system: string, user: string }) => Promise<string>} options.ask calls the model once
 * @param {((text: string) => Array<object>)=} options.checkViolations
 *   optional violation probe overriding the default whole-text check. The
 *   paragraph view checks aligned sentences individually, because a wrong
 *   rendering in one sentence is masked in the whole-paragraph count when the
 *   correct rendering appears in a sibling sentence.
 * @returns {Promise<{ text: string, result: EnforceResult }>}
 */
export async function enforceText(options) {
  const { glossary, source, direction, ask } = options
  const checkViolations =
    typeof options.checkViolations === 'function'
      ? options.checkViolations
      : (text) => findViolations(glossary, source, text, direction)
  let text = options.translation
  const started = Date.now()
  const initial = checkViolations(text)
  if (initial.length === 0) {
    return { text, result: { status: 'clean', attempts: 0, applied: 0, unresolved: [], at: started } }
  }

  let violations = initial
  let applied = 0
  let attempts = 0
  /** Last failure reason, surfaced in the result so the UI can show why. */
  let errorNote = ''
  const system = enforceSystemPrompt(direction)

  while (violations.length > 0 && attempts < MAX_ENFORCE_ATTEMPTS) {
    attempts += 1
    let answer = ''
    try {
      answer = await ask({ system, user: enforceUserMessage({ source, translation: text, violations }) })
    } catch (caught) {
      // A failed repair request is a failure to enforce, not a reason to lose
      // the translation that already exists — but the reason must not be
      // swallowed silently, otherwise the button looks dead.
      errorNote = caught instanceof Error ? caught.message : String(caught)
      break
    }
    const repair = parseRepair(answer)
    if (repair === null) {
      // Rejected on purpose: accepting the raw answer as a full rewrite lets
      // the model silently degrade unrelated sentences. JSON-only remains the
      // contract; a non-conforming answer is reported, never applied.
      errorNote = 'The model answer could not be used as a repair instruction.'
      break
    }

    if (repair.replacements.length > 0) {
      const outcome = applyReplacements(text, repair.replacements, violations)
      if (outcome.applied > 0) {
        text = outcome.text
        applied += outcome.applied
      }
    }
    // A rewrite is only taken when the replacements did not fix everything and
    // the rewrite itself verifiably satisfies the glossary.
    violations = checkViolations(text)
    if (violations.length > 0 && repair.rewrite.length > 0) {
      const rewriteViolations = checkViolations(repair.rewrite)
      if (rewriteViolations.length < violations.length) {
        text = repair.rewrite
        violations = rewriteViolations
      }
    }
  }

  const status = violations.length === 0 ? (applied > 0 || text !== options.translation ? 'repaired' : 'clean') : 'failed'
  return {
    text,
    result: {
      status,
      attempts,
      applied,
      unresolved: violations.map((violation) => ({ sourceTerm: violation.sourceTerm, required: violation.required })),
      ...(errorNote.length > 0 ? { error: errorNote } : {}),
      at: Date.now(),
    },
  }
}