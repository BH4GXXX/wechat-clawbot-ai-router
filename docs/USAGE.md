# 本机路由器使用说明

各 AI 工具、Node.js、WorkBuddy 技能和 OpenClaw 的实际安装步骤见 [本机工具安装与操作记录](INSTALLATION.md)。

当前版本 0.2 提供独立命令入口和 OpenClaw 插件入口。独立入口使用 Node.js 内置模块，无需 npm 安装依赖。Node.js 版本要求为 22 或更新版本。macOS 已完成模拟 CLI、OpenClaw 插件调用、微信通道在线和手机消息往返验证；Windows 实机尚未验证。

## 1. 初始化

在项目目录打开终端：

```sh
node cli.mjs init
node cli.mjs doctor
```

也可以在 Mac 双击 `start.command`，Windows 双击 `start.bat` 完成初始化和环境检查。这两个脚本不是微信监听服务。

`init` 创建 `config.json`，会启用 PATH 中发现的 Codex 和 Claude 命令，并将命令的绝对路径保存到配置。Mac 上找不到 Codex 时会检查当前已知的 ChatGPT.app 内置位置。显式配置的路径失效时会报错，不静默替换。只判断命令是否存在，不验证登录或额度。`doctor` 会报告 `configuredCommand` 和 `pathIndependent`；应在实际调用路由器的应用内检查，开发终端的 PATH 不能代表 WorkBuddy 的 PATH。已有配置不会被覆盖。请在相应 CLI 中自行登录。

如果所有工具都未找到，先安装或配置 `command` 的绝对路径，并设置 `enabled: true`。工作目录 `cwd` 是工具执行任务的位置，请改成要处理的项目目录。相对路径以配置文件所在目录为基准。

## 2. 执行与会话

```sh
node cli.mjs run --prompt "概述当前目录的项目" --id message-001 --session my-chat
node cli.mjs run --prompt "继续说明" --id message-002 --session my-chat
node cli.mjs run --prompt "概述项目" --provider claude
node cli.mjs status
```

相同 `id` 与相同内容会返回已完成的缓存结果。相同 ID 换内容会被拒绝；执行失败或状态不明的任务也不会用原 ID 自动重放。明确需要重做时使用新的 ID。

`session` 可选；相同会话会把最近成功的对话传给下一个 AI，因此跨提供方仍有文字上下文。保留最多 12 轮、256 KiB；不共享厂商内部 session。不同微信用户/会话应由接入端分配不同且稳定的 `sessionId`。

## 3. 接入电脑端 ClawBot

已有 OpenClaw：参考 `openclaw.config.example.json5`，合并插件配置、修改绝对路径，将该 Agent 的默认模型设为 `jijin-ai-router/auto`，再重启 Gateway。现有微信通道继续处理收发消息。该插件已在 OpenClaw 2026.9.8 中完成实际调用，返回 `OPENCLAW_ROUTER_OK`。OpenClaw 模式由其传入历史上下文，独立入口的 `--session` 不适用于此模式。

其他接入程序：调用本地进程 `node /绝对路径/cli.mjs run --config /绝对路径/config.json --json`，通过 stdin 写入一个 JSON 对象并关闭 stdin：

```json
{"id":"wechat-message-123","sessionId":"user-a-chat-1","prompt":"请分析这个项目"}
```

成功时 stdout 返回包含 `id`、`provider`、`text`、`attempts` 和 `cached` 的 JSON。接入端把 `text` 回复微信；非零退出时 stderr 返回简明错误 JSON。路由器不发送微信消息，也不会自动注册或替换现有机器人。文件内容/附件传递还需接入端约定。

## 4. 在对话中切换路由

当前微信会话可以保存一个首选 AI：

```text
/route status
/route codex
/route deepseek
/route workbuddy
/route doubao
/route auto
```

`/route` 是 OpenClaw 插件命令，直接修改本机状态，不调用 AI。自然语言短句“切换到 Codex”“改用 DeepSeek”“使用 WorkBuddy”“请切换到豆包”和“恢复自动路由”也会被路由器识别。

