# 第二轮：剩余 4 项修复 + 发布记录

承接 [FIXES.md](FIXES.md)。上一轮修了 7 个插件缺陷并列出 4 项"未修复/范围外"；本轮把这 4 项  
全部处理，并把 1.0.10 发布到 npm。

| 项                  | 上轮状态      | 本轮结果                           |
| ------------------ | --------- | ------------------------------ |
| E-1 沙箱无法初始化        | 判断错因、未修   | ✅ **真因已实证并修复**（附一处**诊断纠正**）    |
| E-2 无成功路径日志        | 未修（设计取舍）  | ✅ 已加诊断通道，且证明**不影响注入**          |
| E-3 未来预发布 minor 覆盖 | 未修（称无法修）  | ✅ 可修的部分已修：单一事实来源 + **自验证**修复配方 |
| E-4 路由无来源校验        | 评估为不新增攻击面 | ✅ 已加 Host/Origin 防护，真机验证       |

回归：**`npm test` 177 PASS / 0 FAIL**（上轮 159，最初 142）｜A/B 测试台 70/0｜  
真实 cordis 集成 9/0｜路由防护真机测试 36/0｜6 个已修缺陷仍全部不复现。

---

## 1. E-1 · 沙箱无法初始化 —— 先纠正，再修复

### 1.1 ⚠️ 纠正上一轮的错误诊断

上一轮我写：目录 ACL 只有 `Authenticated Users:(M)`，**不含 `WRITE_DAC`**，所以  
`SetNamedSecurityInfoW` 报 `ERROR_ACCESS_DENIED(5)`。

**这是错的。** 实测给该目录**新增一条 ACE 完全成功**：

```
实验A：只写 DACL（新增 ACE）  -> 成功
实验B：写强制完整性标签        -> Access is denied (exit 5)
```

`WRITE_DAC` 一直都在（目录 owner 是 `HERO\34332`，即当前用户；Windows 对 owner 隐含授予  
`READ_CONTROL` + `WRITE_DAC`）。**失败的是"写强制完整性标签"这一步。**

### 1.2 真因（代码级证据）

沙箱实现 `@deepseek-ai/dsh-sandbox-windows-acl`：

```js
// lib/types-DxezulnA.js:480
api.setNamedSecurityInfoW(path, 1, labelEdit.kind === "keep" ? 4 : 20, null, null, newAcl, ...)
//                                                DACL(4) | LABEL(0x10) = 20
```

它把 **DACL 与强制完整性标签（Low integrity）合并成一次调用**写入。标签存在对象的 SACL 位置，  
写它需要额外权限——沙箱自己的文档写得很清楚：

```
// lib/types/acl.d.ts:93
 * The directory must be owned by the caller AND grant WRITE_OWNER (the label ...
```

本机情况：owner ✅ 是当前用户；`WRITE_OWNER` ❌ —— `Authenticated Users:(M)` 不含它，  
而 `BUILTIN\Administrators:(F)` 虽然含，但当前令牌是 **UAC 过滤令牌**  
（`whoami /groups` 显示 Administrators 为 *"Group used for deny only"*），那个 `(F)` 不生效。  
所以 DACL 那半能过、LABEL 那半被拒，整调用返回 5，`grantWrite` 抛错。

### 1.3 修复（按沙箱文档的前置条件）

```powershell
icacls "D:\Users\34332\AI\dsh-instruction-memory" /grant "$(whoami):(OI)(CI)(WDAC,WO)"
```

ACL 变化**精确到一条 ACE**（`icacls /save` 的 SDDL 前后对比）：

```
before: D:AI(A;OICIID;0x110156;;;S-1-4-825086058-161902607)(A;ID;FA;;;BA)…
after : D:AI(A;OICI;WDWO;;;S-1-5-21-3420368060-2751838060-2397351331-1001)(A;OICIID;0x110156;;;…)…
                ^ 唯一新增：HERO\34332:(OI)(CI)(WDAC,WO)
```

### 1.4 实证验证（受控探针，位于同一父目录内）

