import { GoogleGenAI, Modality } from 'https://esm.sh/@google/genai';

const btnToggleMic = document.getElementById('btnToggleMic');
const micBtnLabel = document.getElementById('micBtnLabel');
const connectionBadge = document.getElementById('connectionBadge');
const connectionText = document.getElementById('connectionText');
const vnTranscriptBox = document.getElementById('vnTranscriptBox');
const enTranscriptBox = document.getElementById('enTranscriptBox');
const vnStatusTag = document.getElementById('vnStatusTag');
const enStatusTag = document.getElementById('enStatusTag');
const speedSlider = document.getElementById('speedSlider');
const speedValueLabel = document.getElementById('speedValueLabel');
const noiseGateSlider = document.getElementById('noiseGateSlider');
const noiseGateValueLabel = document.getElementById('noiseGateValueLabel');
const latencyList = document.getElementById('latencyList');
const avgLatencyLabel = document.getElementById('avgLatencyLabel');
const btnClearHistory = document.getElementById('btnClearHistory');
const chkBackgroundMode = document.getElementById('chkBackgroundMode');
const chkFilterFillers = document.getElementById('chkFilterFillers');
const modelSelect = document.getElementById('modelSelect');
const quickTextForm = document.getElementById('quickTextForm');
const quickTextInput = document.getElementById('quickTextInput');
const bgKeepAliveAudio = document.getElementById('bgKeepAliveAudio');

let liveClientSession = null;
let isRecording = false;
let micContext = null;
let playbackContext = null;
let micStream = null;
let workletNode = null;
let wakeLockSentinel = null;
let nextPlayTime = 0;
let activeAudioSources = [];
let playbackSpeed = parseFloat(speedSlider.value) || 1.2;

let turnCounter = 0;
let currentTurnStartMs = null;
let currentTurnFirstByteMs = null;
let currentVnItem = null;
let currentEnItem = null;
const latencyHistory = [];

const STANDALONE_FILLER_REGEX = /^[\s,.;:!?…\-–—]*(?:à+|ừ+|ờ+|ừm+|ờm+|ưm+|ạ+|ơ+|hơ+|ạ\s*ừm+|à\s*ừm+|à\s*ừ+|uh+|um+|hmm+)[\s,.;:!?…\-–—]*$/i;
const TOKEN_FILLER_REGEX = /(?:^|(?<=[\s,.;:!?…\-–—]))(?:ạ\s+ừm+|à\s+ừm+|à\s+ừ+|ừ\s+à+|ừm+|ờm+|ưm+|à+|ừ+|ờ+|uh+|um+|hmm+)(?=$|[\s,.;:!?…\-–—])/giu;

export function cleanClientFillers(rawText, enabled = true) {
  if (!rawText || typeof rawText !== 'string') return '';
  if (!enabled) return rawText.trim();
  let t = rawText.trim();
  if (!t || STANDALONE_FILLER_REGEX.test(t)) return '';
  t = t.replace(TOKEN_FILLER_REGEX, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!t || STANDALONE_FILLER_REGEX.test(t)) return '';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function setStatus(state, text) {
  connectionBadge.dataset.state = state;
  connectionText.textContent = text;
  connectionBadge.title = text;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToInt16Array(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer);
}

function schedulePcm24kPlayback(base64Data) {
  if (!playbackContext) {
    playbackContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 24000,
    });
  }
  if (playbackContext.state === 'suspended') {
    playbackContext.resume();
  }

  const pcm16 = base64ToInt16Array(base64Data);
  if (pcm16.length === 0) return;

  const float32 = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    float32[i] = pcm16[i] / 32768;
  }

  const audioBuffer = playbackContext.createBuffer(1, float32.length, 24000);
  audioBuffer.getChannelData(0).set(float32);

  const source = playbackContext.createBufferSource();
  source.buffer = audioBuffer;
  source.playbackRate.value = playbackSpeed;
  source.connect(playbackContext.destination);

  const now = playbackContext.currentTime;
  const startAt = Math.max(now, nextPlayTime);
  source.start(startAt);

  const effectiveDuration = audioBuffer.duration / playbackSpeed;
  nextPlayTime = startAt + effectiveDuration;

  activeAudioSources.push(source);
  source.onended = () => {
    activeAudioSources = activeAudioSources.filter((s) => s !== source);
  };
}

function clearAudioQueue() {
  for (const src of activeAudioSources) {
    try {
      src.stop();
    } catch {}
  }
  activeAudioSources = [];
  if (playbackContext) {
    nextPlayTime = playbackContext.currentTime;
  }
}

