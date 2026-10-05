/**
 * dsh-instruction-memory — Client half.
 *
 * Hand-authored in the browser module-loader format the web shell expects
 * (`window.__ModuleLoader__.load` + `require`), so the package needs no build
 * step. Contributes one settings page; all data lives host-side and is reached
 * through the same-origin route the Host half registers.
 *
 * UI copy is bilingual (zh/en). When the host ships the official locale
 * service (`ctx.locale`, from @deepseek-ai/dsh-client-locale) the panel
 * follows the user's Language preference live; otherwise the built-in
 * dictionaries pick the browser's language (zh by default).
 */
window.__ModuleLoader__.load({
  id: 'dsh-instruction-memory',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    const API = '/instruction-memory/api'

    const CSS = `
.im-root { display:flex; flex-direction:column; gap:16px; padding:6px 2px 56px; max-width:860px;
  color:var(--dsw-alias-label-primary,#1f2329); font-size:13px; line-height:1.6; }
.im-h { margin:0; font-size:14px; font-weight:600; }
.im-sub { margin:3px 0 0; font-size:12px; color:var(--dsw-alias-label-secondary,#8a9099); }
.im-card { display:flex; flex-direction:column; gap:11px; padding:15px; border-radius:12px;
  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1)); background:var(--dsw-alias-bg-layer-1,#fff); }
.im-row { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.im-row-wrap { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.im-grid2 { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.im-spacer { flex:1; }
.im-btn { border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.18)); background:var(--dsw-alias-bg-layer-1,#fff);
  color:inherit; border-radius:8px; padding:5px 12px; font-size:12px; font-family:inherit; cursor:pointer; }
.im-btn:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05)); }
.im-btn:disabled { opacity:.5; cursor:not-allowed; }
.im-btn-primary { background:var(--dsw-alias-brand-primary,#3b6cff); border-color:transparent; color:#fff; }
.im-btn-danger { color:var(--dsw-alias-state-error-primary,#d94838); }
.im-input, .im-textarea, .im-select { width:100%; box-sizing:border-box; border-radius:8px; padding:7px 10px;
  border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.18)); background:var(--dsw-alias-bg-base,#fff);
  color:inherit; font-size:13px; font-family:inherit; line-height:1.55; }
.im-textarea { resize:vertical; min-height:92px; }
.im-input:focus, .im-textarea:focus, .im-select:focus { outline:none; border-color:var(--dsw-alias-brand-primary,#3b6cff); }
.im-label { display:block; margin-bottom:5px; font-size:12px; color:var(--dsw-alias-label-secondary,#8a9099); }
.im-list { display:flex; flex-direction:column; gap:8px; }
.im-item { display:flex; flex-direction:column; gap:6px; padding:12px 14px; border-radius:10px;
  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1)); background:var(--dsw-alias-bg-layer-1,#fff); }
.im-item-off { opacity:.5; }
.im-item-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.im-title { font-size:13px; font-weight:600; }
.im-body { font-size:12px; color:var(--dsw-alias-label-secondary,#6b7280);
  white-space:pre-wrap; word-break:break-word; max-height:96px; overflow:hidden; }
.im-tag { padding:1px 8px; border-radius:999px; font-size:11px; white-space:nowrap;
  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.14)); color:var(--dsw-alias-label-secondary,#6b7280); }
.im-tag-always { color:var(--dsw-alias-brand-primary,#3b6cff); border-color:currentColor; }
.im-tag-auto { color:var(--dsw-alias-state-success-primary,#18a058); border-color:currentColor; }
.im-tag-high { color:var(--dsw-alias-state-warn-primary,#d97706); border-color:currentColor; }
.im-empty { padding:26px; border-radius:10px; text-align:center; font-size:12px;
  border:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.18)); color:var(--dsw-alias-label-secondary,#8a9099); }
.im-err { font-size:12px; color:var(--dsw-alias-state-error-primary,#d94838); }
.im-ok { font-size:12px; color:var(--dsw-alias-state-success-primary,#18a058); }
.im-warn { font-size:12px; color:var(--dsw-alias-state-warn-primary,#d97706); }
.im-meta { font-size:11.5px; color:var(--dsw-alias-label-secondary,#8a9099); word-break:break-all; }
.im-pre { margin:0; padding:12px 14px; border-radius:8px; font-size:11.5px; line-height:1.65;
  background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04)); color:var(--dsw-alias-label-secondary,#4b5563);
  white-space:pre-wrap; word-break:break-word; max-height:340px; overflow:auto;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
.im-switch { display:inline-flex; align-items:center; gap:6px; font-size:12px; cursor:pointer; user-select:none; }
.im-switch input { width:15px; height:15px; margin:0; cursor:pointer; accent-color:var(--dsw-alias-brand-primary,#3b6cff); }
.im-divider { height:1px; background:var(--dsw-alias-border-l1,rgba(0,0,0,.08)); }
.im-status { display:flex; align-items:center; gap:7px; font-size:12px; }
.im-dot { width:7px; height:7px; border-radius:50%; flex:none; background:var(--dsw-alias-label-secondary,#8a9099); }
.im-dot-on { background:var(--dsw-alias-state-success-primary,#18a058); }
.im-dot-off { background:var(--dsw-alias-state-warn-primary,#d97706); }
.im-dot-err { background:var(--dsw-alias-state-error-primary,#d94838); }
.im-body-open { max-height:none; }
.im-more { margin-top:4px; font-size:11.5px; color:var(--dsw-alias-brand-primary,#3b6cff); cursor:pointer; user-select:none; }
.im-search-meta { margin-top:5px; }
.im-undo { display:flex; align-items:center; gap:10px; padding:9px 13px; border-radius:8px; font-size:12px;
  border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14)); background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04)); }
.im-undo button { border:1px solid var(--dsw-alias-brand-primary,#3b6cff); color:var(--dsw-alias-brand-primary,#3b6cff);
  background:transparent; border-radius:7px; padding:2px 10px; font-size:12px; font-family:inherit; cursor:pointer; }
@media (max-width:640px) { .im-grid2 { grid-template-columns:1fr; } }
`

    /* ---------------- i18n ---------------- */

    /** Our slice of the dictionary registry; one owner per namespace. */
    const NS = 'instruction-memory'

    /**
     * The full UI copy, both shipped locales, identical key sets. zh is the
     * fallback locale (mirrors the official FALLBACK_LOCALE), so a missing en
     * entry must be a build mistake — verify.mjs pins the key sets equal.
     */
    const STRINGS = {
      zh: {
        'section.label': '指令记忆',
        'panel.title': '指令记忆',
        'panel.subtitle': '保存后自动写入系统提示词，对此后所有对话、问答与任务执行生效。',
        'panel.loading': '正在读取指令记忆…',
        'panel.masterSwitch': '总开关',
        'status.mounted': '已挂载到系统提示词——后续每轮对话自动生效（{chars} 字符）',
        'status.notMountedEmpty': '未挂载：当前没有启用中的指令',
        'status.notMounted': '未挂载',
        'err.unrecognized': '宿主返回了无法识别的数据',
        'err.http': '宿主返回 HTTP {status}',
        'err.httpDetail': '宿主返回 HTTP {status}：{detail}',
        'err.timeout': '请求宿主超时（15 秒无响应）',
        'export.failed': '导出失败：宿主返回了无法识别的数据',
        'import.notJson': '导入文件不是有效的 JSON（{detail}）',
        'import.tooLarge': '文件约 {size} MB，远超本插件可导入的规模（约 {limit} MB 以内）。请确认选择的是「导出」生成的 JSON 文件。',
        'editor.new': '新增指令',
        'editor.edit': '编辑指令',
        'editor.title': '标题',
        'editor.titlePlaceholder': '例如：回答语言',
        'editor.content': '指令内容',
        'editor.contentPlaceholder': '例如：所有回答使用简体中文；不确定需求时先提问再动手。',
        'editor.mode': '生效方式',
        'editor.modeAlways': '始终生效（无条件遵守）',
        'editor.modeAuto': '按需生效（按相关性自动判断）',
        'editor.priority': '优先级',
        'priority.high': '高',
        'priority.normal': '普通',
        'priority.low': '低',
        'editor.when': '适用场景（可选，帮助模型判断何时生效）',
        'editor.whenPlaceholder': '例如：编写或修改代码时',
        'editor.save': '保存',
        'editor.saving': '保存中…',
        'editor.cancel': '取消',
        'editor.hint': '保存后对下一轮对话立即生效',
        'editor.needTitleOrContent': '请至少填写标题或指令内容',
        'editor.confirmDiscard': '当前编辑内容尚未保存，确定放弃这些修改吗？',
        'body.expand': '展开全部',
        'body.collapse': '收起',
        'budget.label': '注入字数上限（字符）',
        'budget.unitHint': '单位是字符，不是 token',
        'budget.rangeError': '上限需在 {min} ~ {max} 之间',
        'budget.note': '单位为字符、非 token：按 DeepSeek 分词约 1 个中文字符 ≈ 0.6 token（英文 ≈ 0.3），{max} 字符上限约合 {tokens} token，实际以模型为准。',
        'rules.label': '生效规则',
        'rules.note': '「始终」无条件生效；「按需」由模型按相关性自动判断。超出上限时按优先级保留，其余暂不注入。',
        'search.placeholder': '搜索指令：标题 / 内容 / 适用场景（共 {count} 条）',
        'search.matchCount': '匹配 {shown} / {total} 条',
        'action.new': '＋ 新增指令',
        'action.reload': '重新载入',
        'action.export': '导出',
        'action.import': '导入',
        'action.showPreview': '查看实际注入内容',
        'action.hidePreview': '收起注入内容',
        'stats.count': '共 {total} 条，生效 {active} 条',
        'storage.file': '存储文件：{path}',
        'storage.noFile': '（未写入磁盘）',
        'storage.savedAt': '最近保存：{time}',
        'storage.notSaved': '尚未保存到磁盘',
        'storage.migrated': '已从旧位置迁移：{path}（原文件保留为 *.migrated）',
        'preview.label': '当前注入到每轮系统提示词的内容',
        'preview.empty': '（当前没有生效中的指令）',
        'list.empty': '还没有指令记忆。点击「＋ 新增指令」添加第一条，例如“所有回答使用简体中文”。',
        'list.noMatch': '没有匹配“{query}”的指令。',
        'tag.always': '始终',
        'tag.auto': '按需',
        'entry.enabled': '启用',
        'entry.edit': '编辑',
        'entry.delete': '删除',
        'entry.untitled': '未命名指令',
        'entry.confirmDelete': '确定删除「{title}」？删除后无法恢复。',
        'entry.when': '适用场景：{when}',
        'entry.updatedAt': '更新于 {time}',
        'undo.deleted': '已删除「{title}」',
        'undo.restore': '撤销删除',
        'undo.dismiss': '知道了',
        'undo.restored': '已恢复刚删除的指令',
      },
      en: {
        'section.label': 'Instruction Memory',
        'panel.title': 'Instruction Memory',
        'panel.subtitle': 'Saved instructions are written into the system prompt and apply to every conversation, answer, and task that follows.',
        'panel.loading': 'Loading instruction memory…',
        'panel.masterSwitch': 'Master switch',
        'status.mounted': 'Mounted into the system prompt — effective for every turn that follows ({chars} chars)',
        'status.notMountedEmpty': 'Not mounted: no enabled instructions',
        'status.notMounted': 'Not mounted',
        'err.unrecognized': 'The host returned data this panel cannot recognize',
        'err.http': 'Host returned HTTP {status}',
        'err.httpDetail': 'Host returned HTTP {status}: {detail}',
        'err.timeout': 'Host request timed out (no response for 15 s)',
        'export.failed': 'Export failed: the host returned unrecognized data',
        'import.notJson': 'The import file is not valid JSON ({detail})',
        'import.tooLarge': 'This file is about {size} MB, far beyond what this plugin can import (keep it within about {limit} MB). Make sure you selected a JSON file produced by Export.',
        'editor.new': 'New instruction',
        'editor.edit': 'Edit instruction',
        'editor.title': 'Title',
        'editor.titlePlaceholder': 'e.g. Response language',
        'editor.content': 'Instruction content',
        'editor.contentPlaceholder': 'e.g. Always answer in Simplified Chinese; ask before acting when the requirement is unclear.',
        'editor.mode': 'Effect mode',
        'editor.modeAlways': 'Always (obeyed unconditionally)',
        'editor.modeAuto': 'On demand (the model judges by relevance)',
        'editor.priority': 'Priority',
        'priority.high': 'High',
        'priority.normal': 'Normal',
        'priority.low': 'Low',
        'editor.when': 'Applicable scenarios (optional; helps the model decide when it applies)',
        'editor.whenPlaceholder': 'e.g. When writing or modifying code',
        'editor.save': 'Save',
        'editor.saving': 'Saving…',
        'editor.cancel': 'Cancel',
        'editor.hint': 'Takes effect for the next conversation turn once saved',
        'editor.needTitleOrContent': 'Fill in at least a title or the instruction content',
        'editor.confirmDiscard': 'The draft has unsaved changes. Discard them?',
        'body.expand': 'Show all',
        'body.collapse': 'Show less',
        'budget.label': 'Injection size limit (characters)',
        'budget.unitHint': 'The unit is characters, not tokens',
        'budget.rangeError': 'The limit must be between {min} and {max}',
        'budget.note': 'Characters, not tokens: with DeepSeek tokenization roughly 1 Chinese character ≈ 0.6 token (English ≈ 0.3), the {max}-character ceiling is about {tokens} tokens; actual usage depends on the model.',
        'rules.label': 'How instructions apply',
        'rules.note': '“Always” applies unconditionally; “On demand” lets the model judge by relevance. When the limit is exceeded, higher-priority entries are kept and the rest are skipped.',
        'search.placeholder': 'Search instructions: title / content / scenario ({count} in total)',
        'search.matchCount': '{shown} of {total} match',
        'action.new': '＋ New instruction',
        'action.reload': 'Reload',
        'action.export': 'Export',
        'action.import': 'Import',
        'action.showPreview': 'Show what is actually injected',
        'action.hidePreview': 'Hide injected content',
        'stats.count': '{total} in total, {active} active',
        'storage.file': 'Store file: {path}',
        'storage.noFile': '(not yet written to disk)',
        'storage.savedAt': 'Last saved: {time}',
        'storage.notSaved': 'Not yet saved to disk',
        'storage.migrated': 'Migrated from the old location: {path} (the original is kept as *.migrated)',
        'preview.label': 'What the system prompt receives on every turn',
        'preview.empty': '(no active instructions right now)',
        'list.empty': 'No instructions yet. Click “＋ New instruction” to add your first one, e.g. “Always answer in Simplified Chinese”.',
        'list.noMatch': 'No instructions match “{query}”.',
        'tag.always': 'Always',
        'tag.auto': 'On demand',
        'entry.enabled': 'Enabled',
        'entry.edit': 'Edit',
        'entry.delete': 'Delete',
        'entry.untitled': 'Untitled instruction',
        'entry.confirmDelete': 'Delete “{title}”? This cannot be undone.',
        'entry.when': 'Applies when: {when}',
        'entry.updatedAt': 'Updated {time}',
        'undo.deleted': 'Deleted “{title}”',
        'undo.restore': 'Undo delete',
        'undo.dismiss': 'Dismiss',
        'undo.restored': 'The deleted instruction was restored',
      },
    }

    /** Same placeholder semantics as the official LocaleService.interpolate. */
    function interpolate(template, params) {
      if (!params) return template
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    }

    /**
     * A translator bound to one fixed locale, straight from the built-in
     * dictionaries. Lookup chain: the locale's own entry -> the zh fallback ->
     * the key itself (a missing translation stays visible as the key, fail
     * loud like the official registry, never a blank).
     */
    function dictionaryT(locale) {
      const dict = STRINGS[locale] !== undefined ? STRINGS[locale] : STRINGS.zh
      return (key, params) => {
        const template = dict[key] !== undefined ? dict[key] : STRINGS.zh[key]
        if (template === undefined) return key
        return interpolate(template, params)
      }
    }

    /**
     * The browser's own language, matched on the primary subtag exactly like
     * the official detectBrowserLocale (`zh-Hans-CN` -> zh, `en-GB` -> en).
     * `window` is the browser test, not `navigator`: Node exposes a global
     * navigator reporting the machine's language, which must not decide the
     * locale for non-browser runs. Used only when the official locale service
     * is unavailable; resolved once (there is no UI to switch it mid-session).
     */
    function detectFallbackLocale() {
      if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'zh'
      const tags = []
      if (Array.isArray(navigator.languages)) tags.push(...navigator.languages)
      if (navigator.language) tags.push(navigator.language)
      for (const tag of tags) {
        const primary = String(tag).toLowerCase().split('-')[0]
        if (STRINGS[primary] !== undefined) return primary
      }
      return 'zh'
    }

    // The runtime context of the running apply(); kept for lazy service lookups
    // because the locale service may publish before OR after this plugin.
    let runtimeCtx = null
    // The official LocaleService once adopted; null = built-in fallback.
    let adoptedService = null
    let serviceBoundT = null
    let fallbackT = null
    const localeListeners = new Set()

    function notifyLocaleListeners() {
      for (const listener of [...localeListeners]) {
        try { listener() } catch (err) {
          // One crashed listener must not break the notification for the rest.
        }
      }
    }

    /** Subscribe to locale switches and late service adoptions. */
    function onLocaleChange(listener) {
      localeListeners.add(listener)
      return () => { localeListeners.delete(listener) }
    }

    /** The official service if it is published right now, else null. */
    function peekLocaleService(ctx) {
      const owner = ctx !== undefined && ctx !== null ? ctx : runtimeCtx
      if (owner === null) return null
      let svc = null
      try {
        if (typeof owner.get === 'function') svc = owner.get('locale') || null
        if (svc === null && owner.locale !== undefined) svc = owner.locale
      } catch (err) {
        svc = null
      }
      return svc
    }

    /**
     * Start routing t() through the official LocaleService: register our
     * dictionaries (single occupant per namespace; a re-adoption of the same
     * instance rethrows harmlessly because the first dictionaries are
     * byte-identical), subscribe to its changes, and re-render every mounted
     * panel. Idempotent; shape-checked so a hostile or alien 'locale' service
     * can never break the panel — the built-in fallback just stays in charge.
     */
    function adoptLocaleService(svc) {
      if (svc === null || typeof svc !== 'object') return false
      if (typeof svc.register !== 'function' || typeof svc.bind !== 'function' || typeof svc.subscribe !== 'function') return false
      if (adoptedService === svc) return true
      try {
        svc.register(NS, { zh: STRINGS.zh, en: STRINGS.en })
      } catch (err) {
        // The namespace is already populated — by an earlier fiber life of
        // this same plugin with identical dictionaries. Binding still works.
      }
      try {
        svc.subscribe(notifyLocaleListeners)
      } catch (err) {
        // A service without working subscriptions still translates; the panel
        // then only refreshes on remount instead of on every switch.
      }
      try {
        serviceBoundT = svc.bind(NS)
      } catch (err) {
        return false
      }
      adoptedService = svc
      notifyLocaleListeners()
      return true
    }

    /**
     * The panel's translator. Reads the ACTIVE locale at call time, so a
     * re-render is all it takes to follow a language switch.
     */
    function t(key, params) {
      if (serviceBoundT !== null) return serviceBoundT(key, params)
      if (fallbackT === null) fallbackT = dictionaryT(detectFallbackLocale())
      return fallbackT(key, params)
    }

    /* ---------------- data helpers ---------------- */

    function cloneEntry(entry) {
      return {
        id: entry.id,
        title: entry.title,
        content: entry.content,
        mode: entry.mode,
        when: entry.when,
        priority: entry.priority,
        enabled: entry.enabled,
        updatedAt: entry.updatedAt,
      }
    }

    function blankDraft() {
      return { id: '', title: '', content: '', mode: 'always', when: '', priority: 1, enabled: true, updatedAt: 0 }
    }

    /**
     * Whether the editor draft carries edits the user would lose by cancelling.
     *
     * Cancelling used to discard the draft instantly — one stray click on 取消
     * and a half-typed 6,000-character instruction was gone. Now a blank new
     * draft, or a copy of an existing entry with nothing touched, still cancels
     * silently; anything else asks first. `updatedAt` is excluded because the
     * Host stamps it on save — it is never user-typed. If the draft's base
     * entry no longer exists (deleted from another window), treat it as dirty:
     * confirming is always the safe direction.
     */
    function draftIsDirty(draft, entries) {
      const fields = ['title', 'content', 'mode', 'when', 'priority', 'enabled']
      const base = draft.id === '' ? blankDraft() : (entries || []).find((entry) => entry.id === draft.id)
      if (base === undefined) return true
      return fields.some((field) => String(draft[field]) !== String(base[field]))
    }

    /**
     * Ask before throwing the draft away. Falls back to "yes" when no dialog
     * is available (a bare webview without window.confirm): blocking the
     * cancel button entirely would be worse than the old instant discard.
     */
    function confirmDiscard() {
      return typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm(t('editor.confirmDiscard'))
        : true
    }

    /**
     * Accept both response shapes the Host can produce: the
     * `{ ok, message, snapshot }` envelope used by the mutating methods, and a
     * bare snapshot. Returns null only when no usable snapshot is present.
     */
    function normalizeResult(result) {
      if (result === null || typeof result !== 'object') return null
      const snapshot = result.snapshot !== undefined && result.snapshot !== null ? result.snapshot : result
      if (snapshot === null || typeof snapshot !== 'object' || snapshot.data === undefined) return null
      return {
        snapshot,
        ok: result.ok !== false,
        message: typeof result.message === 'string' ? result.message : '',
        conflict: result.conflict === true,
      }
    }

    /**
     * Whether two snapshots carry identical content.
     *
     * The Host pushes every persisted change to every open panel, so the window
     * that issued the command receives an SSE frame matching the POST response
     * it already absorbed. Re-absorbing would not corrupt anything, but it
     * would replace the response's message ('已保存…' / a truncation notice)
     * with the frame's empty one — the success feedback would blink out a tick
     * after appearing. An identical frame is therefore dropped instead.
     */
    function sameSnapshot(a, b) {
      return a !== null && typeof a === 'object'
        && b !== null && typeof b === 'object'
        && JSON.stringify(a) === JSON.stringify(b)
    }

    /**
     * Cheap import gate, run on the File's byte size BEFORE the file is read.
     *
     * Picking the wrong file (a log, a dataset, a lockfile — tens or hundreds
     * of MB) used to mean the whole thing was read into memory, parsed with
     * the UI frozen, uploaded, and only then refused with 413. This refuses
     * first, with numbers in the message.
     *
     * The ceiling is deliberately loose, because `maxBodyChars` counts the
     * compact request BODY in characters while `file.size` counts pretty-
     * printed FILE bytes: UTF-8 CJK is up to 3 bytes per character and an
     * export is written with 2-space indentation. A maximal store this plugin
     * exports is ≈4 MB of file; the ×4 guard (≈10 MB) can never reject it.
     * The cost of the slack is only that a slightly-too-big wrong file still
     * takes the slow 413 path. An older Host that publishes no
     * `maxBodyChars` disables the gate (the Host's own 413 still applies).
     */
    function importSizeVerdict(byteSize, maxBodyChars) {
      if (typeof byteSize !== 'number' || !Number.isFinite(byteSize) || byteSize <= 0) return { ok: true }
      if (typeof maxBodyChars !== 'number' || !(maxBodyChars > 0)) return { ok: true }
      const ceilingBytes = maxBodyChars * 4
      if (byteSize <= ceilingBytes) return { ok: true }
      const mb = (n) => Math.max(1, Math.round(n / 1048576))
      return {
        ok: false,
        message: t('import.tooLarge', { size: mb(byteSize), limit: mb(ceilingBytes) }),
      }
    }

    /**
     * What the budget input should show after a snapshot arrives.
     *
     * A push from another window used to reset budgetText unconditionally
     * inside absorb(), so editing the injection-size field while any other
     * panel saved wiped the half-typed number. While the input is focused the
     * user's draft wins; the committed value re-syncs on blur.
     */
    function nextBudgetText(currentText, incoming, focused) {
      return focused ? currentText : String(incoming)
    }

    async function callHost(method, args) {
      // A hung host used to pin the panel on 保存中… forever; fail visibly
      // after a generous timeout instead.
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller !== null ? setTimeout(() => controller.abort(), 15000) : null
      try {
        const response = await fetch(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ method, args: args === undefined ? null : args }),
          signal: controller !== null ? controller.signal : undefined,
        })
        if (!response.ok) {
          // 413/415 carry a readable reason in the JSON body. Reporting only the
          // status code left the user staring at "宿主返回 HTTP 413" with no
          // hint that the import file was simply too large.
          let detail = ''
          try {
            const body = await response.json()
            if (body !== null && typeof body === 'object' && typeof body.message === 'string') detail = body.message
          } catch (err) {
            // A non-JSON error body leaves the status code as the only clue.
          }
          throw new Error(detail === ''
            ? t('err.http', { status: response.status })
            : t('err.httpDetail', { status: response.status, detail }))
        }
        return await response.json()
      } catch (err) {
        if (controller !== null && controller.signal.aborted) throw new Error(t('err.timeout'))
        throw err
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
    }

    function EntryEditor(props) {
      const draft = props.draft
      const set = (patch) => props.onChange(Object.assign(cloneEntry(draft), patch))
      const children = [
        h('h3', { className: 'im-h', key: 'title' }, draft.id === '' ? t('editor.new') : t('editor.edit')),
        h('div', { key: 't' },
          h('label', { className: 'im-label' }, t('editor.title')),
          h('input', {
            className: 'im-input',
            value: draft.title,
            maxLength: 120,
            placeholder: t('editor.titlePlaceholder'),
            onChange: (ev) => set({ title: ev.target.value }),
          })),
        h('div', { key: 'c' },
          h('label', { className: 'im-label' }, t('editor.content')),
          h('textarea', {
            className: 'im-textarea',
            value: draft.content,
            maxLength: 6000,
            placeholder: t('editor.contentPlaceholder'),
            onChange: (ev) => set({ content: ev.target.value }),
          })),
        h('div', { className: 'im-grid2', key: 'g' },
          h('div', null,
            h('label', { className: 'im-label' }, t('editor.mode')),
            h('select', {
              className: 'im-select',
              value: draft.mode,
              onChange: (ev) => set({ mode: ev.target.value }),
            },
              h('option', { value: 'always' }, t('editor.modeAlways')),
              h('option', { value: 'auto' }, t('editor.modeAuto')))),
          h('div', null,
            h('label', { className: 'im-label' }, t('editor.priority')),
            h('select', {
              className: 'im-select',
              value: String(draft.priority),
              onChange: (ev) => set({ priority: Number(ev.target.value) }),
            },
              h('option', { value: '2' }, t('priority.high')),
              h('option', { value: '1' }, t('priority.normal')),
              h('option', { value: '0' }, t('priority.low'))))),
      ]
      if (draft.mode === 'auto') {
        children.push(h('div', { key: 'w' },
          h('label', { className: 'im-label' }, t('editor.when')),
          h('input', {
            className: 'im-input',
            value: draft.when,
            maxLength: 200,
            placeholder: t('editor.whenPlaceholder'),
            onChange: (ev) => set({ when: ev.target.value }),
          })))
      }
      children.push(h('div', { className: 'im-row-wrap', key: 'a' },
        h('button', { className: 'im-btn im-btn-primary', disabled: props.busy, onClick: props.onSave },
          props.busy ? t('editor.saving') : t('editor.save')),
        h('button', { className: 'im-btn', disabled: props.busy, onClick: props.onCancel }, t('editor.cancel')),
        h('span', { className: 'im-spacer' }),
        h('span', { className: 'im-meta' }, t('editor.hint'))))
      return h('div', { className: 'im-card' }, children)
    }

    /**
     * Entry body with an explicit 展开/收起 toggle. The collapsed cap lives in
     * CSS (max-height + overflow:hidden), so whether overflow actually happens
     * is measured from the DOM — a short body renders no toggle at all.
     */
    function EntryBody(props) {
      const bodyRef = React.useRef(null)
      const [overflowing, setOverflowing] = React.useState(false)
      const [open, setOpen] = React.useState(false)
      React.useEffect(() => {
        const el = bodyRef.current
        if (el !== null && el !== undefined) setOverflowing(el.scrollHeight > el.clientHeight + 1)
      }, [props.text])
      return h('div', null,
        h('div', { className: 'im-body' + (open ? ' im-body-open' : ''), ref: bodyRef }, props.text),
        overflowing ? h('div', { className: 'im-more', onClick: () => setOpen(!open) }, open ? t('body.collapse') : t('body.expand')) : null)
    }

    /** How long the undo bar keeps its offer alive after a confirmed delete. */
    const UNDO_TTL_MS = 10000

    function InstructionPanel() {
      const [view, setView] = React.useState(null)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [draft, setDraft] = React.useState(null)
      const [budgetText, setBudgetText] = React.useState('')
      // Latest live value of the draft, because the SSE onmessage closure below
      // is created once and must not read a stale first-render budgetText.
      const budgetTextRef = React.useRef('')
      budgetTextRef.current = budgetText
      const [showPreview, setShowPreview] = React.useState(false)
      const [query, setQuery] = React.useState('')
      const [undo, setUndo] = React.useState(null)
      const importInputRef = React.useRef(null)
      // Whether the budget input is being edited right now. A live SSE push
      // from another window must not replace the number under the cursor;
      // the ref (not state) is read inside absorb so no re-render is needed.
      const budgetFocusedRef = React.useRef(false)
      // The latest snapshot this panel has absorbed. The SSE effect runs once
      // (empty deps), so it cannot read the `view` state of a later render —
      // the ref is how its frames are compared against what is on screen.
      const viewRef = React.useRef(null)

      /**
       * Re-render on locale switches. t() reads the active locale at call
       * time, so a fresh render re-translates everything; the same tick also
       * covers a locale service adopted after this panel mounted (a runtime
       * without ctx.inject, or one that publishes the service late).
       */
      const [, bumpLocale] = React.useState(0)
      React.useEffect(() => {
        const svc = peekLocaleService()
        if (svc !== null) adoptLocaleService(svc)
        return onLocaleChange(() => bumpLocale((v) => v + 1))
      }, [])

      /**
       * The undo bar is an offer with a shelf life: it lapses on its own
       * UNDO_TTL_MS after the delete, so a stale offer never outlives the
       * deletion it refers to. The deadline is stamped into the bar state, not
       * computed here, so the countdown starts at delete time and survives
       * re-renders (including the SSE absorb of our own delete).
       */
      React.useEffect(() => {
        if (undo === null) return undefined
        const timer = setTimeout(() => setUndo(null), Math.max(0, undo.expires - Date.now()))
        return () => clearTimeout(timer)
      }, [undo])

      /**
       * The rev of the snapshot this panel is currently rendering. Sent back as
       * baseRev on every mutation so the Host can refuse a write built on a
       * stale view (another window or process changed the store in between)
       * instead of letting it overwrite blindly. Undefined against an older
       * Host whose snapshot carries no rev — JSON.stringify drops the key, so
       * the request stays byte-identical to what that Host expects.
       */
      const revOf = () => (view !== null && view.data && typeof view.data.rev === 'number' ? view.data.rev : undefined)

      function absorb(result) {
        const normalized = normalizeResult(result)
        if (normalized === null) {
          // Never fail silently: the previous version returned here, leaving the
          // panel on its loading state forever with no error to act on.
          setError(t('err.unrecognized'))
          return
        }
        setView(normalized.snapshot)
        viewRef.current = normalized.snapshot
        // Keep the user's in-progress budget edit when a push arrives while
        // the input is focused; re-sync only once editing is not active. The
        // ref is the live draft — absorb may run from the SSE closure created
        // on the first render.
        setBudgetText(nextBudgetText(budgetTextRef.current, normalized.snapshot.data.budgetChars, budgetFocusedRef.current))
        if (!normalized.ok && normalized.message) {
          setError(normalized.message)
          setNotice('')
        } else {
          setError('')
          setNotice(normalized.message)
        }
      }

      async function send(method, args) {
        setBusy(true)
        try {
          const result = await callHost(method, args)
          absorb(result)
          return result
        } catch (err) {
          setError(String(err && err.message ? err.message : err))
          return null
        } finally {
          setBusy(false)
        }
      }

      async function doExport() {
        try {
          const result = await callHost('export-data', null)
          if (result === null || typeof result !== 'object' || result.export === undefined || result.export === null) {
            setError(t('export.failed'))
            return
          }
          const blob = new Blob([JSON.stringify(result.export, null, 2) + '\n'], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = url
          link.download = 'dsh-instruction-memory-' + new Date().toISOString().slice(0, 10) + '.json'
          document.body.appendChild(link)
          link.click()
          if (link.parentNode !== null) link.parentNode.removeChild(link)
          setTimeout(() => { URL.revokeObjectURL(url) }, 1000)
        } catch (err) {
          setError(String(err && err.message ? err.message : err))
        }
      }

      async function handleImportFile(file) {
        try {
          const verdict = importSizeVerdict(
            file && typeof file.size === 'number' ? file.size : NaN,
            view !== null && view.limits ? view.limits.maxBodyChars : undefined,
          )
          if (!verdict.ok) {
            setError(verdict.message)
            return
          }
          const text = typeof file.text === 'function'
            ? await file.text()
            : await new Promise((resolve, reject) => {
              const reader = new FileReader()
              reader.onload = () => resolve(String(reader.result))
              reader.onerror = () => reject(reader.error)
              reader.readAsText(file)
            })
          let payload
          try {
            payload = JSON.parse(text)
          } catch (err) {
            setError(t('import.notJson', { detail: String(err && err.message ? err.message : err) }))
            return
          }
          await send('import-data', { payload, baseRev: revOf() })
        } catch (err) {
          setError(String(err && err.message ? err.message : err))
        }
      }

      React.useEffect(() => {
        let alive = true
        callHost('state', null).then(
          (result) => { if (alive) absorb(result) },
          (err) => { if (alive) setError(String(err && err.message ? err.message : err)) },
        )
        return () => { alive = false }
      }, [])

      /**
       * Live updates: the Host streams a fresh snapshot over SSE whenever the
       * store changes underneath this panel — another window on the same host,
       * another process sharing the file, or a hand-edited memory.json. Our
       * own writes come back the same way; sameSnapshot drops that echo so a
       * just-shown success notice survives. EventSource reconnects by itself
       * (the Host asks for a 5s retry), and without it the panel still works
       * off 重新载入 — a dead stream degrades to manual refresh, never to an
       * error the user has to dismiss.
       */
      React.useEffect(() => {
        if (typeof EventSource !== 'function') return
        const source = new EventSource(API)
        source.onmessage = (ev) => {
          try {
            const pushed = JSON.parse(ev.data)
            if (sameSnapshot(pushed, viewRef.current)) return
            absorb(pushed)
          } catch {
            // A malformed frame is dropped; the next frame, or 重新载入, catches up.
          }
        }
        return () => { source.close() }
      }, [])

      if (view === null) {
        return h('div', { className: 'im-root' },
          h('div', { className: 'im-empty' }, error === '' ? t('panel.loading') : error))
      }

      if (draft !== null) {
        return h('div', { className: 'im-root' },
          h(EntryEditor, {
            draft,
            busy,
            onChange: setDraft,
            onCancel: () => {
              if (draftIsDirty(draft, view.data.entries) && !confirmDiscard()) return
              setDraft(null); setError('')
            },
            onSave: () => {
              if (draft.title.trim() === '' && draft.content.trim() === '') {
                setError(t('editor.needTitleOrContent'))
                return
              }
              send('save-entry', { entry: draft, baseRev: revOf() }).then((result) => {
                if (result && result.ok === true) { setDraft(null); setError('') }
              })
            },
          }))
      }

      const data = view.data
      // Older hosts can hand over snapshots without storage/limits; fall back
      // instead of throwing mid-render.
      const storage = view.storage || {}
      const limits = view.limits || { minBudget: 800, maxBudget: 40000, maxEntries: 200 }
      const injection = view.injection || { registered: false, chars: 0, error: null }
      const entries = data.entries.slice().sort((a, b) => (b.priority - a.priority) || (b.updatedAt - a.updatedAt))
      const activeCount = entries.filter((e) => e.enabled && e.content !== '').length
      const keyword = query.trim().toLowerCase()
      const visible = keyword === ''
        ? entries
        : entries.filter((entry) =>
          entry.title.toLowerCase().indexOf(keyword) !== -1
          || entry.content.toLowerCase().indexOf(keyword) !== -1
          || entry.when.toLowerCase().indexOf(keyword) !== -1)

      const dotClass = injection.error
        ? 'im-dot im-dot-err'
        : (injection.registered ? 'im-dot im-dot-on' : 'im-dot im-dot-off')
      const dotText = injection.error
        ? injection.error
        : (injection.registered
          ? t('status.mounted', { chars: injection.chars })
          : (activeCount === 0 ? t('status.notMountedEmpty') : t('status.notMounted')))

      const header = h('div', { className: 'im-card', key: 'head' },
        h('div', { className: 'im-row' },
          h('div', null,
            h('h3', { className: 'im-h' }, t('panel.title')),
            h('p', { className: 'im-sub' }, t('panel.subtitle'))),
          h('label', { className: 'im-switch' },
            h('input', {
              type: 'checkbox',
              checked: data.enabled === true,
              disabled: busy,
              onChange: () => send('set-options', { enabled: !data.enabled, baseRev: revOf() }),
            }),
            t('panel.masterSwitch'))),
        h('div', { className: 'im-status' },
          h('span', { className: dotClass }),
          h('span', { className: injection.error ? 'im-err' : 'im-meta' }, dotText)),
        h('div', { className: 'im-grid2' },
          h('div', null,
            h('label', { className: 'im-label' }, t('budget.label')),
            h('input', {
              className: 'im-input',
              type: 'number',
              min: limits.minBudget,
              max: limits.maxBudget,
              step: 100,
              value: budgetText,
              disabled: busy,
              title: t('budget.unitHint'),
              onFocus: () => { budgetFocusedRef.current = true },
              onChange: (ev) => setBudgetText(ev.target.value),
              onBlur: () => {
                // Editing is over: later pushes may sync the field again.
                budgetFocusedRef.current = false
                const parsed = Number(budgetText)
                if (!Number.isFinite(parsed) || parsed < limits.minBudget || parsed > limits.maxBudget) {
                  setBudgetText(String(data.budgetChars))
                  setError(t('budget.rangeError', { min: limits.minBudget, max: limits.maxBudget }))
                  return
                }
                send('set-options', { budgetChars: parsed, baseRev: revOf() })
              },
            }),
            h('div', { className: 'im-meta' },
              t('budget.note', { max: limits.maxBudget, tokens: Math.round(limits.maxBudget * 0.6) }))),
          h('div', null,
            h('label', { className: 'im-label' }, t('rules.label')),
            h('div', { className: 'im-meta' },
              t('rules.note')))),
        entries.length > 0 ? h('div', { key: 'search' },
          h('input', {
            className: 'im-input',
            value: query,
            placeholder: t('search.placeholder', { count: entries.length }),
            onChange: (ev) => setQuery(ev.target.value),
          }),
          query.trim() !== '' ? h('div', { className: 'im-meta im-search-meta' }, t('search.matchCount', { shown: visible.length, total: entries.length })) : null) : null,
        h('div', { className: 'im-row-wrap' },
          h('button', {
            className: 'im-btn im-btn-primary',
            disabled: busy,
            onClick: () => { setDraft(blankDraft()); setError('') },
          }, t('action.new')),
          h('button', { className: 'im-btn', disabled: busy, onClick: () => send('reload', null) }, t('action.reload')),
          h('button', { className: 'im-btn', disabled: busy, onClick: doExport }, t('action.export')),
          h('button', {
            className: 'im-btn',
            disabled: busy,
            onClick: () => {
              const el = importInputRef.current
              if (el !== null && el !== undefined) el.click()
            },
          }, t('action.import')),
          h('button', {
            className: 'im-btn',
            disabled: busy,
            onClick: () => setShowPreview(!showPreview),
          }, showPreview ? t('action.hidePreview') : t('action.showPreview')),
          h('span', { className: 'im-spacer' }),
          h('span', { className: 'im-meta' }, t('stats.count', { total: entries.length, active: activeCount }))),
        h('div', { className: 'im-divider' }),
        h('div', { className: 'im-meta' },
          storage.path ? t('storage.file', { path: storage.path }) : t('storage.noFile')),
        h('div', { className: 'im-meta' },
          storage.savedAt ? t('storage.savedAt', { time: new Date(storage.savedAt).toLocaleString() }) : t('storage.notSaved')),
        storage.migratedFrom
          ? h('div', { className: 'im-ok' }, t('storage.migrated', { path: storage.migratedFrom }))
          : null,
        storage.warning ? h('div', { className: 'im-warn' }, storage.warning) : null,
        error !== '' ? h('div', { className: 'im-err' }, error) : null,
        error === '' && notice !== '' ? h('div', { className: 'im-ok' }, notice) : null,
        error === '' && notice === '' && storage.error ? h('div', { className: 'im-err' }, storage.error) : null,
        undo !== null ? h('div', { className: 'im-undo', key: 'undo' },
          h('span', null, t('undo.deleted', { title: undo.entry.title !== '' ? undo.entry.title : t('entry.untitled') })),
          h('button', { disabled: busy, onClick: () => {
            const entry = cloneEntry(undo.entry)
            send('save-entry', { entry, baseRev: revOf() }).then((result) => {
              if (result === null || result.ok !== true) {
                // A failed restore must not eat the offer: re-arm the bar so
                // the user can retry. absorb() has already pulled in the
                // winning snapshot, so the next click sends its fresh rev.
                setUndo({ entry, expires: Date.now() + UNDO_TTL_MS })
                return
              }
              setUndo(null)
              setNotice(t('undo.restored'))
            })
          } }, t('undo.restore')),
          h('button', { className: 'im-btn', disabled: busy, onClick: () => setUndo(null) }, t('undo.dismiss'))) : null,
        showPreview ? h('div', null,
          h('label', { className: 'im-label' }, t('preview.label')),
          h('pre', { className: 'im-pre' }, view.preview === '' ? t('preview.empty') : view.preview)) : null,
        h('input', {
          key: 'import-input',
          type: 'file',
          accept: '.json,application/json',
          style: { display: 'none' },
          ref: importInputRef,
          onChange: (ev) => {
            const file = ev.target.files && ev.target.files.length > 0 ? ev.target.files[0] : null
            ev.target.value = ''
            if (file !== null) void handleImportFile(file)
          },
        }))

      const items = visible.map((entry) => {
        const tags = [
          h('span', {
            className: 'im-tag ' + (entry.mode === 'always' ? 'im-tag-always' : 'im-tag-auto'),
            key: 'mode',
          }, entry.mode === 'always' ? t('tag.always') : t('tag.auto')),
        ]
        if (entry.priority === 2) tags.push(h('span', { className: 'im-tag im-tag-high', key: 'p' }, t('priority.high')))
        else if (entry.priority === 0) tags.push(h('span', { className: 'im-tag', key: 'p' }, t('priority.low')))
        return h('div', {
          className: 'im-item' + (entry.enabled ? '' : ' im-item-off'),
          key: entry.id,
        },
          h('div', { className: 'im-item-head' },
            h('span', { className: 'im-title' }, entry.title),
            tags,
            h('span', { className: 'im-spacer' }),
            h('label', { className: 'im-switch' },
              h('input', {
                type: 'checkbox',
                checked: entry.enabled === true,
                disabled: busy,
                onChange: () => {
                  const next = cloneEntry(entry)
                  next.enabled = !entry.enabled
                  send('save-entry', { entry: next, baseRev: revOf() })
                },
              }),
              t('entry.enabled')),
            h('button', {
              className: 'im-btn',
              disabled: busy,
              onClick: () => { setDraft(cloneEntry(entry)); setError('') },
            }, t('entry.edit')),
            h('button', {
              className: 'im-btn im-btn-danger',
              disabled: busy,
              onClick: () => {
                // confirm() is standard DOM, guarded anyway: if the embedded
                // shell omits it, deletion proceeds rather than breaking.
                if (typeof window.confirm === 'function'
                  && !window.confirm(t('entry.confirmDelete', {
                    title: entry.title !== '' ? entry.title : t('entry.untitled'),
                  }))) return
                // Keep the full entry for the undo bar; the POST response
                // (not this closure) is what confirms the deletion happened.
                setUndo(null)
                send('delete-entry', { id: entry.id, baseRev: revOf() }).then((result) => {
                  if (result === null || result.ok !== true) return
                  setUndo({ entry, expires: Date.now() + UNDO_TTL_MS })
                })
              },
            }, t('entry.delete'))),
          h(EntryBody, { text: entry.content, key: 'body' }),
          entry.mode === 'auto' && entry.when !== ''
            ? h('div', { className: 'im-meta' }, t('entry.when', { when: entry.when }))
            : null,
          // The Host stamps updatedAt on every save; entries imported from an
          // old export (or predating the field) carry 0/undefined and show
          // nothing rather than a 1970-01-01.
          entry.updatedAt > 0
            ? h('div', { className: 'im-meta' }, t('entry.updatedAt', { time: new Date(entry.updatedAt).toLocaleString() }))
            : null)
      })

      const list = entries.length === 0
        ? h('div', { className: 'im-empty', key: 'empty' },
          t('list.empty'))
        : visible.length === 0
          ? h('div', { className: 'im-empty', key: 'no-match' }, t('list.noMatch', { query: query.trim() }))
          : h('div', { className: 'im-list', key: 'list' }, items)

      return h('div', { className: 'im-root' }, header, list)
    }

    function apply(ctx) {
      // Kept for lazy service lookups: the official locale service may be
      // published before or after this plugin activates.
      runtimeCtx = ctx
      // `slots` is a declared injection (see exports.inject below), so the
      // runtime holds this plugin until the slot service exists. The fallback
      // covers a runtime that resolves injections lazily instead.
      const slots = ctx.slots !== undefined ? ctx.slots : ctx.get('slots')
      if (slots === undefined) {
        console.error('[instruction-memory] slots service unavailable; settings page not registered')
        return
      }

      // Own stylesheet: one <style> element created and removed with this fiber.
      const styleEl = document.createElement('style')
      styleEl.setAttribute('data-dsh-plugin', 'instruction-memory')
      styleEl.textContent = CSS
      document.head.appendChild(styleEl)
      ctx.effect(() => () => {
        if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl)
      })

      // Locale adoption, path 1: a child fiber that runs as soon as (and as
      // long as) the official locale service exists — covering hosts where the
      // service publishes after this plugin activates. Hosts without the
      // service, or runtimes without ctx.inject, never run this; the built-in
      // fallback dictionaries keep the panel working either way.
      if (typeof ctx.inject === 'function') {
        try {
          ctx.inject(['locale'], (localeCtx) => {
            adoptLocaleService(peekLocaleService(localeCtx))
          })
        } catch (err) {
          // An exotic runtime: stay on the built-in fallback dictionaries.
        }
      }

      ctx.effect(() => slots.inject('settings.section', () => {
        // Path 2: this factory runs when the settings shell activates the
        // slot; the shell itself declares the locale service as a dependency,
        // so on a locale-aware host the service is already published by now.
        const svc = peekLocaleService()
        if (svc !== null) adoptLocaleService(svc)
        return slots.register(
          // `order` 1200 deliberately sits far above every official section
          // (general 0, models 10, plugins 15, agent-presets 20, archived-
          // sessions 25) and above the third-party ones in the wild (mnemon 20,
          // pet 30, market 40, prompt-optimizer 90, better-sidebar 100,
          // version-update 140). `settings.section` is a `list` slot, so a
          // duplicate order does not throw — it silently makes the render order
          // depend on registration timing. The previous value was 26, one above
          // the official tail: a single new official section would have collided.
          //
          // The label: with the official locale service a FUNCTION label is
          // re-evaluated by the locale-aware shell on every language switch
          // (resolveSlotLabel), so the nav entry follows the Language setting
          // live. Without the service (pre-locale hosts) it must stay a plain
          // string — those shells render options.label directly and a function
          // would crash their nav.
          {
            name: 'settings.section',
            id: 'instruction-memory',
            order: 1200,
            label: svc !== null ? () => t('section.label') : t('section.label'),
            locale: NS,
          },
          () => h(InstructionPanel, null),
        )
      }))
    }

    exports.name = 'instruction-memory'
    // Without this the runtime calls apply() immediately, before the slot
    // service is published, and the settings page silently never registers.
    exports.inject = ['slots']
    exports.apply = apply
    // Exposed for the contract test in verify.mjs.
    exports.__normalizeResult = normalizeResult
    exports.__draftIsDirty = draftIsDirty
    exports.__sameSnapshot = sameSnapshot
    exports.__confirmDiscard = confirmDiscard
    exports.__importSizeVerdict = importSizeVerdict
    exports.__nextBudgetText = nextBudgetText
    exports.__strings = STRINGS
    exports.__ns = NS
    exports.__dictionaryT = dictionaryT
    exports.__undoTtlMs = UNDO_TTL_MS
    return module.exports
  },
})