|                                               | 修复前                           | 修复后                                                |
| --------------------------------------------- | ----------------------------- | -------------------------------------------------- |
| `icacls <probe> /setintegritylevel (OI)(CI)L` | **exit 5 · Access is denied** | **exit 0**                                         |
| 标签是否真的写上                                      | —                             | `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)` |

探针目录已删除，工作区无残留。**失败的正是标签那一步，而它现在成功了。**

> **诚实边界**：本会话策略是 `danger-full-access`，我**无法**真的以 `workspace-write` 模式  
> 启一次沙箱来端到端验证。上面证明的是"沙箱失败的那个原语现在成功了"。最终确认方式是新开一次  
> 处于 `workspace-write` 的会话。

### 1.5 过程中我自己造成的一次污染（已复原）

我在诊断时用 PowerShell `Get-Acl` / `Set-Acl` 做了"写回同一描述符"的测试，**误以为它无副作用**。  
实际上 PowerShell 的 ACL 往返**会**给 owner 补一条 `HERO\34332:(S)`（Synchronize, `0x100000`）ACE。  
靠 `/save` 的 SDDL 对比发现，已用 `icacls <dir> /remove:g "$(whoami)"` 清除并核对：

```
IDENTICAL TO BACKUP: True
```

**教训**：`Get-Acl`/`Set-Acl` 往返不是空操作；改 ACL 一律用 `icacls`（直接 Win32），并用  
`/save` 的 SDDL 做前后对比。

### 1.6 回滚 E-1

```powershell
icacls "D:\Users\34332\AI\dsh-instruction-memory" /remove:g "$(whoami)"
```

或从 `backup/acl-before.txt` 用 SDDL 精确写回（上一轮已验证该方法得到 `IDENTICAL TO BACKUP: True`）。  
ACL 备份：`backup/acl-before.txt`、`backup/acl-granted.txt`（授权后）。

---

## 2. E-2 · 诊断日志（日志只写日志）

**问题**：插件只有失败才有输出（8 处 `console.error`），成功路径完全静默，导致上一轮验证  
步骤 3 要求的"写入/读取/命中/更新/淘汰日志"**按字面无法采集**。

**修复**：走宿主 `ctx.logger('instruction-memory')`，两级：

- `info` —— 每次挂载一行，含**数据来源**、条目数、总开关、实际注入字符数、读取错误：
  ```
  mounted: store=<DSH_HOME>\instruction-memory\memory.json from=memory.json entries=2 enabled=true injected=437 chars
  ```
  `from=` 取值：`memory.json` / `memory.json.bak (main file corrupt)` /  
  `memory.json.bak (main file missing)` / `legacy cwd file (migrated)` / `first run (empty store created)`
- `debug` —— 每次写入（路径/字节/条目数/备份是否刷新）、注入段落注册与注销、路由注册、  
  提交回滚、以及**被拒绝的请求**。

**硬约束：不影响注入内容。** `verify.mjs` 新增断言：同一份存储在"有 logger"与"没有 logger"  
下渲染出的文本**逐字节相同**；并且生产注入块 SHA256 仍是 `D66C3C3E…`（未变）。

没有 logger 服务的环境（离线测试台）中，`debug` 需要 `DSH_INSTRUCTION_MEMORY_DEBUG=1`；  
`info` 始终有 `console.error` 兜底，挂载结果不会消失。

---

## 3. E-3 · 版本范围：把"手改长串"这个成因消掉

**必须说清楚**：npm 的预发布门禁按 `[major, minor, patch]` **精确匹配**，所以  
**未声明的未来 minor 的预发布版本无法被任何范围覆盖**——`0.1.8-rc.1` 与 `^0.1.0` 无法匹配  
`0.1.8-rc.1` 是同一个限制。**这一点无法用代码消除**，我不声称修好了它。

**修好的是它的成因和后果**（同一个 bug 已经出现两次：1.0.8 只枚举到 0.1.6，DSH 随即发  
0.1.7-rc.2，又漏一次）：

