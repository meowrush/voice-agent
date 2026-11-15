const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createApp, configure } = require('../server');
const { Session, Vad } = require('../session');
const { mockProviders, liveProviders, fallback } = require('../providers');
const { fixture, openSession, sendPcm } = require('../scripts/harness');

const config = overrides => configure({ VOICE_MODE: 'mock', SESSION_DB: ':memory:', ...overrides });
const silent = Buffer.alloc(640);
const voiced = Buffer.alloc(640);
for (let i = 0; i < voiced.length; i += 2) voiced.writeInt16LE(6000, i);

async function withApp(t, options, providers) {
  const app = createApp(config(options), providers);
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.close());
  return openSession('http://127.0.0.1:' + app.server.address().port);
}

async function turn(client, index) {
  const offset = client.events.length;
  await sendPcm(client.ws, fixture(index));
  return client.wait('state', offset, event => event.state === 'listening');
}

test('VAD ignores silence and short bursts and finds the last voiced frame', () => {
  const vad = new Vad(config());
  assert.deepEqual(vad.accept(silent, 0), {});
  assert.equal(vad.accept(voiced, 20).start, true);
  for (let i = 1; i < 30; i++) vad.accept(silent, 20 + i * 20);
  assert.deepEqual(vad.accept(silent, 620), { end: 20, valid: false });
  for (let i = 0; i < 10; i++) vad.accept(voiced, 640 + i * 20);
  for (let i = 1; i < 30; i++) vad.accept(silent, 820 + i * 20);
  assert.deepEqual(vad.accept(silent, 1420), { end: 820, valid: true });
});

test('session enforces state transitions and ends once', () => {
  const writes = [];
  const events = [];
  const socket = { send: msg => events.push(JSON.parse(msg)), readyState: 1, close() {} };
  const session = new Session({ config: config(), providers: mockProviders(), store: { save: r => writes.push(r.end_reason) } });
  try {
    assert.throws(() => session.state('thinking'), /Invalid session transition/);
    session.attach(socket);
    session.state('thinking');
    session.state('speaking');
    session.state('listening');
    session.end('user_ended');
    session.end('disconnected');
    assert.deepEqual(events.filter(e => e.type === 'state').map(e => e.state),
      ['listening', 'thinking', 'speaking', 'listening', 'ended']);
    assert.deepEqual(writes, [null, 'user_ended']);
  } finally { session.end('test_ended'); }
});

test('OpenAI adapter assembles streamed tool calls and aligns split PCM samples', async () => {
  function response(events) {
    return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n');
  }
  const payloads = [];
  const providers = liveProviders({
    openaiKey: 'test', prompt: 'Test', llmModel: 'model', ttsModel: 'speech', ttsVoice: 'voice'
  }, async (url, options) => {
    payloads.push(JSON.parse(options.body));
    if (url.endsWith('audio/speech')) {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(Uint8Array.of(1));
          controller.enqueue(Uint8Array.of(2, 3, 4));
          controller.close();
        }
      }));
    }
    if (payloads.length === 1) {
      return response([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'clock', function: { name: 'get_current_time', arguments: '{' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] } }] }
      ]);
    }
    return response([{ choices: [{ delta: { content: 'The clock replied.' } }] }]);
  });
  const signal = new AbortController().signal;
  const reply = [];
  for await (const chunk of providers.llm({
    history: [{ role: 'user', content: 'Time?' }], signal,
    execute: (name, args) => {
      assert.equal(name, 'get_current_time');
      assert.deepEqual(args, {});
      return { utc: '12:00' };
    }
  })) reply.push(chunk);
  assert.deepEqual(reply, ['The clock replied.']);
  assert.equal(payloads[1].messages.at(-1).tool_call_id, 'clock');
  const audio = [];
  for await (const chunk of providers.tts({ text: reply[0], signal })) audio.push(chunk);
  assert.deepEqual(Buffer.concat(audio), Buffer.from([1, 2, 3, 4]));
});

