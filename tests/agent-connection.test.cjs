const { test } = require('node:test');
const assert = require('node:assert/strict');

test('push consumes split frames without poll timers and refreshes token on reconnect', async () => {
  const { AgentConnection } = await import('../agent-connection.js');
  let wake = 0, sessions = 0, streams = 0, emit;
  const fetcher = async (url, options) => {
    if (url === '/api/session') { sessions++; return { ok: true, json: async () => ({ token: 'token-' + sessions }) }; }
    assert.equal(options.headers['X-Studio-Token'], 'token-' + sessions); streams++;
    const body = new ReadableStream({ start(controller) {
      emit = text => controller.enqueue(new TextEncoder().encode(text));
      options.signal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
    } });
    return { ok: true, body };
  };
  const connection = new AgentConnection(() => wake++, { fetcher });
  connection.start(); await new Promise(resolve => setImmediate(resolve));
  emit('data: wa'); emit('ke\n\ndata: wake\n\n');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(wake, 2);
  connection.stop(); connection.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(sessions, 2); assert.equal(streams, 2);
  emit('data: wake\n\n'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(wake, 3); connection.stop();
});
