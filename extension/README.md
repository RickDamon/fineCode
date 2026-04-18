# fineCode for VS Code

A model-agnostic coding agent, right in your VS Code sidebar. Bring your own key.

> **What it is**: the same harness-based agent from the [fineCode CLI](https://github.com/RickDamon/fineCode), wrapped in a native VS Code Webview sidebar view. Same core (Agent / Session / Permission), same `~/.fineCode/config.json`, same model support (OpenAI, Anthropic Claude 4.7, DeepSeek, Kimi K2.6, GLM-5.1, MiniMax M2.5, Ollama, ...).

## Install

### Option 1 — from the packaged `.vsix` (quickest, before Marketplace)

```bash
cd extension
npm install
npm run build
npm run package         # produces fine-code.vsix
code --install-extension fine-code.vsix
```

### Option 2 — run it in dev from this repo

Open the fineCode workspace in VS Code, press **F5**. A second VS Code window (“Extension Development Host”) opens with the extension loaded.

## First-time setup

The extension shares `~/.fineCode/config.json` with the CLI. Easiest way:

```bash
# If you already have the CLI installed:
fine init
```

Or configure directly via VS Code Settings (`Cmd+,`) — search **fineCode**:

| Setting | Notes |
|---|---|
| `fineCode.model` | e.g. `kimi-k2.5` / `claude-opus-4-7` / `deepseek-chat` |
| `fineCode.preset` | `moonshot` / `zhipu` / `minimax` / `deepseek` / ... |
| `fineCode.apiKey` | ⚠️ Stored in plain `settings.json`. Prefer the config file or env vars. |
| `fineCode.baseUrl` | For self-hosted or Azure endpoints |
| `fineCode.bypassPermissions` | Auto-approve all tool calls (yolo) |

**Preference order** (highest wins): VS Code settings → env vars → `~/.fineCode/config.json`.

## Usage

1. Click the fineCode icon in the Activity Bar (left sidebar).
2. Type a question. Press **Enter** to send, **Shift+Enter** for newline.
3. When the agent wants to run `bash` or write a file, a permission dialog appears inline — pick **Allow once** / **Always allow** / **Deny**.

### Slash commands

Type these in the chat input (like the CLI):

- `/help` — list commands
- `/clear` — new session (old one is still preserved on disk)
- `/model <name>` — hot-switch the model
- `/cost` — current session's tokens / cost
- `/compact` — summarize old history to free up context
- `/sessions` — list recent sessions
- `/diff [path-filter]` — show what the agent changed this session
- `/rewind` — (planned) revert all AI-made file changes this session

### Keyboard shortcuts

- **Enter** — send
- **Shift+Enter** — newline
- **Esc** (while running) — stop the current turn

## What's supported

| Feature | CLI | Extension |
|---|---|---|
| Chat + tool calls | ✓ | ✓ |
| Permission dialog | ✓ (TUI) | ✓ (inline webview) |
| Session persistence (`~/.fineCode/sessions/`) | ✓ | ✓ (shared) |
| Token / cost tracking | ✓ | ✓ |
| Streaming assistant text | ✓ | ✓ |
| Concurrent read-only tools | ✓ | ✓ |
| Sub-agents (`spawn_agent`) | ✓ | ✓ (events shown inline) |
| FINE.md / anchors / skills / memory | ✓ | ✓ |
| Slash commands | ✓ (full) | ✓ (help/clear/model/cost/compact/sessions/diff) |
| Workflow modes (DDD/TDD/SDD) | ✓ | Planned |
| MCP client | ✓ | Planned |
| MCP server | ✓ | n/a |

## How it's wired

```
┌─────────────────────────── VS Code window ───────────────────────────┐
│                                                                       │
│   Activity Bar                    Sidebar (Webview)                   │
│   [ fineCode ]                    ┌──────────────────────────────┐   │
│                                   │   <Header model + cost>      │   │
│                                   │                              │   │
│                                   │   ▸ user / assistant bubbles │   │
│                                   │   ▸ tool calls               │   │
│                                   │   ▸ inline permission dialog │   │
│                                   │                              │   │
│                                   │   [ textarea + Send/Stop ]   │   │
│                                   └────────────▲─────────────────┘   │
│                                                │ postMessage          │
│  Extension Host (Node)                         │                      │
│  ┌─────────────────────────────────────────────▼──────────────┐     │
│  │  AgentBridge                                               │     │
│  │    ├─ createProvider(...)       ← src/providers/           │     │
│  │    ├─ new Agent(...)            ← src/core/Agent           │     │
│  │    ├─ new Session(...)          ← src/session/Session      │     │
│  │    └─ agent.run()  → AgentEvent → postMessage              │     │
│  └────────────────────────────────────────────────────────────┘     │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘

     External: provider APIs (OpenAI / Anthropic / Moonshot / ...)
```

- Core fineCode (`../src/**`) is **zero-modified** — the extension bundles it via esbuild.
- Every `AgentEvent` is translated 1:1 to a `postMessage` the webview can render.
- The permission prompt is a Promise on the host side that resolves when the webview sends a `permission_response`.

## Known limitations (v1)

- No native VS Code diff editor integration — `/diff` outputs unified-diff text for now.
- MCP servers from `config.json` are not auto-connected (they are by the CLI).
- No workflow-mode UI yet; still works by editing session meta externally.
- `/rewind` not yet wired.

All of these are additive — the core hooks are in place, just not plugged in.

## Development

```bash
cd extension
npm install
npm run watch         # rebuilds on change; reload the Extension Host window with Cmd+R
```

Logs: **View → Output → fineCode**.

## License

MIT
