# fineCode

> 一个留在你终端里的编程 agent，换任何模型都能用，记得住每次你让它做过什么。

一个极简的、模型无关的命令行编码代理 (coding agent)，继承自 Claude Code 的 **"harness 即一切"** 设计哲学。

> **核心思想**：不用复杂的 DAG/Chain 编排 LLM，只给模型一组丰富的工具、清晰的上下文、安全的权限模型，然后让模型自己决定怎么做。

## 特性

### 骨架
- 🔌 **任意模型** — 一条命令切换：OpenAI / Anthropic / DeepSeek / Moonshot (Kimi) / 智谱 GLM / MiniMax / OpenRouter / Groq / Ollama / 任何 OpenAI 兼容端点
- 🛡️ **三态权限模型** — allow / allow-always / deny；危险操作必须用户确认
- 🔧 **8 个核心工具** — bash / read_file / edit_file / write_file / grep / glob / ls / todo_write
- 🧠 **隐式 Agent** — 没有预定义工作流，完全由模型驱动
- 📦 **无 SDK 锁定** — Anthropic provider 用原生 fetch 实现

### 长期使用
- 💾 **会话持久化** — `fine -c` 接着上次聊，`/rewind` 回滚 AI 改过的文件
- 💰 **Token & 成本追踪** — 状态栏实时显示 `24.5k tokens (37%) · $0.024`
- 📎 **上下文锚** — `/anchor` 钉住"别忘了"的指令，跨 compact 永不丢
- 🗜️ **两层压缩** — 大工具结果自动 micro-compact；历史逼近窗口自动 summarize
- 🎓 **Skill 复用** — `/skill save` 把做过的事固化成 SKILL.md，下次关键词匹配时自动注入
- 🧠 **长期记忆** — session 结束时可自动抽取 key facts，下次在同目录打开时作为 user context 注入
- 👥 **Profile 多实例** — `--profile work` / `--profile side`，各自独立的 config / sessions / anchors / skills / memory

