/**
 * Prompt construction.
 *
 * Every translation request carries the approved glossary, so one paper keeps
 * one translation per term. Selected skills contribute optional style guidance.
 * Direction decides which side of the glossary is the source form.
 *
 * @module @local/dsh-academic-translator/prompt
 */

/** Character budget for one skill's body inside the system prompt. */
const MAX_SKILL_CHARS = 6000
/** Character budget for all skills together. */
const MAX_SKILLS_CHARS = 14000

/** Human-readable language names for prompts. */
const LANGUAGE_NAMES = {
  en: 'English',
  'zh-CN': 'Simplified Chinese',
}

/**
 * @param {string} tag
 * @returns {string}
 */
function languageName(tag) {
  return LANGUAGE_NAMES[tag] ?? tag
}

/**
 * Render the approved glossary as `source => target`.
 * Longest source term first so an overlapping shorter term cannot shadow it.
 * The source side follows the translation direction.
 * @param {Array<{ en: string, zh: string, note?: string, approved?: boolean }>} glossary
 * @param {'en-zh' | 'zh-en'} direction
 * @returns {string}
 */
export function glossaryBlock(glossary, direction = 'en-zh') {
  const sourceKey = direction === 'zh-en' ? 'zh' : 'en'
  const targetKey = direction === 'zh-en' ? 'en' : 'zh'
  const rows = glossary
    .filter((entry) => entry.approved !== false)
    .map((entry) => ({ source: (entry[sourceKey] ?? '').trim(), target: (entry[targetKey] ?? '').trim() }))
    .filter((entry) => entry.source.length > 0 && entry.target.length > 0)
    .sort((left, right) => right.source.length - left.source.length)
  if (rows.length === 0) return ''
  return rows.map((entry) => `${entry.source} => ${entry.target}`).join('\n')
}

/**
 * Trim one skill body to the per-skill budget.
 * @param {string} content
 */
function trimSkill(content) {
  const text = content.trim()
  if (text.length <= MAX_SKILL_CHARS) return text
  return `${text.slice(0, MAX_SKILL_CHARS)}\n[truncated]`
}

/**
 * System prompt for translation batches.
 * @param {object} options
 * @param {Array<object>} options.glossary approved glossary rows
 * @param {Array<{ name: string, content: string }>} options.skills selected skills
 * @param {'en-zh' | 'zh-en'} [options.direction]
 * @param {string} [options.sourceLanguage]
 * @param {string} [options.targetLanguage]
 * @param {'paragraph' | 'sentence'} options.granularity
 * @param {string} [options.instructions] user-defined constraints for the model
 * @returns {string}
 */
