# claudeproxy — Log Locations & Analysis Guide

## Context

This project is a proxy (`index.js`) that translates Anthropic API requests from Claude Code CLI into OpenAI-compatible requests for LM Studio running a local MLX model. The known issue is: after sending any message in Claude, there is a brief flash of 2 lines then no response. Claude remains functional (accepts `/` commands) but produces no output.

The 2 lines are likely the `message_start` and `content_block_start` SSE events being rendered, after which the stream silently fails or closes.

---

## Log Files

### 1. claudeproxy proxy log
**Path:** `./logs/proxy-<timestamp>.log` (in this repo directory)  
**Written by:** `index.js` on every run  
**Contains:**
- `[INFO]` — each request received, model name, stream vs sync, upstream connection status, stream end with chunk/token counts
- `[DEBUG]` — full request headers & body from Claude, full OpenAI-format body sent to LM Studio, every raw chunk received from LM Studio, every parsed SSE line, every SSE event sent back to Claude
- `[SSE]` — each event emitted to Claude: `message_start`, `content_block_start`, `ping`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`
- `[ERROR]` — upstream failures with full stack traces and response bodies
- `[WARN]` — unmatched routes

**What to look for:**
- Does `upstream connected` appear? If not, LM Studio isn't reachable.
- Are any `content_block_delta` SSE events logged? If `output_tokens: 0` at stream end, LM Studio returned no content.
- Does `upstream stream ended` appear quickly (near-zero chunks)? The model may have rejected the request or returned an empty completion.
- Are there parse errors on chunks? The stream format from LM Studio may be malformed.
- Does `client disconnected` fire before `response ended`? Claude may be closing the connection early.

### 2. Claude CLI debug log
**Path:** `~/.claude/debug/latest` (symlink to a timestamped `.txt` file in the same dir)  
**Written by:** Claude Code CLI when launched with `--debug` (already set in `claude-local.sh`)  
**Contains:** Claude's internal view of API requests and responses, including what it receives back from the proxy.

**What to look for:**
- What model string is Claude sending in requests?
- Is Claude receiving the SSE events and interpreting them correctly?
- Are there any protocol-level errors or unexpected response shapes?

### 3. claudeproxy stdout/stderr (legacy)
**Path:** `/tmp/claudeproxy.log`  
**Written by:** shell redirection in `claude-local.sh` (`> /tmp/claudeproxy.log 2>&1`)  
**Note:** Now superseded by the structured `./logs/` file logging, but still written as a fallback.

### 4. LM Studio server log
**Location:** LM Studio UI → Developer tab → Server logs  
**Contains:** What LM Studio received and whether it processed the request.

---

## How to Run a Diagnostic Session

1. Start everything: `./claude-local.sh`
2. In Claude, send one short message (e.g. `hi`)
3. Observe the flash — note roughly how many lines appear
4. Exit Claude
5. Examine logs in order:
   ```
   cat logs/proxy-*.log | grep -v DEBUG   # high-level flow first
   cat logs/proxy-*.log                   # full detail if needed
   cat ~/.claude/debug/latest             # Claude's perspective
   cat /tmp/claudeproxy.log               # fallback stdout
   ```

---

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | The proxy server — all translation logic and logging |
| `claude-local.sh` | Launch script — starts LM Studio, proxy, and Claude with env vars |
| `logs/proxy-*.log` | Structured per-run proxy logs |
| `~/.claude/debug/latest` | Claude CLI debug log (requires `--debug` flag, already set) |
| `/tmp/claudeproxy.log` | Proxy stdout/stderr redirect |
