/**
 * Host half of the paper translator.
 *
 * Registers the HTTP routes behind the workbench and one Agent tool that calls
 * the same service methods, so the UI and the agent cannot drift apart.
 *
 * @module @local/dsh-academic-translator
 */

import { createTranslatorService } from './service.js'
import { createRoutes } from './routes.js'

/** Row name shown in logs. */
export const name = 'academic-translator'

/** The translator service is the only hard dependency. */
export const inject = ['llm']

/** Route paths; both are exact matches on the Web server. */
export const STATE_ROUTE = '/academic-translator/state'
export const ACTION_ROUTE = '/academic-translator/action'

/** Agent-facing description of the workbench. */
const TOOL_DESCRIPTION = [
  'Paper translation workbench: translate a paper between English and Chinese while keeping terminology consistent and scoring quality.',
  'It keeps one document per paper with a translation direction, a glossary, an optional set of injected skills, a paragraph or sentence translation granularity, a bilingual view, and user-defined translation instructions.',
  'Actions: state (list papers and read the active one), create (new paper, optionally with source text and direction), import (replace the source text), update (title, direction, granularity, view, skills), editSource (edit one source paragraph; clears that paragraph\u2019s stale translations so it can be retranslated; set keepTranslation to preserve them), addParagraph / deleteParagraph, settings (provider, model, batch size, instructions — free-form constraints injected into every translation request), models (list models of a provider), modelEfforts (list reasoning effort levels of one model), glossary (replace the shared terminology table; set merge to add), importTerms (parse pasted text into glossary rows for preview: Markdown table, CSV/TSV, or en=zh lines), extractTerms (propose terms from the paper), translate (scope missing/all/ids), enforceTerms (re-run glossary enforcement on existing translations), review (score translated segments 0-100 and propose revisions), acceptRevision / rejectRevision (apply or discard one proposal), cancel, setTranslation (hand-edit one segment), report (counts, glossary violations, low scores), export (Markdown).',
  'The glossary is one shared table for the whole profile, not one per paper. Terminology consistency is enforced, not merely suggested: every approved glossary entry whose source form occurs must appear with its exact required rendering, and translation enforces this by having the model propose exact substring replacements that the Host applies and re-verifies. Accepting a proposed revision passes through the same check. report lists segments that still violate the glossary.',
].join(' ')

/** JSON schema of the tool parameters. */
const TOOL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: [
        'state',
        'create',
        'import',
        'update',
        'editSource',
        'addParagraph',
        'deleteParagraph',
        'settings',
        'models',
        'modelEfforts',
        'glossary',
        'importTerms',
        'extractTerms',
        'translate',
        'enforceTerms',
        'review',
        'acceptRevision',
        'rejectRevision',
        'cancel',
        'setTranslation',
        'report',
        'export',
      ],
      description: 'Operation to perform.',
    },
    projectId: { type: 'string', description: 'Target paper id; omit for the most recently updated paper.' },
    title: { type: 'string', description: 'Paper title.' },
    source: { type: 'string', description: 'Full source text; blank lines separate paragraphs. For editSource, the new text of one paragraph or one sentence.' },
    paragraphId: { type: 'string', description: 'Paragraph id (p1, p2, ...) for editSource / deleteParagraph.' },
    segmentId: { type: 'string', description: 'Segment id for editSource: a paragraph (p1) or a single sentence (p1:s2). Overrides paragraphId.' },
    keepTranslation: { type: 'boolean', description: 'For editSource: keep the existing translation when the edit is only a typo fix.' },
    merge: { type: 'boolean', description: 'For glossary: add rows instead of replacing the whole table.' },
    direction: {
      type: 'string',
      enum: ['en-zh', 'zh-en'],
      description: 'Translation direction: en-zh translates English into Chinese, zh-en translates Chinese into English.',
    },
    granularity: { type: 'string', enum: ['paragraph', 'sentence'], description: 'Translate whole paragraphs or one sentence at a time.' },
    view: { type: 'string', enum: ['bilingual', 'source', 'target'], description: 'Preferred reading layout.' },
    skills: { type: 'array', items: { type: 'string' }, description: 'Skill names to inject as style and terminology guidance.' },
    strictTerms: { type: 'boolean', description: 'Flag segments that miss a glossary term.' },
    glossary: {
      type: 'array',
      description: 'Complete terminology table; replaces the stored one.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          en: { type: 'string' },
          zh: { type: 'string' },
          note: { type: 'string' },
          approved: { type: 'boolean' },
        },
        required: ['en', 'zh'],
      },
    },
    scope: { type: 'string', enum: ['missing', 'all', 'ids'], description: 'Which segments to translate.' },
    ids: { type: 'array', items: { type: 'string' }, description: 'Segment ids in the form p3 or p3:s2.' },
    segmentId: { type: 'string', description: 'Segment id whose translation is being edited.' },
    text: { type: 'string', description: 'For setTranslation: replacement translation (empty clears it); for importTerms: pasted terminology text (Markdown table, CSV/TSV, or en=zh lines).' },
    format: { type: 'string', enum: ['bilingual', 'source', 'target'], description: 'Export layout: bilingual, source only, or translation only.' },
    provider: { type: 'string', description: 'Model provider route; empty follows the session default.' },
    model: { type: 'string', description: 'Model id; empty follows the session default.' },
    targetLanguage: { type: 'string', description: 'Unused when direction is set; kept for compatibility.' },
    instructions: { type: 'string', description: 'For settings: free-form constraints injected into every translation request (e.g. terminology rules, tone, style).' },
    reasoningEffort: { type: 'string', description: 'For settings: reasoning effort id for model calls; empty follows the model default. Use modelEfforts to list valid ids.' },
  },
  required: ['action'],
}

