# claudeproxy

A lightweight local proxy that lets Claude Code (or any Anthropic API client) run against a local model served by [LM Studio](https://lmstudio.ai) on a MacBook.

Claude sends and receives the Anthropic message format. LM Studio speaks the OpenAI chat completions format. This proxy sits between them and translates both directions — including streaming SSE.

```
Claude Code  →  claudeproxy :8082  →  LM Studio :1234
             (Anthropic format)       (OpenAI format)
```

## What gets translated

| | Anthropic | OpenAI |
|---|---|---|
| System prompt | Top-level `system` field | `{role: "system"}` message |
| Content | `[{type: "text", text}]` blocks | Plain string |
| Stop reason | `end_turn` | `stop` |
| Token counts | `input_tokens / output_tokens` | `prompt_tokens / completion_tokens` |
| Streaming | Named SSE events (`message_start`, `content_block_delta`, etc.) | `data:` chunks with `delta.content` |

## Requirements

- Node.js 18+
- [LM Studio](https://lmstudio.ai) running locally with a model loaded and the local server enabled

## Installation

```bash
git clone https://github.com/lucidbeaming/claudeproxy.git
cd claudeproxy
npm install
cp .env.example .env
```

Edit `.env` if your LM Studio runs on a different port or you want to pin a specific model:

```env
PORT=8082
LM_STUDIO_URL=http://127.0.0.1:1234

# Optional: override whatever model name Claude sends with an LM Studio model ID
# MODEL_OVERRIDE=lmstudio-community/Meta-Llama-3-8B-Instruct-GGUF
```

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