function appendOrUpdateUtterance(box, currentItem, text, tagLabel) {
  const hint = box.querySelector('.empty-hint');
  if (hint) hint.remove();

  if (!currentItem) {
    const item = document.createElement('div');
    item.className = 'utterance-item';
    const contentSpan = document.createElement('span');
    contentSpan.className = 'utterance-text';
    contentSpan.textContent = text.trim();
    const metaSpan = document.createElement('span');
    metaSpan.className = 'utterance-meta';
    metaSpan.textContent = tagLabel;
    item.appendChild(contentSpan);
    item.appendChild(metaSpan);
    box.appendChild(item);
    box.scrollTop = box.scrollHeight;
    return item;
  } else {
    const contentSpan = currentItem.querySelector('.utterance-text');
    const prev = contentSpan.textContent;
    const sep = prev.endsWith(' ') || text.startsWith(' ') ? '' : ' ';
    contentSpan.textContent = `${prev}${sep}${text}`.replace(/\s{2,}/g, ' ').trim();
    box.scrollTop = box.scrollHeight;
    return currentItem;
  }
}

function recordTurnLatency(ttfaMs, totalMs, previewText) {
  const hint = latencyList.querySelector('.empty-hint');
  if (hint) hint.remove();

  turnCounter += 1;
  const safeTtfa = Math.max(1, Math.round(ttfaMs));
  const safeTotal = Math.max(safeTtfa, Math.round(totalMs));
  latencyHistory.push(safeTtfa);

  const avg = Math.round(
    latencyHistory.reduce((sum, v) => sum + v, 0) / latencyHistory.length
  );
  avgLatencyLabel.textContent = `TB: ${avg} ms`;

  const row = document.createElement('div');
  row.className = 'latency-row';
  const shortText = previewText
    ? previewText.slice(0, 26) + (previewText.length > 26 ? '…' : '')
    : `Câu #${turnCounter}`;

  row.innerHTML = `
    <span><strong>#${turnCounter}</strong> ${shortText}</span>
    <span class="latency-ms">${safeTtfa} ms (Tổng: ${safeTotal} ms)</span>
  `;
  latencyList.prepend(row);
}

async function enableBackgroundKeepAlive() {
  if (!chkBackgroundMode.checked) return;

  if ('wakeLock' in navigator && document.visibilityState === 'visible') {
    try {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
    } catch {}
  }

  if (bgKeepAliveAudio && !bgKeepAliveAudio.src) {
    const sampleRate = 8000;
    const numSamples = sampleRate;
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);
    const writeStr = (offset, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + numSamples * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, numSamples * 2, true);
    const blob = new Blob([buffer], { type: 'audio/wav' });
    bgKeepAliveAudio.src = URL.createObjectURL(blob);
  }

  try {
    await bgKeepAliveAudio.play();
  } catch {}

  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'Phiên Dịch Gemini Live (Việt → Anh)',
      artist: 'Đang thu âm & dịch trong nền',
    });
    navigator.mediaSession.setActionHandler('pause', () => {
      if (isRecording) stopLiveSession();
    });
    navigator.mediaSession.setActionHandler('play', () => {
      if (!isRecording) startLiveSession();
    });
  }
}

document.addEventListener('visibilitychange', async () => {
  if (isRecording && chkBackgroundMode.checked) {
    if (document.visibilityState === 'visible' && 'wakeLock' in navigator) {
      try {
        wakeLockSentinel = await navigator.wakeLock.request('screen');
      } catch {}
    }
    if (micContext?.state === 'suspended') micContext.resume();
    if (playbackContext?.state === 'suspended') playbackContext.resume();
  }
});

