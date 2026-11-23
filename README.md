# claudeproxy

Local proxy translating Anthropic Messages API ↔ OpenAI chat for LM Studio.

> **Retired.** claudeproxy was an early bridge for running Claude Code against local models, from before the local servers supported it themselves. Both targets now do it natively, with tool use, which this proxy never passed through:
>
> - **LM Studio 0.4.1+** (January 2026): point `ANTHROPIC_BASE_URL` at the LM Studio server. See LM Studio's [Claude Code guide](https://lmstudio.ai/docs/integrations/claude-code).
> - **Ollama 0.14.0+** (January 2026): set `ANTHROPIC_BASE_URL=http://localhost:11434`, or run `ollama launch claude`. See Ollama's [Claude Code guide](https://docs.ollama.com/integrations/claude-code).
>
> The code is kept for reference, as a compact example of mapping the Anthropic Messages API to OpenAI chat completions, including streaming (#9).

A lightweight local proxy that lets Claude Code (or any Anthropic API client) run against a local model served by [LM Studio](https://lmstudio.ai) on a MacBook. It also works with [Ollama](https://ollama.com), which serves the same OpenAI-compatible endpoint (`LM_STUDIO_URL=http://localhost:11434`).

Claude sends and receives the Anthropic message format. LM Studio speaks the OpenAI chat completions format. This proxy sits between them and translates both directions — including streaming SSE.

```
Claude Code  →  claudeproxy :8082  →  LM Studio :1234
             (Anthropic format)       (OpenAI format)
```

A request in Anthropic format, and what comes back:

```console
$ curl -s localhost:8082/v1/messages -H 'content-type: application/json' \
    -d '{"model":"devstral-small-2","max_tokens":256,"system":"Be brief.",
         "messages":[{"role":"user","content":"Say hello"}]}'
{"id":"chatcmpl-1","type":"message","role":"assistant",
 "content":[{"type":"text","text":"Hello! How can I help?"}],
 "model":"devstral-small-2","stop_reason":"end_turn","stop_sequence":null,
 "usage":{"input_tokens":18,"output_tokens":7}}
```

LM Studio received the OpenAI form:

```json
{"model":"devstral-small-2","messages":[{"role":"system","content":"Be brief."},{"role":"user","content":"Say hello"}],"stream":false,"max_tokens":256}
```

## What gets translated

| | Anthropic | OpenAI |
|---|---|---|
| System prompt | Top-level `system` field | `{role: "system"}` message |
| Content | `[{type: "text", text}]` blocks | Plain string |
| Stop reason | `end_turn` | `stop` |
| Token counts | `input_tokens / output_tokens` | `prompt_tokens / completion_tokens` |
| Streaming | Named SSE events (`message_start`, `content_block_delta`, etc.) | `data:` chunks with `delta.content` |
| Sampling | `max_tokens`, `temperature`, `top_p` | Same names |

### Limits

- **No tool calling.** The `tools` array isn't forwarded, so the model can't call tools. Earlier `tool_use` and `tool_result` blocks in the conversation are flattened into plain text (`[Tool call: name]`, `[Tool result]`) so the history still reads correctly.
- **Text only.** Image and other non-text content blocks are dropped.
- Only `POST /v1/messages` and `GET /health` are served. Anything else gets a 404 and is logged as a warning.

## Requirements

- Node.js 20+
- [LM Studio](https://lmstudio.ai) running locally with a model loaded and the local server enabled

## Installation

```bash
git clone https://github.com/lucidbeaming/claudeproxy.git
cd claudeproxy
npm install
cp .env.example .env
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8082` | Port the proxy listens on |
| `LM_STUDIO_URL` | `http://localhost:1234` | LM Studio's OpenAI-compatible server |
| `MODEL_OVERRIDE` | (unset) | Send this LM Studio model ID instead of whatever model name Claude sends |
| `LOG_DIR` | `./logs` | Where per-run `proxy-<timestamp>.log` files are written |

## Usage

Start LM Studio, load a model, and enable the local server (default port 1234).

Then start the proxy:

```bash
npm start
```

Point Claude Code at the proxy by setting this environment variable before launching it:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8082 claude
```

Or export it persistently in your shell profile:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8082
```

### One-step launcher

`claude-local.sh` (zsh, needs LM Studio's `lms` CLI) does it all at once. It loads the model named in `REAL_MODEL` with a 64k context, starts the LM Studio server and the proxy, sets the Claude Code environment variables (including `ANTHROPIC_CUSTOM_MODEL_OPTION`, so the local model name is accepted) and launches `claude --debug`. Edit `REAL_MODEL` at the top of the script for your model.

## How it works

`index.js` is a single Express app. `POST /v1/messages` converts the request with `toOpenAIRequest()` and forwards it to `LM_STUDIO_URL/v1/chat/completions` with axios. Non-streaming responses are mapped back to an Anthropic `message`. For streaming, it reads LM Studio's `data:` chunks and emits the Anthropic event sequence (`message_start`, `content_block_start`, `ping`, `content_block_delta`…, `content_block_stop`, `message_delta`, `message_stop`).

## Troubleshooting

Every run writes a structured log to `logs/proxy-<timestamp>.log`, with full request and response bodies at `DEBUG` level. [LOGS.md](LOGS.md) lists every log location (proxy, Claude Code's `--debug` log, LM Studio's server log) and gives a step-by-step diagnostic procedure.

## Development

Auto-restarts on file changes:

```bash
npm run dev
```

Health check:

```bash
curl http://127.0.0.1:8082/health
```

## Testing

Tests verify connectivity to LM Studio, model metadata shape, and inference (both streaming and non-streaming). LM Studio must be running with a model loaded.

```bash
npm test
```

The test suite covers:

- **Connectivity** — server reachable, returns JSON
- **Model metadata** — OpenAI-compatible response shape, required fields, prints loaded model IDs
- **Inference** — non-streaming response + token counts, streaming SSE chunks and `[DONE]` terminator

## Related projects

- [chatjc](https://github.com/lucidbeaming/chatjc): RAG chatbot API with switchable Mistral and OpenAI backends

## License

[MIT](LICENSE).
