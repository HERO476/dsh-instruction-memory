# 第三轮：去掉唯一无任务的副作用 + 修正日志文案

承接 [RUNAWAY-AUDIT.md](RUNAWAY-AUDIT.md) §6 的建议 1 与建议 2。

| 项 | 变更前 | 变更后 |
| --- | --- | --- |
| 全新安装（零会话）启动 | **主动创建** 78 字节空 `memory.json` | **不写任何文件**，连目录都不建 |
| 挂载日志 | `… enabled=true injected=437 chars` | `… onDisk=yes entries=2 enabled=true section=437 chars (pending assembly) pulls=0` |
| 可观测的"真的注入了吗" | 无 | `pulls`（宿主实际拉取次数）+ `injection.pulls` 快照字段 |

回归：**`npm test` 190 PASS / 0 FAIL**（本轮前 177）｜A/B 台 70/0｜真实 cordis 9/0｜路由防护 36/0｜
空转实验仍为 0/0/0、CPU 0.0ms｜6 个历史缺陷仍全部不复现。

---

## 1. 惰性创建存储（去掉 boot 期磁盘写入）

### 1.1 改了什么

`readFromDisk()` 的第 3 步（全新安装分支）原本直接 `await writeToDisk()`，只为"让设置页有个真实路径可显示"。
现在它只置一个标志：

```js
// 3. First run: there is no store anywhere. Deliberately write NOTHING.
needsMaterialize = true
state.loadedFrom = 'first run (no store on disk yet)'
state.storeExists = false
```

文件改由**第一个真正需要它的动作**创建：

- **保存 / 导入** —— 本来就会写，`writeToDisk()` 成功时清除 `needsMaterialize`；
- **设置页读取 `state`** —— 新增 `ensureStoreMaterialized()`，在 `dispatch('state')` 里调用。

```js
const ensureStoreMaterialized = async () => {
  if (!needsMaterialize) return false
  return writeToDisk()          // 失败则标志保持，下次重试，不会假装文件已存在
}
```

### 1.2 代价（已确认可接受，且 UI 本就支持）

- 在真正保存之前，`storage.path` 指向一个**尚不存在**的文件；
- `state.storage.onDisk === false`，设置页显示「**尚未写入磁盘**」——该文案是既有的，无需改动客户端；
- `state.injection.registered === false`、`pulls === 0`。

### 1.3 明确不受影响的两条分支

只有**磁盘上已有真实数据**时才会走，仍然立即写回：

- `.bak` 恢复（主文件缺失 / 主文件损坏）；
- 旧位置（cwd）迁移。

### 1.4 一个需要知道的行为细节

全新安装的**第一次保存**现在不会再顺带产生 `memory.json.bak`。变更前，boot 期那次空写算作"第一次写"，
于是用户的第一次真实保存成了第二次写，就会把那份**空存储**滚成 `.bak`。现在 `.bak` 的语义更准确了：
它保存的是"上一次真实内容"，而第一次保存之前并没有内容可滚。既有多条保存的回归断言
（`rolling backup memory.json.bak exists`）仍然通过。

---

## 2. 日志文案：`injected=` → `section=… (pending assembly)` + `pulls`

```
[instruction-memory] mounted: store=… from=memory.json onDisk=yes entries=2 enabled=true section=437 chars (pending assembly) pulls=0
```

### 2.1 关于 `sessions=0`：我没有加

你建议"加 `sessions=0` 之类的语境"。**这一点我没照字面做，因为它会编造数据**：
本插件不依赖任何 session 服务，`inject = ['systemPrompt']`，它**根本不知道有几个会话**。
在日志里写一个自己观测不到的数字，比原来那句含糊的 `injected=` 更糟。

我用了**等价但真实可测**的量：**`pulls`**。

### 2.2 `pulls` 是什么

宿主每次装配提示词，就会求值插件注册的那个 thunk。原来注册的是 `sectionText` 本身，
所以插件数不清"自己被拉取了几次"；现在注册的是包装函数：

