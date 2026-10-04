# 工具可用 / 不可用 与故障切换（实测矩阵）

本文回答一个问题：**某个本机 AI 工具不可用时，路由器会不会自动换一个，换得对不对。**
所有结论都来自 2026-10-03 在本机的实测，命令可复现。

## 1. 结论先说

| 能力 | 状态 | 证据 |
| --- | --- | --- |
| 单个工具可用性判断 | ✅ 成立 | 逐工具真实探测：deepseek 1.8s、doubao 7.8s 返回 `ROUTER_OK` |
| 工具额度耗尽 → 自动切换 | ✅ 成立（真实发生） | Codex 撞用量上限，路由器判为 `unavailable` 并切到 deepseek |
| 工具通道断开 → 自动切换 | ✅ 成立（真实发生） | 豆包 CDP 指向空端口，`attempts` 记录 `doubao/unavailable`，deepseek 接管 |
| 工具未安装 → 自动切换 | ✅ 成立 | `start_failed`（ENOENT）进入切换链 |
| 普通任务失败 → 自动切换 | ✅ 可用性优先模式覆盖 | 当前生产配置会继续下一个 AI |
| 超时 / 状态不确定 → 自动切换 | ✅ 可用性优先模式覆盖 | 当前生产配置会继续下一个 AI |
| 结构化 CLI 无工具调用且空闲超时后切换 | ✅ 自动化覆盖 | 用于 Codex 断网后不退出的情况 |
| 故障工具冷却期内被跳过 | ✅ 成立 | 冷却后 `attempts` 为空，不再重复失败 |
| 报错原因能分辨到「哪种故障」 | ❌ 不成立 | 见第 6 节 |

## 2. 决定「能不能切换」的策略

当前生产配置及示例都使用：

```json
{"failoverPolicy":"availability-first"}
```

该模式只看当前 provider 是否成功返回。断网、额度不足、登录失效、启动失败、普通任务失败、权限阻塞、
输出异常、超时和状态不确定都会进入下一 provider；只有用户主动取消才终止整条链。失败 provider 会进入
冷却期，后续新任务在冷却时间内直接跳过它。

这种策略优先保证微信端能收到一个 AI 的结果。代价是前一个 AI 如果已经执行了部分操作，下一个 AI 可能
重复执行。若某台电脑上的任务更重视防重复，可改为 `"safe"`。下面三条规则只适用于 `safe` 模式。

安全模式的源码判断在 `lib/process.mjs`，最终是否继续由 `lib/engine.mjs` 根据策略决定。

**安全模式规则一：只有被识别为「暂时性故障」的错误才切换。**
命中 `retryPatterns`（或未配置时的内置正则）才是 `unavailable`，才可能切换；否则是 `unknown`
（"AI 执行失败，请在电脑端检查该工具"），**直接失败不切换**。这是为了防止把用户的正常提问失败
当成服务故障反复重试。

**安全模式规则二：文本型 / JSON 型输出默认「不切换」，必须显式声明。**

```js
const retryable = matches && (p.retrySafe || (reliable && !toolUsed));
```

`reliable` 只在**结构化事件流**（`codex-jsonl` / `claude-jsonl`）里才会被置为 true。因此
`output: "text"`（deepseek）和 `output: "json"`（豆包）**恒为不可重试**——路由器无法证明这个工具
"没产生副作用"，于是保守地放弃切换。

> 这是设计上的安全默认，不是 bug。代价是：不声明 `retrySafe`，这两个工具永远不会参与故障切换。

**安全模式规则三：`retryPatterns` 一旦设置，就完全取代内置的通用正则。**

```js
const matches = p.retryPatterns.length ? p.retryPatterns.some(...) : unavailable.test(message);
```

所以自定义模式表时必须把通用词（`quota`、`rate limit`、`429`、`503`、`额度不足`…）**一起写进去**，
否则反而比默认更弱。本项目给 deepseek / doubao 配的表就是这么来的。

