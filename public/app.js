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

const profileBar = document.getElementById('profileBar');
const btnAddProfile = document.getElementById('btnAddProfile');
const profileFormDrawer = document.getElementById('profileFormDrawer');
const profileNameInput = document.getElementById('profileNameInput');
const profileApiKeyInput = document.getElementById('profileApiKeyInput');
const profilePinInput = document.getElementById('profilePinInput');
const profileFormError = document.getElementById('profileFormError');
const btnSaveProfile = document.getElementById('btnSaveProfile');
const btnCancelProfile = document.getElementById('btnCancelProfile');
const profileDeleteConfirm = document.getElementById('profileDeleteConfirm');
const profileDeleteTargetName = document.getElementById('profileDeleteTargetName');
const profileDeletePinGroup = document.getElementById('profileDeletePinGroup');
const profileDeletePinInput = document.getElementById('profileDeletePinInput');
const profileDeleteError = document.getElementById('profileDeleteError');
const btnConfirmDeleteProfile = document.getElementById('btnConfirmDeleteProfile');
const btnCancelDeleteProfile = document.getElementById('btnCancelDeleteProfile');

const SELECTED_PROFILE_STORAGE_KEY = 'glt_selected_profile_id';
const DEFAULT_PROFILE_ENTRY = {
  id: 'default',
  name: 'Tôi',
  locked: true,
  isOwner: true,
  selectable: true,
  ownerNote: null,
  hasPin: false,
};

let profilesList = [{ ...DEFAULT_PROFILE_ENTRY }];
let activeProfileId = 'default';
let pendingDeleteProfileId = null;
let isSavingProfile = false;
let isDeletingProfile = false;

let liveClientSession = null;
let isRecording = false;
let isStarting = false;
let isReconnecting = false;
let micContext = null;
let playbackContext = null;
let playbackStreamDest = null;
let keepAliveOscillator = null;
let micStream = null;
let workletNode = null;
let wakeLockSentinel = null;
let webLockRelease = null;
let watchdogInterval = null;
let nextPlayTime = 0;
let activeAudioSources = [];
let playbackSpeed = parseFloat(speedSlider.value) || 1.2;

let turnCounter = 0;
let currentTurnStartMs = null;
let currentTurnFirstByteMs = null;
let currentVnItem = null;
let currentVnRawText = '';
let currentEnItem = null;
const latencyHistory = [];
const btnCopyTranslation = document.getElementById('btnCopyTranslation');
const sessionDetails = document.getElementById('sessionDetails');
const btnOpenSettings = document.getElementById('btnOpenSettings');
const inputMeter = document.querySelector('.input-meter');
const feedback = document.getElementById('feedback');
let feedbackTimer;

function showFeedback(message) {
  clearTimeout(feedbackTimer);
  feedback.textContent = message;
  feedbackTimer = setTimeout(() => {
    feedback.textContent = '';
  }, 3000);
}

function setInputLevel(rms = 0) {
  inputMeter.style.setProperty(
    '--input-level',
    Math.min(1, Math.max(0, rms * 14))
  );
}

function getSafeStoredProfileId() {
  try {
    return localStorage.getItem(SELECTED_PROFILE_STORAGE_KEY) || 'default';
  } catch {
    return 'default';
  }
}

function saveSelectedProfileId(profileId) {
  try {
    localStorage.setItem(SELECTED_PROFILE_STORAGE_KEY, profileId);
  } catch {}
}

function getActiveProfile() {
  return (
    profilesList.find((p) => p.id === activeProfileId) || DEFAULT_PROFILE_ENTRY
  );
}

function closeActiveLiveClientSession() {
  if (!liveClientSession) return;
  const prev = liveClientSession;
  liveClientSession = null;
  try {
    prev.close();
  } catch {}
}

function setFormError(el, message) {
  if (!el) return;
  if (!message) {
    el.textContent = '';
    el.hidden = true;
  } else {
    el.textContent = message;
    el.hidden = false;
  }
}