export function translationSystemPrompt({ glossary, skills, direction = 'en-zh', sourceLanguage, targetLanguage, granularity, instructions }) {
  const source = sourceLanguage ?? (direction === 'zh-en' ? 'zh-CN' : 'en')
  const target = targetLanguage ?? (direction === 'zh-en' ? 'en' : 'zh-CN')
  const sourceName = languageName(source)
  const targetName = languageName(target)
  const lines = [
    `You are a professional academic translator working from ${sourceName} into ${targetName}.`,
    '',
    'Hard rules:',
    '1. Translate faithfully: no additions, no omissions, no summarizing, no merging of separate input items.',
    '2. Keep every number, unit, statistic, citation marker ([12], (Smith et al., 2019)), figure and table reference (Fig. 2, Table 1), chemical formula, gene/protein symbol, and Latin binomial exactly as written.',
  ]
  if (direction === 'en-zh') {
    lines.push(
      '3. The glossary below is MANDATORY. Every source term in it must appear in your output as exactly the listed Chinese string, character for character. Never paraphrase it, never use a synonym, never translate it two different ways in one paper.',
      '4. A term that is absent from the glossary must still be rendered one way only: choose one translation, and reuse that same wording for every later occurrence in this paper.',
      '5. Before answering, check each glossary term that occurs in the input: is its listed Chinese string present literally in your translation? If not, fix it.',
    )
  } else {
    lines.push(
      '3. The glossary below is MANDATORY. Every Chinese source term in it must appear in your output as exactly the listed English string, including capitalization and hyphenation. Never paraphrase it, never use a synonym, never translate it two different ways in one paper.',
      '4. A term absent from the glossary must still get one fixed English rendering that you reuse for every later occurrence; never vary it for variety.',
      '5. Write idiomatic academic English: complete sentences, correct articles and tense, and no literal word-for-word carry-over from Chinese syntax or punctuation (use target punctuation).',
      '6. Before answering, check each glossary term that occurs in the input: is its listed English string present literally in your translation? If not, fix it.',
    )
  }
  // Keep the numbering below aligned with the direction-specific rules above.
  const base = direction === 'en-zh' ? 6 : 7
  lines.push(
    `${base}. Keep the original paragraph boundaries: one output item per input item, identified by its id.`,
    `${base + 1}. Preserve hedges and epistemic strength (tentative claims must not become categorical).`,
    `${base + 2}. Keep sentence-internal logic words (however, therefore, whereas, 因此, 然而) translated; do not drop connectives.`,
  )
  if (granularity === 'sentence') {
    lines.push(`${base + 3}. Input items are single sentences. Translate each one independently and completely; do not merge two items.`)
  } else {
    lines.push(`${base + 3}. Input items are whole paragraphs. Translate each paragraph as one coherent unit.`)
  }
  lines.push(`Target language: ${targetName} (${target}).`)
  lines.push('Output format: one JSON object only, no prose and no code fences, shaped as {"translations":[{"id":"<input id>","out":"<translation>"}]}.')

  const glossaryText = glossaryBlock(glossary, direction)
  if (glossaryText.length > 0) {
    lines.push('', `Glossary (${sourceName} => required ${targetName}):`, glossaryText)
  }

  const skillBlocks = []
  let budget = MAX_SKILLS_CHARS
  for (const skill of skills) {
    const body = trimSkill(skill.content)
    if (budget - body.length < 0) break
    budget -= body.length
    skillBlocks.push(`### Skill: ${skill.name}\n${body}`)
  }
  if (skillBlocks.length > 0) {
    lines.push(
      '',
      'Style and terminology guidance supplied by the user. Follow it where it does not conflict with the hard rules or the glossary:',
      '',
      skillBlocks.join('\n\n'),
    )
  }
  const userInstructions = typeof instructions === 'string' ? instructions.trim() : ''
  if (userInstructions.length > 0) {
    lines.push(
      '',
      'Additional instructions from the user. Obey them wherever they do not conflict with the hard rules above or the mandatory glossary:',
      userInstructions,
    )
  }
  return lines.join('\n')
}

/**
 * User message carrying the batch.
 * @param {Array<{ id: string, source: string }>} items
 * @returns {string}
 */
export function translationUserMessage(items) {
  return [
    `Translate ${items.length} item(s). Return the JSON object described in the instructions.`,
    JSON.stringify(items.map((item) => ({ id: item.id, source: item.source })), null, 1),
  ].join('\n')
}

/**
 * System prompt for terminology extraction.
 * @param {'en-zh' | 'zh-en'} direction
 * @param {number} maxTerms
 * @returns {string}
 */
export function extractionSystemPrompt(direction, maxTerms) {
  const sourceName = languageName(direction === 'zh-en' ? 'zh-CN' : 'en')
  const targetName = languageName(direction === 'zh-en' ? 'en' : 'zh-CN')
  return [
    `You extract the terminology of a research paper written in ${sourceName} so a translator can keep it consistent.`,
    `Produce at most ${maxTerms} entries, most important first: technical terms, method names, taxon or gene names, measured variables, statistical and experimental design terms, and recurring noun phrases with a domain meaning.`,
    'Prefer multi-word terms that the paper itself uses repeatedly. Skip ordinary academic filler and skip single common words.',
    `For each entry give the exact source form as it appears in the paper ("source"), the recommended ${targetName} rendering ("target"), and a short note only when the choice needs justification (for example an ambiguous or polysemous term).`,
    'Output one JSON object only, no prose and no code fences, shaped as {"terms":[{"source":"...","target":"...","note":""}]}.',
  ].join('\n')
}

/**
 * User message for terminology extraction.
 * @param {string} text paper text, already truncated
 * @returns {string}
 */
export function extractionUserMessage(text) {
  return `Extract terminology from this paper text:\n\n${text}`
}

/**
 * Ask for a repair when the model answered in the wrong shape.
 * @param {string[]} ids expected ids
 * @returns {string}
 */
