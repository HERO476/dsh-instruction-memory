# DSH 插件记忆功能生效验证报告

对象：`dsh-instruction-memory`（用户长期指令记忆插件）
结论（先说）：**起作用（功能上生效）**，但**步骤 3 要求的"记忆写入/读取/命中/更新/淘汰日志"在本插件中并不存在**——该插件不产生任何记忆生命周期日志，只能用等价可观测证据替代。详见 §8 与 §10。

验证时间：2026-09-25 17:21–17:44（本机时区）
证据目录：`dsh-memory-verification/`（备份、脚本、原始输出、日志、转录全部保留）

---

## 1. 前置确认

| 项 | 值 | 获取方式 |
| --- | --- | --- |
| 插件版本 | **1.0.9**（git HEAD `d364e48`，工作区干净，仅新增本验证目录） | `package.json` + `git log` |
| 插件实际装载源 | `$env:DSH_HOME\profiles\web\node_modules\dsh-instruction-memory` → **Junction** 指向 `D:\Users\34332\AI\dsh-instruction-memory` | `Get-Item -Force \| Select LinkType,Target` |
| 装载一致性 | `lib/index.js` SHA256 `2DB7348A…E96CF`，仓库与已装载副本**一致** | `Get-FileHash` ×2 |
| DSH 宿主版本 | **0.1.7-rc.2** | 宿主 `package.json` + `startup-*.log` 内 `dshVersion` |
| 运行环境 | Windows NT 10.0.26200.0 / x64；Node **v22.23.2**；npm 10.9.4 | `[Environment]::OSVersion` |
| Profile | `web`；`DSH_HOME=<用户目录>\.dsh`；Web GUI `http://127.0.0.1:8080` | `$env:DSH_PROFILE` / `$env:DSH_HOME` |
| 组合行 | 组合树中存在 `id: 'instruction-memory' / module: 'dsh-instruction-memory'` | 启动日志 §第 205–206 行 |
| 任务类型 | 交互式对话任务（模型步 / turn）与子代理（subagent）任务 | 本会话转录 |
| 触发方式 | ① 每次**提示词装配**（`SystemPrompt.assemble()`）时求值注入段落；② 设置页 `POST /instruction-memory/api` 写入 | `dsh-system-prompt/lib/index.js:342` |
| 日志路径 | `$env:DSH_HOME\logs\startup-*.log`（**仅启动失败时写入**）；插件自身**无日志文件** | 目录枚举 + 全量 grep |
| 记忆开关 | `memory.json` 的 `enabled`（总开关）+ 每条目 `enabled` | 存储文件 |
| 其他配置项 | `budgetChars`（默认 4000，夹取 800–40000）、`MAX_ENTRIES=200`、`SECTION_ORDER=950` | `lib/index.js:78-84, 60` |
| 存储路径 | `$env:DSH_HOME\instruction-memory\memory.json`（解析优先级：显式 `$DSH_HOME` → `~\.dsh`；空串视为未设置） | `lib/index.js:72-76` |
| API 端点 | `http://127.0.0.1:8080/instruction-memory/api`（仅 POST + `application/json`） | 实测 |

### 1.1 重要架构事实（决定后续验证方法）

1. **本插件不注册任何面向模型的工具。** 模型没有任何写入入口，写入只能来自设置页或用户本人编辑文件。因此"模型写入记忆"这条路径**不存在**，不是缺陷而是设计（README「只由用户本人维护」）。
2. **注入是"全量确定性拼接"，不是检索。** `buildBlock()` 把全部启用条目按优先级排序后整体渲染；不存在相似度召回、打分、命中率一类的机制。
3. **注入段落注册为"惰性求值函数"**：`text: sectionText` 是 thunk，`assemble()` 每个模型步都重新调用它。
   → 后果：**改动记忆后无需重启，下一步即生效**（已在生产实例上实测，见 §4）。
4. **`inject = ['systemPrompt', 'webServer']` 是硬依赖。** 没有 webServer 的 profile（例如 `headless`/`tui`）中该行会一直处于 pending，`apply()` 根本不执行 → **记忆与设置页同时失效**。见 §7 边界 F-1。

---

## 2. 步骤 1 · 备份与回滚

备份位置：`dsh-memory-verification/backup/`