function renderProfileBar() {
  if (!profileBar || !btnAddProfile) return;
  const existingItems = profileBar.querySelectorAll('.profile-item');
  existingItems.forEach((node) => node.remove());

  const controlsLocked =
    isRecording || isStarting || isSavingProfile || isDeletingProfile;

  for (const profile of profilesList) {
    const item = document.createElement('div');
    item.className = 'profile-item';
    item.dataset.profileId = profile.id;
    if (profile.locked) {
      item.dataset.locked = 'true';
    } else {
      item.dataset.owner = String(Boolean(profile.isOwner));
    }

    const selectBtn = document.createElement('button');
    selectBtn.className = 'profile-select';
    selectBtn.type = 'button';
    selectBtn.dataset.profileId = profile.id;
    if (profile.locked) {
      selectBtn.dataset.locked = 'true';
    }
    const isSelected = profile.id === activeProfileId;
    selectBtn.setAttribute('aria-pressed', String(isSelected));

    if (!profile.locked && !profile.isOwner) {
      selectBtn.disabled = true;
      selectBtn.setAttribute('aria-disabled', 'true');
      selectBtn.title = 'Chỉ chủ hồ sơ';
      selectBtn.setAttribute('aria-label', `${profile.name} — Chỉ chủ hồ sơ`);
      const nameSpan = document.createElement('span');
      nameSpan.className = 'profile-name';
      nameSpan.textContent = profile.name;
      const noteSpan = document.createElement('span');
      noteSpan.className = 'profile-lock-note';
      noteSpan.textContent = 'Chỉ chủ hồ sơ';
      selectBtn.append(nameSpan, noteSpan);
    } else {
      selectBtn.disabled = controlsLocked;
      selectBtn.textContent = profile.name;
      selectBtn.addEventListener('click', () => {
        handleSelectProfile(profile.id);
      });
    }
    item.appendChild(selectBtn);

    if (!profile.locked && profile.isOwner) {
      const delBtn = document.createElement('button');
      delBtn.className = 'profile-delete';
      delBtn.type = 'button';
      delBtn.dataset.profileId = profile.id;
      delBtn.setAttribute('aria-label', `Xóa hồ sơ ${profile.name}`);
      delBtn.setAttribute('aria-controls', 'profileDeleteConfirm');
      const isExpanded =
        !profileDeleteConfirm.hidden && pendingDeleteProfileId === profile.id;
      delBtn.setAttribute('aria-expanded', String(isExpanded));
      delBtn.disabled = controlsLocked;
      delBtn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
      delBtn.addEventListener('click', () => {
        openDeleteConfirm(profile.id);
      });
      item.appendChild(delBtn);
    }

    profileBar.insertBefore(item, btnAddProfile);
  }

  btnAddProfile.disabled = controlsLocked;
}

function closeAddDrawer(restoreFocus = false) {
  if (!profileFormDrawer) return;
  profileFormDrawer.hidden = true;
  btnAddProfile?.setAttribute('aria-expanded', 'false');
  profileNameInput.value = '';
  profileApiKeyInput.value = '';
  profilePinInput.value = '';
  setFormError(profileFormError, '');
  if (restoreFocus) {
    btnAddProfile?.focus();
  }
}

function openAddDrawer() {
  if (isRecording || isStarting) {
    showFeedback('Hãy dừng mic trước khi tạo hồ sơ API mới.');
    return;
  }
  closeDeleteConfirm(false);
  profileFormDrawer.hidden = false;
  btnAddProfile.setAttribute('aria-expanded', 'true');
  setFormError(profileFormError, '');
  profileNameInput.focus();
}

function closeDeleteConfirm(restoreFocus = false) {
  if (!profileDeleteConfirm) return;
  const prevTargetId = pendingDeleteProfileId;
  pendingDeleteProfileId = null;
  profileDeleteConfirm.hidden = true;
  profileDeletePinInput.value = '';
  setFormError(profileDeleteError, '');
  renderProfileBar();
  if (restoreFocus) {
    const delBtn =
      prevTargetId &&
      profileBar?.querySelector(
        `.profile-delete[data-profile-id="${CSS.escape(prevTargetId)}"]`
      );
    if (delBtn && !delBtn.disabled) {
      delBtn.focus();
    } else {
      btnAddProfile?.focus();
    }
  }
}

