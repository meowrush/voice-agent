const $ = id => document.getElementById(id);
const toggle = $('toggle'), status = $('status'), messages = $('messages');
const labels = {
  idle: 'Ready to call', connecting: 'Connecting…', listening: 'Listening',
  thinking: 'Thinking…', speaking: 'Assistant speaking', ended: 'Call ended', disconnected: 'Disconnected'
};
let call;

function setStatus(state) {
  status.textContent = labels[state];
  status.dataset.state = state;
  document.querySelector('.call').dataset.active = ['listening', 'thinking', 'speaking'].includes(state);
}

function showError(message) {
  $('error').textContent = message;
  $('error').hidden = !message;
}

function partial(text) {
  $('partial').textContent = text;
  $('partial').hidden = !text;
}

function message(role, text) {
  $('empty').hidden = true;
  const row = document.createElement('div');
  row.className = 'message ' + role;
  const name = document.createElement('strong');
  name.textContent = role === 'user' ? 'You' : 'Assistant';
  const body = document.createElement('span');
  body.textContent = text;
  row.append(name, body);
  messages.append(row);
  messages.scrollTop = messages.scrollHeight;
  return row;
}

function send(current, type, fields = {}) {
  if (current.ws?.readyState === WebSocket.OPEN) current.ws.send(JSON.stringify({ type, ...fields }));
}

function stopOutput(current, markInterrupted = false) {
  const output = current.output;
  if (!output) return;
  for (const source of output.sources) {
    source.onended = null;
    try { source.stop(); } catch {}
  }
  if (markInterrupted && output.row) {
    const label = document.createElement('small');
    label.textContent = 'Interrupted';
    output.row.append(label);
  }
  current.output = null;
  current.nextAudio = 0;
}

function dispose(current, state) {
  if (call !== current) return;
  call = null;
  clearTimeout(current.endTimer);
  stopOutput(current);
  current.capture?.disconnect();
  current.mic?.getTracks().forEach(track => track.stop());
  current.audio?.close().catch(() => {});
  current.ws?.close();
  toggle.textContent = 'Start Call';
  toggle.disabled = false;
  setStatus(state);
  partial('');
  if (current.id) {
    $('session').href = '/sessions/' + current.id;
    $('session').hidden = false;
  }
}

function outputFor(current, id) {
  if (current.ignored.has(id)) return null;
  if (id !== current.output?.id) {
    stopOutput(current);
    current.output = { id, sources: new Set(), parts: new Map(), played: 0, ended: false, voiced: 0 };
  }
  return current.output;
}

function playbackProgress(current, output) {
  if (current.output !== output) return;
  const previous = output.played;
  while (output.parts.get(output.played)?.ended && !output.parts.get(output.played).pending) output.played++;
  if (previous !== output.played) send(current, 'playback', { turn_id: output.id, played_sentences: output.played });
  if (output.ended && output.sources.size === 0) {
    send(current, 'playback_done', { turn_id: output.id });
    stopOutput(current);
  }
}

function playChunk(current, data, info) {
  if (!info || data.byteLength % 2) return;
  const output = outputFor(current, info.turn_id);
  if (!output) return;
  const audio = current.audio;
  const audioBuffer = audio.createBuffer(1, data.byteLength / 2, 24000);
  const channel = audioBuffer.getChannelData(0);
  const pcm = new DataView(data);
  for (let i = 0; i < channel.length; i++) channel[i] = pcm.getInt16(i * 2, true) / 32768;
  const source = audio.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(current.speaker);
  const part = output.parts.get(info.sentence) || { pending: 0, ended: false };
  output.parts.set(info.sentence, part);
  part.pending++;
  output.sources.add(source);
  source.onended = () => {
    output.sources.delete(source);
    part.pending--;
    playbackProgress(current, output);
  };
  const start = Math.max(current.nextAudio, audio.currentTime + 0.025);
  current.nextAudio = start + audioBuffer.duration;
  source.start(start);
  if (!output.started) {
    output.started = true;
    setTimeout(() => {
      if (current.output === output) send(current, 'playback_started', { turn_id: output.id });
    }, (start - audio.currentTime) * 1000);
  }
}

