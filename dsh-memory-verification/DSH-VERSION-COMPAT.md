# dsh-instruction-memory 1.0.11 × 最近 10 个 DSH 版本 适配核验

**结论：10 个版本全部适配（契约层 12/12 通过）；并对受检版本里最旧与最新的 cordis（4.0.2 / 4.0.4）做了真实挂载执行（各 9/9）。**

核验对象：`dsh-instruction-memory@1.0.11`（npm `latest`）
核验日期：2026-09-27｜Windows 10.0.26200｜Node v22.23.2
证据：`dsh-memory-verification/out/dsh-version-matrix.json`、`logs/dsh-version-matrix.txt`

---

## 0. 先说清楚"最近 10 个 DSH"是怎么定的

**取自 npm 官方 registry 的 `@deepseek-ai/dsh` packument，按发布时间倒序取 10 个**（不是猜、不是按 semver 排序——预发布版本的 semver 顺序与发布顺序并不一致）：

| # | 版本 | 发布时间 | cordis |
| --- | --- | --- | --- |
| 1 | 0.1.7-rc.2 | 2026-09-24 | 4.0.4 |
| 2 | 0.1.7-rc.1 | 2026-09-23 | 4.0.4 |
| 3 | 0.1.7-alpha.2 | 2026-09-23 | 4.0.4 |
| 4 | 0.1.7-alpha.1 | 2026-09-22 | 4.0.4 |
| 5 | 0.1.5-rc.3 | 2026-09-22 | **4.0.2** |
| 6 | 0.1.6-alpha.2 | 2026-09-17 | 4.0.4 |
| 7 | 0.1.6-alpha.1 | 2026-09-15 | 4.0.4 |
| 8 | 0.1.5-rc.2 | 2026-09-10 | 4.0.4 |
| 9 | 0.1.5-rc.1 | 2026-09-10 | 4.0.4 |
| 10 | 0.1.5-alpha.2 | 2026-09-09 | 4.0.4 |

该包公开版本共 27 个。**顺带一个事实**：`dist-tags` 是 `latest=0.1.5-rc.3`、`next=0.1.7-rc.2`、`alpha=0.1.7-alpha.2`——**`latest` 比 `next` 还旧**。也就是说按 `latest` 安装的人拿到的是 0.1.5-rc.3，它同样在本次核验范围内且通过。

---

## 1. 方法（三层，逐层加强）

| 层 | 做什么 | 覆盖 |
| --- | --- | --- |
| L1 语义层 | 该版本是否落在插件声明的 `engines.dsh` 范围内（默认 + `includePrerelease` 两种判定，用 profile 自带的 semver） | 10/10 |
| L2 契约层 | 抓**那个版本真实发布的源码**，核验 1.0.11 实际用到的每个符号 | 10/10 |
| L3 执行层 | 把插件**真的挂载**进该版本的 `@deepseek-ai/cordis`，跑 9 项断言 | 4.0.2 + 4.0.4 两个真实版本 |

核验的具体依赖面（1.0.11 实际用到的全部）：

- `@deepseek-ai/dsh-system-prompt`：`section()` 方法、`assemble()` 是否求值**函数型** `text`（注入机制成立与否的关键）、`FILE_REFERENCE=900` / `TOOL_BASH=1000` 是否仍在（决定 order 950 是否空档）、重名注册是否抛错
- `@deepseek-ai/dsh-host-webserver`：`register(route)`、`get host()`（1.0.10 的 Host 防护依赖它）
- `@deepseek-ai/cordis`：`ctx.inject()`（**1.0.10 新引入的硬依赖**）、`ctx.effect()`
- `dsh.client.inject` 声明的两个客户端包：在各版本是否存在、是否真的声明了 `dsh.client`

---

## 2. 我在这轮里犯过并修正的两次方法错误（必须先说）

这很重要，因为前两版的"结论"都是错的，如果直接汇报会得出**完全不成立**的适配失败。

**错误 1 — v1**：直接读 `@deepseek-ai/dsh` 顶层 `dependencies` 找子包 → 全部 `null`，据此判定 10 个版本全失败。
**真相**：`@deepseek-ai/dsh-system-prompt` 等**从不是** `dsh` 的直接依赖，只出现在传递依赖里（本机就装在 `dsh/node_modules/@deepseek-ai/` 下）。v1 的 60 项"失败"全部是我的取值错误。

**错误 2 — v2**：自己写 BFS 重实现 npm 依赖解析 → 只接受"精确锁定"形式的依赖，而**旧版本用 `^0.1.5-rc.3` 这类范围**，整棵树被剪空，7 个版本假失败。
**真相**：修复路径不是把 BFS 写得更聪明，而是**不要重实现 npm 的解析器**。改用可验证的等价模型（见下）。

**v3 的依据（两条独立证据，不是假设）**：

1. **家族同步发布**：5 个同族子包各自发布的版本列表**与 dsh 的版本逐个对应**——
   `dsh-system-prompt` 28 个版本 / `dsh-host-webserver` 28 / `dsh-client-ui-renderer` 20 / `dsh-client-ui-settings` 28 / `dsh-agent-loop` 28，且**都包含本次受检的全部 10 个版本**（脚本里逐项断言）。
2. **本机安装树**：`dsh@0.1.7-rc.2` → 5 个子包全部 `0.1.7-rc.2`，与之一致。

所以"`dsh@V` 的同期依赖树 = 各子包 `@V`"是**被验证的前提**，据此对 `@V` 的真实源码做 API 核验。

---

## 3. 适配矩阵

| DSH 版本 | semver 覆盖 | `section()` | 函数型 text | order 950 空档 | `register()` | `get host()` | cordis | `ctx.inject` | 客户端声明 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.1.7-rc.2 | ✔ / ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | 4.0.4 | ✔ | ✔ |
| 0.1.7-rc.1 | ✔ / ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | 4.0.4 | ✔ | ✔ |
| 0.1.7-alpha.2 | ✔ / ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | 4.0.4 | ✔ | ✔ |
| 0.1.7-alpha.1 | ✔ / ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | 4.0.4 | ✔ | ✔ |
| 0.1.5-rc.3 | ✔ / ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | **4.0.2** | ✔ | ✔ |
| 0.1.6-alpha.2 | ✔ / ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | 4.0.4 | ✔ | ✔ |
| 0.1.6-alpha.1 | ✔ / ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | 4.0.4 | ✔ | ✔ |
| 0.1.5-rc.2 | ✔ / ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | 4.0.4 | ✔ | ✔ |
| 0.1.5-rc.1 | ✔ / ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | 4.0.4 | ✔ | ✔ |
| 0.1.5-alpha.2 | ✔ / ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | 4.0.4 | ✔ | ✔ |

`semver 覆盖` = 默认模式 / `includePrerelease` 模式（后者是 dshmarket 的发现路径所用的语义）。

**12 项判定，0 项未通过**。逐项：前提(lockstep)、semver×2、`section()`、函数型 text、order 950、重名抛错、`register()`、`get host()`、`ctx.inject`、`ctx.effect`、客户端声明。

### L3 执行层（真实挂载，不只是 grep 符号）

**1.0.10 起 `inject` 去掉了 `webServer`，改为非阻塞 `ctx.inject(['webServer'], …)`——这是新版最大的新增依赖**，所以特意对它做真实执行：

```
cordis@4.0.2（受检版本里最旧）  checks: 9, failed: 0
cordis@4.0.4（DSH 自带那版）    checks: 9, failed: 0
```