function openDeleteConfirm(profileId) {
  if (isRecording || isStarting) {
    showFeedback('Không thể xóa hồ sơ khi phiên thu âm đang hoạt động.');
    return;
  }
  const target = profilesList.find((p) => p.id === profileId);
  if (!target || target.locked || !target.isOwner) {
    showFeedback('Chỉ chủ sở hữu mới có quyền xóa hồ sơ này.');
    return;
  }

  closeAddDrawer(false);
  pendingDeleteProfileId = target.id;
  profileDeleteTargetName.textContent = target.name;
  profileDeletePinInput.value = '';
  setFormError(profileDeleteError, '');

  if (target.hasPin) {
    profileDeletePinGroup.hidden = false;
    profileDeletePinInput.required = true;
  } else {
    profileDeletePinGroup.hidden = true;
    profileDeletePinInput.required = false;
  }

  profileDeleteConfirm.hidden = false;
  renderProfileBar();
  if (target.hasPin) {
    profileDeletePinInput.focus();
  } else {
    btnConfirmDeleteProfile.focus();
  }
}

function handleSelectProfile(profileId) {
  if (isRecording || isStarting) {
    showFeedback('Hãy dừng mic trước khi đổi hồ sơ API.');
    return;
  }
  const target = profilesList.find((p) => p.id === profileId);
  if (!target || (!target.locked && !target.isOwner)) {
    showFeedback('Hồ sơ này chỉ dành cho chủ hồ sơ.');
    return;
  }

  closeAddDrawer(false);
  closeDeleteConfirm(false);

  const changed = activeProfileId !== target.id;
  activeProfileId = target.id;
  saveSelectedProfileId(activeProfileId);

  if (changed || liveClientSession) {
    closeActiveLiveClientSession();
  }

  renderProfileBar();
  setStatus(
    'idle',
    target.id === 'default' ? 'Sẵn sàng' : `Sẵn sàng · Hồ sơ: ${target.name}`
  );
}

async function loadProfiles(preferredId = null) {
  try {
    const res = await fetch('/api/profiles', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data?.profiles) && data.profiles.length > 0) {
      profilesList = data.profiles;
    } else {
      profilesList = [{ ...DEFAULT_PROFILE_ENTRY }];
    }
  } catch {
    profilesList = [{ ...DEFAULT_PROFILE_ENTRY }];
  }

  const desiredId = preferredId || getSafeStoredProfileId();
  const selectableMatch = profilesList.find(
    (p) => p.id === desiredId && (p.locked || p.isOwner)
  );
  activeProfileId = selectableMatch ? selectableMatch.id : 'default';
  saveSelectedProfileId(activeProfileId);
  renderProfileBar();
}

btnAddProfile?.addEventListener('click', () => {
  if (profileFormDrawer.hidden) {
    openAddDrawer();
  } else {
    closeAddDrawer(true);
  }
});

btnCancelProfile?.addEventListener('click', () => {
  closeAddDrawer(true);
});

btnCancelDeleteProfile?.addEventListener('click', () => {
  closeDeleteConfirm(true);
});

