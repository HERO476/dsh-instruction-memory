# dsh-instruction-memory 问题清单与修复报告

验证对象：`dsh-instruction-memory` **1.0.9 → 1.0.10**（DSH 宿主 0.1.7-rc.2 / Node v22.23.2 / profile `web`）
本报告承接 [REPORT.md](REPORT.md) 的记忆生效验证，针对其中发现的问题逐条修复。

**结论：7 个真实缺陷全部修复并回归通过；另有 4 项不属于本仓库可修范围，逐条说明与你需要决定的事项。**

| 回归项 | 修复前 | 修复后 |
| --- | --- | --- |
| 插件自带套件 `npm test` | 142 PASS / 0 FAIL | **159 PASS / 0 FAIL**（新增 17 条回归守卫） |
| 独立 A/B + 边界测试台 | 68 项 | **70 PASS / 0 FAIL** |
| 真实 cordis 集成挂载（新增） | 无 | **9 PASS / 0 FAIL** |
| 缺陷探针 `defect-probe` | **6/6 全部复现** | **0/6 复现** |
| 生产实例记忆注入 | 块 437 字符，偏移 5889 | **完全不变**（逐字节相同） |
| 生产 `memory.json` | `06013E41…` | **`06013E41…`（未被触碰）** |

> ⚠️ **修复尚未在运行中的 DSH 里生效。** 当前宿主进程（PID 35212，17:21:27 启动）内存中仍是旧代码；
> 需要**重启 DSH** 才会加载 1.0.10。我没有替你重启——那会打断你正在进行的会话。

---

## A. 已修复的缺陷

### D-1 · 写盘失败后内存态"超前"，未保存的指令仍被注入 · 中

**现象**：保存失败时面板正确报 `保存失败`、`memory.json` 也确实没变——但 `state.data` 已被改过，
系统提示词里仍带着那条**从未落盘**的指令，模型在整个进程生命周期内继续遵守它。

**证据（修复前）**：`logs/defect-probe.txt` → `"injectedAfterFailedSave": true` 而 `"diskHasNew": false`。
根因在 `lib/index.js` 原 `saveEntry`：先 `list.push(entry)` → `syncSection()` → **之后**才 `await writeToDisk()`。

**修复**：引入事务化提交 `commit(mutate)`——先 `cloneData()` 快照，执行变更并 `syncSection()`，
写盘成功后清警告；**写盘失败则把 `state.data` 与警告一起回滚并重新 `syncSection()`**。
`saveEntry` / `deleteEntry` / `setOptions` / `importData` 全部改走该路径。
（`saveEntry` 的 200 条上限判断也一并提到变更之前，否则 `return` 会被吞掉。）

**验证**：`logs/defect-probe-after-fix.txt` → 不再复现；`failsave-nuance.mjs` → `duringSameProcess.hasNew: false`（原为 `true`）；
`contract-test.mjs` 新增 4 条守卫（`a failed save is not injected` 等）全部通过。

### D-2 · 主文件缺失 + 备份完好 → 静默变成空存储 · 高

**现象**：`memory.json` 不在、而 `memory.json.bak` 里数据完好时，插件**不看备份**，直接当作"首次运行"
建一份**空存储**，用户记忆看起来凭空消失。

**证据（修复前）**：`"entriesAfterBoot": 0`，而同一目录 `.bak` 里有数据且可解析。

**根因有二，都在 `writeToDisk` 的备份方式上**：原实现是"先把 `memory.json` 改名成 `.bak`，
再把临时文件改名顶上"。这两步之间**主路径是不存在的**；只要第二步失败（文件被占用 / 磁盘满 / 杀软扫描），
主路径就一直空着，下次启动走 "first run" 分支写出空存储。**这是一个真正会丢全部记忆的窗口。**

**修复**：
1. 备份改为 **复制**（`copyFile`）而非改名 → 主文件在原子替换成功前始终待在原位；替换失败时
   `tmp` 被清理、原文件完好。
2. `readFromDisk` 新增 **1b 分支**：主文件 ENOENT 而 `.bak` 可读时，从备份恢复并**写回**主路径，
   同时明确提示"已从最近备份恢复"。
3. 备份刷新若因非 ENOENT 原因失败，记入新的 `state.backupError`，由 `snapshot().storage.warning`
   呈现（原来这条路径是被 `throw` 直接打断保存的）。

