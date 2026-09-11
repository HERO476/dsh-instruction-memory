/**
 * dsh-instruction-memory — Client half.
 *
 * Hand-authored in the browser module-loader format the web shell expects
 * (`window.__ModuleLoader__.load` + `require`), so the package needs no build
 * step. Contributes one settings page; all data lives host-side and is reached
 * through the same-origin route the Host half registers.
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
@media (max-width:640px) { .im-grid2 { grid-template-columns:1fr; } }
`

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
      }
    }

    async function callHost(method, args) {
      const response = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, args: args === undefined ? null : args }),
      })
      if (!response.ok) throw new Error('宿主返回 HTTP ' + response.status)
      return await response.json()
    }

    function EntryEditor(props) {
      const draft = props.draft
      const set = (patch) => props.onChange(Object.assign(cloneEntry(draft), patch))
      const children = [
        h('h3', { className: 'im-h', key: 'title' }, draft.id === '' ? '新增指令' : '编辑指令'),
        h('div', { key: 't' },
          h('label', { className: 'im-label' }, '标题'),
          h('input', {
            className: 'im-input',
            value: draft.title,
            placeholder: '例如：回答语言',
            onChange: (ev) => set({ title: ev.target.value }),
          })),
        h('div', { key: 'c' },
          h('label', { className: 'im-label' }, '指令内容'),
          h('textarea', {
            className: 'im-textarea',
            value: draft.content,
            placeholder: '例如：所有回答使用简体中文；不确定需求时先提问再动手。',
            onChange: (ev) => set({ content: ev.target.value }),
          })),
        h('div', { className: 'im-grid2', key: 'g' },
          h('div', null,
            h('label', { className: 'im-label' }, '生效方式'),
            h('select', {
              className: 'im-select',
              value: draft.mode,
              onChange: (ev) => set({ mode: ev.target.value }),
            },
              h('option', { value: 'always' }, '始终生效（无条件遵守）'),
              h('option', { value: 'auto' }, '按需生效（按相关性自动判断）'))),
          h('div', null,
            h('label', { className: 'im-label' }, '优先级'),
            h('select', {
              className: 'im-select',
              value: String(draft.priority),
              onChange: (ev) => set({ priority: Number(ev.target.value) }),
            },
              h('option', { value: '2' }, '高'),
              h('option', { value: '1' }, '普通'),
              h('option', { value: '0' }, '低')))),
      ]
      if (draft.mode === 'auto') {
        children.push(h('div', { key: 'w' },
          h('label', { className: 'im-label' }, '适用场景（可选，帮助模型判断何时生效）'),
          h('input', {
            className: 'im-input',
            value: draft.when,
            placeholder: '例如：编写或修改代码时',
            onChange: (ev) => set({ when: ev.target.value }),
          })))
      }
      children.push(h('div', { className: 'im-row-wrap', key: 'a' },
        h('button', { className: 'im-btn im-btn-primary', disabled: props.busy, onClick: props.onSave },
          props.busy ? '保存中…' : '保存'),
        h('button', { className: 'im-btn', disabled: props.busy, onClick: props.onCancel }, '取消'),
        h('span', { className: 'im-spacer' }),
        h('span', { className: 'im-meta' }, '保存后对下一轮对话立即生效')))
      return h('div', { className: 'im-card' }, children)
    }

    function InstructionPanel() {
      const [view, setView] = React.useState(null)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [draft, setDraft] = React.useState(null)
      const [budgetText, setBudgetText] = React.useState('')
      const [showPreview, setShowPreview] = React.useState(false)

      function absorb(result) {
        const normalized = normalizeResult(result)
        if (normalized === null) {
          // Never fail silently: the previous version returned here, leaving the
          // panel on its loading state forever with no error to act on.
          setError('宿主返回了无法识别的数据')
          return
        }
        setView(normalized.snapshot)
        setBudgetText(String(normalized.snapshot.data.budgetChars))
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

      React.useEffect(() => {
        let alive = true
        callHost('state', null).then(
          (result) => { if (alive) absorb(result) },
          (err) => { if (alive) setError(String(err && err.message ? err.message : err)) },
        )
        return () => { alive = false }
      }, [])

      if (view === null) {
        return h('div', { className: 'im-root' },
          h('div', { className: 'im-empty' }, error === '' ? '正在读取指令记忆…' : error))
      }

      if (draft !== null) {
        return h('div', { className: 'im-root' },
          h(EntryEditor, {
            draft,
            busy,
            onChange: setDraft,
            onCancel: () => { setDraft(null); setError('') },
            onSave: () => {
              if (draft.title.trim() === '' && draft.content.trim() === '') {
                setError('请至少填写标题或指令内容')
                return
              }
              send('save-entry', { entry: draft }).then((result) => {
                if (result && result.ok === true) { setDraft(null); setError('') }
              })
            },
          }))
      }

      const data = view.data
      const storage = view.storage
      const injection = view.injection || { registered: false, chars: 0, error: null }
      const entries = data.entries.slice().sort((a, b) => (b.priority - a.priority) || (b.updatedAt - a.updatedAt))
      const activeCount = entries.filter((e) => e.enabled && e.content !== '').length

      const dotClass = injection.error
        ? 'im-dot im-dot-err'
        : (injection.registered ? 'im-dot im-dot-on' : 'im-dot im-dot-off')
      const dotText = injection.error
        ? injection.error
        : (injection.registered
          ? '已挂载到系统提示词——后续每轮对话自动生效（' + injection.chars + ' 字符）'
          : (activeCount === 0 ? '未挂载：当前没有启用中的指令' : '未挂载'))

      const header = h('div', { className: 'im-card', key: 'head' },
        h('div', { className: 'im-row' },
          h('div', null,
            h('h3', { className: 'im-h' }, '指令记忆'),
            h('p', { className: 'im-sub' }, '保存后自动写入系统提示词，对此后所有对话、问答与任务执行生效。')),
          h('label', { className: 'im-switch' },
            h('input', {
              type: 'checkbox',
              checked: data.enabled === true,
              disabled: busy,
              onChange: () => send('set-options', { enabled: !data.enabled }),
            }),
            '总开关')),
        h('div', { className: 'im-status' },
          h('span', { className: dotClass }),
          h('span', { className: injection.error ? 'im-err' : 'im-meta' }, dotText)),
        h('div', { className: 'im-grid2' },
          h('div', null,
            h('label', { className: 'im-label' }, '注入字数上限'),
            h('input', {
              className: 'im-input',
              type: 'number',
              min: view.limits.minBudget,
              max: view.limits.maxBudget,
              step: 100,
              value: budgetText,
              disabled: busy,
              onChange: (ev) => setBudgetText(ev.target.value),
              onBlur: () => {
                const parsed = Number(budgetText)
                if (!Number.isFinite(parsed) || parsed < view.limits.minBudget || parsed > view.limits.maxBudget) {
                  setBudgetText(String(data.budgetChars))
                  setError('上限需在 ' + view.limits.minBudget + ' ~ ' + view.limits.maxBudget + ' 之间')
                  return
                }
                send('set-options', { budgetChars: parsed })
              },
            })),
          h('div', null,
            h('label', { className: 'im-label' }, '生效规则'),
            h('div', { className: 'im-meta' },
              '「始终」无条件生效；「按需」由模型按相关性自动判断。超出上限时按优先级保留，其余暂不注入。'))),
        h('div', { className: 'im-row-wrap' },
          h('button', {
            className: 'im-btn im-btn-primary',
            disabled: busy,
            onClick: () => { setDraft(blankDraft()); setError('') },
          }, '＋ 新增指令'),
          h('button', { className: 'im-btn', disabled: busy, onClick: () => send('reload', null) }, '重新载入'),
          h('button', {
            className: 'im-btn',
            disabled: busy,
            onClick: () => setShowPreview(!showPreview),
          }, showPreview ? '收起注入内容' : '查看实际注入内容'),
          h('span', { className: 'im-spacer' }),
          h('span', { className: 'im-meta' }, '共 ' + entries.length + ' 条，生效 ' + activeCount + ' 条')),
        h('div', { className: 'im-divider' }),
        h('div', { className: 'im-meta' }, '存储文件：' + (storage.path ? storage.path : '（未写入磁盘）')),
        h('div', { className: 'im-meta' },
          storage.savedAt ? '最近保存：' + new Date(storage.savedAt).toLocaleString() : '尚未保存到磁盘'),
        storage.migratedFrom
          ? h('div', { className: 'im-ok' }, '已从旧位置迁移：' + storage.migratedFrom + '（原文件保留为 *.migrated）')
          : null,
        error !== '' ? h('div', { className: 'im-err' }, error) : null,
        error === '' && notice !== '' ? h('div', { className: 'im-ok' }, notice) : null,
        error === '' && notice === '' && storage.error ? h('div', { className: 'im-err' }, storage.error) : null,
        showPreview ? h('div', null,
          h('label', { className: 'im-label' }, '当前注入到每轮系统提示词的内容'),
          h('pre', { className: 'im-pre' }, view.preview === '' ? '（当前没有生效中的指令）' : view.preview)) : null)

      const items = entries.map((entry) => {
        const tags = [
          h('span', {
            className: 'im-tag ' + (entry.mode === 'always' ? 'im-tag-always' : 'im-tag-auto'),
            key: 'mode',
          }, entry.mode === 'always' ? '始终' : '按需'),
        ]
        if (entry.priority === 2) tags.push(h('span', { className: 'im-tag im-tag-high', key: 'p' }, '高'))
        else if (entry.priority === 0) tags.push(h('span', { className: 'im-tag', key: 'p' }, '低'))
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
                  send('save-entry', { entry: next })
                },
              }),
              '启用'),
            h('button', {
              className: 'im-btn',
              disabled: busy,
              onClick: () => { setDraft(cloneEntry(entry)); setError('') },
            }, '编辑'),
            h('button', {
              className: 'im-btn im-btn-danger',
              disabled: busy,
              onClick: () => send('delete-entry', { id: entry.id }),
            }, '删除')),
          h('div', { className: 'im-body' }, entry.content),
          entry.mode === 'auto' && entry.when !== ''
            ? h('div', { className: 'im-meta' }, '适用场景：' + entry.when)
            : null)
      })

      const list = entries.length === 0
        ? h('div', { className: 'im-empty', key: 'empty' },
          '还没有指令记忆。点击「＋ 新增指令」添加第一条，例如“所有回答使用简体中文”。')
        : h('div', { className: 'im-list', key: 'list' }, items)

      return h('div', { className: 'im-root' }, header, list)
    }

    function apply(ctx) {
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

      ctx.effect(() => slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'instruction-memory', order: 26, label: '指令记忆' },
        () => h(InstructionPanel, null),
      )))
    }

    exports.name = 'instruction-memory'
    // Without this the runtime calls apply() immediately, before the slot
    // service is published, and the settings page silently never registers.
    exports.inject = ['slots']
    exports.apply = apply
    // Exposed for the contract test in verify.mjs.
    exports.__normalizeResult = normalizeResult
    return module.exports
  },
})
