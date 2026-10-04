# 微信 ClawBot 接入（前端直连，不经过模型）

目标：**在手机微信里发一句话，本机 AI 执行并把结果回到微信**，且这条链路里**没有任何模型挡在中间**——
消息直接被当成一次「模型调用」交给本机路由器，路由器按优先级选择本机已登录的 AI 工具。

## 1. 两条路线，先说清区别

| | 路线 A：WorkBuddy 远程通道 + 技能 | 路线 B：OpenClaw + 本插件（本文重点） |
| --- | --- | --- |
| 微信绑定 | WorkBuddy 助理设置 → 远程通道，已绑好 | 微信「我 → 设置 → 插件 → ClawBot」+ 电脑端扫码 |
| 消息路径 | 微信 → WorkBuddy 助手 → **助手模型先接手** → 调用技能 → 路由器 | 微信 → OpenClaw → **直接调用路由器** |
| 中间有没有模型 | **有**。每条消息都先经过 WorkBuddy 的助手模型，再由它决定调用技能 | **没有**。路由器注册为 OpenClaw 的一个模型后端，消息直达 |
| 优点 | 现在就能用，配置已就位 | 无模型参与、无额外 token 消耗、行为确定、延迟更低 |
| 现状 | 链路已打通（含故障修复），见 `docs/WORKBUDDY.md` | **已安装、扫码绑定、常驻运行并完成手机往返验收** |

路线 A 的问题不是"能不能用"，而是「前端路由根本不需要有模型参与」这个要求它满足不了：
微信消息一定会先落到助手模型上，再由模型去调技能。路线 B 把路由器直接做成模型后端，绕开了这一步。

## 2. 路线 B 在本机已经具备什么

三个入口文件都已就绪并通过本地验证（`npm test` / 手工契约验证）：

| 文件 | 作用 |
| --- | --- |
| `openclaw.plugin.json` | 插件清单。声明 `cliBackends: ["jijin-ai-router"]` 与配置校验 schema（含 `failoverPolicy` / `retrySafe` / `retryPatterns` / `output` 枚举） |
| `index.mjs` | 注册入口。把 `router.mjs` 注册成一个 CLI backend，并注入配置 |
| `router.mjs` | 运行时。从 stdin 读任务、把结果写到 stdout、诊断写 stderr |

`index.mjs` 还注册了不经过 AI 的 `/route` 命令，并把 OpenClaw 会话 ID 传给 `router.mjs`。因此不同微信会话可以保存不同首选 AI，Gateway 重启后偏好仍保存在路由器状态中。
自然语言切换使用 OpenClaw 的 `before_agent_reply` 钩子，配置中必须为本插件启用 `hooks.allowConversationAccess: true`；插件只检查当前消息是否完整匹配控制短句。

**契约已实测**（不需要装 OpenClaw 就能验证）：

```sh
export JIJIN_AI_ROUTER_CONFIG='{"stateDir":"/tmp/x/state","providers":[...]}'
echo "只回复 ROUTER_OK" | node router.mjs
# stdout: ROUTER_OK      ← ClawBot 直接拿这个当回复
# stderr: （空）          ← 诊断不会污染回复
```

要点：

- **配置通过环境变量传入**（`JIJIN_AI_ROUTER_CONFIG`，JSON 字符串），不经过命令行，任务内容也不会被当成 shell 参数。
- **状态目录由 OpenClaw 进程自己创建**（默认 `~/.jijin-ai-router`），不落在 WorkBuddy 的会话目录里，
  因此不会遇到 `docs/WORKBUDDY.md` 里那个「上个会话的文件被文件策略拦住」的问题。
- 实测这次调用由 `deepseek` 接管返回（`codex` 当时额度用完，被正确跳过）——故障切换在直连路径上同样生效。

## 3. 本机实际安装与绑定

### 3.1 装 OpenClaw 并让它加载本插件

`openclaw` 是 npm 上的真实包（`openclaw@2026.9.8`，"Multi-channel AI gateway with extensible messaging integrations"，
仓库 `github.com/openclaw/openclaw`）。

**本机已安装完成**（2026-10-03）。要点是它要求 `node: ">=24.16.0 <25 || >=26.1.0"`
（见其 `package.json` 的 `engines`），而本机原来的 Homebrew node 是 23.7.0，**装不上**。

本机的处置（`npm install -g openclaw` 会因 Node 版本被 preinstall 脚本拒绝）：