9 项含：只发布 `systemPrompt` 时注入段落已注册（**没有 webServer 也能注入**）、之后发布 `webServer` 时路由被正确挂上、真实 fiber 上路由能应答 `state`、卸载时两者都被注销。

---

## 4. 附带观测：**今天**安装旧版 dsh，子包会漂移

早期 dsh 用 caret 范围声明同族依赖（`^0.1.5-alpha.2`），范围会随时间"往前漂"。用 semver 对已发布版本表直接算出结果（不是推测）：

| DSH 版本 | 同族依赖声明 | 今天默认语义解析到 | 今天 `includePrerelease` 解析到 |
| --- | --- | --- | --- |
| 0.1.7-rc.2 / rc.1 / alpha.2 | **全部精确锁定** | 同期版本 | 同期版本 |
| 0.1.7-alpha.1 | `dsh-hmr ^0.1.7-alpha.1` | 0.1.7-rc.2 | 0.1.7-rc.2 |
| 0.1.5-rc.3 | `dsh-base ^0.1.5-rc.3` | 0.1.5-rc.3 | **0.1.7-rc.2** |
| 0.1.6-alpha.2 | `dsh-hmr ^0.1.6-alpha.2` | 0.1.6-alpha.2 | **0.1.7-rc.2** |
| 0.1.6-alpha.1 | `dsh-base ^0.1.6-alpha.1` | 0.1.6-alpha.2 | **0.1.7-rc.2** |
| 0.1.5-rc.2 / rc.1 / alpha.2 | `dsh-base ^0.1.5-rc.x` | 0.1.5-rc.3 | **0.1.7-rc.2** |

**3/10 精确锁定（不可能漂移），7/7 采样都会漂移。** 这意味着"旧版 DSH 今天装出来的树"与"当年装出来的树"可能不同。

**这对本插件的结论没有影响**：漂移的目标 `0.1.7-rc.2` 恰好也是本次核验通过的版本，且相邻版本的同族 API 逐版本都是 ✔。但它是运维上值得知道的事实。

---

## 5. 明确**没有**验证的部分（不得当作已验证）

| 项 | 状态 |
| --- | --- |
| **真实启动 DSH** | ❌ **本次没有对任何版本做真实 DSH 启动**。L2 是源码符号核验，L3 是 cordis 真实挂载——都不是"启动一个 0.1.6-alpha.2 的 DSH 看插件是否装上"。原因：单个版本完整安装约 465 MB、本机实测一次 `npm install --package-lock-only` 就耗时 **468 秒**（且未产出可用锁文件），10 个版本不现实 |
| README 的"实测范围" | ⚠️ 那是**仓库自己的记录**（声称 0.1.3-alpha.2 / 0.1.5-alpha.1 / 0.1.5-alpha.2 / 0.1.5-rc.1 / 0.1.5-rc.2 在 Windows/Node 22 上真实启动过）。**我本轮没有复核这 5 次启动**，只是复述 |
| 客户端真实加载 | ⚠️ 对 0.1.7-rc.2 由 `verify.mjs` 用桩 ModuleLoader 真加载；对其余 9 个版本只核验了"包存在 + 声明 `dsh.client` + 源码里确实调用 `__ModuleLoader__.load`"。**不是真实浏览器加载** |
| 各版本真实 Web 服务器上的路由注册 | ⚠️ 用 req/res 桩（`contract-test.mjs`）与假 webServer（real-cordis-mount）验证；**没有**对每个版本的 `WebServer` 真实现跑一遍 |
| `rangeDriftToday` 的计算 | ⚠️ 用 `semver.maxSatisfying` 对已发布版本表计算，**不是**真的跑 npm 安装。真实 `npm install` 的解析结果可能因 npm 版本/配置不同 |
| 0.1.8+ 的预发布版本 | 插件声明范围本就覆盖不到（npm 预发布门禁按 `[major,minor,patch]` 精确匹配），这是已知限制，已在 README 记录并有自验证修复配方 |

---

## 6. 复现

```powershell
cd D:\Users\34332\AI\dsh-instruction-memory

# L1+L2：10 个版本的语义覆盖 + 契约面核验（只读外部 registry/CDN）
node .\dsh-memory-verification\scripts\dsh-version-matrix.mjs

# L3：把插件真实挂载进指定版本的 cordis
$cd = Join-Path $env:TEMP 'cordis-402'
New-Item -ItemType Directory -Force $cd | Out-Null
Set-Content (Join-Path $cd 'package.json') '{"name":"c","version":"1.0.0","private":true}' -Encoding utf8
Push-Location $cd; npm install @deepseek-ai/cordis@4.0.2 --no-audit --no-fund; Pop-Location
$env:CORDIS_LIB = Join-Path $cd 'node_modules\@deepseek-ai\cordis\lib\index.js'
node .\dsh-memory-verification\scripts\real-cordis-mount.mjs   # 期望 checks: 9, failed: 0
Remove-Item Env:\CORDIS_LIB; Remove-Item $cd -Recurse -Force
```

**可证伪的预测**：若某个 DSH 版本真的不兼容，`dsh-version-matrix.mjs` 会在对应单元格打出 ✘ 并使退出码非 0；`real-cordis-mount.mjs` 会在挂载/路由/卸载任一步 FAIL。

---

## 7. 与本次任务相关的其他事实

- 本轮**没有改动任何要发布的代码**（`lib/`、`package.json`、`README.md` 零改动，`git status` 只有未跟踪的 `dsh-memory-verification/`）。因此**不需要新版本**：npm `latest` 仍是 1.0.11，`git HEAD = origin/main = 91bf41d`，tag `v1.0.11`。
- 插件自身回归仍为 **`npm test` 190 PASS / 0 FAIL**。
- 运行中的宿主是 1.0.10（PID 26028），与本轮的版本核验无关。

---

## 8. 声明处置：为什么不改范围，只改表述 → 1.0.12

处置结论（经用户确认）：**范围字符串保持不变，只更新 README 的声明表述**，随后**发布 1.0.12**。

### 8.1 "不改范围"是有证据的决定，不是偷懒

对**全部 27 个**已发布宿主版本穷举核验（`scripts/dsh-range-audit.mjs`）：

| 项 | 结果 |
| --- | --- |
| 声明范围接住的已发布版本 | **12 个**（`0.1.3-alpha.2` → `0.1.7-rc.2`） |
| 其中 API 面全部齐备的 | **12 个** |
| **超范围承诺** | **0** |
| 范围外的已发布版本 | 15 个（`0.0.1-rc.1` → `0.1.2-rc.1`），API 面**也齐备**，但**从未真实启动验证** |

- **不收紧**：范围内 12 个版本 API 全部齐备，收紧会丢掉真实可用的支持。
- **不放宽**：范围外那 15 个虽然 API 齐备，但一次都没有真机启动过。把没验证过的东西写进声明，正是这份报告一直在避免的事。

### 8.2 顺带补掉的一个自身缺口

上一版矩阵对旧版本按"今天能解析到的 cordis 4.0.4"核验——**这样不对**：它们**同期**用的可能是 cordis 4.0.1。补齐后：

```
cordis 版本      ctx.inject   ctx.effect
4.0.1-rc.1       True         True
4.0.1-rc.4       True         True
4.0.1            True         True
4.0.2            True         True
4.0.3            True         True
4.0.4            True         True
```

**`ctx.inject` 在 cordis 全部 6 个已发布版本里都存在**，而声明范围内各 dsh 版本要求的都是 `^4.0.2` / `4.0.2` / `^4.0.3` / `~4.0.4`。所以 1.0.10 引入的那个硬依赖，**不会**在任何范围内版本上失效。