export function repairReminder(ids) {
  return [
    'Your previous answer was not valid JSON in the required shape.',
    `Return only {"translations":[{"id":"...","out":"..."}]} with exactly these ids: ${ids.join(', ')}.`,
    'No explanation, no markdown fence.',
  ].join('\n')
}

/**
 * System prompt for quality scoring.
 * The reviewer judges the translation; it does not rewrite the source.
 * @param {object} options
 * @param {'en-zh' | 'zh-en'} options.direction
 * @param {Array<object>} options.glossary
 * @returns {string}
 */
export function scoringSystemPrompt({ direction, glossary }) {
  const sourceName = languageName(direction === 'zh-en' ? 'zh-CN' : 'en')
  const targetName = languageName(direction === 'zh-en' ? 'en' : 'zh-CN')
  const lines = [
    `You are a demanding native-English journal editor editing a manuscript for a top-tier international journal. You will assess translations from ${sourceName} into ${targetName}. You have zero tolerance for translationese, awkward phrasing, or anything a native author would not write. Grade like a gatekeeper, not a cheerleader: your default is to find fault, and a high score is earned only by prose indistinguishable from a native scholar's own writing.`,
    '',
    'For every item you receive the source text and a candidate translation. Score it on exactly five weighted dimensions (total 100):',
    '- [忠] fidelity, 0-30: no meaning added, dropped, or inverted; every clause translated; no unwarranted interpretation;',
    '- [术] terminology, 0-25: every glossary term uses its required rendering;',
    '- [体] academic register, 0-20: idiomatic academic target language, no source-language syntax or calque leaking through; word choice, collocations, and idioms must be what a native scholar would actually write;',
    '- [流] fluency and logic, 0-15: smooth syntax, natural rhythm, correct connectives, coherent logic; no stilted or mechanical sentences;',
    '- [格] format, 0-10: numbers, units, citations, figure/table references, capitalization and punctuation preserved.',
    '',
    'Rules:',
    '- "score" MUST equal the sum of the five breakdown values; report each dimension independently.',
    '- Attribute every problem to one of the five dimensions; every deduction belongs to exactly one dimension and no known problem is left unassigned.',
    '- A terminology problem is deducted ONLY under [术], never also under [忠]; avoid double-counting the same error.',
    '- Treat even small deviations in idiom or collocation as real deductions. Do not excuse a phrase because the meaning is "roughly right" — how a native editor would rewrite it is the standard.',
    '- Only list an issue when it genuinely warrants the reader\'s attention; quote the exact offending wording and say how a native scholar would write it instead. Do not pad the list with trivial nitpicks.',
    '- Calibration: 90-100 means publishable, native-quality prose; 75-89 means solid but needing meaningful editing; 50-74 means noticeable translationese or several flaws; below 50 is a poor translation. Score honestly by how good the prose actually is — do not aim for a particular number, high or low.',
    '- Be strict and consistent: apply the same standard to every item, and let two similar issues cost similar points across items.',
    '- Prefix every entry in "issues" with its dimension tag, e.g. "[术] wrong rendering of heat tolerance", and quote the exact offending wording.',
    '- Always supply one improved translation in "suggestion" that fixes every issue you listed, unless the translation is truly flawless. A high score with a non-empty suggestion is a contradiction.',
    '- Do not comment on the source quality, only on the translation.',
    'Output one JSON object only, no prose and no code fences, shaped as:',
    '{"reviews":[{"id":"<input id>","score":<0-100>,"breakdown":{"fidelity":<0-30>,"terminology":<0-25>,"register":<0-20>,"fluency":<0-15>,"format":<0-10>},"issues":["[<dim>] <short issue>"],"suggestion":"<improved translation or empty>"}]}',
  ]
  const glossaryText = glossaryBlock(glossary, direction)
  if (glossaryText.length > 0) {
    lines.push('', `Glossary the translation must honour (${sourceName} => required ${targetName}):`, glossaryText)
  }
  return lines.join('\n')
}

/**
 * User message carrying items to review.
 * @param {Array<{ id: string, source: string, translation: string }>} items
 * @returns {string}
 */
export function scoringUserMessage(items) {
  return [
    `Review ${items.length} translation(s). Return the JSON object described in the instructions.`,
    JSON.stringify(items.map((item) => ({ id: item.id, source: item.source, translation: item.translation })), null, 1),
  ].join('\n')
}