# 「偷跑」审计报告 —— dsh-instruction-memory

结论先行：**未发现偷跑缺陷。判定为「属设计行为」**，并附 2 项**事实性注意**与 1 项**代码路径推断（已标注）**。

被测对象：`dsh-instruction-memory` **1.0.10**（已发布到 npm 的版本；运行中的宿主进程亦已实测确认加载 1.0.10，见 §9）
审计日期：2026-09-27｜宿主 DSH 0.1.7-rc.2｜Node v22.23.2｜Windows 10.0.26200
证据目录：`dsh-memory-verification/`（脚本 `scripts/`、原始输出 `logs/`、`out/`）

---

## 一、现象界定

### 1.1 「无任务」的操作性定义

本审计把"无任务"拆成四个可分别观测的状态，因为它们的结论**并不相同**：

| 状态 | 定义 | 观测手段 |
| --- | --- | --- |
| **S1 进程启动、零会话** | DSH 进程已启动，尚未创建任何会话，无任何用户输入 | 受控挂载实验（`boot-and-wake.mjs`） |
| **S2 会话空闲** | 会话存在，但**没有任何 turn 在运行**，无用户输入、无工具调用、无定时器 | 4 秒空转实验（`idle-probe.mjs`）+ 真实转录中的 41.5 小时空档 |
| **S3 无人值守 turn** | 有 turn 在运行，但**不是人类输入**唤醒的（自动续跑、队友消息等） | 转录 `agent/inbox/spliced` 的 `source.kind` 字段 |
| **S4 turn 运行中** | 正常的用户任务执行中 | 转录时间线 |

### 1.2 「偷跑」的判定标准（三条，满足任一即成立）

- **T1** 在 S1/S2（无 turn 运行）下，仍产生**新的提示词装配**或把记忆内容送进任何模型请求；
- **T2** 同一次装配中记忆块出现**多于一次**（重复注入）；
- **T3** 记忆内容**超出用户授权范围**扩散（例如未经同意跨会话/跨项目泄漏）。

判定所需的"注入"定义：**只有提示词被装配并进入模型请求才算注入**。仅仅"注册了一个提示词段落"不算 —— 这是本次审计最关键的口径区分。

---

## 二、复现步骤与观察点

```powershell
cd D:\Users\34332\AI\dsh-instruction-memory
node .\dsh-memory-verification\scripts\idle-probe.mjs            # S2 空转实验
node .\dsh-memory-verification\scripts\idle-probe.mjs --control  # 对照：不挂载插件
node .\dsh-memory-verification\scripts\boot-and-wake.mjs         # S1 启动期 + 唤醒来源
node .\dsh-memory-verification\scripts\runaway-forensics.mjs     # 真实转录时间线
node .\dsh-memory-verification\scripts\attribution-scope.mjs     # 归因 + 跨会话范围
node .\dsh-memory-verification\scripts\wake-attribution.mjs      # source.kind 精确归因
node .\dsh-memory-verification\scripts\delivery-probe.mjs        # 口径对齐 + 投递载荷
```

观察点：段落注册次数、thunk 求值次数、存储写入次数、活动句柄、CPU、每条 system prompt 的字符数与哈希、每条 prompt 的唤醒来源。

---

## 三、证据清单

### 3.1 结构证据：整个 DSH 只有一处装配提示词

```
$ grep -r "systemPrompt.assemble" <DSH>/node_modules/@deepseek-ai/
  \dsh-agent-loop\lib\index.js:907
    const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal));
```

且 `preStep()` 有硬前置（同文件 902-907）：

```js
async preStep(target, position) {
  if (this.phase.kind !== "running") throw new Error(`agent "${this.id}": pre-step outside running phase`);
  const signal = this.phase.abort.signal;
  const claimed = this.inbox.claim(target, position.turn);
  const assembly = await this.loopCtx.systemPrompt.assemble(...);   // ← 唯一注入点
```

**没有 turn 在跑，`preStep` 根本不会被调用**（它自己会抛错）。

插件侧的完整 API 使用面（`lib/index.js` 全文检索 `systemPrompt.`）：

```
  L518: sectionDispose = systemPrompt.section({ name: SECTION_NAME, order: SECTION_ORDER, text: sectionText })
```

**只有一次 `section()` 调用，从不调用 `assemble()`。** 注入是**宿主拉取**，不是插件推送。

另外，`system-prompt/change` 事件在整个 DSH 树里**只有 emit、没有任何监听者**（4 处命中：1 处 emit、3 处文档/API 目录）→ 注册动作不会引发级联的重新装配。