### 多模型协作
- 🤖 **Subagent 系统** — 让父 agent 调 `spawn_agent` 起子 agent 干脏活：research 用便宜模型、edit 用强模型、review 用第三个模型
- ⚡ **并发工具** — 只读工具自动并行（一次读 5 个文件 ~ 1× 时间）
- 💡 **便宜模型最大化指南** — 基于 2026-04 最新格局（对标 Claude Opus 4.7），单模型党友好，用国产模型拿到 ~85% 体验花 5% 的钱，详见下方 [实战指南](#用便宜模型最大化发挥实战指南)

### 扩展
- 🔌 **MCP 双向** — 作为 **client** 接外部 MCP server（GitHub/Postgres/…），也能作为 **server** 让 Claude Desktop 调用 fine 的工具
- 🎯 **Workflow 模式** — `/DDD` `/TDD` `/SDD` 三种强约束开发方式供自我约束的人用

### 上下文
- 📜 **FINE.md 规则** — 项目/全局 FINE.md 自动拼入 system prompt
- 🩺 **fine doctor** — 一键诊断：Node / config / 网络 / API key / 模型名是否有效
- ⚠️ **友好错误** — 把 `400 Model Not Exist` 翻译成"跑 fine doctor 看可用模型"

## 安装

```bash
# 一键脚本（推荐，自动装 Node）
curl -fsSL https://raw.githubusercontent.com/RickDamon/fineCode/main/scripts/install.sh | bash

# 或者全局装 npm 包
npm install -g fine-code

# 或者本地开发
git clone <repo>
cd fineCode
npm install
npm run build
```

> 要求 Node.js >= 18。

## VS Code 扩展

除了 CLI，fineCode 也有一个 **VS Code 扩展**，把同一套 agent 搬到 IDE 侧边栏里，共享 `~/.fineCode/config.json` 配置和会话历史。

```bash
# 从源码构建并安装
cd extension
npm install
npm run build          # esbuild 打包：dist/extension.js + dist/webview.js
npm run package        # 产出 fine-code.vsix (~350KB)
code --install-extension fine-code.vsix

# 或者按 F5 在 Extension Development Host 里调试
```

特点：
- 同一套核心（Agent / Session / PermissionManager / Provider）**零改动复用**
- CLI 和扩展读同一个 `~/.fineCode/config.json`、同一个 sessions 目录、同一套 anchors/skills/memory
- 权限弹窗在 Webview 里以 inline dialog 方式出现
- 斜杠命令 `/clear` `/model` `/cost` `/compact` `/sessions` `/diff` 都可用
- 包体积 ~350KB，启动瞬间

详见 [`extension/README.md`](./extension/README.md)。

## 快速开始

```bash
# 1) 首次使用先交互式配置
fine init

# 2) 以后直接启动，无需参数
fine
```

`fine init` 会引导你选择 preset（openai / deepseek / moonshot / openrouter / groq / together / ollama）、填入模型名和 API key，并保存到 `~/.fineCode/config.json`（文件权限 0600，仅所有者可读）。

## 配置优先级

运行时参数按下面的优先级合并（高优先级覆盖低优先级）：

1. **命令行 flag** — `--model` / `--api-key` / `--base-url` / `--preset` / `--provider` / `--bypass`
2. **环境变量** — `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `DEEPSEEK_API_KEY` / `MOONSHOT_API_KEY` (或 `KIMI_API_KEY`) / `ZHIPU_API_KEY` / `MINIMAX_API_KEY` / `OPENROUTER_API_KEY` / `GROQ_API_KEY` / `TOGETHER_API_KEY`
3. **配置文件** — `~/.fineCode/config.json`（可用 `fine config` 打印路径）

## 使用示例

### 用配置文件（推荐）

```bash
fine init          # 一次性设置
fine               # 以后直接用
```

### 用 CLI 参数（临时覆盖）

```bash
# OpenAI
fine --model gpt-4o --api-key sk-xxx

# Claude (Opus 4.7, the 2026 flagship)
fine --model claude-opus-4-7 --api-key sk-ant-xxx
fine --model claude-sonnet-4-5 --api-key sk-ant-xxx

# DeepSeek
fine --model deepseek-chat --preset deepseek --api-key xxx

# Kimi (Moonshot) — K2.5 is the current coding flagship
fine --model kimi-k2.5 --preset moonshot --api-key sk-xxx

# 智谱 GLM
fine --model glm-5.1 --preset zhipu --api-key xxx

# MiniMax
fine --model MiniMax-M2.5 --preset minimax --api-key xxx

# Ollama 本地模型（无需 key）
fine --model qwen2.5-coder:7b --preset ollama

# OpenRouter
fine --model anthropic/claude-opus-4-7 --preset openrouter --api-key sk-or-xxx
```

### 使用环境变量

```bash
export OPENAI_API_KEY=sk-xxx
fine -m gpt-4o

export ANTHROPIC_API_KEY=sk-ant-xxx
fine -m claude-sonnet-4-5-20250929

export DEEPSEEK_API_KEY=xxx
fine -m deepseek-chat -p deepseek
```

### 自定义端点

```bash
# 自建的 OpenAI 兼容服务
fine -m my-model -u http://localhost:8000/v1 -k any-key

# Azure OpenAI
fine -m gpt-4 -u https://my-resource.openai.azure.com/openai/deployments/my-deployment -k key
```

### 危险模式（跳过所有权限）

```bash
fine -m gpt-4o --bypass
```

## 命令

| 命令 | 作用 |
|------|------|
| `fine` | 启动 REPL（使用配置文件 / env / flag 解析出的参数） |
| `fine -c` | 继续当前目录最近一次会话 |
| `fine --resume <id>` | 恢复指定 id 的会话（用 `fine sessions` 查 id） |
| `fine -P <name>` / `--profile <name>` | 使用指定 profile（独立 config/sessions/anchors/skills/memory） |
| `fine sessions` | 列出最近的会话 |
| `fine profiles` | 列出所有已创建的 profile |
| `fine init` | 交互式配置向导；能联网时自动拉取 `/v1/models` 供你选择 |
| `fine doctor` | 诊断环境与配置（Node / 配置 / 网络 / API key / 模型） |
| `fine mcp-server` | 作为 MCP server 运行（供 Claude Desktop / IDE 等调用） |
| `fine config` | 打印当前 profile 的配置文件路径 |

## REPL 内斜杠命令

进入 REPL 后，输入 `/` 开头的命令可以不退出就操作：

| 命令 | 作用 |
|------|------|
| `/help` | 列出所有可用命令 |
| `/cost` | 显示当前会话的 token / 费用 |
| `/model <name>` | 热切换模型（不退出 REPL） |
| `/clear` | 开启全新会话（清空历史，配置保留） |
| `/compact` | 手动压缩历史（把老消息换成摘要） |
| `/sessions` | 列出最近的会话 |
| `/diff [pathFilter]` | 展示本次会话对文件的改动（基于 snapshot） |
| `/rewind` | 回滚本次会话中所有被 AI 改过的文件 |
| `/anchor <text>` | 钉一条"永不忘记"的指令（跨 compact 存活） |
| `/anchors` / `/unanchor <id\|all>` | 列出 / 删锚 |
| `/skill save [name]` | 让模型把当前会话精华固化成 SKILL.md |
| `/skill list` / `/skill delete <name>` | 管理 skills |
| `/remember` | 把本次会话抽取 key facts 写入长期记忆 |
| `/memory list` / `/memory recall` / `/memory forget <id\|all>` | 管理长期记忆 |
| `/mode [none\|ddd\|tdd\|sdd]` / `/ddd` `/tdd` `/sdd` | 切换 workflow 模式 |
| `/exit` | 退出 |

## Subagent 系统

让父 agent 通过 `spawn_agent` 工具把任务甩给子 agent——**子 agent 走完 loop、调自己的工具，只把结论回给父 agent**，保持父 agent 的 context 干净。

三种用法：

```bash
# 1. 零配置，模型自己决定什么时候 spawn
#    子 agent 默认只读（read_file / grep / glob / ls / todo_write）

# 2. 在 config.json 里定义预设
#    让不同子 agent 用不同模型、不同工具白名单
```

```json
{
  "subagents": {
    "research": {
      "model": "gpt-4o-mini",
      "systemPrompt": "You investigate code structure. Return a concise summary.",
      "allow": ["read_file", "grep", "glob", "ls"],
      "maxTurns": 15
    },
    "reviewer": {
      "model": "claude-sonnet-4-5",
      "systemPrompt": "You review code changes critically. Point out issues only.",
      "allow": ["read_file", "grep"]
    }
  }
}
```

之后模型就能写出 `spawn_agent(agent_type="research", prompt="...")` 调用。并发友好——多个 `spawn_agent` 调用会被分区并行跑。

嵌套深度限制为 3（防 loop 爆炸）；subagent 默认 **写权限=deny**（read-only 是安全线），想让子 agent 写文件，把 `bash` / `write_file` / `edit_file` 加到 `allow` 并加 `--bypass` 启动。

## Workflow 模式（DDD / TDD / SDD）

默认 fineCode 奉行 "harness > framework"，但有些人（包括我）喜欢给自己加硬约束。三种预设模式：

| 模式 | 约束 |
|------|------|
| `/ddd` | Domain-Driven Design：建模优先——在 `edit_file` 之前必须先确定 bounded context / entities / ubiquitous language |
| `/tdd` | Test-Driven Development：Red→Green→Refactor 强制，不先写失败测试就不能写生产代码 |
| `/sdd` | Spec-Driven Development：先写 spec（编号列表）+ plan（`todo_write`），用户批准后再动代码 |

切回默认 harness：`/mode none`。
模式会持久化到 session，`fine -c` 时自动恢复。

## 上下文锚（Anchors）

告诉 AI："不管你多久没跟我聊，这条永远记住。"

```
/anchor 这个项目用 pnpm，不要用 npm。
/anchor 测试文件放在 __tests__/，不要放在 src/ 同级。
/anchors                # 列出
/unanchor abc123        # 移除
/unanchor all           # 清空
```

**和 FINE.md 的区别**：FINE.md 是项目级规则（放在 repo 里 commit），anchors 是跨项目、跨会话的用户级 pinned context，存在 `~/.fineCode/anchors.json`，**auto-compact 永远不会吞掉它**。

## Skill 系统

AI 帮你做过一遍的事情，可以"固化"成复用的 SKILL.md：

```
❯ 帮我通过 rsync 部署到生产服务器
…（AI 完成一堆步骤）…

❯ /skill save
✓ Saved skill: deploy-via-rsync
  triggers: deploy, rsync, production
  file: ~/.fineCode/skills/deploy-via-rsync.md
```

下次你说"帮我 deploy 一下"时，**因为 trigger 匹配**，这条 skill 会自动被拼进 system prompt，AI 会按上次的步骤来。

- `/skill list` — 看所有 skill
- `/skill save [name]` — 蒸馏当前会话
- `/skill delete <name>` — 删一个
- Skill 文件是普通 Markdown，可以手动编辑或 commit 到项目 repo 里共享

和 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 的 skill 概念相似，格式简化。

## 长期记忆

`/remember` 把本次会话蒸馏成"我在这个项目里学到的事实"，存进 `~/.fineCode/memory.json`。下次你在**同一目录**打开 fineCode 时，recall 会自动匹配并注入到 system prompt 里：

```
❯ /remember
✓ Saved 4 fact(s) [a3f2c1]:
  • 这个项目用 pnpm 而不是 npm
  • 所有 API route 在 src/app/api/
  • 测试用 vitest，不是 jest
  • 已决定使用 Zod 做运行时校验
```

下次启动会看到：
```
# User context (recalled from past sessions in this directory)
...
```

设置 `config.json` 里 `"autoRemember": true` 可以在**退出时自动**触发一次（会加一次 API 调用，默认关闭）。

- `/memory list` — 看所有记忆条目
- `/memory recall` — 看当前目录会被 recall 的
- `/memory forget <id>` — 删一条，`/memory forget all` 清空

## Profile 多实例

想要"工作用 agent"和"副业用 agent"分开？用 profile：

```bash
fine --profile work           # 专用工作 profile
fine --profile side           # 副业
fine -P study --model gpt-4o  # 短参数也行

export FINE_PROFILE=work      # 一整个 shell 都走 work
fine                          # 自动用 work

fine profiles                 # 看所有 profile
```

每个 profile 独立：
- `~/.fineCode/profiles/<name>/config.json`（不同的 model / key）
- `~/.fineCode/profiles/<name>/sessions/`（对话历史分开）
- `~/.fineCode/profiles/<name>/anchors.json`（各自 pinned）
- `~/.fineCode/profiles/<name>/skills/`（各自的 skill 库）
- `~/.fineCode/profiles/<name>/memory.json`（各自的长期记忆）

不指定 `--profile` 就用默认 profile，路径是 `~/.fineCode/...`。

## 会话持久化 / Diff / Rewind

每次对话自动保存到 `~/.fineCode/sessions/<session-id>.jsonl`（append-only），
进程被 `Ctrl+C` 杀掉也不会丢。下次 `fine -c` 就能接着聊。

**文件改动全程留痕**：每次 AI 用 `write_file` / `edit_file` 改文件**之前**，原文件被备份到
`~/.fineCode/sessions/<session-id>.snapshots/`。然后：

- `/diff` — 显示本 session 每个被改文件的 unified diff（`+N -M` 行数汇总）
- `/diff src/config` — 按路径过滤
- `/rewind` — 一键还原本 session 所有被改过的文件到 session 开始前的状态

## 上下文窗口 & 双层压缩

状态栏实时显示：
```
deepseek-chat · 24.5k tokens (37% of 65.5k) · $0.024
```

两层压缩策略让对话可以"永远继续"：

**Layer 1 — Micro-compact**（每次工具调用都触发）
- 工具返回 > 8KB 时，在进 history **之前**自动 head+tail 截断
- 保留前 40 行 + 后 20 行 + 中间标记
- 不经过模型，零延迟零成本
- 大 grep / cat 大文件 / 长构建日志，一次能省 50-90% token

**Layer 2 — Auto-compact**（历史逼近窗口时触发）
- 用量 > 70% 窗口时自动触发
- 让同模型 summarize 老消息，保留最近 6 条 + 一条 summary
- 或手动 `/compact`

Anchors 始终在 system prompt 里，**不参与任一层压缩**。

## MCP 双向支持

### 作为 client —— 把外部 MCP server 的工具接进来

在 config.json 里声明：
```json
{
  "mcpServers": {
    "github":   { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "..." } },
    "postgres": { "command": "mcp-server-postgres", "args": ["postgresql://..."] }
  }
}
```

启动时自动连上，工具以 `<server>__<tool>` 形式暴露给模型（例如 `github__create_pr`）。

### 作为 server —— 把 fine 的工具给别的工具用

```bash
fine mcp-server
```

通过 stdio 暴露 8 个内置工具。在 Claude Desktop 的 `claude_desktop_config.json` 里：
```json
{
  "mcpServers": {
    "fine": { "command": "fine", "args": ["mcp-server"] }
  }
}
```
之后 Claude Desktop 就能直接调 fine 的 `read_file` / `bash` 等。

## 项目级 / 用户级指令（FINE.md）

在项目根目录或任一父目录放 `FINE.md`（或 `CLAUDE.md`），内容会自动拼到
system prompt 里：

```markdown
# FINE.md
- 这个项目用 pnpm，不要用 npm。
- 所有 API 路由放在 src/api/，组件放在 src/components/。
- 不要直接 commit 到 main 分支。
```

全局规则可以放 `~/.fineCode/FINE.md`。

## 并发工具执行

模型一次返回多个工具调用时，**只读工具（read_file / grep / glob / ls / todo_write / spawn_agent）会被自动并行化**，写操作保持串行。一次读 5 个文件的耗时从 5× 降到 ~1×。

## 错误诊断

fineCode 会把常见的 provider API 错误翻译成人话，直接告诉你下一步怎么办：

| 错误类型 | 触发条件 | 建议 |
|---------|---------|------|
| `auth` | 401、API key 无效 | 重新 `fine init` 或设置环境变量 |
| `model` | 400/404、模型名不存在 | 运行 `fine doctor` 看服务端支持的模型 |
| `rate_limit` | 429 | 稍等重试或换 preset |
| `quota` | 402、账户欠费 | 去服务商控制台充值 |
| `network` | 连接被拒 / DNS / 超时 | 检查网络 / VPN / `--base-url` |

如果 REPL 里显示红色 `Error: [4xx] ...` 下面跟着黄色的 `Hint: ...`，按提示操作即可。

## 更新提示

fineCode 每 24 小时在后台检查一次 npm 新版本，发现更新时会在启动时打印一行提示。可以通过以下方式禁用：

```bash
export NO_UPDATE_NOTIFIER=1   # 或在 CI 环境下自动禁用
```

## 交互体验

启动后进入 REPL：

```
harness · model: openai:gpt-4o · type your question, Ctrl+C to exit