```js
const assembledSectionText = () => {
  sectionPulls += 1
  logDebug('section pulled into a prompt (pull #' + sectionPulls + ')')
  return sectionText()
}
```

于是：

- `pulls=0` = 段落已就绪，**从未被装配**（进程刚起、或会话空闲）；
- `pulls=N` = 已被拉进提示词 N 次；
- 每次拉取另有一条 `debug` 行 `section pulled into a prompt (pull #N)` —— 这正是第二轮审计里
  **缺失的那种直接证据**：当时只能靠代码路径推断"那次 turn 有没有真的带块"。

返回值未被触碰：`verify.mjs` 断言"有/无 logger 时渲染文本逐字节相同"，
`idle-probe.mjs` 断言"注册的 thunk 渲染结果 === `buildBlock()` 输出"。两条都通过。

`pulls` 同时进入路由快照（`injection.pulls`），设置页将来可以直接展示。

---

## 3. 回归验证

### 3.1 新增断言（`contract-test.mjs`，用**独立挂载 + 独立 DSH_HOME**，否则测不出"启动不写文件"）

```
PASS  lazy first run: booting writes no store file
PASS  lazy first run: booting does not even create the store directory
PASS  lazy first run: the mount line reports onDisk=no, first run, and nothing to inject
PASS  lazy first run: nothing has been pulled into a prompt yet (pulls=0)
PASS  lazy first run: an empty memory registers NO prompt section
PASS  lazy first run: reading state materialises the store
PASS  lazy first run: the snapshot reports onDisk=true afterwards
PASS  lazy first run: pulls is still 0 (prepared nowhere, assembled nowhere)
PASS  lazy first run: saving registers the section
PASS  lazy first run: registering alone does not move pulls
PASS  lazy first run: the registered thunk renders the memory
PASS  lazy first run: a host assembly moves pulls to 1
```

### 3.2 更新的断言

- `verify.mjs`：原来断言日志含 `injected=`（我自己写的旧措辞），改为断言含 `section=` + `pulls=`，
  并**新增一条反向断言**：挂载行必须含 `pending assembly` 且**不得**含 `injected=`。

### 3.3 实测输出

```
[全新 DSH_HOME，无任何会话]
  存储文件挂载前存在 : false
  存储文件挂载后存在 : false   <-- 惰性创建：boot 未写文件
  注册的 prompt 段落 : 0
  日志: "mounted: … from=first run (no store on disk yet) onDisk=no entries=0 enabled=true section=nothing to inject pulls=0"

[已有存储，但同样零会话]
  注册的 prompt 段落 : 1
  日志: "mounted: … from=memory.json onDisk=yes entries=1 enabled=true section=231 chars (pending assembly) pulls=0"
```

复现：`node .\dsh-memory-verification\scripts\boot-and-wake.mjs`

### 3.4 未受影响的关键指标

```
空转 4000ms 内 section() 新增     : 0
空转 4000ms 内 spec.text 求值     : 0
空转 4000ms 内存储被写            : 0
空转 4000ms 内消耗 CPU            : 0.0ms
生产注入块                        : 437 字符 sha256=D66C3C3E…（逐字节未变）
生产 memory.json                  : 06013E41…（逐字节未变，目录内仅此一文件）
```

---

## 4. 变更文件

```
 README.md         | +38  「首次运行不写文件（惰性创建）」+ 日志措辞说明（含为何不用 sessions=）
 contract-test.mjs | +104 12 条惰性创建/pulls 回归断言（独立挂载）
 lib/index.js      | +98  needsMaterialize / ensureStoreMaterialized / assembledSectionText /
                          storeExists / sectionPulls / 新日志文案
 verify.mjs        | +9   日志措辞断言更新 + pending assembly 反向断言
```

## 5. 发布记录（1.0.11）