const integration = process.env.UNIT_ONLY ? test.skip : test;
integration('recorded PCM runs through a six-turn call with captions, clock and persistence', async t => {
  const client = await withApp(t);
  client.ws.send(voiced);
  for (let i = 0; i < 32; i++) client.ws.send(silent);
  for (let i = 0; i < 6; i++) await turn(client, i);
  assert.deepEqual((await client.end()).reason, 'user_ended');
  const saved = await client.snapshot();
  assert.equal(saved.transcript.length, 12);
  assert.equal(saved.metrics.length, 6);
  assert(saved.metrics.every(row => Number.isFinite(row.total_ms)));
  assert.equal(saved.errors.length, 0);
  assert.match(saved.transcript[7].text, /Kyoto/);
  assert.match(saved.transcript.at(-1).text, /Maya/);
  assert.equal(saved.transcript[9].tool_calls[0].name, 'get_current_time');
  assert.match(saved.transcript[9].tool_calls[0].result.utc, /Z$/);
  assert(client.events.some(event => event.type === 'transcript_partial' && event.text));
  assert(client.audioBytes > 10000);
});

integration('barge-in discards unacknowledged audio and the session records a disconnect', async t => {
  const client = await withApp(t);
  client.autoPlay = false;
  await sendPcm(client.ws, fixture(0));
  const first = await client.wait('agent_audio');
  client.send('interrupt', { turn_id: first.turn_id, played_sentences: 0 });
  await client.wait('interrupted');
  client.autoPlay = true;
  await turn(client, 1);
  client.ws.close();
  await once(client.ws, 'close');
  const saved = await client.snapshot();
  assert.equal(saved.end_reason, 'disconnected');
  assert.equal(saved.transcript[1].text, '');
  assert.equal(saved.transcript[1].interrupted, true);
  assert.match(saved.transcript.at(-1).text, /Kyoto/);
});

for (const stage of ['stt', 'llm', 'tts']) {
  integration(stage + ' failure plays fallback and keeps the session open', async t => {
    const baseline = mockProviders();
    let attempts = 0;
    const providers = {
      ...baseline, [stage](options) {
        if (attempts++ === 0) throw new Error('Injected failure');
        return baseline[stage](options);
      }
    };
    const client = await withApp(t, {}, providers);
    await turn(client, 0);
    assert(client.events.some(event => event.type === 'agent_text' && event.text === fallback));
    assert(client.audioBytes > 10000);
    assert.equal((await client.snapshot()).errors[0].stage, stage);
    await turn(client, stage === 'stt' ? 0 : 1);
    await client.end();
  });
}

for (const [env, reason] of [['IDLE_MS', 'silence_timeout'], ['MAX_CALL_MS', 'max_duration']]) {
  integration(reason + ' plays goodbye before ending', async t => {
    const client = await withApp(t, { [env]: 800 });
    await client.wait('agent_audio');
    const ended = await client.wait('call_ended');
    assert.equal(ended.reason, reason);
    assert.match((await client.snapshot()).transcript.at(-1).text, /Goodbye/);
  });
}




integration('a failed tool returns a structured error to the LLM and persists the result', async t => {
  const baseline = mockProviders();
  let returned;
  const client = await withApp(t, {}, {
    ...baseline,
    async *llm({ execute }) {
      returned = await execute('get_current_time', { invalid: true });
      yield 'Nice to meet you, Maya.';
    }
  });
  await turn(client, 0);
  await client.end();
  assert.match(returned.error, /clock tool/);
  const saved = await client.snapshot();
  assert.equal(saved.errors[0].stage, 'tool');
  assert.deepEqual(saved.transcript.at(-1).tool_calls[0].result, returned);
});

integration('a partial TTS failure keeps the spoken fallback in history', async t => {
  const baseline = mockProviders();
  const client = await withApp(t, {}, {
    ...baseline,
    async *tts() {
      yield Buffer.alloc(4800);
      throw new Error('Connection dropped during speech');
    }
  });
  await turn(client, 0);
  await client.end();
  const saved = await client.snapshot();
  assert.equal(saved.errors[0].stage, 'tts');
  assert.equal(saved.transcript.at(-1).text, fallback);
});

integration('STT timeout produces a fallback even when finish stalls', async t => {
  const baseline = mockProviders();
  const client = await withApp(t, { PROVIDER_TIMEOUT_MS: 100 }, {
    ...baseline,
    stt() { return { write() {}, finish() { return new Promise(() => {}); } }; }
  });
  await turn(client, 0);
  await client.end();
  const saved = await client.snapshot();
  assert.match(saved.errors[0].message, /STT timed out/);
  assert.equal(saved.transcript.at(-1).text, fallback);
});
