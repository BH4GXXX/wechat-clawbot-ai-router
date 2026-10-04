# 豆包（Doubao PC）接入可行性验证

验证日期：2026-10-03　验证人：WorkBuddy（会话内实机操作）
对应任务：`docs/TASKS.md` 的 **T09 桌面客户端可行性矩阵**、**T10 桌面客户端首个适配器**

## 结论摘要

1. 豆包 PC 端**没有官方 CLI、没有本地 API、默认不开放调试端口**，深链协议只有 4 条 UI 唤起路由，不能作为"发问取答"通道。
2. 存在一条**社区实现的可用通道**：npm 包 `doubao-cli`（MIT，零依赖），它用 CDP 驱动本机已登录的豆包渲染进程收发消息。这是目前唯一能拿到"文本回复"的本地通道。
3. 机制、命令、权限、风险已从源码层面核清；环境识别与只读命令已在实机验证通过。
4. **判定性验证已完成，方法成立**：`doubao cdp launch` 在本机自己的终端里成功开启 CDP
   （Chrome/147.0.7727.149，协议 1.3），真实发消息拿到 `reply.text = "ROUTER_OK"`。
   豆包 **2.31.4 正常接受调试参数**，不存在相对上游 2.31.1 的回归。
   （此前在本会话内失败的原因已用对照实验定位为我方环境不向 GUI 应用投递启动参数，与豆包无关。）
5. **适配器已实现并接入路由器**：新增 `adapters/doubao.mjs` 与 `config.json` 的 `doubao` provider，
   已按接入端 stdin JSON 契约端到端返回 `{"provider":"doubao","text":"ROUTER_OK"}`；
   新增 6 个离线测试（模拟 CLI，不消耗额度），全套 26/26 通过。
6. 若要在**无人值守**的微信链路上使用，必须先接受两个代价：CDP 开启期间本机任意进程都能
   无认证控制豆包渲染进程；且豆包每次正常重启后端口关闭，需要重新 `cdp launch`。

---

## 1. 验证环境

| 项目 | 值 |
| --- | --- |
| 平台 | macOS（darwin） |
| 豆包版本 | `CFBundleShortVersionString = 2.31.4`，`CFBundleVersion = 2.31.4` |
| Bundle ID | `com.bot.pc.doubao` |
| 应用路径 | `/Applications/Doubao.app` |
| 内核 | Chromium 分支 `Doubao Browser Framework 147.0.7727.149` |
| 当前配置档 | `Default`（显示名「工作」） |
| DoubaoWork | 未安装（`/Applications/DoubaoWork.app` 不存在） |

注意：豆包是"启动器 + 浏览器进程"双进程架构。`Contents/MacOS/Doubao` 只是启动器，
真正的 Chromium 在 `Contents/Helpers/Doubao Browser.app/`。

---

## 2. 可编程入口勘察（逐项实测）

| 入口 | 结论 | 证据 |
| --- | --- | --- |
| 官方 CLI | **不存在** | `/usr/local/bin`、`/opt/homebrew/bin`、`~/.local/bin` 均无 `doubao` |
| 本地 HTTP 接口 | **不存在** | `curl 127.0.0.1:9225 / 9226` 连接被拒；lsof 仅见启动器↔浏览器进程之间的 2 个环回端口 |
| CDP 调试端口 | **默认关闭** | 缺少 `DevToolsActivePort` 文件；进程 argv 无 `--remote-debugging-port` |
| 深链协议 | 仅 4 条，且都是 UI 唤起，**不返回 AI 结果** | framework 内字符串：`doubao://doubaoapp/open-url`、`doubao://doubaoapp/active-chat`、`doubao://doubao-text-picker`、`doubao://new-tab-page/` |
| LinkRouter 结果回传 | 机制存在，但**属内部协议、无公开契约** | `Helpers/豆包.app`（`com.bot.pc.doubao.linkrouter`）注册 `doubao` 与 `doubao-link-router-result` 两个 scheme；字段 `__saman_link_router_client_result`、`event_id`、`handler_product` |
| 内置 MCP | **方向相反**：豆包作为 MCP 客户端去调用外部工具，不能被外部反向调用 | `libmcp_helper.dylib` 含 stdio/HTTP MCP 客户端、`connectorId`、`x-mcp-header`；应用内无 `mcpServers` 本地配置键 |
| GUI 自动化（AX / Apple Event） | **被 macOS 权限拦截** | `osascript -e 'tell application id "com.bot.pc.doubao" to quit'` → `权限违例 (-10004)` |
| 厂商 HTTP API | 存在且可靠，但**违背本项目"不直接调用厂商 API"的原则** | 火山方舟 `https://ark.cn-beijing.volces.com/api/v3`，需 API Key |