function handle(current, data) {
  if (call !== current) return;
  if (typeof data !== 'string') {
    playChunk(current, data, current.audioInfo);
    current.audioInfo = null;
    return;
  }
  const event = JSON.parse(data);
  switch (event.type) {
    case 'state':
      if (event.state !== 'ended') setStatus(event.state);
      if (event.turn_id && ['thinking', 'speaking'].includes(event.state)) outputFor(current, event.turn_id);
      break;
    case 'transcript_partial': partial(event.text); break;
    case 'transcript_final': partial(''); message('user', event.text); break;
    case 'agent_text': {
      const output = outputFor(current, event.turn_id);
      if (!output) break;
      if (!output.row) output.row = message('assistant', event.text);
      else output.row.children[1].append(' ' + event.text);
      messages.scrollTop = messages.scrollHeight;
      break;
    }
    case 'tool_result': message('assistant', event.text); break;
    case 'agent_audio': current.audioInfo = event; break;
    case 'sentence_end': {
      const output = current.output;
      const part = output?.parts.get(event.sentence);
      if (output?.id === event.turn_id && part) {
        part.ended = true;
        playbackProgress(current, output);
      }
      break;
    }
    case 'reply_end': {
      const output = outputFor(current, event.turn_id);
      if (output) {
        output.ended = true;
        playbackProgress(current, output);
      }
      break;
    }
    case 'interrupted':
      current.ignored.add(event.turn_id);
      if (current.output?.id === event.turn_id) stopOutput(current, true);
      break;
    case 'error': showError(event.message); break;
    case 'call_ended': dispose(current, 'ended'); break;
  }
}

function capture(current, frame) {
  if (current.ws?.readyState !== WebSocket.OPEN) return;
  const output = current.output;
  if (output?.sources.size) {
    const samples = new Int16Array(frame);
    let sum = 0;
    for (const sample of samples) sum += (sample / 32768) ** 2;
    const rms = Math.sqrt(sum / samples.length);
    output.voiced = rms >= current.threshold ? output.voiced + 1 : 0;
    if (output.voiced >= 4) {
      current.ignored.add(output.id);
      send(current, 'interrupt', { turn_id: output.id, played_sentences: output.played });
      stopOutput(current, true);
      setStatus('listening');
    }
  }
  if (current.ws.bufferedAmount > 128000) {
    showError('Audio connection is too slow.');
    dispose(current, 'disconnected');
    return;
  }
  current.ws.send(frame);
}

async function start() {
  const current = { ignored: new Set(), nextAudio: 0 };
  call = current;
  toggle.disabled = true;
  setStatus('connecting');
  showError('');
  $('session').hidden = true;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Use localhost or HTTPS to enable the microphone.');
    current.mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
    });
    current.audio = new AudioContext();
    await current.audio.resume();
    await current.audio.audioWorklet.addModule('/capture.js');
    current.capture = new AudioWorkletNode(current.audio, 'pcm-capture');
    current.speaker = current.audio.createGain();
    current.speaker.connect(current.audio.destination);
    const silent = current.audio.createGain();
    silent.gain.value = 0;
    current.audio.createMediaStreamSource(current.mic).connect(current.capture).connect(silent).connect(current.audio.destination);
    const response = await fetch('/sessions', { method: 'POST' });
    if (!response.ok) throw new Error('Could not create a call.');
    const session = await response.json();
    current.id = session.session_id;
    current.threshold = session.vad_threshold;
    $('mode').textContent = session.mode === 'mock' ? 'Scripted demo' : 'Live providers';
    $('mode').hidden = false;
    for (const row of messages.querySelectorAll('.message')) row.remove();
    $('empty').hidden = false;
    const url = new URL('/ws/voice', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('session_id', current.id);
    current.ws = new WebSocket(url);
    current.ws.binaryType = 'arraybuffer';
    current.ws.onopen = () => {
      toggle.textContent = 'End Call';
      toggle.disabled = false;
    };
    current.ws.onmessage = event => handle(current, event.data);
    current.ws.onclose = () => dispose(current, 'disconnected');
    current.capture.port.onmessage = event => capture(current, event.data);
  } catch (error) {
    const denied = ['NotAllowedError', 'PermissionDeniedError'].includes(error.name);
    showError(denied ? 'Microphone permission was denied. Allow access in your browser and try again.' : error.message);
    dispose(current, 'idle');
  }
}

toggle.addEventListener('click', () => {
  if (!call) {
    void start();
    return;
  }
  const current = call;
  toggle.disabled = true;
  send(current, 'end_call');
  current.endTimer = setTimeout(() => dispose(current, 'disconnected'), 2000);
});