### 8.3 README 改了什么

原来是一段含糊的"**实测范围**：5 个版本真实启动 + `0.1.6-alpha.2`/`0.1.7-rc.2` 由范围测试覆盖；其他均未实测"。现在改为**三档证据等级**并逐档点名：

- ① **真实启动**（5 个版本，Windows / Node 22，确认注入真的进入组装后的提示）
- ② **契约核验**（范围内全部 12 个版本，逐符号核验该版本**真实发布的源码**）
- ③ **真实执行**（cordis 4.0.2 / 4.0.4 各 9/9，插件真的挂载进去）

并新增三段事实说明：`ctx.inject` 在全部 6 个 cordis 版本存在；"超范围承诺 = 0"的数据与口径；以及**旧版 DSH 今天安装会漂移**（7/10 采样）。

`## 兼容性` 里的范围字符串**逐字节未改**；`dsh.engines.dsh` 与 `dsh.compatibility.dsh` 仍完全一致（`host-range-test.mjs` 有断言）。

### 8.4 1.0.12 发布记录

| 项 | 值 |
| --- | --- |
| 版本 | **1.0.12**（`latest` 1.0.11 → 1.0.12） |
| 提交 | **`a92f3f8`**，已推送 `origin/main` |
| 改动 | `README.md`（声明表述）、`package.json`（版本号）；**代码零改动** |
| `dist.integrity` | `sha512-7HUyJw+s2YWic2o5VzDRRZXuuekusfkLesBzxdaydqKF1JQPpFtwyH/xCdzoir9OGetkE3yp6q090/jRbTC0DQ==` |
| `dist.gitHead` | `a92f3f873a3c8c52a1ed03d8cb1d826fdd4397cc` |
| 发布方式 | 本地 `npm publish`（token） |
| provenance | ❌ 无（OIDC 通道仍未配置，见 1.0.11 记录） |
| **Git tag** | ❌ **未推** —— 推 tag 会触发未配置的 OIDC 工作流，只会再产生一次必红的 CI。1.0.11 那次已实测（Publish #1 failure，唯一失败步骤就是 `npm publish`） |
| 发布物验证 | 全新缓存安装后 `lib/index.js`、`lib/client.js`、`README.md`、`package.json`、`cordis.patch.yml` **与本地逐字节一致**；README 里新的三档证据等级表述确实在包内；`engines.dsh` 与 `compatibility` 仍一致 |
| 回归 | `npm test` **190 PASS / 0 FAIL** |

### 8.5 仍需你完成 / 仍未验证

- **npm Trusted Publisher**：~~未配置~~ → 见 §9，**已配置并已实测生效**。
- **真机启动仍未做**：①档仍是仓库自己那 5 个版本的记录，我本轮没有复核；②档只证明 API 面存在，不证明端到端可用。

---

## 9. OIDC 发布通道：已实测打通 → 1.0.13 是第一个带 provenance 的版本

用户告知 npm 侧 Trusted Publisher 已配置。配置本身**无法从外部验证**（npm 不公开该设置），
唯一能确证的方式是**让 CI 去发一个尚未占用的版本**——因为 npm 不允许版本复用，用已发布的版本试
只会得到 `EPUBLISHCONFLICT`，与认证是否成功无关。

### 9.1 先核对能核对的前置条件

| 前置条件 | 结果 |
| --- | --- |
| `package.json` 的 `repository.url` 与 npm 记录**完全一致**（工作流注释点名的第一要求） | ✅ `git+https://github.com/HERO476/dsh-instruction-memory.git` 两侧逐字节相同 |
| 工作流文件名 | ✅ `.github/workflows/publish.yml`（npm 侧只填文件名） |
| `environment` | ✅ 文件里没有该键（npm 侧要求留空） |
| `id-token: write` | ✅ 存在 |
| tag 触发 | ✅ `on: push: tags: v*` |
| 发布前门禁 | ✅ 先跑 `npm test` 再校验 `package.json` 版本 == tag |

GitHub API 当时持续 **504 网关超时**，仓库/运行列表查不到；npm registry 正常，所以改用 npm 侧作决定性观测。

### 9.2 决定性实验

1. `package.json` 1.0.12 → **1.0.13**；`npm test` **190/0**；`check-metadata.mjs` 通过；`npm pack --dry-run` 7 个文件；
2. 确认 registry 上 **1.0.13 不存在**（未占用）；
3. 提交 `6d0a1c8` → 推送 `origin/main`；
4. 推 tag **`v1.0.13`** → 触发 `Publish` 工作流；
5. 轮询 npm registry（约 1 分 15 秒）→ **1.0.13 出现**。

### 9.3 结果：通过，且首次带 provenance

```
latest      : 1.0.13
integrity   : sha512-etuN3us5++rlUKyg9V/IGVKVYGRg04Q7m55NONNIcMvbVaEDdNhHZPEUrQR+RB57ZvNpVH+gWPs971cjROX1EQ==
gitHead     : 6d0a1c856d9d31644f6de50372d879b5c97f9110     ← 正是本次提交
attestations: 有 ✔
  - https://github.com/npm/attestation/tree/main/specs/publish/v0.1
  - https://slsa.dev/provenance/v1
attestation url: https://registry.npmjs.org/-/npm/v1/attestations/dsh-instruction-memory@1.0.13
```

**两条 attestation 就是 OIDC 信任发布才会产生的东西**——对比 1.0.10 / 1.0.11 / 1.0.12 的
`dist.attestations` 均为空（本地 token 发布）。发布物全新缓存安装后，`lib/index.js`、`lib/client.js`、
`README.md`、`package.json`、`cordis.patch.yml` **与本地逐字节一致**。

### 9.4 1.0.13 的内容

不是空版本：它修掉了一个**真实缺陷** —— README 的「发布（维护者）」章节还在教人本地 `npm publish`，
与仓库实际的 `publish.yml`（tag → OIDC CI）**相互矛盾**。现在该章节：

- 写明正规流程是推 tag、由 CI 发布，并给出完整命令序列；
- 列出 npm 侧需要填的**五个字段**（含"2026-09-03 之后创建的默认只允许 `npm stage publish`，直发必须显式勾选"）；
- 明确警告 **npm 保存时不校验这些字段**，填错只在第一次发布尝试时以 `ENEEDAUTH` 之类暴露；
- 记录 **1.0.10/1.0.11/1.0.12 为何是本地发布**（配置当时未就绪、`Publish` 唯一失败步骤就是 `npm publish`），
  因此这三版**无 provenance 也无 tag**，并说明**不要补推这三个 tag**（版本已占用，只会再红一次）；
- 保留本地兜底发布说明（OIDC 不可用时），并注明产物不含 provenance。

### 9.5 tag 现状（如实记录）

```
v1.0.11   Publish #1 → failure（配置当时不存在；唯一失败步骤是 npm publish）
v1.0.13   Publish #2 → success（带 provenance）
```

`v1.0.11` 的失败运行是**历史事实**，我保留它、没有删 tag 或改历史；README 里已说明这三个版本的处境。
1.0.10 与 1.0.12 按决定**不打 tag**。

### 9.6 仍需你注意

- 以后每个版本按 README 的新流程走：**升版本 → 提交 → 推 main → 打 tag 推送**，npm 侧会自动带 provenance。
- GitHub API 目前对本机**间歇性 504**，我无法从 Actions API 读到运行结论；本次的结论**由 npm registry 侧独立确证**（版本出现 + 两条 attestation + `gitHead` 对应提交），不依赖 GitHub API。

---

## 10. DSH 0.2.0-rc.1 适配核验（任务：「检查插件在新版DSH的适配性」）