/**
 * Map tool arguments onto a service action and payload.
 * @param {any} args
 */
function dispatch(args) {
  const action = typeof args?.action === 'string' ? args.action : ''
  const projectId = typeof args?.projectId === 'string' ? args.projectId : undefined
  switch (action) {
    case 'state':
      return ['state', projectId === undefined ? {} : { projectId }]
    case 'create':
      return ['createProject', { title: args.title, source: args.source, direction: args.direction }]
    case 'import':
      return ['updateProject', { projectId, source: args.source }]
    case 'editSource':
      return ['editSource', { projectId, segmentId: args.segmentId, paragraphId: args.paragraphId, source: args.source, keepTranslation: args.keepTranslation }]
    case 'addParagraph':
      return ['addParagraph', { projectId, source: args.source }]
    case 'deleteParagraph':
      return ['deleteParagraph', { projectId, paragraphId: args.paragraphId }]
    case 'update':
      return [
        'updateProject',
        {
          projectId,
          title: args.title,
          direction: args.direction,
          granularity: args.granularity,
          view: args.view,
          skills: args.skills,
          strictTerms: args.strictTerms,
        },
      ]
    case 'settings':
      return [
        'setSettings',
        {
          provider: args.provider,
          model: args.model,
          targetLanguage: args.targetLanguage,
          instructions: args.instructions,
          reasoningEffort: args.reasoningEffort,
        },
      ]
    case 'glossary':
      return ['setGlossary', { glossary: args.glossary, merge: args.merge }]
    case 'importTerms':
      return ['importTerms', { text: args.text }]
    case 'extractTerms':
      return ['extractTerms', { projectId }]
    case 'translate':
      return ['translate', { projectId, scope: args.scope, ids: args.ids }]
    case 'enforceTerms':
      return ['enforceTerms', { projectId, ids: args.ids }]
    case 'review':
      return ['review', { projectId, scope: args.scope === 'all' ? 'all' : 'missing', ids: args.ids }]
    case 'acceptRevision':
      return ['acceptRevision', { projectId, segmentId: args.segmentId }]
    case 'rejectRevision':
      return ['rejectRevision', { projectId, segmentId: args.segmentId }]
    case 'models':
      return ['listModels', { provider: args.provider }]
    case 'modelEfforts':
      return ['listModelEfforts', { provider: args.provider, model: args.model }]
    case 'cancel':
      return ['cancel', { projectId }]
    case 'setTranslation':
      return ['setTranslation', { projectId, segmentId: args.segmentId, text: args.text }]
    case 'report':
      return ['report', { projectId }]
    case 'export':
      return ['exportText', { projectId, format: args.format }]
    default:
      return null
  }
}

/**
 * Register the plugin.
 * @param {any} ctx Cordis context
 */
export function apply(ctx) {
  const service = createTranslatorService(ctx)

  // Web routes: optional, because a headless profile has no browser to serve.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scoped) => {
      if (typeof scoped?.webServer?.register !== 'function') return
      const routes = createRoutes(service)
      scoped.effect(
        () =>
          scoped.webServer.register({
            kind: 'exact',
            path: STATE_ROUTE,
            handler: routes.stateHandler,
          }),
        'academic-translator.state()',
      )
      scoped.effect(
        () =>
          scoped.webServer.register({
            kind: 'exact',
            path: ACTION_ROUTE,
            handler: routes.actionHandler,
          }),
        'academic-translator.action()',
      )
    })
  }

  // Agent tool: the same operations the UI performs.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (scoped) => {
      if (typeof scoped?.tools?.register !== 'function') return
      scoped.effect(
        () =>
          scoped.tools.register({
            name: 'paper_translator',
            description: TOOL_DESCRIPTION,
            parameters: TOOL_PARAMETERS,
            output: {
              schema: { type: 'object', additionalProperties: true, properties: {} },
              render(_args, value) {
                const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1)
                const clipped = text.length > 6000 ? `${text.slice(0, 6000)}\n…[truncated]` : text
                return [{ type: 'text', text: clipped }]
              },
            },
            async execute(args) {
              const mapped = dispatch(args)
              if (mapped === null) return { error: `Unknown action: ${String(args?.action ?? '')}` }
              const [action, payload] = mapped
              const handler = service.actions[action]
              if (typeof handler !== 'function') return { error: `Unsupported action: ${action}` }
              try {
                const result = await handler(payload)
                return { ok: true, action, result }
              } catch (error) {
                return { ok: false, action, error: error instanceof Error ? error.message : String(error) }
              }
            },
          }),
        'academic-translator.tool()',
      )
    })
  }
}