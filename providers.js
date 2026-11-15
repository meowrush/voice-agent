const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { Client } = require('faye-websocket');

const fallback = "Sorry, I didn't catch that. Could you repeat?";
const goodbye = 'Thanks for calling. Goodbye!';
const script = [
  ['My name is Maya.', 'Nice to meet you, Maya.'],
  ['I am planning a weekend in Kyoto.', 'Kyoto sounds great. What would you like to do there?'],
  ['I like quiet gardens.', 'Try visiting a temple garden early in the morning. This is a good way to avoid crowds.'],
  ['Which city am I visiting?', 'You said you are visiting Kyoto.'],
  ['What time is it?', 'I checked the current UTC time. You can see it in the transcript.'],
  ['What is my name?', 'Your name is Maya.']
];

const tool = {
  type: 'function',
  function: {
    name: 'get_current_time',
    description: 'Get the current date and time in UTC.',
    strict: true,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }
  }
};

function mockProviders() {
  return {
    stt: ({ partial, turnIndex, signal }) => {
      const [text] = script[turnIndex % script.length];
      let frames = 0;
      return {
        write() {
          signal.throwIfAborted();
          if (++frames === 8) partial(text.split(' ').slice(0, 3).join(' '));
        },
        async finish() {
          signal.throwIfAborted();
          return text;
        }
      };
    },
    async *llm({ history, execute, signal }) {
      signal.throwIfAborted();
      const text = history.at(-1).content;
      if (/time/.test(text)) await execute('get_current_time', {});
      if (/name\?/.test(text) && !history.some(item => item.content === script[0][0])) return;
      if (/city/.test(text) && !history.some(item => item.content === script[1][0])) return;
      const reply = script.find(([prompt]) => prompt === text)?.[1] || fallback;
      for (const word of reply.match(/\S+\s*/g)) yield word;
    },
    tts: localAudio
  };
}

async function* localAudio({ text, signal }) {
  const phrases = [...script.flatMap(([, reply]) => reply.match(/[^.!?]+[.!?]/g).map(s => s.trim())), fallback, goodbye];
  const index = phrases.indexOf(text);
  if (index < 0) throw new Error('No audio fixture for this phrase');
  const pcm = await readFile(join(__dirname, 'fixtures', 'reply-' + index + '.pcm'));
  for (let offset = 0; offset < pcm.length; offset += 4800) {
    signal.throwIfAborted();
    yield pcm.subarray(offset, offset + 4800);
  }
}

function deepgram(config, { signal, partial }) {
  const params = new URLSearchParams({
    model: config.sttModel, encoding: 'linear16', sample_rate: '16000',
    channels: '1', interim_results: 'true', endpointing: 'false',
    punctuate: 'true'
  });
  const ws = new Client('wss://api.deepgram.com/v1/listen?' + params, null, {
    headers: { Authorization: 'Token ' + config.deepgramKey }
  });
  const queue = [];
  const final = [];
  let resolve, reject, metadata = false;
  const result = new Promise((yes, no) => { resolve = yes; reject = no; });
  result.catch(() => {});
  function abort() {
    reject(signal.reason);
    ws.close();
  }
  signal.addEventListener('abort', abort, { once: true });
  ws.on('open', () => {
    for (const chunk of queue) ws.send(chunk);
    queue.length = 0;
  });
  ws.on('message', ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.type === 'Error') reject(new Error('Deepgram returned an error'));
    if (msg.type === 'Metadata') {
      metadata = true;
      resolve(final.join(' '));
    }
    if (msg.type !== 'Results') return;
    const text = msg.channel.alternatives[0]?.transcript?.trim();
    if (!text) return;
    if (msg.is_final) final.push(text);
    partial([...final, ...(msg.is_final ? [] : [text])].join(' '));
  });
  ws.on('error', () => reject(new Error('Deepgram connection failed')));
  ws.on('close', () => {
    signal.removeEventListener('abort', abort);
    if (!metadata) reject(new Error('Deepgram closed before finalizing'));
  });
  function send(data) {
    if (ws.readyState === 0) queue.push(data);
    if (ws.readyState === 1) ws.send(data);
  }
  return {
    write: send,
    finish() {
      send(JSON.stringify({ type: 'CloseStream' }));
      return result;
    }
  };
}

function liveProviders(config, fetcher = fetch) {
  async function post(path, payload, signal) {
    const response = await fetcher('https://api.openai.com/v1/' + path, {
      method: 'POST', signal,
      headers: { Authorization: 'Bearer ' + config.openaiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error('OpenAI ' + path + ' returned HTTP ' + response.status);
    return response;
  }

  return {
    stt: options => deepgram(config, options),
    async *llm({ history, execute, signal }) {
      const messages = [{ role: 'system', content: config.prompt }, ...history];
      for (let round = 0; round < 2; round++) {
        const response = await post('chat/completions', {
          model: config.llmModel, messages, stream: true, max_completion_tokens: 180,
          tools: [tool], tool_choice: round ? 'none' : 'auto'
        }, signal);
        const calls = new Map();
        let content = '';
        for await (const event of sse(response)) {
          const delta = event.choices?.[0]?.delta;
          if (delta?.content) {
            content += delta.content;
            yield delta.content;
          }
          for (const chunk of delta?.tool_calls || []) {
            const call = calls.get(chunk.index) || {
              id: '', type: 'function', function: { name: '', arguments: '' }
            };
            call.id += chunk.id || '';
            call.function.name += chunk.function?.name || '';
            call.function.arguments += chunk.function?.arguments || '';
            calls.set(chunk.index, call);
          }
        }
        if (!calls.size) return;
        messages.push({ role: 'assistant', content: content || null, tool_calls: [...calls.values()] });
        for (const call of calls.values()) {
          let args;
          try { args = JSON.parse(call.function.arguments); } catch { args = null; }
          const result = await execute(call.function.name, args);
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        }
      }
    },
    async *tts({ text, signal }) {
      const response = await post('audio/speech', {
        model: config.ttsModel, voice: config.ttsVoice, input: text, response_format: 'pcm'
      }, signal);
      let remainder = Buffer.alloc(0);
      for await (const bytes of response.body) {
        const buffer = Buffer.concat([remainder, bytes]);
        const end = buffer.length - buffer.length % 2;
        if (end) yield buffer.subarray(0, end);
        remainder = buffer.subarray(end);
      }
      if (remainder.length) throw new Error('Incomplete PCM sample');
    }
  };
}

async function* sse(response) {
  let pending = '';
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      yield JSON.parse(data);
    }
  }
  throw new Error('OpenAI stream ended without a completion marker');
}

module.exports = { mockProviders, liveProviders, localAudio, fallback, goodbye, script };

