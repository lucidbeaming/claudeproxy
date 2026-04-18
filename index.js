require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '10mb' }));

const LM_STUDIO_URL = process.env.LM_STUDIO_URL || 'http://localhost:1234';
const PORT = process.env.PORT || 8082;
const MODEL_OVERRIDE = process.env.MODEL_OVERRIDE;

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
      : msg.content.map(b => b.type === 'text' ? b.text : '').join('');
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

function sendSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

app.post('/v1/messages', async (req, res) => {
  const body = req.body;
  const openaiBody = toOpenAIRequest(body);
  const targetUrl = `${LM_STUDIO_URL}/v1/chat/completions`;

  console.log(`→ ${body.stream ? 'stream' : 'sync'} | model: ${openaiBody.model} | messages: ${openaiBody.messages.length}`);

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
      const upstream = await axios.post(targetUrl, openaiBody, {
        responseType: 'stream',
        headers: { 'Content-Type': 'application/json' },
      });

      let buffer = '';
      let outputTokens = 0;

      upstream.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') continue;

          try {
            const parsed = JSON.parse(raw);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              outputTokens++;
              sendSSE(res, 'content_block_delta', {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: delta },
              });
            }
          } catch (_) {}
        }
      });

      upstream.data.on('end', () => {
        sendSSE(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
        sendSSE(res, 'message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: outputTokens },
        });
        sendSSE(res, 'message_stop', { type: 'message_stop' });
        res.end();
      });

      upstream.data.on('error', (err) => {
        console.error('Stream error:', err.message);
        res.end();
      });

    } catch (err) {
      console.error('Upstream error:', err.message);
      sendSSE(res, 'error', { type: 'error', error: { type: 'api_error', message: err.message } });
      res.end();
    }

  } else {
    try {
      const upstream = await axios.post(targetUrl, openaiBody, {
        headers: { 'Content-Type': 'application/json' },
      });
      res.json(toAnthropicResponse(upstream.data, body.model));
    } catch (err) {
      console.error('Upstream error:', err.message);
      res.status(err.response?.status || 500).json({
        type: 'error',
        error: { type: 'api_error', message: err.message },
      });
    }
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok', upstream: LM_STUDIO_URL }));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`claudeproxy listening on http://localhost:${PORT}`);
  console.log(`forwarding to LM Studio at ${LM_STUDIO_URL}`);
  if (MODEL_OVERRIDE) console.log(`model override: ${MODEL_OVERRIDE}`);
});
