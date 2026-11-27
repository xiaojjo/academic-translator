/**
 * The plugin's single implementation of every paper-translation operation.
 *
 * Both the Web UI (through the plugin's HTTP routes) and the Agent tool call
 * these methods, so there is one behaviour and one failure shape.
 *
 * @module @local/dsh-academic-translator/service
 */

import { randomUUID } from 'node:crypto'
import { dataDirectory, languagesOf, loadStore, mergeTerms, normalizeDirection, normalizeTerm, saveStore } from './store.js'
import { alignSentences, buildSegments, countSegments, splitParagraphs, splitSentences } from './segment.js'
import { discoverSkills, loadSkillBody } from './skills.js'
import { findViolations, enforceText, locateTerm } from './enforce.js'
import {
  callModel,
  defaultRoute,
  parseReviews,
  parseTerms,
  parseTermText,
  parseTranslations,
  resolveRoute,
} from './engine.js'
import {
  extractionSystemPrompt,
  extractionUserMessage,
  repairReminder,
  scoringSystemPrompt,
  scoringUserMessage,
  translationSystemPrompt,
  translationUserMessage,
} from './prompt.js'

/** Upper bound on the source text accepted in one import. */
const MAX_SOURCE_CHARS = 2_000_000
/** Characters of paper text sent to one terminology-extraction request. */
const EXTRACTION_CHARS = 40000

/**
 * Terms a translated segment failed to honour.
 * Delegates to the enforcement rules, so what is reported and what is forced
 * are decided by exactly one implementation.
 * @param {Array<object>} glossary
 * @param {string} source
 * @param {string} translation
 * @param {'en-zh' | 'zh-en'} direction
 * @returns {string[]} offending source terms
 */
function termIssuesOf(glossary, source, translation, direction = 'en-zh') {
  return findViolations(glossary, source, translation, direction).map((violation) => violation.sourceTerm)
}

/**
 * Violations of a whole-paragraph translation, checked both as one text and
 * sentence by sentence.
 *
 * The whole-paragraph count alone masks a wrong rendering in one sentence
 * whenever the correct rendering of the same term appears in a sibling
 * sentence — the totals cancel out and the paragraph looks clean. Checking
 * each aligned sentence on its own recovers those missed violations, which is
 * exactly what the sentence-mode cards already show.
 *
 * @param {object} paragraph stored paragraph (needs `.source`)
 * @param {{ text?: string, sentences?: string[] } | undefined} stored stored paragraph translation
 * @param {Array<object>} glossary
 * @param {'en-zh' | 'zh-en'} direction
 * @returns {Array<{ sourceTerm: string, required: string }>} deduplicated
 */
function paragraphViolationsOf(paragraph, stored, glossary, direction) {
  if (stored === undefined || typeof stored.text !== 'string' || stored.text.trim().length === 0) return []
  const whole = findViolations(glossary, paragraph.source, stored.text, direction)
  const merged = new Map(whole.map((violation) => [`${violation.sourceTerm}\u0000${violation.required}`, violation]))
  const sentences = splitSentences(paragraph.source)
  derivedSentencesOf(paragraph, stored).forEach(({ translation }, index) => {
    const sentence = sentences[index]
    if (translation.trim().length === 0 || sentence === undefined) return
    for (const violation of findViolations(glossary, sentence, translation, direction)) {
      const key = `${violation.sourceTerm}\u0000${violation.required}`
      if (!merged.has(key)) merged.set(key, violation)
    }
  })
  return [...merged.values()]
}

/**
 * Paragraph id addressed by a sentence-level key (`p1:s2` → `p1`).
 * Whole-paragraph keys have no `:s` suffix and return null.
 * @param {string} segmentId
 * @returns {string | null}
 */
function paragraphIdOfSentence(segmentId) {
  const at = segmentId.indexOf(':s')
  return at > 0 ? segmentId.slice(0, at) : null
}

/**
 * Join translated sentences into one paragraph. A space is inserted after a
 * Latin terminator but not after a CJK one, so the joined text re-splits into
 * the same sentences — the exact reverse of `alignSentences`.
 * @param {string[]} parts
 */
function joinSentences(parts) {
  if (parts.length === 0) return ''
  let out = parts[0]
  for (let index = 1; index < parts.length; index += 1) {
    const previous = parts[index - 1]
    const cjkEnd = /[。！？｡…」』”’）】》〉]$/u.test(previous)
    out += (cjkEnd ? '' : ' ') + parts[index]
  }
  return out
}

/**
 * Sentence-level translations visible for one paragraph, in source order.
 *
 * A per-sentence array written when sentence edits are merged back is
 * authoritative, including empty entries for not-yet-translated sentences.
 * Older records without that array fall back to positional alignment of the
 * whole-paragraph text.
 *
 * @param {object | undefined} paragraph
 * @param {{ text?: string, sentences?: string[] } | undefined} stored
 * @returns {Array<{ translation: string, exact: boolean }>}
 */
function derivedSentencesOf(paragraph, stored) {
  if (paragraph === undefined || stored === undefined) return []
  if (Array.isArray(stored.sentences)) {
    return stored.sentences.map((text) => ({ translation: typeof text === 'string' ? text : '', exact: true }))
  }
  if (typeof stored.text === 'string' && stored.text.trim().length > 0) {
    return alignSentences(paragraph.source, stored.text)
  }
  return []
}

/**
 * Merge one sentence-level translation back into its parent paragraph so the
 * paragraph view always shows the latest text. The parent keeps a positional
 * `sentences` array (with empty entries for untranslated sentences) as the
 * authoritative sentence breakdown, and `text` is its joined rendering.
 * @param {object} project
 * @param {object} translations
 * @param {string} segmentId a `pN:sM` key
 * @param {string} text the new sentence translation
 * @param {number} at
 */
function mergeSentenceIntoParagraph(project, translations, segmentId, text, at) {
  const match = /^(.+):s(\d+)$/u.exec(segmentId)
  if (match === null) return
  const parent = project.paragraphs.find((item) => item.id === match[1])
  if (parent === undefined) return
  const index = Number(match[2]) - 1
  const derived = derivedSentencesOf(parent, translations[parent.id])
  const count = Math.max(derived.length, splitSentences(parent.source).length)
  if (index < 0 || index >= count) return

  // Rebuild the positional array from the current authoritative sources:
  // the edited sentence uses the new text (empty means "delete"), siblings
  // prefer their own override, then the previously derived value.
  const sentences = []
  for (let position = 0; position < count; position += 1) {
    if (position === index) {
      sentences.push(text)
      continue
    }
    const own = translations[`${parent.id}:s${position + 1}`]
    if (own !== undefined && own.text.trim().length > 0) sentences.push(own.text)
    else sentences.push(derived[position]?.translation ?? '')
  }
  // The paragraph text is the join of translated sentences only, so it stays
  // clean even while some sentences are still untranslated.
  translations[parent.id] = {
    text: joinSentences(sentences.filter((part) => part.length > 0)),
    sentences,
    at,
  }
}

/**
 * Store a translation while keeping the paragraph and sentence views in sync.
 *
 * A whole-paragraph write becomes the single source of truth and drops any
 * earlier sentence overrides. A sentence write keeps its override and is also
 * merged back into the parent paragraph, so switching granularity never shows
 * stale text in either direction.
 *
 * @param {object} project
 * @param {object} translations
 * @param {string} segmentId
 * @param {string} text
 * @param {number} at
 */
