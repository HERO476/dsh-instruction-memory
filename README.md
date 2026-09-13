# dsh-instruction-memory

在 DSH 设置界面中维护**长期指令记忆**：保存后自动注入此后每一轮对话的系统提示词。

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

该文件可手工编辑，改完点设置页的「重新载入」即可读回。

## 兼容性

`dsh.compatibility.dsh` 声明为：

```
>=0.1.3-alpha.2 <0.1.4 || >=0.1.4-0 <0.1.5-0 || >=0.1.5-alpha.1
```

**实测范围**：以下 5 个宿主版本已在 **Windows / Node 22** 上逐个真实启动验证（每个版本都确认了
插件装载、系统提示注入真的进入组装后的提示、插件 HTTP 路由可应答、客户端设置页模块被下发）：

`0.1.3-alpha.2` · `0.1.5-alpha.1` · `0.1.5-alpha.2` · `0.1.5-rc.1` · `0.1.5-rc.2`

**为什么写成分段形式**：node-semver 规定"候选版本带预发布标签时，区间里必须存在同一个
major.minor.patch 且自身带预发布标签的比较符"。因此看起来很宽的写法——例如 `>=0.1.3-alpha.2`
甚至 `>=0.1.3-alpha.2 <0.2.0-0`——**反而匹配不到** `0.1.5-rc.1` / `0.1.5-rc.2` 这些预发布版本
（已用 node-semver 7.8.5 与插件市场自带的版本判定实现逐一实测确认）。分段写法在两者下都能覆盖上面 5 个版本。

**为什么没有上限**：不设上限，未来 DSH 发布新的预发布版本时不会被判为"超出上限"而拒绝升级。
代价是 `0.2.0` / `1.0.0` 这类未来版本在 node-semver 下也会被判为满足；若你希望严格封顶，
在末尾追加 `<0.2.0-0` 即可（注意那会让下一版 0.1.6+ 被市场判为超限）。

**未验证范围**：macOS / Linux、`headless` 与 `tui` profile、以及上表之外的其他 DSH 版本均未实测。

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