| 备份对象 | 文件 | 大小 |
| --- | --- | --- |
| 生产记忆存储 | `prod-store/memory.json` | 1094 B，SHA256 `06013E41…C43` |
| Profile 配置 | `profile/package.json` | 1347 B |
| Profile 安装前备份 | `profile/package.json.dsh-instruction-memory.bak` | 1308 B |
| 宿主启动日志 | `logs/startup-*.log`（2 个）+ `node-procs.json` | 25 755 / 15 062 / 908 B |
| 插件源码指纹 | `plugin-sha256.txt` | 4 个文件的 SHA256 |

一键回滚脚本：`dsh-memory-verification/rollback-instruction-memory.ps1`

```powershell
pwsh -File .\dsh-memory-verification\rollback-instruction-memory.ps1
# 或只做数据回滚（命令内不含任何机器专有路径）：
$DSH = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
Copy-Item .\dsh-memory-verification\backup\prod-store\memory.json (Join-Path $DSH 'instruction-memory\memory.json') -Force
node .\dsh-memory-verification\scripts\im-api.mjs reload   # 让运行中的宿主读回
```

必须知道的回滚细节：**运行中的宿主不会监听文件**，手工改文件后必须调用 `reload`（或重启 DSH），否则内存态与磁盘态不一致。

**回滚已执行并校验**（实验结束后）：

```
restored file sha256 : 06013E41FA12E0F2F963405A6AA794F73DCC161AE5CFB6B66D9BB818F7B57C43
pre-experiment sha256: 06013E41FA12E0F2F963405A6AA794F73DCC161AE5CFB6B66D9BB818F7B57C43   ← 逐字节一致
实验产生的 memory.json.bak 已复制留证后删除（原生产目录本无 .bak）
实时状态：entryCount=2, injectionChars=437, previewSha256=D66C3C3E…
```

---

## 3. 步骤 2 · 基线（记忆关闭）

**注意：本插件不存在"记忆日志"，所以基线不可能靠日志证明"，改用三重可观测证据。**

### 3.1 生产实例上的真实关闭（可逆）

```powershell
# 通过插件自己的同源路由关闭总开关（与设置页完全相同的调用路径）
node .\dsh-memory-verification\scripts\im-api.mjs set-options "@.\dsh-memory-verification\out\payload-disable.json"
```

实测输出（原始响应见 `out/b1-set-options-disabled.json`）：

```
ok=true  saved=true
injectionRegistered=false      ← 注入段落已注销
injectionChars=0
preview=""                     ← 渲染结果为空串
enabled=false   entryCount=2   ← 条目被保留，未被销毁
```

### 3.2 基线任务实测

对同一提示词、同类型任务派发独立子代理（`subagent`），要求它原样吐出系统提示词中的记忆段落：

| 臂 | 记忆状态 | 子代理输出 |
| --- | --- | --- |
| **A（基线）** | 开，2 条目，无标记 | 完整段落（2 条目，无标记） |
| **B（关闭）** | 关 | **`NONE`** |
| **C（开启+标记）** | 开，3 条目，含标记 | 完整段落（**含标记** `验证标记 IM-7F3A-OK`） |

→ 关闭时**同一类型任务确实完全拿不到记忆**，确认无记忆参与。

### 3.3 关闭时的系统提示词逐字节等价性

确定性测试台 `ab-harness.mjs` 臂 1（A1–A6）全部通过：

- `enabled:false` → **不注册任何 prompt 段落**（`sections.length === 0`）
- `enabled:true` 但 `entries:[]` → 同样不注册
- 组装结果为空 → **与未安装本插件时的系统提示词逐字节一致**（README 承诺，已实测）

---

## 4. 步骤 3 · 开启记忆并写入标记

### 4.1 "无生命周期日志"这一事实（必须标注）

对 `lib/index.js`、`lib/client.js` 全量 grep：

```
console.error(...)   ← 7 处（index）+ 1 处（client），全部是**失败**分支
console.log/info/warn/debug  → 0 处
logger / ctx.log / diag / usage.jsonl → 0 处
```

对 `$env:DSH_HOME\logs` 全量 grep `instruction-memory`：仅命中组合树的 `pending / id: / module:` 行，**没有任何一次成功注入、读取、命中、淘汰的记录**。

**因此步骤 3 要求的"观察写入/读取/命中/更新/淘汰日志"按字面无法完成。** 这是本报告最重要的一处不准确风险标注：**不要**把下面这些替代证据当作"日志"。

