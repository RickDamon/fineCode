# fineCode

> 一个留在你终端里的编程 agent，换任何模型都能用，记得住每次你让它做过什么。

一个极简的、模型无关的命令行编码代理 (coding agent)，继承自 Claude Code 的 **"harness 即一切"** 设计哲学。

> **核心思想**：不用复杂的 DAG/Chain 编排 LLM，只给模型一组丰富的工具、清晰的上下文、安全的权限模型，然后让模型自己决定怎么做。

## 特性

### 骨架
- 🔌 **任意模型** — 一条命令切换：OpenAI / Anthropic / DeepSeek / Moonshot / OpenRouter / Groq / Ollama / 任何 OpenAI 兼容端点
- 🛡️ **三态权限模型** — allow / allow-always / deny；危险操作必须用户确认
- 🔧 **8 个核心工具** — bash / read_file / edit_file / write_file / grep / glob / ls / todo_write
- 🧠 **隐式 Agent** — 没有预定义工作流，完全由模型驱动
- 📦 **无 SDK 锁定** — Anthropic provider 用原生 fetch 实现

### 长期使用
- 💾 **会话持久化** — `fine -c` 接着上次聊，`/rewind` 回滚 AI 改过的文件
- 💰 **Token & 成本追踪** — 状态栏实时显示 `24.5k tokens (37%) · $0.024`
- 📎 **上下文锚** — `/anchor` 钉住"别忘了"的指令，跨 compact 永不丢
- 🗜️ **两层压缩** — 大工具结果自动 micro-compact；历史逼近窗口自动 summarize

### 多模型协作
- 🤖 **Subagent 系统** — 让父 agent 调 `spawn_agent` 起子 agent 干脏活：research 用便宜模型、edit 用强模型、review 用第三个模型
- ⚡ **并发工具** — 只读工具自动并行（一次读 5 个文件 ~ 1× 时间）

### 扩展
- 🔌 **MCP 双向** — 作为 **client** 接外部 MCP server（GitHub/Postgres/…），也能作为 **server** 让 Claude Desktop 调用 fine 的工具
- 🎯 **Workflow 模式** — `/DDD` `/TDD` `/SDD` 三种强约束开发方式供自我约束的人用

### 上下文
- 📜 **FINE.md 规则** — 项目/全局 FINE.md 自动拼入 system prompt
- 🩺 **fine doctor** — 一键诊断：Node / config / 网络 / API key / 模型名是否有效
- ⚠️ **友好错误** — 把 `400 Model Not Exist` 翻译成"跑 fine doctor 看可用模型"

## 安装

```bash
# 全局安装（推荐）
npm install -g fine-code

# 或者本地开发
git clone <repo>
cd fineCode
npm install
npm run build
```

> 要求 Node.js >= 18。

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
2. **环境变量** — `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `DEEPSEEK_API_KEY` / `MOONSHOT_API_KEY` / `OPENROUTER_API_KEY` / `GROQ_API_KEY` / `TOGETHER_API_KEY`
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

# Claude
fine --model claude-sonnet-4-5-20250929 --api-key sk-ant-xxx

# DeepSeek
fine --model deepseek-chat --preset deepseek --api-key xxx

# Ollama 本地模型（无需 key）
fine --model qwen2.5-coder:7b --preset ollama

# OpenRouter
fine --model anthropic/claude-sonnet-4 --preset openrouter --api-key sk-or-xxx
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
| `fine sessions` | 列出最近的会话 |
| `fine init` | 交互式配置向导；能联网时自动拉取 `/v1/models` 供你选择 |
| `fine doctor` | 诊断环境与配置（Node / 配置 / 网络 / API key / 模型） |
| `fine mcp-server` | 作为 MCP server 运行（供 Claude Desktop / IDE 等调用） |
| `fine config` | 打印配置文件路径 |

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
| `/anchors` | 列出当前锚 |
| `/unanchor <id>` / `/unanchor all` | 移除锚 |
| `/mode [none\|ddd\|tdd\|sdd]` | 切换 workflow 模式 |
| `/ddd` `/tdd` `/sdd` | 模式快捷键 |
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