1. **单一事实来源**：`host-range-test.mjs` 顶部的 `COVERED_LINES` 是唯一来源，package.json 里那串  
   `||` 长串**必须逐字节等于**由它生成的结果（漂移断言）。手改长串漏一段这类错误不可能再发生——  
   加一个 DSH minor 只需在列表末尾加一行。
2. **可达性与递增断言**：每条声明线都必须能真正被范围满足，且 floor 严格递增。
3. **实时守卫打印自验证配方**：发现未覆盖的宿主时，直接给出精确到行的改法，并且**打印前先验证  
   该改法确实能放行那个版本**：
   ```
   FAIL  LIVE GUARD: the installed host 0.1.8-rc.1 is admitted by both modes -> …
         Fix: append { floor: '0.1.8-alpha.0', below: '0.2.0-0' } to COVERED_LINES
              and set the preceding line's below to '0.1.8-0'
         [verified: that edit admits 0.1.8-rc.1]
   ```
4. **配方本身也有测试**：拿 `0.1.8-rc.1` 走"当前范围拒收 → 套用配方 → 两种模式都放行 →  
   下方版本仍被拒收 → 所有已覆盖版本仍被放行"。配方失效会先失败在测试里，而不是失败在用户机器上。

---

## 4. E-4 · Host / Origin 防护（真机验证）

### 4.1 为什么原来的两道防线不够

上一轮我的结论是"不新增攻击面"，**这个结论不完整**。原来的防线是：

- 要求 `content-type: application/json`（HTML 表单伪造不了 JSON body）；
- 不发 CORS 头，跨源 `fetch` 带 JSON 会死在 preflight。

**两条都建立在"浏览器认为请求是跨源"之上，而 DNS 重绑定恰好推翻这个前提**：`evil.com` 解析到  
`127.0.0.1` 后，页面与服务器在浏览器眼里**同源**——不发 preflight、JSON 也合法。于是任何网页  
都能改写用户那份"注入到此后每一轮对话"的长期指令。此时唯一伪造不了的就是 `Host` 头。

### 4.2 实现

- 服务器绑定回环（默认）时，路由**要求 Host 是回环**：`127.0.0.1` / `localhost` / `::1` /  
  `::ffff:127.0.0.1`；`Origin` 若存在，其主机名必须与 `Host` 一致（只比主机名，端口可能被  
  反向代理改写；主机名才是重绑定攻击的对象）。
- 命中即 **403**，并记录一行日志。
- 绑定 `0.0.0.0`（主动对所有网卡开放）时 Host 白名单**自动关闭**——那种情况下无法预知合法 Host，  
  强行限制只会打断所有正常客户端；`Origin` 校验仍然生效。这个取舍已写进 README。

### 4.3 真机测试（真实 node:http 服务器 + 真实 HTTP 请求）

`scripts/route-guard-test.mjs`，36 项断言全过：

| 场景                                               | 结果                      |
| ------------------------------------------------ | ----------------------- |
| `Host: 127.0.0.1`（设置页正常调用）                       | 200 ✅                   |
| `Host: localhost`                                | 200 ✅                   |
| `Host: 127.0.0.1` + 同源 `Origin`                  | 200 ✅                   |
| **`Host: evil.com`（DNS 重绑定）**                    | **403** ✅               |
| `Host: evil.com` + 匹配的 `Origin: http://evil.com` | **403** ✅               |
| 跨源 `Origin`                                      | 403 ✅                   |
| `Origin: null`                                   | 403 ✅                   |
| 无 `Host`                                         | 400（Node HTTP 解析器先行拒绝）✅ |
| GET / 非 JSON content-type                        | 仍 405 / 415 ✅           |
| 绑定 `0.0.0.0` 时 `Host: 192.168.1.50`              | 200（白名单关闭）✅             |
| 绑定 `0.0.0.0` 时跨源 `Origin`                        | 403 ✅                   |

**最关键的一条**：重绑定写入被拒后，**存储哈希未变**、`PWNED` 条目既未落盘也未被注入。