### 4.2 替代证据（等价可观测）

写入标记条目：

```powershell
node .\dsh-memory-verification\scripts\im-api.mjs save-entry "@.\dsh-memory-verification\out\payload-marker.json"
```

实测（`out/c2-save-entry-marker.json`）：

```
ok=true saved=true
injectionRegistered=true       ← 段落重新注册
injectionChars 437 → 511       ← 渲染长度增加 74
entryCount 2 → 3
preview 中条目顺序：标记(高, 最新) → 原高优条目 → 原按需条目
磁盘：memory.json 1093 → 1437 B，并生成 memory.json.bak
```

**同一会话内的即时性证据（最强）**：写入后**下一步**，我自己的系统提示词已带上该标记条目；回滚后又消失。即 `systemPromptUpdate: in-history` + thunk 求值 = **无需重启，一步内生效**。

### 4.3 "命中/淘汰"的准确对应

| 步骤 3 用词 | 本插件中的对应物 | 实测 |
| --- | --- | --- |
| 写入 | `save-entry` 路由 → 原子替换 + 滚动备份 | ✅ 通过（C2–C4） |
| 读取 | `boot` 时 `readFromDisk()`；`reload` 路由 | ✅ 通过（B8、3.1） |
| **命中** | **不存在**——无检索、无排序打分、无缓存键，只有确定性全量注入 | ⚠️ 不适用 |
| 更新 | 同 id 覆盖 `save-entry` | ✅ 通过（C5） |
| **淘汰** | **仅**预算超限时的"省略 + 页脚披露"与"首条截断" | ✅ 通过（D1–D6） |

---

## 5. 步骤 4 · 跨任务 / 跨轮次

### 5.1 真实转录中的系统提示词（决定性证据）

本会话转录：`$env:DSH_HOME\sessions\--D-Users-34332-AI-dsh-instruction-memory--\<session-id>\session.v4.jsonl.zstd`（89 个 zstd 帧，解压后 160 行 JSONL）。

用**插件自己的** `buildBlock()` 从生产 `memory.json` 渲染出块（437 字符，SHA256 `D66C3C3E…`），在真实系统提示词中检索：

| 记录 | 提示词长度 | 块出现次数 | 块偏移 | 块 SHA256 | 前缀 SHA256 |
| --- | --- | --- | --- | --- | --- |
| step 1 | 11 817 | **1** | 5889 | `D66C3C3E…` | `7DB46D26…` |
| step 6 | 14 195 | **1** | 5889 | `D66C3C3E…` | `7DB46D26…` |

结论：
- 块**恰好出现一次**，且**渲染结果与插件函数输出逐字节相同**；
- 位置在 FILE_REFERENCE(900) 之后、TOOL_BASH(1000) 之前 → 与 `SECTION_ORDER=950` 的声明**完全吻合**；
- 两个不同步的前缀/块哈希**完全一致** → 该段落的"提示词前缀可缓存"声明成立（提示词从 11 817 增至 14 195 字符，新增内容全在块之后）。

### 5.2 跨代理（跨任务）影响

三个独立子代理（各自独立上下文，无法访问我的对话）分别读到 A/B/C 三臂的不同结果（§3.2）。**任务 1 写入的标记，被后续独立任务原样读到** → 上一任务的信息确实影响了当前任务。

### 5.3 变量 / 上下文 / 偏好 / 缓存键

- **偏好**：✅ 生效（记忆条目本身就是"偏好/长期要求"，全量注入到每个任务）。
- **上下文**：✅ 生效（同一段落进入所有任务的系统提示词）。
- **变量**：⚠️ **本插件没有变量机制**。它不注入 `{{...}}` 变量（`system-prompt` 的变量注册接口它一个都没用），只有静态文本块。E2E 测试 C8 用"内容中带 `CACHEKEY=zz9` 字样"来模拟跨任务传递，**这只证明文本会跨任务保留，不证明存在变量替换**。
- **缓存键**：⚠️ **本插件不产生缓存键**。唯一相关的是 §5.1 的"前缀字节稳定"，它是**提示词前缀缓存可用性**，不是记忆缓存键。

---

## 6. 步骤 5 · 基线与记忆组对比