### 10.0 触发本次核验的客观变化

| 事实 | 值 |
| --- | --- |
| npm 新增版本 | **`0.2.0-rc.1`**，发布时间 `2026-09-28T12:34:03.181Z`，dist-tag **`next`** |
| `latest` 变动 | 由 `0.1.5-rc.3` → **`0.1.7-rc.2`** |
| 本机安装 | 由 **`0.1.7-rc.2`**（依据 09-25 两次启动日志里的 `dshVersion: '0.1.7-rc.2'`）→ **`0.2.0-rc.1`**。npm 把旧安装改名为 `@deepseek-ai/dsh.replaced-1790327293098`（**保留了完整 282 个子包 → 可做字节级 A/B 对照**）；注意该残留目录的 `package.json` 自标 `0.1.7-rc.1`，与运行日志不一致，所以**关键比对不用它做主证据**，改用 npm 上真实发布的 tarball（见 §10.3） |
| 运行中的宿主 | PID 3364，`@deepseek-ai/dsh\lib\bin.js web --no-open --host 127.0.0.1 --port 8080`，启动 `2026-09-29 13:03:11` |
| 插件装载方式 | profile 内为 **junction**（`C:\Users\34332\.dsh\profiles\web\node_modules\dsh-instruction-memory` → 工作区），所以宿主加载的就是工作区源码 **1.0.13** |

> 说明：§1–§9 的核验对象是 1.0.11 × 最近 10 个 DSH（当时最新为 `0.1.7-rc.2`）。本节是针对 **0.2.0-rc.1** 的增量核验，并修正 §8/README 中已过期的计数。

### 10.1 结论

**已适配，且不只是"符号还在"——已在 0.2.0-rc.1 上真实运行并取得活体证据。**
但本轮同时查出我方**文档/声明的 4 处准确性问题**，其中 1 处是真实的**执行层缺口**（见 §10.6）。

### 10.2 先把耦合面收敛到全量（这一步决定后面要核验什么）

`lib/index.js` 与 `lib/client.js` **只 import Node 内建模块**（`node:fs/promises`、`node:os`、`node:path`、`react`），**不 import 任何 `@deepseek-ai/*`**。因此耦合面总共只有 6 处：

| # | 耦合点 | 来源包 | 形式 |
| --- | --- | --- | --- |
| 1 | `inject = ['systemPrompt']` + `systemPrompt.section({name, order, text})` | `dsh-system-prompt` | 服务名 + 方法签名 |
| 2 | 每轮 `assemble()` 求值**函数型** `text` | `dsh-agent-loop` | 调用点 |
| 3 | `ctx.inject` / `ctx.effect` / `ctx.get` / `ctx.logger` | `cordis` | 框架 API |
| 4 | `ctx.inject(['webServer'])` → `webServer.register({kind:'prefix',path,handler})`、`webServer.host` | `dsh-host-webserver` | 服务契约 |
| 5 | `dsh.client.{platform,inject}` 声明与校验 | `dsh-client-modules` | 清单字段 |
| 6 | 客户端 `slots.inject('settings.section', …)` | `dsh-client-ui-slots` / `-renderer` / `-settings` | 客户端槽位 |

### 10.3 逐点字节级核验：**已发布的 `0.1.7-rc.2`** → 本地 `0.2.0-rc.1`

方法：对每个包的 `lib/` 下**全部文件**逐个算 SHA256 再比对（不是只看文件大小）。

**基准的选择很重要，这里改过一次。** 我最初拿本地 `dsh.replaced-*` 残留目录做基准（它自标 `0.1.7-rc.1`），但运行日志显示升级前真正在跑的是 **`0.1.7-rc.2`**。两者标签不一致，于是我把基准换成 **npm 上真实发布的 `0.1.7-rc.2` tarball** 重算——结果**改掉了我先前两处结论**（见下）。

| 包 | 结果（published rc.2 → local 0.2.0-rc.1） |
| --- | --- |
| `dsh-system-prompt`（耦合点 1，**唯一硬依赖**） | **IDENTICAL · 4/4** |
| `dsh-client-ui-slots`（耦合点 6） | **IDENTICAL · 4/4** |
| `dsh-client-ui-renderer`（耦合点 6） | **IDENTICAL · 12/12** |
| `dsh-client-ui-settings`（耦合点 6） | **IDENTICAL · 11/11** ← 改：先前用 rc.1 基准说它"1 个 `.d.ts` 变了"，**对 rc.2 根本不成立** |
| `dsh-host-webserver`（耦合点 4） | **IDENTICAL · 3/3** |
| `dsh-client-modules`（耦合点 5） | **IDENTICAL · 10/10** |
| `dsh-plugin-manager` | **IDENTICAL · 29/29** ← 改：先前用 rc.1 基准说它"4 个文件变了"，**对 rc.2 不成立** |
| `dsh-agent-loop`（耦合点 2） | **changed**：`lib/index.js`、`types/tool-calls.d.ts` |
| `dsh-app-boot`（门禁所在，见 §10.6 P1） | **changed**：`lib/index.js` |
| `dsh-client-ui-primitives` | changed 13/123 —— 本插件**不引用它**（`lib/client.js` 只 `require('react')`） |
| `dsh-agent-preset-registry` | changed 1/24（`typert.host.js`）—— 本插件不使用 |
| `cordis` | 两处均为 **4.0.4**；本地两份安装的 `lib/` 19/19 全等（`@deepseek-ai/cordis` 在 npm 上取不到该版本 tarball，故以版本号 + 双树哈希为据） |

**也就是说：相对升级前真正在跑的版本，本插件 6 个耦合点里有 6 个的包是逐字节不变的，只有 2 个包变了一行代码所在的文件，而那两处的相关区域我都逐行核过（注入通路逐行等同；门禁函数逐字节等同，行号都是 289/294/300）。**

**方法可信度：阴性对照不可省。**

| 来源 | `dsh-system-prompt/lib/index.js` SHA256 |
| --- | --- |
| npm `0.1.7-rc.1` | `FF422AFA…0D2F57` |
| npm **`0.1.7-rc.2`**（升级前真正在跑的） | `FF422AFA…0D2F57` |
| 本地 `0.2.0-rc.1` | `FF422AFA…0D2F57` |
| npm `0.1.6-alpha.2`（**阴性对照**） | `12A6307A…AEF5C2` ← **不同**，证明该方法确实能检出变化 |

没有最后一行，"全等"也可能只是比对写错了。

**`dsh-agent-loop` 唯一真正的运行时变更文件 `lib/index.js`，其注入通路逐行等同：**

```
L902  async preStep(target, position) {
L904    if (this.phase.kind !== "running") throw new Error(`agent "${this.id}": pre-step outside running phase`);
L907    const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal));
```
（两版本行号、文本完全一致；`ctx.systemPrompt.variable("provider"|"model"|"cwd", …)` 亦一致，新版本位于 L1564–1566、旧版本 L1523–1525。文件增大的 +1844 B 落在**与本插件无关**的区域。）

**`SECTION_ORDERS` 也未动**（因 `dsh-system-prompt` 字节一致）：`FILE_REFERENCE: 900` → **本插件 950** → `TOOL_BASH: 1e3`，950 仍在空档，无碰撞。已回查本机 profile 内其他插件：**无任何第三方插件注册 system prompt 段落**，故也不存在跨插件 order 竞争。

### 10.4 最强一层：在 0.2.0-rc.1 上真实运行（活体证据）

