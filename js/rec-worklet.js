/* 听歌识曲录音处理器（AudioWorklet）：采集单声道 Float32 PCM
 * 采样率由 AudioContext({ sampleRate: 8000 }) 决定（Shazam v2 指纹需要 8kHz）
 *  - start：开始录音，缓冲 duration*8000 个采样
 *  - 每帧仅上报进度（不传缓冲，避免结构化克隆开销）
 *  - 录满 / 收到 stop 后一次性回传 Float32Array 缓冲
 */
class TimedRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.max_length = 0;
    this.recbuffer = new Float32Array(0);
    this.recording = false;
    this.buf_index = 0;
    this.port.onmessage = (event) => {
      const d = event.data || {};
      if (d.message === 'start') {
        this.max_length = Math.round((d.duration || 6) * 8000);
        this.recbuffer = new Float32Array(this.max_length);
        this.buf_index = 0;
        this.recording = true;
        this.port.postMessage({ message: 'started' });
      } else if (d.message === 'stop' && this.recording) {
        this._finish();
      }
    };
  }
  _finish() {
    this.recording = false;
    const out = this.recbuffer.slice(0, Math.max(0, this.buf_index));
    this.port.postMessage({ message: 'finished', recording: out });
  }
  process(inputs) {
    if (!this.recording) return true;
    const ch = inputs && inputs[0] && inputs[0][0];
    if (!ch) return true;
    if (this.buf_index + ch.length > this.max_length) {
      this.recbuffer.set(ch.subarray(0, Math.max(0, this.max_length - this.buf_index)), this.buf_index);
      this.buf_index = this.max_length;
      this._finish();
      return true;
    }
    this.recbuffer.set(ch, this.buf_index);
    this.buf_index += ch.length;
    return true;
  }
}

registerProcessor('timed-recorder', TimedRecorder);