profileFormDrawer?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (isSavingProfile || isRecording || isStarting) return;

  const name = profileNameInput.value.trim();
  const apiKey = profileApiKeyInput.value.trim();
  const pin = profilePinInput.value.trim();

  if (!name) {
    setFormError(profileFormError, 'Vui lòng nhập tên hồ sơ.');
    profileNameInput.focus();
    return;
  }
  if (name.length > 24) {
    setFormError(profileFormError, 'Tên hồ sơ tối đa 24 ký tự.');
    profileNameInput.focus();
    return;
  }
  if (name.toLocaleLowerCase('vi') === 'tôi') {
    setFormError(
      profileFormError,
      'Tên "Tôi" được dành riêng cho hồ sơ mặc định của chủ web.'
    );
    profileNameInput.focus();
    return;
  }
  if (!apiKey || apiKey.length < 10 || /\s/.test(apiKey)) {
    setFormError(profileFormError, 'Vui lòng nhập Gemini API Key hợp lệ.');
    profileApiKeyInput.focus();
    return;
  }
  if (pin !== '' && !/^[0-9]{4}$/.test(pin)) {
    setFormError(
      profileFormError,
      'PIN xóa hồ sơ phải gồm đúng 4 chữ số (0–9).'
    );
    profilePinInput.focus();
    return;
  }

  isSavingProfile = true;
  btnSaveProfile.disabled = true;
  btnCancelProfile.disabled = true;
  btnSaveProfile.setAttribute('aria-busy', 'true');
  btnSaveProfile.textContent = 'Đang lưu…';
  setFormError(profileFormError, '');
  renderProfileBar();

  try {
    const res = await fetch('/api/profiles', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, apiKey, pin }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `Không thể lưu hồ sơ (HTTP ${res.status})`);
    }

    if (Array.isArray(data.profiles) && data.profiles.length > 0) {
      profilesList = data.profiles;
    }
    const createdId = data.profile?.id || 'default';
    activeProfileId = createdId;
    saveSelectedProfileId(activeProfileId);
    closeActiveLiveClientSession();
    closeAddDrawer(false);
    renderProfileBar();

    const activeBtn = profileBar.querySelector(
      `.profile-select[data-profile-id="${CSS.escape(activeProfileId)}"]`
    );
    activeBtn?.focus();
    const createdName = data.profile?.name || name;
    setStatus('idle', `Sẵn sàng · Hồ sơ: ${createdName}`);
    showFeedback(`Đã lưu và chọn hồ sơ "${createdName}".`);
  } catch (err) {
    const msg = err?.message || 'Không thể lưu hồ sơ.';
    setFormError(profileFormError, msg);
    showFeedback(msg);
  } finally {
    isSavingProfile = false;
    btnSaveProfile.disabled = false;
    btnCancelProfile.disabled = false;
    btnSaveProfile.setAttribute('aria-busy', 'false');
    btnSaveProfile.textContent = 'Lưu & Dùng';
    renderProfileBar();
  }
});

profileDeleteConfirm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (isDeletingProfile || !pendingDeleteProfileId) return;
  if (isRecording || isStarting) {
    setFormError(
      profileDeleteError,
      'Không thể xóa hồ sơ khi phiên thu âm đang hoạt động.'
    );
    return;
  }

  const targetId = pendingDeleteProfileId;
  const target = profilesList.find((p) => p.id === targetId);
  const pin = profileDeletePinInput.value.trim();

  if (target?.hasPin && !/^[0-9]{4}$/.test(pin)) {
    setFormError(
      profileDeleteError,
      'Vui lòng nhập đúng mã PIN 4 chữ số của hồ sơ.'
    );
    profileDeletePinInput.focus();
    return;
  }

  isDeletingProfile = true;
  btnConfirmDeleteProfile.disabled = true;
  btnCancelDeleteProfile.disabled = true;
  btnConfirmDeleteProfile.setAttribute('aria-busy', 'true');
  btnConfirmDeleteProfile.textContent = 'Đang xóa…';
  setFormError(profileDeleteError, '');
  renderProfileBar();

  try {
    const res = await fetch(
      `/api/profiles/${encodeURIComponent(targetId)}`,
      {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: targetId, pin }),
      }
    );
    profileDeletePinInput.value = '';
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `Không thể xóa hồ sơ (HTTP ${res.status})`);
    }

    if (Array.isArray(data.profiles) && data.profiles.length > 0) {
      profilesList = data.profiles;
    } else {
      profilesList = profilesList.filter((p) => p.id !== targetId);
    }

    const wasSelected = activeProfileId === targetId;
    if (wasSelected) {
      activeProfileId = 'default';
      saveSelectedProfileId('default');
      closeActiveLiveClientSession();
      setStatus('idle', 'Sẵn sàng');
    }

    pendingDeleteProfileId = null;
    profileDeleteConfirm.hidden = true;
    setFormError(profileDeleteError, '');
    renderProfileBar();

    const defaultBtn = profileBar.querySelector(
      '.profile-select[data-profile-id="default"]'
    );
    defaultBtn?.focus();
    showFeedback(`Đã xóa hồ sơ "${target?.name || ''}".`);
  } catch (err) {
    const msg = err?.message || 'Không thể xóa hồ sơ.';
    setFormError(profileDeleteError, msg);
    showFeedback(msg);
    if (target?.hasPin) {
      profileDeletePinInput.focus();
    } else {
      btnConfirmDeleteProfile.focus();
    }
  } finally {
    isDeletingProfile = false;
    btnConfirmDeleteProfile.disabled = false;
    btnCancelDeleteProfile.disabled = false;
    btnConfirmDeleteProfile.setAttribute('aria-busy', 'false');
    btnConfirmDeleteProfile.textContent = 'Xóa';
    renderProfileBar();
  }
});