```
POST http://127.0.0.1:8080/instruction-memory/api   {"method":"state"}
→ HTTP 200  ok=true  saved=true
injection: { registered: true, available: true, error: null, chars: 437, pulls: 38 }
storage:   { path: C:\Users\34332\.dsh\instruction-memory\memory.json, onDisk: true, error: null }
```

四条独立含义：

1. **HTTP 200** → 耦合点 4（`webServer.register` 前缀路由）在 0.2.0-rc.1 上真的注册成功并可应答。
2. **`registered: true`** → `systemPrompt.section()` 注册成功（耦合点 1）。
3. **`pulls: 38`** → 0.2.0-rc.1 的 agent loop **真的求值了 38 次**函数型 `text`（耦合点 2）。这是"注入真的生效"的直接证据，不是静态推断。
4. **`chars: 437`** 与本次会话 system prompt 中实际出现的「用户长期指令记忆（Instruction Memory）」段落一致 → 端到端贯通。

**旁证（很有价值）**：同一台机器上 13:03:33 的一次启动因 `EADDRINUSE 8080` 失败，其诊断里的 "Plugins waiting for services (12)" 列表包含 `better-sidebar`、`sidecard-ask`、`version-update` 等插件**阻塞在 `webServer`**，而 **`instruction-memory` 不在列表中**——说明 1.0.9 起把 webServer 改为非阻塞 `ctx.inject` 的设计，在 0.2.0-rc.1 上依然成立（不会因 webServer 缺失而丢掉注入）。

### 10.5 声明是否接住了新版本：实测

用 **DSH 自带的 semver 7.8.5**（`@deepseek-ai/dsh/node_modules/semver`）实测：

| 候选版本 | 默认语义 | `includePrerelease: true` |
| --- | --- | --- |
| `0.2.0-rc.1` | **true** | **true** |
| `0.2.0`（未来正式版） | true | true |
| `0.1.7-rc.2` | true | true |
| `0.1.8-rc.1` | false | **true** ← 见 §10.6 P3 |

对 npm 上**全部 28 个已发布版本**穷举：**13 个被接住 / 15 个被拒**，且**两种模式在已发布版本上零分歧**。

`npm test` 全绿：`host-range-test.mjs` 内含实时断言
`PASS  LIVE GUARD: the installed host 0.2.0-rc.1 is admitted by both modes`
（该断言直接读本机实际安装的宿主版本，所以升级到 0.2.0-rc.1 后**自动**覆盖到新版本，无需我手工加进矩阵。）四个套件（host-range / smoke / contract / verify）全部 ALL PASS、退出码 0。

### 10.6 本轮查出的问题（按严重度，全部如实标注）

#### P1（真实缺口）声明的范围**没有被宿主强制执行**——因为本插件没声明 `peerDependencies`

宿主的兼容门禁是 `evaluatePluginCompatibility`（`dsh-app-boot/lib/index.js:286–313`）。该文件在 0.2.0-rc.1 里确实变过，但这个函数**没变**——已用 **npm 上发布的 `0.1.7-rc.2`** 与本地 `0.2.0-rc.1` 逐行比对，关键行号都是 289 / 294 / 300：

```js
L288  const fields = objectOf$1(manifest, "Plugin manifest");
L289  if (!Object.hasOwn(fields, "peerDependencies")) return void 0;   // ← 无 peerDependencies 直接放行
L294  if (name !== "@deepseek-ai/dsh" && !name.startsWith("@deepseek-ai/dsh-")) continue;
L300  if (requirement.trim() === "" || !semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })) peers[name] = range;
```

- 它**只读 `peerDependencies`**，读的是 `manifest` 顶层字段。
- 官方 `@deepseek-ai/dsh` README 第 39 行印证：「安装和 profile 启动会按声明的 DSH **peer** 范围，检查与 `dsh --version` 显示值相同的运行时版本。」
- 在 0.2.0-rc.1 整棵树里对 `engines.dsh` / `compatibility.dsh` 做全量检索：**0 命中**；全树 `.engines` 访问：**0 命中**。
- 本机 profile 里除本插件外的 **283 个**第三方插件（`package.json` 可解析）中：**10 个**用 `@deepseek-ai/dsh*` 的 `peerDependencies` 作为门禁；**1 个**声明 `dsh.engines.dsh`（`dsh-vibe-math@2.3.16`）；**3 个**声明 `dsh.compatibility`（`dsh-office-tools`、`dsh-vibe-math`、`oss-prompt-optimizer`）；其余 **271 个**三者皆无。

> ⚠️ 更正一处我自己先前的草稿：最初我只扫了直接依赖目录，得出"`dsh.engines.dsh` 0 命中"，**那是错的**。全量扫 283 个后确有 1 个插件声明它。这条已按实测改正。

**这里要分清两套**不同机制，否则结论会写错：

| 机制 | 读什么 | 作用 | 本插件 |
| --- | --- | --- | --- |
| **宿主运行时门禁**（安装 / profile 启动） | **只读 `peerDependencies`**（`dsh-app-boot/lib/index.js:289`；官方 README L39） | **拒绝**或要求显式豁免 | ❌ **未声明 → 不生效** |
| **市场卡片判定**（`dshmarket` 等服务端） | `engines.dsh`（顶层优先）或 `dsh.engines.dsh`，与 `peerDependencies`（若有）求交，再用 `includePrerelease:true` 比宿主版本 | 只影响**展示/担保**，不执行 | ✅ 已声明 |

**后果（必须说清）**：本插件**没有 `peerDependencies`** → `evaluatePluginCompatibility` 在 L289 直接 `return undefined` → **在声明范围之外的宿主（如 `0.1.2-rc.1`、或未来的 `0.3.x`）上安装/启动本插件不会被拦、也不会有警告。** 市场卡片那套是**展示**，不是**门禁**。所以 §8 里"声明范围"目前只对市场生效，**对宿主没有强制力**。

**修复方向（未执行，需你授权）**：加
```json
"peerDependencies": { "@deepseek-ai/dsh-system-prompt": "<同一串范围>" }
```
按 L300，peer 的**值会被拿去和宿主版本比较**（同族包与宿主锁步发布，版本号同串），于是范围才真正生效。注意这会让**范围外的宿主在安装/启动时被拒或要求显式豁免**——这是行为变更，不是纯文档改动。

#### P2（文档过期，客观可核）README 的计数已不成立

| 位置 | 现文 | 实际 |
| --- | --- | --- |
| README L188 | 「全部 **27 个**已发布宿主版本」「范围内 **12 个**版本」 | **28 个**已发布；范围内 **13 个** |
| README L181 | ② 档覆盖「全部 12 个…（`0.1.3-alpha.2` → **`0.1.7-rc.2`**）」 | 需延伸至 **`0.2.0-rc.1`** |

（§8.3 当时的数字在 0.2.0-rc.1 发布前是对的；新增一个版本后自动过期。）

#### P3（表述不准确）「无法被任何范围覆盖」是**模式相关**的，而宿主门禁用的正是另一个模式

README L202 用加粗断言「**未声明的未来 minor 的预发布版本，无法被任何范围覆盖**」，L203 又限定「在 npm 语义下」。实测：同一串范围对 `0.1.8-rc.1` 在**默认语义下 false、在 `includePrerelease: true` 下 true**；而 P1 的 L300 表明**宿主门禁就是传 `includePrerelease: true`**。

- 对 **npm/pnpm 解析 `peerDependencies`**：该上限成立。
- 对 **DSH 运行时门禁**：该上限**不成立**——未声明的未来 minor 预发布版本其实**会被接住**。