```sh
# 1) macOS 13 (Ventura) 上 Homebrew 对 node/node@24 都已停发预编译瓶，
#    brew 会从源码编译并连带升级 llvm/rust 等 18 个依赖 —— 不要走 brew。
#    改用 nodejs.org 官方预编译包：
curl -fLO https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-arm64.tar.gz
shasum -a 256 -c <(grep 'node-v24.21.0-darwin-arm64.tar.gz$' <(curl -sL https://nodejs.org/dist/v24.21.0/SHASUMS256.txt))
tar -xzf node-v24.21.0-darwin-arm64.tar.gz -C ~/.local/node
ln -sfn ~/.local/node/node-v24.21.0-darwin-arm64 ~/.local/node/current
# 2) 让 `#!/usr/bin/env node` 解析到 24.x（加到 ~/.zshrc 末尾，带存在性守卫）
export PATH="$HOME/.local/node/current/bin:$PATH"
# 3) 装（注意：npm 11 默认拦 install 脚本，必须放行，否则 postinstall 全被跳过）
npm install -g --allow-scripts=@google/genai,esbuild,koffi,protobufjs,openclaw openclaw
# 4) 确认版本满足插件要求（package.json: peerDependencies openclaw >= 2026.3.24）
openclaw --version
```

**第 3 步的 `--allow-scripts` 不能省**：npm 11 默认不跑 install 脚本，先装一次虽然"成功"
（`added 343 packages`），但 `openclaw` 自己的 `postinstall-bundled-plugins`、`esbuild` 的二进制拉取、
`koffi` 的原生编译**全被跳过**，装出来是不完整的。

Homebrew 的 `/opt/homebrew/opt/node`（23.7.0）**保持不动**，因为下面豆包 provider 依赖它。

先运行 `npm run openclaw-config`，它会把模板中的占位符替换为当前电脑的绝对路径，生成被 Git 忽略的
`openclaw.generated.local.json5`。启用已安装的 provider，再把该文件**合并**进 OpenClaw 现有配置
（不要覆盖微信通道部分）。模板已经写好权限设置、`retrySafe` 与错误模式表——这些口径的理由见 `docs/FAILOVER.md`。

关键一行是：

```json5
agents: { defaults: { model: { primary: "jijin-ai-router/auto" } } }
```

它让**默认模型就是本机路由器**，微信发来的消息不会先经过任何模型。

本机实际执行了插件链接、配置合并和本地模型验证：

```sh
openclaw plugins install --link --force --accept-capabilities "$PWD"
npm run openclaw-config
openclaw config patch --file openclaw.generated.local.json5
openclaw agent --local --session-id router-openclaw-verification-20261003 \
  --message "只回复 OPENCLAW_ROUTER_OK，不要调用任何工具。" --json
```

最后一条已由 `jijin-ai-router/auto` 返回 `OPENCLAW_ROUTER_OK`。配置模板应当合并到现有配置，不能覆盖已有的通道和账号设置。

### 3.2 安装官方微信插件并绑定

本机使用腾讯官方 npm 插件 `@tencent-weixin/openclaw-weixin@2.4.8`。安装和登录命令：

```sh
openclaw plugins install --pin --accept-capabilities \
  --acknowledge-install-policy-warning '@tencent-weixin/openclaw-weixin@2.4.8'
openclaw channels login --channel openclaw-weixin --account default --verbose
```

终端显示二维码后用手机微信扫码确认。本机已经出现“已将此 OpenClaw 连接到微信”，凭据由插件保存，不写入项目配置或文档。

### 3.3 安装常驻 Gateway

```sh
openclaw daemon install --runtime node \
  --runtime-path /Users/yourname/.local/node/current/bin/node
