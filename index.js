require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));

const LM_STUDIO_URL = process.env.LM_STUDIO_URL || 'http://localhost:1234';
const PORT = process.env.PORT || 8082;
const MODEL_OVERRIDE = process.env.MODEL_OVERRIDE;

// --- File-based logger ---
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const logFile = path.join(LOG_DIR, `proxy-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

function log(level, ...args) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ')}`;
  logStream.write(line + '\n');
  if (level === 'ERROR') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

log('INFO', `claudeproxy log file: ${logFile}`);

// Convert a single Anthropic content block to a plain text string
function blockToText(block) {
  if (block.type === 'text') return block.text;
  if (block.type === 'tool_use') {
    return `[Tool call: ${block.name}]\nInput: ${JSON.stringify(block.input, null, 2)}`;
  }
  if (block.type === 'tool_result') {
    const inner = Array.isArray(block.content)
      ? block.content.map(b => b.type === 'text' ? b.text : '').join('')
      : (block.content || '');
    return `[Tool result]\nOutput: ${inner}`;
  }
  return '';
}

// Anthropic request → OpenAI request
function toOpenAIRequest(body) {
  const messages = [];

  if (body.system) {
    const text = typeof body.system === 'string'
      ? body.system
      : body.system.map(b => b.text).join('\n');
    messages.push({ role: 'system', content: text });
  }

  for (const msg of body.messages) {
    const content = typeof msg.content === 'string'
      ? msg.content
      : msg.content.map(blockToText).filter(Boolean).join('\n');
    messages.push({ role: msg.role, content });
  }

  const req = {
    model: MODEL_OVERRIDE || body.model,
    messages,
    stream: body.stream || false,
  };

  if (body.max_tokens) req.max_tokens = body.max_tokens;
  if (body.temperature != null) req.temperature = body.temperature;
  if (body.top_p != null) req.top_p = body.top_p;

  return req;
}

// OpenAI response → Anthropic response
function toAnthropicResponse(openai, model) {
  const choice = openai.choices[0];
  return {
    id: openai.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: choice.message.content }],
    model,
    stop_reason: choice.finish_reason === 'stop' ? 'end_turn' : (choice.finish_reason || 'end_turn'),
    stop_sequence: null,
    usage: {
      input_tokens: openai.usage?.prompt_tokens || 0,
      output_tokens: openai.usage?.completion_tokens || 0,
    },
  };
}

// Extract a human-readable error message from LM Studio error responses
function lmStudioErrMsg(err) {
  const data = err.response?.data;
  if (!data) return null;
  const msg = (typeof data === 'object' ? data?.error?.message : null) || null;
  if (!msg) return null;
  if (msg.includes('No models loaded')) {
    return 'LM Studio has no model loaded. The model may have crashed — reload it in LM Studio and try again.';
  }
  return msg;
}

