# pi-local

A Pi extension for configuring and switching between multiple local LLM inference engine connections.

## Features

- **Multiple connections** — configure several local inference servers (LM Studio, oMLX, llama.cpp, etc.) and switch between them
- **Auto-detection** — queries connected endpoints for available models with rich metadata (size, context window, type)
- **Model loading** — load/unload models on servers that support it (oMLX, LM Studio)
- **Persistence** — your default provider and model are restored automatically on Pi restart
- **macOS keychain** — offers to store API keys in the macOS keychain via `security` commands
- **Reasoning support** — forwards pi's thinking levels as `reasoning_effort`, using each server's advertised vocabulary where available

## Supported backends

| Backend | Detection | Load/Unload |
|---------|-----------|-------------|
| oMLX | `/v1/models/status` + `/api/status` | Yes |
| LM Studio | `/api/v1/models` | Yes |
| OpenAI-compatible | `/v1/models` | No |

The extension tries oMLX first, then LM Studio, then falls back to OpenAI-compatible.

## Reasoning levels

Thinking levels (`/thinking`) are forwarded as the OpenAI-style `reasoning_effort`
field on `/v1/chat/completions`. What each backend advertises decides which
levels you get:

| Backend | Levels | Wire format |
|---------|--------|-------------|
| oMLX | whatever `/v1/models/status` advertises (`reasoning_effort_options`) | `reasoning_effort`, `enable_thinking` fallback |
| OpenAI-compatible (llama.cpp, vLLM, ...) | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` | `reasoning_effort` passed through |
| LM Studio | pi default (`off` … `high`) | `reasoning_effort` |

For servers we cannot identify (llama.cpp, including `llama-server`), the level is
sent verbatim and `off` is sent as `reasoning_effort: "none"` — llama.cpp
treats `"none"` as "don't think" (`enable_thinking = false`) rather than
forwarding it to the chat template. Levels only take effect if the model's chat
template reads `reasoning_effort`; llama.cpp ignores it otherwise. The server
must not be started with `--reasoning off` (default `auto` is fine), and
`--reasoning-effort` on the command line only sets the default that a request
can override.

## Commands

### `/local-endpoints`

Add or remove connections. Each connection is identified by its base URL.

```
Manage Connections
> Remove: http://127.0.0.1:1234
  Add new connection
  Done
```

On macOS, if you enter a direct API key, you have the option to store it in the keychain. The key is then referenced via a `!security` command.

### `/local-model`

Select a connection and model. Shows server stats (for oMLX), model size, context window, and model type.

## Installation

You can either install this directly with the pi command via npm:

```bash
pi install npm:@monroewilliams/pi-local
```

or check out this repository and add the extension to your Pi configuration in `~/.pi/agent/settings.json` (useful if you want to modify it to better suit your purposes):

```json
{
  "extensions": [
    "/path/to/pi-local"
  ]
}
```

Then reload Pi (`/reload`) and run `/local-login` to add your first connection.

## API key formats

The API key field accepts all Pi auth key formats:

| Format | Example | Description |
|--------|---------|-------------|
| Direct key | `sk-1234567890abcdef` | Stored as-is |
| Environment variable | `$MY_API_KEY` or `${MY_API_KEY}` | Resolved via `resolveConfigValue` |
| Shell command | `!security find-generic-password -s 'pi-local' -a 'http://...' -w` | Shell execution, stdout used |
| Empty | _(leave blank)_ | No authentication |

On macOS, direct keys are optionally stored on the keychain.

## Storage

- **Connections** — stored in `~/.pi/agent/auth.json` keyed by base URL
- **Default provider/model** — stored in `~/.pi/agent/settings.json` (`defaultProvider` / `defaultModel`)
- **Model metadata** — cached alongside the connection in auth.json (contextWindow, maxTokens, reasoning)

## Development

```bash
npm install
npm run typecheck    # TypeScript check
npm run check        # Biome + TypeScript + tests
npm run format       # Auto-format
```

## License

MIT
