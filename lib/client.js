/**
 * Browser half of the paper translator.
 *
 * Layout: one header row with the only primary actions, a four-tab side panel
 * (papers, terms, skills, model), and a reading area of one card per segment.
 * Everything else stays out of the way until it is needed.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-academic-translator',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'academic-translator'
    const LOCALE_NS = 'paperTranslator'
    const STATE_ROUTE = '/academic-translator/state'
    const ACTION_ROUTE = '/academic-translator/action'

    // Local copy of the text parser so bulk import works entirely in the
    // browser (this bundle cannot import the Host's engine.js). Mirrors
    // parseTermText in engine.js: Markdown tables, CSV/TSV and en=zh lines.
    function parseTermText(text) {
      const rows = []
      const seen = new Set()
      const skip = /^(en|english|原文|术语|term|source)?\s*(\||,|\t)?\s*(zh|chinese|译名|中文|target|rendering)/iu
      for (const rawLine of String(text ?? '').split(/\r?\n/u)) {
        let line = rawLine.trim()
        if (line.length === 0) continue
        line = line.replace(/^[-*+]\s+|^\d+[.)]\s+/u, '').trim()
        if (line.startsWith('|')) line = line.replace(/^\||\|$/gu, '')
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
        if (skip.test(`${en} ${zh}`)) continue
        const key = en.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        rows.push({ en, zh, note: parts.slice(2).join(' '), approved: true, origin: 'manual' })
      }
      return rows
    }

    function mergeGlossaryRows(current, rows) {
      const known = new Set(current.map((row) => row.en.toLowerCase()))
      const merged = [...current]
      for (const row of rows) {
        if (known.has(row.en.toLowerCase())) continue
        known.add(row.en.toLowerCase())
        merged.push(row)
      }
      return merged
    }

    const CSS = `
.dpt { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.6; font-family: inherit; }
.dpt * { box-sizing: border-box; }

/* header ─ one row, primary actions only */
.dpt-hd { display: flex; align-items: center; gap: 10px; padding: 0 16px; height: 52px; flex: none; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.dpt-hd-title { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 30ch; }
.dpt-hd-title.muted { color: var(--dsw-alias-label-secondary); font-weight: 500; }
.dpt-fill { flex: 1 1 auto; min-width: 8px; }

/* controls — segmented switch: light-gray track + white thumb in light theme, dark-adaptive in dark theme */
.dpt { --dpt-seg-track: #e0e0e0; --dpt-seg-track-border: #cccccc; --dpt-seg-thumb: #ffffff; --dpt-seg-thumb-border: #bfbfbf; --dpt-on-brand: #ffffff; }
@media (prefers-color-scheme: dark) {
  .dpt { --dpt-seg-track: #2e2e33; --dpt-seg-track-border: #45454b; --dpt-seg-thumb: #3a3a41; --dpt-seg-thumb-border: #5a5a62; --dpt-on-brand: #17171a; }
}
.dpt-seg { position: relative; display: inline-flex; padding: 2px; border-radius: 10px; background: var(--dpt-seg-track); border: 1px solid var(--dpt-seg-track-border); }
.dpt-seg > .dpt-seg-ind { position: absolute; top: 2px; bottom: 2px; left: 2px; width: calc((100% - 4px) / var(--dpt-n, 2)); border-radius: 7px; background: var(--dpt-seg-thumb); border: 1px solid var(--dpt-seg-thumb-border); transform: translateX(calc(var(--dpt-i, 0) * 100%)); transition: transform .26s cubic-bezier(.2,.9,.25,1.15); pointer-events: none; }
.dpt-seg > button { position: relative; z-index: 1; flex: 1 1 0; height: 24px; padding: 0 9px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; transition: color .18s ease; }
.dpt-seg > button[aria-pressed="true"] { color: var(--dsw-alias-label-primary); font-weight: 600; }
.dpt-seg > button:disabled { opacity: .45; cursor: default; }

.dpt-btn { height: 28px; padding: 0 11px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; display: inline-flex; align-items: center; gap: 5px; transition: background .16s ease, border-color .16s ease; }
.dpt-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2)); }
.dpt-btn:active:not(:disabled) { background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2)); }
.dpt-btn:disabled { opacity: .45; cursor: default; }
.dpt-btn.primary { background: var(--dsw-alias-brand-primary); border-color: transparent; color: var(--dpt-on-brand); }
.dpt-btn.primary:hover:not(:disabled) { filter: brightness(1.08); }
.dpt-btn.ghost { background: transparent; border-color: transparent; color: var(--dsw-alias-label-secondary); }
.dpt-btn.ghost:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dpt-btn.danger { color: var(--dsw-alias-state-error-primary); }
.dpt-btn.danger:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-state-error-primary); }
.dpt-btn.icon { width: 28px; padding: 0; justify-content: center; font-size: 15px; line-height: 1; }
.dpt-btn.tiny { height: 23px; padding: 0 8px; font-size: 11px; border-radius: 6px; }
.dpt-btn:focus-visible, .dpt-seg > button:focus-visible, .dpt-input:focus, .dpt-area:focus, .dpt-select:focus { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }

/* sliding switch */
.dpt-switch { position: relative; flex: none; width: 30px; height: 17px; padding: 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: 9px; background: var(--dsw-alias-bg-layer-2); cursor: pointer; transition: background .22s ease, border-color .22s ease; }
.dpt-switch > i { position: absolute; top: 2px; left: 2px; width: 11px; height: 11px; border-radius: 50%; background: var(--dsw-alias-label-secondary); transition: transform .22s cubic-bezier(.2,.8,.2,1), background .22s ease; }
.dpt-switch.on { background: var(--dsw-alias-brand-primary); border-color: transparent; }
.dpt-switch.on > i { transform: translateX(13px); background: var(--dpt-on-brand); }
.dpt-switch:disabled { opacity: .45; cursor: default; }
.dpt-check .dpt-switch { margin-top: 2px; }

/* saved feedback */
.dpt-saved { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--dsw-alias-state-success-primary, #1a7f37); animation: dpt-saved-in .28s ease both; }
.dpt-saved-ic { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; border-radius: 50%; background: var(--dsw-alias-state-success-primary, #1a7f37); color: var(--dpt-on-brand); font-size: 9px; line-height: 1; }
@keyframes dpt-saved-in { from { opacity: 0; transform: translateY(-3px) scale(.96); } to { opacity: 1; transform: none; } }

/* body ─ side panel + reading area */
.dpt-body { display: flex; flex: 1 1 auto; min-height: 0; }
.dpt-side { width: 300px; flex: none; border-right: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); display: flex; flex-direction: column; min-height: 0; transition: width .18s ease; }
.dpt-side.collapsed { width: 0; overflow: hidden; border-right: 0; }
.dpt-side-rail { width: 34px; flex: none; border-right: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); display: flex; align-items: flex-start; justify-content: center; padding-top: 8px; }
.dpt-tabs { position: relative; display: flex; align-items: center; flex: none; border-bottom: 1px solid var(--dsw-alias-border-l1); padding: 0 8px; }
.dpt-tabs > button[role="tab"] { flex: 1 1 0; height: 34px; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; transition: color .18s ease; }
.dpt-tabs > button[role="tab"][aria-selected="true"] { color: var(--dsw-alias-label-primary); font-weight: 600; }
.dpt-tabs > .dpt-tab-ind { position: absolute; bottom: 0; left: 8px; width: calc((100% - 44px) / 4); height: 2px; border-radius: 2px; background: var(--dsw-alias-brand-primary); transform: translateX(calc(var(--dpt-tab-i, 0) * 100%)); transition: transform .24s cubic-bezier(.2,.8,.2,1); pointer-events: none; }
.dpt-pane { flex: 1 1 auto; overflow: auto; padding: 12px; min-height: 0; }

.dpt-main { flex: 1 1 auto; min-width: 0; overflow: auto; }

/* generic bits */
.dpt-label { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); margin: 0 0 6px; }
.dpt-note { font-size: 11.5px; color: var(--dsw-alias-label-secondary); margin: 0 0 10px; }
.dpt-section { padding-bottom: 14px; margin-bottom: 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dpt-section:last-child { border-bottom: 0; margin-bottom: 0; padding-bottom: 0; }
.dpt-input, .dpt-area, .dpt-select { width: 100%; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; padding: 6px 8px; }
.dpt-area { min-height: 88px; resize: vertical; line-height: 1.55; }
.dpt-area.tall { min-height: 170px; }
.dpt-stack > * + * { margin-top: 6px; }
.dpt-row { display: flex; align-items: center; gap: 8px; }
.dpt-row.wrap { flex-wrap: wrap; }

.dpt-item { display: flex; align-items: flex-start; gap: 8px; padding: 7px 8px; border-radius: 7px; cursor: pointer; border: 1px solid transparent; }
.dpt-item:hover { background: var(--dsw-alias-bg-layer-2); }
.dpt-item.on { background: var(--dsw-alias-bg-base); border-color: var(--dsw-alias-brand-primary); }
.dpt-item[draggable="true"] { cursor: grab; }
.dpt-item.drag-target { position: relative; }
.dpt-item.drag-target::after { content: ''; position: absolute; left: 10px; right: 10px; bottom: -2px; height: 2px; border-radius: 1px; background: var(--dsw-alias-brand-primary); opacity: .75; }
.dpt-item-body { flex: 1 1 auto; min-width: 0; }
.dpt-item-title { font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dpt-item-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); }