### 3.2 S2：空转实验（决定性）

`idle-probe.mjs`，挂载插件后**什么都不做**，真实墙钟 4000ms：

| 观察项 | PLUGIN | CONTROL（不挂载插件） |
| --- | --- | --- |
| `section()` 注册次数 | 1（order=950，`text` 是函数） | 0 |
| 空转 4000ms 内 `section()` 新增 | **0** | 0 |
| 空转 4000ms 内 `spec.text` 求值 | **0** | 0 |
| 空转 4000ms 内存储被写（自建 fs.watch） | **0** | 0 |
| 存储 mtime 变化 | false | false |
| 活动句柄新增 | **0** | 0 |
| 空转 4000ms 内消耗 CPU | **0.0 ms** | 0.0 ms |
| 插件是否自己调用 `assemble` | **0** | n/a |
| 模拟一次主机装配后 `spec.text` 求值 | **恰好 1 次**，结果 = `buildBlock()` 输出 | n/a |

- **对照实验的意义**：不作对照时我看到"空转期间新增 1 个 `Socket` 句柄"，容易误归因于插件；加上不挂载插件的对照组后，`Socket` 在**两组都出现**（属 Node 自身），故与插件无关。这是我在本轮修正掉的第一个自身方法学错误。
- 进程在脚本结束后 **4.27 秒自行退出**（4s 空转 + 启动开销）→ 没有残留 timer/interval/watcher/socket 能维持进程存活。
- 静态面佐证：`lib/index.js` **零** `setInterval`/`setTimeout`/`fs.watch`/事件订阅；仅有的 `.on(` 是 HTTP 请求流上的 `req.on('error'|'data'|'end')`，属请求作用域。`lib/client.js` 有 2 处 `setTimeout`，均为单次调用的 15s 中止计时器与一次性的 `URL.revokeObjectURL`，**无轮询**（`callHost('state')` 只在面板挂载时调用一次）。

### 3.3 S2 的真实世界证据：41.5 小时空档

真实转录里最大的记录间空档：

```
  149355.5s 之后紧跟 session/end-seed
    2734.6s 之后紧跟 session/end-seed
     961.1s 之后紧跟 subagent/catalog
     709.4s 之后紧跟 turn/end
     566.4s 之后紧跟 approval/asked

  间隔 >60s 之后紧接着出现 system/message 或 request 的次数: 0
```

41.5 小时里**没有任何**提示词装配或模型请求；恢复后第一次注入发生在新的用户消息之后 **118 ms**。

### 3.4 S1：进程启动、零会话时插件确实执行了磁盘动作

```
[全新 DSH_HOME，无任何会话]
  存储文件挂载前存在 : false
  存储文件挂载后存在 : true   <-- 插件在零会话时创建了文件
  文件内容           : 7 行 / 78 字节，条目数 0
  注册的 prompt 段落 : 0      <-- 空存储不注册，注入为 0
  日志: "store written: … bytes=78 entries=0 backup=refreshed"
        "mounted: … from=first run (empty store created) entries=0 enabled=true injected=nothing"

[已有存储，但同样零会话]
  注册的 prompt 段落 : 1（chars=231）
  日志: "prompt section registered: order=950 chars=231"
        "mounted: … from=memory.json entries=1 enabled=true injected=231 chars"
```

**注意 `injected=231 chars` 这个措辞**：它指的是"这个段落若被装配会产出 231 字符"，此刻**并没有任何会话、没有任何模型请求**。日志文案容易让人误读成"已注入"，这是我在 1.0.10 里自己写的文案，属于可改进项（见 §6）。

### 3.5 S3/S4：真实转录的注入密度与唤醒来源

转录（978+ 个 zstd 帧，最终 1633+ 条记录）：

```
  step/start            : 234      (= 模型步数 = assemble() 调用次数)
  assistant/message     : 234
  turn/start            : 8        (turn/end 7，第 8 个仍在跑)
  system/message        : 6        (仅提示词变化时重新下发)
  agent/inbox/spliced   : 20
  落在任何 turn 窗口之外的 step/start: 0
```

**每个 step 装配一次，且 234 个 step 全部落在 8 个 turn 之内，无一例外。**

每次记录下来的 system prompt：

