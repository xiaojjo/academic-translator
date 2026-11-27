/**
 * Paragraph and sentence segmentation.
 *
 * Sentences are split on terminal punctuation that is followed by a new
 * sentence, while common academic abbreviations ("et al.", "e.g.", "Fig. 2"),
 * initials, decimals, and ellipses keep their sentence intact.
 *
 * @module @local/dsh-academic-translator/segment
 */

/** Abbreviations whose trailing period does not end a sentence. */
const ABBREVIATIONS = new Set([
  'al', 'e.g', 'i.e', 'etc', 'fig', 'figs', 'eq', 'eqs', 'vs', 'no', 'nos',
  'approx', 'ca', 'resp', 'cf', 'min', 'max', 'sect', 'sec', 'ref', 'refs',
  'dr', 'prof', 'st', 'mr', 'mrs', 'ms', 'inc', 'ltd', 'vol', 'vols', 'pp',
  'ed', 'eds', 'suppl', 'stat', 'wt', 'sp', 'spp', 'var', 'subsp', 'cv',
  'et', 'a.m', 'p.m', 'u.s', 'u.k', 'e.u', 'tab', 'tabs', 'app', 'appx',
])

/**
 * Last word of a fragment, lowercased and without its trailing period.
 * @param {string} fragment
 * @returns {string}
 */
function trailingWord(fragment) {
  const match = /([A-Za-z][A-Za-z.]*)\s*$/.exec(fragment)
  if (match === null) return ''
  return match[1].replace(/\.+$/u, '').toLowerCase()
}

/**
 * Whether a period after this fragment merely marks an abbreviation.
 * @param {string} fragment
 * @param {string} rawToken the matched word before the period, original case
 * @returns {boolean}
 */
function isAbbreviation(fragment, rawToken) {
  const word = trailingWord(fragment)
  if (word.length === 0) return false
  if (ABBREVIATIONS.has(word)) return true
  // A single capital letter is an initial ("J. Smith"), not a sentence end.
  if (rawToken.length === 1 && rawToken === rawToken.toUpperCase() && /[A-Z]/u.test(rawToken)) return true
  return false
}

/**
 * Split one paragraph into sentences.
 * @param {string} text
 * @returns {string[]} non-empty trimmed sentences.
 */
/** Closing punctuation that belongs to the sentence it closes. */
const CLOSERS = new Set(['」', '』', '”', '’', '"', "'", '）', ')', '】', ']', '》', '〉'])

/** Full-width sentence terminators. Chinese has no ASCII period. */
const CJK_TERMINALS = new Set(['。', '！', '？', '｡'])

/**
 * Consume the rest of one sentence terminator run: repeated terminators
 * ("？！", "……") and closing quotes/brackets stay with their sentence.
 * @param {string} source
 * @param {number} from first index after the terminator
 * @returns {number} index just past the run
 */
function endOfTerminatorRun(source, from) {
  let cursor = from
  while (cursor < source.length) {
    const char = source[cursor]
    if (CJK_TERMINALS.has(char) || char === '.' || char === '!' || char === '?' || char === '…' || CLOSERS.has(char)) {
      cursor += 1
      continue
    }
    break
  }
  return cursor
}

/**
 * Split one paragraph into sentences.
 *
 * Handles both scripts, because the two end a sentence differently: English
 * uses `. ! ?` with the next sentence capitalized, Chinese uses `。！？` with no
 * case signal at all. Treating Chinese text with the English rule would leave a
 * whole paragraph as one "sentence".
 * @param {string} text
 * @returns {string[]} non-empty trimmed sentences.
 */