| 对比项 | 基线组（记忆关） | 记忆组（记忆开） | 判定 |
| --- | --- | --- | --- |
| prompt 段落注册 | `false` | `true` | 差异明确 |
| 渲染长度 | 0 | 437（+ 标记臂 511） | 差异明确 |
| 独立任务实际读到的内容 | `NONE` | 完整段落 | **差异可复现** |
| 系统提示词长度（真实转录） | —（关闭态仅由路由快照观测） | 11 817 / 14 195，含块 | 差异明确 |
| 磁盘存储 | 未被删改 | 被原子重写 + 滚动备份 | 差异明确 |

**差异可复现，且每一项差异都能对应到确定的证据文件**（`out/b1-*.json`、`out/c2-*.json`、`out/live-check.json`、三臂子代理输出）→ 判定**生效**。

可复现性：`ab-harness.mjs` 68 项断言全部通过，每次运行均从零构造 scratch `DSH_HOME`，结果确定（同一状态 20 000 次渲染只产生 **1** 个 SHA256）。

---

## 7. 步骤 6 · 边界检查

确定性边界矩阵见 `dsh-memory-verification/logs/ab-harness.txt`（臂 5/6）与 `logs/failsave-nuance.txt`。

| 边界 | 结果 | 证据 |
| --- | --- | --- |
| **并发** | ✅ 不失效。20 个并发 `save-entry` 全部 `ok`，最终文件 20 条无丢失，渲染 20 条 | E9–E12（插件用 `diskQueue` 串行化） |
| **超时** | ✅ 不受影响。装配路径是**纯内存**计算：`sectionText()` → `buildBlock(state.data)`，无 fs、无网络、无定时器；实测 **1.38 µs/次**（20 000 次 27.6 ms） | 代码 + `logs/measurements.txt` |
| **重启** | ✅ 不失效。存储位于 `DSH_HOME`（非 cwd）；独立第二次 `apply()` 渲染**逐字节相同** | B8、F8/F9 |
| **插件热加载/卸载** | ✅ 正确注销。执行插件自身的 `ctx.effect` 清理后，prompt 段落被 dispose；`set-options` 开关可在**不重启**的情况下实时注册/注销 | C10、C11、F2 |
| **存储满 / 写失败** | ⚠️ **有真实一致性缺口**。保存失败时 `ok:false` 且磁盘文件不变，但**内存态已被修改**，未持久化的条目**在本进程剩余生命周期内仍会被注入**，重启后消失 | F3–F8（缺口见 §10.3） |
| **权限不足 / 路径不可用** | ✅ 不崩溃、不静默。`memory.json` 为目录 → `storage.error` 明确；`DSH_HOME` 落在普通文件下（ENOTDIR）→ `apply()` 不抛异常，报 `storage.error`，不注册段落 | F3–F7 |
| **存储损坏** | ✅ 有自愈与披露。`memory.json` 解析失败 → 回退 `memory.json.bak` 并明确提示；无备份 → 报错且不注入（不猜测） | E1–E4 |
| **`inject` 硬依赖（未在步骤 6 列出但风险更高）** | ⚠️ **无 webServer 的 profile 中记忆完全不生效**。启动日志显示该行 `outcome: pending, missing: ['webServer']` → `apply()` 未执行 | 启动日志第 34 / 195–197 行 + `lib/index.js:32` |
| **条目上限 / 空条目** | ✅ 200 条上限生效、重复 id 自动修复、空条目丢弃且**明确披露被丢弃数量** | E17–E20 |
| **预算 |** ✅ 下限 800 / 上限 40000 夹取；超预算条目省略并在页脚注明条数；超大首条截断而非丢弃 | D1–D6、F10–F11 |
| **路由契约** | ✅ GET→405，非 JSON content-type→415，超大请求体→413，未知方法→可读错误 | E13–E16 |

---

## 8. 步骤 7 · 检查项对照表

> 证据列中的路径均相对 `dsh-memory-verification/`。命令以 `$DSH` 表示 `$env:DSH_HOME`（缺省 `$env:USERPROFILE\.dsh`）。