btnOpenSettings.addEventListener('click', () => {
  sessionDetails.open = !sessionDetails.open;
  if (sessionDetails.open) {
    sessionDetails.scrollIntoView({ block: 'nearest' });
    sessionDetails.querySelector('summary').focus({ preventScroll: true });
  }
});
sessionDetails.addEventListener('toggle', () => {
  btnOpenSettings.setAttribute('aria-expanded', String(sessionDetails.open));
});

btnCopyTranslation.addEventListener('click', async () => {
  const text = [...enTranscriptBox.querySelectorAll('.utterance-text')]
    .map((item) => item.textContent)
    .join('\n\n');
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    showFeedback('Đã sao chép bản dịch.');
  } catch {
    showFeedback('Chưa sao chép được. Bạn có thể chọn và sao chép văn bản.');
  }
});

const STANDALONE_FILLER_REGEX =
  /^[\s,.;:!?…\-–—]*(?:à+|ừ+|ờ+|ừm+|ờm+|ưm+|ạ+|ơ+|hơ+|ạ\s*ừm+|à\s*ừm+|à\s*ừ+|uh+|um+|hmm+)[\s,.;:!?…\-–—]*$/i;
const TOKEN_FILLER_REGEX =
  /(?:^|(?<=[\s,.;:!?…\-–—]))(?:ạ\s+ừm+|à\s+ừm+|à\s+ừ+|ừ\s+à+|ừm+|ờm+|ưm+|à+|ừ+|ờ+|uh+|um+|hmm+)(?=$|[\s,.;:!?…\-–—])/giu;

export function cleanClientFillers(rawText, enabled = true) {
  if (!rawText || typeof rawText !== 'string') return '';
  if (!enabled) return rawText.trim();
  let t = rawText.trim();
  if (!t || STANDALONE_FILLER_REGEX.test(t)) return '';
  t = t
    .replace(TOKEN_FILLER_REGEX, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/^[,.;:!?…\-–—\s]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
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

/**
 * Khởi tạo AudioContext phát 24kHz có gắn sóng hạ âm giữ thức (-75dB)
 * và kết nối cả MediaStream vào thẻ <audio> để khi khóa màn hình điện thoại
 * hệ điều hành vẫn cấp quyền phát loa liên tục.
 */
function ensurePlaybackContext() {
  if (!playbackContext) {
    playbackContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 24000,
    });

    try {
      const osc = playbackContext.createOscillator();
      const gain = playbackContext.createGain();
      osc.type = 'sine';
      osc.frequency.value = 24;
      gain.gain.value = 0.00018;
      osc.connect(gain);
      gain.connect(playbackContext.destination);

      if (typeof playbackContext.createMediaStreamDestination === 'function') {
        playbackStreamDest = playbackContext.createMediaStreamDestination();
        gain.connect(playbackStreamDest);
      }
      osc.start();
      keepAliveOscillator = osc;
    } catch {}
  }

  if (playbackContext.state === 'suspended') {
    playbackContext.resume().catch(() => {});
  }
  return playbackContext;
}