.dpt-check { display: flex; align-items: flex-start; gap: 8px; padding: 6px 4px; border-radius: 6px; cursor: pointer; }
.dpt-check:hover { background: var(--dsw-alias-bg-layer-2); }
.dpt-check input { margin: 3px 0 0; flex: none; }

/* glossary table */
.dpt-gloss { width: 100%; border-collapse: collapse; font-size: 12px; }
.dpt-gloss th { text-align: left; font-weight: 500; font-size: 11px; color: var(--dsw-alias-label-secondary); padding: 0 3px 4px; }
.dpt-gloss td { padding: 2px 3px; vertical-align: middle; }
.dpt-gloss input[type="text"] { width: 100%; border: 1px solid transparent; border-radius: 5px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; padding: 3px 5px; }
.dpt-gloss input[type="text"]:hover { border-color: var(--dsw-alias-border-l1); }
.dpt-gloss input[type="text"]:focus { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-base); outline: none; }
.dpt-gloss tr.off { opacity: .45; }

/* reading area */
.dpt-toolbar { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 10px; padding: 8px 20px; background: var(--dsw-alias-bg-base); border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.dpt-card { border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dpt-card-hd { display: flex; align-items: center; gap: 8px; padding: 7px 20px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dpt-card-body { padding: 2px 20px 16px; display: grid; gap: 22px; }
.dpt-card-body.two { grid-template-columns: 1fr 1fr; }
.dpt-card-body.one { grid-template-columns: 1fr; }
.dpt-col { min-width: 0; }
.dpt-col-label { font-size: 10px; letter-spacing: .09em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); margin-bottom: 3px; }
.dpt-text { white-space: pre-wrap; word-break: break-word; }
.dpt-text.empty { color: var(--dsw-alias-state-idle-primary); font-style: italic; }
mark.dpt-termmark { background: none; color: var(--dsw-alias-state-error-primary); font-weight: 600; padding: 0; }
.dpt-termhint { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 11px; color: var(--dsw-alias-state-error-primary); }

.dpt-badge { display: inline-flex; align-items: center; height: 18px; padding: 0 7px; border-radius: 9px; border: 1px solid var(--dsw-alias-border-l1); font-size: 10.5px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }

/* review block */
.dpt-review { margin: 0 20px 14px; padding: 10px 12px; border-radius: 8px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); }
.dpt-review-issues { margin: 6px 0 0; padding-left: 18px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dpt-review-issues li { margin: 2px 0; }
.dpt-breakdown { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 9px; }
.dpt-dim { display: inline-flex; align-items: center; gap: 5px; padding: 2px 7px 2px 5px; border-radius: 6px; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); font-size: 11px; line-height: 1.4; }
.dpt-dim-tag { font-weight: 600; color: var(--dsw-alias-brand-primary); }
.dpt-dim-bar { width: 42px; height: 5px; border-radius: 3px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.dpt-dim-bar > i { display: block; height: 100%; border-radius: 3px; background: var(--dsw-alias-brand-primary); transition: width .3s ease; }
.dpt-dim-num { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.dpt-suggest { margin-top: 8px; padding: 9px 11px; border-radius: 7px; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-brand-primary); white-space: pre-wrap; word-break: break-word; }

/* status */
.dpt-banner { margin: 0; padding: 8px 20px; font-size: 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dpt-banner.error { color: var(--dsw-alias-state-error-primary); }
.dpt-banner.warn { color: var(--dsw-alias-state-warn-primary); }
.dpt-progress { padding: 8px 20px; border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.dpt-bar { height: 4px; border-radius: 2px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; margin-bottom: 5px; }
.dpt-bar > i { display: block; height: 100%; background: var(--dsw-alias-brand-primary); transition: width .25s ease; }

/* empty state */
.dpt-empty { max-width: 640px; padding: 40px 28px; }
.dpt-empty h2 { font-size: 16px; margin: 0 0 6px; font-weight: 600; }
.dpt-empty p { margin: 0 0 16px; color: var(--dsw-alias-label-secondary); font-size: 12.5px; }

.dpt-menu { position: relative; }
.dpt-menu-list { position: absolute; right: 0; top: 32px; z-index: 20; min-width: 180px; padding: 5px; border-radius: 8px; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); }
.dpt-menu-list > button { display: block; width: 100%; text-align: left; height: 28px; padding: 0 9px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; cursor: pointer; }
.dpt-menu-list > button:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.dpt-menu-list > button:disabled { opacity: .45; cursor: default; }
`

    // ── Copy ─────────────────────────────────────────────────────────────────
    const zh = {
      appTitle: '论文翻译',
      noPaper: '还没有打开论文',
      tabPapers: '论文',
      tabTerms: '术语',
      tabSkills: '技能',
      tabModel: '模型',

      segLength: '粒度',
      paragraphMode: '整段',
      sentenceMode: '逐句',
      direction: '方向',
      dirEnZh: '英→中',
      dirZhEn: '中→英',
      view: '显示',
      viewBilingual: '对照',
      viewTarget: '译文',
      viewSource: '原文',

      translateMissing: '翻译未完成部分',
      reviewAll: '全部评分',
      reviewMissing: '评分',
      collapseSide: '收起侧栏',
      expandSide: '展开侧栏',
      allTranslated: '已全部翻译',
      nothingToReview: '没有可评分的译文',
      more: '更多',
      retranslateAll: '全部重译',
      exportBilingual: '导出对照稿',
      exportTarget: '导出译文',
      clearTranslations: '清空本方向译文',
      delete: '删除这篇论文',
      cancel: '取消',

      newPaper: '新建论文',
      newPaperTitle: '标题（可留空）',
      sourcePlaceholder: '把论文原文粘贴到这里。空行分段。',
      create: '创建',
      creating: '创建中…',
      noProjects: '还没有论文。点「新建论文」开始。',
      emptyTitle: '开始一篇论文',
      emptyHint: '粘贴原文（空行分段），选择翻译方向，然后翻译。整段读起来连贯，逐句便于校对。',
      deleteConfirm: '删除',

      extract: '提取术语',
      extracting: '提取中…',
      saveGlossary: '保存术语表',
      clearGlossary: '清空全部',
      clearGlossaryConfirm: '确定清空全部术语？此操作不可撤销。',
      addTerm: '添加一行',
      bulk: '批量导入',
      bulkHint: '每行一条：原文=译名（也支持 Tab 或逗号分隔）。',
      bulkApply: '导入',
      glossaryEmpty: '还没有术语。可以先「提取术语」，或手动添加。',
      glossaryHint: '术语会随每次请求发送，并强制全文统一。',
      termSource: '原文',
      termTarget: '译名',
      termOn: '启用',
      remove: '移除',
      unsaved: '有未保存的修改',
      saved: '已保存',

      skillsHint: '勾选的技能会作为风格与术语参考一起注入提示词。',
      noSkills: '此环境没有可用技能',
      skillsSaved: '技能选择已保存',

      modelRoute: '当前路由',
      noRoute: '没有可用模型',
      followSession: '跟随会话默认模型',
      provider: '提供方',
      model: '模型',
      pickModel: '选择模型',
      noModelList: '该提供方没有模型列表',
      reasoningEffort: '思考强度',
      followDefault: '跟随模型默认',
      noEfforts: '该模型没有可选的思考强度',
      reasoningEffortHint: '影响翻译与评分时模型的思考深度；越高越慢但推理更充分。',
      batchSize: '每批片段数',
      batchHint: '数值越大越快，但单次请求更长。',
      instructions: '给翻译 AI 的约束',
      instructionsPlaceholder: '例如：术语一律采用表内译名；语气保持客观；不要增删句子……',
      instructionsHint: '这些要求会随每次翻译请求一起发给模型；与术语表和硬性规则冲突时以后者为准。',
      saveSettings: '保存',

      source: '原文',
      editSource: '改原文',
      editSourceHint: '修改原文后，该段译文会被清空，等待重新翻译。',
      saveAndClear: '保存并待重译',
      sourceEmpty: '原文不能为空。',
      translation: '译文',
      untranslated: '未翻译',
      edit: '编辑',
      save: '保存',
      cancelEdit: '取消编辑',
      retranslate: '重译此段',
      reviewThis: '评分',
      score: '评分',
      dims: '五维评分（忠30/术25/体20/流15/格10）',
      dimFidelity: '忠实',
      dimTerminology: '术语',
      dimRegister: '语体',
      dimFluency: '流畅',
      dimFormat: '格式',
      termMiss: '术语未统一',
      termFixed: '已按术语表修正',
      termRequired: '应译为',
      fromParagraph: '由整段拆分',
      fromParagraphHint: '该译文从整段译文按句拆分而来，未单独翻译或评分。点「评分」或「重译此段」可生成独立句译文。',
      termUnresolved: '术语未能修正',
      enforceTerms: '术语回归',
      enforcing: '回归中…',
      enforceNothing: '没有需要自动修复的术语段落',
      enforceClean: '所有译文已符合术语表',
      enforceFailed: '{count} 段未能自动统一，请手动编辑译文或重译',
      revisionPending: '待处理建议',
      accepted: '已接受',
      rejected: '已拒绝',
      suggestion: '建议修改',
      accept: '接受',
      reject: '拒绝',
      counts: '{done}/{segments} 已译',
      averageScore: '平均分 {score}',
      pendingCount: '{count} 条待处理',
      repairedCount: '已自动修正术语 {count} 段',
      unresolvedCount: '{count} 段术语待修',
      issueCount: '{count} 处术语未统一',
      jobTranslating: '翻译中 {done}/{total}',
      jobReviewing: '评分中 {done}/{total}',
      jobError: '出错',
      loadError: '加载失败',
      segLabel: '段 {n}',
      sentLabel: '段 {n} · 句 {m}',
      retry: '重试',
    }

    const en = {
      appTitle: 'Paper translator',
      noPaper: 'No paper open',
      tabPapers: 'Papers',
      tabTerms: 'Terms',
      tabSkills: 'Skills',
      tabModel: 'Model',

      segLength: 'Granularity',
      paragraphMode: 'Paragraph',
      sentenceMode: 'Sentence',
      direction: 'Direction',
      dirEnZh: 'EN→ZH',
      dirZhEn: 'ZH→EN',
      view: 'View',
      viewBilingual: 'Bilingual',
      viewTarget: 'Translation',
      viewSource: 'Source',

      translateMissing: 'Translate missing',
      reviewAll: 'Score all',
      reviewMissing: 'Score',
      collapseSide: 'Collapse sidebar',
      expandSide: 'Expand sidebar',
      allTranslated: 'All translated',
      nothingToReview: 'No translations to score',
      more: 'More',
      retranslateAll: 'Retranslate all',
      exportBilingual: 'Export bilingual',
      exportTarget: 'Export translation',
      clearTranslations: 'Clear translations',
      delete: 'Delete paper',
      cancel: 'Cancel',

      newPaper: 'New paper',
      newPaperTitle: 'Title (optional)',
      sourcePlaceholder: 'Paste the source text here. Blank lines separate paragraphs.',
      create: 'Create',
      creating: 'Creating…',
      noProjects: 'No papers yet. Use "New paper".',
      emptyTitle: 'Start a paper',
      emptyHint: 'Paste the source (blank lines separate paragraphs), pick a direction, then translate. Paragraphs read better; sentences are easier to proofread.',
      deleteConfirm: 'Delete',

      extract: 'Extract terms',
      extracting: 'Extracting…',
      saveGlossary: 'Save glossary',
      clearGlossary: 'Clear all',
      clearGlossaryConfirm: 'Delete all glossary terms? This cannot be undone.',
      addTerm: 'Add row',
      bulk: 'Bulk import',
      bulkHint: 'One entry per line: source=target (tab or comma also work).',
      bulkApply: 'Import',
      glossaryEmpty: 'No terms yet. Extract them, or add one.',
      glossaryHint: 'Terms are sent with every request and enforced across the paper.',
      termSource: 'Source',
      termTarget: 'Target',
      termOn: 'On',
      remove: 'Remove',
      unsaved: 'Unsaved changes',
      saved: 'Saved',

      skillsHint: 'Checked skills are injected as style and terminology guidance.',
      noSkills: 'No skills are available here',
      skillsSaved: 'Skill selection saved',

      modelRoute: 'Current route',
      noRoute: 'No model route',
      followSession: 'Follow the session default model',
      provider: 'Provider',
      model: 'Model',
      pickModel: 'Pick a model',
      noModelList: 'This provider lists no models',
      reasoningEffort: 'Reasoning effort',
      followDefault: 'Follow model default',
      noEfforts: 'This model exposes no reasoning levels',
      reasoningEffortHint: 'Controls how deeply the model reasons during translation and review; higher is slower but more thorough.',
      batchSize: 'Segments per request',
      batchHint: 'Higher is faster but makes each request longer.',
      instructions: 'Instructions for the translation AI',
      instructionsPlaceholder: 'e.g. always use the glossary renderings; keep an objective tone; add no sentences…',
      instructionsHint: 'Sent with every translation request. The glossary and hard rules take precedence if there is a conflict.',
      saveSettings: 'Save',

      source: 'Source',
      editSource: 'Edit source',
      editSourceHint: 'Changing the source clears this segment\u2019s translation so it can be retranslated.',
      saveAndClear: 'Save and clear translation',
      sourceEmpty: 'The source text cannot be empty.',
      translation: 'Translation',
      untranslated: 'Not translated',
      edit: 'Edit',
      save: 'Save',
      cancelEdit: 'Cancel',
      retranslate: 'Retranslate',
      reviewThis: 'Score',
      score: 'Score',
      dims: 'Five-dimension rubric (fidelity30/term25/register20/fluency15/format10)',
      dimFidelity: 'Fidelity',
      dimTerminology: 'Terminology',
      dimRegister: 'Register',
      dimFluency: 'Fluency',
      dimFormat: 'Format',
      termMiss: 'Term not unified',
      termFixed: 'Fixed from glossary',
      termRequired: 'should be',
      fromParagraph: 'Split from paragraph',
      fromParagraphHint: 'This translation was split from a whole-paragraph translation; it is not individually translated or scored. Use Score or Retranslate to create a standalone sentence translation.',
      termUnresolved: 'Term could not be fixed',
      enforceTerms: 'Enforce terms',
      enforcing: 'Enforcing…',
      enforceNothing: 'No segments need term enforcement',
      enforceClean: 'All translations already match the glossary',
      enforceFailed: '{count} segment(s) could not be auto-fixed; edit the translation or retranslate',
      revisionPending: 'Revision pending',
      accepted: 'Accepted',
      rejected: 'Rejected',
      suggestion: 'Suggested revision',
      accept: 'Accept',
      reject: 'Reject',
      counts: '{done}/{segments} translated',
      averageScore: 'Average {score}',
      pendingCount: '{count} pending',
      repairedCount: '{count} segment(s) auto-fixed',
      unresolvedCount: '{count} segment(s) still violate the glossary',
      issueCount: '{count} term issue(s)',
      jobTranslating: 'Translating {done}/{total}',
      jobReviewing: 'Scoring {done}/{total}',
      jobError: 'Failed',
      loadError: 'Could not load',
      segLabel: 'P{n}',
      sentLabel: 'P{n} · S{m}',
      retry: 'Retry',
    }

    /**
     * Locale-bound formatter with a Chinese fallback, so a key never renders raw.
     * @param {any} ctx
     */
    function makeT(ctx) {
      let bound = null
      try {
        if (ctx?.locale?.bind) bound = ctx.locale.bind(LOCALE_NS)
      } catch {
        bound = null
      }
      return (key) => {
        if (typeof bound === 'function') {
          try {
            const value = bound(key)
            if (typeof value === 'string' && value.length > 0 && value !== key) return value
          } catch {
            /* fall through */
          }
        }
        return zh[key] ?? key
      }
    }

    /** @param {string} template @param {Record<string, string|number>} values */
    const fill = (template, values) => {
      let out = template
      for (const [key, value] of Object.entries(values)) out = out.split(`{${key}}`).join(String(value))
      return out
    }

    // ── Host calls ───────────────────────────────────────────────────────────
    /** @param {string | undefined} projectId */
    async function fetchState(projectId) {
      const suffix = projectId === undefined ? '' : `?project=${encodeURIComponent(projectId)}`
      const response = await fetch(`${STATE_ROUTE}${suffix}`, { headers: { accept: 'application/json' } })
      const data = await response.json()
      if (data?.ok !== true) throw new Error(data?.error?.message ?? 'Failed to load state')
      return data.state
    }

    /** @param {string} action @param {any} payload */
    async function postAction(action, payload) {
      const response = await fetch(ACTION_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ action, payload: payload ?? {} }),
      })
      const data = await response.json()
      if (data?.ok !== true) throw new Error(data?.error?.message ?? 'Action failed')
      return data
    }

    /** @param {string} filename @param {string} text */
    function downloadText(filename, text) {
      const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 4000)
    }

    // ── Building blocks ──────────────────────────────────────────────────────
    function SidebarIcon(props) {
      const size = props?.size ?? 16
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true, style: { display: 'block' } },
        h('rect', { x: 1.6, y: 2.2, width: 5.2, height: 11.6, rx: 1.2, fill: 'currentColor', opacity: props?.active ? 0.95 : 0.75 }),
        h('rect', {
          x: 8.2, y: 2.2, width: 6.2, height: 11.6, rx: 1.2,
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, opacity: 0.85,
        }),
        h('path', {
          d: 'M9.6 5.6h3.4M9.6 8h3.4M9.6 10.4h2.2',
          stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round', opacity: 0.85,
        }),
      )
    }

    /**
     * Segmented control: one choice out of a few, always visible.
     * @param {{ label: string, value: string, options: Array<{ value: string, label: string }>, onChange: (value: string) => void, disabled?: boolean }} props
     */
    function Seg(props) {
      const { label, value, options, onChange, disabled } = props
      const selected = Math.max(0, options.findIndex((option) => option.value === value))
      return h(
        'div',
        {
          className: 'dpt-seg',
          role: 'group',
          'aria-label': label,
          style: { '--dpt-n': String(options.length), '--dpt-i': String(selected) },
        },
        h('span', { className: 'dpt-seg-ind', 'aria-hidden': 'true' }),
        options.map((option) =>
          h(
            'button',
            {
              key: option.value,
              type: 'button',
              'aria-pressed': value === option.value,
              disabled: disabled === true,
              onClick: () => {
                if (value !== option.value) onChange(option.value)
              },
            },
            option.label,
          ),
        ),
      )
    }

    /**
     * Sliding on/off switch with an accessible label.
     * @param {{ label: string, checked: boolean, disabled?: boolean, onChange: (next: boolean) => void }} props
     */
    function Switch(props) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          className: props.checked ? 'dpt-switch on' : 'dpt-switch',
          'aria-label': props.label,
          'aria-checked': props.checked === true,
          title: props.label,
          disabled: props.disabled === true,
          onClick: () => props.onChange(!props.checked),
        },
        h('i'),
      )
    }

    /** Short "saved" confirmation that fades in after a successful save. */
    function SavedBadge(props) {
      return h('span', { className: 'dpt-saved', role: 'status' }, h('span', { className: 'dpt-saved-ic', 'aria-hidden': 'true' }, '✓'), props.label)
    }

    /** Five-dimension score breakdown as labelled mini bars. */
    function Breakdown(props) {
      const t = props.t
      const review = props.review
      if (!review.breakdown) return null
      const dims = [
        ['fidelity', t('dimFidelity'), 30, review.breakdown.fidelity],
        ['terminology', t('dimTerminology'), 25, review.breakdown.terminology],
        ['register', t('dimRegister'), 20, review.breakdown.register],
        ['fluency', t('dimFluency'), 15, review.breakdown.fluency],
        ['format', t('dimFormat'), 10, review.breakdown.format],
      ]
      return h(
        'div',
        { className: 'dpt-breakdown', title: t('dims') },
        dims.map((dim) =>
          h(
            'span',
            { className: 'dpt-dim', key: dim[0] },
            h('span', { className: 'dpt-dim-tag' }, dim[1]),
            h('span', { className: 'dpt-dim-bar' }, h('i', { style: { width: `${Math.round((Number(dim[3]) / dim[2]) * 100)}%` } })),
            h('span', { className: 'dpt-dim-num' }, `${dim[3]}/${dim[2]}`),
          ),
        ),
      )
    }

    /**
     * Score chip: colour encodes the band, so quality is readable at a glance.
     * @param {{ score: number }} props
     */
    function ScoreBadge(props) {
      const score = props.score
      const tone =
        score >= 90
          ? 'var(--dsw-alias-state-success-primary)'
          : score >= 70
            ? 'var(--dsw-alias-state-warn-primary)'
            : 'var(--dsw-alias-state-error-primary)'
      return h('span', { className: 'dpt-badge', style: { color: tone, borderColor: tone } }, `${props.t} ${score}`)
    }

    /**
     * Render text with glossary-violation terms highlighted in red.
     * Ranges are half-open [start, end) offsets computed by the Host on the
     * same string, so plain slicing is exact. Terms outside any range render
     * as normal text.
     * @param {{ text: string, ranges: Array<{ start: number, end: number }> }} props
     */
    function MarkedText(props) {
      const text = props.text
      const ranges = (props.ranges || []).filter((range) => range.start >= 0 && range.end <= text.length && range.end > range.start)
      if (ranges.length === 0) return h('span', null, text)
      const sorted = [...ranges].sort((left, right) => left.start - right.start)
      const parts = []
      let cursor = 0
      for (let index = 0; index < sorted.length; index += 1) {
        const range = sorted[index]
        if (range.start < cursor) continue // overlapping or duplicate match
        if (range.start > cursor) parts.push(h('span', { key: `t${cursor}` }, text.slice(cursor, range.start)))
        parts.push(h('mark', { key: `m${range.start}`, className: 'dpt-termmark' }, text.slice(range.start, range.end)))
        cursor = range.end
      }
      if (cursor < text.length) parts.push(h('span', { key: `t${cursor}` }, text.slice(cursor)))
      return h('span', null, parts)
    }

    /**
     * One segment: source and translation side by side, with its own actions.
     * @param {object} props
     */
    function SegmentCard(props) {
      const { t, segment, view, editing, draft, busy, onStartEdit, onDraft, onSave, onCancelEdit, onRetranslate, onReview, onAccept, onReject, label, editingSource, sourceDraft, onStartEditSource, onSourceDraft, onSaveSource, onCancelEditSource } = props
      const showSource = view !== 'target'
      const showTarget = view !== 'source'
      const isEditing = editing === true
      const isEditingSource = editingSource === true
      const review = segment.review
      const pending = review !== null && review.status === 'open' && review.suggestion.length > 0

      return h(
        'section',
        { className: 'dpt-card' },
        h(
          'div',
          { className: 'dpt-card-hd' },
          h('span', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, label),
          segment.translation.length === 0 ? h('span', { className: 'dpt-badge' }, t('untranslated')) : null,
          segment.derivedFrom != null && segment.derivedFrom !== ''
            ? h('span', { className: 'dpt-badge', title: t('fromParagraphHint') }, `${t('fromParagraph')}${segment.derivedExact === false ? ' ?' : ''}`)
            : null,
          review === null ? null : h(ScoreBadge, { score: review.score, t: t('score') }),
          pending ? h('span', { className: 'dpt-badge', style: { borderColor: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-brand-primary)' } }, t('revisionPending')) : null,
          segment.issues.length > 0
            ? h('span', { className: 'dpt-badge', style: { color: 'var(--dsw-alias-state-warn-primary)', borderColor: 'var(--dsw-alias-state-warn-primary)' } }, `${t('termMiss')}: ${segment.issues.join(', ')}`)
            : null,
          segment.enforcement != null && segment.enforcement.status === 'repaired' && segment.issues.length === 0
            ? h('span', { className: 'dpt-badge', style: { color: 'var(--dsw-alias-state-success-primary)', borderColor: 'var(--dsw-alias-state-success-primary)' } }, t('termFixed'))
            : null,
          h('span', { className: 'dpt-fill' }),
          h('button', { type: 'button', className: 'dpt-btn tiny ghost', disabled: busy || segment.translation.length === 0, onClick: () => onReview(segment.id) }, t('reviewThis')),
          h('button', { type: 'button', className: 'dpt-btn tiny ghost', disabled: busy, onClick: () => onRetranslate(segment.id) }, t('retranslate')),
          h('button', { type: 'button', className: 'dpt-btn tiny ghost', onClick: () => onStartEdit(segment) }, isEditing ? t('cancelEdit') : t('edit')),
        ),
        h(
          'div',
          { className: `dpt-card-body ${showSource && showTarget ? 'two' : 'one'}` },
          showSource
            ? h(
                'div',
                { className: 'dpt-col' },
                h(
                  'div',
                  { className: 'dpt-row', style: { marginBottom: '3px' } },
                  showTarget ? h('div', { className: 'dpt-col-label', style: { margin: 0 } }, t('source')) : null,
                  h('span', { className: 'dpt-fill' }),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dpt-btn tiny ghost',
                      disabled: busy,
                      title: t('editSourceHint'),
                      onClick: () => onStartEditSource(segment),
                    },
                    isEditingSource ? t('cancelEdit') : t('editSource'),
                  ),
                ),
                isEditingSource
                  ? h(
                      'div',
                      null,
                      h('textarea', { className: 'dpt-area', value: sourceDraft, spellCheck: false, onChange: (event) => onSourceDraft(event.target.value) }),
                      h(
                        'div',
                        { className: 'dpt-row', style: { marginTop: '6px' } },
                        h('button', { type: 'button', className: 'dpt-btn tiny primary', onClick: () => onSaveSource(segment, sourceDraft) }, t('saveAndClear')),
                        h('button', { type: 'button', className: 'dpt-btn tiny ghost', onClick: onCancelEditSource }, t('cancelEdit')),
                      ),
                    )
                  : h(MarkedText, { text: segment.source, ranges: (segment.termMarks ?? []).flatMap((mark) => mark.sourceRanges ?? []) }),
              )
            : null,
          showTarget
            ? h(
                'div',
                { className: 'dpt-col' },
                showSource ? h('div', { className: 'dpt-col-label' }, t('translation')) : null,
                isEditing
                  ? h(
                      'div',
                      null,
                      h('textarea', { className: 'dpt-area', value: draft, spellCheck: false, onChange: (event) => onDraft(event.target.value) }),
                      h(
                        'div',
                        { className: 'dpt-row', style: { marginTop: '6px' } },
                        h('button', { type: 'button', className: 'dpt-btn tiny primary', onClick: () => onSave(segment.id, draft) }, t('save')),
                        h('button', { type: 'button', className: 'dpt-btn tiny ghost', onClick: onCancelEdit }, t('cancelEdit')),
                      ),
                    )
                  : h(
                      'div',
                      null,
                      h('div', { className: segment.translation.length === 0 ? 'dpt-text empty' : 'dpt-text' }, segment.translation.length === 0 ? t('untranslated') : segment.translation),
                      (segment.termMarks ?? []).length > 0
                        ? h('div', { className: 'dpt-termhint' }, (segment.termMarks ?? []).map((mark, index) => h('span', { key: `${segment.id}-th-${index}`, className: 'dpt-termhint-item' }, `“${mark.term}” → ${t('termRequired')} “${mark.required}”`)))
                        : null,
                    ),
              )
            : null,
        ),
        review === null
          ? null
          : h(
              'div',
              { className: 'dpt-review' },
              h(
                'div',
                { className: 'dpt-row wrap' },
                h('span', { style: { fontWeight: 600 } }, `${t('score')} ${review.score} / 100`),
                review.status === 'accepted' ? h('span', { className: 'dpt-badge' }, t('accepted')) : null,
                review.status === 'rejected' ? h('span', { className: 'dpt-badge' }, t('rejected')) : null,
                review.model.length > 0 ? h('span', { className: 'dpt-badge' }, review.model) : null,
              ),
              h(Breakdown, { review, t }),
              review.issues.length === 0
                ? null
                : h('ul', { className: 'dpt-review-issues' }, review.issues.map((issue, index) => h('li', { key: `${segment.id}-${index}` }, issue))),
              pending
                ? h(
                    'div',
                    null,
                    h('div', { className: 'dpt-col-label', style: { marginTop: '8px' } }, t('suggestion')),
                    h('div', { className: 'dpt-suggest' }, review.suggestion),
                    h(
                      'div',
                      { className: 'dpt-row', style: { marginTop: '8px' } },
                      h('button', { type: 'button', className: 'dpt-btn tiny primary', disabled: busy, onClick: () => onAccept(segment.id) }, t('accept')),
                      h('button', { type: 'button', className: 'dpt-btn tiny ghost', disabled: busy, onClick: () => onReject(segment.id) }, t('reject')),
                    ),
                  )
                : null,
            ),
      )
    }

    // ── Workbench ─────────────────────────────────────────────────────────────
    function Workbench(props) {
      const { t } = props

      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [tab, setTab] = React.useState('papers')
      const [sideCollapsed, setSideCollapsed] = React.useState(false)
      const [menuOpen, setMenuOpen] = React.useState(false)
      const [editing, setEditing] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [editingSource, setEditingSource] = React.useState(null)
      const [sourceDraftEdit, setSourceDraftEdit] = React.useState('')
      const [sourceDraft, setSourceDraft] = React.useState('')
      const [titleDraft, setTitleDraft] = React.useState('')
      const [creating, setCreating] = React.useState(false)
      const [glossaryDraft, setGlossaryDraft] = React.useState([])
      const [glossaryDirty, setGlossaryDirty] = React.useState(false)
      const [bulkText, setBulkText] = React.useState('')
      const [bulkOpen, setBulkOpen] = React.useState(false)
      const [providerDraft, setProviderDraft] = React.useState('')
      const [modelDraft, setModelDraft] = React.useState('')
      const [batchDraft, setBatchDraft] = React.useState(4)
      const [instructionsDraft, setInstructionsDraft] = React.useState('')
      const [models, setModels] = React.useState([])
      const [modelsError, setModelsError] = React.useState('')
      const [effortDraft, setEffortDraft] = React.useState('')
      const [efforts, setEfforts] = React.useState([])
      const [effortsError, setEffortsError] = React.useState('')
      const [savedTab, setSavedTab] = React.useState('')
      const savedTimers = React.useRef({})
      const [dragId, setDragId] = React.useState(null)
      const [dragOverId, setDragOverId] = React.useState(null)

      // Flash a short "saved" confirmation on the active settings tab, then clear it.
      const flashSaved = (which) => {
        setSavedTab(which)
        if (savedTimers.current[which]) clearTimeout(savedTimers.current[which])
        savedTimers.current[which] = setTimeout(() => {
          setSavedTab((current) => (current === which ? '' : current))
        }, 2200)
      }

      React.useEffect(() => () => {
        for (const timer of Object.values(savedTimers.current)) clearTimeout(timer)
      }, [])

      const active = state?.active ?? null
      const projectId = active?.id

      /** @param {string} action @param {any} payload @param {string} label */
      const run = async (action, payload, label) => {
        setBusy(label ?? action)
        setError('')
        try {
          const data = await postAction(action, payload)
          if (data.state) setState(data.state)
          return data
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught))
          return null
        } finally {
          setBusy('')
        }
      }

      // Initial load.
      React.useEffect(() => {
        let cancelled = false
        fetchState(undefined)
          .then((next) => {
            if (!cancelled) setState(next)
          })
          .catch((caught) => {
            if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught))
          })
        return () => {
          cancelled = true
        }
      }, [])

      // The glossary is one table for the whole profile, so it is loaded from the
      // top-level state rather than from a paper. It must reload when the table
      // changes, not when the paper does.
      React.useEffect(() => {
        const rows = state?.glossary ?? []
        setGlossaryDraft(
          rows.map((entry) => ({ en: entry.en, zh: entry.zh, note: entry.note ?? '', approved: entry.approved !== false, origin: entry.origin })),
        )
        setGlossaryDirty(false)
      }, [state?.glossary])

      // Switching papers only resets the inline editors.
      React.useEffect(() => {
        setEditing(null)
        setEditingSource(null)
      }, [projectId])

      // Keep the model editor in step with the saved settings.
      React.useEffect(() => {
        setProviderDraft(state?.settings?.provider ?? '')
        setModelDraft(state?.settings?.model ?? '')
        setBatchDraft(state?.settings?.batchSize ?? 4)
        setInstructionsDraft(state?.settings?.instructions ?? '')
        setEffortDraft(state?.settings?.reasoningEffort ?? '')
      }, [state?.settings?.provider, state?.settings?.model, state?.settings?.batchSize, state?.settings?.instructions, state?.settings?.reasoningEffort])

      // Poll only while a job is running.
      const running = active?.job?.running === true
      React.useEffect(() => {
        if (!running || projectId === undefined) return undefined
        const timer = setInterval(() => {
          fetchState(projectId)
            .then((next) => setState(next))
            .catch(() => {})
        }, 900)
        return () => clearInterval(timer)
      }, [running, projectId])

      /** @param {string} provider */
      const loadModels = async (provider) => {
        setModelsError('')
        setModels([])
        if (provider.trim().length === 0) return
        try {
          const data = await postAction('listModels', { provider })
          setModels(data?.result?.models ?? [])
          if (data?.result?.error) setModelsError(String(data.result.error))
        } catch (caught) {
          setModelsError(caught instanceof Error ? caught.message : String(caught))
        }
      }

      // Load the model list as soon as the model tab is open. The provider
      // dropdown no longer requires an extra click before models appear.
      React.useEffect(() => {
        if (tab === 'model' && providerDraft.trim().length > 0) void loadModels(providerDraft)
      }, [tab, providerDraft])

      // Reasoning efforts are model-specific and are not part of the model
      // catalog, so query them once the active provider/model is known.
      React.useEffect(() => {
        let cancelled = false
        const loadEfforts = async () => {
          setEffortsError('')
          setEfforts([])
          if (providerDraft.trim().length === 0 || modelDraft.trim().length === 0) return
          try {
            const data = await postAction('listModelEfforts', { provider: providerDraft, model: modelDraft })
            if (cancelled) return
            setEfforts(data?.result?.efforts ?? [])
            if (data?.result?.error) setEffortsError(String(data.result.error))
          } catch (caught) {
            if (!cancelled) setEffortsError(caught instanceof Error ? caught.message : String(caught))
          }
        }
        if (tab === 'model') void loadEfforts()
        return () => { cancelled = true }
      }, [tab, providerDraft, modelDraft])

      const selectPaper = async (id) => {
        setError('')
        try {
          setState(await fetchState(id))
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught))
        }
      }

      // Drag-and-drop ordering of the paper list. The dropped order is sent to
      // the Host, which persists an explicit `order` per paper so the sequence
      // survives reloads and no longer follows "most recently updated".
      const dropPaperAt = async (draggedId, targetId) => {
        if (draggedId === null || draggedId === targetId) return
        const ids = (state?.projects ?? []).map((project) => project.id)
        const from = ids.indexOf(draggedId)
        const to = ids.indexOf(targetId)
        if (from < 0 || to < 0) return
        ids.splice(to, 0, ...ids.splice(from, 1))
        setDragId(null)
        setDragOverId(null)
        await run('reorderProjects', { order: ids }, 'reorder')
      }

      const createPaper = async () => {
        const data = await run('createProject', { title: titleDraft, source: sourceDraft, direction: 'en-zh' }, 'create')
        if (data === null) return
        const id = data.result?.projectId
        setSourceDraft('')
        setTitleDraft('')
        setCreating(false)
        if (id !== undefined) await selectPaper(id)
      }

      const patchProject = async (patch) => {
        if (projectId === undefined) return
        await run('updateProject', { projectId, ...patch }, 'update')
      }

      const translate = async (scope, ids) => {
        if (projectId === undefined) return
        await run('translate', { projectId, scope, ids }, 'translate')
      }

      const review = async (scope, ids) => {
        if (projectId === undefined) return
        await run('review', { projectId, scope, ids }, 'review')
      }

      const acceptRevision = async (segmentId) => {
        if (projectId === undefined) return
        await run('acceptRevision', { projectId, segmentId }, 'accept')
      }

      const rejectRevision = async (segmentId) => {
        if (projectId === undefined) return
        await run('rejectRevision', { projectId, segmentId }, 'reject')
      }

      const enforceTerms = async () => {
        if (projectId === undefined) return
        const data = await run('enforceTerms', { projectId }, 'enforce')
        // run() already bannered transport/action errors; here we surface the
        // *outcome* of a successful call, which used to be silent and made the
        // button feel dead when the model could not fix a segment.
        const r = data?.result
        if (!r) return
        if ((r.checked ?? 0) === 0) {
          setError(t('enforceNothing'))
          return
        }
        const repaired = r.repaired ?? 0
        const failed = r.failed ?? 0
        if (repaired === 0 && failed === 0) {
          setError(t('enforceClean'))
          return
        }
        const parts = []
        if (repaired > 0) parts.push(fill(t('repairedCount'), { count: repaired }))
        if (failed > 0) parts.push(fill(t('enforceFailed'), { count: failed }))
        if (failed > 0 && Array.isArray(r.errors) && r.errors.length > 0) {
          // Surface the underlying model-call failure so a dead-looking button
          // always has an explanation (bad route, timeout, unparsable answer…).
          parts.push(r.errors[0])
        }
        setError(parts.join('；'))
      }

      const saveTranslation = async (segmentId, text) => {
        if (projectId === undefined) return
        const data = await run('setTranslation', { projectId, segmentId, text }, 'save')
        if (data !== null) {
          setEditing(null)
          setDraft('')
        }
      }

      /**
       * Save an edited source segment. In sentence mode the segment is one
       * sentence (p1:s2) and only that sentence's translation is cleared; in
       * paragraph mode it is the whole paragraph (p1).
       * @param {object} segment
       * @param {string} text
       */
      const saveSource = async (segment, text) => {
        if (projectId === undefined) return
        const next = typeof text === 'string' ? text.trim() : ''
        if (next.length === 0) {
          setError(t('sourceEmpty'))
          return
        }
        const data = await run('editSource', { projectId, segmentId: segment.id, source: next }, 'source')
        if (data !== null && data.result?.changed === false) setEditingSource(null)
        else if (data !== null) setEditingSource(null)
      }

      const extractTerms = async () => {
        if (projectId === undefined) return
        await run('extractTerms', { projectId }, 'extract')
      }

      const saveGlossary = async () => {
        const rows = glossaryDraft.filter((row) => row.en.trim().length > 0)
        // No project id: the table belongs to the profile, not to one paper.
        const data = await run('setGlossary', { glossary: rows }, 'glossary')
        if (data !== null) {
          setGlossaryDirty(false)
          flashSaved('terms')
        }
      }

      const clearGlossary = async () => {
        if (glossaryDraft.length === 0) return
        if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
          if (!window.confirm(t('clearGlossaryConfirm'))) return
        }
        // An empty array replaces the whole shared table; run() refreshes state,
        // whose effect re-syncs the draft.
        const data = await run('setGlossary', { glossary: [] }, 'glossary')
        if (data !== null) {
          setGlossaryDraft([])
          setGlossaryDirty(false)
          flashSaved('terms')
        }
      }

      const applyBulk = () => {
        if (bulkText.trim().length === 0) return
        const merged = mergeGlossaryRows(glossaryDraft, parseTermText(bulkText))
        setGlossaryDraft(merged)
        setGlossaryDirty(true)
        setBulkText('')
        setBulkOpen(false)
      }

      const saveSettings = async () => {
        const data = await run('setSettings', { provider: providerDraft, model: modelDraft, batchSize: batchDraft, instructions: instructionsDraft, reasoningEffort: effortDraft }, 'settings')
        if (data !== null) flashSaved('model')
      }

      const exportPaper = async (format) => {
        if (projectId === undefined) return
        const data = await run('exportText', { projectId, format }, 'export')
        if (data?.result?.markdown !== undefined) downloadText(data.result.filename, data.result.markdown)
        setMenuOpen(false)
      }

      const clearTranslations = async () => {
        if (projectId === undefined) return
        await run('clearTranslations', { projectId }, 'clear')
        setMenuOpen(false)
      }

      const deletePaper = async () => {
        if (projectId === undefined) return
        setMenuOpen(false)
        if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
          if (!window.confirm(`${t('deleteConfirm')}「${active.title}」?`)) return
        }
        const data = await run('deleteProject', { projectId }, 'delete')
        if (data === null) return
        const next = await fetchState(undefined).catch(() => null)
        if (next !== null) setState(next)
      }

      const toggleSkill = async (name) => {
        if (active === null) return
        const current = Array.isArray(active.skills) ? active.skills : []
        const next = current.includes(name) ? current.filter((item) => item !== name) : [...current, name]
        await run('updateProject', { projectId, skills: next }, 'skills')
      }

      const direction = active?.direction ?? 'en-zh'
      const granularity = active?.granularity ?? 'paragraph'
      const view = active?.view ?? 'bilingual'
      const job = active?.job ?? null
      const counts = active?.counts ?? null

      // ── Header ──────────────────────────────────────────────────────────────
      const header = h(
        'header',
        { className: 'dpt-hd' },
        h('span', { className: active === null ? 'dpt-hd-title muted' : 'dpt-hd-title' }, active === null ? t('noPaper') : active.title),
        h('span', { className: 'dpt-fill' }),
        h(Seg, {
          label: t('direction'),
          value: direction,
          disabled: active === null,
          options: [
            { value: 'en-zh', label: t('dirEnZh') },
            { value: 'zh-en', label: t('dirZhEn') },
          ],
          onChange: (next) => void patchProject({ direction: next }),
        }),
        h(Seg, {
          label: t('segLength'),
          value: granularity,
          disabled: active === null,
          options: [
            { value: 'paragraph', label: t('paragraphMode') },
            { value: 'sentence', label: t('sentenceMode') },
          ],
          onChange: (next) => void patchProject({ granularity: next }),
        }),
        h(Seg, {
          label: t('view'),
          value: view,
          disabled: active === null,
          options: [
            { value: 'bilingual', label: t('viewBilingual') },
            { value: 'target', label: t('viewTarget') },
            { value: 'source', label: t('viewSource') },
          ],
          onChange: (next) => void patchProject({ view: next }),
        }),
        h(
          'button',
          {
            type: 'button',
            className: 'dpt-btn',
            disabled: active === null || running || busy === 'enforce' || (counts?.unresolved ?? 0) === 0,
            onClick: () => void enforceTerms(),
          },
          busy === 'enforce' ? t('enforcing') : `${t('enforceTerms')}${counts?.unresolved ? ` ${counts.unresolved}` : ''}`,
        ),
        h(
          'div',
          { className: 'dpt-menu' },
          h(
            'button',
            { type: 'button', className: 'dpt-btn icon', title: t('more'), 'aria-haspopup': 'menu', 'aria-expanded': menuOpen, onClick: () => setMenuOpen((open) => !open) },
            '⋯',
          ),
          menuOpen
            ? h(
                'div',
                { className: 'dpt-menu-list', role: 'menu' },
                h('button', { type: 'button', role: 'menuitem', disabled: active === null || running, onClick: () => { setMenuOpen(false); void translate('all') } }, t('retranslateAll')),
                h('button', { type: 'button', role: 'menuitem', disabled: active === null || running || (counts?.translated ?? 0) === 0, onClick: () => { setMenuOpen(false); void review('all') } }, t('reviewAll')),
                h('button', { type: 'button', role: 'menuitem', disabled: active === null, onClick: () => void exportPaper('bilingual') }, t('exportBilingual')),
                h('button', { type: 'button', role: 'menuitem', disabled: active === null, onClick: () => void exportPaper('target') }, t('exportTarget')),
                h('button', { type: 'button', role: 'menuitem', disabled: active === null || (counts?.translated ?? 0) === 0, onClick: () => void clearTranslations() }, t('clearTranslations')),
                h('button', { type: 'button', role: 'menuitem', className: 'danger', disabled: active === null, style: { color: 'var(--dsw-alias-state-error-primary)' }, onClick: () => void deletePaper() }, t('delete')),
              )
            : null,
        ),
      )

      // ── Side panel: four tabs, one job each ─────────────────────────────────
      const papersPane = h(
        'div',
        null,
        h(
          'div',
          { className: 'dpt-row', style: { marginBottom: '10px' } },
          h('span', { className: 'dpt-label', style: { margin: 0, flex: '1 1 auto' } }, t('tabPapers')),
          h('button', { type: 'button', className: creating ? 'dpt-btn tiny ghost' : 'dpt-btn tiny primary', onClick: () => setCreating((open) => !open) }, creating ? t('cancel') : t('newPaper')),
        ),
        creating
          ? h(
              'div',
              { className: 'dpt-stack', style: { marginBottom: '12px' } },
              h('input', { className: 'dpt-input', placeholder: t('newPaperTitle'), value: titleDraft, onChange: (event) => setTitleDraft(event.target.value) }),
              h('textarea', { className: 'dpt-area tall', placeholder: t('sourcePlaceholder'), value: sourceDraft, onChange: (event) => setSourceDraft(event.target.value) }),
              h(
                'button',
                { type: 'button', className: 'dpt-btn primary', disabled: busy === 'create' || sourceDraft.trim().length === 0, onClick: () => void createPaper() },
                busy === 'create' ? t('creating') : t('create'),
              ),
            )
          : null,
        (state?.projects ?? []).length === 0
          ? h('div', { className: 'dpt-note' }, t('noProjects'))
          : (state?.projects ?? []).map((project) =>
              h(
                'div',
                {
                  key: project.id,
                  className:
                    (active !== null && active.id === project.id ? 'dpt-item on' : 'dpt-item') +
                    (dragOverId === project.id && dragId !== project.id ? ' drag-target' : ''),
                  role: 'button',
                  tabIndex: 0,
                  draggable: true,
                  onClick: () => void selectPaper(project.id),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter' || event.key === ' ') void selectPaper(project.id)
                  },
                  onDragStart: (event) => {
                    setDragId(project.id)
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', project.id)
                  },
                  onDragEnd: () => {
                    setDragId(null)
                    setDragOverId(null)
                  },
                  onDragOver: (event) => {
                    if (dragId === null) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    if (dragOverId !== project.id) setDragOverId(project.id)
                  },
                  onDragLeave: (event) => {
                    if (dragOverId === project.id && event.currentTarget === event.target) setDragOverId(null)
                  },
                  onDrop: (event) => {
                    event.preventDefault()
                    const dragged = dragId ?? event.dataTransfer.getData('text/plain')
                    void dropPaperAt(dragged, project.id)
                  },
                },
                h(
                  'div',
                  { className: 'dpt-item-body' },
                  h('div', { className: 'dpt-item-title' }, project.title),
                  h(
                    'div',
                    { className: 'dpt-item-meta' },
                    `${project.direction === 'zh-en' ? t('dirZhEn') : t('dirEnZh')} · ${project.translated}/${project.segments} · ${project.granularity === 'sentence' ? t('sentenceMode') : t('paragraphMode')}`,
                  ),
                ),
              ),
            ),
      )

      const termsPane = h(
        'div',
        null,
        h(
          'div',
          { className: 'dpt-row', style: { marginBottom: '10px' } },
          h('span', { className: 'dpt-label', style: { margin: 0, flex: '1 1 auto' } }, t('tabTerms')),
          h('button', { type: 'button', className: 'dpt-btn tiny', disabled: active === null || busy === 'extract', onClick: () => void extractTerms() }, busy === 'extract' ? t('extracting') : t('extract')),
        ),
        h('p', { className: 'dpt-note' }, t('glossaryHint')),
        // The glossary is shared, so it is editable with or without a paper open.
        glossaryDraft.length === 0
          ? h('p', { className: 'dpt-note' }, t('glossaryEmpty'))
          : h(
              'table',
              { className: 'dpt-gloss' },
              h('thead', null, h('tr', null, h('th', null, t('termSource')), h('th', null, t('termTarget')), h('th', null, ''))),
              h(
                'tbody',
                null,
                glossaryDraft.map((row, index) =>
                  h(
                    'tr',
                    { key: `${row.en}-${index}`, className: row.approved ? '' : 'off' },
                    h('td', null, h('input', { type: 'text', value: row.en, placeholder: t('termSource'), onChange: (event) => { const next = [...glossaryDraft]; next[index] = { ...row, en: event.target.value }; setGlossaryDraft(next); setGlossaryDirty(true) } })),
                    h('td', null, h('input', { type: 'text', value: row.zh, placeholder: t('termTarget'), onChange: (event) => { const next = [...glossaryDraft]; next[index] = { ...row, zh: event.target.value }; setGlossaryDraft(next); setGlossaryDirty(true) } })),
                    h(
                      'td',
                      { style: { whiteSpace: 'nowrap', width: '58px' } },
                      h('input', { type: 'checkbox', title: t('termOn'), checked: row.approved, onChange: (event) => { const next = [...glossaryDraft]; next[index] = { ...row, approved: event.target.checked }; setGlossaryDraft(next); setGlossaryDirty(true) } }),
                      h('button', { type: 'button', className: 'dpt-btn tiny ghost', title: t('remove'), onClick: () => { setGlossaryDraft(glossaryDraft.filter((_item, at) => at !== index)); setGlossaryDirty(true) } }, '×'),
                    ),
                  ),
                ),
              ),
            ),
        h(
              'div',
              { className: 'dpt-row wrap', style: { marginTop: '10px' } },
              h('button', { type: 'button', className: 'dpt-btn tiny ghost', onClick: () => { setGlossaryDraft([...glossaryDraft, { en: '', zh: '', note: '', approved: true, origin: 'manual' }]); setGlossaryDirty(true) } }, t('addTerm')),
              h('button', { type: 'button', className: 'dpt-btn tiny ghost', onClick: () => setBulkOpen((open) => !open) }, t('bulk')),
              h('button', { type: 'button', className: 'dpt-btn tiny ghost danger', disabled: glossaryDraft.length === 0, title: t('clearGlossaryConfirm'), onClick: () => void clearGlossary() }, t('clearGlossary')),
              h('button', { type: 'button', className: 'dpt-btn tiny primary', disabled: !glossaryDirty, onClick: () => void saveGlossary() }, t('saveGlossary')),
              savedTab === 'terms' ? h(SavedBadge, { label: t('saved') }) : glossaryDirty ? h('span', { className: 'dpt-note', style: { margin: 0 } }, t('unsaved')) : null,
            ),
        bulkOpen
          ? h(
              'div',
              { className: 'dpt-stack', style: { marginTop: '8px' } },
              h('p', { className: 'dpt-note', style: { margin: 0 } }, t('bulkHint')),
              h('textarea', { className: 'dpt-area', value: bulkText, placeholder: 'heat tolerance=耐热性', onChange: (event) => setBulkText(event.target.value) }),
              h('button', { type: 'button', className: 'dpt-btn tiny', onClick: applyBulk }, t('bulkApply')),
            )
          : null,
      )

      const skillsPane = h(
        'div',
        null,
        h('div', { className: 'dpt-row', style: { justifyContent: 'space-between' } },
          h('span', { className: 'dpt-label', style: { margin: 0 } }, t('tabSkills')),
        ),
        h('p', { className: 'dpt-note' }, t('skillsHint')),
        (state?.skills ?? []).length === 0
          ? h('p', { className: 'dpt-note' }, t('noSkills'))
          : (state?.skills ?? []).map((skill) =>
              h(
                'div',
                { key: skill.name, className: 'dpt-row' },
                h(Switch, {
                  label: skill.name,
                  checked: (active?.skills ?? []).includes(skill.name),
                  disabled: active === null || busy === 'skills',
                  onChange: () => void toggleSkill(skill.name),
                }),
                h('span', { style: { minWidth: 0, flex: '1 1 auto' } }, h('div', { className: 'dpt-item-title' }, skill.name), h('div', { className: 'dpt-item-meta' }, skill.description)),
              ),
            ),
      )

      const modelPane = h(
        'div',
        null,
        h('div', { className: 'dpt-row', style: { justifyContent: 'space-between' } },
          h('span', { className: 'dpt-label', style: { margin: 0 } }, t('tabModel')),
          savedTab === 'model' ? h(SavedBadge, { label: t('saved') }) : null,
        ),
        h('p', { className: 'dpt-note' }, `${t('modelRoute')}: ${state?.effectiveRoute === null || state?.effectiveRoute === undefined ? t('noRoute') : `${state.effectiveRoute.provider} / ${state.effectiveRoute.model}`}`),
        h(
          'div',
          { className: 'dpt-stack' },
          h(
            'label',
            null,
            h('div', { className: 'dpt-col-label' }, t('provider')),
            h(
              'select',
              {
                className: 'dpt-select',
                value: providerDraft,
                onChange: (event) => {
                  const provider = event.target.value
                  setProviderDraft(provider)
                  setModelDraft('')
                  void loadModels(provider)
                },
              },
              h('option', { value: '' }, t('followSession')),
              (state?.providers ?? []).map((provider) => h('option', { key: provider.id, value: provider.id }, `${provider.name || provider.id} (${provider.id})`)),
            ),
          ),
          h(
            'label',
            null,
            h('div', { className: 'dpt-col-label' }, t('model')),
            h(
              'select',
              {
                className: 'dpt-select',
                value: modelDraft,
                disabled: providerDraft === '',
                onChange: (event) => setModelDraft(event.target.value),
              },
              h('option', { value: '' }, models.length === 0 ? t('noModelList') : t('pickModel')),
              models.map((model) => h('option', { key: model.id, value: model.id }, model.name || model.id)),
            ),
          ),
          modelsError.length > 0 ? h('p', { className: 'dpt-note', style: { margin: 0, color: 'var(--dsw-alias-state-error-primary)' } }, modelsError) : null,
          h(
            'label',
            null,
            h('div', { className: 'dpt-col-label' }, t('reasoningEffort')),
            h(
              'select',
              {
                className: 'dpt-select',
                value: effortDraft,
                disabled: efforts.length === 0,
                onChange: (event) => setEffortDraft(event.target.value),
              },
              h('option', { value: '' }, t('followDefault')),
              efforts.map((effort) => h('option', { key: effort.id, value: effort.id }, effort.name || effort.id)),
            ),
            effortsError.length > 0
              ? h('p', { className: 'dpt-note', style: { margin: '4px 0 0', color: 'var(--dsw-alias-state-error-primary)' } }, effortsError)
              : h('p', { className: 'dpt-note', style: { margin: '4px 0 0' } }, efforts.length === 0 ? t('noEfforts') : t('reasoningEffortHint')),
          ),
          h(
            'label',
            null,
            h('div', { className: 'dpt-col-label' }, t('batchSize')),
            h('input', { className: 'dpt-input', type: 'number', min: 1, max: 20, value: batchDraft, onChange: (event) => setBatchDraft(Number(event.target.value) || 1) }),
            h('p', { className: 'dpt-note', style: { margin: '4px 0 0' } }, t('batchHint')),
          ),
          h(
            'label',
            null,
            h('div', { className: 'dpt-col-label' }, t('instructions')),
            h('textarea', { className: 'dpt-area tall', placeholder: t('instructionsPlaceholder'), value: instructionsDraft, onChange: (event) => setInstructionsDraft(event.target.value) }),
            h('p', { className: 'dpt-note', style: { margin: '4px 0 0' } }, t('instructionsHint')),
          ),
          h('button', { type: 'button', className: 'dpt-btn primary', disabled: busy === 'settings', onClick: () => void saveSettings() }, t('saveSettings')),
        ),
      )

      const sideToggle = h(
        'button',
        {
          type: 'button',
          className: 'dpt-btn icon ghost',
          title: sideCollapsed ? t('expandSide') : t('collapseSide'),
          'aria-label': sideCollapsed ? t('expandSide') : t('collapseSide'),
          'aria-expanded': !sideCollapsed,
          onClick: () => setSideCollapsed((value) => !value),
        },
        sideCollapsed ? '»' : '«',
      )

      const side = h(
        'aside',
        { className: sideCollapsed ? 'dpt-side collapsed' : 'dpt-side' },
        h(
          'div',
          { className: 'dpt-tabs', role: 'tablist' },
          [
            { id: 'papers', label: t('tabPapers') },
            { id: 'terms', label: t('tabTerms') },
            { id: 'skills', label: t('tabSkills') },
            { id: 'model', label: t('tabModel') },
          ].map((item) =>
            h(
              'button',
              { key: item.id, type: 'button', role: 'tab', 'aria-selected': tab === item.id, onClick: () => setTab(item.id) },
              item.label,
            ),
          ),
          h('span', {
            className: 'dpt-tab-ind',
            'aria-hidden': 'true',
            style: { '--dpt-tab-i': String(['papers', 'terms', 'skills', 'model'].indexOf(tab)) },
          }),
          sideToggle,
        ),
        h('div', { className: 'dpt-pane', role: 'tabpanel' }, tab === 'papers' ? papersPane : tab === 'terms' ? termsPane : tab === 'skills' ? skillsPane : modelPane),
      )

      // ── Reading area ────────────────────────────────────────────────────────
      const progress =
        job !== null && (job.running || job.error !== null)
          ? h(
              'div',
              { className: 'dpt-progress' },
              h('div', { className: 'dpt-bar' }, h('i', { style: { width: `${job.total === 0 ? 0 : Math.round((Math.min(job.done, job.total) / job.total) * 100)}%` } })),
              h(
                'span',
                null,
                job.running
                  ? fill(job.kind === 'review' ? t('jobReviewing') : t('jobTranslating'), { done: job.done, total: job.total })
                  : `${job.done}/${job.total}`,
                job.error !== null ? ` · ${t('jobError')}: ${job.error}` : '',
              ),
            )
          : null

      const summary =
        counts === null
          ? ''
          : [
              fill(t('counts'), { done: counts.translated, segments: counts.segments }),
              counts.repaired > 0 ? fill(t('repairedCount'), { count: counts.repaired }) : null,
              counts.unresolved > 0 ? fill(t('unresolvedCount'), { count: counts.unresolved }) : null,
              counts.averageScore === null ? null : fill(t('averageScore'), { score: counts.averageScore }),
              counts.pendingRevisions > 0 ? fill(t('pendingCount'), { count: counts.pendingRevisions }) : null,
            ]
              .filter((part) => part !== null)
              .join(' · ')

      const emptyState = h(
        'div',
        { className: 'dpt-empty' },
        h('h2', null, t('emptyTitle')),
        h('p', null, t('emptyHint')),
        h(
          'div',
          { className: 'dpt-stack' },
          h('input', { className: 'dpt-input', placeholder: t('newPaperTitle'), value: titleDraft, onChange: (event) => setTitleDraft(event.target.value) }),
          h('textarea', { className: 'dpt-area tall', placeholder: t('sourcePlaceholder'), value: sourceDraft, onChange: (event) => setSourceDraft(event.target.value) }),
          h(
            'button',
            { type: 'button', className: 'dpt-btn primary', disabled: busy === 'create' || sourceDraft.trim().length === 0, onClick: () => void createPaper() },
            busy === 'create' ? t('creating') : t('create'),
          ),
        ),
      )

      const cards = []
      if (active !== null) {
        for (const segment of active.segments) {
          const paragraphNumber = segment.paragraphId.replace(/^p/u, '')
          const label =
            granularity === 'sentence'
              ? fill(t('sentLabel'), { n: paragraphNumber, m: segment.index + 1 })
              : fill(t('segLabel'), { n: paragraphNumber })
          cards.push(
            h(SegmentCard, {
              key: segment.id,
              t,
              segment,
              label,
              view,
              editing: editing === segment.id,
              draft: editing === segment.id ? draft : '',
              busy: running || busy === 'translate' || busy === 'review',
              onStartEdit: (row) => {
                if (editing === row.id) {
                  setEditing(null)
                  setDraft('')
                  return
                }
                setEditing(row.id)
                setDraft(row.translation)
              },
              onDraft: setDraft,
              onSave: (id, text) => void saveTranslation(id, text),
              onCancelEdit: () => {
                setEditing(null)
                setDraft('')
              },
              onRetranslate: (id) => void translate('ids', [id]),
              onReview: (id) => void review('missing', [id]),
              onAccept: (id) => void acceptRevision(id),
              onReject: (id) => void rejectRevision(id),
              editingSource: editingSource === segment.id,
              sourceDraft: editingSource === segment.id ? sourceDraftEdit : '',
              onStartEditSource: (row) => {
                if (editingSource === row.id) {
                  setEditingSource(null)
                  setSourceDraftEdit('')
                  return
                }
                // Edit exactly what the card shows: one sentence in sentence
                // mode, the whole paragraph in paragraph mode. The Host
                // replaces that segment and only clears its own records.
                setEditingSource(row.id)
                setSourceDraftEdit(row.source)
              },
              onSourceDraft: setSourceDraftEdit,
              onSaveSource: (row, text) => void saveSource(row, text),
              onCancelEditSource: () => {
                setEditingSource(null)
                setSourceDraftEdit('')
              },
            }),
          )
        }
      }

      const issueCount = counts?.issues ?? 0

      return h(
        'div',
        { className: 'dpt' },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        header,
        error.length > 0 ? h('div', { className: 'dpt-banner error' }, error) : null,
        active !== null && issueCount > 0 ? h('div', { className: 'dpt-banner warn' }, fill(t('issueCount'), { count: issueCount })) : null,
        progress,
        h(
          'div',
          { className: 'dpt-body' },
          side,
          sideCollapsed ? h('div', { className: 'dpt-side-rail' }, sideToggle) : null,
          h(
            'main',
            { className: 'dpt-main' },
            active === null
              ? emptyState
              : h(
                  'div',
                  null,
                  h('div', { className: 'dpt-toolbar' }, h('span', null, summary), h('span', { className: 'dpt-fill' })),
                  h('div', null, cards),
                ),
          ),
        ),
      )
    }

    return {
      // `locale` must be declared: reading ctx.locale without it throws, which
      // would silently downgrade every label to the bundled Chinese fallback.
      inject: ['slots', 'locale'],
      apply(ctx) {
        // Each registration is isolated: one failing slot must not blank the
        // others. The typed locale dependency above is what keeps labels live.
        const guard = (work) => {
          try {
            return work()
          } catch {
            return undefined
          }
        }

        const t = guard(() => makeT(ctx)) ?? ((key) => zh[key] ?? key)

guard(() =>
          ctx.effect(
            () =>
              ctx.slots.inject('sidebar.panellist', () =>
                ctx.slots.register(
                  { name: 'sidebar.panellist', id: PANEL_ID, order: 55, label: () => t('appTitle'), locale: LOCALE_NS },
                  (owner = {}) => h(SidebarIcon, { size: owner.size ?? 16, active: owner.active === true }),
                ),
              ),
            'academic-translator: sidebar entry',
          ),
        )
guard(() =>
          ctx.effect(
            () =>
              ctx.slots.inject('main', () =>
                ctx.slots.register({ name: 'main', key: PANEL_ID, locale: LOCALE_NS }, () => h(Workbench, { t })),
              ),
            'academic-translator: main panel',
          ),
        )
guard(() =>
          ctx.effect(
            () =>
              ctx.slots.inject('settings.section', () =>
                ctx.slots.register({ name: 'settings.section', id: PANEL_ID, order: 42, label: () => t('appTitle'), locale: LOCALE_NS }, () => h(Workbench, { t })),
              ),
            'academic-translator: settings section',
          ),
        )
guard(() => {
          if (typeof ctx.effect !== 'function' || !ctx?.locale?.register) return undefined
          return ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'academic-translator: dictionaries')
        })
      },
    }
  },
})