| 检查项 | 命令或操作 | 预期 | 实际 | 证据 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 插件已装载 | 查启动日志组合树 | 存在 `instruction-memory` 行 | 存在，`module: dsh-instruction-memory` | `backup/logs/startup-*.log:205` | ✅ |
| 装载源正确 | `Get-Item <profile>\node_modules\dsh-instruction-memory -Force` | Junction 指向仓库 | Junction → `D:\...\dsh-instruction-memory` | 会话输出 | ✅ |
| 版本一致性 | `Get-FileHash lib\index.js`（仓库 vs 装载副本） | 哈希相同 | 均为 `2DB7348A…` | 会话输出 | ✅ |
| 记忆总开关关闭 | `node scripts/im-api.mjs set-options "@out/payload-disable.json"` | 段落注销、渲染空 | `registered=false, chars=0, preview=""` | `out/b1-*.json` | ✅ |
| 关闭后无记忆参与 | 同类型任务子代理读取系统提示词 | 无该段落 | 输出 `NONE` | 臂 B 输出 | ✅ |
| 关闭时提示词等价 | 见 §3.3 | 与无插件逐字节一致 | 段落未注册、组装为空 | `logs/ab-harness.txt` A1–A6 | ✅ |
| 记忆开启 | `node scripts/im-api.mjs set-options "@out/payload-enable.json"` | 段落注册 | `registered=true, chars=437` | `out/c1-*.json` | ✅ |
| 标记写入 | `node scripts/im-api.mjs save-entry "@out/payload-marker.json"` | 落盘 + 渲染变化 | 1437 B，`chars 437→511`，3 条目 | `out/c2-*.json` | ✅ |
| **记忆生命周期日志** | `Select-String lib\*.js -Pattern 'logger\|console\.(log\|info\|warn\|debug)'` | 按步骤 3 应有日志 | **0 命中，只有 8 处 `console.error` 失败分支** | §4.1 | ❌ **不存在（须标注）** |
| 真实任务拿到记忆 | 从本会话转录提取 `system/message` | 含块且逐字节相同 | 块出现 1 次，偏移 5889，SHA 相同 | `out/live-check.json`、`scripts/live-check.mjs` | ✅ |
| 注入位置正确 | 同上，比对前后段落 | 在 900 与 1000 之间 | 紧接 FILE_REFERENCE，紧邻 TOOL_BASH | `out/live-check.json` | ✅ |
| 跨任务影响 | 三个独立子代理 A/B/C | 关→NONE；开→含标记 | 完全符合 | 臂 A/B/C 输出 | ✅ |
| 跨轮次持久 | 无需重启，一步内生效 | 下一步即含新条目 | 本会话下一步系统提示词即含标记 | §4.2 | ✅ |
| 重启后一致 | 第二次独立 `apply()` 同存储 | 渲染逐字节相同 | 相同 | `logs/ab-harness.txt` B8 | ✅ |
| 写→更新→删除 | `save-entry`（同 id）→`delete-entry` | 渲染跟随变化 | 全部跟随，删除后段落注销 | `logs/ab-harness.txt` C5–C7 | ✅ |
| 优先级顺序 | 混合 2/1/0 优先级 | 高→普通→低 | 顺序正确 | `logs/ab-harness.txt` F15 | ✅ |
| 预算淘汰 | `budgetChars=800` + 3×300 字符 | 省略并披露 | 页脚 `另有 N 条指令因注入字数上限未包含` | `logs/ab-harness.txt` D3 | ✅ |
| 首条截断 | `budgetChars=800` + 6000 字符单条 | 截断而非丢弃 | 含 `…（本条因注入字数上限被截断）` | `logs/ab-harness.txt` D5 | ✅ |
| 存储损坏回退 | 写入非法 JSON + 合法 `.bak` | 回退并提示 | 回退成功，`storage.warning` 明确 | `logs/ab-harness.txt` E1–E2 | ✅ |
| 存储损坏无备份 | 写入非法 JSON，无 `.bak` | 报错且不注入 | `storage.error` 非空，段落为空 | `logs/ab-harness.txt` E3–E4 | ✅ |
| 并发写 | 20 个并发 `save-entry` | 无丢失 | 20/20 ok，文件 20 条 | `logs/ab-harness.txt` E9–E12 | ✅ |
| 写失败（存储满/权限） | 令 `memory.json.tmp` 为目录 | 明确失败 | `ok:false` + `EISDIR` 错误，磁盘不变 | `logs/ab-harness.txt` E5–E8 | ⚠️ 见 §10.3 |
| 不可读存储 | `memory.json` 为目录 | 报错不崩溃 | `storage.error` 非空，不注入 | `logs/ab-harness.txt` F3–F4 | ✅ |
| 路径全不可用 | `DSH_HOME` 落在普通文件下 | 不抛异常 | `apply()` 不抛，报错，不注册 | `logs/ab-harness.txt` F5–F7 | ✅ |
| 空 `DSH_HOME` 回退 | `resolveStorePath({DSH_HOME:'   '})` | 不得回退 cwd | 等同未设置，非 cwd | `logs/ab-harness.txt` F8–F9 | ✅ |
| 热卸载 | 执行插件 `ctx.effect` 清理 | 段落被 dispose | 段落移除 | `logs/ab-harness.txt` F2 | ✅ |
| 路由负向契约 | GET / 错误 content-type / 超大 body | 405 / 415 / 413 | 405 / 415 / 413 | `logs/ab-harness.txt` E13–E15 | ✅ |
| 装配成本 | `buildBlock` ×20 000 | 无 I/O、微秒级 | 1.38 µs/次 | `logs/measurements.txt` | ✅ |
| 前缀可缓存 | 两个真实 step 的前缀哈希 | 相同 | 均为 `7DB46D26…` | `logs/measurements.txt` | ✅ |
| 插件自带套件 | `npm test` | 全通过 | **142 PASS / 0 FAIL** | `logs/npm-test.txt` | ✅ |
| 确定性测试台 | `node scripts/ab-harness.mjs` | 全通过 | **68 PASS / 0 FAIL** | `logs/ab-harness.txt` | ✅ |
| **生产配置未被残留修改** | 实验后比对哈希 | 与备份一致 | `06013E41…` 完全一致，`.bak` 已清理 | `out/d2-post-restore-state.json` | ✅ |