**验证**：`contract-test.mjs` 新增 `missing primary: recovers from the backup instead of an empty store`
等 5 条守卫；`defect-probe` 修复后 `"entriesAfterBoot": 1`、`"injected": true`，
警告文案为 `memory.json 不存在，已从最近备份 memory.json.bak 恢复，并已写回 memory.json`。

### D-3 · 满配记忆导出后无法导入（插件拒绝自己的导出） · 中

**现象**：`MAX_BODY_CHARS` 写死 `1_000_000`，而 200 条 × 6000 字符的内容本身就是 1,200,000 字符。
满配存储导出后回导，路由直接 **413**。

**证据（修复前）**：`"exportedChars": 1224332`，`"importRequestBodyChars": 1224376`，`"importHttpStatus": 413`。

**修复**：上限改为**由条目上限推导**，两者不可能再漂移：
`MAX_BODY_CHARS = MAX_ENTRIES × (MAX_CONTENT + MAX_TITLE + MAX_WHEN + 200) × 2 + 100000` → **2,708,000**
（×2 覆盖 JSON 转义，+100k 覆盖信封）。该常量现已导出，供测试与用户自行校验。

**验证**：修复后同一请求 `"importHttpStatus": 200`，body 1,224,376 ≤ cap 2,708,000；
最坏合法载荷 1,285,147，余量 1,422,853。`contract-test.mjs` 与 `ab-harness.mjs` 各新增一条上限守卫。

### D-4 · 超长内容被静默截断 · 低-中

**现象**：导入/手工编辑时超过 `内容 6000 / 标题 120 / 适用场景 200` 的文本被 `sanitizeEntry` **无声改短**，
返回消息仍是"导入完成：新增 1 条"。这与 README 承诺的"不会静默丢弃"直接冲突。

**证据（修复前）**：发送 7000 字符 → 存储 6000 字符 → `"truncationDisclosed": false`。

**修复**：新增导出的纯函数 `truncatedFields(raw)` 报告被截断的**字段名**；
`saveEntry` 与 `importData` 用它生成提示（"内容超过长度上限…超出部分已被截断" /
"其中 N 条超过长度上限，内容已被截断"）。`sanitizeEntry` 的契约保持不变。

**验证**：修复后 `"truncationDisclosed": true`；`contract-test.mjs` 新增 3 条守卫
（含"被截断的条目仍被注入——它是被保存了，不是被丢掉了"）。

### D-5 · 空操作导入谎报 `saved: true` · 低

**现象**：导入一个全是重复条目的文件时返回 `{ok:true, saved:true}`，但**根本没有写盘**。
`state` 与其他方法都靠 `saved` 区分"真的落盘了"，这里是在说谎。

**证据（修复前）**：`"saved": true`，`"fileChanged": false`。

**修复**：`accepted.length === 0` 时返回 `saved: false`（`ok` 仍为 `true`，消息不变）。
同时把整个合并计划提到变更之前计算，避免"计数器与实际追加不一致"。

**验证**：修复后 `"saved": false`；`contract-test.mjs` 新增 2 条守卫（含"存储未被改动"）。

### D-6 · 无 Web 服务器的 profile 里记忆**完全失效** · 高

**现象**：`inject = ['systemPrompt', 'webServer']` 把 Web 服务器声明成了**前置条件**。
在 `headless` / `tui` 这类没有 Web 服务器的 profile 里，整行插件永远停在 `pending`，
**`apply()` 根本不执行** → 用户同时失去设置页**和**系统提示词注入——而记忆本身完全不需要 Web 服务器。

**证据**：启动日志 `instruction-memory  pending, missing: ['webServer']`；
且 `apply()` 本身在没有 `webServer` 时**工作正常**（能正常注册注入段落，只是路由没注册）。

**修复**：
- `inject` 收敛为 `['systemPrompt']`；
- 路由改由**非阻塞** `ctx.inject(['webServer'], (scope) => …)` 子 fiber 注册，服务发布时自动挂上。

这在修掉"前置条件"的同时，把最初那个竞态修得**更彻底**：原方案只在 webServer 恰好早于本行挂载时
才拿得到它；新方案在服务**任何时刻**发布都会触发回调。子 fiber 归父所有，卸载插件时路由一并注销。