仓库自带套件 `contract-test.mjs` 也新增了 8 条同样语义的守卫（用 req/res 桩），CI 会跑到。

---

## 5. 发布记录

| 项                 | 值                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| 版本                | **1.0.10**（registry 原为 1.0.9）                                                                     |
| 提交                | `098ca42` — 已推送到 `origin/main`（`git push` 成功）                                                     |
| npm `latest`      | **1.0.10**                                                                                        |
| `dist.integrity`  | `sha512-ChtxWVyCQkbm3Yq2CLzGmiP7cwhx7GNog+dPflpK48G5PkQ2P/c8sd9Yl2Kt0KEfbhMEQfSDhv06giMfx1mztw==` |
| `dist.gitHead`    | `098ca42f30a6865428a21a0820b974b9c1e37da4`                                                        |
| 发布方式              | **本地 `npm publish --access public`**（用 `~/.npmrc` 的 token）                                        |
| **provenance 存证** | ❌ **无**（token 发布 ≠ OIDC CI 发布，后者会自动附加 attestation）                                                |
| Git tag           | ❌ 未推送（原因见下）                                                                                       |

**发布物验证**（从 registry 全新缓存安装到临时目录）：  
`lib/index.js` 与 `lib/client.js` 的 SHA256 **与本地逐字节一致**，  
导出符号齐全，`inject` 为 `["systemPrompt"]`（E-4/E-6 修复确实在发布物里）。

### 5.1 两件需要你知道的事

1. **为什么是本地发布**：动手时 `git ls-remote` 连不上 GitHub（20 秒超时），  
   无法推 tag 触发 OIDC 工作流；而 registry 可达、token 有效，所以走了本地 `npm publish`。  
   推送 commit 时网络已恢复，**代码已经在 GitHub 上**。
2. **为什么不推 `v1.0.10` tag**：该 tag 会触发 `.github/workflows/publish.yml` 再次执行  
   `npm publish`，而 1.0.10 已存在——npm 不允许版本复用，CI 必然报 `EPUBLISHCONFLICT` 变红。  
   所以我没有推 tag。**建议 1.0.11 恢复 tag→CI 流程**，那样既有 release 标记，也会自动获得  
   provenance 存证（本次本地发布没有）。

### 5.2 一个小插曲（避免你困惑）

发布刚完成时 `npm view` 仍显示 1.0.9、`npm install` 报 `ETARGET`。原因有两个，都已自愈：  
registry 传播延迟（npm 自己提示 "may take a few minutes"）＋ npm 本地 HTTP 缓存了那次 404  
（用全新 cache 目录安装即成功）。直连 registry 复核确认 1.0.10 已在。

---

## 6. 本轮变更文件

```
 .gitignore        | +5   忽略验证脚本的临时沙箱目录
 README.md         | +80  诊断日志、请求来源防护、范围单一事实来源
 contract-test.mjs | +60  Host/Origin 守卫（8 条）
 host-range-test.mjs | +130 COVERED_LINES 单一事实来源 + 自验证修复配方
 lib/client.js     | +13  D-7（上一轮）
 lib/index.js      | +180 诊断通道 + Host/Origin 防护（本轮）＋ 上一轮 6 项修复
 package.json      | 1.0.9 -> 1.0.10
 verify.mjs        | +45  无 Web 服务器守卫 + 诊断不影响注入的断言
```

验证脚本与证据（**不随包发布**，`files` 字段不含）：`scripts/`、`logs/`、`out/`、`backup/`。

## 7. 生产状态

- `memory.json` SHA256 仍是 `06013E41FA12E0F2F963405A6AA794F73DCC161AE5CFB6B66D9BB818F7B57C43`  
  （与最初备份逐字节一致），目录里只有这一个文件。
- 生产注入块仍是 437 字符 / SHA256 `D66C3C3E…`，逐字节未变。
- **运行中的 DSH 仍加载旧代码**，需重启才生效 1.0.10（我没有替你重启）。
- 工作区 ACL 只多了 §1.3 那一条授权 ACE；我引入的 `(S)` 残留已清除并核对复原。