---

## 9. 步骤 8 · 结论与最小复现

### 9.1 结论

**起作用。**

- 记忆被真实写入 `<DSH_HOME>/instruction-memory/memory.json`；
- 在**真实的对话任务**中被读入，并**逐字节**出现在发给模型的系统提示词中（偏移 5889，位于 `FILE_REFERENCE(900)` 与 `TOOL_BASH(1000)` 之间，与 `SECTION_ORDER=950` 吻合）；
- 关闭与开启可**可复现地**改变同一类型任务实际读到的内容（`NONE` ↔ 完整段落）；
- 写入后**无需重启**，一步内生效；重启后渲染逐字节一致。

**同时必须标注的三点不准确/不适用**：

1. 插件**不存在**记忆写入/读取/命中/更新/淘汰日志（只有 8 处失败分支的 `console.error`）。步骤 3 的字面要求无法满足，本报告用路由快照 + 真实系统提示词 + 文件状态替代。
2. "**命中**"在本插件语义下**不存在**（无检索、无打分、无缓存键）；"**淘汰**"仅对应预算超限的省略与截断。
3. "**变量**"与"**缓存键**"在本插件中**不存在**；只有静态文本全量注入 + 提示词前缀字节稳定。

### 9.2 最小复现步骤（约 3 分钟，不触碰生产配置）

```powershell
# 0. 定位
$DSH = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$REPO = 'D:\Users\34332\AI\dsh-instruction-memory'   # 改为你的插件仓库路径

# 1. 确定性 A/B + 边界（68 项断言，全部在 dsh-memory-verification\tmp 下隔离运行）
cd $REPO
node .\dsh-memory-verification\scripts\ab-harness.mjs

# 2. 真实提示词对照（读取本机某次会话转录，只读）
node .\dsh-memory-verification\scripts\live-check.mjs

# 3. 只读查看生产实例当前状态（走插件自己的路由）
node .\dsh-memory-verification\scripts\im-api.mjs state
```

判读标准：

- 步骤 1 应为 `checks: 68, failed: 0`；
- 步骤 2 应为 `blockFound: true, occurrences: 1`（若生产存储为空或关闭，则 `blockFound: false`，属预期）；
- 步骤 3 的 `injectionRegistered / injectionChars` 应与 `memory.json` 内容一致。

**要亲手做 A/B（会改动生产存储，务必先备份）**：

