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
cd harness
npm install
```

## 使用

### 最简启动

```bash
# OpenAI
npx tsx src/cli.tsx --model gpt-4o --api-key sk-xxx

# Claude
npx tsx src/cli.tsx --model claude-sonnet-4-5-20250929 --api-key sk-ant-xxx

# DeepSeek
npx tsx src/cli.tsx --model deepseek-chat --preset deepseek --api-key xxx

# Ollama 本地模型（无需 key）
npx tsx src/cli.tsx --model qwen2.5-coder:7b --preset ollama

# OpenRouter
npx tsx src/cli.tsx --model anthropic/claude-sonnet-4 --preset openrouter --api-key sk-or-xxx
```

### 使用环境变量

```bash
export OPENAI_API_KEY=sk-xxx
npx tsx src/cli.tsx -m gpt-4o

export ANTHROPIC_API_KEY=sk-ant-xxx
npx tsx src/cli.tsx -m claude-sonnet-4-5-20250929

export DEEPSEEK_API_KEY=xxx
npx tsx src/cli.tsx -m deepseek-chat -p deepseek
```

### 自定义端点

```bash
# 自建的 OpenAI 兼容服务
npx tsx src/cli.tsx -m my-model -u http://localhost:8000/v1 -k any-key

# Azure OpenAI
npx tsx src/cli.tsx -m gpt-4 -u https://my-resource.openai.azure.com/openai/deployments/my-deployment -k key
```

### 危险模式（跳过所有权限）

```bash
npx tsx src/cli.tsx -m gpt-4o --bypass
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
├── cli.tsx                    入口：解析 --model / --api-key
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
