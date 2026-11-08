/**
 * AudioWorkletProcessor thu âm chuẩn 16kHz PCM 16-bit Little-Endian,
 * tích hợp RMS Noise Gate (chống tiếng ồn nền) và phát hiện ngắt câu (Hybrid VAD).
 */
class PcmNoiseGateProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.noiseThreshold = 0.012; // Ngưỡng RMS mặc định để cắt tiếng ồn nền
    this.silenceMsThreshold = 550; // Thời gian im lặng để đánh dấu dứt câu (ms)
    this.isSpeaking = false;
    this.lastVoiceTimeMs = 0;
    this.bufferSize = 2048;
    this.accumBuffer = new Int16Array(this.bufferSize);
    this.accumIndex = 0;

    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (typeof data.noiseThreshold === 'number') {
        this.noiseThreshold = data.noiseThreshold;
      }
      if (typeof data.silenceMsThreshold === 'number') {
        this.silenceMsThreshold = data.silenceMsThreshold;
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channelData = input[0];
    const len = channelData.length;

    // Tính năng lượng RMS của khung âm thanh hiện tại
    let sumSquares = 0;
    for (let i = 0; i < len; i++) {
      const sample = channelData[i];
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / len);
    const nowMs = (currentFrame / sampleRate) * 1000;

    const aboveGate = rms >= this.noiseThreshold;

    if (aboveGate) {
      if (!this.isSpeaking) {
        this.isSpeaking = true;
        this.port.postMessage({ type: 'speech_start', rms });
      }
      this.lastVoiceTimeMs = nowMs;
    } else if (this.isSpeaking && nowMs - this.lastVoiceTimeMs >= this.silenceMsThreshold) {
      this.isSpeaking = false;
      this.flushBuffer();
      this.port.postMessage({
        type: 'speech_end',
        silenceMs: Math.round(nowMs - this.lastVoiceTimeMs),
      });
    }

    // Nếu dưới ngưỡng Noise Gate và không đang trong câu nói thì bỏ qua tạp âm nền
    if (!aboveGate && !this.isSpeaking) {
      return true;
    }

    for (let i = 0; i < len; i++) {
      // Nếu mẫu dưới cổng ồn khi đang ngắt nhịp, làm suy giảm để tránh gửi tiếng ù
      const raw = aboveGate ? channelData[i] : channelData[i] * 0.15;
      const clamped = Math.max(-1, Math.min(1, raw));
      this.accumBuffer[this.accumIndex++] =
        clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;

      if (this.accumIndex >= this.bufferSize) {
        this.flushBuffer(rms);
      }
    }

    return true;
  }

  flushBuffer(rms = 0) {
    if (this.accumIndex === 0) return;
    const chunk = this.accumBuffer.slice(0, this.accumIndex);
    this.accumIndex = 0;
    this.port.postMessage(
      {
        type: 'pcm_chunk',
        pcm16: chunk.buffer,
        rms,
      },
      [chunk.buffer]
    );
  }
}

registerProcessor('pcm-noise-gate-processor', PcmNoiseGateProcessor);