```powershell
Copy-Item (Join-Path $DSH 'instruction-memory\memory.json') .\memory.json.bak-step1 -Force
node .\dsh-memory-verification\scripts\im-api.mjs set-options "@.\dsh-memory-verification\out\payload-disable.json"   # 关
# …执行一次同类型任务，观察是否读不到记忆…
node .\dsh-memory-verification\scripts\im-api.mjs set-options "@.\dsh-memory-verification\out\payload-enable.json"    # 开
Copy-Item .\memory.json.bak-step1 (Join-Path $DSH 'instruction-memory\memory.json') -Force   # 回滚
node .\dsh-memory-verification\scripts\im-api.mjs reload
```

### 9.3 本次验证为达成结论而对生产做的临时改动（已全部回滚）

| 改动 | 时间 | 回滚 | 校验 |
| --- | --- | --- | --- |
| 通过路由 `set-options{enabled:false}` 关闭记忆 | 17:41:35 | 已重新开启 | 回滚后 `enabled=true` |
| 通过路由 `save-entry` 写入标记条目 `im-verify-marker-0001` | 17:41:43 | 已由备份覆盖 + `reload` | 回滚后 `entryCount=2`，无标记 |
| 插件自动生成的 `memory.json.bak` | 17:41:35 | 复制留证后删除 | 生产目录仅剩 `memory.json` |
| **生产 `memory.json` 最终哈希** | — | — | `06013E41…` 与实验前**逐字节一致** |

宿主进程 **PID 35212 启动于 17:21:27**，A/B 发生在 17:41:35–17:41:43 → **全程未重启宿主**，证明改动是在**运行中**生效的。

---

## 10. 步骤 9 · 若不起作用时的定位（本次不适用，给出预防性排查顺序）

本次判定"起作用"，故无需修复。以下为**若**在别的环境复现为"不起作用"时的定位顺序，每一级都给出可直接复制的判定命令。

### 10.1 配置

```powershell
$DSH = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
Get-Content (Join-Path $DSH 'profiles\web\package.json')            # dsh.profile.bundles 是否含 dsh-instruction-memory
Get-Content (Join-Path $DSH 'instruction-memory\memory.json')       # enabled 是否 true；条目 enabled 是否 true
node .\dsh-memory-verification\scripts\im-api.mjs state             # injection.registered / injection.chars
```
- `enabled:false` 或全部条目停用 → 段落**整体注销**，提示词与未安装时逐字节一致。**这是最常见原因，不是故障。**
- 条款为空（`title` 与 `content` 都空）会在载入时被丢弃，并被 `storage.warning` 披露。

### 10.2 权限

```powershell
icacls (Join-Path $DSH 'instruction-memory')
node .\dsh-memory-verification\scripts\im-api.mjs state   # 看 storage.error
```
- 期望：宿主进程对 `<DSH_HOME>\instruction-memory` 具备写权限；写失败时 `save-entry` 返回 `ok:false` 且 `storage.error` 含 `EACCES/EPERM/EISDIR`。

### 10.3 存储（本次发现一处真实缺口）

```powershell
node .\dsh-memory-verification\scripts\failsave-nuance.mjs
```
**缺口**：`saveEntry` 先改内存、调 `syncSection()` 注册新段落，**之后**才 `await writeToDisk()`
（`lib/index.js:544-564`）。因此写盘失败时：

- ✅ 面板如实报 `ok:false` + `保存失败：…`，磁盘文件不变；
- ❌ 但**未持久化的条目在本进程剩余生命周期内仍会被注入**，重启后才消失。

实测：`before: hasNew=false` → `duringSameProcess: hasNew=true` → `afterRestart: hasNew=false`。
影响面：仅"保存失败"这一异常路径，且不丢已有数据（磁盘是权威）。修复方向：`writeToDisk()` 失败时回滚 `state.data` 到写入前的快照并重新 `syncSection()`。

### 10.4 版本

```powershell
(Get-Content '<DSH 安装目录>\package.json' -Raw | ConvertFrom-Json).version
node .\host-range-test.mjs        # 固定矩阵 + 读取本机实际宿主版本的实时守卫
```
- 本机 **0.1.7-rc.2** 落在声明范围内（README 的"实测范围"只列到 `0.1.5-rc.2`，`0.1.6-alpha.2`/`0.1.7-rc.2` 由范围测试与本次实测覆盖）。
- ⚠️ README 已说明：**未声明的未来 minor 预发布版本无法被任何 semver 范围覆盖**，升级到 `0.1.8-rc.x` 时需追加一段范围，否则市场会隐藏/拒绝安装。

