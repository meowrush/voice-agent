const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { performance } = require('node:perf_hooks');

function fixture(index) {
  const wave = readFileSync(join(__dirname, '..', 'fixtures', 'input-' + index + '.wav'));
  if (wave.toString('ascii', 0, 4) !== 'RIFF' || wave.readUInt32LE(24) !== 16000) {
    throw new Error('Expected a 16 kHz PCM WAV fixture');
  }
  for (let at = 12; at + 8 <= wave.length;) {
    const length = wave.readUInt32LE(at + 4);
    if (wave.toString('ascii', at, at + 4) === 'data') return wave.subarray(at + 8, at + 8 + length);
    at += 8 + length + length % 2;
  }
  throw new Error('Missing PCM data in WAV fixture');
}

async function openSession(base) {
  const response = await fetch(base + '/sessions', { method: 'POST' });
  if (!response.ok) throw new Error('Session creation failed');
  const { session_id: id } = await response.json();
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws/voice?session_id=' + id);
  const events = [];
  let audioBytes = 0;
  let autoPlay = true;
  const send = (type, fields = {}) => ws.send(JSON.stringify({ type, ...fields }));
  ws.onmessage = ({ data }) => {
    if (typeof data !== 'string') {
      audioBytes += data.size ?? data.byteLength;
      return;
    }
    const event = JSON.parse(data);
    events.push(event);
    if (event.type === 'sentence_end' && autoPlay) {
      send('playback', { turn_id: event.turn_id, played_sentences: event.sentence + 1 });
    }
    if (event.type === 'reply_end' && autoPlay) send('playback_done', { turn_id: event.turn_id });
  };
  async function wait(type, offset = 0, check = () => true, timeout = 15000) {
    const deadline = performance.now() + timeout;
    while (performance.now() < deadline) {
      const found = events.slice(offset).find(event => event.type === type && check(event));
      if (found) return found;
      await delay(10);
    }
    throw new Error('Timed out waiting for ' + type + ': ' + JSON.stringify(events.slice(-8)));
  }
  await wait('state', 0, event => event.state === 'listening');
  return {
    id, ws, events, send, wait,
    get audioBytes() { return audioBytes; },
    set autoPlay(value) { autoPlay = value; },
    async snapshot() { return (await fetch(base + '/sessions/' + id)).json(); },
    async end() {
      const start = events.length;
      send('end_call');
      return wait('call_ended', start);
    }
  };
}

async function sendPcm(ws, pcm, { realtime = false, silenceMs = 680 } = {}) {
  const frames = Math.ceil(pcm.length / 640) + Math.ceil(silenceMs / 20);
  const start = performance.now();
  for (let i = 0; i < frames; i++) {
    if (realtime && i) await delay(Math.max(0, start + i * 20 - performance.now()));
    const frame = Buffer.alloc(640);
    if (i * 640 < pcm.length) pcm.copy(frame, 0, i * 640, Math.min((i + 1) * 640, pcm.length));
    ws.send(frame);
  }
}

module.exports = { fixture, openSession, sendPcm };