function writeTranslation(project, translations, segmentId, text, at) {
  const parentId = paragraphIdOfSentence(segmentId)
  if (parentId === null) {
    if (text.length === 0) delete translations[segmentId]
    else translations[segmentId] = { text, at }
    for (const key of Object.keys(translations)) {
      if (key.startsWith(`${segmentId}:s`)) delete translations[key]
    }
    return
  }
  if (text.length === 0) delete translations[segmentId]
  else translations[segmentId] = { text, at }
  mergeSentenceIntoParagraph(project, translations, segmentId, text, at)
}

/**
 * Split items into request-sized batches.
 * @param {Array<{ id: string, source: string }>} items
 * @param {number} batchSize
 * @param {number} maxChars
 */
function makeBatches(items, batchSize, maxChars) {
  /** @type {Array<Array<{ id: string, source: string }>>} */
  const batches = []
  /** @type {Array<{ id: string, source: string }>} */
  let current = []
  let chars = 0
  for (const item of items) {
    const tooMany = current.length >= batchSize
    const tooLong = chars + item.source.length > maxChars && current.length > 0
    if (tooMany || tooLong) {
      batches.push(current)
      current = []
      chars = 0
    }
    current.push(item)
    chars += item.source.length
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/**
 * Build the translation service bound to one Host context.
 * @param {any} ctx Cordis context exposing llm, and optionally skills
 */
export function createTranslatorService(ctx) {
  const directory = dataDirectory()
  let store = loadStore(directory)
  /** @type {Map<string, { controller: AbortController, running: boolean, done: number, total: number, current: string, error: string | null, startedAt: number }>} */
  const jobs = new Map()

  const persist = () => saveStore(directory, store)

  /**
   * @param {string} id
   * @returns {object} the stored project
   */
  function requireProject(id) {
    const project = store.projects[id]
    if (project === undefined) throw new Error('Project not found')
    return project
  }

  const touch = (project) => {
    project.updatedAt = Date.now()
    persist()
  }

  /**
   * Directory used for workspace-sensitive skill discovery.
   * User and project skill layers are only visible when a cwd is supplied.
   * @returns {string}
   */
  function skillCwd() {
    const service = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
    if (service !== undefined && service !== null && typeof service.defaultDirectory === 'string' && service.defaultDirectory.length > 0) {
      return service.defaultDirectory
    }
    try {
      const directories = typeof ctx.get === 'function' ? ctx.get('directories') : undefined
      if (directories !== undefined && directories !== null) {
        const listed = directories.list?.()
        if (Array.isArray(listed) && typeof listed[0]?.path === 'string') return listed[0].path
      }
    } catch {
      /* fall through */
    }
    return process.cwd()
  }

  /**
   * Discovered skill roots for this profile and workspace.
   * @returns {{ cwd?: string, installDir?: string }}
   */
  function skillOptions() {
    return {
      cwd: skillCwd(),
      installDir: typeof process.env.DSH_INSTALL_DIR === 'string' ? process.env.DSH_INSTALL_DIR : undefined,
    }
  }

  /** @returns {Array<{ name: string, description: string, source: string }>} */
  async function listSkills() {
    const service = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
    /** @type {Map<string, { name: string, description: string, source: string }>} */
    const merged = new Map()
    for (const skill of discoverSkills(skillOptions())) {
      merged.set(skill.name, { name: skill.name, description: skill.description, source: 'filesystem' })
    }
    if (service !== undefined && service !== null && typeof service.list === 'function') {
      try {
        const summaries = await service.list({ cwd: skillCwd() })
        for (const summary of summaries) {
          merged.set(summary.name, {
            name: summary.name,
            description: summary.description,
            source: String(summary.source ?? ''),
          })
        }
      } catch {
        /* the filesystem result still stands */
      }
    }
    return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name))
  }

  /**
   * Load the bodies of the selected skills.
   * The Host service wins because it resolves layered overrides; a skill only it
   * cannot see is read from the discovered file.
   * @param {string[]} names
   * @returns {Promise<Array<{ name: string, content: string }>>}
   */
  async function loadSkills(names) {
    if (names.length === 0) return []
    const service = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
    const onDisk = new Map(discoverSkills(skillOptions()).map((skill) => [skill.name, skill.path]))
    /** @type {Array<{ name: string, content: string }>} */
    const out = []
    /** @type {string[]} */
    const missing = []
    for (const name of names) {
      let content = null
      if (service !== undefined && service !== null && typeof service.get === 'function') {
        try {
          const skill = await service.get(name, { cwd: skillCwd() })
          if (skill !== undefined && skill !== null && typeof skill.content === 'string') content = skill.content
        } catch {
          content = null
        }
      }
      if (content === null) {
        const file = onDisk.get(name)
        if (file !== undefined) content = loadSkillBody(file)
      }
      if (content === null || content.trim().length === 0) {
        missing.push(name)
        continue
      }
      out.push({ name, content })
    }
    // A silently skipped skill would let the user believe guidance was injected.
    if (out.length === 0) {
      throw new Error(`None of the selected skills could be loaded: ${missing.join(', ')}. Clear the skill selection or re-check the skill names.`)
    }
    return out
  }

  /** @returns {Array<{ id: string, name: string }>} */
  function listProviders() {
    const service = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
    if (service === undefined || service === null || typeof service.listProviders !== 'function') return []
    try {
      return service.listProviders()
    } catch {
      return []
    }
  }

  /**
   * The one glossary this profile uses. It is shared by every paper, so a term
   * only has to be entered once and stays consistent across papers.
   * @returns {Array<{ en: string, zh: string, note: string, approved: boolean, origin: string }>}
   */
  function glossaryTerms() {
    if (!Array.isArray(store.glossary)) store.glossary = []
    return store.glossary
  }

  /**
   * The translation bucket of one project at its current direction.
   * Translations are kept per direction, so switching direction never destroys
   * work done in the other one.
   * @param {object} project
   */
  function bucketOf(project) {
    const direction = normalizeDirection(project.direction)
    if (project.translations[direction] === undefined) project.translations[direction] = {}
    return project.translations[direction]
  }

  /**
   * The review bucket of one project at its current direction.
   * @param {object} project
   */
  function reviewBucketOf(project) {
    const direction = normalizeDirection(project.direction)
    if (project.reviews[direction] === undefined) project.reviews[direction] = {}
    return project.reviews[direction]
  }

  /**
   * The enforcement bucket of one project at its current direction.
   * @param {object} project
   */
  function enforcementBucketOf(project) {
    const direction = normalizeDirection(project.direction)
    if (project.enforcements === undefined) project.enforcements = { 'en-zh': {}, 'zh-en': {} }
    if (project.enforcements[direction] === undefined) project.enforcements[direction] = {}
    return project.enforcements[direction]
  }

  /** @param {object} project @param {string} paragraphId */
  function paragraphSourceOf(project, paragraphId) {
    const paragraph = project.paragraphs.find((item) => item.id === paragraphId)
    return paragraph === undefined ? '' : paragraph.source
  }

  /**
   * Projection sent to the UI and returned by the tool.
   * @param {object} project
   */
  function projectView(project) {
    const segments = buildSegments(project)
    const glossary = glossaryTerms()
    const direction = normalizeDirection(project.direction)
    const translations = bucketOf(project)
    const reviews = reviewBucketOf(project)
    const enforcements = enforcementBucketOf(project)
    // Cache the sentence alignment of each whole-paragraph translation. A
    // paragraph-mode translation must stay visible when the user switches to
    // sentence mode, without duplicating any stored data.
    /** @type {Map<string, Array<{ translation: string, exact: boolean }>>} */
    const derived = new Map()
    const derivedFor = (paragraphId) => {
      if (derived.has(paragraphId)) return derived.get(paragraphId)
      const paragraph = project.paragraphs.find((item) => item.id === paragraphId)
      const aligned = derivedSentencesOf(paragraph, translations[paragraphId])
      derived.set(paragraphId, aligned)
      return aligned
    }
    const rows = segments.map((segment) => {
      const stored = translations[segment.id]
      const isSentence = segment.granularity === 'sentence'
      let text = stored === undefined ? '' : stored.text
      let derivedFrom = ''
      let derivedExact = false
      if (isSentence && text.length === 0) {
        const aligned = derivedFor(segment.paragraphId)
        const candidate = aligned[segment.index]
        if (candidate !== undefined && candidate.translation.length > 0) {
          text = candidate.translation
          derivedFrom = segment.paragraphId
          derivedExact = candidate.exact
        }
      }
      const review = reviews[segment.id]
      const enforcement = enforcements[segment.id]
      // The live check is what counts; the stored record explains how it got
      // there (repaired by substitution, or still unresolved). Whole-paragraph
      // rows use the sentence-by-sentence probe so a wrong rendering in one
      // sentence is not masked by correct renderings elsewhere in the text.
      const isParagraphRow = !isSentence
      const violations =
        text.length === 0
          ? []
          : isParagraphRow
            ? paragraphViolationsOf(project.paragraphs.find((item) => item.id === segment.id), translations[segment.id], glossary, direction)
            : findViolations(glossary, segment.source, text, direction)
      // Red-mark support: where exactly each violating term sits in the source,
      // so the client can highlight the offender instead of only listing it.
      // The translation side has nothing to locate (the term is absent — that
      // is the violation), so it gets a "required rendering" hint instead.
      const termMarks = project.strictTerms
        ? violations.map((violation) => ({
            term: violation.sourceTerm,
            required: violation.required,
            sourceRanges: locateTerm(segment.source, violation.sourceTerm),
          }))
        : []
      return {
        id: segment.id,
        paragraphId: segment.paragraphId,
        index: segment.index,
        source: segment.source,
        translation: text,
        derivedFrom,
        derivedExact,
        issues: project.strictTerms ? violations.map((violation) => violation.sourceTerm) : [],
        termMarks,
        enforcement:
          enforcement === undefined
            ? null
            : {
                status: violations.length === 0 ? (enforcement.status === 'failed' ? 'repaired' : enforcement.status) : 'failed',
                attempts: enforcement.attempts,
                applied: enforcement.applied,
                unresolved: violations.length > 0 ? violations.map((violation) => violation.sourceTerm) : enforcement.unresolved.map((item) => item.sourceTerm),
                at: enforcement.at,
              },
        review:
          review === undefined
            ? null
            : {
                score: review.score,
                breakdown: review.breakdown ?? null,
                issues: review.issues,
                suggestion: review.suggestion,
                status: review.status,
                at: review.at,
                model: review.model,
              },
        updatedAt: stored === undefined ? 0 : stored.at,
      }
    })
    const translated = rows.filter((row) => row.translation.length > 0).length
    const scored = rows.filter((row) => row.review !== null && row.translation.length > 0)
    const scoreSum = scored.reduce((total, row) => total + row.review.score, 0)
    const job = jobs.get(project.id)
    return {
      id: project.id,
      title: project.title,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      granularity: project.granularity,
      direction,
      languages: languagesOf(direction),
      view: project.view,
      skills: project.skills,
      strictTerms: project.strictTerms,
      paragraphs: project.paragraphs.map((paragraph) => ({ id: paragraph.id, source: paragraph.source })),
      segments: rows,
      glossary,
      counts: {
        ...countSegments(project),
        segments: rows.length,
        translated,
        missing: rows.length - translated,
        issues: rows.reduce((total, row) => total + row.issues.length, 0),
        scored: scored.length,
        averageScore: scored.length === 0 ? null : Math.round(scoreSum / scored.length),
        pendingRevisions: rows.filter((row) => row.review !== null && row.review.status === 'open' && row.review.suggestion.length > 0).length,
        repaired: rows.filter((row) => row.enforcement !== null && row.enforcement.status === 'repaired').length,
        unresolved: rows.filter((row) => row.issues.length > 0).length,
      },
      job:
        job === undefined
          ? null
          : {
              running: job.running,
              done: job.done,
              total: job.total,
              current: job.current,
              error: job.error,
              startedAt: job.startedAt,
              kind: job.kind,
            },
    }
  }

  /** @param {object} project */
  function summaryOf(project) {
    const counts = countSegments(project)
    const total = project.granularity === 'sentence' ? counts.sentences : counts.paragraphs
    const done = Object.keys(bucketOf(project)).length
    return {
      id: project.id,
      title: project.title,
      updatedAt: project.updatedAt,
      order: typeof project.order === 'number' ? project.order : Number.MAX_SAFE_INTEGER,
      granularity: project.granularity,
      direction: normalizeDirection(project.direction),
      paragraphs: counts.paragraphs,
      segments: total,
      translated: Math.min(done, total),
    }
  }

  /**
   * Full state for the workbench.
   * @param {{ projectId?: string }} options
   */
  async function state(options = {}) {
    const projects = Object.values(store.projects)
      // Manual order wins (drag-and-drop); updatedAt is the fallback for
      // papers that have never been reordered.
      .sort((left, right) => {
        const leftOrder = typeof left.order === 'number' ? left.order : Number.MAX_SAFE_INTEGER
        const rightOrder = typeof right.order === 'number' ? right.order : Number.MAX_SAFE_INTEGER
        if (leftOrder !== rightOrder) return leftOrder - rightOrder
        return right.updatedAt - left.updatedAt
      })
      .map(summaryOf)
    const activeId = options.projectId ?? projects[0]?.id
    const active = activeId === undefined ? undefined : store.projects[activeId]
    return {
      settings: store.settings,
      defaultRoute: defaultRoute(ctx),
      effectiveRoute: (() => {
        try {
          return resolveRoute(ctx, store.settings)
        } catch {
          return null
        }
      })(),
      providers: listProviders(),
      skills: await listSkills(),
      // Shared by every paper: one table, edited in one place.
      glossary: glossaryTerms(),
      projects,
      active: active === undefined || active === null ? null : projectView(active),
    }
  }

  /**
   * Translate every segment of a job kind.
   * @param {object} project
   * @param {object} options
   */
  async function runTranslation(project, options) {
    const settings = store.settings
    const granularity = project.granularity
    const direction = normalizeDirection(project.direction)
    const translations = bucketOf(project)
    const reviews = reviewBucketOf(project)
    const all = buildSegments(project)
    const wanted = options.ids === undefined ? null : new Set(options.ids)
    // A sentence already covered by a whole-paragraph translation counts as
    // translated, so switching granularity never re-translates the same text.
    /** @type {Set<string>} */
    const derivedIds = new Set()
    if (project.granularity === 'sentence') {
      const byParagraph = new Map()
      for (const paragraph of project.paragraphs) {
        const stored = translations[paragraph.id]
        if (stored === undefined || stored.text.trim().length === 0) continue
        byParagraph.set(paragraph.id, alignSentences(paragraph.source, stored.text))
      }
      for (const segment of all) {
        const aligned = byParagraph.get(segment.paragraphId)
        const candidate = aligned?.[segment.index]
        if (candidate !== undefined && candidate.translation.length > 0) derivedIds.add(segment.id)
      }
    }
    const selected = all.filter((segment) => {
      if (wanted !== null && !wanted.has(segment.id)) return false
      if (options.scope === 'missing' && (translations[segment.id] !== undefined || derivedIds.has(segment.id))) return false
      return true
    })
    if (selected.length === 0) return { started: false, reason: 'Nothing to translate' }

    const controller = new AbortController()
    const job = {
      controller,
      running: true,
      kind: 'translate',
      done: 0,
      total: selected.length,
      current: '',
      error: null,
      startedAt: Date.now(),
    }
    jobs.set(project.id, job)

    const items = selected.map((segment) => ({ id: segment.id, source: segment.source }))
    const batches = makeBatches(items, Math.max(1, settings.batchSize), Math.max(500, settings.maxCharsPerBatch))

    void (async () => {
      let failed = 0
      try {
        const skills = await loadSkills(project.skills)
        const system = translationSystemPrompt({
          glossary: glossaryTerms(),
          skills,
          direction,
          granularity,
          instructions: settings.instructions,
        })
        const route = resolveRoute(ctx, settings)
        for (const batch of batches) {
          if (controller.signal.aborted) break
          job.current = `${batch[0].id} … ${batch[batch.length - 1].id}`
          const ids = batch.map((item) => item.id)
          let parsed = null
          try {
            const answer = await callModel(ctx, route, {
              system,
              user: translationUserMessage(batch),
              timeoutMs: settings.timeoutMs,
              reasoningEffort: settings.reasoningEffort,
              signal: controller.signal,
            })
            parsed = parseTranslations(answer, ids)
            if (parsed === null) {
              const repaired = await callModel(ctx, route, {
                system,
                user: `${translationUserMessage(batch)}\n\n${repairReminder(ids)}`,
                timeoutMs: settings.timeoutMs,
                reasoningEffort: settings.reasoningEffort,
                signal: controller.signal,
              })
              parsed = parseTranslations(repaired, ids)
            }
          } catch (error) {
            if (controller.signal.aborted) break
            failed += batch.length
            job.error = error instanceof Error ? error.message : String(error)
            job.done += batch.length
            continue
          }
          if (parsed === null) {
            failed += batch.length
            job.error = 'The model answer did not contain usable translations.'
            job.done += batch.length
            continue
          }
          const now = Date.now()
          const enforcements = enforcementBucketOf(project)
          const routeForEnforce = route
          for (const item of batch) {
            const raw = parsed[item.id]
            if (raw === undefined) continue
            let text = raw
            // The glossary is a contract: force the required rendering now,
            // before the segment is ever stored as finished.
            if (project.strictTerms && glossaryTerms().length > 0) {
              const enforced = await enforceText({
                glossary: glossaryTerms(),
                source: item.source,
                translation: raw,
                direction,
                ask: ({ system: askSystem, user }) =>
                  callModel(ctx, routeForEnforce, {
                    system: askSystem,
                    user,
                    timeoutMs: settings.timeoutMs,
                    maxTokens: 2048,
                    reasoningEffort: settings.reasoningEffort,
                    signal: controller.signal,
                  }),
              })
              text = enforced.text
              enforcements[item.id] = enforced.result
            }
            writeTranslation(project, translations, item.id, text, Date.now())
            // A new translation invalidates the review made on the old one.
            delete reviews[item.id]
          }
          job.done += batch.length
          project.updatedAt = now
          persist()
        }
        if (failed > 0) {
          job.error = job.error ?? `${failed} item(s) could not be translated.`
        }
      } catch (error) {
        job.error = error instanceof Error ? error.message : String(error)
      } finally {
        job.running = false
        job.current = ''
        project.updatedAt = Date.now()
        persist()
      }
    })()

    return { started: true, total: selected.length, batches: batches.length }
  }

  /**
   * Score every translated segment and propose a revision.
   * Nothing is applied automatically: each revision waits for accept or reject.
   * @param {object} project
   * @param {object} options
   */
  async function runReview(project, options) {
    const settings = store.settings
    const direction = normalizeDirection(project.direction)
    const granularity = project.granularity
    const translations = bucketOf(project)
    const reviews = reviewBucketOf(project)
    const wanted = options.ids === undefined ? null : new Set(options.ids)
    // Score exactly what the user sees. In sentence mode many visible rows are
    // derived from a whole-paragraph translation and have no sentence-level key
    // in storage; ignoring them made "Score" appear to do nothing.
    const visible = new Map(projectView(project).segments.map((row) => [row.id, row]))
    const all = buildSegments(project)
    const selected = all.filter((segment) => {
      if (wanted !== null && !wanted.has(segment.id)) return false
      const row = visible.get(segment.id)
      if (row === undefined || row.translation.trim().length === 0) return false
      // `all` re-scores everything; the default skips what is already reviewed.
      if (options.scope !== 'all' && wanted === null && reviews[segment.id] !== undefined) return false
      return true
    })
    if (selected.length === 0) return { started: false, reason: 'Nothing to review' }

    const controller = new AbortController()
    const route = resolveRoute(ctx, settings)
    const job = {
      controller,
      running: true,
      kind: 'review',
      done: 0,
      total: selected.length,
      current: '',
      error: null,
      startedAt: Date.now(),
    }
    jobs.set(project.id, job)

    const items = selected.map((segment) => ({
      id: segment.id,
      source: segment.source,
      translation: visible.get(segment.id).translation,
    }))
    const batches = makeBatches(items, Math.max(1, settings.batchSize), Math.max(500, settings.maxCharsPerBatch))
    const modelLabel = `${route.provider}/${route.model}`

    void (async () => {
      let failed = 0
      try {
        const system = scoringSystemPrompt({ direction, glossary: glossaryTerms() })
        for (const batch of batches) {
          if (controller.signal.aborted) break
          job.current = `${batch[0].id} … ${batch[batch.length - 1].id}`
          const ids = batch.map((item) => item.id)
          let parsed = null
          try {
            const answer = await callModel(ctx, route, {
              system,
              user: scoringUserMessage(batch),
              timeoutMs: settings.timeoutMs,
              reasoningEffort: settings.reasoningEffort,
              signal: controller.signal,
            })
            parsed = parseReviews(answer, ids)
          } catch (error) {
            if (controller.signal.aborted) break
            failed += batch.length
            job.error = error instanceof Error ? error.message : String(error)
            job.done += batch.length
            continue
          }
          if (parsed === null) {
            failed += batch.length
            job.error = 'The model answer did not contain usable scores.'
            job.done += batch.length
            continue
          }
          const now = Date.now()
          for (const item of batch) {
            const review = parsed[item.id]
            if (review === undefined) continue
            reviews[item.id] = {
              score: review.score,
              breakdown: review.breakdown ?? null,
              issues: review.issues,
              suggestion: review.suggestion,
              status: 'open',
              at: now,
              model: modelLabel,
            }
          }
          job.done += batch.length
          project.updatedAt = now
          persist()
        }
        if (failed > 0) job.error = job.error ?? `${failed} item(s) could not be scored.`
        // `granularity` is read for symmetry with translation input framing.
        void granularity
      } catch (error) {
        job.error = error instanceof Error ? error.message : String(error)
      } finally {
        job.running = false
        job.current = ''
        project.updatedAt = Date.now()
        persist()
      }
    })()

    return { started: true, total: selected.length, batches: batches.length }
  }

  const actions = {
    /** @param {{ projectId?: string }} payload */
    state: async (payload) => state(payload),

    /** @param {{ title?: string, source?: string }} payload */
    createProject: async (payload) => {
      const source = typeof payload.source === 'string' ? payload.source.slice(0, MAX_SOURCE_CHARS) : ''
      const paragraphs = splitParagraphs(source).map((text, index) => ({ id: `p${index + 1}`, source: text }))
      const title =
        typeof payload.title === 'string' && payload.title.trim().length > 0
          ? payload.title.trim()
          : paragraphs[0] !== undefined
            ? paragraphs[0].source.slice(0, 60)
            : 'Untitled paper'
      const project = {
        id: randomUUID(),
        title,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        granularity: 'paragraph',
        direction: normalizeDirection(payload.direction),
        view: 'bilingual',
        paragraphs,
        translations: { 'en-zh': {}, 'zh-en': {} },
        reviews: { 'en-zh': {}, 'zh-en': {} },
        enforcements: { 'en-zh': {}, 'zh-en': {} },
        skills: [],
        strictTerms: true,
      }
      store.projects[project.id] = project
      persist()
      return { projectId: project.id, paragraphs: paragraphs.length }
    },

    /** @param {{ projectId: string, title?: string, source?: string }} payload */
    updateProject: async (payload) => {
      const project = requireProject(payload.projectId)
      if (typeof payload.title === 'string' && payload.title.trim().length > 0) project.title = payload.title.trim()
      if (typeof payload.source === 'string') {
        const paragraphs = splitParagraphs(payload.source.slice(0, MAX_SOURCE_CHARS)).map((text, index) => ({
          id: `p${index + 1}`,
          source: text,
        }))
        project.paragraphs = paragraphs
        // Paragraph ids were renumbered, so stored enforcement records no longer
        // describe these segments.
        project.enforcements = { 'en-zh': {}, 'zh-en': {} }
      }
      if (payload.granularity === 'paragraph' || payload.granularity === 'sentence') {
        project.granularity = payload.granularity
      }
      if (payload.direction === 'en-zh' || payload.direction === 'zh-en') {
        project.direction = normalizeDirection(payload.direction)
      }
      if (payload.view === 'bilingual' || payload.view === 'source' || payload.view === 'target') project.view = payload.view
      if (Array.isArray(payload.skills)) project.skills = payload.skills.filter((name) => typeof name === 'string')
      if (typeof payload.strictTerms === 'boolean') project.strictTerms = payload.strictTerms
      touch(project)
      return { project: projectView(project) }
    },

    /**
     * Edit the source text of one segment in place.
     *
     * Editing the source without clearing its translation would leave a
     * translation of text that no longer exists, so the callers decide: the
     * default clears the translation of the edited segment and marks it for
     * retranslation. `keepTranslation` preserves it when the user only fixed a
     * typo.
     *
     * The target may be a whole paragraph (`p3`) or, in sentence mode, a single
     * sentence (`p3:s2`). A sentence edit rewrites the paragraph source with
     * that one sentence replaced and clears only that sentence's records, so
     * sibling sentences keep their translations.
     * @param {{ projectId: string, paragraphId?: string, segmentId?: string, source: string, keepTranslation?: boolean }} payload
     */
    editSource: async (payload) => {
      const project = requireProject(payload.projectId)
      // Accept the modern segmentId first; paragraphId stays for older callers.
      const requested = typeof payload.segmentId === 'string' && payload.segmentId.length > 0 ? payload.segmentId : typeof payload.paragraphId === 'string' ? payload.paragraphId : ''
      const source = typeof payload.source === 'string' ? payload.source.trim() : ''
      const sentenceMatch = /^([^:]+):s(\d+)$/u.exec(requested)
      const paragraphId = sentenceMatch === null ? requested : sentenceMatch[1]
      const paragraph = project.paragraphs.find((item) => item.id === paragraphId)
      if (paragraph === undefined) throw new Error('Unknown paragraph')
      if (source.length === 0) throw new Error('The source text cannot be empty; delete the paper instead.')
      const sentenceIndex = sentenceMatch === null ? -1 : Number(sentenceMatch[2]) - 1
      if (sentenceIndex >= 0) {
        const sentences = splitSentences(paragraph.source)
        if (sentenceIndex >= sentences.length) throw new Error('Unknown sentence')
        if (sentences[sentenceIndex] === source) return { changed: false, project: projectView(project) }
        sentences[sentenceIndex] = source
        // Paragraph sources are whitespace-normalized, so rejoining with
        // single spaces matches how splitParagraphs would have stored it.
        paragraph.source = sentences.join(' ')
      } else {
        if (paragraph.source === source) return { changed: false, project: projectView(project) }
        paragraph.source = source
      }
      if (payload.keepTranslation !== true) {
        // The `:s` suffixes live in the same buckets, so gather them per
        // bucket instead of assuming one direction key.
        const collectDerived = (bucket) => Object.keys(bucket ?? {}).filter((key) => key.startsWith(`${paragraphId}:s`))
        /** @type {Record<string, string[]>} */
        const derivedByBucket = {}
        for (const [name, bucket] of Object.entries(project.translations)) derivedByBucket[name] = collectDerived(bucket)
        for (const [name, bucket] of Object.entries(project.reviews)) {
          if (derivedByBucket[name] === undefined) derivedByBucket[name] = []
          derivedByBucket[name].push(...collectDerived(bucket))
        }
        for (const [name, bucket] of Object.entries(project.enforcements)) {
          if (derivedByBucket[name] === undefined) derivedByBucket[name] = []
          derivedByBucket[name].push(...collectDerived(bucket))
        }
        const allBuckets = [
          ...Object.values(project.translations),
          ...Object.values(project.reviews),
          ...Object.values(project.enforcements),
        ]
        if (sentenceIndex >= 0) {
          // Only the edited sentence is stale. Delete its own records, keep
          // the parent (so siblings derived from it survive), and blank just
          // that slot in the parent's authoritative `sentences` array.
          for (const bucket of allBuckets) delete bucket[requested]
          for (const bucket of Object.values(project.translations)) {
            const parentText = bucket[paragraphId]
            if (parentText === undefined) continue
            const sentences = Array.isArray(parentText.sentences)
              ? parentText.sentences.slice()
              : derivedSentencesOf(paragraph, parentText).map((row) => row.translation)
            if (sentenceIndex >= sentences.length) continue
            sentences[sentenceIndex] = ''
            parentText.sentences = sentences
            parentText.text = joinSentences(sentences.filter((part) => typeof part === 'string' && part.length > 0))
          }
        } else {
          // A paragraph edit invalidates the paragraph and every sentence
          // derived from it, in every bucket.
          for (const [name, bucket] of Object.entries(project.translations)) {
            delete bucket[paragraphId]
            for (const key of derivedByBucket[name] ?? []) delete bucket[key]
          }
          for (const [name, bucket] of Object.entries(project.reviews)) {
            delete bucket[paragraphId]
            for (const key of derivedByBucket[name] ?? []) delete bucket[key]
          }
          for (const [name, bucket] of Object.entries(project.enforcements)) {
            delete bucket[paragraphId]
            for (const key of derivedByBucket[name] ?? []) delete bucket[key]
          }
        }
      }
      touch(project)
      return { changed: true, project: projectView(project) }
    },

    /** @param {{ projectId: string, paragraphId?: string, afterId?: string, source: string }} payload */
    addParagraph: async (payload) => {
      const project = requireProject(payload.projectId)
      const source = typeof payload.source === 'string' ? payload.source.trim() : ''
      if (source.length === 0) throw new Error('The new paragraph is empty.')
      // Append, then renumber so ids stay p1..pn and reading order is stable.
      project.paragraphs.push({ id: `p${project.paragraphs.length + 1}`, source })
      project.paragraphs = project.paragraphs.map((paragraph, index) => ({ ...paragraph, id: `p${index + 1}` }))
      touch(project)
      return { project: projectView(project) }
    },

    /** @param {{ projectId: string, paragraphId: string }} payload */
    deleteParagraph: async (payload) => {
      const project = requireProject(payload.projectId)
      const paragraphId = typeof payload.paragraphId === 'string' ? payload.paragraphId : ''
      if (!project.paragraphs.some((item) => item.id === paragraphId)) throw new Error('Unknown paragraph')
      project.paragraphs = project.paragraphs
        .filter((item) => item.id !== paragraphId)
        .map((item, index) => ({ ...item, id: `p${index + 1}` }))
      // Ids were renumbered, so every stored record for this project is stale.
      project.translations = { 'en-zh': {}, 'zh-en': {} }
      project.reviews = { 'en-zh': {}, 'zh-en': {} }
      project.enforcements = { 'en-zh': {}, 'zh-en': {} }
      touch(project)
      return { project: projectView(project) }
    },

    /** @param {{ projectId: string }} payload */
    deleteProject: async (payload) => {
      const project = requireProject(payload.projectId)
      jobs.delete(project.id)
      delete store.projects[project.id]
      persist()
      return { deleted: project.id }
    },

    /**
     * Persist a manual paper order (drag-and-drop in the sidebar).
     * @param {{ order: string[] }} payload ordered project ids
     */
    reorderProjects: async (payload) => {
      const ids = Array.isArray(payload.order) ? payload.order.filter((id) => typeof id === 'string') : []
      let rank = 0
      for (const id of ids) {
        const project = store.projects[id]
        if (project === undefined) continue
        project.order = rank
        rank += 1
      }
      // Papers missing from the payload keep a deterministic tail position.
      for (const project of Object.values(store.projects)) {
        if (typeof project.order !== 'number') project.order = rank + Object.keys(store.projects).length
      }
      persist()
      return { ordered: ids.length }
    },

    /** @param {{ projectId?: string, glossary: Array<object>, replace?: boolean, merge?: boolean }} payload */
    setGlossary: async (payload) => {
      const rows = Array.isArray(payload.glossary) ? payload.glossary : []
      /** @type {Array<{ en: string, zh: string, note: string, approved: boolean, origin: string }>} */
      const next = []
      for (const row of rows) {
        const term = normalizeTerm(row)
        if (term === null || term.en.length === 0) continue
        next.push(term)
      }
      // The table is shared by every paper; `merge` adds rather than replaces.
      if (payload.merge === true) mergeTerms(glossaryTerms(), next)
      else store.glossary = next
      persist()
      return { glossary: glossaryTerms() }
    },

    /**
     * Parse pasted terminology text (Markdown table, CSV/TSV, or `en=zh` lines)
     * into glossary rows. Does not write anything: the client previews first.
     * @param {{ text: string }} payload
     */
    importTerms: async (payload) => {
      const rows = parseTermText(typeof payload.text === 'string' ? payload.text : '')
      return { glossary: rows }
    },

    /** @param {{ projectId: string, maxTerms?: number }} payload */
    extractTerms: async (payload) => {
      const project = requireProject(payload.projectId)
      const settings = store.settings
      const direction = normalizeDirection(project.direction)
      const text = project.paragraphs
        .map((paragraph) => paragraph.source)
        .join('\n\n')
        .slice(0, EXTRACTION_CHARS)
      if (text.trim().length === 0) throw new Error('Import the paper text first.')
      const route = resolveRoute(ctx, settings)
      const maxTerms = Math.max(5, Math.min(200, Number(payload.maxTerms) || settings.maxTerms))
      const answer = await callModel(ctx, route, {
        system: extractionSystemPrompt(direction, maxTerms),
        user: extractionUserMessage(text),
        timeoutMs: settings.timeoutMs,
        maxTokens: 4096,
        reasoningEffort: settings.reasoningEffort,
      })
      const terms = parseTerms(answer).slice(0, maxTerms)
      if (terms.length === 0) throw new Error('The model returned no usable terms.')
      // Terms live in `en`/`zh` slots regardless of direction, so one pair serves
      // both directions of the same paper.
      const asPair = (term) => (direction === 'zh-en' ? { en: term.zh, zh: term.en } : { en: term.en, zh: term.zh })
      const existing = new Set(glossaryTerms().map((entry) => entry.en.toLowerCase()))
      let added = 0
      for (const term of terms) {
        const pair = asPair(term)
        if (existing.has(pair.en.toLowerCase())) continue
        existing.add(pair.en.toLowerCase())
        glossaryTerms().push({ en: pair.en, zh: pair.zh, note: term.note, approved: true, origin: 'extracted' })
        added += 1
      }
      // Extracted terms join the shared table, so other papers benefit too.
      persist()
      return { added, glossary: glossaryTerms() }
    },

    /**
     * Re-run glossary enforcement over translations that already exist.
     * Needed after the glossary itself changes: an entry added or renamed later
     * must still reach the segments translated before it.
     * @param {{ projectId: string, scope?: string, ids?: string[] }} payload
     */
    enforceTerms: async (payload) => {
      const project = requireProject(payload.projectId)
      const settings = store.settings
      const direction = normalizeDirection(project.direction)
      const translations = bucketOf(project)
      const enforcements = enforcementBucketOf(project)
      const reviews = reviewBucketOf(project)
      const wanted = payload.ids === undefined ? null : new Set(payload.ids)
      const glossary = glossaryTerms()

      // Enforce at the canonical storage level. In sentence mode the visible
      // text is often *derived* from a whole-paragraph translation and has no
      // sentence-level key in storage; looking only at sentence keys would find
      // nothing and make the button appear broken. Fixing the stored paragraph
      // also fixes every sentence derived from it in one pass.
      /** @type {Array<{ key: string, source: string, text: string }>} */
      const targets = []

      // When specific ids are given, resolve each to the key holding its text.
      if (wanted !== null) {
        for (const segment of buildSegments(project)) {
          if (!wanted.has(segment.id)) continue
          const own = translations[segment.id]
          const key = own !== undefined && own.text.trim().length > 0 ? segment.id : segment.paragraphId
          const stored = translations[key]
          if (stored !== undefined && stored.text.trim().length > 0 && !targets.some((entry) => entry.key === key)) {
            targets.push({ key, source: key === segment.id ? segment.source : paragraphSourceOf(project, segment.paragraphId), text: stored.text })
          }
        }
      } else {
        for (const paragraph of project.paragraphs) {
          const paragraphKey = paragraph.id
          const sentences = splitSentences(paragraph.source)
          // Any sentence with its own stored translation is an independent edit
          // and must be enforced on its own.
          const independent = sentences
            .map((sentence, index) => ({ sentence, key: `${paragraphKey}:s${index + 1}` }))
            .filter((item) => {
              const stored = translations[item.key]
              return stored !== undefined && stored.text.trim().length > 0
            })
          if (independent.length > 0) {
            for (const item of independent) {
              targets.push({ key: item.key, source: item.sentence, text: translations[item.key].text })
            }
          }
          // The whole-paragraph translation remains the canonical target too.
          const whole = translations[paragraphKey]
          if (whole !== undefined && whole.text.trim().length > 0) {
            targets.push({ key: paragraphKey, source: paragraph.source, text: whole.text })
          }
        }
      }

      // Sentence-level probe for whole-paragraph targets: the plain
      // whole-text count masks a wrong rendering in one sentence whenever the
      // correct rendering appears in a sibling sentence (the totals cancel).
      // The probe matches what the segment cards display, so a paragraph the
      // UI reports as "terms unresolved" is always selected for repair.
      const violationsOf = (target) =>
        target.sentence !== undefined || target.key.includes(':s')
          ? findViolations(glossary, target.source, target.text, direction)
          : paragraphViolationsOf(
              project.paragraphs.find((item) => item.id === target.key),
              { text: target.text },
              glossary,
              direction,
            )

      const selected = targets.filter((target) => violationsOf(target).length > 0)
      if (selected.length === 0) return { repaired: 0, failed: 0, checked: 0, project: projectView(project) }

      const route = resolveRoute(ctx, settings)
      let repaired = 0
      let failed = 0
      /** Collected failure reasons, shown to the user when repairs cannot run. */
      const errors = []
      for (const target of selected) {
        // Re-read at execution time: a sentence fix just above may already have
        // merged into this paragraph, so the captured snapshot could be stale.
        const current = translations[target.key]
        const currentText = current === undefined ? '' : current.text
        if (currentText.trim().length === 0) continue
        const enforced = await enforceText({
          glossary,
          source: target.source,
          translation: currentText,
          direction,
          // Paragraph targets use the sentence-by-sentence probe so the repair
          // loop keeps iterating while a single sentence still misses a term,
          // even though the whole-paragraph count already cancels out.
          ...(target.key.includes(':s')
            ? {}
            : {
                checkViolations: (text) =>
                  paragraphViolationsOf(
                    project.paragraphs.find((item) => item.id === target.key),
                    { text },
                    glossary,
                    direction,
                  ),
              }),
          ask: ({ system, user }) => callModel(ctx, route, { system, user, timeoutMs: settings.timeoutMs, maxTokens: 2048, reasoningEffort: settings.reasoningEffort }),
        })
        enforcements[target.key] = enforced.result
        if (enforced.result.status === 'failed') {
          failed += 1
          if (typeof enforced.result.error === 'string' && enforced.result.error.length > 0) errors.push(enforced.result.error)
        }
        if (enforced.text !== currentText) {
          writeTranslation(project, translations, target.key, enforced.text, Date.now())
          delete reviews[target.key]
          repaired += 1
        }
      }
      touch(project)
      return { repaired, failed, checked: selected.length, ...(errors.length > 0 ? { errors } : {}), project: projectView(project) }
    },

    /** @param {{ projectId: string, scope?: string, ids?: string[] }} payload */
    translate: async (payload) => {
      const project = requireProject(payload.projectId)
      const running = jobs.get(project.id)
      if (running !== undefined && running.running) throw new Error('A translation job is already running for this paper.')
      const scope = payload.scope === 'ids' ? 'ids' : payload.scope === 'all' ? 'all' : 'missing'
      const ids = Array.isArray(payload.ids) ? payload.ids.filter((id) => typeof id === 'string') : undefined
      const result = await runTranslation(project, { scope, ids })
      return { ...result, project: projectView(project) }
    },

    /** @param {{ projectId: string, scope?: string, ids?: string[] }} payload */
    review: async (payload) => {
      const project = requireProject(payload.projectId)
      const running = jobs.get(project.id)
      if (running !== undefined && running.running) throw new Error('A job is already running for this paper.')
      const scope = payload.scope === 'all' ? 'all' : 'missing'
      const ids = Array.isArray(payload.ids) ? payload.ids.filter((id) => typeof id === 'string') : undefined
      const result = await runReview(project, { scope, ids })
      return { ...result, project: projectView(project) }
    },

    /**
     * Accept a proposed revision, replacing the current translation.
     * @param {{ projectId: string, segmentId: string }} payload
     */
    acceptRevision: async (payload) => {
      const project = requireProject(payload.projectId)
      const translations = bucketOf(project)
      const reviews = reviewBucketOf(project)
      const review = reviews[payload.segmentId]
      if (review === undefined) throw new Error('No review exists for this segment.')
      const suggestion = typeof review.suggestion === 'string' ? review.suggestion.trim() : ''
      if (suggestion.length === 0) throw new Error('This review has no proposed revision to accept.')
      // The proposal is model output too, so it faces the same glossary contract
      // as a fresh translation before it becomes the stored text.
      const settings = store.settings
      const direction = normalizeDirection(project.direction)
      const segment = buildSegments(project).find((item) => item.id === payload.segmentId)
      let text = suggestion
      if (segment !== undefined && project.strictTerms && glossaryTerms().length > 0) {
        const enforced = await enforceText({
          glossary: glossaryTerms(),
          source: segment.source,
          translation: suggestion,
          direction,
          ask: ({ system, user }) =>
            callModel(ctx, resolveRoute(ctx, settings), {
              system,
              user,
              timeoutMs: settings.timeoutMs,
              maxTokens: 2048,
              reasoningEffort: settings.reasoningEffort,
            }),
        })
        text = enforced.text
        enforcementBucketOf(project)[payload.segmentId] = enforced.result
      }
      writeTranslation(project, translations, payload.segmentId, text, Date.now())
      review.status = 'accepted'
      review.suggestion = ''
      touch(project)
      return { project: projectView(project) }
    },

    /** @param {{ projectId: string, segmentId: string }} payload */
    rejectRevision: async (payload) => {
      const project = requireProject(payload.projectId)
      const reviews = reviewBucketOf(project)
      const review = reviews[payload.segmentId]
      if (review === undefined) throw new Error('No review exists for this segment.')
      review.status = 'rejected'
      review.suggestion = ''
      touch(project)
      return { project: projectView(project) }
    },

    /** @param {{ projectId: string }} payload */
    cancel: async (payload) => {
      const job = jobs.get(payload.projectId)
      if (job === undefined || !job.running) return { cancelled: false }
      job.controller.abort(new Error('Cancelled by the user'))
      return { cancelled: true }
    },

    /** @param {{ projectId: string, segmentId: string, text: string }} payload */
    setTranslation: async (payload) => {
      const project = requireProject(payload.projectId)
      const segments = buildSegments(project)
      if (!segments.some((segment) => segment.id === payload.segmentId)) throw new Error('Unknown segment')
      const text = typeof payload.text === 'string' ? payload.text.trim() : ''
      const translations = bucketOf(project)
      const reviews = reviewBucketOf(project)
      writeTranslation(project, translations, payload.segmentId, text, Date.now())
      // A hand edit is the user's own decision, so a pending review no longer applies
      // and any stored enforcement record becomes stale; the live check still
      // reports a violation, but nothing pretends it was repaired.
      delete reviews[payload.segmentId]
      delete enforcementBucketOf(project)[payload.segmentId]
      touch(project)
      return { project: projectView(project) }
    },

    /** @param {{ projectId: string }} payload */
    clearTranslations: async (payload) => {
      const project = requireProject(payload.projectId)
      const direction = normalizeDirection(project.direction)
      project.translations[direction] = {}
      project.reviews[direction] = {}
      project.enforcements[direction] = {}
      touch(project)
      return { project: projectView(project) }
    },

    /** @param {object} payload */
    setSettings: async (payload) => {
      const settings = store.settings
      if (typeof payload.provider === 'string') settings.provider = payload.provider.trim()
      if (typeof payload.model === 'string') settings.model = payload.model.trim()
      if (typeof payload.targetLanguage === 'string' && payload.targetLanguage.trim().length > 0) {
        settings.targetLanguage = payload.targetLanguage.trim()
      }
      if (typeof payload.instructions === 'string') settings.instructions = payload.instructions.trim()
      if (typeof payload.reasoningEffort === 'string') settings.reasoningEffort = payload.reasoningEffort.trim()
      const numbers = ['batchSize', 'maxCharsPerBatch', 'maxTerms', 'timeoutMs']
      for (const key of numbers) {
        const value = Number(payload[key])
        if (Number.isFinite(value) && value > 0) settings[key] = Math.round(value)
      }
      persist()
      return { settings: store.settings }
    },

    /** @param {{ projectId: string, format?: string }} payload */
    exportText: async (payload) => {
      const project = requireProject(payload.projectId)
      const view = projectView(project)
      const format = payload.format === 'target' || payload.format === 'source' || payload.format === 'en' || payload.format === 'zh'
        ? payload.format
        : 'bilingual'
      // `source`/`target` follow the direction; `en`/`zh` stay literal.
      const sourceOnly = format === 'source' || (format === 'en' && view.direction === 'zh-en') || (format === 'zh' && view.direction === 'en-zh')
      const targetOnly = format === 'target' || (format === 'en' && view.direction === 'en-zh') || (format === 'zh' && view.direction === 'zh-en')
      const sourceLabel = view.direction === 'zh-en' ? '原文 · 中文' : '原文 · EN'
      const targetLabel = view.direction === 'zh-en' ? '译文 · EN' : '译文 · 中文'
      const lines = [`# ${project.title}`, '']
      for (const segment of view.segments) {
        if (!targetOnly) lines.push(`**${sourceLabel} · ${segment.id}**`, '', segment.source, '')
        if (!sourceOnly) {
          const body = segment.translation.length > 0 ? segment.translation : '[未翻译]'
          const score = segment.review === null ? '' : `  (评分 ${segment.review.score})`
          lines.push(`**${targetLabel} · ${segment.id}**${score}`, '', body, '')
        }
        lines.push('---', '')
      }
      if (view.glossary.length > 0) {
        lines.push('## 术语表', '')
        for (const entry of view.glossary) {
          lines.push(`- ${entry.en} => ${entry.zh}${entry.note.length > 0 ? ` （${entry.note}）` : ''}`)
        }
      }
      const unsaved = view.segments.filter((segment) => segment.review !== null && segment.review.status === 'open' && segment.review.suggestion.length > 0)
      if (unsaved.length > 0) {
        lines.push('', '## 待处理修订建议', '')
        for (const segment of unsaved) {
          lines.push(`- ${segment.id}（${segment.review.score} 分）: ${segment.review.suggestion}`)
        }
      }
      return {
        filename: `${project.title.replace(/[\\/:*?"<>|]/gu, '_').slice(0, 40) || 'paper'}-${format}.md`,
        markdown: lines.join('\n'),
      }
    },

    /** @param {{ projectId: string }} payload */
    report: async (payload) => {
      const project = requireProject(payload.projectId)
      const view = projectView(project)
      const problems = view.segments
        .filter((segment) => segment.issues.length > 0)
        .map((segment) => ({ id: segment.id, terms: segment.issues }))
      const lowScores = view.segments
        .filter((segment) => segment.review !== null && segment.review.score < 90)
        .map((segment) => ({ id: segment.id, score: segment.review.score, issues: segment.review.issues }))
      return {
        title: view.title,
        direction: view.direction,
        counts: view.counts,
        problems,
        unresolved: problems,
        lowScores,
        repaired: view.segments
          .filter((segment) => segment.enforcement !== null && segment.enforcement.status === 'repaired')
          .map((segment) => ({ id: segment.id, applied: segment.enforcement.applied })),
        glossarySize: view.glossary.length,
      }
    },

    /** Models advertised by one provider route. @param {{ provider?: string }} payload */
    listModels: async (payload) => {
      const service = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
      const provider = typeof payload.provider === 'string' && payload.provider.trim().length > 0
        ? payload.provider.trim()
        : resolveRoute(ctx, store.settings).provider
      if (service === undefined || service === null || typeof service.listModels !== 'function') {
        return { provider, models: [] }
      }
      try {
        const models = await service.listModels(provider)
        return {
          provider,
          models: models.map((model) => ({ id: model.id, name: model.name ?? model.id })),
        }
      } catch (error) {
        return { provider, models: [], error: error instanceof Error ? error.message : String(error) }
      }
    },

    /**
     * Exact reasoning-effort levels advertised by one model. `listModels` does
     * not carry this metadata; only `resolveModelInfo` returns it.
     * @param {{ provider?: string, model?: string }} payload
     */
    listModelEfforts: async (payload) => {
      const service = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
      const route = resolveRoute(ctx, store.settings)
      const provider = typeof payload.provider === 'string' && payload.provider.trim().length > 0
        ? payload.provider.trim()
        : route.provider
      const model = typeof payload.model === 'string' && payload.model.trim().length > 0
        ? payload.model.trim()
        : route.model
      if (model.length === 0) return { provider, model, efforts: [], defaultEffort: '' }
      if (service === undefined || service === null || typeof service.resolveModelInfo !== 'function') {
        return { provider, model, efforts: [], defaultEffort: '' }
      }
      try {
        const info = await service.resolveModelInfo(provider, model)
        const reasoning = info?.reasoning
        const efforts = Array.isArray(reasoning?.efforts)
          ? reasoning.efforts
              .filter((effort) => typeof effort?.id === 'string' && effort.id.length > 0)
              .map((effort) => ({ id: effort.id, name: effort.name ?? effort.id, description: effort.description ?? '' }))
          : []
        return {
          provider,
          model,
          efforts,
          defaultEffort: typeof reasoning?.defaultEffort === 'string' ? reasoning.defaultEffort : '',
        }
      } catch (error) {
        return { provider, model, efforts: [], defaultEffort: '', error: error instanceof Error ? error.message : String(error) }
      }
    },
  }

  return { actions, state, projectView, directory }
}