### 10.5 调用链

```powershell
Select-String -Path (Join-Path $DSH 'logs\startup-*.log') -Pattern 'instruction-memory'
```
- 组合行应为 `fiberState` 已激活、无 `missing`。若出现 `pending, missing: ['webServer']` → **该 profile 没有 web 服务器，插件行从未 apply，记忆与设置页同时失效**（`lib/index.js:32` 的硬依赖）。
- 若出现 `[instruction-memory] section registration failed` / `render failed` → 注入注册被拒。
- 若出现 `[instruction-memory] webServer unavailable` → 路由未注册，设置页改不动，但**注入仍可用**。

### 10.6 修复建议与回滚

| 现象 | 修复建议 | 回滚 |
| --- | --- | --- |
| 记忆被关掉 | 设置页打开总开关，或 `im-api.mjs set-options "@…payload-enable.json"` | 无需回滚 |
| 无 webServer 的 profile 无记忆 | 改用含 webServer 的 profile，或把 `inject` 中的 `webServer` 改为可选（需改插件代码：`apply()` 已经能容忍 `webServer` 缺失，`inject` 却把它列为硬依赖） | `Copy-Item backup\plugin-sha256.txt` 对应源码 + 重启 |
| 写盘失败后内存态超前 | 见 §10.3，`writeToDisk()` 失败时回滚 `state.data` | 重启 DSH 即回到磁盘权威态 |
| 存储损坏 | 从 `memory.json.bak` 恢复，或删除该文件让插件重建空存储 | 已保留 `out/memory.json.bak.created-by-experiment` 作为格式样例 |
| 整体回退插件 | `node install.mjs --remove` | 用 `backup/profile/package.json` 覆盖 profile 配置后重启 |

---

## 11. 准确性说明与未能判定的项

1. **"日志"要求无法按字面满足**（§4.1）。所有"写入/更新/读取"结论均来自路由响应快照、真实系统提示词与磁盘文件，**不是日志**。
2. **子代理 A/B 是行为层证据，但样本量为每臂 1 次**。三臂结果与机制证据完全一致，但"模型是否**遵守**记忆内容"属于概率行为，超出本次验证范围；本次只证明**记忆确实到达了模型**。
3. **磁盘满（ENOSPC）未真实注入**，用 `memory.json.tmp` 为目录（`EISDIR`）等价模拟写失败。二者在插件代码路径上同为 `writeToDisk()` 的 catch 分支。
4. **未做真实的任务超时注入**。"超时不影响记忆"的结论基于代码路径证明（装配为纯内存、无 I/O、1.38 µs/次），而非注入超时实测。
5. **生产 `memory.json` 的 `title` 含未折叠换行**（`"…客观。\n需要标注…"`），而注入文本中的标题是**单行空格连接**的。原因：`sanitizeEntry()` 的 `singleLine()` 只在载入/保存时折叠内存态，磁盘文件保持原样。结合"生产目录原本没有 `memory.json.bak`"可推断：该文件**不是由本版本设置页保存过两次以上写入的**（很可能手工编辑或旧版本写入）。这不影响注入正确性，但说明磁盘文件与渲染文本在标题上**必然不同**——排查时不要以磁盘 `title` 断言注入文本。
6. **环境异常（与插件无关）**：本会话 `workspace-write` 沙箱在初始化阶段即失败（`SetNamedSecurityInfoW failed (Win32 5): grantWrite(<workspace>)`），任何命令都无法执行；后续命令在 `danger-full-access` 下运行。这是 DSH 沙箱在 D: 盘该目录上的 ACL 授权问题，**不是被测插件的故障**，但会妨碍在受限模式下复现本报告的脚本。

## 12. 脱敏说明

- 所有命令使用 `$env:USERPROFILE` / `$env:DSH_HOME` / `$env:DSH_SESSION_ID`，不含用户名明文路径（报告中出现的 `C:\Users\<用户名>` 形态路径仅为说明，可被变量替换）。
- 会话 ID 在正文中以 `<session-id>` 呈现；转录文件按 `$env:DSH_SESSION_ID` 定位。
- 记忆条目内容为**用户本人已保存在设置页中的长期指令**，属用户自有内容，未做改写；未包含凭据、令牌或密钥。
- 未读取或输出 `.credentials.yaml` / `settings.yaml` 等凭据文件。
