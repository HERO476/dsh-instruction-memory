# dsh-instruction-memory

在 DSH 设置界面中维护**长期指令记忆**：保存后自动注入此后每一轮对话的系统提示词。

![设置页截图](docs/screenshot.png)

> 想先看看界面？在 [GitHub 仓库](https://github.com/HERO476/dsh-instruction-memory)中打开 `docs/demo.html`，无需安装 DSH，浏览器直接体验真实设置页（内置演示数据）。

## 安装

```sh
dsh plugin --profile web add dsh-instruction-memory
```

装完重启 DSH，设置页会出现「指令记忆」入口。卸载：

```sh
dsh plugin --profile web remove dsh-instruction-memory
```

## 只由用户本人维护

**这份记忆的内容只属于用户。** 本插件刻意**不注册任何面向模型的工具**——模型没有任何
途径自行添加、修改或删除记忆条目。写入入口只有设置页（以及用户本人直接编辑存储文件），
因此不会出现 AI 悄悄给用户"记下"指令的情况。

条目内容由用户输入并被原样注入，本插件不对其做语义判断或自动生成。

## 组成

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | Host 半：读取/保存记忆，注册 `systemPrompt` 段落，暴露同源 JSON 路由 |
| `lib/client.js` | Client 半：在 `settings.section` 注册「指令记忆」设置页（手写模块，无需构建） |
| `cordis.patch.yml` | bundle patch：把 Host 行插入宿主组合 |
| `contract-test.mjs` | 契约测试：驱动真实路由，验证两半之间的响应格式 |
| `verify.mjs` | 装载验证：按 DSH 的方式加载两半 |
| `smoke-test.mjs` | 注入渲染逻辑的单元测试 |
| `host-range-test.mjs` | 宿主版本范围契约测试：固定矩阵 × 两种 semver 判定模式，锁死兼容性声明 |
| `docs/demo.html` | 离线演示页：桩掉 DSH 外壳、加载真实 Client 半渲染设置页（不随 npm 包发布） |

## 生效方式

- **始终** 条目：无条件遵守。
- **按需** 条目：由模型按相关性自行判断是否适用，不相关时忽略；可填「适用场景」辅助判断。
- **优先级** 高 > 普通 > 低，决定注入顺序。
- **注入字数上限**：超出时按优先级保留，被略过的条目数会在注入文本末尾注明。

条目全部停用或总开关关闭时，该提示词段落**整个注销**，系统提示词与未安装本插件时逐字节一致。

## 存储

记忆保存在 **DSH 数据根目录**下（设置页会显示完整绝对路径）：

```
<DSH_HOME>/instruction-memory/memory.json      # DSH_HOME 默认为 ~/.dsh
```

路径优先级与官方 `@deepseek-ai/dsh-home-paths` 一致：显式 `$DSH_HOME` → `~/.dsh`。
**空白的 `$DSH_HOME` 视为未设置**，绝不会退回当前工作目录——否则用户换个目录启动
DSH 就会得到第二份空记忆，看起来像"记忆消失"。

> 1.0.0 之前的构建曾把数据写在宿主进程 cwd 下（`.dsh-instruction-memory.json`）。
> 首次启动新版本时会自动迁移到上述位置，并把原文件改名为 `*.migrated` 保留。

该文件可手工编辑，改完点设置页的「重新载入」即可读回。每次保存先写临时文件再原子替换，
进程崩溃不会留下损坏的半截 `memory.json`；保存前把上一版**复制**为 `memory.json.bak`，
若 `memory.json` 解析失败会自动临时回退到该备份并明确提示。

> **备份为什么是"复制"而不是"改名"**：曾经的做法是先把 `memory.json` 改名成 `.bak`、
> 再改名临时文件顶上。这两步之间 `memory.json` 是不存在的——只要第二步失败（文件被占用、
> 磁盘满、杀软扫描），主路径就一直空着，下次启动找不到文件就会**建一份空存储**，用户的
> 记忆看起来凭空消失，而真实数据其实好好躺在 `.bak` 里。改为复制后主文件在原子替换成功
> 前始终待在原位；同时启动时若发现 `memory.json` 缺失而 `.bak` 可用，会**从备份恢复并写回**
> 主路径，而不是从零开始。

若手工编辑后的文件有条目为空或超过 200 条上限，设置页会明确提示哪些条目未能载入
（它们将在下次保存时从文件中移除），不会静默丢弃。导入时若某条超出长度上限
（标题 120 / 内容 6000 / 适用场景 200 字符），会明确提示**有几条、哪个字段**被截断，
而不是悄悄改短。

设置页支持**导出 / 导入**：导出为自带说明的 JSON 文件；导入采用**合并语义**——按 id 与
「标题+内容」去重，只新增、绝不覆盖或清空现有条目。请求体上限由条目上限推导
（`MAX_ENTRIES × (MAX_CONTENT + MAX_TITLE + MAX_WHEN + 200) × 2 + 100000`），保证**本插件
导出的文件一定能被自己导回**——早先写死的 1,000,000 小于满配导出（200 × 6000 = 1.2 M 字符），
导致满配记忆导出后无法导入。

### 首次运行不写文件（惰性创建）

全新安装、尚无任何记忆时，插件**不会**在宿主启动那一刻创建空的 `memory.json`。

> 这里曾主动物化一份空存储，只为让设置页有个真实路径可显示。但那意味着插件在**进程启动、
> 零会话、零任务**的状态下执行了一次磁盘写入——这正是行为审计中唯一能被正当称为
> "没活干还在动"的副作用。现在文件由**第一个真正需要它的动作**创建：一次保存、一次导入，
> 或设置页读取 `state`（面板打开时就会读）。

在这之前：`storage.path` 仍会显示路径，但 `storage.onDisk` 为 `false`，设置页显示
「尚未写入磁盘」（该文案本就存在），`state.injection.registered === false`，`pulls === 0`。
挂载日志相应为 `from=first run (no store on disk yet) onDisk=no`。

**不受影响**：从 `.bak` 恢复、以及从旧位置迁移——这两条分支只有在**磁盘上已有真实数据**时才会走，
它们仍然会立即写回。

## 无 Web 服务器时依然生效

`systemPrompt` 是本插件唯一的硬依赖。**Web 服务器不是前置条件**：设置页那部分路由通过
非阻塞的 `ctx.inject(['webServer'], …)` 子 fiber 注册，服务出现时自动挂上；没有 Web 服务器
的 profile（`headless`、`tui`）里，系统提示词注入照常工作，只是设置页不可用。

> 这里曾声明 `inject = ['systemPrompt', 'webServer']`。声明式依赖是**前置条件**，于是没有
> Web 服务器的 profile 里整行插件永远停在 pending、`apply()` 根本不执行——用户同时失去设置页
> **和**记忆注入，而记忆本身根本不需要 Web 服务器。非阻塞注册同时把最初那个竞态修得更彻底：
> 回调在服务发布时就会执行，而不只是在它"抢在插件挂载之前"发布时才生效。

## 诊断日志

插件此前**只有失败才有输出**：每次载入、保存、注入成功都不留任何记录，只有失败分支走
`console.error`。于是"记忆到底有没有在干活"完全无法从日志回答。现在它挂载时写一行
`info`，过程细节写 `debug`（走宿主的 `ctx.logger`）：

```
[instruction-memory] mounted: store=<DSH_HOME>\instruction-memory\memory.json from=memory.json onDisk=yes entries=2 enabled=true section=437 chars (pending assembly) pulls=0
```

挂载行含**数据来源**（`memory.json` / `memory.json.bak (main file missing)` / `memory.json.bak (main file corrupt)`
/ `legacy cwd file (migrated)` / `first run (no store on disk yet)`）、**是否已在磁盘上**（`onDisk`）、
条目数、总开关状态、段落就绪时的字符数，以及 `pulls`。

### 为什么是 `section=… (pending assembly)` 而不是 `injected=…`

**「段落已就绪」≠「已经注入」。** 注入发生在宿主装配提示词时；插件在挂载那一刻**什么都没注入过**，
打印 `injected=437 chars` 会让人误以为记忆已经进入了某个提示词。这是本插件此前一处会误导排查的措辞。

真正的"到达了提示词"的信号是 **`pulls`**：宿主每次对这段做装配，插件注册的那个 thunk 就被求值一次，
计数器加一。因此

- `pulls=0` = 已准备、**从未装配**（进程刚起来、或会话空闲）；
- `pulls=N` = 已被拉进提示词 N 次。

插件看不到会话或轮次，**不会**报告 `sessions=` 之类的数字——那会是编造。它只报告自己能真正观测到的东西。
`pulls` 同时出现在路由的 `state` 快照里（`injection.pulls`）。每次拉取另有一条 `debug` 行：
`section pulled into a prompt (pull #N)`。

**这是纯日志，绝不影响注入内容**：同一份存储在"有 logger"和"没有 logger"下渲染出的文本
**逐字节相同**（`verify.mjs` 有断言锁定这一点）。`debug` 级别由宿主日志级别过滤；
没有 logger 服务的环境下需要 `DSH_INSTRUCTION_MEMORY_DEBUG=1` 才会输出到标准错误。

## 请求来源防护（Host / Origin）

设置页路由之所以要求 `content-type: application/json`，是因为 HTML 表单无法伪造 JSON body，
而跨源 `fetch` 带 JSON 会先在 preflight 失败。**这两条防线都建立在"浏览器认为这是跨源"之上，
DNS 重绑定恰好推翻了它**：`evil.com` 解析到 `127.0.0.1` 之后，页面与服务器在浏览器眼里是
**同源**——不发 preflight、JSON 也合法，于是任何网页都能改写用户那份"注入到此后每一轮
对话"的长期指令。此时唯一无法伪造的就是浏览器发出的 `Host` 头。

因此当服务器绑定在回环地址（默认）时，路由**要求 `Host` 是回环**，另外校验 `Origin`（若存在）
与 `Host` 同源。命中即 **403**，并记一行日志：

```
[instruction-memory] route rejected a request: Host 头不是回环地址（可能是 DNS 重绑定攻击）：evil.com:8080
```

- 绑定 `--host 0.0.0.0`（主动对所有网卡开放）时 Host 校验**自动关闭**——那种情况下无法预知合法
  Host，强行限制只会打断所有正常客户端；`Origin` 校验仍然生效。
- 无 `Host` 的 HTTP/1.1 请求由 Node 的 HTTP 解析器先以 400 拒掉，根本到不了路由。
- 端口不参与 `Origin` 比对（反向代理可能改写端口），主机名才是重绑定攻击的对象。

## 兼容性

`dsh.compatibility.dsh` 与 `dsh.engines.dsh` 声明为同一串：

```
>=0.1.3-alpha.2 <0.1.4 || >=0.1.4-0 <0.1.5-0 || >=0.1.5-alpha.1 <0.1.6-0 || >=0.1.6-alpha.0 <0.1.7-0 || >=0.1.7-alpha.0 <0.2.0-0 || >=0.2.0-0
```

**实测范围**：以下 5 个宿主版本已在 **Windows / Node 22** 上逐个真实启动验证（每个版本都确认了
插件装载、系统提示注入真的进入组装后的提示、插件 HTTP 路由可应答、客户端设置页模块被下发）：

`0.1.3-alpha.2` · `0.1.5-alpha.1` · `0.1.5-alpha.2` · `0.1.5-rc.1` · `0.1.5-rc.2`

此外 `0.1.6-alpha.2` 与 `0.1.7-rc.2` 完成了完整的装载与兼容性判定核验（`host-range-test.mjs`
的固定矩阵覆盖它们，且该脚本会**读取本机实际安装的宿主版本**做实时断言）。

**为什么写成分段形式**：node-semver 规定"候选版本带预发布标签时，区间里必须存在同一个
major.minor.patch 且自身带预发布标签的比较符"。这条规则是**集合级**的——一个 `||` 分支最多
覆盖**一个** minor 的预发布版本。由此产生两个必须遵守的约束：

- **宽写法接不住预发布**：`>=0.1.3-alpha.2`、`>=0.1.3-alpha.2 <0.2.0-0` 都**匹配不到**
  `0.1.4-0` / `0.1.5-rc.1` / `0.1.6-alpha.2`——因为 `0.1.3` 与 `0.2.0` 的 tuple 都不等于
  它们各自的 tuple（已用 node-semver 7.8.5 实测确认）。
- **每段的上界不能省**：省略会被上一段的比较符"续接"。例如单写 `>=0.1.5-alpha.1`（不封顶），
  在把 `0.1.3` 当 token 时会放行 `0.1.3-alpha.0/1`。

⚠️ **一个必须知道的上限**：**未声明的未来 minor 的预发布版本，无法被任何范围覆盖。**
`0.1.8-rc.1` 这类版本 tuple 与所有比较符都不同，在 npm 语义下**永远匹配不到**——与
`^0.1.0` 无法匹配 `0.1.8-rc.1` 是同一个限制。正式版（`0.1.8`、`0.2.0`、`1.0.0` 等）不受影响。

**这个限制无法用代码消除，但它的后果已经被消掉了。** 范围现在是**生成出来的**：
`host-range-test.mjs` 顶部的 `COVERED_LINES` 是唯一事实来源，package.json 里那串长字符串必须
逐字节等于由它生成的结果（有专门的漂移断言），所以手改长串导致"枚举漏了一段"这类错误不可能
再发生——DSH 发新 minor 时只需在列表末尾加一行。

同时**实时守卫**（直接读本机实际安装的宿主版本）在发现未覆盖的宿主时，会打印**精确到行**的
修复配方，并且在打印前**先验证该配方真的能让那个版本被放行**：

```
FAIL  LIVE GUARD: the installed host 0.1.8-rc.1 is admitted by both modes  -> ...
      Fix: append { floor: '0.1.8-alpha.0', below: '0.2.0-0' } to COVERED_LINES
           and set the preceding line's below to '0.1.8-0'
      [verified: that edit admits 0.1.8-rc.1]
```

这份配方本身也有测试：`host-range-test.mjs` 会拿 `0.1.8-rc.1` 走一遍"确认当前范围拒收 →
套用配方 → 确认放行 → 确认下方版本仍被拒收 → 确认所有已覆盖版本仍被放行"。配方失效会先失败在
测试里，而不是失败在用户的安装上。

**历史修复说明**（同一个 bug 出现过两次，值得记下来）：

- 1.0.7 及以前，范围末段是 `>=0.1.5-alpha.1`，使宿主 `0.1.6-alpha.2` 在 npm **默认**语义下
  被判为**不兼容**（预发布门禁要求 tuple 相同：`0.1.5 ≠ 0.1.6`，`>=` 的大小比较根本走不到）。
- 1.0.8 改为逐段枚举，但只枚举到 `0.1.6`。DSH 随后发布 `0.1.7-rc.2`，**同一个假阴性再次出现**：
  范围里最后一个预发布 tuple 是 `0.1.6`，而 `0.1.7 ≠ 0.1.6`。1.0.9 补上 `0.1.7` 段。
- 1.0.10 把枚举抽成 `COVERED_LINES` 单一事实来源 + 漂移/可达/递增断言，并让实时守卫给出
  **自验证**的修复配方——这个 bug 的**成因**（手改长串）从此被消掉。

两次都因为插件市场传入 `includePrerelease: true` 而侥幸放行，但任何标准 semver 判定
（`npm` / `pnpm` 的依赖解析）都会拒绝。现在 `host-range-test.mjs` 同时具备固定矩阵与实时守卫。

**未验证范围**：macOS / Linux、`headless` 与 `tui` profile、以及上表之外的其他 DSH 版本均未实测。

**同一串范围写在两处**：`dsh.compatibility.dsh`（插件自己的字段）与 `dsh.engines.dsh`（插件市场**实际读取**的位置）。
市场只读 `engines.dsh` / `dsh.engines.dsh` 以及 `@deepseek-ai/dsh*` 的 `peerDependencies`，并不读 `dsh.compatibility.dsh`。
从 1.0.4 起宿主要求会真实出现在市场卡片上，并生效于安装前的校验：**范围之外的宿主上，市场会把本插件从列表中隐藏并拒绝安装/更新**
（市场只隐藏"确认不兼容"的条目；"未声明"或"无法确认"的条目照常显示）。范围之外的宿主仍可自行用 `dsh plugin add` 安装，只是不再被市场担保。
`host-range-test.mjs` 会断言这两处字段逐字节一致。

## 发布（维护者）

```sh
# 1. 自检（prepublishOnly 也会自动跑，占位符未替换会中止发布）
npm test
node check-metadata.mjs
# 2. 发布（需先 npm login）
npm publish
```

发布前自检会拒绝在 `TODO` 占位符残留时发布，避免把空仓库地址或无名版权声明发出去。

## 数据格式

```json
{
  "version": 1,
  "enabled": true,
  "budgetChars": 4000,
  "entries": [
    {
      "id": "im-xxxx",
      "title": "回答语言",
      "content": "所有回答使用简体中文。",
      "mode": "always",
      "when": "",
      "priority": 1,
      "enabled": true,
      "updatedAt": 1700000000000
    }
  ]
}
```

`mode` 为 `always` | `auto`；`priority` 为 `2` 高 / `1` 普通 / `0` 低。