❯ 给我写一个斐波那契函数，保存到 fib.py

⧖ write_file · write fib.py (142 bytes)
┌────────────────────────────────────────┐
│ Permission requested                   │
│                                        │
│ write_file · write fib.py (142 bytes)  │
│                                        │
│ [y] allow once   [a] always allow      │
│ this tool   [n] deny                   │
└────────────────────────────────────────┘
(按 y)

✓ write_file · write fib.py (142 bytes)
  Wrote 142 bytes to /Users/you/project/fib.py

已创建 fib.py。
```

## 架构

```
src/
├── cli.tsx                    入口：解析 CLI / 子命令 / 启动 REPL
├── commands/
│   └── init.ts                fine init 交互式向导
├── config/
│   └── Config.ts              ~/.fineCode/config.json 读写与优先级合并
├── utils/
│   └── updateCheck.ts         启动时后台检查 npm 新版本
├── core/
│   ├── types.ts               统一类型（OpenAI 风格为 canonical）
│   ├── Provider.ts            Provider 接口
│   └── Agent.ts               ★ 主循环（harness 核心）
├── providers/
│   ├── openai.ts              OpenAI / 兼容端点（用 openai SDK）
│   ├── anthropic.ts           Claude（原生 fetch + SSE）
│   └── factory.ts             自动选择 provider + preset
├── tools/
│   ├── BashTool.ts            shell 执行（带超时/中止）
│   ├── FileReadTool.ts        带行号的读文件
│   ├── FileEditTool.ts        精确编辑 + 全文写入
│   ├── SearchTools.ts         grep / glob / ls
│   └── TodoTool.ts            任务追踪
├── permission/
│   └── PermissionManager.ts   三态权限模型
├── context/
│   └── SystemPrompt.ts        动态环境提示（cwd / git / 文件列表）
└── ui/
    └── REPL.tsx               Ink TUI