设置首选项不会关闭故障切换。例如当前首选 WorkBuddy，WorkBuddy 不可用时仍继续配置中的其他 provider。`/route auto` 删除当前会话偏好，恢复 `priority` 顺序。不同会话相互隔离，状态保存在 `stateDir/state.json`；不要通过删除状态文件重置路由。

CLI 也能验证同样的行为：

```sh
node cli.mjs run --session demo --prompt "/route workbuddy"
node cli.mjs run --session demo --prompt "只回复 ROUTE_OK"
node cli.mjs run --session demo --prompt "/route auto"
```

## 5. 切换规则

当前默认使用 `failoverPolicy: "availability-first"`。任一 provider 没有成功返回，包括断网、额度不足、登录失效、普通失败、权限阻塞、输出异常、超时和状态不确定，都会记录失败并继续下一个 provider；只有用户主动取消才停止。所有候选均失败后才向微信返回整体失败。

Codex 使用 JSONL 事件，Claude Code 使用 stream-json 事件。可设置 `idleTimeoutSeconds` 缩短断网挂起的等待时间，当前 Codex 为 60 秒。切换会启动另一个 AI 重新处理同一任务，因此前一个 AI 已经做过部分操作时可能重复执行。

如需避免重复执行，将顶层配置改为 `failoverPolicy: "safe"`。此模式仅对明确可重试的故障切换；文本或 JSON provider 需设置 `retrySafe: true` 和 `retryPatterns`，结构化事件流则会检查是否调用过工具。完整矩阵见 [工具可用 / 不可用 与故障切换](FAILOVER.md)。

写自定义 CLI 时注意：`output: "json"` 的 provider **失败时也必须向 stdout 输出合法 JSON**（例如 `{"error":{"message":"…"}}`）。路由器会先解析 stdout、再判断退出码，stdout 为空会被误报为「AI 返回的 JSON 无效」，真实原因全部丢失。参考 `adapters/doubao.mjs`。

冷却期间不重试该提供方，全部冷却时明确返回错误。同一状态目录一次只执行一个任务，并发请求返回 `busy`，由接入端排队或稍后重试。

## 6. 在各 AI 工具中保留任务

当前 Mac 的四个 provider 都启用了 `persistTask: true`。每次调用会在原始任务前加入“微信 ClawBot 任务 + 路由任务 ID”的可见标记；标记只用于客户端标题和检索，不要求 AI 在回复中复述。

| Provider | 原生记录 | 路由结果中的映射 |
| --- | --- | --- |
| Codex | `codex exec` 默认保存会话，ChatGPT/Codex 使用同一份 `~/.codex` 数据 | 从 `thread.started` 保存 `nativeTaskId` |
| DeepSeek | Harness headless 自动保存 Session 到 `~/.dsh`，标题由首条任务生成 | 当前版本保留路由任务 ID，Harness 自行生成 Session ID |
| WorkBuddy | 使用 `--session-id wechat-<任务ID>`，并通过 `CODEBUDDY_CONFIG_DIR=~/.workbuddy` 写入桌面端任务库 | `nativeTaskId` 等于该 WorkBuddy Session ID |
| 豆包 | `doubao sessions create` 在豆包客户端创建会话 | 保存 `conversationId` 为 `nativeTaskId` |

WorkBuddy 不再使用 `--no-session-persistence`。已实测生成的任务位于 `~/.workbuddy/projects/.../wechat-workbuddy-shared-visible-20261003.jsonl`，包含原任务和回复。若桌面端没有立即刷新任务列表，重新打开对应项目或重启 WorkBuddy 即可重新载入本地记录。

配置示例：

```json
{
  "persistTask": true,
  "taskLabel": "微信 ClawBot 任务"
}
```

provider 的 `args` 还支持 `{taskId}`、`{sessionId}`、`{nativeSessionId}` 和 `{source}` 占位符。参数由进程参数数组传递，不经过 shell。

## 7. 状态与恢复