function handleServerResponse(response) {
  const content = response?.serverContent;
  if (!content) return;
  const now = performance.now();

  if (content.modelTurn?.parts) {
    for (const part of content.modelTurn.parts) {
      if (part.inlineData?.data) {
        if (!currentTurnStartMs) currentTurnStartMs = now - 180;
        if (!currentTurnFirstByteMs) {
          currentTurnFirstByteMs = now;
          enStatusTag.textContent = `Phản hồi: ${Math.round(
            currentTurnFirstByteMs - currentTurnStartMs
          )} ms`;
        }
        schedulePcm24kPlayback(part.inlineData.data);
      }
      if (part.text) {
        if (!currentTurnStartMs) currentTurnStartMs = now - 180;
        if (!currentTurnFirstByteMs) {
          currentTurnFirstByteMs = now;
        }
        currentEnItem = appendOrUpdateUtterance(
          enTranscriptBox,
          currentEnItem,
          part.text,
          `${playbackSpeed.toFixed(2)}x`
        );
      }
    }
  }

  if (content.inputTranscription?.text) {
    const rawVn = content.inputTranscription.text;
    const cleanedVn = cleanClientFillers(rawVn, chkFilterFillers.checked);
    if (rawVn.trim().length > 0 && cleanedVn.length === 0) {
      vnStatusTag.textContent = `Đã lọc từ đệm: "${rawVn.trim()}"`;
    } else if (cleanedVn) {
      if (!currentTurnStartMs) currentTurnStartMs = now;
      vnStatusTag.textContent = 'Đang nhận tiếng Việt';
      currentVnItem = appendOrUpdateUtterance(
        vnTranscriptBox,
        currentVnItem,
        cleanedVn,
        `#${turnCounter + 1}`
      );
    }
  }

  if (content.outputTranscription?.text) {
    if (!currentTurnStartMs) currentTurnStartMs = now - 180;
    if (!currentTurnFirstByteMs) {
      currentTurnFirstByteMs = now;
      enStatusTag.textContent = `Phản hồi: ${Math.round(
        currentTurnFirstByteMs - currentTurnStartMs
      )} ms`;
    }
    currentEnItem = appendOrUpdateUtterance(
      enTranscriptBox,
      currentEnItem,
      content.outputTranscription.text,
      `${playbackSpeed.toFixed(2)}x`
    );
  }

  if (content.interrupted === true) {
    clearAudioQueue();
  }

  if (content.turnComplete === true) {
    if (currentTurnStartMs) {
      const ttfa = (currentTurnFirstByteMs || now) - currentTurnStartMs;
      const total = now - currentTurnStartMs;
      const preview =
        currentEnItem?.querySelector('.utterance-text')?.textContent ||
        currentVnItem?.querySelector('.utterance-text')?.textContent ||
        '';
      recordTurnLatency(ttfa, total, preview);
    }
    currentTurnStartMs = null;
    currentTurnFirstByteMs = null;
    currentVnItem = null;
    currentEnItem = null;
  }
}

async function connectDirectGeminiLive() {
  const model = modelSelect.value;
  const res = await fetch('/api/ephemeral-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error || `HTTP ${res.status}`);
  }

  const { token, systemInstruction } = await res.json();
  if (!token) {
    throw new Error('Không nhận được Ephemeral Token từ Server');
  }

  const ai = new GoogleGenAI({
    apiKey: token,
    vertexai: false,
    httpOptions: { apiVersion: 'v1alpha' },
  });

  const isTranslateModel = model.includes('translate');
  const liveConfig = isTranslateModel
    ? {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        translationConfig: {
          targetLanguageCode: 'en',
          echoTargetLanguage: false,
        },
      }
    : {
        responseModalities: [Modality.AUDIO],
        systemInstruction: {
          parts: [{ text: systemInstruction }],
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        contextWindowCompression: {
          slidingWindow: {},
        },
        sessionResumption: {},
      };

  const session = await ai.live.connect({
    model,
    config: liveConfig,
    callbacks: {
      onopen: () => {
        setStatus('active', 'Đã kết nối Live API');
      },
      onmessage: (response) => {
        handleServerResponse(response);
      },
      onerror: (err) => {
        setStatus('error', err?.message || 'Lỗi kết nối Live API');
      },
      onclose: () => {
        if (!isRecording) {
          setStatus('idle', 'Đã ngắt kết nối');
        }
      },
    },
  });

  setStatus('active', 'Đã kết nối Live API');
  return session;
}

async function startLiveSession() {
  try {
    setStatus('idle', 'Đang kết nối...');
    liveClientSession = await connectDirectGeminiLive();

    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true,
      },
    });

    micContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 16000,
    });
    await micContext.audioWorklet.addModule('/audio-worklet.js');

    const source = micContext.createMediaStreamSource(micStream);

    const highPass = micContext.createBiquadFilter();
    highPass.type = 'highpass';
    highPass.frequency.value = 85;

    const lowPass = micContext.createBiquadFilter();
    lowPass.type = 'lowpass';
    lowPass.frequency.value = 3400;

    workletNode = new AudioWorkletNode(micContext, 'pcm-noise-gate-processor');
    workletNode.port.postMessage({
      noiseThreshold: parseFloat(noiseGateSlider.value) || 0.012,
    });

    workletNode.port.onmessage = (event) => {
      const data = event.data;
      if (!liveClientSession) return;

      if (data.type === 'speech_start') {
        vnStatusTag.textContent = 'Đang nghe...';
      } else if (data.type === 'pcm_chunk') {
        liveClientSession.sendRealtimeInput({
          audio: {
            data: arrayBufferToBase64(data.pcm16),
            mimeType: 'audio/pcm;rate=16000',
          },
        });
      } else if (data.type === 'speech_end') {
        currentTurnStartMs = performance.now();
        currentTurnFirstByteMs = null;
        liveClientSession.sendRealtimeInput({
          audioStreamEnd: true,
        });
      }
    };

    source.connect(highPass);
    highPass.connect(lowPass);
    lowPass.connect(workletNode);

    await enableBackgroundKeepAlive();

    isRecording = true;
    btnToggleMic.classList.add('recording');
    micBtnLabel.textContent = 'Đang Bật Mic (Ấn Để Dừng)';
    setStatus('active', 'Đang nghe & dịch');
  } catch (err) {
    isRecording = false;
    btnToggleMic.classList.remove('recording');
    micBtnLabel.textContent = 'Ấn Để Bật Mic Nói';
    setStatus('error', err?.message || 'Không thể bật Mic');
  }
}