**安全模式补充：结构化工具不一定能切换。** codex 走 `codex-jsonl`，是否切换取决于「这一轮有没有用过工具」：
额度耗尽发生在用工具之前 → 可以切换（本次实测正是如此）；已经读过文件、执行过命令之后才失败 →
`toolUsed` 为真，路由器**拒绝重放**，直接返回失败。这是刻意的，避免同一个任务被两个 AI 各做一遍。

结构化工具还可配置 `idleTimeoutSeconds`。当前 Codex 为 60 秒：60 秒没有新的 stdout 事件，且此前事件
没有任何工具调用时，路由器把它判为暂时不可用并继续下一个 provider。安全模式下，若已经出现工具事件，
空闲超时会停止；当前可用性优先模式仍继续下一个。这个规则处理「客户端断网后进程一直不退出」。

## 3. 当前配置口径

`config.json` 里两个工具都已开启切换，理由是它们都没有本地副作用：

- `deepseek`：`env.DSH_PERMISSION_MODE = read-only`，沙箱允许写入时才写文件（实测被拒绝），重试安全；
- `doubao`：`--runtime cloud`，任务在云端执行，不落本机工作目录，重试安全。

两者都设置了 `retrySafe: true` 和各自的 `retryPatterns`。豆包额外把自身特有的措辞写进了模式表：
`CDP is unavailable`、`cdp launch`、`找不到 doubao 命令`。

**安全模式下故意没写进去的**（可用性优先模式仍会切换）：

| 措辞 | 原因 |
| --- | --- |
| `豆包任务状态未知，请勿重复提交` | 执行状态不确定，重放可能产生第二次副作用 |
| `豆包任务需要人工确认` | 权限类问题，换工具也解决不了 |
| `豆包任务执行失败` | 任务本身失败，不是服务故障 |

## 4. 实测记录

### 4.1 离线体检（不调用 AI）

```sh
npm run check-tools
```

```text
  工具        优先级   输出          命令  绝对路径  工作目录  故障切换
  codex      10      codex-jsonl   ✔     ✔         ✔         安全默认（不切换）
  deepseek   15      text          ✔     ✔         ✔         retrySafe(17 条)
  doubao     20      json          ✔     ✔         ✔         retrySafe(18 条)
```

### 4.2 逐工具真实探测

```sh
npm run check-live
```

```text
  codex     不可用   11249ms   unavailable
  deepseek  可用      1758ms   "ROUTER_OK"
  doubao    可用      7765ms   "ROUTER_OK"
```

**codex 这次不是模拟的**：直接调用它返回的是真实报错——

```json
{"type":"turn.failed","error":{"message":"You've hit your usage limit. ... try again at 3:18 PM."}}
```

也就是说，写本文时这台机器上 Codex 的额度确实用完了，deepseek 与豆包是可用的兜底。
这正是本项目存在的意义。

### 4.3 切换验证（真实工具）

```sh
npm run check-failover
```

```text
  ✔ 由 deepseek 接管，耗时 19560ms
    切换链：simulated-outage(unavailable) → codex(unavailable)
    回复："ROUTER_OK"
```

命令会在真实工具之前插入一个「额度耗尽」的模拟工具，验证「故障 → 换下一个」的完整路径。

### 4.4 通道断开 → 切换（真实豆包）

把豆包适配器的 CDP 端点指向空端口，模拟「豆包 CDP 没开」，并把它排在 deepseek 之前：

```sh
echo '{"id":"real-failover-1","prompt":"只回复 ROUTER_OK"}' | node cli.mjs run --config /tmp/.../config.json --json
```

```json
{"id":"real-failover-1","provider":"deepseek","text":"ROUTER_OK",
 "attempts":[{"provider":"doubao","kind":"unavailable"}],"cached":false}
```

状态文件里的健康记录：

```json
{"doubao":   {"lastFailure":"...","kind":"unavailable","cooldownUntil":1791007380403},
 "deepseek": {"lastSuccess":"...","cooldownUntil":0}}
```

冷却生效后，紧接着的请求会把豆包**整体跳过**（`attempts` 为空），不会每个消息都重试一遍故障工具。