```

### 设计决策

| 决策 | 做法 | 原因 |
|------|------|------|
| canonical 消息格式 | OpenAI 风格 | 兼容性最广 |
| Anthropic SDK | 不用，原生 fetch | 避免 SDK 锁定 |
| 工具 schema | JSON Schema | 所有模型都认 |
| Agent 循环 | 朴素 while loop | 隐式 Agent 哲学 |
| 并发工具执行 | 顺序执行 | 简单安全，未来可扩展 |
| 权限策略 | 工具自声明 | 只读工具 never 需要权限 |

## 用便宜模型最大化发挥（实战指南）

> **基准日期：2026-04-18**。对标 **Claude Opus 4.7**（Anthropic 于 2026-04-16 发布的当前旗舰，SWE-bench Verified **87.6%** / SWE-bench Pro **64.3%** / CursorBench **70%**，新增 `xhigh` effort 和自验证机制，$5 / $25 per M tokens）。国产开源主力迭代到 **Kimi K2.6 / GLM-5.1 / MiniMax M2.5 / DeepSeek V4 / Qwen3**。
>
> **谁该看这节**：想用国产模型或便宜模型省钱、但又不想放弃太多体验的个人/小团队开发者。下面这套做法**默认只用一个模型**（大部分人的真实用法），subagent 分级那套只作为可选进阶放在最后。

### 1. 选一个主力模型就够了

绝大多数人每天就开一个终端、配一个模型、开干。**不用折腾多模型编排**。2026-04 粗排：

| 你的场景 | 推荐 | 月度成本量级 | 接近 Opus 4.7 的程度 |
|---------|------|-------------|---------------------|
| 就想省钱，日常搬砖、改 bug、写小工具 | **Kimi K2.6** | $5-20 | ~55% 裸用，叠完下面做法能到 **~85%** |
| 个人项目偶尔吃点硬任务，想平衡 | **Claude Sonnet 4.5** | $30-80 | **~90%**（性价比甜点）|
| 吃饭的硬核工作，不能掉链子 | **Claude Opus 4.7 xhigh** | $200+ | 100%（基准）|
| 全程本地、隐私场景 | **Qwen3-Coder** (Ollama) | $0 | ~40% |
| 纯中文需求沟通 / 写注释写文档 | 任何国产模型 | — | 这个场景国产能反超 |

> 选 Kimi K2.6 的人最多（fineCode 用户画像偏省钱）。下面做法都按"主力 Kimi K2.6"来写，**其他模型同理**。

### 2. 第一件事：写 `FINE.md`

Opus 4.7 对隐式约定的推理能力已经很强（它能自己猜出你用 pnpm），国产模型需要你**写明白**。花 5 分钟写 30 行，之后每次对话都省心：

```markdown
# FINE.md
## 项目约定
- 包管理器：pnpm。**禁止**用 npm / yarn。
- 测试框架：vitest（非 jest）。测试文件放在源文件同级 `__tests__/`。
- 所有 API 路由：src/app/api/[...]/route.ts
- 运行时校验：Zod。禁止手写 `typeof` 校验。