export function splitSentences(text) {
  const source = text.replace(/\s+/gu, ' ').trim()
  if (source.length === 0) return []
  /** @type {string[]} */
  const sentences = []
  let start = 0
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    const isCjk = CJK_TERMINALS.has(char)
    if (!isCjk && char !== '.' && char !== '!' && char !== '?') continue

    if (!isCjk) {
      const previous = source[index - 1] ?? ''
      const next = source[index + 1] ?? ''
      // Decimals and version numbers: 0.05, 1.2.3
      if (char === '.' && /\d/u.test(previous) && /\d/u.test(next)) continue
      // Ellipsis: keep scanning; the last dot of "..." decides.
      let cursor = index + 1
      while (cursor < source.length && /\s/u.test(source[cursor])) cursor += 1
      if (cursor >= source.length) break
      // A Latin terminator may also open a Chinese sentence, which has no
      // capitalization signal, so accept a CJK character as a sentence start.
      const startsSentence = /[A-Z0-9"'([{]/u.test(source[cursor]) || /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/u.test(source[cursor])
      if (!startsSentence) continue
      const before = source.slice(start, index)
      const tokenMatch = /([A-Za-z]+)$/u.exec(before)
      if (char === '.' && isAbbreviation(before, tokenMatch === null ? '' : tokenMatch[1])) continue
      const sentence = source.slice(start, index + 1).trim()
      if (sentence.length > 0) sentences.push(sentence)
      start = cursor
      index = cursor - 1
      continue
    }

    // Chinese: the terminator itself ends the sentence. Closing quotes and
    // repeated markers belong to it, and there is no capitalization to check.
    const end = endOfTerminatorRun(source, index + 1)
    const sentence = source.slice(start, end).trim()
    if (sentence.length > 0) sentences.push(sentence)
    start = end
    index = end - 1
  }
  const tail = source.slice(start).trim()
  if (tail.length > 0) sentences.push(tail)
  return sentences
}

/**
 * Split raw paper text into paragraphs. Blank lines separate paragraphs;
 * single newlines inside a paragraph are hard wraps and become spaces.
 * @param {string} text
 * @returns {string[]}
 */
export function splitParagraphs(text) {
  const normalized = text.replace(/\r\n?/gu, '\n')
  /** @type {string[]} */
  const paragraphs = []
  let buffer = []
  const flush = () => {
    const joined = buffer.join(' ').replace(/\s+/gu, ' ').trim()
    if (joined.length > 0) paragraphs.push(joined)
    buffer = []
  }
  for (const line of normalized.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) flush()
    else buffer.push(trimmed)
  }
  flush()
  return paragraphs
}

/**
 * Build the display segments of a project at its current granularity.
 * @param {object} project stored project
 * @returns {Array<{ id: string, paragraphId: string, index: number, source: string, granularity: 'paragraph' | 'sentence' }>}
 */
export function buildSegments(project) {
  /** @type {Array<{ id: string, paragraphId: string, index: number, source: string, granularity: 'paragraph' | 'sentence' }>} */
  const segments = []
  for (const paragraph of project.paragraphs) {
    if (project.granularity === 'sentence') {
      const sentences = splitSentences(paragraph.source)
      sentences.forEach((sentence, index) => {
        segments.push({
          id: `${paragraph.id}:s${index + 1}`,
          paragraphId: paragraph.id,
          index,
          source: sentence,
          granularity: 'sentence',
        })
      })
      continue
    }
    segments.push({
      id: paragraph.id,
      paragraphId: paragraph.id,
      index: 0,
      source: paragraph.source,
      granularity: 'paragraph',
    })
  }
  return segments
}

/**
 * Align a whole-paragraph translation onto the sentences of its source.
 *
 * When a paper was translated in paragraph mode and then viewed in sentence
 * mode, the per-sentence keys do not exist yet. Projecting the paragraph
 * translation by position lets the bilingual view show one translation beside
 * each source sentence without writing anything to storage.
 *
 * Alignment is positional and best-effort: when the two languages split into a
 * different number of sentences, extra source sentences are left blank so the
 * user can retranslate them individually. The caller marks the result as
 * derived so nobody mistakes it for a stored, reviewed sentence translation.
 *
 * @param {string} sourceText the original paragraph
 * @param {string} translationText the whole-paragraph translation
 * @returns {Array<{ translation: string, exact: boolean }>} one entry per source sentence
 */
export function alignSentences(sourceText, translationText) {
  const sourceSentences = splitSentences(sourceText)
  const targetSentences = splitSentences(translationText)
  const exact = sourceSentences.length === targetSentences.length
  return sourceSentences.map((_sentence, index) => ({
    translation: targetSentences[index] ?? '',
    exact,
  }))
}

/**
 * Every segment in both granularities, used for counting coverage.
 * @param {object} project
 */
export function countSegments(project) {
  let paragraphs = 0
  let sentences = 0
  for (const paragraph of project.paragraphs) {
    paragraphs += 1
    sentences += splitSentences(paragraph.source).length
  }
  return { paragraphs, sentences }
}

/**
 * Escape a string for use inside a regular expression.
 * @param {string} value
 */
export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}