---

## 3. 找到的方法：`doubao-cli`

| 项目 | 值 |
| --- | --- |
| 包名 / 版本 | `doubao-cli` `0.13.0`（2026-10-01 发布，共 24 个版本） |
| 仓库 / 许可 | `github.com/Fullstop000/doubao-cli` / MIT |
| 维护者 | `fullstop0002`（**个人开发者，非字节官方**） |
| 依赖 | **零运行时依赖**；Node ≥ 22；仅 macOS |
| 上游声明验证过的版本 | DoubaoWork 2.30.5、Doubao 2.31.1（PR #9，2026-09-25） |

### 工作机制（读源码得出，非猜测）

1. `doubao cdp launch`：先退出豆包（`osascript quit`，失败则 `pkill -TERM`），
   再用 `/usr/bin/open -a /Applications/Doubao.app --args --remote-debugging-port=9225` 重启，
   轮询 CDP 就绪（Work 用 9226，普通版用 9225）。
2. 发送：通过 CDP WebSocket 在**已登录的 chat renderer**里 `Runtime.evaluate` 发请求，
   复用应用自身的请求签名钩子（`msToken` / `a_bogus` / `x-helios` / `x-medusa`）。
3. 接收：从 **SSE 流**读取回复；消息、附件、模型选择走 DOM 操作。
4. 会话元数据来自账号 IndexedDB 快照；任务跟踪跟随关联线程。

### 源码审查结论（0.13.0 解包共 4510 行）

- **无生命周期钩子**：`package.json` 没有 `preinstall` / `postinstall` / `prepare`。
- **网络目标收敛**：仅 `www.doubao.com`、`api5-normal-gl.doubao.com`、`registry.npmjs.org`（更新检查）、`127.0.0.1`（CDP）。**无第三方回传地址**。
- **不窃取凭据**：所有请求在渲染进程内以 `credentials: 'include'` 发出，复用应用自身会话；源码注释明确"never copy signature/token fields or use another application's device ids"。
- **风险面**：它确实会开启一个**无认证的 localhost 调试端口**，并在该端口上完整控制你已登录的豆包。README「Limits」自己也列了这一点。

---

## 4. 本机实测结果

### 已验证通过的部分

| 命令 | 结果 |
| --- | --- |
| `status --json` | `installed: true`、`running: true`、`appVersion: 2.31.4`、`profile: Default(工作)`、`cdpEndpoint: http://127.0.0.1:9225` |
| `profiles --json` | `lastUsed: Default`，含「工作」 |
| `sessions list --json` | `[]`（纯本地读取，不需要 CDP） |
| `cdp status --json` | 正确报告 `available: false` |
| `usage --json` | 明确报错：`CDP is unavailable ... Run "doubao --app doubao cdp launch"` |

即：**工具可用、环境识别正确、只读能力正常、依赖 CDP 的能力被正确拦截。**

### 判定性验证：已完成，结论成立

2026-10-03 12:39，在**本机自己的终端**（非本会话）执行 `doubao cdp launch` 后：

| 命令 | 实测结果 |
| --- | --- |
| `cdp status --json` | `available: true`、`browser: Chrome/147.0.7727.149`、`protocolVersion: 1.3` |
| `sessions create "只回复 ROUTER_OK" --wait --json` | `status: completed`、`reply.text = "ROUTER_OK"`、`conversationId: 38445393965860610` |
| `sessions create … --runtime cloud …` | 同样成功；`context.runtime = "cloud"`，且**没有 `workspace` 字段**（不在本机落工作目录） |
| `runtimes --json` | `local`（READY，设备 `AmirdePC.local`）与 `cloud` 均可用 |
| `capabilities --json` | 全部 `true`，含 `sendMessages` / `waitForTurn` / `uploadAttachments` / `mcpConnectors` |

