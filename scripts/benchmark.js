const { once } = require('node:events');
const { writeFileSync } = require('node:fs');
const { createApp, configure } = require('../server');
const { fixture, openSession, sendPcm } = require('./harness');

const stages = {
  vad_end_ms: 'VAD end detection',
  stt_final_ms: 'STT finalization',
  llm_first_token_ms: 'LLM first text',
  tts_first_audio_ms: 'First text to first TTS audio',
  total_ms: 'Speech end to first server audio'
};
const median = sorted => (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
const p90 = sorted => sorted[Math.ceil(sorted.length * 0.9) - 1];

async function main() {
  const config = configure({ ...process.env, SESSION_DB: ':memory:' });
  const app = createApp(config);
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const measured = [];
  try {
    for (const length of [6, 6, 6, 2]) {
      const client = await openSession(base);
      for (let index = 0; index < length; index++) {
        const offset = client.events.length;
        await sendPcm(client.ws, fixture(index), { realtime: true, silenceMs: config.silenceMs + 80 });
        await client.wait('state', offset, event => event.state === 'listening', 60000);
      }
      await client.end();
      const report = await client.snapshot();
      if (report.metrics.length !== length || report.errors.length) throw new Error(JSON.stringify(report));
      for (const row of report.metrics) measured.push({ session_id: client.id, ...row });
      console.log('Measured', measured.length, 'turns');
    }
  } finally {
    await app.close();
  }
  const rows = Object.entries(stages).map(([key, label]) => {
    const values = measured.map(item => item[key]);
    if (values.some(value => value == null)) throw new Error('Incomplete measurements for ' + key);
    values.sort((a, b) => a - b);
    return '| ' + label + ' | ' + median(values) + ' | ' + p90(values) + ' |';
  });
  const caveat = config.summary.mode === 'mock'
    ? 'This run used scripted transcripts, deterministic LLM output and prerecorded replies. It verifies local transport and instrumentation. Live-provider latency and the 1.5 s acceptance target still require a live run.'
    : 'This run used the configured live providers. Results reflect this run and network conditions.';
  const result = [
    '# Voice agent latency report', '',
    '20 turns across four localhost calls in **' + config.summary.mode + '** mode. The driver replayed 16 kHz mono recorded speech over WebSocket in real time. Measurements were read back from SQLite through the session endpoint.', '',
    '| Stage | Median (ms) | P90 (ms) |', '| --- | ---: | ---: |', ...rows, '',
    'Speech end is the receipt of the final voiced frame according to the server VAD. The TTS interval includes sentence buffering. Total ends when the server receives the first PCM chunk. This driver acknowledges playback immediately, so it does not measure speaker onset.', '',
    'Median is the average of the two central samples, and p90 is nearest rank.', '', caveat, ''
  ].join('\n');
  console.log(result);
  if (process.argv[2]) {
    writeFileSync(process.argv[2] + '.md', result);
    writeFileSync(process.argv[2] + '.json', JSON.stringify({ config: config.summary, measured }, null, 2) + '\n');
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