function schedulePcm24kPlayback(base64Data) {
  const ctx = ensurePlaybackContext();

  const pcm16 = base64ToInt16Array(base64Data);
  if (pcm16.length === 0) return;

  const float32 = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    float32[i] = pcm16[i] / 32768;
  }

  const audioBuffer = ctx.createBuffer(1, float32.length, 24000);
  audioBuffer.getChannelData(0).set(float32);

  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;
  source.playbackRate.value = playbackSpeed;
  source.connect(ctx.destination);

  if (playbackStreamDest && document.visibilityState === 'hidden') {
    try {
      source.connect(playbackStreamDest);
    } catch {}
  }

  const now = ctx.currentTime;
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

function appendOrUpdateUtterance(
  box,
  currentItem,
  text,
  tagLabel,
  replaceFull = false
) {
  const hint = box.querySelector('.empty-hint');
  if (hint) hint.remove();

  if (box === enTranscriptBox) btnCopyTranslation.disabled = false;

  if (!currentItem) {
    const item = document.createElement('div');
    item.className = 'utterance-item';
    item.dataset.rawText = text;
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
    if (replaceFull) {
      currentItem.dataset.rawText = text;
      contentSpan.textContent = text.trim();
    } else {
      const prevRaw = currentItem.dataset.rawText ?? contentSpan.textContent;
      const needsSpace =
        prevRaw.length > 0 &&
        !/\s$/.test(prevRaw) &&
        !/^\s/.test(text) &&
        !/^[,.;:!?…'")\]]/.test(text);
      const combinedRaw = `${prevRaw}${needsSpace ? ' ' : ''}${text}`;
      currentItem.dataset.rawText = combinedRaw;
      contentSpan.textContent = combinedRaw.replace(/\s{2,}/g, ' ').trim();
    }
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

  const preview = document.createElement('span');
  preview.textContent = `#${turnCounter} ${shortText}`;
  const timing = document.createElement('span');
  timing.className = 'latency-ms';
  timing.textContent = `${safeTtfa} ms (Tổng: ${safeTotal} ms)`;
  row.append(preview, timing);
  latencyList.prepend(row);
}

/**
 * Tạo WAV có tín hiệu dither khác 0 (-75dB) để hệ điều hành điện thoại
 * không nhận diện là "im lặng giả" khi người dùng ấn nút nguồn tắt màn hình.
 */
function buildNonZeroKeepAliveWavUrl() {
  const sampleRate = 8000;
  const seconds = 2;
  const numSamples = sampleRate * seconds;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
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

  for (let i = 0; i < numSamples; i++) {
    const sample = i % 2 === 0 ? 3 : -3;
    view.setInt16(44 + i * 2, sample, true);
  }

  const blob = new Blob([buffer], { type: 'audio/wav' });
  return URL.createObjectURL(blob);
}

async function enableBackgroundKeepAlive() {
  if (!chkBackgroundMode.checked) return;

  ensurePlaybackContext();

  if (
    navigator.locks &&
    typeof navigator.locks.request === 'function' &&
    !webLockRelease
  ) {
    navigator.locks
      .request('gemini_live_translator_active_lock', () => {
        return new Promise((resolve) => {
          webLockRelease = resolve;
        });
      })
      .catch(() => {});
  }

  if ('wakeLock' in navigator && document.visibilityState === 'visible') {
    try {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
    } catch {}
  }

  if (bgKeepAliveAudio) {
    if (!bgKeepAliveAudio.src) {
      bgKeepAliveAudio.src = buildNonZeroKeepAliveWavUrl();
    }
    bgKeepAliveAudio.volume = 0.02;
    try {
      await bgKeepAliveAudio.play();
    } catch {}
  }

  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'Đang Phiên Dịch Việt → Anh',
      artist: 'Gemini Live (Chạy nền khi tắt màn hình)',
      album: 'Gemini Live Translator',
    });
    navigator.mediaSession.playbackState = 'playing';
    navigator.mediaSession.setActionHandler('pause', () => {
      if (isRecording) stopLiveSession();
    });
    navigator.mediaSession.setActionHandler('play', () => {
      if (!isRecording) startLiveSession();
    });
  }

  if (watchdogInterval) clearInterval(watchdogInterval);
  watchdogInterval = setInterval(async () => {
    if (!isRecording) return;

    if (micContext && micContext.state === 'suspended') {
      micContext.resume().catch(() => {});
    }
    if (playbackContext && playbackContext.state === 'suspended') {
      playbackContext.resume().catch(() => {});
    }
    if (
      bgKeepAliveAudio &&
      bgKeepAliveAudio.paused &&
      chkBackgroundMode.checked
    ) {
      bgKeepAliveAudio.play().catch(() => {});
    }
    if (!liveClientSession && !isReconnecting) {
      isReconnecting = true;
      try {
        setStatus('idle', 'Đang tự kết nối lại...');
        liveClientSession = await connectDirectGeminiLive();
      } catch {} finally {
        isReconnecting = false;
      }
    }
  }, 2000);
}