| 项 | 值 |
| --- | --- |
| 版本 | **1.0.11**（npm `latest` 由 1.0.10 → 1.0.11） |
| 提交 | `91bf41d` —— 已推送到 `origin/main` |
| Tag | **`v1.0.11`**（已推送；这是本仓库第一个 tag） |
| `dist.integrity` | `sha512-hENLc4vnYr1Y9M9UZukupr9FR55bNGrtkALymUpItsMHtVU3h7xH2of4xi/10CKVE95DybHLGtAd3lYZc5ErQ==` |
| `dist.gitHead` | `91bf41dea7b214d7f37942d20dba2b7e9e0c3b03` |
| 发布方式 | **本地 `npm publish`（token）** —— 见下 |
| provenance 存证 | ❌ 仍无（与 1.0.10 相同） |
| 发布物验证 | 从 registry 全新缓存安装：`lib/index.js`、`lib/client.js`、`README.md`、`cordis.patch.yml` **与本地逐字节一致**；`inject=["systemPrompt"]`；包内确实含 `ensureStoreMaterialized` / `first run (no store on disk yet)` / `pending assembly` / `pulls=` |

### 5.1 我尝试了仓库文档规定的 OIDC 通道，它失败了

这次 GitHub 可达，所以我按 `publish.yml` 的说明推了 tag `v1.0.11` 触发 OIDC 发布。结果：

```
Publish #1  event=push  head=v1.0.11  conclusion=failure
  步骤结论：
    [success] Run npm test
    [success] Check package.json version matches the tag
    [failure] Run npm publish --access public     <-- 唯一失败步骤
```

其余步骤（含 `npm test`、tag↔version 一致性）全部通过，**只有 `npm publish` 那一步失败**。
这与 `publish.yml` 自己注释里的警告完全一致：

> `One-time setup on npmjs.com, required BEFORE this can publish:
> Package -> Settings -> Trusted publishing -> Add trusted publisher …
> trusted publishers created after 2026-09-03 default to allowing only
> "npm stage publish". Direct publishing must be explicitly enabled`

补充事实：**`Publish` 工作流在此之前从未运行过**（历史上 6 次运行全是 `CI`，全部 success），
所以这条通道从未被验证；1.0.10 也确实没有 attestation。运行日志需鉴权（403），拿不到 npm 的原文错误。

**需要你做的事**：在 npmjs.com 上为该包配置 Trusted Publisher
（Organization/user = `HERO476`，Repository = `dsh-instruction-memory`，Workflow filename = `publish.yml`，
Allowed actions 勾选 **npm publish**）。配好之后，后续版本推 tag 即可由 CI 带上 provenance 发布；
**1.0.11 本身已由本地 token 发布，不要再推 tag 让它重发**（版本已占用，重跑只会再红一次）。

### 5.2 本次的发布顺序（供复核）

1. `package.json` 1.0.10 → 1.0.11；`npm test` 190/0；`check-metadata.mjs` 通过；`npm pack --dry-run` 7 个文件；
2. `git commit` `91bf41d` → `git push origin main`（成功）；
3. `git tag -a v1.0.11` → `git push origin v1.0.11`（成功，触发 Publish #1 → **failure**）；
4. 确认失败的 CI **没有留下任何东西**（registry 直连查询：1.0.11 不存在）；
5. 回退到已验证可用的本地 token 发布 → `+ dsh-instruction-memory@1.0.11`；
6. 直连 registry 轮询约 2 分钟 → `latest=1.0.11`，integrity/gitHead 与本地一致；
7. 全新缓存安装并逐字节比对 → 一致。

> 传播延迟提示（两次都遇到）：发布成功后 `npm view` / `npm install` 在 **1–2 分钟内仍可能
> 报旧版本或 `ETARGET`**，因为 registry 传播 + npm 本地 packument 缓存。用
> `Invoke-RestMethod` 直连 registry（带 `Cache-Control: no-cache`）轮询，或加
> `--cache <全新目录>`，即可绕过。

### 5.3 未生效提醒

运行中的宿主仍是 **1.0.10**（PID 26028，09-27 12:08:48 启动）——`live-version-check.mjs` 显示
`1.0.10+ (Host/Origin guard active)`。1.0.11 的惰性创建与新日志文案**需要重启 DSH 才生效**。

