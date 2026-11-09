import { GoogleGenAI, Modality } from 'https://esm.sh/@google/genai';

const btnToggleMic = document.getElementById('btnToggleMic');
const micBtnLabel = document.getElementById('micBtnLabel');
const connectionBadge = document.getElementById('connectionBadge');
const connectionText = document.getElementById('connectionText');
const vnTranscriptBox = document.getElementById('vnTranscriptBox');
const enTranscriptBox = document.getElementById('enTranscriptBox');
const vnStatusTag = document.getElementById('vnStatusTag');
const enStatusTag = document.getElementById('enStatusTag');
const vnPendingBox = document.getElementById('vnPendingBox');
const vnLiveBufferBox = document.getElementById('vnLiveBufferBox');
const vnLiveBufferText = document.getElementById('vnLiveBufferText');
const enPlaybackBanner = document.getElementById('enPlaybackBanner');
const enPlaybackBannerText = document.getElementById('enPlaybackBannerText');
const rollingStatus = document.getElementById('rollingStatus');
const rollingListenText = document.getElementById('rollingListenText');
const rollingPlayText = document.getElementById('rollingPlayText');

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
const profileCountBadge = document.getElementById('profileCountBadge');
const profileSearchInput = document.getElementById('profileSearchInput');
const profileSortSelect = document.getElementById('profileSortSelect');
const profileNoResults = document.getElementById('profileNoResults');
const btnAddProfile = document.getElementById('btnAddProfile');
const profileFormDrawer = document.getElementById('profileFormDrawer');
const profileNameInput = document.getElementById('profileNameInput');
const voiceGenderMaleBtn = document.getElementById('voiceGenderMaleBtn');
const voiceGenderFemaleBtn = document.getElementById('voiceGenderFemaleBtn');
const profileVoiceGenderInput = document.getElementById('profileVoiceGenderInput');
const profileApiKeyInput = document.getElementById('profileApiKeyInput');
const profilePinInput = document.getElementById('profilePinInput');
const profileFormError = document.getElementById('profileFormError');
const btnSaveProfile = document.getElementById('btnSaveProfile');
const btnCancelProfile = document.getElementById('btnCancelProfile');
const profileDeleteConfirm = document.getElementById('profileDeleteConfirm');
const profileDeleteTargetName = document.getElementById('profileDeleteTargetName');
const profileDeleteName = document.getElementById('profileDeleteName');
const profileDeletePinGroup = document.getElementById('profileDeletePinGroup');
const profileDeletePinInput = document.getElementById('profileDeletePinInput');
const profileDeleteError = document.getElementById('profileDeleteError');
const btnConfirmDeleteProfile = document.getElementById('btnConfirmDeleteProfile');
const btnCancelDeleteProfile = document.getElementById('btnCancelDeleteProfile');
const profileUnlockConfirm = document.getElementById('profileUnlockConfirm');
const profileUnlockName = document.getElementById('profileUnlockName');
const profileUnlockPinInput = document.getElementById('profileUnlockPinInput');
const profileUnlockError = document.getElementById('profileUnlockError');
const btnConfirmUnlockProfile = document.getElementById('btnConfirmUnlockProfile');
const btnCancelUnlockProfile = document.getElementById('btnCancelUnlockProfile');

const SELECTED_PROFILE_STORAGE_KEY = 'glt_selected_profile_id';
const UNLOCKED_PROFILES_STORAGE_KEY = 'glt_unlocked_profile_ids';
const PIN_VALIDATION_REGEX = /^[0-9]{4,8}$/;
const RESERVED_DEFAULT_NAMES = new Set(['tôi', 'tuấn anh', 'tuan anh']);
const DEFAULT_PROFILE_ENTRY = {
  id: 'default',
  name: 'Tuấn Anh',
  locked: true,
  isOwner: true,
  selectable: true,
  ownerNote: null,
  hasPin: true,
  requiresPin: true,
  isUnlocked: false,
  voiceGender: 'male',
  voiceName: 'Puck',
  voiceLabel: 'Nam',
  createdAt: 0,
};

let profilesList = [{ ...DEFAULT_PROFILE_ENTRY }];
let activeProfileId = 'default';
let pendingDeleteProfileId = null;
let pendingUnlockProfileId = null;
let pendingUnlockCallback = null;
let isSavingProfile = false;
let isDeletingProfile = false;
let isUnlockingProfile = false;
let selectedFormVoiceGender = 'male';

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
let currentEnTurn = null;
export const enTurns = [];
let playbackSyncTimer = null;

let isModelGeneratingTurn = false;
let rollingInputQueue = [];
let pendingLiveVnText = '';
let isCapturingRollingSpeech = false;

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