### 4.5 真实任务调用（不是探活）

前面几次都是「只回复 ROUTER_OK」的探活，只能证明**进程活着**。这里换成一道**真实任务**，
确认端到端拿回来的是**能用的东西**。

任务：用 JavaScript 写一个游程编码函数 `rle(str)`（`"aaabbc"` → `"a3b2c1"`），只输出代码块。
走的是生产入口 `router.mjs` + stdin，也就是微信 ClawBot 那条路：

```sh
cd wechat-ai-router
JIJIN_AI_ROUTER_CONFIG="$(cat config.json)" node router.mjs < .probe/task1-rle.txt
```

18.5 秒返回。状态文件说明了这次到底是谁干的、中间换过谁：

```json
{"status":"completed",
 "result":{"provider":"deepseek","cached":false,"text":"```js\nfunction rle(str){…}\n```"}}
{"health":{"codex":   {"kind":"unavailable","cooldownUntil":1791007712719},
           "deepseek":{"lastSuccess":"2026-10-03T06:07:40.790Z","cooldownUntil":0}}}
```

`codex` 这次依旧是**真实撞墙**（直连复现，与 4.2 的报错一字不差）：

```json
{"type":"error","message":"You've hit your usage limit. … try again at 3:18 PM."}
{"type":"turn.failed","error":{"message":"You've hit your usage limit. …"}}
```

**把它的产出拿去真跑**（`.probe/verify-rle.mjs` 抽出代码块后直接断言）：

```text
PASS  rle("aaabbc") = "a3b2c1"
PASS  rle("") = ""
PASS  rle("a") = "a1"
PASS  rle("abcd") = "a1b1c1d1"
PASS  rle("zzzz") = "z4"
PASS  rle("aabbaa") = "a2b2a2"

结果: 6/6
```

即「额度撞墙 → 自动绕开 → 兜底模型的答案可直接使用」在**真实任务**上成立，而不只是探活成功。

第三个工具也直接答了一道真实问题（`--provider doubao`，13 秒）：

```sh
node cli.mjs run --provider doubao --json --prompt "用一个例子解释什么是尾递归，三句话以内。"
```

```json
{"provider":"doubao","text":"尾递归是指函数的递归调用发生在**最后一步**…可被编译器优化为循环，避免栈溢出。"}
```

**顺带校准**：这次 codex 的切换是**内置** `unavailable` 正则命中的（`usage limit` 本来就在内置表里），
说明**没写 `retryPatterns` 的 provider 也能正确切换**；自定义模式表只在需要补充内置表没有的措辞时才有必要。
§6 缺口 4 说的「deepseek / 豆包的**真实**额度耗尽措辞未校准」仍然成立，本次没有把它们的额度用光。

#### 踩坑：`stateDir` 写相对路径会跟着 cwd 走

`config.json` 原来写的是 `"stateDir": ".router-state"`，但两个入口解析相对路径的基准**不一样**：

| 入口 | 解析基准 | 后果 |
| --- | --- | --- |
| `cli.mjs`（走 `readConfig`） | `config.json` 所在目录 | 稳定 |
| `router.mjs`（OpenClaw 直连） | **`process.cwd()`** | 从哪个目录启动就落哪个目录 |

同一份 config，换个启动目录就会得到两个状态目录，表现为「冷却失效」「同一任务重复执行」「会话上下文丢失」。
微信侧拉起进程时 cwd 不受控，这条路径迟早会踩。

**本次处置**：把 `config.json` 的 `stateDir` 改成绝对路径 `/Users/amirliu/.jijin-ai-router`
（与 `openclaw.config.example.json5` 里的示例值、以及 `router.mjs` 缺省分支一致）。属配置修正，未动核心代码。
**留待所有者定口径**：是否把 `router.mjs` 的相对路径基准从 `process.cwd()` 改为模块自身目录，
让两个入口彻底一致。

## 5. 自动化覆盖

`tests/failover.test.mjs` 用模拟子进程锁定了以上行为，**不联网、不消耗额度**：