**结论：豆包 2.31.4 正常接受 `--remote-debugging-port`，本方法在本机成立。**

### 为什么本会话里跑不通（保留记录，避免重复踩）

`cdp launch --yes` 在本会话失败：`osascript quit` 被 TCC 拒（`-10004`），`SIGTERM` 被豆包忽略；
手动 ⌘Q 后重启则调试参数没送达——浏览器子进程 argv 仅 `--saman-from-chat=<pid>`，
`DevToolsActivePort` 未生成。

**归因实验（关键）**：自建探针 App 做对照——

- `/usr/bin/open <Probe.app> --args --flag-alpha` → 探针**收不到任何参数**
- 直接执行二进制 → 参数**正常收到**
- 用系统自带 TextEdit 复核（`open -n -a TextEdit --args --probe-abc123`）→ argv 里同样**没有**该参数

结论：**本会话环境不向 GUI 应用投递启动参数**，`open --args` 在任何应用上都失效。
这是会话环境的限制，**与豆包版本无关**——同样的命令在用户自己的终端里一次成功。

另外确认了启动器的身份：`Contents/MacOS/Doubao`（1.0 MB）是 **shim loader + 更新器**
（源码路径 `aha/saman/chrome/chat_app_shim/chat_app_shim_loader_mac.mm`、`aha/saman/update/update.cc`），
自己**不含** `remote-debugging-port` 字符串（该字符串在 `Doubao Browser Framework` 里），
但它并不过滤该参数——只要参数真的送达，豆包就会接受。

---

## 5. 复现步骤（2026-10-03 已验证通过）

在**本机自己的终端**执行（首次会弹出「允许控制豆包」的系统授权，选允许）：

```sh
# 任选一种安装方式
npm install --global doubao-cli@latest
# 或临时运行： npx --yes doubao-cli@latest <子命令>

# ⚠️ 装完若报 zsh: command not found: doubao —— 这是 Homebrew node 的 PATH 问题，见第 9 节
doubao cdp launch          # 会自动退出并重启豆包，开启 9225 调试端口
doubao cdp status --json   # 期望 available: true
doubao sessions create "只回复 ROUTER_OK" --wait --json
```

实测结果：`status: completed`，`reply.text = "ROUTER_OK"`。

实测踩到的坑：

| 现象 | 说明 |
| --- | --- |
| `sessions create --help` | **没有 help 支持**——`--help` 会被当成消息内容真的发出去（本次误发了一条内容为 `--help` 的消息，会话 `38445504524343298`）。任何子命令都不要用 `--help` 试探 |
| 消息以 `-` 开头 | 用 `--` 分隔：`sessions create -- "…"`；实测 `sent.text` 与原文一致 |
| 豆包重启后 | 调试端口关闭，需要重新 `cdp launch` |

验证完请务必恢复：

```sh
# 退出豆包（⌘Q）后正常打开即可关闭调试端口，或：
doubao cdp status --json   # 确认 available: false
```

**安全提醒**：调试端口开启期间，本机任何程序都能无认证读取/操作你已登录的豆包会话。
不要把"开着 CDP 的豆包"长期留在后台。

---

## 6. 接入实现（已完成）

| 文件 | 内容 |
| --- | --- |
| `adapters/doubao.mjs` | 适配器：stdin 收任务 → 调 `doubao sessions create --wait --json` → stdout 输出 `{"text": …}` |
| `config.json` | 新增 `doubao` provider（`priority: 20`，紧跟 codex 之后） |
| `tests/doubao-adapter.test.mjs` | 6 个离线测试，全部使用模拟 CLI，不联网、不消耗额度 |

实测（直接走接入端契约，不是手工调 CLI）：

```sh
echo '{"id":"doubao-e2e-1","provider":"doubao","prompt":"只回复 ROUTER_OK"}' \
  | node cli.mjs run --config <config> --json
# → {"id":"doubao-e2e-1","provider":"doubao","text":"ROUTER_OK","attempts":[],"cached":false}
```

### 为什么必须有一层适配