function getDeviceUnlockedIds() {
  try {
    const raw = localStorage.getItem(UNLOCKED_PROFILES_STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveDeviceUnlockedId(profileId) {
  if (!profileId) return;
  try {
    const set = getDeviceUnlockedIds();
    set.add(profileId);
    localStorage.setItem(UNLOCKED_PROFILES_STORAGE_KEY, JSON.stringify([...set]));
  } catch {}
}

function syncDeviceUnlockedIdsFromServer(profiles = []) {
  try {
    const set = new Set();
    for (const p of profiles) {
      if (p?.id && p?.isUnlocked) {
        set.add(p.id);
      }
    }
    localStorage.setItem(UNLOCKED_PROFILES_STORAGE_KEY, JSON.stringify([...set]));
  } catch {}
}

function doesProfileNeedPinUnlock(profile) {
  if (!profile) return false;
  if (profile.id === 'default') {
    return !profile.isUnlocked;
  }
  return Boolean(profile.hasPin && !profile.isUnlocked);
}

function getActiveProfile() {
  return (
    profilesList.find((p) => p.id === activeProfileId) || DEFAULT_PROFILE_ENTRY
  );
}

function setFormVoiceGender(gender = 'male') {
  selectedFormVoiceGender = gender === 'female' ? 'female' : 'male';
  if (profileVoiceGenderInput) {
    profileVoiceGenderInput.value = selectedFormVoiceGender;
  }
  if (voiceGenderMaleBtn) {
    voiceGenderMaleBtn.setAttribute(
      'aria-pressed',
      String(selectedFormVoiceGender === 'male')
    );
  }
  if (voiceGenderFemaleBtn) {
    voiceGenderFemaleBtn.setAttribute(
      'aria-pressed',
      String(selectedFormVoiceGender === 'female')
    );
  }
}

voiceGenderMaleBtn?.addEventListener('click', () => {
  setFormVoiceGender('male');
});
voiceGenderFemaleBtn?.addEventListener('click', () => {
  setFormVoiceGender('female');
});

function closeActiveLiveClientSession() {
  if (!liveClientSession) return;
  const prev = liveClientSession;
  liveClientSession = null;
  isModelGeneratingTurn = false;
  rollingInputQueue = [];
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

function getFilteredAndSortedProfiles() {
  const query = (profileSearchInput?.value || '')
    .trim()
    .toLocaleLowerCase('vi');
  const sortMode = profileSortSelect?.value || 'mine';

  const cloned = profilesList.map((p, idx) => ({
    ...p,
    _idx: idx,
    createdAt: Number(p.createdAt) || 0,
    voiceLabel: p.voiceLabel || (p.voiceGender === 'female' ? 'Nữ' : 'Nam'),
  }));

  cloned.sort((a, b) => {
    if (a.locked) return -1;
    if (b.locked) return 1;

    if (sortMode === 'mine' || sortMode === 'owner-first') {
      const ownerDiff = Number(Boolean(b.isOwner)) - Number(Boolean(a.isOwner));
      if (ownerDiff !== 0) return ownerDiff;
      return a.name.localeCompare(b.name, 'vi');
    }

    if (sortMode === 'newest') {
      if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
      return b._idx - a._idx;
    }

    if (sortMode === 'name' || sortMode === 'name-asc') {
      return a.name.localeCompare(b.name, 'vi');
    }

    return a._idx - b._idx;
  });

  if (!query) return cloned;
  return cloned.filter((p) => p.name.toLocaleLowerCase('vi').includes(query));
}

function updateProfileCountBadge() {
  if (!profileCountBadge) return;
  const total = profilesList.length;
  const owned = profilesList.filter((p) => p.locked || p.isOwner).length;
  profileCountBadge.textContent = `${total} hồ sơ · ${owned} của bạn`;
}

function renderProfileBar() {
  if (!profileBar) return;
  const existingItems = profileBar.querySelectorAll('.profile-item');
  existingItems.forEach((node) => node.remove());

  updateProfileCountBadge();

  const controlsLocked =
    isRecording ||
    isStarting ||
    isSavingProfile ||
    isDeletingProfile ||
    isUnlockingProfile;

  const visibleProfiles = getFilteredAndSortedProfiles();

  if (profileNoResults) {
    profileNoResults.hidden = visibleProfiles.length > 0;
  }

  for (const profile of visibleProfiles) {
    const item = document.createElement('div');
    item.className = 'profile-item';
    item.dataset.profileId = profile.id;
    item.dataset.created = String(Number(profile.createdAt) || 0);
    if (profile.locked) {
      item.dataset.locked = 'true';
      item.dataset.owner = 'true';
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

    const nameSpan = document.createElement('span');
    nameSpan.className = 'profile-name';
    nameSpan.textContent = profile.name;

    const voiceTag = document.createElement('span');
    voiceTag.className = 'profile-voice-tag';
    voiceTag.textContent =
      profile.voiceLabel || (profile.voiceGender === 'female' ? 'Nữ' : 'Nam');

    if (!profile.locked && !profile.isOwner) {
      selectBtn.disabled = true;
      selectBtn.setAttribute('aria-disabled', 'true');
      selectBtn.title = 'Chỉ chủ hồ sơ có thể sử dụng API key này';
      selectBtn.setAttribute(
        'aria-label',
        `${profile.name} (${voiceTag.textContent}) — Chỉ chủ hồ sơ`
      );
      const noteSpan = document.createElement('span');
      noteSpan.className = 'profile-owner-note profile-lock-note';
      noteSpan.textContent = 'Chỉ chủ hồ sơ';
      selectBtn.append(nameSpan, voiceTag, noteSpan);
    } else {
      selectBtn.disabled = controlsLocked;
      selectBtn.append(nameSpan, voiceTag);
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
      delBtn.dataset.deleteProfileId = profile.id;
      delBtn.setAttribute('aria-label', `Xóa hồ sơ ${profile.name}`);
      delBtn.setAttribute('aria-controls', 'profileDeleteConfirm');
      const isExpanded =
        !profileDeleteConfirm.hidden && pendingDeleteProfileId === profile.id;
      delBtn.setAttribute('aria-expanded', String(isExpanded));
      delBtn.disabled = controlsLocked;
      delBtn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M6 6 18 18M18 6 6 18"/></svg>';
      delBtn.addEventListener('click', () => {
        openDeleteConfirm(profile.id);
      });
      item.appendChild(delBtn);
    }

    if (btnAddProfile && btnAddProfile.parentElement === profileBar) {
      profileBar.insertBefore(item, btnAddProfile);
    } else {
      profileBar.appendChild(item);
    }
  }

  if (btnAddProfile) {
    btnAddProfile.disabled =
      isSavingProfile || isDeletingProfile || isUnlockingProfile;
  }
}

profileSearchInput?.addEventListener('input', () => {
  renderProfileBar();
});

profileSortSelect?.addEventListener('change', () => {
  renderProfileBar();
});

function closeAddDrawer(restoreFocus = false) {
  if (!profileFormDrawer) return;
  profileFormDrawer.hidden = true;
  btnAddProfile?.setAttribute('aria-expanded', 'false');
  profileNameInput.value = '';
  profileApiKeyInput.value = '';
  profilePinInput.value = '';
  setFormVoiceGender('male');
  setFormError(profileFormError, '');
  if (restoreFocus) {
    btnAddProfile?.focus();
  }
}

function openAddDrawer() {
  closeDeleteConfirm(false);
  closeUnlockConfirm(false);
  profileFormDrawer.hidden = false;
  btnAddProfile?.setAttribute('aria-expanded', 'true');
  setFormError(profileFormError, '');
  profileNameInput.focus();
}

function closeUnlockConfirm(restoreFocus = false) {
  if (!profileUnlockConfirm) return;
  const prevTargetId = pendingUnlockProfileId;
  pendingUnlockProfileId = null;
  pendingUnlockCallback = null;
  profileUnlockConfirm.hidden = true;
  if (profileUnlockPinInput) {
    profileUnlockPinInput.value = '';
  }
  setFormError(profileUnlockError, '');
  renderProfileBar();
  if (restoreFocus) {
    const btn =
      prevTargetId &&
      profileBar?.querySelector(
        `.profile-select[data-profile-id="${CSS.escape(prevTargetId)}"]`
      );
    if (btn && !btn.disabled) {
      btn.focus();
    } else {
      btnAddProfile?.focus();
    }
  }
}

function openUnlockConfirm(profileId, options = {}) {
  if (!profileUnlockConfirm) return;
  if (isRecording || isStarting) {
    showFeedback('Hãy dừng mic trước khi đổi hoặc mở khóa hồ sơ API.');
    return;
  }
  const target =
    profilesList.find((p) => p.id === profileId) || DEFAULT_PROFILE_ENTRY;

  closeAddDrawer(false);
  closeDeleteConfirm(false);
  pendingUnlockProfileId = target.id;
  pendingUnlockCallback =
    typeof options.onUnlocked === 'function' ? options.onUnlocked : null;

  if (profileUnlockName) {
    profileUnlockName.textContent = target.name;
  }
  if (profileUnlockPinInput) {
    profileUnlockPinInput.value = '';
  }
  setFormError(profileUnlockError, '');
  profileUnlockConfirm.hidden = false;
  renderProfileBar();
  profileUnlockPinInput?.focus();
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
  closeUnlockConfirm(false);
  pendingDeleteProfileId = target.id;
  if (profileDeleteName) {
    profileDeleteName.textContent = target.name;
  } else if (profileDeleteTargetName) {
    profileDeleteTargetName.textContent = target.name;
  }
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

function applySelectedProfile(target) {
  closeAddDrawer(false);
  closeDeleteConfirm(false);
  closeUnlockConfirm(false);

  const changed = activeProfileId !== target.id;
  activeProfileId = target.id;
  saveSelectedProfileId(activeProfileId);

  if (changed || liveClientSession) {
    closeActiveLiveClientSession();
  }

  renderProfileBar();
  const voiceTag =
    target.voiceLabel || (target.voiceGender === 'female' ? 'Nữ' : 'Nam');
  setStatus(
    'idle',
    target.id === 'default'
      ? 'Sẵn sàng'
      : `Sẵn sàng · Hồ sơ: ${target.name} (${voiceTag})`
  );
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

  if (doesProfileNeedPinUnlock(target)) {
    openUnlockConfirm(target.id, {
      onUnlocked: (unlockedTarget) => {
        applySelectedProfile(unlockedTarget || target);
      },
    });
    return;
  }

  applySelectedProfile(target);
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
      syncDeviceUnlockedIdsFromServer(profilesList);
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

btnCancelUnlockProfile?.addEventListener('click', () => {
  closeUnlockConfirm(true);
});

profileUnlockConfirm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (isUnlockingProfile || !pendingUnlockProfileId) return;
  if (isRecording || isStarting) {
    setFormError(
      profileUnlockError,
      'Hãy dừng mic trước khi mở khóa hồ sơ API.'
    );
    return;
  }

  const targetId = pendingUnlockProfileId;
  const target =
    profilesList.find((p) => p.id === targetId) || DEFAULT_PROFILE_ENTRY;
  const pin = (profileUnlockPinInput?.value || '').trim();

  if (!PIN_VALIDATION_REGEX.test(pin)) {
    setFormError(
      profileUnlockError,
      'Vui lòng nhập đúng mã PIN (4–8 chữ số).'
    );
    profileUnlockPinInput?.focus();
    return;
  }

  isUnlockingProfile = true;
  if (btnConfirmUnlockProfile) {
    btnConfirmUnlockProfile.disabled = true;
    btnConfirmUnlockProfile.setAttribute('aria-busy', 'true');
    btnConfirmUnlockProfile.textContent = 'Đang mở khóa…';
  }
  if (btnCancelUnlockProfile) {
    btnCancelUnlockProfile.disabled = true;
  }
  setFormError(profileUnlockError, '');
  renderProfileBar();

  try {
    const res = await fetch('/api/profiles', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'unlock',
        profileId: targetId,
        pin,
      }),
    });
    if (profileUnlockPinInput) {
      profileUnlockPinInput.value = '';
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        data.error || `Không thể mở khóa hồ sơ (HTTP ${res.status})`
      );
    }

    if (Array.isArray(data.profiles) && data.profiles.length > 0) {
      profilesList = data.profiles;
      syncDeviceUnlockedIdsFromServer(profilesList);
    } else {
      profilesList = profilesList.map((p) =>
        p.id === targetId ? { ...p, isUnlocked: true, isOwner: true } : p
      );
      saveDeviceUnlockedId(targetId);
    }

    const unlockedTarget =
      profilesList.find((p) => p.id === targetId) || {
        ...target,
        isUnlocked: true,
      };
    const nextCallback = pendingUnlockCallback;

    applySelectedProfile(unlockedTarget);
    const activeBtn = profileBar?.querySelector(
      `.profile-select[data-profile-id="${CSS.escape(targetId)}"]`
    );
    activeBtn?.focus();
    showFeedback(
      `Đã mở khóa hồ sơ "${unlockedTarget.name}" và lưu trên thiết bị này.`
    );

    if (typeof nextCallback === 'function') {
      nextCallback(unlockedTarget);
    }
  } catch (err) {
    const msg = err?.message || 'Mã PIN không đúng.';
    setFormError(profileUnlockError, msg);
    showFeedback(msg);
    profileUnlockPinInput?.focus();
  } finally {
    isUnlockingProfile = false;
    if (btnConfirmUnlockProfile) {
      btnConfirmUnlockProfile.disabled = false;
      btnConfirmUnlockProfile.setAttribute('aria-busy', 'false');
      btnConfirmUnlockProfile.textContent = 'Mở khóa & Lưu thiết bị';
    }
    if (btnCancelUnlockProfile) {
      btnCancelUnlockProfile.disabled = false;
    }
    renderProfileBar();
  }
});

profileFormDrawer?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (isSavingProfile || isRecording || isStarting) return;

  const name = profileNameInput.value.trim();
  const apiKey = profileApiKeyInput.value.trim();
  const pin = profilePinInput.value.trim();
  const voiceGender =
    profileVoiceGenderInput?.value === 'female' ? 'female' : 'male';

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
  if (RESERVED_DEFAULT_NAMES.has(name.toLocaleLowerCase('vi'))) {
    setFormError(
      profileFormError,
      'Tên "Tuấn Anh" được dành riêng cho hồ sơ mặc định của chủ web.'
    );
    profileNameInput.focus();
    return;
  }
  if (!apiKey || apiKey.length < 10 || /\s/.test(apiKey)) {
    setFormError(profileFormError, 'Vui lòng nhập Gemini API Key hợp lệ.');
    profileApiKeyInput.focus();
    return;
  }
  if (pin !== '' && !PIN_VALIDATION_REGEX.test(pin)) {
    setFormError(
      profileFormError,
      'Mã PIN hồ sơ phải gồm từ 4 đến 8 chữ số (0–9).'
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
      body: JSON.stringify({ name, apiKey, pin, voiceGender }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `Không thể lưu hồ sơ (HTTP ${res.status})`);
    }

    if (Array.isArray(data.profiles) && data.profiles.length > 0) {
      profilesList = data.profiles;
      syncDeviceUnlockedIdsFromServer(profilesList);
    }
    const createdId = data.profile?.id || 'default';
    saveDeviceUnlockedId(createdId);
    activeProfileId = createdId;
    saveSelectedProfileId(activeProfileId);
    if (profileSearchInput && profileSearchInput.value) {
      profileSearchInput.value = '';
    }
    closeActiveLiveClientSession();
    closeAddDrawer(false);
    renderProfileBar();

    const activeBtn = profileBar.querySelector(
      `.profile-select[data-profile-id="${CSS.escape(activeProfileId)}"]`
    );
    activeBtn?.focus();
    const createdName = data.profile?.name || name;
    const createdVoiceLabel =
      data.profile?.voiceLabel || (voiceGender === 'female' ? 'Nữ' : 'Nam');
    setStatus(
      'idle',
      `Sẵn sàng · Hồ sơ: ${createdName} (${createdVoiceLabel})`
    );
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

  if (target?.hasPin && !PIN_VALIDATION_REGEX.test(pin)) {
    setFormError(
      profileDeleteError,
      'Vui lòng nhập đúng mã PIN (4–8 chữ số) của hồ sơ.'
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
    .map((item) => item.textContent.trim())
    .filter(Boolean)
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

function isSpeakerPlaying() {
  if (!playbackContext) return false;
  return (
    activeAudioSources.length > 0 &&
    nextPlayTime > playbackContext.currentTime + 0.03
  );
}

function setVnUtteranceState(item, state) {
  if (!item) return;
  item.dataset.vnState = state;
  const labelEl = item.querySelector('.utterance-state-label');
  if (labelEl) {
    labelEl.textContent =
      state === 'translating' ? 'Đang dịch sang tiếng Anh' : 'Đã dịch';
  }
}

export function showPendingVnBuffer(text) {
  pendingLiveVnText = text || '';
  if (!vnPendingBox || !vnLiveBufferText) return;
  if (!pendingLiveVnText) {
    vnPendingBox.hidden = true;
    vnLiveBufferText.textContent = '';
  } else {
    vnPendingBox.hidden = false;
    vnLiveBufferText.textContent = pendingLiveVnText;
  }
  syncRollingIndicators();
}

function renderSpeakingWords(textEl, rawText, progress = 0.35) {
  if (!textEl) return;
  const clean = (rawText || '').replace(/\s{2,}/g, ' ').trim();
  if (!clean) {
    textEl.textContent = '';
    return;
  }
  const words = clean.split(' ');
  const total = words.length;
  if (total === 1) {
    textEl.innerHTML = '';
    const activeSpan = document.createElement('span');
    activeSpan.className = 'word-active';
    activeSpan.textContent = words[0];
    textEl.appendChild(activeSpan);
    return;
  }

  const clamped = Math.min(0.96, Math.max(0, progress));
  const activeStart = Math.min(total - 1, Math.floor(clamped * total));
  const activeCount = total >= 5 ? 2 : 1;
  const activeEnd = Math.min(total, activeStart + activeCount);

  const spokenPart = words.slice(0, activeStart).join(' ');
  const activePart = words.slice(activeStart, activeEnd).join(' ');
  const upcomingPart = words.slice(activeEnd).join(' ');

  textEl.innerHTML = '';
  if (spokenPart) {
    const s = document.createElement('span');
    s.className = 'word-spoken';
    s.textContent = spokenPart;
    textEl.appendChild(s);
    textEl.appendChild(document.createTextNode(' '));
  }
  if (activePart) {
    const a = document.createElement('span');
    a.className = 'word-active';
    a.textContent = activePart;
    textEl.appendChild(a);
    if (upcomingPart) {
      textEl.appendChild(document.createTextNode(' '));
    }
  }
  if (upcomingPart) {
    const u = document.createElement('span');
    u.className = 'word-upcoming';
    u.textContent = upcomingPart;
    textEl.appendChild(u);
  }
}

function applyEnTurnState(turn, state, progress = 0.35) {
  if (!turn || !turn.element) return;
  turn.state = state;
  turn.element.dataset.enState = state;
  const labelEl = turn.element.querySelector('.utterance-state-label');
  const textEl = turn.element.querySelector('.utterance-text');

  if (labelEl) {
    if (state === 'speaking') {
      labelEl.textContent = 'Đang đọc bản dịch';
    } else if (state === 'queued') {
      labelEl.textContent = 'Chờ phát tiếp theo';
    } else {
      labelEl.textContent = 'Đã phát xong';
    }
  }

  if (textEl) {
    const clean = (turn.rawText || '').replace(/\s{2,}/g, ' ').trim();
    if (state === 'speaking') {
      renderSpeakingWords(textEl, clean, progress);
    } else {
      textEl.textContent = clean;
    }
  }
}

function syncRollingIndicators() {
  const nowAudio = playbackContext ? playbackContext.currentTime : 0;
  let speakingTurn = null;
  let queuedCount = 0;

  for (const turn of enTurns) {
    if (turn.manualState) {
      applyEnTurnState(turn, turn.manualState, turn.manualProgress ?? 0.4);
      if (turn.manualState === 'speaking') speakingTurn = turn;
      if (turn.manualState === 'queued') queuedCount += 1;
      continue;
    }

    const hasAudioWindow =
      turn.audioStartTime !== null && turn.audioEndTime > turn.audioStartTime;

    if (hasAudioWindow) {
      if (nowAudio + 0.02 < turn.audioStartTime) {
        if (speakingTurn) {
          applyEnTurnState(turn, 'queued');
          queuedCount += 1;
        } else {
          speakingTurn = turn;
          applyEnTurnState(turn, 'speaking', 0.1);
        }
      } else if (nowAudio <= turn.audioEndTime + 0.04) {
        if (!speakingTurn) {
          speakingTurn = turn;
          const duration = Math.max(0.1, turn.audioEndTime - turn.audioStartTime);
          const progress =
            typeof turn.manualProgress === 'number'
              ? turn.manualProgress
              : (nowAudio - turn.audioStartTime) / duration;
          applyEnTurnState(turn, 'speaking', progress);
        } else {
          applyEnTurnState(turn, 'queued');
          queuedCount += 1;
        }
      } else {
        applyEnTurnState(turn, 'played');
        if (turn.vnItem) {
          setVnUtteranceState(turn.vnItem, 'translated');
        }
      }
    } else {
      if (!turn.turnCompleted) {
        if (!speakingTurn) {
          speakingTurn = turn;
          applyEnTurnState(turn, 'speaking', 0.35);
        } else {
          applyEnTurnState(turn, 'queued');
          queuedCount += 1;
        }
      } else {
        const elapsedSinceDone = performance.now() - (turn.completedAtMs || 0);
        if (elapsedSinceDone < 450 && !speakingTurn) {
          speakingTurn = turn;
          applyEnTurnState(turn, 'speaking', Math.min(0.9, elapsedSinceDone / 450));
        } else {
          applyEnTurnState(turn, 'played');
          if (turn.vnItem) {
            setVnUtteranceState(turn.vnItem, 'translated');
          }
        }
      }
    }
  }

  const hasPendingVn = Boolean(pendingLiveVnText) || isCapturingRollingSpeech;
  const showBanner = Boolean(speakingTurn) || queuedCount > 0;
  const showRollingBar =
    showBanner && (isRecording || hasPendingVn || queuedCount > 0);

  if (enPlaybackBanner) {
    enPlaybackBanner.hidden = !showBanner;
    if (enPlaybackBannerText) {
      enPlaybackBannerText.textContent = 'Loa đang đọc · Mic vẫn mở';
    }
  }

  if (rollingStatus) {
    rollingStatus.hidden = !showRollingBar;
    if (rollingListenText) {
      rollingListenText.textContent = hasPendingVn
        ? 'Đang nghe cuốn chiếu câu tiếp...'
        : 'Đang nghe cuốn chiếu câu tiếp...';
    }
    if (rollingPlayText) {
      rollingPlayText.textContent = 'Đang đọc bản dịch...';
    }
  }

  const allVnItems = [
    ...vnTranscriptBox.querySelectorAll('.utterance-item'),
  ];
  if (allVnItems.length > 0) {
    if (isModelGeneratingTurn || (showBanner && hasPendingVn)) {
      allVnItems.forEach((item, idx) => {
        setVnUtteranceState(
          item,
          idx === allVnItems.length - 1 ? 'translating' : 'translated'
        );
      });
    } else if (!speakingTurn && queuedCount === 0 && !isModelGeneratingTurn) {
      allVnItems.forEach((item) => setVnUtteranceState(item, 'translated'));
    }
  }

  if (isRecording) {
    if (showBanner || hasPendingVn) {
      setStatus('active', 'Đang nghe liên tục');
      if (hasPendingVn) {
        vnStatusTag.textContent = 'Đang nghe câu tiếp';
      }
    }
    if (queuedCount > 0) {
      enStatusTag.textContent = 'Đang đọc và xếp hàng';
    } else if (!speakingTurn) {
      enStatusTag.textContent =
        'Câu tiếp theo được thu ngay cả khi bản dịch đang phát.';
    }
  }
}

function ensurePlaybackSyncLoop() {
  if (playbackSyncTimer) return;
  playbackSyncTimer = setInterval(() => {
    syncRollingIndicators();
    const anyActive = enTurns.some(
      (t) => t.state === 'speaking' || t.state === 'queued'
    );
    if (!anyActive && !pendingLiveVnText && !isRecording) {
      clearInterval(playbackSyncTimer);
      playbackSyncTimer = null;
    }
  }, 90);
}

function schedulePcm24kPlayback(base64Data, targetTurn = currentEnTurn) {
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
  const endAt = startAt + effectiveDuration;
  nextPlayTime = endAt;

  if (targetTurn) {
    if (targetTurn.audioStartTime === null) {
      targetTurn.audioStartTime = startAt;
    }
    targetTurn.audioEndTime = Math.max(targetTurn.audioEndTime || 0, endAt);
  }

  activeAudioSources.push(source);
  source.onended = () => {
    activeAudioSources = activeAudioSources.filter((s) => s !== source);
    syncRollingIndicators();
  };

  syncRollingIndicators();
  ensurePlaybackSyncLoop();
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
  syncRollingIndicators();
}

export function appendOrUpdateUtterance(
  box,
  currentItem,
  text,
  tagLabel,
  replaceFull = false,
  stateAttr = null
) {
  const hint = box.querySelector('.empty-hint');
  if (hint) hint.remove();

  if (box === enTranscriptBox) btnCopyTranslation.disabled = false;

  const isVnBox = box === vnTranscriptBox;

  if (!currentItem) {
    const item = document.createElement('article');
    item.className = 'utterance-item';
    item.dataset.rawText = text;

    const stateLabel = document.createElement('span');
    stateLabel.className = 'utterance-state-label';

    if (isVnBox) {
      const vnState = stateAttr || 'translating';
      item.dataset.vnState = vnState;
      stateLabel.textContent =
        vnState === 'translating' ? 'Đang dịch sang tiếng Anh' : 'Đã dịch';
    } else {
      const enState = stateAttr || 'speaking';
      item.dataset.enState = enState;
      stateLabel.textContent =
        enState === 'queued'
          ? 'Chờ phát tiếp theo'
          : enState === 'played'
            ? 'Đã phát xong'
            : 'Đang đọc bản dịch';
    }

    const contentSpan = document.createElement('span');
    contentSpan.className = 'utterance-text';
    contentSpan.textContent = text.trim();

    const metaSpan = document.createElement('span');
    metaSpan.className = 'utterance-meta';
    metaSpan.hidden = true;
    metaSpan.textContent = tagLabel || '';

    item.append(stateLabel, contentSpan, metaSpan);
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

function ensureCurrentEnTurn(initialText = '') {
  if (!currentEnTurn) {
    const anotherSpeaking = enTurns.some((t) => t.state === 'speaking');
    const initialState = anotherSpeaking ? 'queued' : 'speaking';
    const element = appendOrUpdateUtterance(
      enTranscriptBox,
      null,
      initialText,
      `${playbackSpeed.toFixed(2)}x`,
      true,
      initialState
    );
    currentEnTurn = {
      element,
      rawText: initialText,
      audioStartTime: null,
      audioEndTime: 0,
      turnCompleted: false,
      completedAtMs: 0,
      state: initialState,
      vnItem: currentVnItem,
    };
    enTurns.push(currentEnTurn);
    syncRollingIndicators();
    ensurePlaybackSyncLoop();
  } else if (initialText) {
    appendOrUpdateUtterance(
      enTranscriptBox,
      currentEnTurn.element,
      initialText,
      `${playbackSpeed.toFixed(2)}x`,
      false
    );
    currentEnTurn.rawText = currentEnTurn.element.dataset.rawText || '';
    syncRollingIndicators();
  }
  return currentEnTurn;
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

function flushRollingInputQueue() {
  if (!liveClientSession || isModelGeneratingTurn || rollingInputQueue.length === 0) {
    return;
  }

  const queuedItems = rollingInputQueue.splice(0, rollingInputQueue.length);
  isCapturingRollingSpeech = false;

  const textEntry = queuedItems.find((item) => typeof item.text === 'string');
  if (textEntry) {
    showPendingVnBuffer('');
    currentTurnStartMs = performance.now();
    currentTurnFirstByteMs = null;
    currentVnItem = appendOrUpdateUtterance(
      vnTranscriptBox,
      null,
      textEntry.text,
      `#${turnCounter + 1}`,
      true,
      'translating'
    );
    isModelGeneratingTurn = true;
    liveClientSession.sendRealtimeInput({ text: textEntry.text });
    return;
  }

  if (pendingLiveVnText) {
    showPendingVnBuffer('');
  }

  let hasStreamEnd = false;
  for (const item of queuedItems) {
    if (item.audio) {
      liveClientSession.sendRealtimeInput({ audio: item.audio });
    }
    if (item.audioStreamEnd) {
      hasStreamEnd = true;
      currentTurnStartMs = performance.now();
      currentTurnFirstByteMs = null;
      liveClientSession.sendRealtimeInput({ audioStreamEnd: true });
    }
  }
  if (hasStreamEnd) {
    isModelGeneratingTurn = true;
  }
}

function stripSsmlTags(text = '') {
  return String(text || '').replace(/<\/?speak\b[^>]*>/gi, '');
}

export function handleServerResponse(response) {
  const content = response?.serverContent;
  if (!content) return;
  const now = performance.now();

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
      if (isSpeakerPlaying() && currentVnItem && currentEnTurn && isModelGeneratingTurn) {
        showPendingVnBuffer(cleanedVn);
      } else {
        showPendingVnBuffer('');
        vnStatusTag.textContent = isSpeakerPlaying()
          ? 'Đang nghe câu tiếp'
          : 'Đang nhận tiếng Việt';
        const previousVnItems = vnTranscriptBox.querySelectorAll(
          '.utterance-item[data-vn-state="translating"]'
        );
        previousVnItems.forEach((item) => {
          if (item !== currentVnItem) {
            setVnUtteranceState(item, 'translated');
          }
        });
        currentVnItem = appendOrUpdateUtterance(
          vnTranscriptBox,
          currentVnItem,
          cleanedVn,
          `#${turnCounter + 1}`,
          true,
          'translating'
        );
        if (currentEnTurn && !currentEnTurn.vnItem) {
          currentEnTurn.vnItem = currentVnItem;
        }
      }
    }
  }

  if (content.modelTurn?.parts) {
    isModelGeneratingTurn = true;
    for (const part of content.modelTurn.parts) {
      if (part.inlineData?.data) {
        if (!currentTurnStartMs) currentTurnStartMs = now - 180;
        if (!currentTurnFirstByteMs) {
          currentTurnFirstByteMs = now;
          enStatusTag.textContent = `Phản hồi: ${Math.round(
            currentTurnFirstByteMs - currentTurnStartMs
          )} ms`;
        }
        const turn = ensureCurrentEnTurn('');
        schedulePcm24kPlayback(part.inlineData.data, turn);
      }
      if (part.text) {
        const cleanEn = stripSsmlTags(part.text);
        if (cleanEn) {
          if (!currentTurnStartMs) currentTurnStartMs = now - 180;
          if (!currentTurnFirstByteMs) {
            currentTurnFirstByteMs = now;
          }
          ensureCurrentEnTurn(cleanEn);
        }
      }
    }
  }

  if (content.outputTranscription?.text) {
    const cleanOut = stripSsmlTags(content.outputTranscription.text);
    if (cleanOut) {
      isModelGeneratingTurn = true;
      if (!currentTurnStartMs) currentTurnStartMs = now - 180;
      if (!currentTurnFirstByteMs) {
        currentTurnFirstByteMs = now;
        enStatusTag.textContent = `Phản hồi: ${Math.round(
          currentTurnFirstByteMs - currentTurnStartMs
        )} ms`;
      }
      ensureCurrentEnTurn(cleanOut);
    }
  }

  if (content.interrupted === true) {
    if (!isRecording) {
      clearAudioQueue();
    }
  }

  if (content.turnComplete === true) {
    isModelGeneratingTurn = false;
    if (currentVnItem) {
      setVnUtteranceState(currentVnItem, 'translated');
    }
    if (currentEnTurn) {
      currentEnTurn.turnCompleted = true;
      currentEnTurn.completedAtMs = now;
    }
    if (currentTurnStartMs) {
      const ttfa = (currentTurnFirstByteMs || now) - currentTurnStartMs;
      const total = now - currentTurnStartMs;
      const preview =
        currentEnTurn?.rawText?.trim() ||
        currentVnItem?.querySelector('.utterance-text')?.textContent ||
        '';
      recordTurnLatency(ttfa, total, preview);
    }
    currentTurnStartMs = null;
    currentTurnFirstByteMs = null;
    currentVnItem = null;
    currentVnRawText = '';
    currentEnTurn = null;
    syncRollingIndicators();
    ensurePlaybackSyncLoop();
    flushRollingInputQueue();
  }
}

async function connectDirectGeminiLive() {
  closeActiveLiveClientSession();

  const model = modelSelect.value;
  const profileId = activeProfileId || 'default';
  const res = await fetch('/api/ephemeral-token', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'X-GLT-Client': 'web',
    },
    body: JSON.stringify({ model, profileId, requireUnlock: true }),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    if (errData.requiresUnlock) {
      const target = profilesList.find((p) => p.id === profileId);
      if (target) target.isUnlocked = false;
      openUnlockConfirm(profileId);
    }
    throw new Error(errData.error || `HTTP ${res.status}`);
  }

  const { token, systemInstruction, voiceName, voiceGender } = await res.json();
  if (!token) {
    throw new Error('Không nhận được Ephemeral Token từ Server');
  }

  const activeProfile = getActiveProfile();
  const resolvedVoiceName =
    voiceName ||
    ((voiceGender || activeProfile.voiceGender) === 'female' ? 'Kore' : 'Puck');

  const ai = new GoogleGenAI({
    apiKey: token,
    vertexai: false,
    httpOptions: { apiVersion: 'v1alpha' },
  });

  const speechConfig = {
    voiceConfig: {
      prebuiltVoiceConfig: {
        voiceName: resolvedVoiceName,
      },
    },
  };

  const realtimeInputConfig = {
    activityHandling: 'NO_INTERRUPTION',
    automaticActivityDetection: {
      disabled: false,
      silenceDurationMs: 450,
      prefixPaddingMs: 120,
    },
  };

  const isTranslateModel = model.includes('translate');
  const liveConfig = isTranslateModel
    ? {
        responseModalities: [Modality.AUDIO],
        speechConfig,
        realtimeInputConfig,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        translationConfig: {
          targetLanguageCode: 'en',
          echoTargetLanguage: false,
        },
      }
    : {
        responseModalities: [Modality.AUDIO],
        speechConfig,
        realtimeInputConfig,
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
          isModelGeneratingTurn = false;
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
  const activeProfile = getActiveProfile();
  if (doesProfileNeedPinUnlock(activeProfile)) {
    openUnlockConfirm(activeProfile.id, {
      onUnlocked: () => {
        startLiveSession();
      },
    });
    showFeedback(
      `Vui lòng nhập mã PIN để mở khóa hồ sơ "${activeProfile.name}" trên thiết bị này.`
    );
    return;
  }

  isStarting = true;
  closeAddDrawer(false);
  closeDeleteConfirm(false);
  closeUnlockConfirm(false);
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

      const rollingActive = isModelGeneratingTurn || isSpeakerPlaying();

      if (data.type === 'speech_start') {
        if (rollingActive) {
          isCapturingRollingSpeech = true;
          vnStatusTag.textContent = 'Đang nghe câu tiếp';
          if (!pendingLiveVnText) {
            showPendingVnBuffer('Đang thu âm câu tiếp theo...');
          }
        } else {
          vnStatusTag.textContent = 'Đang nghe...';
        }
        syncRollingIndicators();
      } else if (data.type === 'pcm_chunk') {
        const audioPayload = {
          data: arrayBufferToBase64(data.pcm16),
          mimeType: 'audio/pcm;rate=16000',
        };
        if (isModelGeneratingTurn) {
          isCapturingRollingSpeech = true;
          if (!pendingLiveVnText) {
            showPendingVnBuffer('Đang thu âm câu tiếp theo...');
          }
          rollingInputQueue.push({ audio: audioPayload });
        } else {
          liveClientSession.sendRealtimeInput({ audio: audioPayload });
        }
      } else if (data.type === 'speech_end') {
        isCapturingRollingSpeech = false;
        if (isModelGeneratingTurn) {
          rollingInputQueue.push({ audioStreamEnd: true });
        } else {
          currentTurnStartMs = performance.now();
          currentTurnFirstByteMs = null;
          isModelGeneratingTurn = true;
          liveClientSession.sendRealtimeInput({
            audioStreamEnd: true,
          });
        }
        syncRollingIndicators();
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
    syncRollingIndicators();
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
  isModelGeneratingTurn = false;
  isCapturingRollingSpeech = false;
  rollingInputQueue = [];
  showPendingVnBuffer('');
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
  currentEnTurn = null;

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
  for (const turn of enTurns) {
    applyEnTurnState(turn, 'played');
  }
  syncRollingIndicators();
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
  clearAudioQueue();
  vnTranscriptBox.innerHTML =
    '<p class="empty-hint">Bật mic.<br />Nói điều bạn muốn.</p>';
  enTranscriptBox.innerHTML =
    '<p class="empty-hint">Your words,<br />in English.</p>';
  latencyList.innerHTML =
    '<p class="empty-hint">Có bản dịch đầu tiên, độ trễ sẽ hiển thị ở đây.</p>';
  currentVnItem = null;
  currentVnRawText = '';
  currentEnTurn = null;
  enTurns.length = 0;
  showPendingVnBuffer('');
  currentTurnStartMs = null;
  currentTurnFirstByteMs = null;
  btnCopyTranslation.disabled = true;
  vnStatusTag.textContent = 'Tiếng Việt';
  enStatusTag.textContent =
    'Câu tiếp theo được thu ngay cả khi bản dịch đang phát.';
  latencyHistory.length = 0;
  turnCounter = 0;
  avgLatencyLabel.textContent = 'TB: -- ms';
  syncRollingIndicators();
});

quickTextForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = quickTextInput.value.trim();
  if (!raw) return;

  const activeProfile = getActiveProfile();
  if (doesProfileNeedPinUnlock(activeProfile)) {
    openUnlockConfirm(activeProfile.id, {
      onUnlocked: () => {
        quickTextForm.requestSubmit();
      },
    });
    showFeedback(
      `Vui lòng nhập mã PIN để mở khóa hồ sơ "${activeProfile.name}" trên thiết bị này.`
    );
    return;
  }

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

  if (isModelGeneratingTurn) {
    showPendingVnBuffer(cleaned);
    rollingInputQueue.push({ text: cleaned });
    syncRollingIndicators();
    return;
  }

  currentVnItem = null;
  currentVnRawText = '';
  currentEnTurn = null;
  currentTurnStartMs = performance.now();
  currentTurnFirstByteMs = null;
  isModelGeneratingTurn = true;

  currentVnItem = appendOrUpdateUtterance(
    vnTranscriptBox,
    null,
    cleaned,
    `#${turnCounter + 1}`,
    true,
    'translating'
  );
  liveClientSession.sendRealtimeInput({ text: cleaned });
  syncRollingIndicators();
});

async function loadInitialConfig() {
  await loadProfiles();
  try {
    const res = await fetch('/api/config', { credentials: 'same-origin' });
    const cfg = await res.json();
    const active = getActiveProfile();
    const voiceTag =
      active.voiceLabel || (active.voiceGender === 'female' ? 'Nữ' : 'Nam');
    if (!cfg.hasConfiguredKey && active.id === 'default') {
      setStatus('error', 'Chưa cấu hình GEMINI_API_KEY');
    } else {
      setStatus(
        'idle',
        active.id === 'default'
          ? 'Sẵn sàng'
          : `Sẵn sàng · Hồ sơ: ${active.name} (${voiceTag})`
      );
    }
  } catch {
    setStatus('error', 'Không kết nối được Server');
  }
}

loadInitialConfig();