| seq | 本地时间 | turn/step | 字符数 | 含当前记忆块 | 含 A/B 标记 `IM-7F3A-OK` | prompt sha |
| --- | --- | --- | --- | --- | --- | --- |
| 13 | 2026-09-25 17:24:04 | 1/1 | 11817 | ✅ | ✗ | `678699386D15` |
| 69 | 2026-09-25 17:33:52 | 1/6 | 14195 | ✅ | ✗ | `843BBDA45497` |
| 263 | 2026-09-25 **17:41:35** | 1/29 | 13756 | **✗** | ✗ | `80BF952A69D5` |
| 277 | 2026-09-25 **17:41:43** | 1/31 | 14269 | ✗（块变体） | **✅** | `E49DC9B8762F` |
| 291 | 2026-09-25 **17:41:55** | 1/33 | 14195 | ✅ | ✗ | `843BBDA45497` |
| 1509 | 2026-09-27 12:09:28 | 8/1 | 16192 | ✅ | ✗ | `0B2B19171633` |

**重复注入：0 条**（每条的块出现次数均为 1）。

**那两条"不含当前记忆块"的 prompt 归因**（这是本轮最需要解释的异常）：

```
17:41:35  ACTION b1-set-options-disabled.json   （我在第一轮 A/B 里把 enabled 设为 false）
17:41:35  PROMPT seq=263 含块=false              ← 同一秒
17:41:43  ACTION c1/c2/c3（重新开启 + 写入标记条目）
17:41:43  PROMPT seq=277 含块=false 含标记=true   ← 块确实在，只是换成了含标记的版本
17:41:55  ACTION d1/d2（从备份逐字节回滚 + reload）
17:41:55  PROMPT seq=291 含块=true               ← sha 与 seq=69 完全相同 = 回滚在提示词层面也生效
```

动作时间取自 `out/*.json` 响应快照的**文件 mtime**（客观时间戳）。结论：**两条异常均由我自己的显式 A/B 动作造成，且均在 1 秒内同步生效**；没有一条是"无任务仍注入"。反过来，这组数据还顺带证明了关闭/开启/回滚在**真实提示词层面**都精确生效。

**唤醒来源（权威字段 `source.kind`）**：

```
  turn seq=   10 17:24:04  <- kind=user          human=true   （我的第一条任务指令，带 rpcId）
  turn seq=  395 17:44:29  <- kind=goal          human=false  （<goal_round> 自动续跑）
  turn seq=  425 17:47:27  <- kind=user          human=true   （"列出有问题的地方，并将其修复"）
  turn seq=  836 18:10:42  <- kind=user          human=true   （"剩余4项全部修复并发布"）
  turn seq= 1491/1496/1501 11:54–11:57 <- kind=user human=true （审计提示词，重复投递 3 次，各 0 step）
  turn seq= 1506 12:09:27  <- kind=user          human=true   （本次审计，仍在跑）

  合计非人类发起的 turn：1 / 8
```

我在第一版脚本里用"turn 窗口内有无 `user/message`"判断无人值守，得出"3 个无人值守 turn"——**这是错的**：消息先 splice 进 inbox 再被 turn 消费，`user/message` 记录会落在窗口之外。改用 `source.kind` 后更正为 **1 个**。这是本轮修正的第二个自身方法学错误。

**零 step 的 turn**：seq 1491/1496/1501 各有 0 个 `step/start` → **0 次装配、0 次注入**。这从反面确认：注入绑定的是**模型步**，不是"turn 存在"。

### 3.6 投递载荷：无法直接证明，只能推断（显式标注）

我尝试用 `session-log-deepseek/delivery-accepted` 记录（235 条）直接证明"那次 goal 续跑的请求里也带了记忆块"，**失败且必须如实说明**：

```
  delivery-accepted 记录数: 235
  单条载荷大小范围: 188 … 192 字节
  keys: ["sessionId","sessionFormatVersion","throughSeq"]
  样例: {"sessionId":"session-ce78e7c0-…","sessionFormatVersion":4,"throughSeq":20}
  全部投递记录中含"完整记忆块"的: 0 / 235
```

这些只是**进度 ACK**，不含请求载荷。因此：

> ⚠️ **待验证/推断**：turn seq=395（goal 自动续跑，3 个 step，时间 17:44:29）的模型请求中包含记忆块，这一条**没有直接观测证据**，属于**代码路径推断**：
> ① `assemble()` 全树唯一调用点是 `preStep()`；② `preStep` 每个 step 调用一次；③ 该 turn 有 3 个 step；④ 该时段段落处于已注册状态（seq 291 @17:41:55 与 seq 1509 @12:09 两端均含块，其间无任何写操作）；∴ 应有 3 次装配且包含该段落。
> 它是**可证伪的**，但我没有直接证据，故不当作已证实结论。