路由器 `output: "json"` 只认 `result` / `response` / `text` / `content` 四个键，
而 `sessions create --wait --json` 返回的是 `reply.text`——字段名对不上，适配层不可省。

### ⚠️ 自定义 provider 使用 `output: "json"` 时的契约陷阱（本次实测发现）

路由器在 `output: "json"` 下会**先** `JSON.parse(stdout)`、**再看退出码**。因此 provider 失败时
如果 stdout 为空，接入端只会收到误导性的 `{"error":"invalid_output","message":"AI 返回的 JSON 无效"}`，
真实原因（例如「CDP 未开启」）完全丢失。

适配器已按此约束处理：**失败时也向 stdout 输出合法的 `{"error":{"message":"…"}}` 并保留原 stderr**，
并写了测试锁定这条行为。任何自定义 provider 都要注意同一问题。

### 实现要点

1. **会话连续性**：路由器会把历史拼进 prompt，每次调用新建会话；不复用 `conversationId`，避免额外状态。
2. **运行时与权限**：当前配置用 `--runtime cloud`——不在本机执行、不落工作目录。
   CLI 默认是 `--runtime local` + `--permission FullAccess`（会在本机跑本地工具），
   无人值守前请自行评估，可改为 `--runtime local --permission AskOnRisk`（代价是需要人工点确认，任务会挂住）。
3. **`--wait` 的续等**：`--wait` 只等到单次超时；任务仍在跑时，适配器用同一 `runId` 走
   `sessions wait` 继续等，**不重发消息**（避免重复消费）。
4. **长度上限**：会话消息只能作为命令行位置参数传入，适配器在 512 KiB 处硬失败，避免撞上
   系统 `ARG_MAX`（本机 1 MiB）后报出难懂的 `E2BIG`。
5. **自动更新**：配置里设了 `DOUBAO_CLI_DISABLE_AUTO_UPDATE=1`，避免调用中途自我更新换掉二进制。
6. **`retrySafe` 未开启**：`sessions create` 会真实建会话、消耗额度，属有副作用的操作，
   因此默认不做自动故障转移。若确认可接受重复发送，再显式打开。

---

## 7. 备选路径与取舍

| 路径 | 可行性 | 代价 |
| --- | --- | --- |
| `doubao-cli` + CDP | **已验证成立**（2.31.4 实机收发通过，已接入路由器） | 非官方、随应用更新易碎、需开无认证调试端口、豆包重启后失效 |
| GUI 自动化（AX / AppleScript） | 需先授予辅助功能与自动化权限，当前被 -10004 拦住 | 最脆弱：依赖窗口焦点、流式输出判定、用户同时操作会打断；不符合 T10 对稳定性的要求 |
| 火山方舟 ARK API | 官方、稳定、可回传，最省事 | 需要 API Key 与计费；**违背本项目"路由器不直接调用厂商模型 API"的设计原则**，需要项目所有者明确改口径 |
| 等上游适配 2.31.x | 无需自研 | 时间不可控；上游是个人项目，无 SLA |

**建议**：T09 的结论应固化为「豆包**无官方可编程入口**，但存在一条**已验证成立的社区通道**」——
不能写成"豆包已支持"。T10 的首个适配器（Codex）保持默认主路径，豆包作为**第二个故障转移目标**接入。
它的三个前提必须写进 README：

1. 需要本机已登录豆包，且 CDP 处于开启状态；
2. 豆包正常重启后通道失效，需要重新执行 `cdp launch`；
3. CDP 开启期间，本机任意进程都能无认证控制该豆包会话。

---

## 8. 本次验证未覆盖的边界

- `--reply-schema` / `--expect-json` 未实测（结构化输出能力待验证）。
- 未验证附件（`--attach`）、模型选择（`--model` / `--reasoning`）、`--mcp`、项目与工作区等高级能力。
- 未做长任务验证：`sessions wait` 的续等路径只由**模拟 CLI** 覆盖，没有用真实长任务跑过。
- 未验证用户同时操作豆包界面时（切窗口、切会话、手动打断）的干扰程度。
- 未拿到额度耗尽时的真实报错文本，因此无法确认路由器 `unavailable` 正则能否命中豆包的错误。
- 未测试微信端到端链路（本项目整体仍未验证微信侧）。
- 未观察 CDP 常驻时的资源占用与长时间稳定性。

