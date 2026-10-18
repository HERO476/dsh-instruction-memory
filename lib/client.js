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

    // Feedback form: the kinds are a closed set shared with the Host (see
    // lib/mailer.js); the ceilings repeat the Host defaults so an older Host
    // that does not publish limits.maxFeedback* still renders a safe form.
    const FEEDBACK_TYPES = ['bug', 'suggestion', 'other']
    const FEEDBACK_DEFAULTS = Object.freeze({ maxTitle: 120, maxBody: 4000, maxContact: 200 })

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
.im-tag-off { color:var(--dsw-alias-state-warn-primary,#d97706); border-color:currentColor; }
.im-tag-cut { color:var(--dsw-alias-state-error-primary,#d94838); border-color:currentColor; }
.im-meter { height:6px; border-radius:999px; overflow:hidden;
  background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.08)); }
.im-meter-fill { height:100%; border-radius:999px; background:var(--dsw-alias-brand-primary,#3b6cff); }
.im-meter-fill-warn { background:var(--dsw-alias-state-warn-primary,#d97706); }
.im-entry-tags { display:flex; flex-wrap:wrap; gap:4px; }
.im-chip { display:inline-flex; align-items:center; gap:3px; padding:1px 4px 1px 9px; border-radius:999px; font-size:11px;
  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.14)); color:var(--dsw-alias-label-secondary,#6b7280);
  background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03)); white-space:nowrap; }
.im-chip-x { border:none; background:transparent; color:inherit; cursor:pointer; font-size:13px; line-height:1;
  padding:0 5px; border-radius:999px; }
.im-chip-x:hover:not(:disabled) { background:rgba(0,0,0,.08); }
.im-filter-row { display:flex; flex-direction:column; gap:7px; }
.im-filter-chips { display:flex; flex-wrap:wrap; gap:6px; }
.im-filter-chip { border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.18)); background:var(--dsw-alias-bg-layer-1,#fff);
  color:inherit; border-radius:999px; padding:2px 11px; font-size:11.5px; font-family:inherit; cursor:pointer; }
.im-filter-chip-on { background:var(--dsw-alias-brand-primary,#3b6cff); border-color:transparent; color:#fff; }
.im-filter-selects { display:flex; flex-wrap:wrap; gap:12px; }
.im-fselect { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--dsw-alias-label-secondary,#8a9099); }
.im-select-sm { padding:3px 6px; font-size:12px; border-radius:7px; border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.18));
  background:var(--dsw-alias-bg-base,#fff); color:inherit; }
.im-batch-bar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:10px 12px; border-radius:10px;
  border:1px solid var(--dsw-alias-state-warn-primary,#d97706); background:rgba(217,119,6,.08); }
.im-batch-check { width:15px; height:15px; margin:0; cursor:pointer; accent-color:var(--dsw-alias-brand-primary,#3b6cff); }
.im-profiles { border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1)); border-radius:10px; padding:10px 12px;
  background:var(--dsw-alias-bg-layer-1,#fff); }
.im-profiles-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.im-profile-item { border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1)); border-radius:9px; padding:9px 11px;
  margin-top:8px; background:var(--dsw-alias-bg-base,#fff); }
.im-profile-item-off { opacity:.55; }
.im-profile-name { font-weight:600; font-size:13.5px; }
.im-profile-sub { margin-top:3px; }
.im-section-title { font-weight:600; font-size:13px; }
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
.im-meter-line { margin-top:5px; }
.im-undo { display:flex; align-items:center; gap:10px; padding:9px 13px; border-radius:8px; font-size:12px;
  border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14)); background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04)); }
.im-undo button { border:1px solid var(--dsw-alias-brand-primary,#3b6cff); color:var(--dsw-alias-brand-primary,#3b6cff);
  background:transparent; border-radius:7px; padding:2px 10px; font-size:12px; font-family:inherit; cursor:pointer; }
/* ---- F13 配置集 ---- */
.im-sets { display:flex; flex-direction:column; gap:7px; padding:10px 12px; border-radius:10px;
  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1)); background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03)); }
.im-sets-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.im-select-set { max-width:220px; }
.im-active-dot { width:7px; height:7px; border-radius:50%; flex:none; background:var(--dsw-alias-brand-primary,#3b6cff); }
.im-inline-form { display:flex; align-items:center; gap:8px; flex-wrap:wrap;
  padding:8px 10px; border-radius:8px; background:var(--dsw-alias-bg-base,#fff);
  border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.18)); }
.im-inline-form .im-input { flex:1; min-width:140px; }
/* ---- F14 版本历史 ---- */
.im-history { border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1)); border-radius:10px; padding:10px 12px;
  background:var(--dsw-alias-bg-layer-1,#fff); }
.im-history-item { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:7px 9px; margin-top:7px;
  border-radius:8px; border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1)); background:var(--dsw-alias-bg-base,#fff); }
.im-history-item-current { border-color:var(--dsw-alias-brand-primary,#3b6cff); }
.im-history-sub { font-size:11.5px; color:var(--dsw-alias-label-secondary,#8a9099); }
.im-list-scroll { max-height:260px; overflow:auto; }
/* ---- F16 源码模式 ---- */
.im-source { display:flex; flex-direction:column; gap:8px; }
.im-textarea-source { min-height:340px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:11.5px; line-height:1.6; white-space:pre; }
.im-source-ok { font-size:12px; color:var(--dsw-alias-state-success-primary,#18a058); }
/* ---- F17 本地预演 ---- */
.im-sim-result { display:flex; flex-direction:column; gap:6px; margin-top:6px; }
.im-sim-item { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:6px 9px; border-radius:8px;
  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1)); background:var(--dsw-alias-bg-base,#fff); }
.im-sim-note { font-size:11.5px; color:var(--dsw-alias-label-secondary,#8a9099); }
.im-tag-sim-high { color:var(--dsw-alias-state-error-primary,#d94838); border-color:currentColor; }
.im-tag-sim-mid { color:var(--dsw-alias-state-warn-primary,#d97706); border-color:currentColor; }
.im-tag-sim-low { color:var(--dsw-alias-label-secondary,#8a9099); border-color:currentColor; }
/* ---- F18 备份位置 ---- */
.im-backup { display:flex; flex-direction:column; gap:8px; }
.im-backup-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.im-backup-row .im-input { flex:1; min-width:200px; }
/* ---- F12 诊断与安全状态 ---- */
.im-hostwarn { display:flex; gap:8px; align-items:flex-start; padding:9px 12px; border-radius:8px; font-size:12px;
  color:var(--dsw-alias-state-warn-primary,#d97706); border:1px solid var(--dsw-alias-state-warn-primary,#d97706);
  background:var(--dsw-alias-state-warn-bg,rgba(217,119,6,.12)); font-weight:500; }
.im-diag { display:flex; flex-direction:column; gap:8px; }
.im-diag-group { display:flex; flex-direction:column; gap:3px; padding:8px 10px; border-radius:8px;
  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1)); background:var(--dsw-alias-bg-base,#fff); }
.im-diag-sub { color:var(--dsw-alias-label-secondary,#8a9099); font-size:11.5px; }
.im-diag-fallback { display:flex; flex-direction:column; gap:5px; }
.im-diag-fallback .im-textarea { min-height:170px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:11px; }
/* ---- F7 临时静音 ---- */
.im-master-col { display:flex; flex-direction:column; align-items:flex-end; gap:6px; }
.im-pause-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; justify-content:flex-end; }
.im-pause-menu { display:flex; flex-direction:column; gap:4px; padding:8px 10px; border-radius:8px;
  border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.18)); background:var(--dsw-alias-bg-base,#fff);
  box-shadow:0 4px 14px rgba(0,0,0,.1); }
.im-pause-bar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; justify-content:flex-end;
  padding:6px 10px; border-radius:8px; font-size:12px;
  border:1px solid var(--dsw-alias-state-warn-primary,#d97706);
  background:var(--dsw-alias-state-warn-bg,rgba(217,119,6,.12)); color:var(--dsw-alias-state-warn-primary,#d97706); }
/* ---- 反馈邮件 ---- */
.im-feedback { display:flex; flex-direction:column; gap:8px; }
.im-feedback-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.im-feedback-head .im-section-title { flex:1; }
.im-feedback-form { display:flex; flex-direction:column; gap:8px; padding:10px 12px; border-radius:8px;
  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1)); background:var(--dsw-alias-bg-base,#fff); }
.im-feedback-form .im-textarea { min-height:110px; }
.im-feedback-hint { font-size:11.5px; color:var(--dsw-alias-label-secondary,#8a9099); }
.im-feedback-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.im-feedback-actions .im-meta { flex:1; }
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
        'budget.used': '实际注入 {used} / {budget} 字符（约 {tokens} token，估算）',
        'budget.omitted': '有 {count} 条生效指令因超出上限本轮未注入，可调高上限或调整优先级',
        'tag.omitted': '本轮不注入',
        'tag.truncated': '已截断',
        'tag.omittedTitle': '因超出注入字数上限，本条当前不会进入系统提示词',
        'tag.truncatedTitle': '本条过长，仅开头部分进入系统提示词',
        'rules.label': '生效规则',
        'rules.note': '「始终」无条件生效；「按需」由模型按相关性自动判断。超出上限时按优先级保留，其余暂不注入。',
        'search.placeholder': '搜索指令：标题 / 内容 / 适用场景（共 {count} 条）',
        'search.matchCount': '匹配 {shown} / {total} 条',
        'tags.label': '标签（可选，仅用于在本页分组与筛选，不会注入提示词）',
        'tags.placeholder': '输入标签后回车，逗号分隔多个，例如：代码规范',
        'tags.hint': '每条最多 {max} 个标签，单个不超过 {len} 字符',
        'tags.duplicate': '已有同名标签',
        'tags.full': '每条最多 {max} 个标签',
        'filter.all': '全部',
        'filter.tag': '标签',
        'filter.mode': '生效方式',
        'filter.status': '状态',
        'filter.modeAlways': '始终',
        'filter.modeAuto': '按需',
        'filter.statusEnabled': '已启用',
        'filter.statusDisabled': '已停用',
        'sort.label': '排序',
        'sort.priority': '按优先级',
        'sort.updated': '按更新时间',
        'sort.title': '按标题',
        'action.batch': '批量操作',
        'batch.exit': '退出批量',
        'batch.selectAll': '全选',
        'batch.selected': '已选 {count} 条',
        'batch.enable': '启用',
        'batch.disable': '停用',
        'batch.priority': '设优先级…',
        'batch.addTags': '加标签…',
        'batch.delete': '删除',
        'batch.confirmDelete': '确定删除选中的 {count} 条指令？删除后无法恢复。',
        'batch.tagPrompt': '输入要添加到 {count} 条指令的标签（多个用逗号分隔）',
        'batch.tagEmpty': '未输入有效的标签',
        'batch.noneSelected': '请先勾选要操作的指令',
        'batch.promptUnavailable': '当前环境不支持快捷输入，请逐条编辑标签',
        'profiles.section': '用户形象',
        'profiles.subtitle': '关于你本人的身份背景、喜好、性格与追求。勾选「使用该形象」后，AI 会在保证回答正确且扣题的前提下据此调整详略、举例与建议侧重；不会为了迎合而改变事实或偏离问题。',
        'profiles.new': '＋ 新增形象',
        'profiles.name': '形象名称',
        'profiles.namePlaceholder': '例如：职业背景 / 沟通偏好 / 性格 / 长期追求',
        'profiles.content': '形象内容',
        'profiles.contentPlaceholder': '描述你本人的情况，例如：有 8 年后端开发经验，技术问题可跳过入门概念；喜欢先给结论、再给可执行步骤，少寒暄。',
        'profiles.use': '使用该形象',
        'profiles.untitled': '未命名形象',
        'profiles.confirmDelete': '确定删除用户形象「{name}」？删除后无法恢复。',
        'profiles.empty': '还没有用户形象。点击「＋ 新增形象」添加关于你本人的信息；不勾选任何形象时，AI 完全按原本方式回答。',
        'profiles.count': '共 {total} 个，使用中 {active} 个',
        'profiles.chars': '已启用形象合计 {count} 字符（独立于指令字数上限，完整注入、不做裁剪）',
        'profiles.saving': '保存中…',
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
        'list.filteredEmpty': '没有符合当前筛选条件的指令。',
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
        // ---- F13 多情境配置集 ----
        'sets.section': '配置集',
        'sets.note': '把记忆分成互不相干的几套（如「工作」「个人」「某客户」）。注入只使用当前激活的一套；切换只改变注入内容，不会移动或删除任何文本。',
        'sets.total': '全部配置集合计 {total} / {max} 条指令',
        'sets.activeHint': '当前注入「{name}」',
        'sets.create': '＋ 新建',
        'sets.rename': '重命名',
        'sets.duplicate': '复制',
        'sets.delete': '删除',
        'sets.nameLabel': '配置集名称',
        'sets.namePlaceholder': '例如：工作 / 个人 / 某客户',
        'sets.confirm': '确定',
        'sets.nameEmpty': '请先填写配置集名称',
        'sets.itemMeta': '{entries} 条指令 · {profiles} 个形象',
        'sets.activeBadge': '使用中',
        'sets.switch': '切换',
        'sets.switchHint': '切换到该配置集：注入内容立即变更',
        'sets.copySuffix': ' 副本',
        'sets.deleteConfirm': '确定删除配置集「{name}」？其中的 {entries} 条指令与 {profiles} 个用户形象会一并删除，且无法撤销。',
        'sets.deleteActive': '当前激活的配置集不能删除；请先切换到其他配置集。',
        'sets.draftsClosed': '已关闭切换前打开的编辑草稿',
        // ---- F12 诊断与安全状态 ----
        'diag.section': '诊断信息',
        'diag.show': '展开诊断',
        'diag.hide': '收起诊断',
        'diag.copy': '复制诊断信息',
        'diag.copied': '诊断信息已复制到剪贴板',
        'diag.copyManual': '自动复制不可用；请手动全选复制下方文本。',
        'diag.hostWarn': '安全提示：设置路由当前绑定在非回环地址（{host}），同一网络内的设备可以无鉴权访问此页面，请勿在不可信网络暴露；如需对外发布，请阅读 README 的「经反向代理对外发布」。',
        'diag.groupStorage': '存储',
        'diag.groupInjection': '注入',
        'diag.groupBackup': '备份与历史',
        'diag.groupIssues': '错误与警告',
        'diag.none': '（无）',
        'diag.storagePath': '存储文件',
        'diag.onDisk': '存储文件已在磁盘',
        'diag.loadedFrom': '载入来源',
        'diag.savedAt': '最近保存',
        'diag.rev': '修订号（rev）',
        'diag.registered': '注入已注册',
        'diag.yes': '是',
        'diag.no': '否',
        'diag.pulls': '注入拉取次数（自本次插件启动计数）',
        'diag.chars': '当前注入字符数 / 上限',
        'diag.backupDir': '备份位置',
        'diag.backupDefault': '默认（与存储文件同目录）',
        'diag.backupPath': '覆盖副本（.bak）',
        'diag.historyDir': '版本历史目录',
        'diag.historyCount': '历史快照数',
        'diag.schemaFile': 'Schema 文件',
        'diag.issueStorage': '存储错误',
        'diag.issueWarning': '存储警告',
        'diag.issueHistory': '历史错误',
        'diag.issueSection': '注入错误',
        // ---- 反馈邮件 ----
        'feedback.section': '反馈',
        'feedback.show': '反馈',
        'feedback.hide': '收起反馈',
        'feedback.intro': '遇到问题或有功能建议？填写下面的表单，通过邮件发送给插件维护者。',
        'feedback.typeLabel': '问题类型',
        'feedback.typeBug': '问题反馈（Bug）',
        'feedback.typeSuggestion': '功能建议',
        'feedback.typeOther': '其他',
        'feedback.titleLabel': '标题',
        'feedback.titlePlaceholder': '一句话概括问题或建议',
        'feedback.bodyLabel': '详细描述',
        'feedback.bodyPlaceholder': '复现步骤、期望结果、实际表现；建议请说明使用场景',
        'feedback.contactLabel': '联系方式（可选）',
        'feedback.contactPlaceholder': '邮箱 / 微信 / GitHub 用户名，便于回复你',
        'feedback.hint': '发送时会自动附带插件版本、DSH / Node 版本与运行平台，不包含你的指令内容。',
        'feedback.send': '发送反馈',
        'feedback.sending': '正在发送…',
        'feedback.clear': '清空',
        'feedback.sent': '反馈已发送，感谢你的反馈！',
        'feedback.failed': '反馈发送失败，请稍后重试。',
        'feedback.failedDetail': '反馈发送失败：{detail}',
        'feedback.errType': '请选择有效的问题类型',
        'feedback.errTitle': '请填写标题',
        'feedback.errTitleLong': '标题不能超过 {max} 个字符',
        'feedback.errBody': '请补充详细描述（至少 5 个字符）',
        'feedback.errBodyLong': '详细描述不能超过 {max} 个字符',
        'feedback.errContact': '联系方式不能超过 {max} 个字符',
        // ---- F7 临时静音 ----
        'mute.menu': '暂停注入…',
        'mute.30m': '30 分钟',
        'mute.1h': '1 小时',
        'mute.today': '到今天结束',
        'mute.resume': '立即恢复',
        'mute.active': '注入已暂停，剩余 {remaining}',
        'mute.hint': '暂停期间不注入任何指令或用户形象，到期后自动恢复；此状态跨重启保留。',
        'mute.remainingMs': '{m} 分 {s} 秒',
        'mute.remainingH': '{h} 小时 {m} 分',
        // ---- F14 版本历史 ----
        'history.section': '版本历史',
        'history.subtitle': '每次保存都会留一份带时间戳的快照（每台设备最多保留 {max} 份，逐出最旧的）。可在此查看并一键回滚。',
        'history.show': '查看版本历史',
        'history.hide': '收起',
        'history.count': '共 {count} 份',
        'history.loading': '正在读取…',
        'history.empty': '还没有历史快照（第一次保存后出现）。',
        'history.itemMeta': '{entries} 条指令 / {profiles} 个形象 · {size} KB',
        'history.itemMetaLite': '{size} KB（文件较大，未统计条目数）',
        'history.foreign': '来自其他设备（{device}）',
        'history.restore': '回滚到此版本',
        'history.restoreConfirm': '确定把当前记忆整体回滚到 {time} 的快照（rev {rev}）？当前内容仍保留在 memory.json.bak 中，且回滚本身会生成一份新快照，可以再回滚回来。',
        'history.delete': '删除',
        'history.deleteConfirm': '确定删除这份历史快照？删除后无法恢复。',
        'history.dir': '快照目录：{dir}',
        // ---- F16 源码模式 ----
        'source.mode': '源码模式',
        'source.exit': '退出源码模式',
        'source.section': '源码模式（整份 JSON）',
        'source.subtitle': '直接编辑整份存储文件（与 memory.json 内容一致）。保存时走与手改文件相同的校验与披露，并带 rev 冲突保护；保存后立即生效。',
        'source.save': '保存源码',
        'source.reload': '重新载入最新内容',
        'source.valid': 'JSON 语法正确：{entries} 条指令 / {profiles} 个形象 / {sets} 个配置集',
        'source.invalid': 'JSON 语法错误：{detail}',
        'source.empty': '内容为空',
        'source.notObject': '顶层必须是一个 JSON 对象',
        'source.keepDraft': '保存被拒绝，源码草稿未丢失；可修改后重试，或点「重新载入最新内容」放弃本地修改。',
        'source.reloadConfirm': '重新载入会丢弃当前编辑的源码草稿，确定吗？',
        'source.editorOpen': '请先关闭正在编辑的条目或形象，再进入源码模式',
        'source.truncatedInput': '源码过长（{size} 万字符），已停止实时校验；保存时仍会按上限校验。',
        // ---- F17 本地预演 ----
        'sim.title': '按需指令本地预演',
        'sim.toggle': '本地预演',
        'sim.hide': '收起预演',
        'sim.disclaimer': '本地预演 ≠ 模型的真实判断：这里只用字面关键词匹配各条「按需」指令的适用场景/标题/内容，帮你把「适用场景」写清楚、预判取舍。它不参与注入，也不代表模型实际会不会采纳。',
        'sim.placeholder': '输入一句当前任务描述，例如：帮我改一下这个配置文件',
        'sim.hint': '输入任务描述后，这里会列出字面相关度较高的「按需」指令；结果仅供自查。',
        'sim.levelHigh': '预演·高',
        'sim.levelMid': '预演·中',
        'sim.levelLow': '预演·低',
        'sim.matched': '字面命中：{terms}',
        'sim.noWhen': '未填写「适用场景」，建议补充',
        'sim.none': '没有「按需」指令与这段描述存在字面匹配。',
        'sim.onlyAuto': '仅「按需」指令参与预演；「始终」指令无条件生效，不参与匹配，也不受此结果影响。',
        'sim.summary': '共 {total} 条按需指令，字面命中 {hit} 条',
        'sim.omitted': '本轮因超出字数上限未注入',
        // ---- F18 备份位置 ----
        'backup.section': '备份位置',
        'backup.label': '自定义备份位置（绝对路径；留空 = 与存储文件同目录）',
        'backup.placeholder': '例如 D:\\云盘\\dsh-memory 或 /home/me/cloud/dsh-memory',
        'backup.apply': '应用',
        'backup.exportToDir': '导出到备份目录',
        'backup.hint': '备份位置决定「版本历史」目录与「导出到备份目录」的去向，并额外保留一份 memory.json.bak；存储文件本身（及其跨进程锁）不会移动。它是本机设置，不会随导出文件带到别的机器。',
        'backup.multiDevice': '多设备建议：把备份位置指向本地云盘文件夹，只同步「导出文件」与「history 快照」；不要用云盘同步存储目录本身，两台机器同时写入会互相覆盖。',
        'action.restore': '从备份恢复…',
        'restore.hint': '用导出的备份文件整体替换当前记忆（导入只做合并，无法还原整份）',
        'restore.confirm': '确定用所选备份文件整体替换当前记忆？现有内容仍保留在 memory.json.bak 与版本历史中；配置集、条目与用户形象都会被文件内容替换（备份位置等本机设置保持不变）。',
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
        'budget.used': '{used} of {budget} characters actually injected (≈{tokens} tokens, estimate)',
        'budget.omitted': '{count} active entries are not injected this turn because the limit is exceeded; raise the limit or adjust priorities',
        'tag.omitted': 'Not injected',
        'tag.truncated': 'Truncated',
        'tag.omittedTitle': 'This entry currently stays out of the system prompt because the injection size limit is exceeded',
        'tag.truncatedTitle': 'This entry is too long; only its beginning reaches the system prompt',
        'rules.label': 'How instructions apply',
        'rules.note': '“Always” applies unconditionally; “On demand” lets the model judge by relevance. When the limit is exceeded, higher-priority entries are kept and the rest are skipped.',
        'search.placeholder': 'Search instructions: title / content / scenario ({count} in total)',
        'search.matchCount': '{shown} of {total} match',
        'tags.label': 'Tags (optional; used only for grouping/filtering on this page, never injected)',
        'tags.placeholder': 'Type a tag and press Enter; separate several with commas, e.g. code-style',
        'tags.hint': 'Up to {max} tags per entry, each at most {len} characters',
        'tags.duplicate': 'This tag already exists',
        'tags.full': 'Up to {max} tags per entry',
        'filter.all': 'All',
        'filter.tag': 'Tag',
        'filter.mode': 'Mode',
        'filter.status': 'Status',
        'filter.modeAlways': 'Always',
        'filter.modeAuto': 'On demand',
        'filter.statusEnabled': 'Enabled',
        'filter.statusDisabled': 'Disabled',
        'sort.label': 'Sort',
        'sort.priority': 'By priority',
        'sort.updated': 'By updated time',
        'sort.title': 'By title',
        'action.batch': 'Bulk actions',
        'batch.exit': 'Exit bulk',
        'batch.selectAll': 'Select all',
        'batch.selected': '{count} selected',
        'batch.enable': 'Enable',
        'batch.disable': 'Disable',
        'batch.priority': 'Set priority…',
        'batch.addTags': 'Add tags…',
        'batch.delete': 'Delete',
        'batch.confirmDelete': 'Delete the {count} selected entries? This cannot be undone.',
        'batch.tagPrompt': 'Enter tags to add to {count} entries (separate several with commas)',
        'batch.tagEmpty': 'No valid tag entered',
        'batch.noneSelected': 'Tick the entries to act on first',
        'batch.promptUnavailable': 'Quick entry is unavailable in this environment; edit tags one by one',
        'profiles.section': 'User persona',
        'profiles.subtitle': 'Facts about you: background, tastes, personality and goals. When “Use this persona” is ticked, the AI adjusts depth, examples and advice to tilt toward you — while staying correct and on-topic; it must never change facts or wander off the question to please you.',
        'profiles.new': '＋ New persona',
        'profiles.name': 'Persona name',
        'profiles.namePlaceholder': 'e.g. Professional background / Communication style / Personality / Goals',
        'profiles.content': 'Persona details',
        'profiles.contentPlaceholder': 'Describe yourself, e.g. 8 years of backend experience, so skip intro concepts; prefers the conclusion first, then actionable steps, no small talk.',
        'profiles.use': 'Use this persona',
        'profiles.untitled': 'Untitled persona',
        'profiles.confirmDelete': 'Delete the persona “{name}”? This cannot be undone.',
        'profiles.empty': 'No persona yet. Click “＋ New persona” to add facts about yourself; with no persona ticked, the AI answers exactly as it normally would.',
        'profiles.count': '{total} in total, {active} in use',
        'profiles.chars': 'Active personas total {count} characters (separate from the instruction budget; injected in full, never trimmed)',
        'profiles.saving': 'Saving…',
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
        'list.filteredEmpty': 'No instructions match the current filters.',
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
        // ---- F13 instruction sets ----
        'sets.section': 'Instruction sets',
        'sets.note': 'Split memory into independent sets (e.g. Work / Personal / a client). Only the active set is injected; switching changes what is injected and never moves or deletes any text.',
        'sets.total': '{total} of {max} instructions across all sets',
        'sets.activeHint': 'Injecting “{name}”',
        'sets.create': '＋ New',
        'sets.rename': 'Rename',
        'sets.duplicate': 'Duplicate',
        'sets.delete': 'Delete',
        'sets.nameLabel': 'Set name',
        'sets.namePlaceholder': 'e.g. Work / Personal / Acme client',
        'sets.confirm': 'OK',
        'sets.nameEmpty': 'Enter a set name first',
        'sets.itemMeta': '{entries} instructions · {profiles} personas',
        'sets.activeBadge': 'In use',
        'sets.switch': 'Switch',
        'sets.switchHint': 'Switch to this set: the injected content changes immediately',
        'sets.copySuffix': ' copy',
        'sets.deleteConfirm': 'Delete the set “{name}”? Its {entries} instructions and {profiles} personas are deleted with it. This cannot be undone.',
        'sets.deleteActive': 'The active set cannot be deleted; switch to another set first.',
        'sets.draftsClosed': 'The editor draft open before the switch was closed',
        // ---- F12 diagnostics & security panel ----
        'diag.section': 'Diagnostics',
        'diag.show': 'Show diagnostics',
        'diag.hide': 'Hide diagnostics',
        'diag.copy': 'Copy diagnostics',
        'diag.copied': 'Diagnostics copied to the clipboard',
        'diag.copyManual': 'Automatic copy is unavailable; select and copy the text below manually.',
        'diag.hostWarn': 'Security notice: the settings route is bound to a non-loopback address ({host}); other devices on the same network can reach this page without authentication. Do not expose it on an untrusted network — for public deployments read “Publishing behind a reverse proxy” in the README.',
        'diag.groupStorage': 'Storage',
        'diag.groupInjection': 'Injection',
        'diag.groupBackup': 'Backup & history',
        'diag.groupIssues': 'Errors & warnings',
        'diag.none': '(none)',
        'diag.storagePath': 'Store file',
        'diag.onDisk': 'Store file on disk',
        'diag.loadedFrom': 'Loaded from',
        'diag.savedAt': 'Last saved',
        'diag.rev': 'Revision (rev)',
        'diag.registered': 'Section registered',
        'diag.yes': 'yes',
        'diag.no': 'no',
        'diag.pulls': 'Prompt pulls (counted since this plugin started)',
        'diag.chars': 'Injected chars / budget',
        'diag.backupDir': 'Backup location',
        'diag.backupDefault': 'default (next to the store file)',
        'diag.backupPath': 'Rolling copy (.bak)',
        'diag.historyDir': 'History directory',
        'diag.historyCount': 'History snapshots',
        'diag.schemaFile': 'Schema file',
        'diag.issueStorage': 'Storage error',
        'diag.issueWarning': 'Storage warning',
        'diag.issueHistory': 'History error',
        'diag.issueSection': 'Injection error',
        // ---- feedback mail ----
        'feedback.section': 'Feedback',
        'feedback.show': 'Feedback',
        'feedback.hide': 'Hide feedback',
        'feedback.intro': 'Found a problem or have a suggestion? Send it to the plugin maintainer by email with the form below.',
        'feedback.typeLabel': 'Category',
        'feedback.typeBug': 'Problem report (bug)',
        'feedback.typeSuggestion': 'Feature request',
        'feedback.typeOther': 'Other',
        'feedback.titleLabel': 'Title',
        'feedback.titlePlaceholder': 'Sum up the problem or suggestion in one line',
        'feedback.bodyLabel': 'Details',
        'feedback.bodyPlaceholder': 'Steps to reproduce, expected result, actual result; for a suggestion, describe the use case',
        'feedback.contactLabel': 'Contact (optional)',
        'feedback.contactPlaceholder': 'Email / WeChat / GitHub handle so the maintainer can reply',
        'feedback.hint': 'The mail automatically includes the plugin version, DSH / Node versions and platform — never your instruction content.',
        'feedback.send': 'Send feedback',
        'feedback.sending': 'Sending…',
        'feedback.clear': 'Clear',
        'feedback.sent': 'Feedback sent — thank you!',
        'feedback.failed': 'Could not send the feedback. Please try again later.',
        'feedback.failedDetail': 'Could not send the feedback: {detail}',
        'feedback.errType': 'Choose a valid category',
        'feedback.errTitle': 'Enter a title',
        'feedback.errTitleLong': 'The title must be at most {max} characters',
        'feedback.errBody': 'Add a description (at least 5 characters)',
        'feedback.errBodyLong': 'The description must be at most {max} characters',
        'feedback.errContact': 'The contact must be at most {max} characters',
        // ---- F7 temporary mute ----
        'mute.menu': 'Pause injection…',
        'mute.30m': '30 minutes',
        'mute.1h': '1 hour',
        'mute.today': 'Until the end of today',
        'mute.resume': 'Resume now',
        'mute.active': 'Injection paused — {remaining} left',
        'mute.hint': 'While paused, neither instructions nor personas are injected. It resumes automatically and survives a restart.',
        'mute.remainingMs': '{m}m {s}s',
        'mute.remainingH': '{h}h {m}m',
        // ---- F14 version history ----
        'history.section': 'Version history',
        'history.subtitle': 'Every save leaves a timestamped snapshot ({max} kept per device, oldest evicted first). Review them here and roll back with one click.',
        'history.show': 'Show version history',
        'history.hide': 'Hide',
        'history.count': '{count} snapshots',
        'history.loading': 'Loading…',
        'history.empty': 'No snapshots yet (the first save creates one).',
        'history.itemMeta': '{entries} instructions / {profiles} personas · {size} KB',
        'history.itemMetaLite': '{size} KB (file too large to count items)',
        'history.foreign': 'From another device ({device})',
        'history.restore': 'Roll back to this',
        'history.restoreConfirm': 'Roll the whole memory back to the snapshot from {time} (rev {rev})? The current content stays in memory.json.bak, and the rollback itself creates a new snapshot, so you can roll forward again.',
        'history.delete': 'Delete',
        'history.deleteConfirm': 'Delete this snapshot? This cannot be undone.',
        'history.dir': 'Snapshot folder: {dir}',
        // ---- F16 source mode ----
        'source.mode': 'Source mode',
        'source.exit': 'Exit source mode',
        'source.section': 'Source mode (whole JSON)',
        'source.subtitle': 'Edit the whole store file (identical to memory.json). Saving runs the same validation and disclosures as a hand edit, carries rev conflict protection, and takes effect immediately.',
        'source.save': 'Save source',
        'source.reload': 'Reload latest',
        'source.valid': 'Valid JSON: {entries} instructions / {profiles} personas / {sets} sets',
        'source.invalid': 'Invalid JSON: {detail}',
        'source.empty': 'The content is empty',
        'source.notObject': 'The top level must be a JSON object',
        'source.keepDraft': 'The save was refused and your draft is intact; fix it and retry, or click “Reload latest” to discard local edits.',
        'source.reloadConfirm': 'Reloading discards the source draft you are editing. Continue?',
        'source.editorOpen': 'Close the open entry/persona editor before entering source mode',
        'source.truncatedInput': 'The source is very long ({size}0k characters); live validation is paused. Saving still enforces the limit.',
        // ---- F17 local preview ----
        'sim.title': 'Local preview of on-demand rules',
        'sim.toggle': 'Local preview',
        'sim.hide': 'Hide preview',
        'sim.disclaimer': 'A local preview is NOT the model’s actual judgement: it only matches literal keywords against each on-demand rule’s scenario/title/content to help you sharpen the scenario field and predict trade-offs. It does not take part in injection and says nothing about whether the model would actually follow the rule.',
        'sim.placeholder': 'Describe the current task, e.g. help me edit this config file',
        'sim.hint': 'Type a task description to list the on-demand rules with the strongest literal overlap; the result is for your own inspection.',
        'sim.levelHigh': 'Preview · high',
        'sim.levelMid': 'Preview · medium',
        'sim.levelLow': 'Preview · low',
        'sim.matched': 'Literal matches: {terms}',
        'sim.noWhen': 'No scenario text — consider adding one',
        'sim.none': 'No on-demand rule overlaps this description literally.',
        'sim.onlyAuto': 'Only on-demand rules take part in the preview; always-on rules apply unconditionally and are unaffected by this result.',
        'sim.summary': '{total} on-demand rules, {hit} with a literal match',
        'sim.omitted': 'Not injected this round (over the size limit)',
        // ---- F18 backup location ----
        'backup.section': 'Backup location',
        'backup.label': 'Custom backup location (absolute path; empty = next to the store file)',
        'backup.placeholder': 'e.g. D:\\cloud\\dsh-memory or /home/me/cloud/dsh-memory',
        'backup.apply': 'Apply',
        'backup.exportToDir': 'Export to backup folder',
        'backup.hint': 'This folder holds the version-history directory and the “Export to backup folder” target, and keeps one extra memory.json.bak. The store file itself (and its cross-process lock) never moves. It is machine-local and is not carried to another machine by an export.',
        'backup.multiDevice': 'Multi-device tip: point this at a local cloud-sync folder and let only the export files and history snapshots sync. Do not sync the store directory itself — two machines writing at once would overwrite each other.',
        'action.restore': 'Restore from backup…',
        'restore.hint': 'Replace the whole memory with an exported backup file (import only merges, so it cannot restore a whole store)',
        'restore.confirm': 'Replace the whole memory with the selected backup file? The current content stays in memory.json.bak and in the version history; sets, instructions and personas are all replaced by the file (machine-local settings such as the backup location are kept).',
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

    // Mirror the Host's tag limits (lib/index.js); kept local so the editor
    // constrains input before the round-trip and tests can pin both to match.
    const MAX_TAGS = 8
    const MAX_TAG_LEN = 24

    /**
     * Parse free text typed into the tag box into normalised tag candidates.
     * Tags are split on commas (ASCII/full-width), semicolons and newlines —
     * never spaces, so a tag may contain spaces. Each piece is trimmed,
     * collapsed to one line, cut to MAX_TAG_LEN, de-duplicated and capped at
     * MAX_TAGS. Pinned as a pure export.
     */
    function parseTagInput(text) {
      if (typeof text !== 'string') return []
      const out = []
      const seen = new Set()
      for (const piece of text.split(/[,，;；\n\r]+/)) {
        const tag = piece.replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_LEN)
        if (tag === '' || seen.has(tag)) continue
        seen.add(tag)
        if (out.length >= MAX_TAGS) break
        out.push(tag)
      }
      return out
    }

    function cloneEntry(entry) {
      return {
        id: entry.id,
        title: entry.title,
        content: entry.content,
        mode: entry.mode,
        when: entry.when,
        priority: entry.priority,
        enabled: entry.enabled,
        tags: Array.isArray(entry.tags) ? entry.tags.slice() : [],
        updatedAt: entry.updatedAt,
      }
    }

    // ---- User persona ("用户形象") drafts ----
    function cloneProfile(profile) {
      return {
        id: profile.id,
        name: profile.name,
        content: profile.content,
        enabled: profile.enabled === true,
        updatedAt: profile.updatedAt,
      }
    }

    function blankProfileDraft() {
      return { id: '', name: '', content: '', enabled: true, updatedAt: 0 }
    }

    /** Whether a profile editor differs from the stored version (or a blank new one). */
    function profileIsDirty(draft, profiles) {
      const base = draft.id === ''
        ? blankProfileDraft()
        : (profiles || []).find((profile) => profile.id === draft.id)
      if (base === undefined) return true
      return base.name !== draft.name || base.content !== draft.content || base.enabled !== draft.enabled
    }

    function blankDraft() {
      return { id: '', title: '', content: '', mode: 'always', when: '', priority: 1, enabled: true, tags: [], updatedAt: 0 }
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
      if (fields.some((field) => String(draft[field]) !== String(base[field]))) return true
      // Tags are an optional array that may be absent on old entries; compare
      // a normalised form so [] and undefined both read as "no tags".
      const tagsKey = (entry) => (Array.isArray(entry && entry.tags) ? entry.tags : []).join('')
      return tagsKey(draft) !== tagsKey(base)
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
      // data === null passes a typeof check but poisons every consumer that
      // reads data.budgetChars; it is exactly as unusable as a missing data.
      if (snapshot === null || typeof snapshot !== 'object' || snapshot.data === undefined || snapshot.data === null) return null
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

    /**
     * Reduce a snapshot's injection plan to the values the header meter and
     * the entry badges render. Pinned as a pure export so the fallback math is
     * testable without React.
     *
     * Tolerates an older Host whose snapshot predates the plan fields: the
     * ceiling then falls back to data.budgetChars and there are simply no
     * per-entry marks (included/omitted). Garbage input degrades to zeros
     * instead of throwing mid-render.
     */
    function budgetMeter(snapshot) {
      const inj = snapshot !== null && typeof snapshot === 'object'
        && snapshot.injection !== null && typeof snapshot.injection === 'object'
        ? snapshot.injection : {}
      const data = snapshot !== null && typeof snapshot === 'object'
        && snapshot.data !== null && typeof snapshot.data === 'object'
        ? snapshot.data : {}
      const budget = typeof inj.budget === 'number' && inj.budget > 0
        ? inj.budget
        : (typeof data.budgetChars === 'number' && data.budgetChars > 0 ? data.budgetChars : 0)
      // Measure ONLY the instruction half: on a host that publishes persona
      // profiles, `chars` is the whole section (personas + instructions) while
      // `entryChars` is the budgeted half. Older hosts publish neither field,
      // and there `chars` is already instructions-only, so the fallback is
      // correct on both.
      const used = typeof inj.entryChars === 'number' && inj.entryChars >= 0
        ? inj.entryChars
        : (typeof inj.chars === 'number' && inj.chars >= 0 ? inj.chars : 0)
      const countFlagged = (list, wantTruncated) =>
        Array.isArray(list)
          ? list.filter((item) => item !== null && typeof item === 'object'
            && typeof item.id === 'string' && item.id !== ''
            && (wantTruncated ? item.truncated === true : true)).length
          : 0
      const omitted = countFlagged(inj.omitted, false)
      const truncated = countFlagged(inj.included, true)
      const percent = budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0
      // The same rough ratio the budget note quotes; displayed as an ESTIMATE.
      const tokens = Math.round(used * 0.6)
      return { budget, used, omitted, truncated, percent, tokens }
    }

    /**
     * F12: serialize a diagnostic snapshot into plain text for an issue report.
     * Pinned as a pure export so verify.mjs can hold the contract: the dump
     * carries the operational fields (store shape, storage, injection,
     * security, load origin) plus the reporter's environment, and NEVER
     * carries user text — no entry titles, no entry or persona bodies. Paths
     * (including the absolute backup directory) are machine-local but are the
     * whole point of a support dump, so they stay.
     */
    function diagnosticsText(view, env) {
      const sec = (root, name) => (root !== null && typeof root === 'object'
        && root[name] !== null && typeof root[name] === 'object' ? root[name] : {})
      const data = sec(view, 'data')
      const storage = sec(view, 'storage')
      const injection = sec(view, 'injection')
      const security = sec(view, 'security')
      const diagnostics = sec(view, 'diagnostics')
      const environment = env !== null && typeof env === 'object' ? env : {}
      const v = (value) => (value === null || value === undefined ? '' : String(value))
      const count = (value) => (Array.isArray(value) ? String(value.length) : '0')
      return [
        'dsh-instruction-memory diagnostics',
        '--- store ---',
        'version: ' + v(data.version),
        'rev: ' + v(data.rev),
        'enabled: ' + v(data.enabled),
        'budgetChars: ' + v(data.budgetChars),
        'disabledUntil: ' + v(data.disabledUntil),
        'sets: ' + count(data.sets),
        'entries(active set): ' + count(data.entries),
        'profiles(active set): ' + count(data.profiles),
        '--- storage ---',
        'path: ' + v(storage.path),
        'onDisk: ' + v(storage.onDisk),
        'loadedFrom: ' + v(diagnostics.loadedFrom),
        'rev: ' + v(diagnostics.rev),
        'savedAt: ' + (typeof storage.savedAt === 'number' && storage.savedAt > 0 ? new Date(storage.savedAt).toISOString() : ''),
        'migratedFrom: ' + v(storage.migratedFrom),
        'backupDir: ' + v(storage.backupDir),
        'isDefaultBackupDir: ' + v(storage.isDefaultBackupDir),
        'backupPath: ' + v(storage.backupPath),
        'historyDir: ' + v(storage.historyDir),
        'historyCount: ' + v(storage.historyCount),
        'schemaFile: ' + v(storage.schemaFile),
        '--- injection ---',
        'registered: ' + v(injection.registered),
        'muted: ' + v(injection.muted),
        'error: ' + v(injection.error),
        'chars: ' + v(injection.chars),
        'budget: ' + v(injection.budget),
        'pulls(since boot): ' + v(injection.pulls),
        '--- security ---',
        'hostGuarded: ' + v(security.hostGuarded),
        'boundHost: ' + v(security.boundHost),
        '--- errors/warnings ---',
        'storage.error: ' + v(storage.error),
        'storage.warning: ' + v(storage.warning),
        'historyError: ' + v(storage.historyError),
        '--- environment ---',
        'userAgent: ' + v(environment.userAgent),
        'language: ' + v(environment.language),
        'time: ' + v(environment.now),
      ].join('\n')
    }

    /* ---------------- F17: local relevance preview ---------------- */

    /** The most terms one query may be split into; keeps matching cheap. */
    const SIM_MAX_TERMS = 40
    /** Overlap thresholds for the three displayed levels (see relevancePreview). */
    const SIM_LEVEL_HIGH = 18
    const SIM_LEVEL_MID = 7
    /**
     * Field weights. The scenario text ("适用场景") carries the most signal
     * because it is the field the user writes FOR matching; the body counts
     * least (a long instruction mentions many words incidentally).
     */
    const SIM_WEIGHTS = [['when', 3], ['title', 2], ['content', 1]]
    /** Gram-sized function words that carry no signal on their own. */
    const SIM_STOP_GRAMS = new Set([
      '的是', '了的', '什么', '怎么', '如何', '可以', '一个', '一下', '进行', '以及', '或者',
      '如果', '因为', '所以', '但是', '然后', '已经', '需要', '应该', '可能', '我的', '你的',
      '我这', '你那', '就是', '还是', '有没有', '这个', '那个', '时候', '一些', '有点',
    ])

    /**
     * Split a free-text task description into the terms the local preview
     * matches on.
     *
     * CJK has no word boundaries, so a run of CJK is expanded into 3- and
     * 2-character grams (longer grams first, so the specific ones win the term
     * budget); Latin/digit runs become single terms. Deterministic and pure —
     * exported so the heuristic itself is pinnable by tests, and capped so a
     * pasted paragraph cannot turn into thousands of comparisons.
     */
    function relevanceTerms(query) {
      if (typeof query !== 'string') return []
      const text = query.toLowerCase().trim()
      if (text === '') return []
      const terms = []
      const seen = new Set()
      const push = (term) => {
        if (term.length < 2 || seen.has(term) || terms.length >= SIM_MAX_TERMS) return
        seen.add(term)
        terms.push(term)
      }
      for (const chunk of text.split(/[^\p{L}\p{N}]+/u)) {
        if (chunk === '' || terms.length >= SIM_MAX_TERMS) continue
        if (/[\u3400-\u9fff\uf900-\ufaff]/.test(chunk)) {
          for (let size = 3; size >= 2; size -= 1) {
            for (let at = 0; at + size <= chunk.length && terms.length < SIM_MAX_TERMS; at += 1) {
              const gram = chunk.slice(at, at + size)
              if (!SIM_STOP_GRAMS.has(gram)) push(gram)
            }
          }
          // A short CJK chunk as one term too: more specific than its grams.
          if (chunk.length <= 6) push(chunk)
        } else {
          push(chunk)
        }
      }
      return terms
    }

    /**
     * Score every on-demand ("按需" / auto) entry against a task description.
     *
     * This is a LOCAL, LITERAL keyword heuristic — explicitly not a prediction
     * of what the model will do — so the result is used only to highlight
     * entries in the list and to help the user sharpen the 适用场景 field. The
     * score is `Σ term.length × field weight` over the terms that appear
     * literally, which makes a 3-character match in the scenario text outrank
     * a 2-character match in the body.
     *
     * @returns { terms, results, autoTotal } — `results` is ordered by score
     *   descending and contains only entries with a non-zero overlap.
     */
    function relevancePreview(entries, query) {
      const terms = relevanceTerms(query)
      const results = []
      let autoTotal = 0
      if (terms.length === 0) return { terms, results, autoTotal }
      for (const entry of (Array.isArray(entries) ? entries : [])) {
        if (entry === null || typeof entry !== 'object' || entry.mode !== 'auto') continue
        autoTotal += 1
        const fields = {
          when: typeof entry.when === 'string' ? entry.when.toLowerCase() : '',
          title: typeof entry.title === 'string' ? entry.title.toLowerCase() : '',
          content: typeof entry.content === 'string' ? entry.content.toLowerCase() : '',
        }
        let score = 0
        const matched = []
        for (const term of terms) {
          for (const [field, weight] of SIM_WEIGHTS) {
            if (!fields[field].includes(term)) continue
            score += term.length * weight
            if (matched.length < 6 && !matched.includes(term)) matched.push(term)
          }
        }
        if (score <= 0) continue
        results.push({
          id: typeof entry.id === 'string' ? entry.id : '',
          score,
          level: score >= SIM_LEVEL_HIGH ? 'high' : (score >= SIM_LEVEL_MID ? 'mid' : 'low'),
          terms: matched,
          whenEmpty: fields.when.trim() === '',
        })
      }
      results.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      return { terms, results, autoTotal }
    }

    /* ---------------- F16: source-mode validation ---------------- */

    /**
     * Live validation for the source editor: syntax plus the cheap shape check
     * the Host will apply anyway (a JSON object, not an array/scalar). It
     * deliberately does NOT try to re-implement the Host's normalisation — the
     * authoritative disclosures (dropped items, corrected options, truncation,
     * version refusal) come back from the save itself, so the panel can never
     * promise something the Host does not do.
     *
     * Past `maxChars` the live parse is skipped: parsing multi-megabyte text on
     * every keystroke would freeze the panel, and the save path still enforces
     * the same ceiling with a readable refusal.
     */
    function sourceParseVerdict(text, maxChars) {
      if (typeof text !== 'string' || text.trim() === '') return { ok: false, message: t('source.empty') }
      if (typeof maxChars === 'number' && maxChars > 0 && text.length > maxChars) {
        return { ok: false, paused: true, message: t('source.truncatedInput', { size: Math.max(1, Math.round(text.length / 10000)) }) }
      }
      let parsed = null
      try {
        parsed = JSON.parse(text)
      } catch (err) {
        return { ok: false, message: t('source.invalid', { detail: String(err && err.message ? err.message : err) }) }
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, message: t('source.notObject') }
      }
      return {
        ok: true,
        message: t('source.valid', {
          entries: Array.isArray(parsed.entries) ? parsed.entries.length : 0,
          profiles: Array.isArray(parsed.profiles) ? parsed.profiles.length : 0,
          sets: Array.isArray(parsed.sets) && parsed.sets.length > 0 ? parsed.sets.length : 1,
        }),
      }
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

    /**
     * Client-side mirror of the Host's normalizeFeedback. Returns either
     * `{ ok: true, value }` (trimmed) or `{ ok: false, message }` (already
     * translated); the Host re-validates and stays authoritative (a forged
     * request can bypass every check here).
     */
    function feedbackVerdict(type, title, body, contact, limits) {
      const source = limits !== null && typeof limits === 'object' ? limits : FEEDBACK_DEFAULTS
      const maxTitle = typeof source.maxFeedbackTitle === 'number' ? source.maxFeedbackTitle : FEEDBACK_DEFAULTS.maxTitle
      const maxBody = typeof source.maxFeedbackBody === 'number' ? source.maxFeedbackBody : FEEDBACK_DEFAULTS.maxBody
      const maxContact = typeof source.maxFeedbackContact === 'number' ? source.maxFeedbackContact : FEEDBACK_DEFAULTS.maxContact
      const kind = typeof type === 'string' ? type : ''
      if (!FEEDBACK_TYPES.includes(kind)) return { ok: false, message: t('feedback.errType') }
      const cleanTitle = typeof title === 'string' ? title.trim() : ''
      if (cleanTitle === '') return { ok: false, message: t('feedback.errTitle') }
      if (cleanTitle.length > maxTitle) {
        return { ok: false, message: t('feedback.errTitleLong', { max: maxTitle }) }
      }
      const cleanBody = typeof body === 'string' ? body.trim() : ''
      if (cleanBody.length < 5) return { ok: false, message: t('feedback.errBody') }
      if (cleanBody.length > maxBody) {
        return { ok: false, message: t('feedback.errBodyLong', { max: maxBody }) }
      }
      const cleanContact = typeof contact === 'string' ? contact.trim() : ''
      if (cleanContact.length > maxContact) {
        return { ok: false, message: t('feedback.errContact', { max: maxContact }) }
      }
      return { ok: true, value: { type: kind, title: cleanTitle, body: cleanBody, contact: cleanContact } }
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
      children.push(h('div', { key: 'tags' },
        h('label', { className: 'im-label' }, t('tags.label')),
        h(TagInput, {
          tags: draft.tags,
          disabled: props.busy,
          onChange: (next) => set({ tags: next }),
        })))
      children.push(h('div', { className: 'im-row-wrap', key: 'a' },
        h('button', { className: 'im-btn im-btn-primary', disabled: props.busy, onClick: props.onSave },
          props.busy ? t('editor.saving') : t('editor.save')),
        h('button', { className: 'im-btn', disabled: props.busy, onClick: props.onCancel }, t('editor.cancel')),
        h('span', { className: 'im-spacer' }),
        h('span', { className: 'im-meta' }, t('editor.hint'))))
      return h('div', { className: 'im-card' }, children)
    }

    /**
     * Tag chips editor for one entry. Tags live only on this panel (they are
     * never injected). Committing (Enter / comma / semicolon / blur) parses the
     * typed text through parseTagInput and merges de-duplicated tags up to the
     * shared cap; Backspace on an empty box removes the last chip.
     */
    function TagInput(props) {
      const [text, setText] = React.useState('')
      const tags = Array.isArray(props.tags) ? props.tags : []
      const merge = (pieces) => {
        const merged = []
        for (const tag of [...tags, ...pieces]) {
          if (!merged.includes(tag)) merged.push(tag)
        }
        props.onChange(merged.slice(0, MAX_TAGS))
      }
      const commit = () => {
        const parsed = parseTagInput(text)
        if (parsed.length > 0) merge(parsed)
        setText('')
      }
      const remove = (tag) => {
        props.onChange(tags.filter((candidate) => candidate !== tag))
      }
      return h('div', null,
        tags.length > 0
          ? h('div', { className: 'im-entry-tags' },
            tags.map((tag) => h('span', { className: 'im-chip', key: tag },
              tag,
              h('button', {
                type: 'button', className: 'im-chip-x', disabled: props.disabled,
                onClick: () => remove(tag),
              }, '×'))))
          : null,
        h('input', {
          className: 'im-input',
          value: text,
          disabled: props.disabled,
          maxLength: MAX_TAG_LEN,
          placeholder: t('tags.placeholder'),
          onChange: (ev) => {
            const v = ev.target.value
            if (/[,，;；\n\r]/.test(v)) {
              // A separator commits the pending text as chips immediately.
              // v is the input's full new value (it already contains what was
              // typed before the separator) — do NOT prepend `text`, that
              // duplicated it ("b" + "b," -> "bb").
              const parsed = parseTagInput(v)
              if (parsed.length > 0) merge(parsed)
              setText('')
            } else {
              setText(v.slice(0, MAX_TAG_LEN))
            }
          },
          onKeyDown: (ev) => {
            if (ev.key === 'Enter') {
              ev.preventDefault()
              commit()
            } else if (ev.key === 'Backspace' && text === '' && tags.length > 0) {
              remove(tags[tags.length - 1])
            }
          },
          onBlur: commit,
        }),
        h('div', { className: 'im-meta' }, t('tags.hint', { max: MAX_TAGS, len: MAX_TAG_LEN })))
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

    /**
     * Editor for one "用户形象" (facts about the user). Deliberately minimal:
     * a single-line name and a multi-line description. Save is disabled while
     * both are blank (the Host would reject that anyway). The enable toggle
     * lives on the card, not here: the editor edits content, the card decides
     * whether the persona is used.
     */
    function ProfileEditor(props) {
      const limits = props.limits || {}
      const maxName = typeof limits.maxProfileName === 'number' ? limits.maxProfileName : 40
      const maxContent = typeof limits.maxProfileContent === 'number' ? limits.maxProfileContent : 4000
      const set = (patch) => props.onChange(Object.assign({}, props.draft, patch))
      const canSave = (props.draft.name.trim() !== '' || props.draft.content.trim() !== '')
      return h('div', { className: 'im-editor im-profiles' },
        h('div', null,
          h('label', { className: 'im-label' }, t('profiles.name')),
          h('input', {
            className: 'im-input',
            value: props.draft.name,
            maxLength: maxName,
            placeholder: t('profiles.namePlaceholder'),
            disabled: props.busy,
            onChange: (ev) => set({ name: ev.target.value }),
          })),
        h('div', null,
          h('label', { className: 'im-label' }, t('profiles.content')),
          h('textarea', {
            className: 'im-textarea',
            rows: 6,
            value: props.draft.content,
            maxLength: maxContent,
            placeholder: t('profiles.contentPlaceholder'),
            disabled: props.busy,
            onChange: (ev) => set({ content: ev.target.value }),
          })),
        h('div', { className: 'im-row-wrap' },
          h('button', {
            className: 'im-btn im-btn-primary',
            disabled: props.busy || !canSave,
            onClick: props.onSave,
          }, props.busy ? t('profiles.saving') : t('editor.save')),
          h('button', { className: 'im-btn', disabled: props.busy, onClick: props.onCancel }, t('editor.cancel'))))
    }

    function InstructionPanel() {
      const [view, setView] = React.useState(null)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [draft, setDraft] = React.useState(null)
      // The persona editor draft (null = closed). Independent of the entry
      // draft: editing an instruction never closes an open persona and vice
      // versa is handled by closing one when opening the other (see handlers).
      const [profileDraft, setProfileDraft] = React.useState(null)
      // Latest live values of the two editor drafts. switchSet's success
      // callback is a closure created at click time; between the click and the
      // response landing, a draft can still be opened (the busy flag only
      // re-renders on the next pass), so the callback must read the drafts
      // through refs to see what is REALLY open when the switch lands — a
      // stale `draft === null` would leave the old set's form on screen.
      const draftRef = React.useRef(null)
      draftRef.current = draft
      const profileDraftRef = React.useRef(null)
      profileDraftRef.current = profileDraft
      const [budgetText, setBudgetText] = React.useState('')
      // Latest live value of the draft, because the SSE onmessage closure below
      // is created once and must not read a stale first-render budgetText.
      const budgetTextRef = React.useRef('')
      budgetTextRef.current = budgetText
      const [showPreview, setShowPreview] = React.useState(false)
      const [query, setQuery] = React.useState('')
      const [undo, setUndo] = React.useState(null)
      // F2: tag/mode/status filters ('' = all) and the list sort key.
      const [tagFilter, setTagFilter] = React.useState('')
      const [modeFilter, setModeFilter] = React.useState('')
      const [statusFilter, setStatusFilter] = React.useState('')
      const [sortKey, setSortKey] = React.useState('priority')
      // F3: bulk-select mode and the chosen entry ids in it.
      const [batchMode, setBatchMode] = React.useState(false)
      const [selected, setSelected] = React.useState([])
      // F13: the set form (null = closed). One small inline form serves create,
      // rename and duplicate, because all three are "type a name and confirm".
      const [setForm, setSetForm] = React.useState(null)
      // F16: source mode holds its own draft + the rev the draft was read at.
      // Capturing the rev at READ time is what makes an external write in
      // between a conflict instead of a silent overwrite of someone else's edit.
      const [sourceMode, setSourceMode] = React.useState(false)
      const [sourceText, setSourceText] = React.useState('')
      const [sourceBaseRev, setSourceBaseRev] = React.useState(undefined)
      const [sourceVerdict, setSourceVerdict] = React.useState(null)
      // The body ceiling for the live check, mirrored into a ref so the
      // debounced effect never has to depend on the snapshot object.
      const sourceCeilingRef = React.useRef(0)
      // The source text as of the last read/save: openSource compares the
      // live draft against this to decide whether re-entering source mode
      // needs a discard confirmation.
      const sourceBaselineRef = React.useRef('')
      // F17: the local relevance preview.
      const [simOpen, setSimOpen] = React.useState(false)
      const [simQuery, setSimQuery] = React.useState('')
      // F14: the history list is fetched lazily, on first expand.
      const [historyOpen, setHistoryOpen] = React.useState(false)
      const [history, setHistory] = React.useState(null)
      const [historyBusy, setHistoryBusy] = React.useState(false)
      // F12: the diagnostics card is collapsed by default; a failed automatic
      // copy parks the dump here so it can be selected manually instead of
      // pretending the copy happened.
      const [diagOpen, setDiagOpen] = React.useState(false)
      const [diagFallback, setDiagFallback] = React.useState(null)
      // Feedback form: closed by default so the settings card stays compact.
      // The draft lives in the panel (not in a child) because the send handler
      // needs the same values the inputs show, and keeping them here survives
      // an SSE snapshot absorb while the user is typing.
      const [feedbackOpen, setFeedbackOpen] = React.useState(false)
      const [feedbackType, setFeedbackType] = React.useState('bug')
      const [feedbackTitle, setFeedbackTitle] = React.useState('')
      const [feedbackBody, setFeedbackBody] = React.useState('')
      const [feedbackContact, setFeedbackContact] = React.useState('')
      const [feedbackBusy, setFeedbackBusy] = React.useState(false)
      const [feedbackError, setFeedbackError] = React.useState('')
      const [feedbackSent, setFeedbackSent] = React.useState('')
      // F7: the pause menu (null-state boolean) and a 1s clock tick that exists
      // ONLY while a pause is live (its effect cleans up after itself). The
      // tick drives nothing but the remaining-time text; authority stays with
      // the host snapshot (injection.muted / data.disabledUntil).
      const [pauseMenuOpen, setPauseMenuOpen] = React.useState(false)
      const [nowTick, setNowTick] = React.useState(Date.now())
      // F18: the backup-location draft (focused-input protection like budget).
      const [backupText, setBackupText] = React.useState('')
      const backupTextRef = React.useRef('')
      backupTextRef.current = backupText
      const backupFocusedRef = React.useRef(false)
      const importInputRef = React.useRef(null)
      const restoreInputRef = React.useRef(null)
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

      // F7: tick once per second while a pause is live so the remaining-time
      // text counts down. The interval exists only while muted — the cleanup
      // clears it the moment the snapshot says otherwise. This effect sits
      // BEFORE the early returns (a hook skipped by a conditional return would
      // desync the hook order); it reads the snapshot through `view` because
      // the derived `injection` does not exist yet up here. The tick value
      // itself is only a re-render trigger; the rendered remaining time is
      // computed from Date.now() at render time (see below).
      const mutedNow = view !== null && view.injection !== null && typeof view.injection === 'object'
        && view.injection.muted === true
      React.useEffect(() => {
        if (!mutedNow) return undefined
        // A pause started from ANOTHER window replaces the menu row; the open
        // flag must not resurface when the row returns after expiry.
        setPauseMenuOpen(false)
        const tick = setInterval(() => setNowTick(Date.now()), 1000)
        return () => clearInterval(tick)
      }, [mutedNow])

      /**
       * F16 live validation, debounced: parsing on every keystroke would stall
       * the panel on a multi-megabyte paste, and 250 ms is below the threshold
       * where typing feels unsynced. The verdict is advisory — the authoritative
       * answer (including every correction the loader makes) comes from the
       * save itself.
       *
       * The ceiling comes through a ref, and the deps are only [sourceMode,
       * sourceText]: a new snapshot object arrives on every push (and the
       * ceiling never changes), so depending on the view would re-arm the timer
       * on every frame and the verdict would visibly lag the typing.
       */
      React.useEffect(() => {
        if (!sourceMode) return undefined
        const timer = setTimeout(() => {
          setSourceVerdict(sourceParseVerdict(sourceText, sourceCeilingRef.current))
        }, 250)
        return () => clearTimeout(timer)
      }, [sourceMode, sourceText])

      /**
       * The rev of the snapshot this panel is currently rendering. Sent back as
       * baseRev on every mutation so the Host can refuse a write built on a
       * stale view (another window or process changed the store in between)
       * instead of letting it overwrite blindly. Undefined against an older
       * Host whose snapshot carries no rev — JSON.stringify drops the key, so
       * the request stays byte-identical to what that Host expects.
       */
      const revOfFrom = (snapshot) => (snapshot !== null && typeof snapshot === 'object'
        && snapshot.data !== null && typeof snapshot.data === 'object'
        && typeof snapshot.data.rev === 'number'
        ? snapshot.data.rev
        : undefined)
      const revOf = () => revOfFrom(view)

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
        // The backup-location field follows the same rule as the budget input:
        // a push from another window never rewrites what is being typed.
        setBackupText(nextBudgetText(backupTextRef.current,
          typeof normalized.snapshot.data.backupDir === 'string' ? normalized.snapshot.data.backupDir : '',
          backupFocusedRef.current))
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

      // ---- F3 bulk actions: one request, one host-side transaction ----

      /** Selected ids that still exist in the latest snapshot. */
      const liveSelected = () => selected.filter((id) => data.entries.some((entry) => entry.id === id))

      function toggleSelected(id) {
        setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
      }

      function exitBatch() {
        setBatchMode(false)
        setSelected([])
      }

      async function doBatch(op, value) {
        const ids = liveSelected()
        if (ids.length === 0) {
          setError(t('batch.noneSelected'))
          return
        }
        if (op === 'delete'
          && typeof window.confirm === 'function'
          && !window.confirm(t('batch.confirmDelete', { count: ids.length }))) {
          return
        }
        const result = await send('batch', { op, ids, value, baseRev: revOf() })
        if (result !== null && result.ok === true && op === 'delete') {
          // Drop deleted ids from the selection; other ops keep it so several
          // bulk actions can be chained (e.g. set priority, then disable).
          setSelected((prev) => prev.filter((id) => !ids.includes(id)))
        }
      }

      function batchAddTags() {
        if (typeof window.prompt !== 'function') {
          setError(t('batch.promptUnavailable'))
          return
        }
        const answer = window.prompt(t('batch.tagPrompt', { count: liveSelected().length }), '')
        if (answer === null) return
        const tags = parseTagInput(answer)
        if (tags.length === 0) {
          setError(t('batch.tagEmpty'))
          return
        }
        void doBatch('add-tags', tags)
      }

      // ---- User persona ("用户形象") handlers ----

      async function saveProfileDraft() {
        if (profileDraft === null) return
        if (profileDraft.name.trim() === '' && profileDraft.content.trim() === '') return
        const result = await send('save-profile', { profile: cloneProfile(profileDraft), baseRev: revOf() })
        if (result !== null && result.ok === true) setProfileDraft(null)
      }

      function toggleProfile(profile) {
        if (busy) return
        const next = cloneProfile(profile)
        next.enabled = !profile.enabled
        void send('save-profile', { profile: next, baseRev: revOf() })
      }

      function editProfile(profile) {
        if (busy) return
        // The two editors are mutually exclusive so the panel stays legible.
        setDraft(null)
        setProfileDraft(cloneProfile(profile))
        setError('')
      }

      function removeProfile(profile) {
        if (busy) return
        if (typeof window.confirm === 'function'
          && !window.confirm(t('profiles.confirmDelete', {
            name: profile.name !== '' ? profile.name : t('profiles.untitled'),
          }))) return
        void send('delete-profile', { id: profile.id, baseRev: revOf() })
      }

      // ---- F13 instruction sets ----

      /** Switch the active set. The one click that changes what is injected. */
      function switchSet(id) {
        if (busy || id === '') return
        void send('set-active-set', { id, baseRev: revOf() }).then((result) => {
          // A switch invalidates any list selection: the ids belong to the set
          // that is no longer displayed.
          if (result !== null && result.ok === true) {
            setSelected([])
            setUndo(null)
            // Batch mode exists to act on listed ids; after a switch it would
            // act on ids from the wrong set, so it leaves with the selection.
            setBatchMode(false)
            // An editor left open across a switch is a form full of the OLD
            // set's content that would save into the NEW set. The server-side
            // cross-set guard means no data is lost, but the form itself is a
            // lie — so it closes with the switch, and the user is told. The
            // refs (not the closure state) say whether anything was open.
            setDraft(null)
            setProfileDraft(null)
            if (draftRef.current !== null || profileDraftRef.current !== null) {
              const base = typeof result.message === 'string' && result.message !== ''
                ? result.message + '；'
                : ''
              setNotice(base + t('sets.draftsClosed'))
            }
          }
        })
      }

      function submitSetForm() {
        if (setForm === null || busy) return
        const name = setForm.name.trim()
        if (name === '') {
          setError(t('sets.nameEmpty'))
          return
        }
        const call = setForm.mode === 'create'
          ? send('save-set', { set: { id: '', name }, baseRev: revOf() })
          : (setForm.mode === 'rename'
            ? send('save-set', { set: { id: setForm.id, name }, baseRev: revOf() })
            : send('duplicate-set', { id: setForm.id, name, baseRev: revOf() }))
        void call.then((result) => {
          if (result !== null && result.ok === true) setSetForm(null)
        })
      }

      function removeSet(set) {
        if (busy) return
        if (set.active === true) {
          setError(t('sets.deleteActive'))
          return
        }
        if (typeof window.confirm === 'function'
          && !window.confirm(t('sets.deleteConfirm', { name: set.name, entries: set.entries, profiles: set.profiles }))) return
        void send('delete-set', { id: set.id, baseRev: revOf() })
      }

      // ---- F14 version history ----

      async function loadHistory() {
        setHistoryBusy(true)
        try {
          const result = await callHost('history-list', null)
          const normalized = normalizeResult(result)
          if (normalized === null || result.history === undefined || result.history === null) {
            setError(t('err.unrecognized'))
            return
          }
          setHistory({ dir: String(result.history.dir || ''), items: Array.isArray(result.history.items) ? result.history.items : [] })
        } catch (err) {
          setError(String(err && err.message ? err.message : err))
        } finally {
          setHistoryBusy(false)
        }
      }

      function toggleHistory() {
        const next = !historyOpen
        setHistoryOpen(next)
        // Fetch on first expand (and on every expand after a write, so the list
        // matches the store the panel is showing).
        if (next) void loadHistory()
      }

      function rollbackTo(item) {
        if (busy || typeof window.confirm !== 'function') return
        const when = new Date(item.epoch).toLocaleString()
        if (!window.confirm(t('history.restoreConfirm', { time: when, rev: item.rev }))) return
        void send('history-restore', { name: item.name, baseRev: revOf() }).then((result) => {
          if (result !== null && result.ok === true) void loadHistory()
        })
      }

      function removeSnapshot(item) {
        if (busy) return
        if (typeof window.confirm === 'function' && !window.confirm(t('history.deleteConfirm'))) return
        void send('history-delete', { name: item.name }).then((result) => {
          if (result !== null && result.ok === true) void loadHistory()
        })
      }

      // ---- 反馈邮件 ----

      function toggleFeedback() {
        const next = !feedbackOpen
        setFeedbackOpen(next)
        setFeedbackError('')
        if (!next) setFeedbackSent('')
      }

      function clearFeedback() {
        setFeedbackType('bug')
        setFeedbackTitle('')
        setFeedbackBody('')
        setFeedbackContact('')
        setFeedbackError('')
        setFeedbackSent('')
      }

      /**
       * Send one report. The host validates again, enforces its own ceiling and
       * a cool-down, and decides the recipient from configuration — the panel
       * only supplies text plus the presentation facts (locale / time zone /
       * user agent). The error log deliberately carries the same reason the
       * user sees: a send failure is a configuration or network problem, and
       * the console is where a maintainer will look for it.
       */
      async function submitFeedback() {
        if (feedbackBusy) return
        const verdict = feedbackVerdict(feedbackType, feedbackTitle, feedbackBody, feedbackContact, view !== null ? view.limits : null)
        if (!verdict.ok) {
          setFeedbackSent('')
          setFeedbackError(verdict.message)
          return
        }
        setFeedbackBusy(true)
        setFeedbackError('')
        setFeedbackSent('')
        const nav = typeof navigator !== 'undefined' && navigator !== null ? navigator : {}
        let timezone = ''
        try {
          timezone = typeof Intl === 'object' && Intl !== null && typeof Intl.DateTimeFormat === 'function'
            ? String(Intl.DateTimeFormat().resolvedOptions().timeZone || '')
            : ''
        } catch (err) {
          timezone = ''
        }
        try {
          const result = await callHost('send-feedback', {
            type: verdict.value.type,
            title: verdict.value.title,
            body: verdict.value.body,
            contact: verdict.value.contact,
            locale: typeof nav.language === 'string' ? nav.language : '',
            userAgent: typeof nav.userAgent === 'string' ? nav.userAgent : '',
            timezone,
          })
          if (result === null || typeof result !== 'object' || result.ok !== true) {
            const message = result !== null && typeof result === 'object' && typeof result.message === 'string' && result.message !== ''
              ? result.message
              : t('feedback.failed')
            setFeedbackError(message)
            console.error('[instruction-memory] feedback failed:', message)
            return
          }
          setFeedbackSent(t('feedback.sent'))
          setFeedbackType('bug')
          setFeedbackTitle('')
          setFeedbackBody('')
          setFeedbackContact('')
        } catch (err) {
          const detail = String(err && err.message ? err.message : err)
          setFeedbackError(t('feedback.failedDetail', { detail }))
          console.error('[instruction-memory] feedback request failed:', detail)
        } finally {
          setFeedbackBusy(false)
        }
      }

      // ---- F16 source mode ----

      async function openSource() {
        if (busy) return
        if (draft !== null || profileDraft !== null) {
          setError(t('source.editorOpen'))
          return
        }
        // Re-entering source mode must not silently discard an unsaved source
        // draft: sourceText survives 退出源码模式 and reloadSource, and the
        // button stays reachable while source mode is open. The baseline is
        // the text as of the last read/save, so an untouched draft reopens
        // without friction.
        if (sourceText !== sourceBaselineRef.current && !confirmDiscard()) return
        try {
          const result = await callHost('read-source', null)
          if (result === null || typeof result !== 'object' || typeof result.source !== 'string') {
            // A refusal carries a reason (e.g. the file declares a newer format
            // version, so source mode is paused) — show THAT, not a generic
            // "unrecognized data".
            setError(result !== null && typeof result === 'object' && typeof result.message === 'string' && result.message !== ''
              ? result.message
              : t('err.unrecognized'))
            return
          }
          setSourceText(result.source)
          sourceBaselineRef.current = result.source
          setSourceBaseRev(revOfFrom(result.snapshot))
          setSourceVerdict(null)
          setSourceMode(true)
          setShowPreview(false)
          setSimOpen(false)
          setError('')
          setNotice('')
        } catch (err) {
          setError(String(err && err.message ? err.message : err))
        }
      }

      function reloadSource() {
        if (typeof window.confirm === 'function' && !window.confirm(t('source.reloadConfirm'))) return
        void openSource()
      }

      function saveSource() {
        if (busy) return
        void send('write-source', { text: sourceText, baseRev: sourceBaseRev }).then((result) => {
          if (result === null || result.ok !== true) return
          // The draft now matches the committed store, so the rev it is based
          // on must move with it — otherwise the very next save would be
          // refused as a conflict against our own write.
          setSourceBaseRev(revOfFrom(result.snapshot))
          sourceBaselineRef.current = sourceText
          void loadHistory()
        })
      }

      // ---- F18 backup location ----

      function applyBackupDir() {
        if (busy) return
        void send('set-options', { backupDir: backupText, baseRev: revOf() })
      }

      function exportToDir() {
        if (busy) return
        void send('export-to-dir', null)
      }

      // ---- F14 whole-store restore (the "replace" door import does not open) ----

      async function handleRestoreFile(file) {
        try {
          if (typeof window.confirm === 'function' && !window.confirm(t('restore.confirm'))) return
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
          await send('restore-data', { payload, baseRev: revOf() })
        } catch (err) {
          setError(String(err && err.message ? err.message : err))
        }
      }

      // ---- F12 diagnostics copy ----

      function copyDiagnostics() {
        if (view === null) return
        const text = diagnosticsText(view, {
          userAgent: typeof navigator !== 'undefined' && navigator.userAgent !== undefined ? String(navigator.userAgent) : '',
          language: typeof navigator !== 'undefined' && navigator.language !== undefined ? String(navigator.language) : '',
          now: new Date().toISOString(),
        })
        const clipboard = typeof navigator !== 'undefined' && navigator.clipboard
          && typeof navigator.clipboard.writeText === 'function' ? navigator.clipboard : null
        if (clipboard !== null) {
          clipboard.writeText(text).then(() => setNotice(t('diag.copied')), () => fallbackCopyDiagnostics(text))
          return
        }
        fallbackCopyDiagnostics(text)
      }

      /**
       * The webview may ship neither the async clipboard API nor
       * document.execCommand; then the only honest move is to surface the dump
       * in a selectable textarea instead of pretending the copy happened.
       */
      function fallbackCopyDiagnostics(text) {
        try {
          const area = document.createElement('textarea')
          area.value = text
          area.setAttribute('readonly', '')
          const host = document.body || document.head
          if (host && typeof host.appendChild === 'function') host.appendChild(area)
          if (typeof area.select === 'function') area.select()
          // execCommand may THROW (not merely return false); the detached
          // helper must leave the DOM on every path.
          let ok = false
          try {
            ok = typeof document.execCommand === 'function' && document.execCommand('copy') === true
          } finally {
            if (host && typeof host.removeChild === 'function' && area.parentNode === host) host.removeChild(area)
          }
          if (ok) {
            setNotice(t('diag.copied'))
            return
          }
          throw new Error('copy rejected')
        } catch {
          setDiagFallback(text)
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
      const limits = view.limits || {
        minBudget: 800, maxBudget: 40000, maxEntries: 200, maxProfiles: 50,
        maxSets: 20, maxSetName: 30, maxHistory: 20, maxBackupDir: 512,
      }
      // The feedback ceilings only exist on a Host that ships the feedback
      // route; an older Host hands over limits without them, so the form falls
      // back to the same defaults the validator uses.
      const feedbackMax = {
        title: typeof limits.maxFeedbackTitle === 'number' ? limits.maxFeedbackTitle : FEEDBACK_DEFAULTS.maxTitle,
        body: typeof limits.maxFeedbackBody === 'number' ? limits.maxFeedbackBody : FEEDBACK_DEFAULTS.maxBody,
        contact: typeof limits.maxFeedbackContact === 'number' ? limits.maxFeedbackContact : FEEDBACK_DEFAULTS.maxContact,
      }
      // Mirrored for the debounced source check (see its effect above): reading
      // it here keeps the effect's dependency list down to the text itself.
      sourceCeilingRef.current = typeof limits.maxBodyChars === 'number' ? limits.maxBodyChars : 0
      const injection = view.injection || { registered: false, chars: 0, error: null }
      // F12: the security block is optional (older Host) and then means "no
      // known problem" — an absent field must not manufacture a warning.
      const security = view.security !== null && typeof view.security === 'object'
        ? view.security
        : { hostGuarded: true, boundHost: '' }
      // List order is display-only and never changes what the Host injects
      // (the injection order is decided host-side). The default mirrors the
      // previous fixed order; updated-time and title are the other sorts.
      const sortEntries = (list) => {
        const copy = list.slice()
        if (sortKey === 'updated') {
          copy.sort((a, b) => (b.updatedAt - a.updatedAt) || (b.priority - a.priority))
        } else if (sortKey === 'title') {
          copy.sort((a, b) =>
            a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
            || (b.priority - a.priority)
            || (b.updatedAt - a.updatedAt))
        } else {
          copy.sort((a, b) => (b.priority - a.priority) || (b.updatedAt - a.updatedAt))
        }
        return copy
      }
      const entries = sortEntries(data.entries)
      const activeCount = data.entries.filter((e) => e.enabled && e.content !== '').length
      // Persona profiles, in stored order (stable injection order). Old hosts
      // simply have no array.
      const profiles = Array.isArray(data.profiles) ? data.profiles : []
      const activeProfiles = profiles.filter((p) => p.enabled === true && p.content !== '').length
      // Prefer the Host's rendered size (includes the shared header); fall
      // back to a local sum for hosts that do not publish the field yet.
      const profileChars = injection && typeof injection === 'object' && typeof injection.profileChars === 'number'
        ? injection.profileChars
        : profiles.reduce((n, p) => n + (p.enabled === true && p.content ? p.name.length + p.content.length + 5 : 0), 0)
      // Every tag actually in use, most frequent first (then name), for the
      // tag filter row.
      const allTags = (() => {
        const counts = new Map()
        for (const entry of data.entries) {
          for (const tag of Array.isArray(entry.tags) ? entry.tags : []) {
            if (typeof tag === 'string' && tag !== '') counts.set(tag, (counts.get(tag) || 0) + 1)
          }
        }
        return [...counts.entries()]
          .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }))
          .map(([tag]) => tag)
      })()
      // Budget usage + per-entry marks straight from the Host's injection plan.
      // Older hosts simply publish none of these fields: the meter falls back
      // to data.budgetChars and the maps stay empty.
      const meter = budgetMeter(view)
      /**
       * F13: the set list. A newer Host publishes the derived block (with
       * per-set counts and the active flag); an older one only has
       * data.sets/activeSetId, so the fallback builds the same shape with
       * zeroed counts rather than hiding the switcher.
       */
      const setsBlock = view.sets !== null && typeof view.sets === 'object' ? view.sets : null
      // A Host from before F13 publishes neither sets nor activeSetId; the set
      // UI is then simply absent instead of showing a made-up single set.
      const setsCapable = typeof data.activeSetId === 'string' && data.activeSetId !== ''
      const fallbackSets = setsCapable
        ? (Array.isArray(data.sets) && data.sets.length > 0
          ? data.sets
          : [{ id: data.activeSetId, name: t('sets.section') }])
        : []
      const setsList = setsBlock !== null && Array.isArray(setsBlock.list)
        ? setsBlock.list
        : fallbackSets.map((set) => ({
          id: set.id,
          name: set.name,
          active: set.id === data.activeSetId,
          entries: set.id === data.activeSetId ? data.entries.length : 0,
          profiles: set.id === data.activeSetId ? data.profiles.length : 0,
        }))
      const setsActiveId = setsBlock !== null && typeof setsBlock.activeId === 'string' ? setsBlock.activeId : data.activeSetId
      const setTotalEntries = setsBlock !== null && setsBlock.total && typeof setsBlock.total.entries === 'number'
        ? setsBlock.total.entries
        : data.entries.length
      const activeSetName = (setsList.find((set) => set.id === setsActiveId) || {}).name || ''
      // F17: the local preview scores the ACTIVE set's on-demand entries.
      // Disabled entries can never be injected, so scoring them as 预演 hits
      // would mislead — they are excluded from the preview entirely.
      const autoEntries = data.entries.filter((entry) => entry.mode === 'auto' && entry.enabled !== false)
      const sim = relevancePreview(autoEntries, simQuery)
      const simById = new Map(sim.results.map((hit) => [hit.id, hit]))
      const omittedById = new Map()
      const truncatedById = new Map()
      {
        const planItems = injection && typeof injection === 'object' ? injection : {}
        for (const item of Array.isArray(planItems.omitted) ? planItems.omitted : []) {
          if (item !== null && typeof item === 'object' && typeof item.id === 'string') omittedById.set(item.id, item)
        }
        for (const item of Array.isArray(planItems.included) ? planItems.included : []) {
          if (item !== null && typeof item === 'object' && item.truncated === true && typeof item.id === 'string') {
            truncatedById.set(item.id, item)
          }
        }
      }
      const keyword = query.trim().toLowerCase()
      const filtersActive = tagFilter !== '' || modeFilter !== '' || statusFilter !== ''
      const matchesFilters = (entry) => {
        if (tagFilter !== '' && !(Array.isArray(entry.tags) && entry.tags.includes(tagFilter))) return false
        if (modeFilter !== '' && entry.mode !== modeFilter) return false
        if (statusFilter === 'enabled' && entry.enabled !== true) return false
        if (statusFilter === 'disabled' && entry.enabled !== false) return false
        return true
      }
      const visible = entries.filter((entry) => {
        if (!matchesFilters(entry)) return false
        if (keyword === '') return true
        const inTags = (Array.isArray(entry.tags) ? entry.tags.join(' ') : '').toLowerCase()
        return entry.title.toLowerCase().indexOf(keyword) !== -1
          || entry.content.toLowerCase().indexOf(keyword) !== -1
          || entry.when.toLowerCase().indexOf(keyword) !== -1
          || inTags.indexOf(keyword) !== -1
      })

      const dotClass = injection.error
        ? 'im-dot im-dot-err'
        : (injection.registered ? 'im-dot im-dot-on' : 'im-dot im-dot-off')
      const dotText = injection.error
        ? injection.error
        : (injection.registered
          ? t('status.mounted', { chars: injection.chars })
          : (activeCount === 0 ? t('status.notMountedEmpty') : t('status.notMounted')))
      // F12: display-only rows. Every value comes straight from the snapshot;
      // a missing field (older Host) degrades to （无） instead of throwing
      // mid-render.
      const diagValue = (value) => (value === null || value === undefined || value === '' ? t('diag.none') : String(value))
      const diagYesNo = (value) => (value === true ? t('diag.yes') : t('diag.no'))
      const diagRow = (label, value) => h('div', { className: 'im-meta' }, label + '：' + value)
      const diagLoadedFrom = view.diagnostics !== null && typeof view.diagnostics === 'object'
        ? view.diagnostics.loadedFrom
        : null
      const diagRev = view.diagnostics !== null && typeof view.diagnostics === 'object'
        && typeof view.diagnostics.rev === 'number'
        ? view.diagnostics.rev
        : (data.rev || 0)
      // F7: the pause decision itself belongs to the host (injection.muted);
      // the countdown below is display-only. The remaining time is computed
      // from the clock AT RENDER TIME — a stale tick value could be days old
      // (the interval only runs while a pause is live), which would inflate
      // the first frame of a later pause. The 1s interval exists purely to
      // trigger re-renders; at zero the bar yields back to the normal control.
      const muted = injection.muted === true
      const disabledUntil = typeof data.disabledUntil === 'number' && Number.isFinite(data.disabledUntil)
        ? data.disabledUntil
        : 0
      const muteRemainingMs = muted ? Math.max(0, disabledUntil - Date.now()) : 0
      const muteRemainingText = (ms) => {
        const totalSec = Math.max(0, Math.round(ms / 1000))
        const hh = Math.floor(totalSec / 3600)
        const mm = Math.floor((totalSec % 3600) / 60)
        const ss = totalSec % 60
        return hh > 0 ? t('mute.remainingH', { h: hh, m: mm }) : t('mute.remainingMs', { m: mm, s: ss })
      }
      const endOfToday = () => {
        const d = new Date()
        d.setHours(24, 0, 0, 0)
        return d.getTime()
      }
      function pauseFor(ms) {
        if (busy || typeof ms !== 'number' || !(ms > 0)) return
        setPauseMenuOpen(false)
        void send('set-options', { disabledUntil: Date.now() + ms, baseRev: revOf() })
      }
      function resumePause() {
        if (busy) return
        setPauseMenuOpen(false)
        void send('set-options', { disabledUntil: 0, baseRev: revOf() })
      }

      // Feedback is the first row of the settings card so it is immediately
      // visible; source mode keeps its own header and never reaches it.
      const feedbackCard = h('div', { key: 'feedback', className: 'im-feedback' },
        h('div', { className: 'im-feedback-head' },
          h('span', { className: 'im-section-title' }, t('feedback.section')),
          h('span', { className: 'im-spacer' }),
          h('button', {
            className: feedbackOpen ? 'im-btn' : 'im-btn im-btn-primary',
            disabled: busy,
            onClick: toggleFeedback,
          }, feedbackOpen ? t('feedback.hide') : t('feedback.show'))),
        feedbackOpen
          ? h('div', { className: 'im-feedback-form' },
            h('div', { className: 'im-meta' }, t('feedback.intro')),
            h('div', { className: 'im-grid2' },
              h('div', null,
                h('label', { className: 'im-label' }, t('feedback.typeLabel')),
                h('select', {
                  className: 'im-select',
                  value: feedbackType,
                  disabled: feedbackBusy,
                  onChange: (ev) => setFeedbackType(String(ev.target.value)),
                },
                  h('option', { value: 'bug' }, t('feedback.typeBug')),
                  h('option', { value: 'suggestion' }, t('feedback.typeSuggestion')),
                  h('option', { value: 'other' }, t('feedback.typeOther')))),
              h('div', null,
                h('label', { className: 'im-label' }, t('feedback.contactLabel')),
                h('input', {
                  className: 'im-input',
                  type: 'text',
                  value: feedbackContact,
                  maxLength: feedbackMax.contact,
                  placeholder: t('feedback.contactPlaceholder'),
                  disabled: feedbackBusy,
                  onChange: (ev) => setFeedbackContact(String(ev.target.value)),
                }))),
            h('div', null,
              h('label', { className: 'im-label' }, t('feedback.titleLabel')),
              h('input', {
                className: 'im-input',
                type: 'text',
                value: feedbackTitle,
                maxLength: feedbackMax.title,
                placeholder: t('feedback.titlePlaceholder'),
                disabled: feedbackBusy,
                onChange: (ev) => setFeedbackTitle(String(ev.target.value)),
              })),
            h('div', null,
              h('label', { className: 'im-label' }, t('feedback.bodyLabel')),
              h('textarea', {
                className: 'im-textarea',
                value: feedbackBody,
                maxLength: feedbackMax.body,
                placeholder: t('feedback.bodyPlaceholder'),
                disabled: feedbackBusy,
                onChange: (ev) => setFeedbackBody(String(ev.target.value)),
              })),
            h('div', { className: 'im-meta' }, t('feedback.hint')),
            // Send failures are shown next to the form and never replace the
            // panel-wide error line: a mail problem must not look like a
            // storage problem.
            feedbackError !== '' ? h('div', { className: 'im-err' }, feedbackError) : null,
            feedbackSent !== '' ? h('div', { className: 'im-ok' }, feedbackSent) : null,
            h('div', { className: 'im-feedback-actions' },
              h('button', {
                className: 'im-btn im-btn-primary',
                disabled: feedbackBusy,
                onClick: () => { void submitFeedback() },
              }, feedbackBusy ? t('feedback.sending') : t('feedback.send')),
              h('button', {
                className: 'im-btn',
                disabled: feedbackBusy,
                onClick: clearFeedback,
              }, t('feedback.clear'))))
          : null)

      const header = h('div', { className: 'im-card', key: 'head' },
        feedbackCard,
        // F12: the non-loopback warning stays high in the panel — directly
        // under the feedback entry — so it cannot be missed.
        security.hostGuarded === false
          ? h('div', { className: 'im-hostwarn', key: 'hostwarn' },
            t('diag.hostWarn', { host: security.boundHost !== '' ? security.boundHost : '?' }))
          : null,
        h('div', { className: 'im-row' },
          h('div', null,
            h('h3', { className: 'im-h' }, t('panel.title')),
            h('p', { className: 'im-sub' }, t('panel.subtitle'))),
          h('div', { className: 'im-master-col' },
            h('label', { className: 'im-switch' },
              h('input', {
                type: 'checkbox',
                checked: data.enabled === true,
                disabled: busy,
                onChange: () => send('set-options', { enabled: !data.enabled, baseRev: revOf() }),
              }),
              t('panel.masterSwitch')),
            // F7 临时静音：暂停期间提示词与「未安装插件」逐字节一致；到期由宿主定时器
            // 自动恢复，无需用户操作、不写盘。倒计时只是展示，权威在快照。
            muted && muteRemainingMs > 0
              ? h('div', { className: 'im-pause-bar' },
                h('span', null, t('mute.active', { remaining: muteRemainingText(muteRemainingMs) })),
                h('button', { className: 'im-btn', disabled: busy, onClick: resumePause }, t('mute.resume')))
              : h('div', { className: 'im-pause-row' },
                h('button', {
                  className: 'im-btn',
                  disabled: busy,
                  onClick: () => setPauseMenuOpen(!pauseMenuOpen),
                }, t('mute.menu')),
                pauseMenuOpen
                  ? h('div', { className: 'im-pause-menu' },
                    h('button', { className: 'im-btn', disabled: busy, onClick: () => pauseFor(30 * 60000) }, t('mute.30m')),
                    h('button', { className: 'im-btn', disabled: busy, onClick: () => pauseFor(60 * 60000) }, t('mute.1h')),
                    h('button', { className: 'im-btn', disabled: busy, onClick: () => pauseFor(endOfToday() - Date.now()) }, t('mute.today')),
                    h('div', { className: 'im-meta' }, t('mute.hint')))
                  : null))),
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
        (data.enabled === true && activeCount > 0)
          ? h('div', { key: 'meter' },
            h('div', { className: 'im-meter' },
              h('div', {
                className: 'im-meter-fill' + (meter.omitted > 0 ? ' im-meter-fill-warn' : ''),
                style: { width: meter.percent + '%' },
              })),
            h('div', { className: 'im-meta im-meter-line' },
              t('budget.used', { used: meter.used, budget: meter.budget, tokens: meter.tokens })),
            meter.omitted > 0
              ? h('div', { className: 'im-warn im-meter-line' }, t('budget.omitted', { count: meter.omitted }))
              : null)
          : null,
        // ---- F13 配置集：列表 + 切换（唯一会改变注入内容的动作） ----
        setsList.length > 0
          ? h('div', { key: 'sets', className: 'im-sets' },
            h('div', { className: 'im-sets-row' },
              h('span', { className: 'im-section-title' }, t('sets.section')),
              h('span', { className: 'im-spacer' }),
              h('span', { className: 'im-meta' }, t('sets.total', { total: setTotalEntries, max: limits.maxEntries })),
              h('button', {
                className: 'im-btn',
                disabled: busy || setsList.length >= limits.maxSets,
                onClick: () => { setSetForm({ mode: 'create', id: '', name: '' }); setError('') },
              }, t('sets.create'))),
            h('div', { className: 'im-meta' }, t('sets.note')),
            setsList.map((set) => h('div', { className: 'im-sets-row', key: set.id },
              set.active === true
                ? h('span', { className: 'im-active-dot', title: t('sets.activeHint', { name: set.name }) })
                : h('span', { className: 'im-dot' }),
              h('span', { className: 'im-title' }, set.name),
              h('span', { className: 'im-meta' }, t('sets.itemMeta', { entries: set.entries, profiles: set.profiles })),
              set.active === true
                ? h('span', { className: 'im-tag im-tag-always' }, t('sets.activeBadge'))
                : null,
              h('span', { className: 'im-spacer' }),
              set.active === true
                ? null
                : h('button', {
                  className: 'im-btn im-btn-primary',
                  disabled: busy,
                  title: t('sets.switchHint'),
                  onClick: () => switchSet(set.id),
                }, t('sets.switch')),
              h('button', {
                className: 'im-btn',
                disabled: busy,
                onClick: () => { setSetForm({ mode: 'rename', id: set.id, name: set.name }); setError('') },
              }, t('sets.rename')),
              h('button', {
                className: 'im-btn',
                disabled: busy || setTotalEntries + set.entries > limits.maxEntries,
                onClick: () => { setSetForm({ mode: 'duplicate', id: set.id, name: set.name + t('sets.copySuffix') }); setError('') },
              }, t('sets.duplicate')),
              set.active === true
                ? null
                : h('button', {
                  className: 'im-btn im-btn-danger',
                  disabled: busy,
                  onClick: () => removeSet(set),
                }, t('sets.delete')))),
            setForm !== null
              ? h('div', { className: 'im-inline-form' },
                h('span', { className: 'im-meta' }, t('sets.nameLabel')),
                h('input', {
                  className: 'im-input',
                  value: setForm.name,
                  maxLength: limits.maxSetName,
                  disabled: busy,
                  placeholder: t('sets.namePlaceholder'),
                  onChange: (ev) => setSetForm({ mode: setForm.mode, id: setForm.id, name: ev.target.value }),
                  onKeyDown: (ev) => { if (ev.key === 'Enter') submitSetForm() },
                }),
                h('button', { className: 'im-btn im-btn-primary', disabled: busy, onClick: submitSetForm }, t('sets.confirm')),
                h('button', { className: 'im-btn', disabled: busy, onClick: () => setSetForm(null) }, t('editor.cancel')))
              : null)
          : null,
        // ---- User persona ("用户形象"): facts about the USER, not a role ----
        h('div', { key: 'profiles', className: 'im-profiles' },
          h('div', { className: 'im-profiles-head' },
            h('span', { className: 'im-section-title' }, t('profiles.section')),
            h('button', {
              className: 'im-btn im-btn-primary',
              disabled: busy,
              onClick: () => { setProfileDraft(blankProfileDraft()); setDraft(null); setError('') },
            }, t('profiles.new')),
            h('span', { className: 'im-spacer' }),
            h('span', { className: 'im-meta' }, t('profiles.count', { total: profiles.length, active: activeProfiles }))),
          h('div', { className: 'im-meta im-profile-sub' }, t('profiles.subtitle')),
          profileDraft !== null
            ? h(ProfileEditor, {
              draft: profileDraft,
              busy: busy,
              limits: view !== null && view.limits ? view.limits : null,
              onChange: setProfileDraft,
              onSave: saveProfileDraft,
              onCancel: () => setProfileDraft(null),
            })
            : null,
          profiles.length === 0 && profileDraft === null
            ? h('div', { className: 'im-empty' }, t('profiles.empty'))
            : profiles.map((profile) => h('div', {
              className: 'im-profile-item' + (profile.enabled === true ? '' : ' im-profile-item-off'),
              key: profile.id,
            },
              h('div', { className: 'im-item-head' },
                h('span', { className: 'im-profile-name' },
                  profile.name !== '' ? profile.name : t('profiles.untitled')),
                h('span', { className: 'im-spacer' }),
                h('label', { className: 'im-switch' },
                  h('input', {
                    type: 'checkbox',
                    checked: profile.enabled === true,
                    disabled: busy,
                    onChange: () => toggleProfile(profile),
                  }),
                  t('profiles.use')),
                h('button', {
                  className: 'im-btn',
                  disabled: busy,
                  onClick: () => editProfile(profile),
                }, t('entry.edit')),
                h('button', {
                  className: 'im-btn im-btn-danger',
                  disabled: busy,
                  onClick: () => removeProfile(profile),
                }, t('entry.delete'))),
              h(EntryBody, { text: profile.content, key: 'body' }),
              profile.updatedAt > 0
                ? h('div', { className: 'im-meta' }, t('entry.updatedAt', { time: new Date(profile.updatedAt).toLocaleString() }))
                : null)),
          activeProfiles > 0
            ? h('div', { className: 'im-meta im-meter-line' }, t('profiles.chars', { count: profileChars }))
            : null),
        // F3 bulk action bar, only while in multi-select mode. "Select all"
        // covers the currently visible (filtered/searched) entries.
        (batchMode && entries.length > 0)
          ? h('div', { key: 'batchbar', className: 'im-batch-bar' },
            h('label', { className: 'im-switch' },
              h('input', {
                type: 'checkbox',
                className: 'im-batch-check',
                checked: visible.length > 0 && visible.every((entry) => selected.includes(entry.id)),
                disabled: busy,
                onChange: (ev) => {
                  const visibleIds = visible.map((entry) => entry.id)
                  if (ev.target.checked) {
                    setSelected([...new Set([...selected, ...visibleIds])])
                  } else {
                    setSelected(selected.filter((id) => !visibleIds.includes(id)))
                  }
                },
              }),
              t('batch.selectAll')),
            h('span', { className: 'im-meta' }, t('batch.selected', { count: liveSelected().length })),
            h('button', { className: 'im-btn', disabled: busy, onClick: () => doBatch('set-enabled', true) }, t('batch.enable')),
            h('button', { className: 'im-btn', disabled: busy, onClick: () => doBatch('set-enabled', false) }, t('batch.disable')),
            h('select', {
              className: 'im-select im-select-sm',
              defaultValue: '',
              disabled: busy,
              onChange: (ev) => {
                const v = Number(ev.target.value)
                if (v === 0 || v === 1 || v === 2) void doBatch('set-priority', v)
                ev.target.value = ''
              },
            },
              h('option', { value: '' }, t('batch.priority')),
              h('option', { value: '2' }, t('priority.high')),
              h('option', { value: '1' }, t('priority.normal')),
              h('option', { value: '0' }, t('priority.low'))),
            h('button', { className: 'im-btn', disabled: busy, onClick: batchAddTags }, t('batch.addTags')),
            h('span', { className: 'im-spacer' }),
            h('button', {
              className: 'im-btn im-btn-danger',
              disabled: busy,
              onClick: () => doBatch('delete', undefined),
            }, t('batch.delete')),
            h('button', { className: 'im-btn', disabled: busy, onClick: exitBatch }, t('batch.exit')))
          : null,
        // ---- F17 本地预演：字面关键词匹配「按需」条目（不是模型真实判断） ----
        (data.enabled === true && autoEntries.length > 0)
          ? h('div', { key: 'sim', className: 'im-profiles' },
            h('div', { className: 'im-profiles-head' },
              h('span', { className: 'im-section-title' }, t('sim.title')),
              h('span', { className: 'im-spacer' }),
              h('button', {
                className: 'im-btn',
                disabled: busy,
                onClick: () => setSimOpen(!simOpen),
              }, simOpen ? t('sim.hide') : t('sim.toggle'))),
            simOpen
              ? h('div', null,
                // The disclaimer is deliberately NOT small print in grey: it is
                // a warning that this is a heuristic, so it reads as one.
                h('div', { className: 'im-warn im-profile-sub' }, t('sim.disclaimer')),
                h('input', {
                  className: 'im-input',
                  value: simQuery,
                  disabled: busy,
                  placeholder: t('sim.placeholder'),
                  onChange: (ev) => setSimQuery(ev.target.value),
                }),
                h('div', { className: 'im-meta im-meter-line' }, t('sim.onlyAuto')),
                simQuery.trim() === ''
                  ? h('div', { className: 'im-meta im-meter-line' }, t('sim.hint'))
                  : h('div', { className: 'im-sim-result' },
                    h('div', { className: 'im-meta' }, t('sim.summary', { total: sim.autoTotal, hit: sim.results.length })),
                    sim.results.length === 0
                      ? h('div', { className: 'im-meta' }, t('sim.none'))
                      : sim.results.slice(0, 8).map((hit) => {
                        const entry = data.entries.find((candidate) => candidate.id === hit.id)
                        if (entry === undefined) return null
                        return h('div', { className: 'im-sim-item', key: hit.id },
                          h('span', { className: 'im-title' }, entry.title !== '' ? entry.title : t('entry.untitled')),
                          h('span', { className: 'im-tag im-tag-sim-' + hit.level },
                            hit.level === 'high' ? t('sim.levelHigh') : (hit.level === 'mid' ? t('sim.levelMid') : t('sim.levelLow'))),
                          h('span', { className: 'im-meta' }, t('sim.matched', { terms: hit.terms.join(' / ') })),
                          hit.whenEmpty ? h('span', { className: 'im-warn' }, t('sim.noWhen')) : null,
                          omittedById.has(hit.id) ? h('span', { className: 'im-tag im-tag-off' }, t('sim.omitted')) : null)
                      })))
              : null)
          : null,
        // F2 filters: tag chips (only when tags exist) plus mode/status/sort.
        entries.length > 0
          ? h('div', { key: 'filters', className: 'im-filter-row' },
            allTags.length > 0
              ? h('div', { className: 'im-filter-chips' },
                h('button', {
                  type: 'button',
                  className: 'im-filter-chip' + (tagFilter === '' ? ' im-filter-chip-on' : ''),
                  onClick: () => setTagFilter(''),
                }, t('filter.all')),
                allTags.map((tag) => h('button', {
                  type: 'button',
                  key: tag,
                  className: 'im-filter-chip' + (tagFilter === tag ? ' im-filter-chip-on' : ''),
                  title: t('filter.tag'),
                  onClick: () => setTagFilter(tagFilter === tag ? '' : tag),
                }, tag)))
              : null,
            h('div', { className: 'im-filter-selects' },
              h('label', { className: 'im-fselect' }, t('filter.mode'),
                h('select', {
                  className: 'im-select im-select-sm',
                  value: modeFilter,
                  onChange: (ev) => setModeFilter(ev.target.value),
                },
                  h('option', { value: '' }, t('filter.all')),
                  h('option', { value: 'always' }, t('filter.modeAlways')),
                  h('option', { value: 'auto' }, t('filter.modeAuto')))),
              h('label', { className: 'im-fselect' }, t('filter.status'),
                h('select', {
                  className: 'im-select im-select-sm',
                  value: statusFilter,
                  onChange: (ev) => setStatusFilter(ev.target.value),
                },
                  h('option', { value: '' }, t('filter.all')),
                  h('option', { value: 'enabled' }, t('filter.statusEnabled')),
                  h('option', { value: 'disabled' }, t('filter.statusDisabled')))),
              h('label', { className: 'im-fselect' }, t('sort.label'),
                h('select', {
                  className: 'im-select im-select-sm',
                  value: sortKey,
                  onChange: (ev) => setSortKey(ev.target.value),
                },
                  h('option', { value: 'priority' }, t('sort.priority')),
                  h('option', { value: 'updated' }, t('sort.updated')),
                  h('option', { value: 'title' }, t('sort.title'))))))
          : null,
        entries.length > 0 ? h('div', { key: 'search' },
          h('input', {
            className: 'im-input',
            value: query,
            placeholder: t('search.placeholder', { count: entries.length }),
            onChange: (ev) => setQuery(ev.target.value),
          }),
          (query.trim() !== '' || filtersActive)
            ? h('div', { className: 'im-meta im-search-meta' }, t('search.matchCount', { shown: visible.length, total: entries.length }))
            : null) : null,
        h('div', { className: 'im-row-wrap' },
          h('button', {
            className: 'im-btn im-btn-primary',
            disabled: busy,
            onClick: () => { setDraft(blankDraft()); setProfileDraft(null); setError('') },
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
            title: t('restore.hint'),
            onClick: () => {
              const el = restoreInputRef.current
              if (el !== null && el !== undefined) el.click()
            },
          }, t('action.restore')),
          h('button', {
            className: 'im-btn',
            disabled: busy || draft !== null || profileDraft !== null,
            onClick: () => { void openSource() },
          }, t('source.mode')),
          h('button', {
            className: 'im-btn',
            disabled: busy,
            onClick: () => setShowPreview(!showPreview),
          }, showPreview ? t('action.hidePreview') : t('action.showPreview')),
          h('button', {
            className: 'im-btn',
            disabled: busy || entries.length === 0,
            onClick: () => { setBatchMode(!batchMode); setSelected([]) },
          }, batchMode ? t('batch.exit') : t('action.batch')),
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
        // ---- F18 备份位置 ----
        h('div', { key: 'backup', className: 'im-backup' },
          h('div', { className: 'im-section-title' }, t('backup.section')),
          h('label', { className: 'im-label' }, t('backup.label')),
          h('div', { className: 'im-backup-row' },
            h('input', {
              className: 'im-input',
              value: backupText,
              disabled: busy,
              maxLength: limits.maxBackupDir,
              placeholder: t('backup.placeholder'),
              onFocus: () => { backupFocusedRef.current = true },
              onChange: (ev) => setBackupText(ev.target.value),
              onBlur: () => { backupFocusedRef.current = false },
            }),
            h('button', { className: 'im-btn im-btn-primary', disabled: busy, onClick: applyBackupDir }, t('backup.apply')),
            h('button', { className: 'im-btn', disabled: busy, onClick: exportToDir }, t('backup.exportToDir'))),
          h('div', { className: 'im-meta' }, t('backup.hint')),
          h('div', { className: 'im-meta' }, t('backup.multiDevice'))),
        // ---- F14 版本历史 ----
        h('div', { key: 'history', className: 'im-history' },
          h('div', { className: 'im-profiles-head' },
            h('span', { className: 'im-section-title' }, t('history.section')),
            h('span', { className: 'im-spacer' }),
            history !== null ? h('span', { className: 'im-meta' }, t('history.count', { count: history.items.length })) : null,
            h('button', { className: 'im-btn', disabled: busy, onClick: toggleHistory }, historyOpen ? t('history.hide') : t('history.show'))),
          h('div', { className: 'im-meta im-profile-sub' }, t('history.subtitle', { max: limits.maxHistory })),
          historyOpen
            ? (historyBusy && history === null
              ? h('div', { className: 'im-meta' }, t('history.loading'))
              : (history === null || history.items.length === 0
                ? h('div', { className: 'im-meta' }, t('history.empty'))
                : h('div', { className: 'im-list-scroll' }, history.items.map((item) => {
                  const when = new Date(item.epoch).toLocaleString()
                  const size = Math.max(1, Math.round(item.bytes / 1024))
                  return h('div', {
                    className: 'im-history-item' + (item.rev === data.rev ? ' im-history-item-current' : ''),
                    key: item.name,
                  },
                    h('span', { className: 'im-title' }, when),
                    h('span', { className: 'im-tag' }, 'rev ' + item.rev),
                    h('span', { className: 'im-history-sub' },
                      item.entries === null
                        ? t('history.itemMetaLite', { size })
                        : t('history.itemMeta', {
                          entries: item.entries,
                          profiles: item.profiles === null ? 0 : item.profiles,
                          size,
                        })),
                    item.foreign === true ? h('span', { className: 'im-tag im-tag-off' }, t('history.foreign', { device: item.device })) : null,
                    h('span', { className: 'im-spacer' }),
                    h('button', { className: 'im-btn', disabled: busy, onClick: () => rollbackTo(item) }, t('history.restore')),
                    h('button', { className: 'im-btn im-btn-danger', disabled: busy, onClick: () => removeSnapshot(item) }, t('history.delete')))
                }))))
            : null,
          history !== null && history.dir !== ''
            ? h('div', { className: 'im-meta' }, t('history.dir', { dir: history.dir }))
            : null),
        // ---- F12 诊断与安全状态（默认收起；纯展示，无写路由） ----
        h('div', { key: 'diag', className: 'im-diag' },
          h('div', { className: 'im-profiles-head' },
            h('span', { className: 'im-section-title' }, t('diag.section')),
            h('span', { className: 'im-spacer' }),
            h('button', { className: 'im-btn', disabled: busy, onClick: () => setDiagOpen(!diagOpen) },
              diagOpen ? t('diag.hide') : t('diag.show')),
            h('button', { className: 'im-btn', disabled: busy, onClick: copyDiagnostics }, t('diag.copy'))),
          diagOpen
            ? h('div', null,
              h('div', { className: 'im-diag-group' },
                h('span', { className: 'im-section-title im-diag-sub' }, t('diag.groupStorage')),
                diagRow(t('diag.storagePath'), diagValue(storage.path)),
                diagRow(t('diag.onDisk'), diagYesNo(storage.onDisk === true)),
                diagRow(t('diag.loadedFrom'), diagValue(diagLoadedFrom)),
                diagRow(t('diag.savedAt'), typeof storage.savedAt === 'number' && storage.savedAt > 0
                  ? new Date(storage.savedAt).toLocaleString()
                  : t('diag.none')),
                diagRow(t('diag.rev'), String(diagRev))),
              h('div', { className: 'im-diag-group' },
                h('span', { className: 'im-section-title im-diag-sub' }, t('diag.groupInjection')),
                diagRow(t('diag.registered'), diagYesNo(injection.registered === true)),
                diagRow(t('diag.pulls'), String(typeof injection.pulls === 'number' ? injection.pulls : 0)),
                diagRow(t('diag.chars'),
                  String(typeof injection.chars === 'number' ? injection.chars : 0) + ' / '
                  + String(typeof injection.budget === 'number' ? injection.budget : data.budgetChars))),
              h('div', { className: 'im-diag-group' },
                h('span', { className: 'im-section-title im-diag-sub' }, t('diag.groupBackup')),
                diagRow(t('diag.backupDir'), typeof storage.backupDir === 'string' && storage.backupDir !== ''
                  ? storage.backupDir
                  : t('diag.backupDefault')),
                diagRow(t('diag.backupPath'), diagValue(storage.backupPath)),
                diagRow(t('diag.historyDir'), diagValue(storage.historyDir)),
                diagRow(t('diag.historyCount'), String(typeof storage.historyCount === 'number' ? storage.historyCount : 0)),
                diagRow(t('diag.schemaFile'), diagValue(storage.schemaFile))),
              h('div', { className: 'im-diag-group' },
                h('span', { className: 'im-section-title im-diag-sub' }, t('diag.groupIssues')),
                diagRow(t('diag.issueStorage'), diagValue(storage.error)),
                diagRow(t('diag.issueWarning'), diagValue(storage.warning)),
                diagRow(t('diag.issueHistory'), diagValue(storage.historyError)),
                diagRow(t('diag.issueSection'), diagValue(injection.error))),
              diagFallback !== null
                ? h('div', { className: 'im-diag-fallback' },
                  h('div', { className: 'im-meta' }, t('diag.copyManual')),
                  h('textarea', {
                    className: 'im-textarea',
                    readOnly: true,
                    value: diagFallback,
                    onFocus: (ev) => { if (typeof ev.target.select === 'function') ev.target.select() },
                  }))
                : null)
            : null),
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
        }),
        // F14: the whole-store restore picker. A separate input because its
        // confirmation and its semantics (replace, not merge) differ from import.
        h('input', {
          key: 'restore-input',
          type: 'file',
          accept: '.json,application/json',
          style: { display: 'none' },
          ref: restoreInputRef,
          onChange: (ev) => {
            const file = ev.target.files && ev.target.files.length > 0 ? ev.target.files[0] : null
            ev.target.value = ''
            if (file !== null) void handleRestoreFile(file)
          },
        }))

      /**
       * F16 源码模式 replaces the list area entirely: editing the raw JSON and
       * editing the cards are two views of ONE store, so they are never shown
       * at once (and the entry/persona editors must be closed first — see
       * openSource). The header card stays visible so the master switch, the
       * budget and the set switcher remain reachable.
       */
      if (sourceMode) {
        const canSave = sourceVerdict === null || sourceVerdict.ok === true || sourceVerdict.paused === true
        return h('div', { className: 'im-root' },
          header,
          h('div', { className: 'im-card' },
            h('div', { className: 'im-profiles-head' },
              h('span', { className: 'im-section-title' }, t('source.section')),
              h('span', { className: 'im-spacer' }),
              sourceBaseRev !== undefined
                ? h('span', { className: 'im-meta' }, 'rev ' + sourceBaseRev)
                : null),
            h('div', { className: 'im-meta' }, t('source.subtitle')),
            h('div', { className: 'im-source' },
              h('textarea', {
                className: 'im-textarea im-textarea-source',
                value: sourceText,
                disabled: busy,
                spellCheck: false,
                onChange: (ev) => setSourceText(ev.target.value),
              }),
              sourceVerdict !== null
                ? h('div', { className: sourceVerdict.ok ? 'im-source-ok' : 'im-warn' }, sourceVerdict.message)
                : null,
              error !== '' ? h('div', { className: 'im-err' }, error) : null,
              // Saving can be refused (a conflict, a future version, a shape
              // problem). The draft is never thrown away by a refusal, and the
              // user needs to know that before deciding what to do next.
              error !== '' ? h('div', { className: 'im-meta' }, t('source.keepDraft')) : null,
              error === '' && notice !== '' ? h('div', { className: 'im-ok' }, notice) : null,
              h('div', { className: 'im-row-wrap' },
                h('button', {
                  className: 'im-btn im-btn-primary',
                  disabled: busy || !canSave,
                  onClick: saveSource,
                }, busy ? t('editor.saving') : t('source.save')),
                h('button', { className: 'im-btn', disabled: busy, onClick: reloadSource }, t('source.reload')),
                h('span', { className: 'im-spacer' }),
                h('button', {
                  className: 'im-btn',
                  disabled: busy,
                  onClick: () => { setSourceMode(false); setSourceVerdict(null); setError(''); setNotice('') },
                }, t('source.exit'))))))
      }

      const items = visible.map((entry) => {
        const tags = [
          h('span', {
            className: 'im-tag ' + (entry.mode === 'always' ? 'im-tag-always' : 'im-tag-auto'),
            key: 'mode',
          }, entry.mode === 'always' ? t('tag.always') : t('tag.auto')),
        ]
        if (entry.priority === 2) tags.push(h('span', { className: 'im-tag im-tag-high', key: 'p' }, t('priority.high')))
        else if (entry.priority === 0) tags.push(h('span', { className: 'im-tag', key: 'p' }, t('priority.low')))
        // Budget marks from the Host's injection plan. Only active entries can
        // appear in the plans, so a disabled entry never gets a stale mark.
        if (omittedById.has(entry.id)) {
          tags.push(h('span', {
            className: 'im-tag im-tag-off', key: 'off', title: t('tag.omittedTitle'),
          }, t('tag.omitted')))
        } else if (truncatedById.has(entry.id)) {
          tags.push(h('span', {
            className: 'im-tag im-tag-cut', key: 'cut', title: t('tag.truncatedTitle'),
          }, t('tag.truncated')))
        }
        // F17: the local preview's literal overlap, shown only while the
        // preview is open so the mark always comes with its disclaimer.
        const simHit = simOpen ? simById.get(entry.id) : undefined
        if (simHit !== undefined) {
          tags.push(h('span', {
            className: 'im-tag im-tag-sim-' + simHit.level,
            key: 'sim',
            title: t('sim.matched', { terms: simHit.terms.join(' / ') }),
          }, simHit.level === 'high' ? t('sim.levelHigh') : (simHit.level === 'mid' ? t('sim.levelMid') : t('sim.levelLow'))))
        }
        return h('div', {
          className: 'im-item' + (entry.enabled ? '' : ' im-item-off'),
          key: entry.id,
        },
          h('div', { className: 'im-item-head' },
            batchMode
              ? h('input', {
                type: 'checkbox',
                className: 'im-batch-check',
                checked: selected.includes(entry.id),
                disabled: busy,
                onChange: () => toggleSelected(entry.id),
              })
              : null,
            h('span', { className: 'im-title' }, entry.title),
            tags,
            h('span', { className: 'im-spacer' }),
            batchMode
              ? null
              : h('label', { className: 'im-switch' },
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
            batchMode
              ? null
              : h('button', {
                className: 'im-btn',
                disabled: busy,
                onClick: () => { setDraft(cloneEntry(entry)); setProfileDraft(null); setError('') },
              }, t('entry.edit')),
            batchMode
              ? null
              : h('button', {
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
          Array.isArray(entry.tags) && entry.tags.length > 0
            ? h('div', { className: 'im-entry-tags' },
              entry.tags.map((tag) => h('span', { className: 'im-chip', key: tag }, tag)))
            : null,
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
          ? h('div', { className: 'im-empty', key: 'no-match' },
            keyword === ''
              ? t('list.filteredEmpty')
              : t('list.noMatch', { query: query.trim() }))
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
    exports.__budgetMeter = budgetMeter
    exports.__parseTagInput = parseTagInput
    exports.__relevanceTerms = relevanceTerms
    exports.__relevancePreview = relevancePreview
    exports.__sourceParseVerdict = sourceParseVerdict
    exports.__feedbackVerdict = feedbackVerdict
    exports.__diagnosticsText = diagnosticsText
    exports.__strings = STRINGS
    exports.__ns = NS
    exports.__dictionaryT = dictionaryT
    exports.__undoTtlMs = UNDO_TTL_MS
    return module.exports
  },
})