### 3.7 跨会话范围（T3）

`resolveStorePath()` 的入参只有 `env` 与 `home`，**不含 session、不含 cwd**：

```
  env 无 DSH_HOME 时 -> C:\Users\example\.dsh\instruction-memory\memory.json
  env 有 DSH_HOME 时 -> D:\alt\instruction-memory\memory.json
```

实测同一份记忆块出现在**4 个不同工作目录**的会话中：

```
  4/ 6  --D-Users-34332-AI-dsh-instruction-memory--   本审计项目
  2/ 2  --D-Users-34332-Documents--                    另一个目录
  2/15  --D-Users-34332-AI--                           另一个目录
  1/ 1  --C-Users-34332-.dsh--                         另一个目录
```

---

## 四、判定

| 判据 | 结论 | 证据 |
| --- | --- | --- |
| **T1** 无 turn 运行时仍注入 | **不成立** | §3.2 空转 4000ms：0 次求值、0 次写入、CPU 0.0ms；§3.3 真实世界 41.5h 空档 0 次装配；§3.1 结构性：装配唯一入口 `preStep` 要求 running phase |
| **T2** 重复注入 | **不成立** | §3.5 六条 prompt 中块的出现次数均为 1；且结构上不可能——`dsh-system-prompt` 的 `NamedEntries.insert` 对重名直接抛错（`lib/index.js:190`），插件侧另有 `sectionDispose === null` 守卫 |
| **T3** 越权跨会话扩散 | **部分成立但属设计** | §3.7 记忆是**用户级全局**，出现在 4 个不同项目目录的会话里。这是"长期指令适用于此后所有对话"的既定语义，不是越权；但对"以为只在本项目生效"的用户是**预期落差**，见 §5 注意 2 |

**总判定：属设计行为（design behavior），不是缺陷。**

三点必须精确区分的事实（都不是"偷跑"，但都与提问的字面表述相关）：

1. **S1（进程启动、零会话）时插件确实"自动执行"了磁盘动作** —— 读存储，首次运行时还会创建一个 78 字节的空存储。这是"无任务仍执行"的**字面成立**部分；但它**不产生任何注入**（空存储连段落都不注册）。
2. **S2（会话空闲）时零动作** —— 不读、不写、不装配、不创建任何句柄。
3. **S3（无人值守 turn）时会注入** —— 本会话观测到 1 次（`kind=goal` 的自动续跑）。此时 **agent 确实在跑任务**，只是没有人类打字；它不属于"空转"。**这不是插件的决定**：插件无法区分"这轮是谁发起的"，任何 turn 都有系统提示词。

---

## 五、根因定位（具体文件与函数）

| 行为 | 位置 | 性质 |
| --- | --- | --- |
| 启动即读存储 | `lib/index.js` `apply()` → `const boot = readFromDisk()…`（约 L714） | 设计：段落必须在首次装配前就位 |
| 首次运行创建空存储 | `lib/index.js` `readFromDisk()` 第 3 步 "First run: materialise an empty store"，调用 `writeToDisk()` | 设计，但**是唯一无任务的副作用** |
| 唯一一次段落注册 | `lib/index.js:518` `systemPrompt.section({ name, order: 950, text: sectionText })` | 设计：交出 thunk，由宿主拉取 |
| **注入真正发生处** | `dsh-agent-loop/lib/index.js:902-925` `preStep()` → `:907` `systemPrompt.assemble()` | 宿主决定，插件无从介入 |
| thunk 被求值 | `dsh-system-prompt/lib/index.js:342` `typeof section.text === "function" ? section.text(context) : section.text` | 宿主装配时 |
| 重名注册被拒 | `dsh-system-prompt/lib/index.js:190` `NamedEntries` 抛 `"prompt section \"x\" is already registered"` | 结构上排除重复注入 |
| 无轮询 | `lib/client.js:317-319` `React.useEffect(() => { callHost('state') }, [])` | 面板挂载时一次 |

---

## 六、修复 / 缓解建议

均非"修 bug"，而是按你的口径把边界收紧到更符合直觉。

1. **去掉唯一无任务的副作用（S1 建空存储）** — 把首次运行的 `writeToDisk()` 改为惰性：不主动物化空文件，等第一次保存或设置页访问 `state` 时再写。
   *代价*：`storage.path` 在真正保存前不指向已存在文件；设置页需容忍"尚未写入磁盘"（现有 UI 文案已支持该状态）。
   *回归*：`contract-test.mjs` 需新增断言 —— 全新 DSH_HOME 挂载后目录仍为空，且 `state.injection.registered === false`。

