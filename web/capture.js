class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = 16000 / sampleRate;
    this.phase = 0;
    this.sum = 0;
    this.count = 0;
    this.frame = new Int16Array(320);
    this.offset = 0;
  }
  process(inputs) {
    const samples = inputs[0]?.[0];
    if (!samples) return true;
    for (const value of samples) {
      this.sum += value;
      this.count++;
      this.phase += this.ratio;
      if (this.phase < 1) continue;
      this.phase -= 1;
      const mono = Math.max(-1, Math.min(1, this.sum / this.count));
      this.frame[this.offset++] = mono * (mono < 0 ? 32768 : 32767);
      this.sum = 0;
      this.count = 0;
      if (this.offset === this.frame.length) {
        this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
        this.frame = new Int16Array(320);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);