`host-range-test.mjs` L322 的断言也只取了默认模式（`semver.satisfies(hypothetical, declared) === false`），但用例名写成"unreachable from the current range (the documented limit)"，读起来是普适结论。**建议改成按模式分别陈述**，否则这句话对宿主门禁是错的。

#### P4（表述需降级：非官方来源，但有独立实证佐证）README 关于"市场读哪个字段"的说法

README L240–241 断言市场「只读 `engines.dsh` / `dsh.engines.dsh` 以及 `@deepseek-ai/dsh*` 的 `peerDependencies`，并不读 `dsh.compatibility.dsh`」。

**先说结论：这条我最初判成"与生态证据相反"，是我读错了语义，现在更正为"说法成立，但缺来源标注"。**

- 我最初的误判来自：`dsh-deja`、`dsh-wsl-workspace` 等插件都在更新 `dsh.compatibility.dshReleases`，我就以为市场读的是它。**这个推断是错的。**
- 决定性反证来自本机安装的 **`dsh-vibe-math@2.3.16` 的 `dsh.compatNote`**（一份把结论与实验写进清单的第三方实证记录），逐字写着：
  > 「市场从**已发布的 npm manifest** 读 `engines.dsh`（顶层优先）或 `dsh.engines.dsh`，与 `@deepseek-ai/dsh*` 的 peerDependencies（若有）一起按"各自都必须满足"求交，再用 semver + `includePrerelease:true` 与宿主版本比较、在卡片上显示兼容性」
  > 「本包此前只有**自用的** `dsh.minVersion`/`testedVersion`（市场不读），因此卡片一直显示"未声明"」
  > （v2.3.12）「安装器自检改为读 `engines.dsh`（顶层优先）/ `dsh.engines.dsh` —— 与市场卡片**同一个**声明，不再与**自用的** `dsh.compatibility.dshReleases` 表各说各话」
- 即：`dsh.compatibility.dshReleases` 是**插件自己给人看的表**，市场读的是 `engines.dsh`。这与 README 的说法**一致**。

**仍需修正的地方**：README 把它写成了确定事实，但它的来源是**第三方反向得出的**（`dshmarket`/`alldsh` 均为第三方站点，本机 `dshmarket` 目录无法枚举、树内没有可核验的市场读取代码），**官方文档里没有这一条**。建议按证据分级改写为"市场侧行为、第三方实证、非官方文档"，而不是像现在这样与官方事实并列陈述。

**顺带一个值得记下的对照**：`dsh-vibe-math` 的 `dsh.engines.dsh` 明确以 `<0.2.0-0` 收尾、**主动拒绝** `0.2.0-rc.1`；而本插件的范围**接纳** `0.2.0-rc.1`。本插件的"接纳"不是靠推断——§10.4 已在 0.2.0-rc.1 上取得活体证据。

### 10.7 明确**没有**验证的部分（不得当作已验证）

- **客户端设置页的视觉/交互**：我通过 `dsh-client-modules` 逐字节一致 + 客户端槽位包字节一致（`-slots`/`-renderer`）来证明**契约未变**，且宿主合成成功（GUI 正常服务）。但 `http://127.0.0.1:8080/` 返回 **401**（需鉴权），我**没有**实际打开设置页做人工确认。
- **`includePrerelease` 门禁的端到端触发**：我读的是宿主的门禁源码，**没有**构造一次"范围外宿主 + 安装被拒"的真实验证（那需要换装另一个 DSH 版本，成本约 465 MB / 单次 npm 解析 468 s）。
- ①②档历史的 5 个"真实启动"版本（`0.1.3-alpha.2` 等）依旧**未复核**。

### 10.8 复现

```powershell
# 1. 版本台账与 dist-tags（官方 registry）
Invoke-RestMethod 'https://registry.npmjs.org/@deepseek-ai%2Fdsh' -Headers @{'Cache-Control'='no-cache'} |
  ForEach-Object { $_.'dist-tags' }

# 2. 耦合点字节级 A/B —— 基准用 npm 上真实发布的 0.1.7-rc.2（不要用本地 dsh.replaced-*，它自标 rc.1）
$tmp="$env:TEMP\imcmp"; New-Item -ItemType Directory $tmp -Force | Out-Null
$local="C:\Users\34332\AppData\Roaming\TRAE SOLO CN\ModularData\ai-agent\vm\tools\node\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai"
foreach ($p in @('dsh-system-prompt','dsh-agent-loop','dsh-client-ui-slots','dsh-client-ui-renderer',
                 'dsh-client-ui-settings','dsh-host-webserver','dsh-client-modules','dsh-app-boot')) {
  Invoke-WebRequest "https://registry.npmjs.org/@deepseek-ai/$p/-/$p-0.1.7-rc.2.tgz" -OutFile "$tmp\$p.tgz" -UseBasicParsing
  New-Item -ItemType Directory "$tmp\$p" -Force | Out-Null; tar -xzf "$tmp\$p.tgz" -C "$tmp\$p"
  $pub="$tmp\$p\package\lib"; $loc="$local\$p\lib"
  $same=0;$diff=@()
  Get-ChildItem $pub -Recurse -File | ForEach-Object {
    $r=$_.FullName.Replace($pub,'')
    if ((Get-FileHash $_.FullName -Algorithm SHA256).Hash -eq (Get-FileHash "$loc$r" -Algorithm SHA256).Hash) { $same++ } else { $diff+=$r }
  }
  "{0,-28} identical={1} changed={2}" -f $p,$same,($diff -join ',')
}
# 阴性对照：0.1.6-alpha.2 必须报"不同"，否则说明比对本身写错了

# 3. 活体证据（需宿主在跑；Host 头必须是回环）
Invoke-WebRequest 'http://127.0.0.1:8080/instruction-memory/api' -Method POST `
  -Body '{"method":"state"}' -ContentType 'application/json' -Headers @{Host='127.0.0.1:8080'} -UseBasicParsing

# 4. 契约测试（含读本机实际宿主版本的实时断言）
npm test
```

**一句话交付**：0.2.0-rc.1 上适配**成立且已实测**；`npm test` 全绿、实时守卫已自动覆盖到 `0.2.0-rc.1`。但"声明范围"目前**不是**技术门禁（P1，需加 `peerDependencies` 才生效），且 README 的 4 处表述需要按本节修正（P1–P4）。**以上修改我都还没有执行，等你确认。**

---

## 11. 1.0.14 发布记录（用户选择 A：加门禁 + 修文档，一起发）

提交 `51ca4d9`，tag **`v1.0.14`**，2026-09-29。

### 11.1 改了什么

| 文件 | 改动 |
| --- | --- |
| `package.json` | 新增 `peerDependencies["@deepseek-ai/dsh-system-prompt"]` = 同一串范围；version → 1.0.14 |
| `host-range-test.mjs` | 新增 4 条断言：peer 存在、peer 只声明这一个包名、三处声明逐字节相同、三处都等于 `COVERED_LINES` 生成值 |
| `README.md` | §兼容性 重写为"三处声明、只有一处被执行"；计数 27/12 → **28/13**；①档加入 `0.2.0-rc.1`（并显式标注未直接观测的那一项）；P3 改为模式相关陈述；P4 标注来源等级；§安装 增加范围外会被拒的说明 |

**为什么 peer 的载体是 `@deepseek-ai/dsh-system-prompt`**：门禁把 peer 的**范围值**与宿主版本比较，**包名不参与解析**（只用于点名报错），所以包名只需指向"本插件唯一硬依赖的那个服务"。选它而不是 `@deepseek-ai/dsh`（运行时元包）是因为包管理器会**自动安装 peer**：实测 `npm install <本包>` 会拉进 `dsh-system-prompt` 及其 peer 链共 **15 个包**（体积小）；若声明 `@deepseek-ai/dsh` 则会把整个 **~465 MB** 的运行时拖进用户的 profile。这也是同类插件（本机 10 个）的通行做法。

### 11.2 用**宿主的真函数**验证（不是我的复现）

直接从本机安装的 `dsh-app-boot` 导入 `evaluatePluginCompatibility` 并喂真实 manifest：

```
host getDshRuntimeVersion() = 0.2.0-rc.1
真 manifest，默认 runtimeVersion      -> undefined（放行）
  0.2.0-rc.1 / 0.1.7-rc.2 / 0.1.5-rc.2 -> PASS
  0.1.2-rc.1（低于下限）                -> BLOCKED
  0.3.0 / 1.0.0                         -> PASS（无界尾部，见 11.5）