2. **修正日志文案，避免"已注入"误读** — 1.0.10 的 `injected=231 chars` 在零会话时也会打印。改为 `section=231 chars (pending assembly)`，并加 `sessions=0` 之类的语境，明确"段落已就绪"≠"已注入"。

3. **给用户一个显式的范围提示（针对 §3.7）** — 设置页已显示存储绝对路径，可在条目区加一句"此记忆对此 DSH_HOME 下的**所有会话与项目**生效"。这是**产品判断**，不是缺陷修复；若你希望改为按项目隔离，那是另一项需求（会改变"用户长期指令"的语义）。

4. **无需针对 S3 改动** — 若要"只有人类输入才注入"，那是**宿主策略**（turn 门控），不属于本插件；插件拿不到发起者信息。可行做法是在 DSH 侧关闭 goal 自动续跑，或由宿主把非人类发起的 turn 标记出来。

---

## 七、回归验证方式

```powershell
cd D:\Users\34332\AI\dsh-instruction-memory
node .\dsh-memory-verification\scripts\idle-probe.mjs            # 期望：空转 4000ms 内新增 0/0/0，CPU 0.0ms
node .\dsh-memory-verification\scripts\idle-probe.mjs --control  # 期望：与上者同样零动作（对照）
node .\dsh-memory-verification\scripts\runaway-forensics.mjs     # 期望：重复注入 0；块出现次数均为 1
node .\dsh-memory-verification\scripts\wake-attribution.mjs      # 期望：非人类发起的 turn 数被明确列出
node .\dsh-memory-verification\scripts\delivery-probe.mjs        # 期望：落在 turn 之外的 step = 0
npm test                                                         # 期望：全套通过（当前 177 PASS / 0 FAIL）
```

**可证伪的预测**（若未来出现真偷跑，下面这些会先变红）：
- `idle-probe` 的"空转期间存储被写"或"`spec.text` 求值"变为非 0；
- `delivery-probe` 的"落在任何 turn 窗口之外的 step/start"变为非 0；
- `runaway-forensics` 中某条 prompt 的块出现次数 ≠ 1，或出现找不到前瞻刺激的 prompt。

---

## 八、本次审计修正的两处自身错误（如实记录）

1. **句柄归因**：初版只跑插件组，看到空转期间新增 1 个 `Socket`，险些归因于插件；加对照组后发现**不挂载插件同样出现** → 与插件无关。
2. **无人值守 turn 计数**：初版用"turn 窗口内有无 `user/message`"判断，得出 3 个；改用权威字段 `source.kind` 后更正为 **1 个**。原判据错在消息先 splice 进 inbox、`user/message` 记录会落在窗口之外。

## 九、未能证实 / 明确标注为待验证的部分

| 项 | 状态 |
| --- | --- |
| turn seq=395（goal 续跑）的请求中是否含记忆块 | **推断**，非直接观测（`delivery-accepted` 仅 190 字节 ACK，不含载荷）。见 §3.6 |
| 队友消息（AgentTeams）触发的 turn 是否带块 | **未观测**。本会话无此类 turn；按同一代码路径推断应为"是"。待验证 |
| 运行中的宿主是否与 1.0.10 行为一致 | **一致，且已实测确认**。宿主进程于 **2026-09-27 12:08:48 重启**（现 PID 26028，非第一轮记录中的 PID 35212/09-25 17:21），重启后从 profile junction 加载了仓库当前源码 = **1.0.10**。判定依据是 1.0.10 独有的可观测行为：对 `Host: evil.com:8080` 的 `POST /instruction-memory/api` 返回 **403** 及 1.0.10 的原始文案 `请求来源被拒绝：Host 头不是回环地址…`（修复前的代码对该请求返回 200）。复现：`node .\dsh-memory-verification\scripts\live-version-check.mjs` |
| 本次审计的插件侧实验与宿主的版本关系 | 两侧**同为 1.0.10**。插件侧脚本直接 `import` 仓库源码；宿主指向同一份源码。转录证据跨越两个版本（09-25 的事件在旧代码下产生，09-27 起在 1.0.10 下产生），但 1.0.10 的改动**未触及注入语义**：`syncSection()` 仍以 `order=950` 与 `text: sectionText`（thunk）注册，改动集中在 `inject` 数组、路由注册方式、诊断日志、Host 防护与事务化提交。逐项差异见 [FIXES.md](FIXES.md) 与 [ROUND2.md](ROUND2.md) |