**验证**：
- **真实 cordis Context 集成测试**（`real-cordis-mount.mjs`，9/9）：只发布 `systemPrompt` 时注入段落
  已注册；**之后**再发布 `webServer`，路由被正确注册；真实 fiber 上路由能应答 `state`；卸载后两者都被注销。
- `verify.mjs` 旧断言（`inject.includes('webServer')`）正是把这个缺陷**锁死**的那条，已改为
  `declares systemPrompt but NOT webServer`，并新增"没有 Web 服务器时注入段落仍然注册"守卫。

### D-7 · 客户端丢弃宿主可读的错误原因 · 低

**现象**：`callHost` 对非 2xx 一律抛 `宿主返回 HTTP 413`。宿主 413/415 的响应体里本就有
可读原因（如"请求体超过 N 字符上限"），全部被丢掉。

**修复**：先尝试解析错误响应体的 `message` 并附在错误里。

**验证**：代码审查 + 端到端路由响应体确有 `message` 字段（`contract-test.mjs` 的 413/415 断言即读该字段）。

---

## B. 未修复 / 不在本仓库范围

> ✅ **本节 4 项已在第二轮全部处理完毕，详见 [ROUND2.md](ROUND2.md)。**
>
> ⚠️ **纠正**：本节的 E-1 曾把根因写成"目录 ACL 缺 `WRITE_DAC`"——**这是错误的**。实测给该目录
> **新增一条 ACE 完全成功**，说明 `WRITE_DAC` 是有的。真因是**写不了强制完整性标签**
> （`LABEL_SECURITY_INFORMATION`），与 `WRITE_DAC` 无关。原文保留在下方以免抹掉记录，
> 但**不要照它排查**；请以 [ROUND2.md §1](ROUND2.md) 的实测结论为准。

### E-1 · DSH `workspace-write` 沙箱在本工作区无法初始化 · ~~环境，非插件缺陷~~ → 已修复

**现象**：`SetNamedSecurityInfoW failed (Win32 5): grantWrite(<工作区>)`，任何命令都无法执行。
**原（错误）判断**：`Authenticated Users:(M)` 不含 `WRITE_DAC`，所以授写权限失败。
**实际**：见 [ROUND2.md §1](ROUND2.md) —— `WRITE_DAC` 可用，失败的是**强制完整性标签**写入。

**我没有执行修复**，因为这是**修改机器上的安全描述符**，超出"修插件"的范围。若你要修：

```powershell
# 诊断（只读）
icacls 'D:\Users\34332\AI\dsh-instruction-memory'
# 修复：给当前用户显式 WRITE_DAC（可逆）
icacls 'D:\Users\34332\AI\dsh-instruction-memory' /grant "$($env:USERNAME):(WDAC)"
# 回滚
icacls 'D:\Users\34332\AI\dsh-instruction-memory' /remove:g "$($env:USERNAME)"
```

### E-2 · 插件没有任何成功路径日志 · 设计取舍，但导致了验证困难

`lib/index.js` / `lib/client.js` 里 0 处 `log/info/warn/debug`，只有 8 处失败分支的 `console.error`。
因此 [REPORT.md](REPORT.md) 步骤 3 要求的"写入/读取/命中/更新/淘汰日志"**按字面无法采集**。

这**不是缺陷**（README 未承诺日志），但它是可观测性缺口。若要补，建议加一个可选的
`debug` 级诊断（装配时输出 `registered/chars/条目数`，写盘时输出 `path/bytes/bak`），
默认关闭、不影响提示词逐字节稳定性。**我没有擅自加**——那会改变插件的输出契约，属于维护者决策。

### E-3 · 未声明的未来预发布 minor 无法被 semver 范围覆盖 · 已知限制

`host-range-test.mjs` 已有实时守卫，README 已完整记录。本次宿主 `0.1.7-rc.2` 在范围内、实测通过。
无需改动；升级到 `0.1.8-rc.x` 时需追加一段范围——**这是 DSH 发新版时才需要做的动作**。

### E-4 · 路由无认证 / 无 Origin 校验 · 评估为不新增攻击面，未改

`POST /instruction-memory/api` 只要求 `content-type: application/json`。评估：

- 跨站攻击：无 CORS 响应头 → 跨源 `fetch` 带 JSON content-type 会先触发 preflight 并失败；
  HTML 表单无法伪造 JSON body，被 415 挡住。**已挡住**（`contract-test.mjs` 有 415 断言）。
