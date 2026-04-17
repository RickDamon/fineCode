# fineCode

> a code tool designed by harness

一个极简的、模型无关的命令行编码代理 (coding agent)，继承自 Claude Code 的 **"harness 即一切"** 设计哲学。

> **核心思想**：不用复杂的 DAG/Chain 编排 LLM，只给模型一组丰富的工具、清晰的上下文、安全的权限模型，然后让模型自己决定怎么做。

## 特性

- 🔌 **任意模型** — 一个命令切换：OpenAI / Anthropic / DeepSeek / Moonshot / OpenRouter / Groq / Ollama / vLLM / 任何 OpenAI 兼容端点
- 🛡️ **三态权限模型** — allow / allow-always / deny，危险操作必须用户确认
- 🔧 **8 个核心工具** — bash / read_file / edit_file / write_file / grep / glob / ls / todo_write
- 🌊 **流式输出** — 边生成边显示，Ctrl+C 可随时打断
- 🧠 **隐式 Agent** — 没有预定义工作流，完全由模型驱动
- 📦 **无 Anthropic/OpenAI SDK 锁定** — Anthropic provider 用原生 fetch 实现

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
| `/rewind` | 回滚本次会话中所有被 AI 改过的文件 |
| `/exit` | 退出 |

## 会话持久化

每次对话自动保存到 `~/.fineCode/sessions/<session-id>.jsonl`（append-only），
进程被 `Ctrl+C` 杀掉也不会丢。下次 `fine -c` 就能接着聊。

快照：每次 AI 要用 `write_file` / `edit_file` 改文件**之前**，原文件会被备份到
`~/.fineCode/sessions/<session-id>.snapshots/`。后悔了就 `/rewind` 一键还原。

## 上下文窗口

状态栏实时显示：
```
deepseek-chat · 24.5k tokens (37% of 65.5k) · $0.024
```

接近窗口上限（> 70%）时 fineCode 会**自动压缩**历史：让同一个模型 summarize
老消息，保留最近 6 条原样。触发时你会看到：
```
Auto-compacted 18 messages (approaching context window).
```

也可以随时手动 `/compact`。

## 项目级 / 用户级指令（FINE.md）

在项目根目录或任一父目录放 `FINE.md`（或 `CLAUDE.md`），内容会自动拼到
system prompt 里。用于记住项目约定：

```markdown
# FINE.md
- 这个项目用 pnpm，不要用 npm。
- 所有 API 路由放在 src/api/，组件放在 src/components/。
- 不要直接 commit 到 main 分支。
```

全局规则可以放 `~/.fineCode/FINE.md`。

## 并发工具执行

模型一次返回多个工具调用时，**只读工具（read_file / grep / glob / ls / todo_write）
会被自动并行化**，写操作保持串行。一次读 5 个文件的耗时从 5× 降到 ~1×。

## MCP (Model Context Protocol) 扩展

在配置文件里声明 MCP server，启动时会自动连接并把它们的 tools 注册进来：

```json
{
  "model": "deepseek-chat",
  "preset": "deepseek",
  "apiKey": "sk-...",
  "mcpServers": {
    "github":   { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "..." } },
    "postgres": { "command": "mcp-server-postgres", "args": ["postgresql://..."] }
  }
}
```

MCP 工具在 REPL 中以 `<server>__<tool>` 形式出现（例如 `github__create_pr`），
因为可能有副作用，默认都需要用户授权。

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
