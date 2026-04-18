require('dotenv').config();
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const BASE = process.env.LM_STUDIO_URL || 'http://127.0.0.1:1234';

let client;

before(() => {
  client = axios.create({ baseURL: BASE, timeout: 10000 });
});

// ─── Connectivity ────────────────────────────────────────────────────────────

describe('LM Studio connectivity', () => {
  test('server is reachable', async () => {
    const res = await client.get('/v1/models');
    assert.equal(res.status, 200, 'Expected HTTP 200 from /v1/models');
  });

  test('response content-type is JSON', async () => {
    const res = await client.get('/v1/models');
    assert.match(res.headers['content-type'], /application\/json/);
  });
});

// ─── Model metadata ──────────────────────────────────────────────────────────

describe('LM Studio model metadata', () => {
  let models;

  before(async () => {
    const res = await client.get('/v1/models');
    models = res.data;
  });

  test('response has OpenAI-compatible shape', () => {
    assert.equal(models.object, 'list', 'Top-level object should be "list"');
    assert.ok(Array.isArray(models.data), 'models.data should be an array');
  });

  test('at least one model is loaded', () => {
    assert.ok(models.data.length > 0, 'No models loaded in LM Studio — load one first');
  });

  test('each model has required fields', () => {
    for (const model of models.data) {
      assert.ok(model.id, `Model missing id: ${JSON.stringify(model)}`);
      assert.equal(model.object, 'model', `Expected object="model", got "${model.object}"`);
      assert.ok(typeof model.created === 'number', 'model.created should be a number');
      assert.ok(model.owned_by, 'model.owned_by should be present');
    }
  });

  test('prints loaded model IDs', () => {
    const ids = models.data.map(m => m.id);
    console.log('  Loaded models:', ids.join(', '));
    assert.ok(ids.length > 0);
  });
});

// ─── Inference ───────────────────────────────────────────────────────────────

describe('LM Studio inference', () => {
  let modelId;

  before(async () => {
    const res = await client.get('/v1/models');
    modelId = res.data.data[0]?.id;
    if (!modelId) throw new Error('No model available for inference test');
  });

  test('non-streaming chat completion returns valid response', async () => {
    const res = await client.post('/v1/chat/completions', {
      model: modelId,
      messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
      max_tokens: 16,
      temperature: 0,
      stream: false,
    });

    assert.equal(res.status, 200);

    const body = res.data;
    assert.ok(body.id, 'Missing response id');
    assert.ok(Array.isArray(body.choices), 'choices should be an array');
    assert.ok(body.choices.length > 0, 'choices should not be empty');

    const choice = body.choices[0];
    assert.ok(choice.message, 'choice.message missing');
    assert.equal(choice.message.role, 'assistant');
    assert.ok(typeof choice.message.content === 'string', 'content should be a string');
    assert.ok(choice.message.content.length > 0, 'content should not be empty');
    assert.ok(choice.finish_reason, 'finish_reason should be present');

    console.log(`  Model: ${modelId}`);
    console.log(`  Response: "${choice.message.content.trim()}"`);
    console.log(`  Finish reason: ${choice.finish_reason}`);
  });

  test('usage token counts are present', async () => {
    const res = await client.post('/v1/chat/completions', {
      model: modelId,
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 8,
      stream: false,
    });

    const usage = res.data.usage;
    assert.ok(usage, 'usage object missing');
    assert.ok(typeof usage.prompt_tokens === 'number', 'prompt_tokens should be a number');
    assert.ok(typeof usage.completion_tokens === 'number', 'completion_tokens should be a number');
    assert.ok(usage.prompt_tokens > 0, 'prompt_tokens should be > 0');
    assert.ok(usage.completion_tokens > 0, 'completion_tokens should be > 0');
  });

  test('streaming chat completion emits SSE chunks', async () => {
    const res = await client.post('/v1/chat/completions', {
      model: modelId,
      messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
      max_tokens: 16,
      temperature: 0,
      stream: true,
    }, { responseType: 'text' });

    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/event-stream/);

    const lines = res.data.split('\n').filter(l => l.startsWith('data: '));
    const chunks = lines.filter(l => l !== 'data: [DONE]').map(l => {
      try { return JSON.parse(l.slice(6)); } catch (_) { return null; }
    }).filter(Boolean);

    assert.ok(chunks.length > 0, 'No SSE chunks received');

    const hasContent = chunks.some(c => c.choices?.[0]?.delta?.content);
    assert.ok(hasContent, 'No content deltas in stream');

    const hasDone = lines.some(l => l === 'data: [DONE]');
    assert.ok(hasDone, 'Stream did not end with [DONE]');

    console.log(`  Received ${chunks.length} chunk(s)`);
  });
});
