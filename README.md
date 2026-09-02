# pi-local

A Pi extension for configuring and switching between multiple local LLM inference engine connections.

## Features

- **Multiple connections** — configure several local inference servers (LM Studio, oMLX, llama.cpp, llama-swap, etc.) and switch between them
- **Auto-detection** — queries each endpoint for its models and shows whatever that server advertises: display name, size, context window, model type, and which models are loaded right now
- **Model loading** — load/unload models on servers that support it (oMLX, LM Studio, llama-swap)
- **Persistence** — your default provider and model are restored automatically on Pi restart
- **macOS keychain** — offers to store API keys in the macOS keychain via `security` commands
- **Reasoning support** — forwards pi's thinking levels as `reasoning_effort`, using each server's advertised vocabulary where available

## Supported backends

| Backend | Detection | Load/Unload | Metadata read |
|---------|-----------|-------------|---------------|
| oMLX | `/v1/models/status` + `/api/status` | Yes | alias, size, context window, max tokens, model type, reasoning vocabulary, pinned/favorite |
| LM Studio | `/api/v1/models` | Yes | display name, size, context window, quantization, publisher, format, architecture, reasoning |
| llama-swap | `/v1/models`, recognised by `owned_by` | Yes | display name, context window, load state, vision |
| OpenAI-compatible | `/v1/models` | No | context window and size (llama.cpp), context window inherited by LoRA adapters (vLLM) |

The extension tries oMLX first, then LM Studio, then falls back to the generic
OpenAI listing. llama-swap answers that generic listing, so it is identified from
the response itself — every card it serves carries `owned_by: "llama-swap"` — and
that is what earns it load/unload, which the generic tier has nothing to call.

Servers disagree about where the same quantity lives, so each is read where it is
actually advertised: llama.cpp nests `meta.n_ctx` and `meta.size`, vLLM puts
`max_model_len` flat on the card (LoRA adapters inherit their base model's through
`parent`), and llama-swap mirrors the operator's `capabilities.context` into
`meta.n_ctx` alongside `name`, `status.value` and `capabilities`.

### Load and unload

Each server is asked its own way:

| Backend | Load | Unload |
|---------|------|--------|
| oMLX | `POST /admin/api/models/{id}/load` | admin session + `POST .../unload` |
| LM Studio | `POST /api/v1/models/load` | `POST /api/v1/models/unload` |
| llama-swap | `GET /props?model={id}` | `POST /api/models/unload/{id}` |

llama-swap has no load endpoint: dispatching a request at a model is what swaps its
server in. `/props?model=` is the cheapest route that dispatches — a GET for
properties, so no tokens are generated, and the process is up and health-checked when
it returns. Two quirks of doing it that way, both confirmed against a live server:

- `/props` is a llama.cpp route, so an upstream that is not llama.cpp answers 404.
  The model is loaded by then — the load is a side effect of dispatching, not of the
  upstream answering — so that 404 is not reported as a failure. llama-swap's own
  rejections are, and they are recognisable by their `{"src":"llama-swap",...}`
  envelope.
- Unload answers `OK` as plain text, not JSON, so nothing there parses a body.

llama-swap may swap out one model to load another; the picker does not model that,
it re-queries after every action and shows what is actually running.

## Reasoning levels

Thinking levels (`/thinking`) are forwarded as the OpenAI-style `reasoning_effort`
field on `/v1/chat/completions`. What each backend advertises decides which
levels you get:

| Backend | Levels | Wire format |
|---------|--------|-------------|
| oMLX | whatever `/v1/models/status` advertises (`reasoning_effort_options`) | `reasoning_effort`, `enable_thinking` fallback |
| llama-swap | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` | `reasoning_effort` forwarded untouched |
| OpenAI-compatible (llama.cpp, vLLM, ...) | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` | `reasoning_effort` passed through |
| LM Studio | pi default (`off` … `high`) | `reasoning_effort` |

llama-swap is treated like llama.cpp because it behaves like llama.cpp: it forwards
the request body untouched — `reasoning_effort` and `chat_template_kwargs` included,
confirmed by reading the forwarded request back out of its own capture endpoint — and
resolves the model name internally without changing what the upstream sees. (It rewrites
`model` only when the operator sets `useModelName` or a filter.) So thinking levels do
exactly what the engine behind it does, and everything below about llama.cpp applies to
llama-swap-fronting-llama.cpp. One llama-swap-specific thing to be aware of:
`sendLoadingState: true` (default `false`) makes it inject its own loading progress
into the `reasoning` field of a stream, so a thinking block can carry text that did not
come from the model.

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

Select a connection and model. Shows server stats where the server reports them
(oMLX: version, loaded/loading counts, memory headroom) and, per model, its
name, size, context window, model type and whether it is loaded.

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
- **Model metadata** — cached alongside the connection in auth.json (display name, contextWindow, maxTokens, reasoning, reasoningEffortOptions, modelType, pinned, favorite) so the picker has something to show before the first live query

## Development

```bash
npm install
npm run typecheck    # TypeScript check
npm run check        # Biome + TypeScript + tests
npm run format       # Auto-format
```

## License

MIT