```sh
node --test tests/failover.test.mjs     # 19 个用例
node --test tests/*.test.mjs            # 全套 49 个用例
```

覆盖：首选可用时不打扰备用 / 额度耗尽切换 / 429 切换 / 未声明 retrySafe 不切换 /
未安装（ENOENT）切换 / 豆包 CDP 断开切换 / 豆包未安装切换 / 安全模式下普通失败不切换 /
安全模式下状态未知不切换 / 需人工确认不切换 / 普通超时不切换 / 结构化空闲且未调用工具时切换 /
已调用工具后空闲不切换 / 可用性优先模式下普通失败切换 / 可用性优先模式下超时切换 /
全部不可用给出明确原因 / 冷却跳过 / 三连失败后最后一个接管 / 配置里文本工具声明了 retrySafe。

其中一条是**配置守护**：如果将来有人误删 `deepseek`/`doubao` 的 `retrySafe`，
测试会直接失败并提示「缺少 retrySafe:true，故障时不会切换」。

## 6. 已知缺口（未修，需所有者定口径）

1. **故障原因被脱敏到无法分辨**。`lib/process.mjs` 把工具原始错误收敛为两句话，
   原文只用于正则匹配，不进 `attempts`、不进状态文件。结果运营者**分不清**
   「没装 / 没登录 / 额度不足 / 通道断开」，与 T11 验收条件冲突。
   建议在脱敏的同时留一条线索（`attempts[]` 加 `detail`，或把 stderr 尾部写进任务记录）。
2. **全部不可用时的提示过于笼统**：只有「所有候选 AI 均不可用，请在电脑端检查安装、登录和额度。」，
   不说是谁、为什么。
3. **冷却时长固定 60 秒**，没有恢复探测（probe），也不知道工具是否已经恢复。
4. **未实测**：额度真正耗尽时 deepseek / 豆包的报错文本，因此不确定它们的真实措辞能否被模式表命中。
   目前表里是推测的常见措辞，需要一次真实耗尽来校准。

## 7. 复现命令

```sh
npm test                 # 全套回归
npm run check-tools      # 离线体检，不调用 AI
npm run check-live       # 真实探测（会真实调用，豆包会真实建会话）
npm run check-failover   # 真实切换验证（插入模拟故障）
npm run doctor           # 原有诊断
```

## 8. 新增一个 AI 工具时的检查清单

后面每加一个工具，照这个顺序走一遍即可，全部实测、不靠推测：

1. **先确认它有非交互入口**。要能在无人值守下"读 stdin / 收参数 → 输出结果 → 退出"。
   桌面 GUI 客户端如果没有厂商支持的 CLI，不要急着做 GUI 自动化。
2. **确认它复用已有登录态**，而不是要求你别处再配一份 API Key。
   （deepseek 的做法是用最小 patch 把 provider 换成 `deepseek-account`；豆包是复用桌面端会话。）
3. **把权限收到最小**。deepseek 用 `DSH_PERMISSION_MODE=read-only`，codex 用 `-s read-only`。
   实测确认沙箱真的拦住了写操作，而不是只在提示词里"要求"。
4. **写进 `config.json` 并给绝对路径**（`command` 必须是绝对路径，
   否则后台/不同 PATH 下会找不到命令；`npm run doctor` 的 `pathIndependent` 字段可验证）。
5. **判断输出形态**：有结构化事件流就用 `codex-jsonl` / `claude-jsonl`；
   纯文本用 `text`；JSON 对象用 `json`（注意失败时也必须向 stdout 输出合法 JSON）。
6. **只有 `text` / `json` 型的工具才需要 `retrySafe: true`**，并同时补齐 `retryPatterns`。
   漏了这步的后果是「这个工具永远不参与故障切换」，而且不会有任何报错提示。
7. **跑三件套验证**：`npm run check-tools` → `check-live` → `check-failover`。
8. **把它的"不可用"措辞补进模式表**，同时确认"状态不确定""需要人工确认"这类措辞**没有**进去。
9. **更新本文档的矩阵表**和 `README.md` 的验证记录。
