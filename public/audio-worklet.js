/**
 * AudioWorkletProcessor thu âm chuẩn 16kHz PCM 16-bit Little-Endian,
 * tích hợp:
 * - Tự động chuẩn hóa tần số lấy mẫu về 16000Hz nếu thiết bị chạy ở 44.1kHz / 48kHz
 * - Bộ đệm đón đầu (Pre-roll Ring Buffer 240ms) chống mất phụ âm đầu câu
 * - Khuếch đại mềm (Soft-knee Makeup Gain 2.2x) giúp giọng nhỏ vẫn rõ nét
 * - Hysteresis Noise Gate & 900ms đuôi im lặng chuẩn cho Gemini Live VAD
 */
class PcmNoiseGateProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.noiseThreshold = 0.003; // Ngưỡng bắt đầu giọng nói (phù hợp mic thực tế 0.002-0.025)
    this.silenceMsThreshold = 850; // Thời gian nghỉ tự nhiên giữa các vế câu tiếng Việt (ms)
    this.minVoiceMs = 220; // Bỏ qua tiếng click/chạm mic ngắn < 220ms
    this.speechGain = 2.2; // Khuếch đại mềm cho giọng nói nhỏ

    this.isSpeaking = false;
    this.lastVoiceTimeMs = 0;
    this.activeVoiceMs = 0;
    this.processedSamples16k = 0;

    // Bộ đệm đón đầu 240ms ở 16kHz (3840 mẫu) để không bao giờ cắt chữ đầu câu
    this.preRollSize = 3840;
    this.preRollRing = new Int16Array(this.preRollSize);
    this.preRollWrite = 0;
    this.preRollCount = 0;

    // Bộ đệm gửi đi (2048 mẫu = 128ms mỗi gói ở 16kHz)
    this.bufferSize = 2048;
    this.accumBuffer = new Int16Array(this.bufferSize);
    this.accumIndex = 0;

    // Bộ tích lũy lấy mẫu xuống 16kHz khi AudioContext phần cứng chạy > 16kHz
    this.resamplePos = 0;

    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (typeof data.noiseThreshold === 'number') {
        this.noiseThreshold = Math.max(0.0008, data.noiseThreshold);
      }
      if (typeof data.silenceMsThreshold === 'number') {
        this.silenceMsThreshold = Math.max(400, data.silenceMsThreshold);
      }
      if (typeof data.speechGain === 'number') {
        this.speechGain = Math.max(1.0, Math.min(4.0, data.speechGain));
      }
    };
  }

  _pushSample16k(int16Sample, rms) {
    this.accumBuffer[this.accumIndex++] = int16Sample;
    if (this.accumIndex >= this.bufferSize) {
      this.flushBuffer(rms);
    }
  }

  _pushPreRoll(int16Sample) {
    this.preRollRing[this.preRollWrite] = int16Sample;
    this.preRollWrite = (this.preRollWrite + 1) % this.preRollSize;
    if (this.preRollCount < this.preRollSize) {
      this.preRollCount += 1;
    }
  }

  _flushPreRollToAccum(rms) {
    if (this.preRollCount === 0) return;
    const startIdx =
      (this.preRollWrite - this.preRollCount + this.preRollSize) %
      this.preRollSize;
    for (let k = 0; k < this.preRollCount; k++) {
      const sample = this.preRollRing[(startIdx + k) % this.preRollSize];
      this._pushSample16k(sample, rms);
    }
    this.preRollCount = 0;
  }

  _appendCleanSilenceTail(samplesCount = 11200) {
    // Đẩy ~700ms mẫu 0 vào cuối câu để bộ phát hiện giọng nói của Gemini nhận diện dứt câu tức thì
    for (let i = 0; i < samplesCount; i++) {
      this._pushSample16k(0, 0);
    }
    this.flushBuffer(0);
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) return true;

    const channelData = input[0];
    const inLen = channelData.length;
    const actualRate = typeof sampleRate === 'number' && sampleRate > 0 ? sampleRate : 16000;

    // 1. Tính năng lượng RMS trên khung gốc
    let sumSquares = 0;
    for (let i = 0; i < inLen; i++) {
      const s = channelData[i];
      sumSquares += s * s;
    }
    const rms = Math.sqrt(sumSquares / inLen);

    // 2. Chuyển đổi sang mẫu 16kHz + khuếch đại mềm (Soft-knee tanh)
    const ratio = actualRate / 16000;
    const outSamples = [];
    if (Math.abs(ratio - 1) < 0.01) {
      for (let i = 0; i < inLen; i++) {
        const boosted = Math.tanh(channelData[i] * this.speechGain);
        outSamples.push(boosted < 0 ? boosted * 0x8000 : boosted * 0x7fff);
      }
    } else {
      while (this.resamplePos < inLen) {
        const idx = Math.min(inLen - 1, Math.floor(this.resamplePos));
        const boosted = Math.tanh(channelData[idx] * this.speechGain);
        outSamples.push(boosted < 0 ? boosted * 0x8000 : boosted * 0x7fff);
        this.resamplePos += ratio;
      }
      this.resamplePos -= inLen;
    }

    const frameDurationMs = (outSamples.length / 16000) * 1000;
    this.processedSamples16k += outSamples.length;
    const nowMs = (this.processedSamples16k / 16000) * 1000;

    // 3. Hysteresis VAD: ngưỡng duy trì câu thấp hơn ngưỡng bắt đầu để không cắt giữa chừng
    const startGate = this.noiseThreshold;
    const holdGate = Math.max(0.0009, this.noiseThreshold * 0.35);
    const aboveGate = rms >= (this.isSpeaking ? holdGate : startGate);

    if (aboveGate) {
      if (!this.isSpeaking) {
        this.isSpeaking = true;
        this.activeVoiceMs = 0;
        this.port.postMessage({ type: 'speech_start', rms });
        this._flushPreRollToAccum(rms);
      }
      this.activeVoiceMs += frameDurationMs;
      this.lastVoiceTimeMs = nowMs;
    } else if (
      this.isSpeaking &&
      nowMs - this.lastVoiceTimeMs >= this.silenceMsThreshold
    ) {
      this.isSpeaking = false;
      const voicedMs = Math.round(this.activeVoiceMs);
      this.activeVoiceMs = 0;
      if (voicedMs >= this.minVoiceMs) {
        this._appendCleanSilenceTail(11200);
        this.port.postMessage({
          type: 'speech_end',
          silenceMs: Math.round(nowMs - this.lastVoiceTimeMs),
          activeVoiceMs: voicedMs,
        });
      } else {
        this.accumIndex = 0;
        this.port.postMessage({
          type: 'speech_cancel',
          activeVoiceMs: voicedMs,
        });
      }
    }

    // 4. Khi chưa nói: lưu vào bộ đệm đón đầu 240ms
    if (!this.isSpeaking) {
      for (let i = 0; i < outSamples.length; i++) {
        this._pushPreRoll(outSamples[i]);
      }
      return true;
    }

    // 5. Khi đang trong câu nói (kể cả nhịp nghỉ ngắn giữa các từ): giữ nguyên 100% biên độ âm thanh
    for (let i = 0; i < outSamples.length; i++) {
      this._pushSample16k(outSamples[i], rms);
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