对照：把 peerDependencies 删掉后
  任意版本（含 0.1.2-rc.1、1.0.0）      -> undefined（门禁跳过）← 正是 1.0.14 之前的洞
```

### 11.3 新断言本身也做了阴性对照（否则可能是恒真）

在临时目录里对 `package.json` 做四种变异后跑 `host-range-test.mjs`：

| 变异 | 结果 |
| --- | --- |
| A 未改动 | exit 0，ALL PASS |
| B 删掉 `peerDependencies` | **4 条 FAIL**，exit 1 |
| C peer 范围末尾多一个空格 | **2 条 FAIL**，exit 1 |
| D 再加一个 peer | **1 条 FAIL**，exit 1 |

### 11.4 发布结果（npm registry 侧）

| 项 | 值 |
| --- | --- |
| `dist-tags.latest` | **1.0.14** |
| `dist.integrity` | `sha512-XWsDcrTOuBvdcit3vAfU2t29JJMqFz43WNU2JAs64lefkfmOWf9zmlKHNRD3bsQX3Lg1hXbb49RxD0Mkb4BAoQ==` |
| `versions["1.0.14"].gitHead` | `51ca4d9600203efe826ed2b516959423c9080827` —— 与 tag / HEAD **完全一致** |
| attestations | **2 条**：`npm/attestation/…/publish/v0.1` + `slsa.dev/provenance/v1` |
| CI | Publish **#3 = success**（tag v1.0.14）、CI **#9 = success**（main） |
| 发布物 | 7 个文件；`lib/index.js`、`lib/client.js`、`README.md`、`package.json`、`cordis.patch.yml` 与工作区**逐字节一致** |

> ⚠️ **更正我自己的一个读法错误**：我一度以为 `gitHead` 消失了。实际是我读错了字段——它**不在 `dist.gitHead`**，而在 **`versions["<v>"].gitHead`**。按正确字段查，1.0.10 → 1.0.14 每个版本都有，1.0.14 与 tag 一致。

**发布前的 CI 预演**：在**完整树的干净副本**上跑工作流的确切序列（`npm install --no-save --no-package-lock semver@7.8.5` → `npm test` → 版本/tag 断言），全绿。这一步不能省——npm 版本号不可重用，一次红的 CI 会**永久**吃掉一个版本号。

### 11.5 一个需要你知道的后果（不是 bug，是既有设计被"激活"了）

范围的尾部是**无界的** `>=0.2.0-0`。在 1.0.14 之前它没有强制力，所以无所谓；**现在它会真的放行 `0.3.0` / `1.0.0` 等所有未来大版本**（已用宿主真函数实测为 PASS）。这与 README 里"正式版不受影响"的既有声明一致，是**有意的**设计选择。

但请注意它与另一种做法的差别：`dsh-vibe-math` 用的是带上限的 `… <0.2.0-0`，**主动拒绝**未验证的 `0.2.0-rc.1`。若你希望"只有验证过的版本才能装"，就得**给尾部加封顶**（例如 `<0.3.0-0`），代价是每个新的正式 minor 都要发一版插件。这是一个取舍，我没有替你决定——需要的话说一声。

### 11.6 仍未验证的部分（与 §10.7 相同，未因发布而改变）

客户端设置页的人工视觉确认、范围外宿主的端到端"安装被拒"实测、①②档历史版本的复核，**都仍然没做**。

---

## 12. 桌面版（DeepSeek Harness 桌面应用）适配核验（任务：「检查我的插件在桌面版的适配性」）

### 12.1 结论先说

**桌面版跑的是另一套 DSH 发行版，而且你的插件根本没装在它的 profile 里——所以此刻不存在"它在桌面版上适不适配"这回事。**
至于"装上去能不能用"：**契约层面判定为可用**（证据见 12.4）；但**活体行为（注入 / 路由 200 / 设置页）我没有实测**，因为那需要改动你的桌面 profile。

### 12.2 桌面版是什么

| 项 | 值 |
| --- | --- |
| 应用 | `D:\Users\34332\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe`（Electron） |
| DSH 位置 | 打包在 `resources\app.asar`（**115.7 MB 归档**，不是目录；普通路径读不进去——我为此写了 `scripts/desktop-asar.mjs` 直接解析归档头与 JSON 目录树） |
| **DSH 发行版** | **`@deepseek-ai/dsh-desktop-runtime@0.2.0-rc.2`** —— **不是** `@deepseek-ai/dsh` |
| 内置包 | **289** 个 `@deepseek-ai/*`，全部 `0.2.0-rc.2`；`@deepseek-ai/cordis` **4.0.4** |
| 该包在 npm 上 | **404（未公开）**——桌面版是私有发行版 |
| 启动入口 | `dsh-desktop-host/lib/index.js`（PID 41836），带 `--expose-internals` 与 profile 路径参数 |
| **profile** | **`C:\Users\34332\.dsh\profiles\desktop`** —— 是 `desktop`，**不是** `web` |
| DSH_HOME | **仍是 `C:\Users\34332\.dsh`**（与网页版同一个 home，`memory.json` 路径不变） |
| GUI | `http://127.0.0.1:19387` |

### 12.3 插件**不在**桌面 profile 里（四条静态证据 + 一条活体反证）

1. `profiles\desktop\package.json` 的 `dependencies` **没有** `dsh-instruction-memory`；
2. 其 `dsh.profile.bundles` 列表里**也没有**；
3. `profiles\desktop\node_modules`（226 个目录）里**没有**该目录；
4. `cordis.yml` 是空表 `[]`，`cordis.patch.yml` 只有 ui-chat / ui-settings / better-sidebar / mnemon 等条目，**没有** instruction-memory。

**活体反证**：`GET http://127.0.0.1:19387/instruction-memory/api` → **404**，与随机路径 `GET /definitely-not-a-route-xyz` → 404 **完全一致**（两者 POST 都返回 405，是该服务器的通用回应）。即该路由**没有注册**。
（对照：同一插件在网页版 profile 的 8080 路由上返回 `200`，`pulls` 持续增长。）

**旁证**：本次会话系统提示里**有** MNEMON 段落（`dsh-mnemon` 已加载），却**没有**「用户长期指令记忆」段落——与插件未加载一致。

### 12.4 若装上去能不能用：契约层面判定**可用**

用 `scripts/desktop-vs-npm.mjs` 把归档里的包与 npm 上**真实发布的 `0.2.0-rc.2`** 逐文件 SHA256 比对（`.d.ts` 被归档剥离、依赖被内联、构建脚本字段被删，均已单列，不计为行为差异）：

| 耦合点来源包 | 桌面归档 vs npm `0.2.0-rc.2` |
| --- | --- |
| `dsh-system-prompt`（唯一硬依赖） | **runtime JS 完全一致**；package.json 语义等价 |
| `dsh-agent-loop`（注入调用点） | **一致** |
| `dsh-client-ui-slots` / `-renderer` / `-settings` | **一致** |
| `dsh-host-webserver`（设置页路由） | **一致**（归档另内联了 `negotiator`，那是它的声明依赖） |
| `dsh-client-modules`（客户端模块下发） | **一致** |
| `dsh-app-boot`（兼容门禁所在） | **一致** |

**门禁**：桌面版 `getDshRuntimeVersion()` 读的是 `dsh-app-boot` 自己的 `package.json` 版本 → **`0.2.0-rc.2`**；`evaluatePluginCompatibility` 源码与我先前实测过的版本**逐字相同**。用该函数喂本插件真实 manifest：

```
runtimeVersion 0.2.0-rc.2  -> ADMITTED（门禁通过）
runtimeVersion 0.1.7-rc.2  -> ADMITTED
runtimeVersion 0.1.2-rc.1  -> BLOCKED（下限仍然咬）
0.2.0-rc.2 在 default 与 includePrerelease 两种模式下均为 true
```

**其余条件**：`webServer` 存在（19387 上是真实 HTTP 路由）；profile 机制与网页版同源（`dsh-desktop-host` 正是用 `dsh-app-boot` 的 `loadProfileDirectory` + `dsh-profile-boot` 的 `runProfile`）；`dsh-client-modules` 一致意味着 `/plugins` 下发方式相同，且该 desktop profile 里已有 10+ 个带客户端半的插件在跑。

### 12.5 明确**没有**验证的部分

- **桌面版上的活体注入 / 路由 200 / 设置页渲染**——**未实测**，因为插件没装（装上才能测）。
- 我**无法**用别的插件给 `systemPrompt.section` 做阳性对照：这个 profile 里**没有任何第三方插件**使用该 API（`dsh-mnemon` 用的是它自己的 `mnemonMemory` 服务，注入通道不同）。所以桌面版的注入通路目前**只有代码同一性这一层证据，没有活体观测**。

### 12.6 三个运维事实（决定怎么装）

- `profiles\desktop\pnpm-workspace.yaml` 设了 **`autoInstallPeers: false`** → 1.0.14 新增的 `peerDependencies` **不会**在桌面 profile 里拖入额外包（我在裸 `npm install` 下实测到的 15 包链在这里不适用）。
- 桌面 profile 的 `.npmrc` 指向 **`registry.npmmirror.com`**；实测该镜像**已有 1.0.14 且带 attestation**（与 npmjs 一致）。另外 `.dsh-market\state.json` 的 `favorites` 正是本仓库，`.dsh-market\discovery-compatibility-v1.json` 缓存里已有 `dsh-instruction-memory@1.0.14`，且**同时记录了 `enginesDsh` 与 `peerDependencies`** —— 这独立佐证了 §10.6 P4 关于"市场读哪些字段"的结论。
- **PATH 上没有 `dsh` CLI**（桌面版 `resources\runtime\bin` 只有 `node`/`node.cmd`），所以不能照 README 的 `dsh plugin --profile desktop add …` 直接来。可行路径：桌面 UI 的插件管理器，或按网页版既有做法**手工建 junction + 加入 `dsh.profile.bundles`**（网页版里本插件就是这么装的：`profiles\web\node_modules\dsh-instruction-memory` → junction → 工作区）。

### 12.7 复现

```powershell
# 1. 归档内省（app.asar 不是目录，普通路径读不到）
node dsh-memory-verification\scripts\desktop-asar.mjs versions
node dsh-memory-verification\scripts\desktop-asar.mjs cat '/dsh/package.json'

# 2. 归档 vs npm 已发布包（先把 tarball 解到 <dir>/<pkg>/package）
node dsh-memory-verification\scripts\desktop-vs-npm.mjs 0.2.0-rc.2 <dir> `
  dsh-system-prompt dsh-agent-loop dsh-client-modules dsh-host-webserver dsh-app-boot

# 3. 活体：路由有没有注册（404=没装；200=已装）
Invoke-WebRequest 'http://127.0.0.1:19387/instruction-memory/api' -Method GET `
  -Headers @{Host='127.0.0.1:19387'} -UseBasicParsing
```

### 12.8 已安装到桌面 profile 并完成活体实测（用户选择 A，2026-09-30）

**改动（两处，均可回滚）**

| 动作 | 内容 |
| --- | --- |
| 建 junction | `C:\Users\34332\.dsh\profiles\desktop\node_modules\dsh-instruction-memory` → `D:\Users\34332\AI\dsh-instruction-memory`（与网页版同一做法） |
| 加入 bundles | `profiles\desktop\package.json` 的 `dsh.profile.bundles` 插入 `"dsh-instruction-memory"`（位置在 `dsh-vibe-math` 之后、`dsh-version-update` 之前，与网页版一致） |
| **未**做 | **没有**加进 `dependencies`——与网页版一致，避免 pnpm 去 registry 拉一份而绕过 junction |
| 备份 | `dsh-memory-verification\backup\desktop-profile\package.json`（改动前，SHA256 `C6C421CC12F2CDD845E9E52DCDD9D89B089E5AEDBADAF2355F51C62DD715465A`） |

**不需要重启桌面版**：`dsh-hmr` 在约 **5 秒**内自动重载了组合（轮询第 1 次即 HTTP 200）。

**活体结果（桌面版 `0.2.0-rc.2`，端口 19387）**

```
POST /instruction-memory/api {"method":"state"}
 -> HTTP 200  ok=true
    injection.registered = true
    injection.available  = true
    injection.chars      = 437
    injection.pulls      = 1        <- 宿主的 agent loop 真的求值了函数型 text
    storage.path         = C:\Users\34332\.dsh\instruction-memory\memory.json
    storage.onDisk       = true      entries=2  enabled=true
foreign Host (evil.example.com) -> HTTP 403   <- Host/Origin 防护在桌面版同样生效
```

**最强的一条**：同一轮的会话系统提示里**真的出现了**该插件注入的「用户长期指令记忆（Instruction Memory）」段落——即 `pulls` 增长与"提示里真的有这段"两件事同时成立，不是静态推断。

**数据是共享的**：桌面版与网页版同一个 `DSH_HOME`，所以读的是**同一个** `memory.json`（2 条条目、437 字符，与网页版完全一致）。装了插件就等于两套界面共用同一份指令记忆。

**回滚**

```powershell
Remove-Item 'C:\Users\34332\.dsh\profiles\desktop\node_modules\dsh-instruction-memory' -Force
Copy-Item 'D:\Users\34332\AI\dsh-instruction-memory\dsh-memory-verification\backup\desktop-profile\package.json' `
          'C:\Users\34332\.dsh\profiles\desktop\package.json' -Force
```

**仍未验证（本次也没做）**：设置页在桌面版 Electron 渲染器里的**实际显示**。原因：客户端模块的 URL 形如
`/plugins/<id>/client.js?rev=<shortHash>`，那个 `rev` 由内部 baseline 计算，我无法重建；而承载 `window.__DSH_BOOT__`
的首页返回 **401**（需鉴权）。所以"设置页模块被下发"这一项在桌面版仍是**契约级**证据
（`dsh-client-modules` 与三个 `-ui-` 包逐字节一致 + 组合成功未抛 `ClientPackageCompositionError` + 同 profile 里 10+ 个客户端插件在跑），
**没有**取到实际字节。**要确认请直接在桌面版打开「设置 → 指令记忆」看一眼。**