独立入口默认在配置旁的 `.router-state` 保存健康状态、任务结果和可选会话历史。插件默认写到用户目录的 `.jijin-ai-router`。这些内容可能包含私密对话，请保留在本机。当前没有自动过期清理；删除结果记录会失去对应任务的去重能力。

> **本机已把 `stateDir` 显式设为绝对路径 `/Users/amirliu/.jijin-ai-router`**（不再依赖上面那个"相对配置目录"的默认值）。
> 原因是 `router.mjs` 这条入口用 `process.cwd()` 解析相对路径：同一份 config 换个启动目录就会落到不同状态目录，
> 冷却与去重会静默失效。取舍与复现见 [FAILOVER.md](FAILOVER.md) §4.5。

异常关机可能留下 `router.lock`。先确认记录的进程及相关 AI 子进程已经停止，再手动移除锁文件；不要删除 `state.json` 来强行重试。已完成任务缓存损坏时默认停止，防止重复执行。

## 8. 验证

```sh
npm test                 # 全套 49 项
npm run check-tools      # 工具体检（不调用 AI）
npm run check-live       # 逐工具真实探测「可用 / 不可用」
npm run check-failover   # 真实切换验证（插入模拟故障）
npm run try-codex        # 一次性判定：Codex 额度是否恢复 + 端到端选路是否符合预期
```

`npm run try-codex`（`scripts/try-codex.mjs`）是额度恢复/故障复盘时的单条命令，依次做三件事：直连 Codex 提一个问题判断额度是否恢复；用生产入口 `router.mjs` 提交一个**可验证**的编码任务并自动跑断言；最后读状态文件报出实际执行者、完整切换链和各 provider 健康状态。它还会先检查 `router.lock` 是否为陈旧锁（异常退出会留下它，使之后每个任务都直接报 `busy`），但**不会自动删除**，只给出命令。证据落在 `.probe/`。注意：Codex 被额度挡住时它**不算失败**——那正是多工具兜底要验证的场景，退出码只反映路由器这条链路是否跑通。

测试使用本地模拟子进程，不调用 AI 服务。覆盖切换、去重、超时、取消、会话隔离和正常文本误判等行为；`tests/failover.test.mjs` 另覆盖 19 项可用性/切换矩阵。2026-10-03 已额外通过当前 Mac 上已登录的 Codex、DeepSeek Harness（`dsh --profile headless`，复用桌面端登录态，`DSH_PERMISSION_MODE=read-only`）以及豆包（`adapters/doubao.mjs`，需先用 `doubao cdp launch` 开启调试端口）实际调用，均返回 `ROUTER_OK`。

同日还观测到一次**真实故障切换**：Codex 撞上用量上限（`You've hit your usage limit`），路由器判定为不可用并自动切到 DeepSeek；把豆包 CDP 指向空端口时同样切到 DeepSeek，并在状态文件里写入冷却。逐项结果见 [FAILOVER.md](FAILOVER.md)。手机微信经 OpenClaw、本机路由器和 Codex 的往返已返回 `WECHAT_ROUTE_OK`。Claude Code 与 Windows 进程树清理仍需实机验证。

Text 模式的 provider（如 `deepseek`）失败时，错误原文只在 stderr，路由器会把 `stderr` 纳入错误判定，因此仍能匹配 `retryPatterns`；但最终对外的错误文案由 `lib/process.mjs` 统一脱敏，接入端无法区分具体故障类型。详见 `docs/WORKBUDDY.md` 的「错误分类不足」。

桌面 GUI 客户端和 ACP 长驻进程暂未接入，不能将此版本描述为“任意客户端已支持”。

## 自动验收

运行 `node scripts/verify.mjs` 执行回归与最小 PATH 诊断；加 `--live` 会发起一次真实 Codex 只读检查，并验证重复任务命中缓存。报告保存为 `verification.local.json`。可用 `--bridge /已安装技能目录/scripts/run.mjs` 检查实际安装的技能脚本。

真实检查使用独立临时状态目录，任务只要求回复 ROUTER_OK。它不删除生产 state.json 或锁文件，不自动重做状态未知的任务。进程级验证不等于 WorkBuddy 对话或微信端到端已通过。