## 9. 安装后 `command not found` 排障（2026-10-03 实测）

`npm install --global doubao-cli@latest` 之后直接敲 `doubao`，报：

```
zsh: command not found: doubao
```

**这不是安装失败。** 包已经装好了，只是可执行文件不在 PATH 里。

原因：本机 npm 的全局前缀落在 Homebrew 的 **Cellar 私有目录**
`/opt/homebrew/Cellar/node/23.7.0`，所以命令实际生成在
`/opt/homebrew/Cellar/node/23.7.0/bin/doubao`；而 PATH 里只有 Homebrew 的链接目录
`/opt/homebrew/bin`。Homebrew **只链接它自己 formula 的文件，不会链接 npm 全局安装的命令**，
于是 `doubao` 永远不可见。

排查三步：

```sh
which -a node npm                       # 确认实际在用哪个 node
npm config get prefix                   # 看全局前缀落在哪
ls -l "$(npm config get prefix)/bin"    # 命令是不是生成在这里
```

修复（推荐，且不随 node 升级失效）：

```sh
ln -s /opt/homebrew/opt/node/lib/node_modules/doubao-cli/bin/doubao.mjs ~/.local/bin/doubao
```

- `~/.local/bin` 已在 PATH 中；
- `/opt/homebrew/opt/node` 是 Homebrew 维护的**稳定软链**（当前指向 `Cellar/node/23.7.0`），
  node 升级后 Homebrew 会自动重指，入口不会断。

验证：

```sh
doubao --version          # 0.13.0
doubao status --json      # 应识别出应用版本 / profile / cdpEndpoint
```

> 路由器接入提示：provider 的 `command` 支持绝对路径（见 `docs/USAGE.md` 第 1 节），
> 所以路由器本身不依赖 PATH。但**不要**把 `command` 写成带版本号的 Cellar 路径
> （如 `.../Cellar/node/23.7.0/bin/doubao`，node 一升级就失效），
> 用 `/opt/homebrew/opt/node/lib/node_modules/doubao-cli/bin/doubao.mjs`
> 或 `~/.local/bin/doubao` 更稳。

---

## 10. 待项目决策的一个诊断缺口（非豆包特有）

实测：CDP 未开启时，接入端收到的是

```json
{"error":"unknown","message":"AI 执行失败，请在电脑端检查该工具。"}
```

原因是路由器在 `lib/process.mjs` 里会把 provider 的原始错误**脱敏**成两句话
（`AI 额度、登录或服务暂不可用` / `AI 执行失败，请在电脑端检查该工具。`），
原始文本只用于 `retryPatterns` / `unavailable` 正则匹配，既不进返回结果，也不进
`attempts`，更不写状态文件。

后果：运营者**无法区分**「工具没装 / 没登录 / 通道（CDP）没开 / 额度不足 / 真的执行失败」，
这与 T11「用户能分辨未安装、未登录、额度不足和通道断开」的验收条件相冲突。
脱敏本身是对的（T07），但建议在脱敏的同时保留一条可诊断线索，例如：

- 在 `attempts[]` 里增加一个截断并脱敏后的 `detail` 字段，或
- 把 provider stderr 的尾部摘要写入状态文件的任务记录。

本次**未改动** `lib/process.mjs`（属核心行为且有测试锁定），口径交给项目所有者决定。

---

## 附：本次使用的测试材料

解包的 CLI 源码与 npm tarball 放在 WorkBuddy 会话目录
`.doubao-cli-inspect/`（含 `pkg/`、`doubao-cli.tgz`），可随时删除。

本次在本项目中新增/修改的文件：

| 文件 | 状态 |
| --- | --- |
| `adapters/doubao.mjs` | 新增 |
| `tests/doubao-adapter.test.mjs` | 新增（6 个模拟 CLI 测试） |
| `config.json` | 新增 `doubao` provider，`claude` 的 priority 由 20 调整为 30 |
| `docs/DOUBAO.md` | 本文档 |

本次实测在用户豆包账号里产生的会话（可自行忽略或删除）：
`38445393965860610`、`38445256484648450`、`38445504524343298`（最后一条内容是误发的字面量 `--help`）。