function sendSSE(res, event, data) {
  log('SSE', `→ event:${event}`, data);
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

app.post('/v1/messages', async (req, res) => {
  const body = req.body;
  const reqId = `req_${Date.now()}`;

  log('INFO', `[${reqId}] POST /v1/messages | stream:${body.stream} | model:${body.model} | messages:${body.messages?.length}`);
  log('DEBUG', `[${reqId}] request headers:`, req.headers);
  log('DEBUG', `[${reqId}] request body:`, body);

  const openaiBody = toOpenAIRequest(body);
  const targetUrl = `${LM_STUDIO_URL}/v1/chat/completions`;

  log('INFO', `[${reqId}] forwarding to ${targetUrl} | openai model:${openaiBody.model}`);
  log('DEBUG', `[${reqId}] openai request body:`, openaiBody);

  if (openaiBody.stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const messageId = `msg_${Date.now()}`;

    sendSSE(res, 'message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: body.model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });

    sendSSE(res, 'content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    });

    sendSSE(res, 'ping', { type: 'ping' });

    try {
      log('INFO', `[${reqId}] opening upstream stream...`);
      const upstream = await axios.post(targetUrl, openaiBody, {
        responseType: 'stream',
        headers: { 'Content-Type': 'application/json' },
      });
      log('INFO', `[${reqId}] upstream connected | status:${upstream.status}`);
      log('DEBUG', `[${reqId}] upstream response headers:`, upstream.headers);

      let buffer = '';
      let outputTokens = 0;
      let chunkCount = 0;
      let currentEvent = null;
      let upstreamErrored = false;

      upstream.data.on('data', (chunk) => {
        const raw = chunk.toString();
        chunkCount++;
        log('DEBUG', `[${reqId}] upstream chunk #${chunkCount} (${raw.length} bytes):`, raw);

        buffer += raw;
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          log('DEBUG', `[${reqId}] upstream line: ${JSON.stringify(line)}`);

          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
            continue;
          }

          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();

          if (currentEvent === 'error') {
            let errMsg = payload;
            try { errMsg = JSON.parse(payload)?.error?.message || payload; } catch {}
            log('ERROR', `[${reqId}] upstream error event: ${errMsg}`);
            upstreamErrored = true;
            sendSSE(res, 'error', { type: 'error', error: { type: 'api_error', message: errMsg } });
            currentEvent = null;
            continue;
          }
          currentEvent = null;

          if (payload === '[DONE]') {
            log('INFO', `[${reqId}] upstream [DONE] received`);
            continue;
          }

          try {
            const parsed = JSON.parse(payload);
            log('DEBUG', `[${reqId}] parsed chunk:`, parsed);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              outputTokens++;
              sendSSE(res, 'content_block_delta', {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: delta },
              });
            } else {
              log('DEBUG', `[${reqId}] chunk had no delta content. finish_reason:${parsed.choices?.[0]?.finish_reason}`);
            }
          } catch (parseErr) {
            log('ERROR', `[${reqId}] failed to parse chunk payload: ${JSON.stringify(payload)} | err:${parseErr.message}`);
          }
        }
      });

      upstream.data.on('end', () => {
        log('INFO', `[${reqId}] upstream stream ended | total chunks:${chunkCount} | output_tokens:${outputTokens}`);
        if (!upstreamErrored) {
          sendSSE(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
          sendSSE(res, 'message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: outputTokens },
          });
          sendSSE(res, 'message_stop', { type: 'message_stop' });
        }
        res.end();
        log('INFO', `[${reqId}] response ended`);
      });

      upstream.data.on('error', (err) => {
        log('ERROR', `[${reqId}] upstream stream error: ${err.message}`, err.stack);
        res.end();
      });

      res.on('close', () => {
        log('INFO', `[${reqId}] client disconnected`);
      });

    } catch (err) {
      log('ERROR', `[${reqId}] upstream request failed: ${err.message}`);
      log('ERROR', `[${reqId}] error stack:`, err.stack);
      if (err.response) {
        log('ERROR', `[${reqId}] upstream response status:${err.response.status} | headers:`, err.response.headers);
        log('ERROR', `[${reqId}] upstream response data:`, err.response.data);
      }
      const errMsg = lmStudioErrMsg(err) || err.message;
      sendSSE(res, 'error', { type: 'error', error: { type: 'api_error', message: errMsg } });
      res.end();
    }

  } else {
    try {
      const upstream = await axios.post(targetUrl, openaiBody, {
        headers: { 'Content-Type': 'application/json' },
      });
      log('INFO', `[${reqId}] sync response | status:${upstream.status}`);
      log('DEBUG', `[${reqId}] upstream sync response:`, upstream.data);
      const anthropicResp = toAnthropicResponse(upstream.data, body.model);
      log('DEBUG', `[${reqId}] anthropic response:`, anthropicResp);
      res.json(anthropicResp);
    } catch (err) {
      log('ERROR', `[${reqId}] sync upstream error: ${err.message}`);
      log('ERROR', `[${reqId}] error stack:`, err.stack);
      if (err.response) {
        log('ERROR', `[${reqId}] upstream response status:${err.response.status}`);
        log('ERROR', `[${reqId}] upstream response data:`, err.response.data);
      }
      const errMsg = lmStudioErrMsg(err) || err.message;
      res.status(503).json({
        type: 'error',
        error: { type: 'api_error', message: errMsg },
      });
    }
  }
});

app.get('/health', (_, res) => {
  log('INFO', 'GET /health');
  res.json({ status: 'ok', upstream: LM_STUDIO_URL, logFile });
});

// Log all unmatched routes
app.use((req, res) => {
  log('WARN', `unmatched route: ${req.method} ${req.path}`);
  res.status(404).json({ error: 'not found' });
});

app.listen(PORT, '127.0.0.1', () => {
  log('INFO', `claudeproxy listening on http://localhost:${PORT}`);
  log('INFO', `forwarding to LM Studio at ${LM_STUDIO_URL}`);
  if (MODEL_OVERRIDE) log('INFO', `model override: ${MODEL_OVERRIDE}`);
  log('INFO', `logging to: ${logFile}`);
});
