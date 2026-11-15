const { randomUUID } = require('node:crypto');
const { fallback, goodbye, localAudio } = require('./providers');

const FRAME_MS = 20;
const elapsed = (start, end = performance.now()) => Math.round(end - start);

class Vad {
  constructor(config) {
    this.threshold = config.threshold;
    this.silenceMs = config.silenceMs;
    this.reset();
  }
  reset() {
    this.active = false;
    this.voiced = 0;
    this.quiet = 0;
  }
  accept(frame, now) {
    let sum = 0;
    for (let pos = 0; pos < frame.length; pos += 2) sum += (frame.readInt16LE(pos) / 32768) ** 2;
    const voice = Math.sqrt(sum / (frame.length / 2)) >= this.threshold;
    if (!this.active && !voice) return {};
    const start = !this.active;
    this.active = true;
    if (voice) {
      this.voiced += FRAME_MS;
      this.quiet = 0;
      this.lastVoice = now;
    } else {
      this.quiet += FRAME_MS;
    }
    if (this.quiet < this.silenceMs) return { start, voice, confirmed: this.voiced === 100 };
    const end = this.lastVoice;
    const valid = this.voiced >= 180;
    this.reset();
    return { end, valid };
  }
}

const transitions = {
  idle: ['listening', 'ended'],
  listening: ['thinking', 'speaking', 'ended'],
  thinking: ['speaking', 'listening', 'ended'],
  speaking: ['listening', 'ended'],
  ended: []
};

class Session {
  constructor({ config, providers, store, socket }) {
    Object.assign(this, { config, providers, store, socket });
    this.vad = new Vad(config);
    this.status = 'idle';
    this.turnIndex = 0;
    this.record = {
      id: randomUUID(), started_at: new Date().toISOString(), ended_at: null,
      end_reason: null, config: config.summary, transcript: [], metrics: [], errors: []
    };
    this.save();
    this.maxTimer = setTimeout(() => this.closeWithGoodbye('max_duration'), config.maxCallMs);
    this.resetIdle();
  }