## 禁止事项
- 不要自己跑 `git commit` / `git push`。
- 不要编辑 `*.generated.ts`。
- 改 schema 时必须同步更新 migrations/。

## 代码风格
- 函数优先 async/await，避免 .then 链。
- 错误处理：抛自定义 Error 子类，不抛字符串。
```

国产模型遵从**显式硬约束**的能力其实不弱，比让它"自己判断"稳得多。**这一步投入产出比最高。**

### 3. 遇到 debug / 不确定的事，打开 `/tdd`

Opus 4.7 有内置的 self-verification（返回前自检），**国产模型没这机制**，最容易出的毛病是：**写完不自测，自信地说"已完成"但其实没跑通**。

```
/tdd              # 进 TDD 模式
（让它干活）
/mode none        # 写完切回默认，继续日常用
```

TDD 模式下模型必须先写失败测试、跑通实现、再报告完成。在"不知道 bug 在哪"这类场景里，这一个开关能把国产模型的效果从 30 分拉到 55 分——**它其实不是"不会"，而是"不会主动验证"**，TDD 强制把这一步补上。

### 4. 跨文件任务：开头就用 `/anchor` 钉死关键约束

国产模型在 20 轮对话之后容易忘掉最初的要求（Opus 4.7 能扛到 80+ 轮）。**真正的陷阱是它不会告诉你它忘了，还在一本正经地改错**。第一轮就钉死：

```
/anchor 本次重构：只改 src/api/ 下的文件，测试先不动。
/anchor 所有新增 handler 必须用 asyncHandler 包一层。
/anchor 最后给我一个 changelog，列出每个被改的 endpoint。
```

Anchors 永远在 system prompt 里，**auto-compact 也吞不掉**。这一步能把国产模型的"长会话跑偏率"从 40% 压到 10% 以下。

### 5. 对话卫生：勤 `/clear`，别迷信长上下文

国产模型在 30+ 轮之后衰减比 Opus 4.7 明显得多。一个任务做完就：

```
/remember      # （可选）存下这个项目学到的事实到长期记忆
/clear         # 开新会话。历史清空，但 FINE.md / memory / anchors / skills 都还在
```

**Kimi 的 256K 是应急用的，不是给你天天填满的。** 比硬扛超长上下文效果好太多。

### 6. 让模型"越用越懂你"：`/remember` 和 `/skill save`

做完一个有代表性的任务后（比如第一次成功部署、第一次跑通某个脚本），花 5 秒：

```
/skill save            # 把做法固化成 SKILL.md，下次触发词命中时自动注入
/remember              # 把项目的关键事实存进长期记忆
```

下次你在同一目录打开 fineCode，长期记忆会自动注入；说"帮我部署"时命中的 skill 也会自动拼进 system prompt。**本质是在手动给国产模型补齐它缺失的"项目直觉"**——Opus 4.7 能自己从对话历史里推断出这些，国产模型记性没那么好。

### 7. 关键节点花 5 秒人工 review

这是用便宜模型省下的钱应该**花回去**的地方——把心态从"全自动"调成"结对编程"：

- 模型说"已完成"时：先 `/diff` 看一眼改了啥，再决定要不要放行
- 重构跨 5 个以上文件：**别一次性让它干完**，拆成几个短会话，每个 review 完再进下一个
- 测试通过时：自己心里默念一句"真的吗"，让它 `bash npm test` 再跑一次

这一项大概能加 10-15 分，也是整套打法里最反直觉但最有效的。

### 效果对照表（主力 Kimi K2.6，基准 Opus 4.7 xhigh = 100）

| 做法 | 增量 | 累计分数 | 额外成本 |
|------|------|---------|---------|
| 裸用 Kimi K2.6，什么都不配 | 起点 | **55** | — |
| + FINE.md | +8 | 63 | 0（一次性 5 分钟）|
| + 遇 debug 开 `/tdd` | +8 | 71 | 0 |
| + 跨文件任务钉 anchors | +5 | 76 | 0 |
| + 对话卫生（勤 `/clear`）| +3 | 79 | 0（反而更省 token）|
| + `/remember` + skills 长期积累 | +3 | 82 | 0 |
| + 关键节点人工 review | +3 | **85** | 你自己的时间 |

叠满大致能到 **Opus 4.7 的 85% 体验，综合成本 ~5%**。对个人项目和大多数小团队场景，**这是 2026 年春天最划算的配置**——**什么多模型编排都不用搞，一个 Kimi 开到底**。

如果碰到啃不动的硬骨头（疑难 debug、跨 10+ 文件的复杂重构、深层架构决策），**老老实实临时切 Opus 4.7**：

```
/model claude-opus-4-7
（让它干完）
/model kimi-k2-thinking   # 干完切回来
```

**fineCode 是 provider-agnostic 的，一条命令切回去，这是它相对单一厂商 CLI 最大的优势。** 不用为了省那点钱在硬任务上耗一整天。

---

### 进阶：多模型 subagent 分级（可选，多数人不需要）

> **警告**：这节是给已经把上面单模型全套跑熟、还想继续压最后一点成本或体验的人看的。**大部分开发者不会走到这一步**——单模型 85 分已经够用了。

fineCode 的 `spawn_agent` 工具支持父 agent 在任务中途把子任务甩给**另一个模型**——子 agent 走完自己的 loop、只把结论回给父 agent。典型分工：

- **主 agent（Kimi K2.6）** 负责规划和编码
- **research subagent（DeepSeek V4）** 干脏活：grep 一堆文件、读代码、总结
- **reviewer subagent（GLM-5.1）** 最后交叉 review 一遍
- **hard-debug subagent（Opus 4.7）** 只在主 agent 卡住时才出手，硬骨头兜底

```json
{
  "model": "kimi-k2-thinking",
  "subagents": {
    "research": {
      "model": "deepseek-chat",
      "systemPrompt": "You investigate code structure. Read files, grep, summarize. Return concise findings with file:line anchors.",
      "allow": ["read_file", "grep", "glob", "ls"],
      "maxTurns": 20
    },
    "reviewer": {
      "model": "glm-5.1",
      "systemPrompt": "You review code changes critically. Point out issues only, no praise.",
      "allow": ["read_file", "grep"],
      "maxTurns": 10
    },
    "hard-debug": {
      "model": "claude-opus-4-7",
      "systemPrompt": "You debug tough, multi-layer bugs. Verify hypotheses with reproductions.",
      "allow": ["read_file", "grep", "glob", "bash", "edit_file"],
      "maxTurns": 40
    }
  }
}
```

**收益**：硬骨头任务自动有 Opus 兜底（不用手动切），研究类脏活用最便宜的 DeepSeek 跑，综合大概比单模型再省 20-30% token。

**成本**：要花时间调每个 subagent 的 system prompt，观察它们什么时候会被主 agent 触发；碰到 subagent 结论不靠谱时还得回来 debug。**前期维护成本相当可观。**

> 老实说：我（作者）自己 90% 时间都是单模型裸开 Kimi。subagent 分级是给那种"每天十几个会话、要跑一整天任务"的重度用户准备的。如果你一天只开 1-3 个会话，单模型就够了。

---

## 对比 Claude Code

Claude Code 的源码有 **~40 万行 TypeScript**；harness 只有 **~1200 行**。保留了核心骨架，去掉了所有 Anthropic 独有特性（thinking、fast mode、effort、context management、1M context、task budgets、afk mode 等 15+ 个 beta features），换来了**多模型支持**。

如果你想扩展更多高级特性（如自动压缩、agent 编排、sandbox、hooks），推荐参考 Claude Code 源码中的 `services/compact/`、`services/tools/`、`cli/` 等模块。

## 扩展

### 添加新工具

在 `src/tools/` 下创建文件，实现 `ToolDefinition` 接口：

```ts
export const MyTool: ToolDefinition<MyInput> = {
  name: 'my_tool',
  description: '...',
  parameters: { /* JSON Schema */ },
  needsPermission: 'always', // or 'never'
  renderCall: input => `my_tool ${input.x}`,
  execute: async (input, ctx) => ({ content: '...' }),
};
```

然后在 `src/tools/index.ts` 里加到 `DEFAULT_TOOLS`。

### 添加新 Provider

实现 `Provider` 接口并在 `providers/factory.ts` 里注册。例如 Gemini：

```ts
class GeminiProvider implements Provider {
  async *stream(options): AsyncGenerator<StreamEvent> {
    // 将 Message[] 转成 Gemini 格式，调 API，把响应转成 StreamEvent
  }
}
```

## License

MIT