openclaw gateway status --json
openclaw channels status --probe --json
```

本机 Gateway 已安装为 `ai.openclaw.gateway` LaunchAgent，绑定在 `127.0.0.1:18789`。2026-10-03 的探测结果为：Gateway `running`、RPC `ok`；微信账号 `configured: true`、`running: true`、`lastError: null`。

`openclaw models status` 会把 `jijin-ai-router/auto` 显示为默认模型，同时可能提示无法确认该模型的认证状态。这是因为本项目是 CLI backend，登录由 Codex、DeepSeek、WorkBuddy 和豆包各自管理，不使用 OpenClaw 的模型凭据仓库。应以 `openclaw agent` 的实际返回和路由器健康记录判断可用性。`openclaw models list --provider jijin-ai-router` 也不适用，因为该命令查询的是模型目录供应商。

## 4. 验证本机路由器确实被调用

绑定成功后，在微信里发一句能产生确定性回答的话，例如：

```text
只回复 ROUTER_OK
```

同时在本机看状态文件（`stateDir` 指向的目录，默认 `~/.jijin-ai-router`）：

```sh
node cli.mjs status --config <你给 OpenClaw 用的配置>
```

`health` 里应出现对应 provider 的 `lastSuccess`；如果首发工具不可用，
任务记录里会出现 `attempts` 切换链——说明切换在微信链路上也生效。

也可以先发 `/status` 验证通道，再发上面的确定性消息验证路由器。收到微信回复后，运行 `openclaw channels status --probe --json` 检查 `lastInboundAt`，并在 Gateway 日志中确认 `outbound: text sent OK`。当前插件版本未必会更新状态接口中的 `lastOutboundAt`。

### 4.1 在微信里切换路由

```text
/route status
/route codex
/route deepseek
/route workbuddy
/route doubao
/route auto
```

同样支持完整对话短句：“切换到 Codex”“改用 DeepSeek”“使用 WorkBuddy”“请切换到豆包”“恢复自动路由”。为了避免误判普通任务，自然语言控制只匹配整条消息，不会把“请使用 Codex 分析这个文件”之类带任务内容的句子当成控制命令。

切换设置的是当前会话的**首选 AI**。例如 `/route workbuddy` 后先调用 WorkBuddy；如果 WorkBuddy 不可用，仍继续 Codex、DeepSeek、豆包中的可用项。`/route auto` 恢复配置的优先级顺序。

### 4.2 本机最终验收结果

2026-10-03 从手机微信 ClawBot 发送确定性测试消息，完整链路结果如下：

1. 微信插件在 `19:58:00` 记录入站消息；
2. OpenClaw 以 `jijin-ai-router/auto` 调用本机路由器；
3. 路由器选择 `codex`，任务成功返回 `WECHAT_ROUTE_OK`；
4. 微信插件在 `19:58:25` 记录 `text sent OK`。

由此确认“手机微信 → OpenClaw → 本机路由器 → Codex CLI → 手机微信”已经端到端可用。当前微信插件版本的通道状态接口没有同步填写 `lastOutboundAt`，因此出站验收以插件明确的 `text sent OK` 日志为准。

## 5. 已知限制（务必知情）

1. **24 小时窗口**：微信侧规定，用户超过 24 小时没发消息，主动推送会被直接丢弃。
   无人值守场景要让用户每天至少发一条（保活）。
2. **插件是灰度发布**：微信侧看不到 ClawBot 入口就说明没被放量，没有绕过办法。
3. **没有「重新绑定」按钮**：二维码失效后只能重跑一次安装命令。
4. **`/model` 必须带参数**：正确的写法是 `/model provider/model`，单写 `/model` 不支持。
5. **豆包需要 CDP 常驻**才能被调用，而 CDP 开启期间本机任意进程都能无认证操作你已登录的豆包。
   若不想承担这个代价，把豆包从 provider 列表里去掉，只留 codex + deepseek。
6. **codex 会撞额度上限**（本次实测就撞上了），这正是需要 deepseek / 豆包兜底的原因。
7. **豆包的运行时版本被 PATH 隐式改变了（待实测确认）**。`doubao-cli` 的入口
   `bin/doubao.mjs` 用的是 `#!/usr/bin/env node`，而 §3.1 把 `~/.local/node/current/bin`
   放到了 PATH 最前，于是 `~/.local/bin/doubao` 现在会由 **node 24.21.0** 解释执行，
   而不再是之前验证过的 **23.7.0**。它的 `engines` 是 `>=22`，理论上满足，但这个组合**没跑过**。
   路由器配置里 `doubao` provider 的 `command` 是 `/opt/homebrew/opt/node/bin/node`（23.7.0，没变），
   被动的是它再往下 spawn 的 `doubao` 可执行文件。
   **不依赖 PATH 的修法是**把 `~/.local/bin/doubao` 从软链改成固定 node 的包装脚本：
   ```sh
   # 注意：必须先删掉原软链再写，否则会顺着软链覆盖 doubao-cli 的源码文件
   rm ~/.local/bin/doubao
   printf '#!/bin/sh\nexec /opt/homebrew/opt/node/bin/node /opt/homebrew/opt/node/lib/node_modules/doubao-cli/bin/doubao.mjs "$@"\n' > ~/.local/bin/doubao
   chmod +x ~/.local/bin/doubao
   ```
   改完后用一次真实调用回归（`npm run check-live`）。

## 6. 来源

- `openclaw` npm 包元数据（`registry.npmjs.org/openclaw`，v2026.9.8，仓库 `github.com/openclaw/openclaw`）
- 微信 ClawBot 插件启用与电脑端扫码绑定流程：公开教程（今日头条《微信ClawBot插件安装教程》、
  oa0.com《微信支持 OpenClaw 了，详细设置指南》），其中微信版本要求、灰度说明、24 小时窗口、
  `/model` 用法均取自这两篇；
- 同类参考项目：WeClaw（`github.com/fastclaw-ai/weclaw`）、CLI-WeChat-Bridge。

上列第三方来源仅作流程参考，实际界面以微信与 OpenClaw 当前版本为准。