async function stopLiveSession() {
  isRecording = false;
  btnToggleMic.classList.remove('recording');
  micBtnLabel.textContent = 'Ấn Để Bật Mic Nói';
  setStatus('idle', 'Đã dừng');

  if (workletNode) {
    workletNode.disconnect();
    workletNode = null;
  }
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  if (micContext) {
    await micContext.close().catch(() => {});
    micContext = null;
  }
  if (wakeLockSentinel) {
    await wakeLockSentinel.release().catch(() => {});
    wakeLockSentinel = null;
  }
  if (bgKeepAliveAudio) {
    bgKeepAliveAudio.pause();
  }
  if (liveClientSession) {
    try {
      liveClientSession.close();
    } catch {}
    liveClientSession = null;
  }
  clearAudioQueue();
}

btnToggleMic.addEventListener('click', () => {
  if (isRecording) {
    stopLiveSession();
  } else {
    startLiveSession();
  }
});

speedSlider.addEventListener('input', () => {
  playbackSpeed = parseFloat(speedSlider.value) || 1.2;
  speedValueLabel.textContent = `${playbackSpeed.toFixed(2)}x`;
  for (const src of activeAudioSources) {
    try {
      src.playbackRate.value = playbackSpeed;
    } catch {}
  }
});

noiseGateSlider.addEventListener('input', () => {
  const val = parseFloat(noiseGateSlider.value) || 0.012;
  noiseGateValueLabel.textContent = val.toFixed(3);
  if (workletNode) {
    workletNode.port.postMessage({ noiseThreshold: val });
  }
});

btnClearHistory.addEventListener('click', () => {
  vnTranscriptBox.innerHTML = '<div class="empty-hint">Câu nói tiếng Việt hiển thị tại đây...</div>';
  enTranscriptBox.innerHTML = '<div class="empty-hint">Bản dịch tiếng Anh hiển thị tại đây...</div>';
  latencyList.innerHTML = '<div class="empty-hint">Độ trễ từng câu (ms) sẽ hiện ở đây...</div>';
  latencyHistory.length = 0;
  turnCounter = 0;
  avgLatencyLabel.textContent = 'TB: -- ms';
});

quickTextForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = quickTextInput.value.trim();
  if (!raw) return;
  quickTextInput.value = '';

  const cleaned = cleanClientFillers(raw, chkFilterFillers.checked);
  if (!cleaned) {
    vnStatusTag.textContent = `Đã lọc từ đệm: "${raw}"`;
    return;
  }

  if (!liveClientSession) {
    try {
      setStatus('idle', 'Đang kết nối Live API...');
      liveClientSession = await connectDirectGeminiLive();
    } catch (err) {
      setStatus('error', err?.message || 'Lỗi kết nối');
      return;
    }
  }

  currentTurnStartMs = performance.now();
  currentTurnFirstByteMs = null;
  currentVnItem = appendOrUpdateUtterance(
    vnTranscriptBox,
    null,
    cleaned,
    `#${turnCounter + 1}`
  );
  currentEnItem = null;

  liveClientSession.sendRealtimeInput({
    text: cleaned,
  });
});

fetch('/api/config')
  .then((r) => r.json())
  .then((cfg) => {
    if (cfg.hasConfiguredKey) {
      setStatus('idle', 'Sẵn sàng');
    }
  })
  .catch(() => {});