- 本地进程：任何本地进程都能直接改 `memory.json`，路由不增加新的攻击面。

结论：**不构成新风险**，未做改动。若你希望加令牌，那是产品决策，请明确要求。

---

## C. 变更清单

`git diff --stat`：**7 files changed, 539 insertions(+), 139 deletions(-)**

| 文件 | 变更 | SHA256（修复后） |
| --- | --- | --- |
| `lib/index.js` | +282 / −119 — 6 个缺陷的宿主侧修复 | `C8C49CDE…9BC05` |
| `lib/client.js` | +13 / −1 — D-7 | `66C60FD1…6F2C6` |
| `verify.mjs` | +61 / −6 — 解掉锁死 D-6 的断言，新增无 Web 服务器守卫 | `B0CEE1F9…74F49` |
| `contract-test.mjs` | +148 / −7 — D-1/D-2/D-3/D-4/D-5 回归守卫 + `inject` 桩 | `777DCFF2…36408` |
| `README.md` | +29 / −5 — 备份语义、缺失恢复、截断披露、无 Web 服务器 | `D25FBB89…E32DF` |
| `package.json` | 1.0.9 → **1.0.10** | `D60C0A8F…3F897` |
| `.gitignore` | +5 — 忽略验证脚本的临时沙箱目录 | `94AECBF7…8ADFE` |

行尾一致性已核对：全部为纯 LF、**无混合行尾**，`numstat` 也证明不是整文件重排。

修复前的完整备份在 `dsh-memory-verification/backup/pre-fix/`。

---

## D. 生效条件与回滚

**生效**：需要**重启 DSH**（`dsh` 在启动时读取 `inject` 与 `apply`）。重启前，运行中的宿主仍是旧代码，
`inject` 里仍含 `webServer`、写盘失败仍会超前注入。我没有替你重启。

**回滚（三级，任选）**：

```powershell
# 1. 只回滚被修复的源码
Copy-Item .\dsh-memory-verification\backup\pre-fix\lib__index.js  .\lib\index.js  -Force
Copy-Item .\dsh-memory-verification\backup\pre-fix\lib__client.js .\lib\client.js -Force
Copy-Item .\dsh-memory-verification\backup\pre-fix\verify.mjs .\verify.mjs -Force
Copy-Item .\dsh-memory-verification\backup\pre-fix\contract-test.mjs .\contract-test.mjs -Force
Copy-Item .\dsh-memory-verification\backup\pre-fix\README.md .\README.md -Force
Copy-Item .\dsh-memory-verification\backup\pre-fix\package.json .\package.json -Force
# 2. 或用 git（若这些改动已在工作区、未提交）
git checkout -- lib/index.js lib/client.js verify.mjs contract-test.mjs README.md package.json .gitignore
# 3. 用户的记忆数据从未被本次修复触碰，无需回滚：
#    memory.json SHA256 仍为 06013E41FA12E0F2F963405A6AA794F73DCC161AE5CFB6B66D9BB818F7B57C43
```

---

## E. 建议的下一步（需要你决定）

1. **复核并提交**：改动都在工作区、未提交。`git diff` 可逐条对照本报告。
2. **重启 DSH 使修复生效**，然后重跑 `npm test`（应 159/0）确认线上加载的是新代码。
3. **是否发布 1.0.10**：版本号已改，但**我没有发布**（`npm publish` 需要登录，且是你的决定）。
   发布前请跑 `node check-metadata.mjs`（已通过）与 `npm test`。
4. **是否反馈上游**：仓库为 `HERO476/dsh-instruction-memory`。D-1/D-2/D-6 是值得上游收的修复。
5. **E-1 沙箱 ACL** 与 **E-2 诊断日志** 需要你点头我才动。

## F. 复现方式（全部只读于生产）

```powershell
cd <插件仓库>
npm test                                                    # 159 PASS / 0 FAIL
node .\dsh-memory-verification\scripts\ab-harness.mjs        # 70 PASS / 0 FAIL
node .\dsh-memory-verification\scripts\real-cordis-mount.mjs # 9 PASS / 0 FAIL
node .\dsh-memory-verification\scripts\defect-probe.mjs      # 6 项缺陷全部不再复现
```

对照证据：修复前 `dsh-memory-verification/logs/defect-probe.txt`（6 项 CONFIRMED），
修复后 `dsh-memory-verification/logs/defect-probe-after-fix.txt`。
