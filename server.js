const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { readFileSync, mkdirSync } = require('node:fs');
const { join, dirname } = require('node:path');
const WebSocket = require('faye-websocket');
const { Session } = require('./session');
const { liveProviders, mockProviders } = require('./providers');

function configure(env = process.env) {
  const number = (key, fallback, min, max) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isFinite(value) || value < min || value > max) throw new Error('Invalid ' + key);
    return value;
  };
  const mode = env.VOICE_MODE || 'mock';
  if (!['mock', 'live'].includes(mode)) throw new Error('VOICE_MODE must be mock or live');
  const config = {
    host: env.HOST || '127.0.0.1', port: number('PORT', 3000, 0, 65535),
    dbPath: env.SESSION_DB || join(__dirname, 'data', 'sessions.sqlite'),
    threshold: number('VAD_THRESHOLD', 0.018, 0.001, 1),
    silenceMs: number('VAD_SILENCE_MS', 600, 200, 2000),
    idleMs: number('IDLE_MS', 120000, 50, 86400000),
    maxCallMs: number('MAX_CALL_MS', 900000, 50, 86400000),
    providerTimeoutMs: number('PROVIDER_TIMEOUT_MS', 12000, 50, 120000),
    playbackTimeoutMs: number('PLAYBACK_TIMEOUT_MS', 45000, 50, 120000),
    prompt: env.SYSTEM_PROMPT || 'You are a friendly voice assistant. Keep replies brief. Use the clock tool when asked for the current time.',
    deepgramKey: env.DEEPGRAM_API_KEY, openaiKey: env.OPENAI_API_KEY,
    sttModel: env.STT_MODEL || 'nova-3', llmModel: env.LLM_MODEL || 'gpt-4o-mini',
    ttsModel: env.TTS_MODEL || 'gpt-4o-mini-tts', ttsVoice: env.TTS_VOICE || 'alloy'
  };
  if (mode === 'live' && (!config.deepgramKey || !config.openaiKey)) {
    throw new Error('Live mode requires DEEPGRAM_API_KEY and OPENAI_API_KEY');
  }
  config.summary = {
    mode, stt: mode === 'live' ? 'Deepgram/' + config.sttModel : 'fixture',
    llm: mode === 'live' ? 'OpenAI/' + config.llmModel : 'script',
    tts: mode === 'live' ? 'OpenAI/' + config.ttsModel : 'fixture',
    prompt_version: env.PROMPT_VERSION || '1', vad_silence_ms: config.silenceMs,
    vad_threshold: config.threshold, idle_ms: config.idleMs, max_call_ms: config.maxCallMs
  };
  return config;
}

function createApp(config = configure(), providers = config.summary.mode === 'mock' ? mockProviders() : liveProviders(config)) {
  if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true });
  const db = new DatabaseSync(config.dbPath);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL)');
  const upsert = db.prepare('INSERT INTO sessions VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET snapshot = excluded.snapshot');
  const get = db.prepare('SELECT snapshot FROM sessions WHERE id = ?');
  const store = { save: record => upsert.run(record.id, JSON.stringify(record)) };
  const sessions = new Map();
  for (const { snapshot } of db.prepare('SELECT snapshot FROM sessions').iterate()) {
    const record = JSON.parse(snapshot);
    if (!record.ended_at) {
      record.ended_at = new Date().toISOString();
      record.end_reason = 'server_restart';
      store.save(record);
    }
  }
  const assets = new Map(Object.entries({
    '/': ['index.html', 'text/html'], '/style.css': ['style.css', 'text/css'],
    '/app.js': ['app.js', 'text/javascript'], '/capture.js': ['capture.js', 'text/javascript']
  }).map(([path, [name, type]]) => [path, [readFileSync(join(__dirname, 'web', name)), type]]));

  function sameOrigin(request) {
    const { origin, host } = request.headers;
    return !origin || origin === 'http://' + host || origin === 'https://' + host;
  }
  function json(response, status, value) {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
  }

  const server = http.createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (request.method === 'POST' && path === '/sessions') {
      request.resume();
      if (!sameOrigin(request)) return json(response, 403, { error: 'Origin denied' });
      if (sessions.size >= 32) return json(response, 503, { error: 'Too many concurrent calls' });
      const session = new Session({ config, providers, store });
      sessions.set(session.record.id, session);
      const expiry = setTimeout(() => {
        if (!session.socket) {
          session.end('connection_timeout');
          sessions.delete(session.record.id);
        }
      }, 20000);
      session.connectionTimer = expiry;
      return json(response, 201, {
        session_id: session.record.id, mode: config.summary.mode, vad_threshold: config.threshold,
        input_sample_rate: 16000, output_sample_rate: 24000
      });
    }
    if (request.method === 'GET' && /^\/sessions\/[a-f0-9-]{36}$/.test(path)) {
      const row = get.get(path.split('/')[2]);
      return row ? json(response, 200, JSON.parse(row.snapshot)) : json(response, 404, { error: 'Session not found' });
    }
    if (request.method === 'GET' && assets.has(path)) {
      const [body, contentType] = assets.get(path);
      response.writeHead(200, { 'Content-Type': contentType + '; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
      return response.end(body);
    }
    return json(response, 404, { error: 'Not found' });
  });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://localhost');
    const session = sessions.get(url.searchParams.get('session_id'));
    if (url.pathname !== '/ws/voice' || !sameOrigin(request) || !WebSocket.isWebSocket(request) ||
        !session || session.status !== 'idle') {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const ws = new WebSocket(request, socket, head, null, { maxLength: 8192, ping: 20 });
    clearTimeout(session.connectionTimer);
    ws.on('open', () => session.attach(ws));
    session.socket = ws;
    ws.on('message', event => session.receive(event.data));
    ws.on('error', () => session.end('disconnected'));
    ws.on('close', () => {
      session.end('disconnected');
      sessions.delete(session.record.id);
    });
  });

  return {
    server,
    async close() {
      for (const session of sessions.values()) {
        clearTimeout(session.connectionTimer);
        session.end('server_shutdown');
      }
      await new Promise(resolve => server.close(resolve));
      db.close();
    }
  };
}

if (require.main === module) {
  const config = configure();
  const app = createApp(config);
  app.server.listen(config.port, config.host, () => {
    console.log('Voice agent (' + config.summary.mode + ') · http://' + config.host + ':' + app.server.address().port);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void app.close());
}
module.exports = { configure, createApp };