  save() { this.store.save(this.record); }
  event(type, fields = {}) {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify({ type, ...fields }));
  }
  state(next) {
    if (next === this.status) return;
    if (!transitions[this.status].includes(next)) throw new Error('Invalid session transition');
    this.status = next;
    this.event('state', { state: next, turn_id: this.reply?.id });
  }
  resetIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.closeWithGoodbye('silence_timeout'), this.config.idleMs);
  }
  attach(socket) {
    this.socket = socket;
    this.state('listening');
  }
  receive(data) {
    if (Buffer.isBuffer(data)) {
      if (data.length === 640 && !this.closing) this.frame(data);
      return;
    }
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'end_call') this.end('user_ended');
    const turn = this.reply;
    if (!turn || turn.id !== msg.turn_id) return;
    if (msg.type === 'playback' || msg.type === 'interrupt') this.acknowledge(turn, msg.played_sentences);
    if (msg.type === 'interrupt' && !this.closing) this.interrupt();
    if (msg.type === 'playback_done' && turn.sent) this.finishReply(turn);
    if (msg.type === 'playback_started' && turn.metrics && turn.metrics.playback_start_ms == null) {
      turn.metrics.playback_start_ms = elapsed(turn.lastVoice);
      this.save();
    }
  }

  frame(frame) {
    const now = performance.now();
    const event = this.vad.accept(frame, now);
    if (event.confirmed) {
      this.resetIdle();
      this.interrupt();
    }
    if (event.start) {
      const controller = new AbortController();
      const capture = { controller };
      this.capture = capture;
      try {
        capture.stream = this.providers.stt({
          signal: controller.signal, turnIndex: this.turnIndex,
          partial: text => {
            if (!controller.signal.aborted && (this.capture === capture || this.reply?.capture === capture)) {
              this.event('transcript_partial', { text });
            }
          }
        });
      } catch (error) {
        capture.error = error;
      }
    }
    const capture = this.capture;
    if (!capture) return;
    try { capture.stream?.write(frame); } catch (error) { capture.error = error; }
    if (event.voice && this.vad.voiced >= 100 && now - (this.lastIdleRefresh || 0) >= 1000) {
      this.resetIdle();
      this.lastIdleRefresh = now;
    }
    if (event.end === undefined) return;
    this.capture = null;
    if (!event.valid) {
      capture.controller.abort();
      this.event('transcript_partial', { text: '' });
      return;
    }
    this.interrupt();
    const turn = this.createReply(event.end, capture);
    this.state('thinking');
    void this.run(turn);
  }

  createReply(lastVoice, capture) {
    const turn = {
      id: randomUUID(), lastVoice, capture, controller: new AbortController(),
      sentences: [], played: 0, completed: 0, toolCalls: [], sent: false
    };
    this.reply = turn;
    return turn;
  }

  async run(turn) {
    const { capture, controller, id } = turn;
    const signal = controller.signal;
    const metrics = {
      turn_id: id, vad_end_ms: elapsed(turn.lastVoice), stt_final_ms: null,
      llm_first_token_ms: null, tts_first_audio_ms: null, total_ms: null, playback_start_ms: null
    };
    turn.metrics = metrics;
    let stage = 'stt';
    try {
      const timeout = setTimeout(() => capture.controller.abort(new Error('STT timed out')), this.config.providerTimeoutMs);
      let text;
      try {
        if (capture.error) throw capture.error;
        const sttSignal = capture.controller.signal;
        text = (await Promise.race([
          capture.stream.finish(),
          new Promise((_, reject) => {
            if (sttSignal.aborted) reject(sttSignal.reason);
            else sttSignal.addEventListener('abort', () => reject(sttSignal.reason), { once: true });
          })
        ])).trim();
      } finally {
        clearTimeout(timeout);
        capture.controller.abort();
      }
      if (this.reply !== turn) return;
      metrics.stt_final_ms = elapsed(turn.lastVoice) - metrics.vad_end_ms;
      this.event('transcript_partial', { text: '' });
      if (!text) {
        this.finishReply(turn);
        return;
      }
      this.turnIndex++;
      this.record.transcript.push({ turn_id: id, role: 'user', text, interrupted: false });
      this.record.metrics.push(metrics);
      this.event('transcript_final', { text, turn_id: id });
      this.save();
      stage = 'llm';
      const history = this.record.transcript.filter(item => item.text).map(item => ({
        role: item.role === 'agent' ? 'assistant' : 'user', content: item.text
      }));
      const providerSignal = AbortSignal.any([signal, AbortSignal.timeout(this.config.providerTimeoutMs)]);
      let pending = '';
      let speech = Promise.resolve();
      let speechError;
      function enqueue(session, sentence) {
        speech = speech.then(async () => {
          if (!speechError && !signal.aborted) await session.speak(turn, sentence);
        }).catch(error => { speechError = error; });
      }
      let generationError;
      try {
        for await (const text of this.providers.llm({
          history, signal: providerSignal,
          execute: (name, args) => this.execute(turn, name, args)
        })) {
          if (signal.aborted) break;
          metrics.llm_first_token_ms ??= elapsed(turn.lastVoice) - metrics.vad_end_ms - metrics.stt_final_ms;
          pending += text;
          let split;
          while ((split = /[.!?](?=\s|$)/.exec(pending))) {
            const at = split.index + 1;
            enqueue(this, pending.slice(0, at).trim());
            pending = pending.slice(at);
          }
        }
      } catch (error) { generationError = error; }
      if (pending.trim() && !generationError) enqueue(this, pending.trim());
      await speech;
      if (speechError) {
        stage = 'tts';
        throw speechError;
      }
      if (generationError) throw generationError;
      if (!turn.sentences.length && !signal.aborted) throw new Error('LLM returned an empty reply');
    } catch (error) {
      if (this.reply !== turn || signal.aborted) return;
      this.logError(stage, error);
      this.event('transcript_partial', { text: '' });
      await this.sayFallback(turn);
    }
    if (this.reply === turn) this.endReply(turn);
  }

  async execute(turn, name, args) {
    let result;
    try {
      if (name !== 'get_current_time' || !args || Array.isArray(args) ||
          typeof args !== 'object' || Object.keys(args).length) throw new Error('Invalid tool call');
      result = { utc: new Date().toISOString() };
    } catch (error) {
      this.logError('tool', error);
      result = { error: 'The clock tool could not complete the request.' };
    }
    turn.toolCalls.push({ name, args, result });
    if (this.config.summary.mode === 'mock' && result.utc) {
      this.event('tool_result', { turn_id: turn.id, text: 'UTC · ' + result.utc });
    }
    return result;
  }

  async speak(turn, text, adapter = this.providers.tts) {
    const baseSignal = turn.controller.signal;
    const signal = AbortSignal.any([baseSignal, AbortSignal.timeout(this.config.providerTimeoutMs)]);
    let index;
    try {
      for await (const audio of adapter({ text, signal })) {
        if (this.reply !== turn || this.status === 'ended') return;
        if (!audio.length) continue;
        if (index === undefined) {
          index = turn.sentences.push(text) - 1;
          this.state('speaking');
          this.event('agent_text', { text, turn_id: turn.id, sentence: index });
          if (turn.metrics?.total_ms == null && turn.metrics) {
            const metrics = turn.metrics;
            metrics.total_ms = elapsed(turn.lastVoice);
            metrics.tts_first_audio_ms = metrics.llm_first_token_ms == null ? null :
              metrics.total_ms - metrics.vad_end_ms - metrics.stt_final_ms - metrics.llm_first_token_ms;
            this.save();
          }
        }
        this.event('agent_audio', { turn_id: turn.id, sentence: index });
        if (this.socket?.readyState === 1) this.socket.send(audio);
      }
    } catch (error) {
      if (this.reply === turn && index !== undefined) {
        turn.sentences[index] = '';
        turn.completed = index + 1;
        this.event('sentence_end', { turn_id: turn.id, sentence: index });
      }
      throw error;
    }
    if (index === undefined && !signal.aborted) throw new Error('TTS returned no audio');
    if (this.reply !== turn || index === undefined) return;
    turn.completed = index + 1;
    this.event('sentence_end', { turn_id: turn.id, sentence: index });
  }

  async sayFallback(turn) {
    try {
      await this.speak(turn, fallback, localAudio);
    } catch (error) {
      if (this.reply !== turn) return;
      this.logError('fallback', error);
      this.event('agent_text', { text: fallback, turn_id: turn.id });
    }
  }

  logError(stage, error) {
    const code = stage.toUpperCase() + '_FAILED';
    this.record.errors.push({ stage, code, message: error.message, timestamp: new Date().toISOString() });
    this.event('error', { code, message: 'The ' + stage + ' stage encountered a problem.' });
    this.save();
  }

  endReply(turn) {
    turn.sent = true;
    this.event('reply_end', { turn_id: turn.id });
    turn.timer = setTimeout(() => this.finishReply(turn, true), this.config.playbackTimeoutMs);
  }

  acknowledge(turn, count) {
    if (Number.isSafeInteger(count)) turn.played = Math.max(turn.played, Math.min(count, turn.completed));
  }

  interrupt() {
    if (!this.reply) return;
    const turn = this.reply;
    this.event('interrupted', { turn_id: turn.id });
    this.finishReply(turn, true);
  }

  finishReply(turn, interrupted = false) {
    if (this.reply !== turn) return;
    clearTimeout(turn.timer);
    turn.controller.abort();
    turn.capture?.controller.abort();
    if (turn.sentences.length || interrupted || turn.toolCalls.length) {
      this.record.transcript.push({
        turn_id: turn.id, role: 'agent', text: turn.sentences.slice(0, turn.played).filter(Boolean).join(' '),
        interrupted, tool_calls: turn.toolCalls
      });
      this.save();
    }
    this.reply = null;
    if (this.closing) this.end(this.closing);
    else this.state('listening');
  }

  async closeWithGoodbye(reason) {
    if (!this.socket || this.closing || this.status === 'ended') {
      if (!this.socket) this.end(reason);
      return;
    }
    this.capture?.controller.abort();
    this.capture = null;
    this.interrupt();
    this.closing = reason;
    const turn = this.createReply();
    try {
      await this.speak(turn, goodbye, localAudio);
    } catch (error) {
      if (this.reply === turn) this.logError('goodbye', error);
    }
    if (this.reply === turn) this.endReply(turn);
  }

  end(reason) {
    if (this.status === 'ended' || this.ending) return;
    this.ending = true;
    clearTimeout(this.idleTimer);
    clearTimeout(this.maxTimer);
    this.capture?.controller.abort();
    if (this.reply) this.finishReply(this.reply, true);
    this.record.ended_at = new Date().toISOString();
    this.record.end_reason = reason;
    this.state('ended');
    this.save();
    this.event('call_ended', { reason });
    this.socket?.close();
  }
}

module.exports = { Session, Vad };