document.addEventListener('visibilitychange', async () => {
  if (!isRecording || !chkBackgroundMode.checked) return;

  if (document.visibilityState === 'visible' && 'wakeLock' in navigator) {
    try {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
    } catch {}
  }
  if (micContext?.state === 'suspended') micContext.resume().catch(() => {});
  if (playbackContext?.state === 'suspended') {
    playbackContext.resume().catch(() => {});
  }
  if (bgKeepAliveAudio?.paused) bgKeepAliveAudio.play().catch(() => {});
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
    const needsSpace =
      currentVnRawText.length > 0 &&
      !/\s$/.test(currentVnRawText) &&
      !/^\s/.test(rawVn) &&
      !/^[,.;:!?…'")\]]/.test(rawVn);
    currentVnRawText = `${currentVnRawText}${needsSpace ? ' ' : ''}${rawVn}`;
    const cleanedVn = cleanClientFillers(
      currentVnRawText,
      chkFilterFillers.checked
    );

    if (currentVnRawText.trim().length > 0 && cleanedVn.length === 0) {
      vnStatusTag.textContent = `Đã lọc từ đệm: "${currentVnRawText.trim()}"`;
    } else if (cleanedVn) {
      if (!currentTurnStartMs) currentTurnStartMs = now;
      vnStatusTag.textContent = 'Đang nhận tiếng Việt';
      currentVnItem = appendOrUpdateUtterance(
        vnTranscriptBox,
        currentVnItem,
        cleanedVn,
        `#${turnCounter + 1}`,
        true
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
    currentVnRawText = '';
    currentEnItem = null;
  }
}

async function connectDirectGeminiLive() {
  closeActiveLiveClientSession();

  const model = modelSelect.value;
  const profileId = activeProfileId || 'default';
  const res = await fetch('/api/ephemeral-token', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, profileId }),
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

  let sessionRef = null;
  const session = await ai.live.connect({
    model,
    config: liveConfig,
    callbacks: {
      onopen: () => {
        setStatus('active', 'Đã kết nối');
      },
      onmessage: (response) => {
        handleServerResponse(response);
      },
      onerror: (err) => {
        setStatus('error', err?.message || 'Lỗi kết nối phiên dịch');
      },
      onclose: () => {
        if (!sessionRef || liveClientSession === sessionRef) {
          liveClientSession = null;
          if (!isRecording) {
            setStatus('idle', 'Đã ngắt kết nối');
          }
        }
      },
    },
  });
  sessionRef = session;

  setStatus('active', 'Đã kết nối');
  return session;
}

async function startLiveSession() {
  if (isStarting || isRecording) return;
  isStarting = true;
  closeAddDrawer(false);
  closeDeleteConfirm(false);
  renderProfileBar();
  btnToggleMic.disabled = true;
  btnToggleMic.setAttribute('aria-busy', 'true');
  micBtnLabel.textContent = 'Đang nối…';
  try {
    setStatus('idle', 'Đang kết nối...');
    await enableBackgroundKeepAlive();
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
      if (data.type === 'pcm_chunk' || data.type === 'speech_start') {
        setInputLevel(data.rms);
      }
      if (data.type === 'speech_end') setInputLevel(0);
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

    isRecording = true;
    btnToggleMic.classList.add('recording');
    micBtnLabel.textContent = 'Dừng mic';
    btnToggleMic.setAttribute('aria-pressed', 'true');
    setStatus('active', 'Đang nghe');
  } catch (err) {
    await stopLiveSession();
    setStatus(
      'error',
      err?.message || 'Không thể bật mic. Hãy kiểm tra quyền truy cập.'
    );
  } finally {
    isStarting = false;
    btnToggleMic.disabled = false;
    btnToggleMic.setAttribute('aria-busy', 'false');
    renderProfileBar();
  }
}

async function stopLiveSession() {
  isRecording = false;
  btnToggleMic.setAttribute('aria-pressed', 'false');
  setInputLevel(0);
  btnToggleMic.classList.remove('recording');
  micBtnLabel.textContent = 'Bật mic';
  setStatus('idle', 'Đã dừng');
  vnStatusTag.textContent = 'Tiếng Việt';
  currentTurnStartMs = null;
  currentTurnFirstByteMs = null;
  currentVnItem = null;
  currentVnRawText = '';
  currentEnItem = null;

  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
  }
  if (webLockRelease) {
    webLockRelease();
    webLockRelease = null;
  }
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
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = 'paused';
  }
  closeActiveLiveClientSession();
  clearAudioQueue();
  renderProfileBar();
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
  speedValueLabel.textContent = `${playbackSpeed.toFixed(2)}×`;
  speedSlider.setAttribute('aria-valuetext', `${playbackSpeed.toFixed(2)} lần`);
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

modelSelect.addEventListener('change', async () => {
  if (!liveClientSession) return;
  try {
    setStatus('idle', 'Đang chuyển mô hình...');
    liveClientSession = await connectDirectGeminiLive();
    if (isRecording) {
      setStatus('active', 'Đang nghe');
    }
  } catch (err) {
    setStatus('error', err?.message || 'Không thể chuyển mô hình');
  }
});

btnClearHistory.addEventListener('click', () => {
  vnTranscriptBox.innerHTML =
    '<p class="empty-hint">Bật mic.<br />Nói điều bạn muốn.</p>';
  enTranscriptBox.innerHTML =
    '<p class="empty-hint">Your words,<br />in English.</p>';
  latencyList.innerHTML =
    '<p class="empty-hint">Có bản dịch đầu tiên, độ trễ sẽ hiển thị ở đây.</p>';
  currentVnItem = null;
  currentVnRawText = '';
  currentEnItem = null;
  currentTurnStartMs = null;
  currentTurnFirstByteMs = null;
  btnCopyTranslation.disabled = true;
  vnStatusTag.textContent = 'Tiếng Việt';
  enStatusTag.textContent = 'Bản dịch được đọc tự động khi có phản hồi.';
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

  currentVnItem = null;
  currentVnRawText = '';
  currentEnItem = null;
  currentTurnStartMs = performance.now();
  currentTurnFirstByteMs = null;

  currentVnItem = appendOrUpdateUtterance(
    vnTranscriptBox,
    null,
    cleaned,
    `#${turnCounter + 1}`
  );
  liveClientSession.sendRealtimeInput({ text: cleaned });
});

async function loadInitialConfig() {
  await loadProfiles();
  try {
    const res = await fetch('/api/config', { credentials: 'same-origin' });
    const cfg = await res.json();
    const active = getActiveProfile();
    if (!cfg.hasConfiguredKey && active.id === 'default') {
      setStatus('error', 'Chưa cấu hình GEMINI_API_KEY');
    } else {
      setStatus(
        'idle',
        active.id === 'default' ? 'Sẵn sàng' : `Sẵn sàng · Hồ sơ: ${active.name}`
      );
    }
  } catch {
    setStatus('error', 'Không kết nối được Server');
  }
}

loadInitialConfig();
