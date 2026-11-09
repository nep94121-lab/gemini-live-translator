import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const OWNER_COOKIE_NAME = 'glt_owner_session';
export const UNLOCKED_COOKIE_NAME = 'glt_unlocked_profiles';
export const DEFAULT_PROFILE_NAME = 'Tuấn Anh';
export const DEFAULT_PROFILE_PIN = process.env.DEFAULT_PROFILE_PIN || '512005';
export const PIN_REGEX = /^[0-9]{4,8}$/;
export const MAX_PIN_ATTEMPTS = 5;
export const PIN_LOCKOUT_MS = 15 * 60 * 1000;

export const VOICE_GENDER_MAP = {
  male: {
    voiceGender: 'male',
    voiceName: 'Puck',
    voiceLabel: 'Nam',
  },
  female: {
    voiceGender: 'female',
    voiceName: 'Kore',
    voiceLabel: 'Nữ',
  },
};

export function normalizeVoiceGender(rawGender) {
  if (!rawGender || typeof rawGender !== 'string') return 'male';
  const v = rawGender.trim().toLocaleLowerCase('vi');
  if (v === 'female' || v === 'nu' || v === 'nữ' || v === 'f' || v === 'kore') {
    return 'female';
  }
  return 'male';
}

export function getVoiceMetadata(rawGender) {
  const gender = normalizeVoiceGender(rawGender);
  return VOICE_GENDER_MAP[gender] || VOICE_GENDER_MAP.male;
}

export function sanitizeSecretFromText(text, secretKey = '') {
  if (!text || typeof text !== 'string') return '';
  let out = text.trim();
  const jsonStart = out.indexOf('{"error":');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(out.slice(jsonStart));
      if (parsed?.error?.message) {
        out = parsed.error.message;
      }
    } catch {}
  }
  if (secretKey && typeof secretKey === 'string' && secretKey.trim().length >= 6) {
    out = out.split(secretKey.trim()).join('[REDACTED_KEY]');
  }
  out = out.replace(/AIza[0-9A-Za-z_-]{16,}/g, '[REDACTED_KEY]');
  return out;
}

function isTimingSafeHexEqual(hexA, hexB) {
  if (typeof hexA !== 'string' || typeof hexB !== 'string') return false;
  if (hexA.length !== hexB.length || hexA.length === 0 || hexA.length % 2 !== 0) {
    return false;
  }
  try {
    const bufA = Buffer.from(hexA, 'hex');
    const bufB = Buffer.from(hexB, 'hex');
    if (bufA.length !== bufB.length || bufA.length === 0) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

export function parseCookies(cookieHeader = '') {
  const out = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function signSessionId(sessionId, sessionSecret) {
  return crypto
    .createHmac('sha256', sessionSecret)
    .update(`glt-session-v1:${sessionId}`)
    .digest('base64url');
}

export function verifySessionToken(token, sessionSecret) {
  if (!token || typeof token !== 'string' || !sessionSecret) return null;
  const dotIdx = token.indexOf('.');
  if (dotIdx <= 0) return null;
  const sessionId = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  if (!/^[a-f0-9]{32,64}$/.test(sessionId) || !sig) return null;
  const expectedSig = signSessionId(sessionId, sessionSecret);
  const bufActual = Buffer.from(sig, 'utf8');
  const bufExpected = Buffer.from(expectedSig, 'utf8');
  if (bufActual.length !== bufExpected.length) return null;
  if (!crypto.timingSafeEqual(bufActual, bufExpected)) return null;
  return sessionId;
}

export function computeOwnerProofHash(sessionId, sessionSecret) {
  if (!sessionId || !sessionSecret) return '';
  return crypto
    .createHmac('sha256', sessionSecret)
    .update(`glt-owner-proof-v1:${sessionId}`)
    .digest('hex');
}

export function getExistingOwnerSession(req, sessionSecret) {
  if (!req || !sessionSecret) return null;
  if (req._gltOwnerSession) return req._gltOwnerSession;
  const cookies = parseCookies(req.headers?.cookie || '');
  const rawToken = cookies[OWNER_COOKIE_NAME];
  const sessionId = verifySessionToken(rawToken, sessionSecret);
  if (!sessionId) return null;
  const session = {
    sessionId,
    ownerProofHash: computeOwnerProofHash(sessionId, sessionSecret),
    isNew: false,
  };
  req._gltOwnerSession = session;
  return session;
}

export function getOrCreateOwnerSession(req, res, sessionSecret) {
  const existing = getExistingOwnerSession(req, sessionSecret);
  if (existing) return existing;

  const sessionId = crypto.randomBytes(24).toString('hex');
  const sig = signSessionId(sessionId, sessionSecret);
  const signedToken = `${sessionId}.${sig}`;
  const isHttps = Boolean(
    req?.secure ||
      String(req?.headers?.['x-forwarded-proto'] || '').includes('https') ||
      process.env.VERCEL === '1'
  );
  const cookieParts = [
    `${OWNER_COOKIE_NAME}=${encodeURIComponent(signedToken)}`,
    'Path=/',
    'Max-Age=31536000',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (isHttps) {
    cookieParts.push('Secure');
  }
  if (res && typeof res.setHeader === 'function') {
    const prev = res.getHeader?.('Set-Cookie');
    const cookieStr = cookieParts.join('; ');
    if (!prev) {
      res.setHeader('Set-Cookie', cookieStr);
    } else if (Array.isArray(prev)) {
      res.setHeader('Set-Cookie', [...prev, cookieStr]);
    } else {
      res.setHeader('Set-Cookie', [String(prev), cookieStr]);
    }
  }

  const session = {
    sessionId,
    ownerProofHash: computeOwnerProofHash(sessionId, sessionSecret),
    isNew: true,
  };
  if (req) req._gltOwnerSession = session;
  return session;
}

function signUnlockedPayload(payloadB64, sessionSecret) {
  return crypto
    .createHmac('sha256', sessionSecret)
    .update(`glt-unlocked-v1:${payloadB64}`)
    .digest('base64url');
}

export function getUnlockedProfileIds(req, sessionSecret) {
  if (!req || !sessionSecret) return new Set();
  if (req._gltUnlockedSet instanceof Set) return new Set(req._gltUnlockedSet);
  const cookies = parseCookies(req.headers?.cookie || '');
  const rawToken = cookies[UNLOCKED_COOKIE_NAME];
  if (!rawToken || typeof rawToken !== 'string') return new Set();
  const dotIdx = rawToken.indexOf('.');
  if (dotIdx <= 0) return new Set();
  const payloadB64 = rawToken.slice(0, dotIdx);
  const sig = rawToken.slice(dotIdx + 1);
  if (!payloadB64 || !sig) return new Set();
  const expectedSig = signUnlockedPayload(payloadB64, sessionSecret);
  const bufActual = Buffer.from(sig, 'utf8');
  const bufExpected = Buffer.from(expectedSig, 'utf8');
  if (bufActual.length !== bufExpected.length) return new Set();
  if (!crypto.timingSafeEqual(bufActual, bufExpected)) return new Set();
  try {
    const parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed)) return new Set();
    const set = new Set(
      parsed.filter((item) => typeof item === 'string' && item.length > 0 && item.length <= 64)
    );
    req._gltUnlockedSet = set;
    return new Set(set);
  } catch {
    return new Set();
  }
}

export function setUnlockedProfileIdsCookie(req, res, sessionSecret, unlockedIds) {
  if (!res || typeof res.setHeader !== 'function' || !sessionSecret) return;
  const list = [...new Set(unlockedIds)].slice(-40);
  const payloadB64 = Buffer.from(JSON.stringify(list), 'utf8').toString('base64url');
  const sig = signUnlockedPayload(payloadB64, sessionSecret);
  const signedToken = `${payloadB64}.${sig}`;
  const isHttps = Boolean(
    req?.secure ||
      String(req?.headers?.['x-forwarded-proto'] || '').includes('https') ||
      process.env.VERCEL === '1'
  );
  const cookieParts = [
    `${UNLOCKED_COOKIE_NAME}=${encodeURIComponent(signedToken)}`,
    'Path=/',
    'Max-Age=31536000',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (isHttps) {
    cookieParts.push('Secure');
  }
  const cookieStr = cookieParts.join('; ');
  const prev = res.getHeader?.('Set-Cookie');
  if (!prev) {
    res.setHeader('Set-Cookie', cookieStr);
  } else if (Array.isArray(prev)) {
    const filtered = prev.filter((c) => !String(c).startsWith(`${UNLOCKED_COOKIE_NAME}=`));
    res.setHeader('Set-Cookie', [...filtered, cookieStr]);
  } else {
    const prevStr = String(prev);
    if (prevStr.startsWith(`${UNLOCKED_COOKIE_NAME}=`)) {
      res.setHeader('Set-Cookie', cookieStr);
    } else {
      res.setHeader('Set-Cookie', [prevStr, cookieStr]);
    }
  }
  if (req) {
    req._gltUnlockedSet = new Set(list);
  }
}

function deriveAesKey(encryptionSecret) {
  if (!encryptionSecret || typeof encryptionSecret !== 'string') {
    throw new Error('Thiếu khóa mã hóa PROFILE_ENCRYPTION_KEY trên server.');
  }
  return crypto.scryptSync(encryptionSecret, 'glt-aes-256-gcm-v1', 32);
}

export function encryptApiKey(apiKey, profileId, ownerProofHash, encryptionSecret) {
  const key = deriveAesKey(encryptionSecret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${profileId}:${ownerProofHash}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: ciphertext.toString('base64'),
  };
}

export function decryptApiKey(encryptedObj, profileId, ownerProofHash, encryptionSecret) {
  if (
    !encryptedObj ||
    typeof encryptedObj.iv !== 'string' ||
    typeof encryptedObj.tag !== 'string' ||
    typeof encryptedObj.data !== 'string'
  ) {
    throw new Error('Dữ liệu khóa mã hóa của hồ sơ không hợp lệ.');
  }
  const key = deriveAesKey(encryptionSecret);
  const iv = Buffer.from(encryptedObj.iv, 'base64');
  const tag = Buffer.from(encryptedObj.tag, 'base64');
  const data = Buffer.from(encryptedObj.data, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(`${profileId}:${ownerProofHash}`, 'utf8'));
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}

function hashPin(pin, saltHex) {
  return crypto.scryptSync(String(pin), saltHex, 32).toString('hex');
}

export class FileStorageAdapter {
  constructor(filePath) {
    this.filePath = filePath;
    this._queue = Promise.resolve();
  }

  async readState() {
    if (!fs.existsSync(this.filePath)) {
      return { state: { version: 1, updatedAt: 0, profiles: [] }, sha: null };
    }
    const raw = await fs.promises.readFile(this.filePath, 'utf8');
    if (!raw.trim()) {
      return { state: { version: 1, updatedAt: 0, profiles: [] }, sha: null };
    }
    const parsed = JSON.parse(raw);
    return {
      state: {
        version: 1,
        updatedAt: Number(parsed?.updatedAt || 0),
        profiles: Array.isArray(parsed?.profiles) ? parsed.profiles : [],
      },
      sha: 'local',
    };
  }

  mutateState(mutatorFn) {
    const run = async () => {
      const { state } = await this.readState();
      const working = structuredClone(state);
      const result = await mutatorFn(working);
      if (result?.changed !== false) {
        working.updatedAt = Date.now();
        await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.promises.writeFile(
          this.filePath,
          `${JSON.stringify(working, null, 2)}\n`,
          'utf8'
        );
      }
      return result;
    };
    const next = this._queue.then(run, run);
    this._queue = next.catch(() => {});
    return next;
  }
}

export class GitHubRepoStorageAdapter {
  constructor({
    repo,
    token,
    filePath = 'profiles.json',
    apiBase = 'https://api.github.com',
    cacheTtlMs = 2000,
  }) {
    if (!repo || !token) {
      throw new Error(
        'Thiếu cấu hình kho dữ liệu bền vững (PROFILE_STORE_GITHUB_REPO / PROFILE_STORE_GITHUB_TOKEN).'
      );
    }
    this.repo = repo.trim();
    this.token = token.trim();
    this.filePath = filePath.replace(/^\/+/, '');
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.cacheTtlMs = Number(cacheTtlMs) >= 0 ? Number(cacheTtlMs) : 2000;
    this._queue = Promise.resolve();
    this._cachedSnapshot = null;
    this._cachedAt = 0;
    this._inflightRead = null;
  }

  _headers(extra = {}) {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Cache-Control': 'no-cache, no-store',
      'User-Agent': 'gemini-live-translator-profile-store',
      ...extra,
    };
  }

  _url() {
    return `${this.apiBase}/repos/${this.repo}/contents/${this.filePath}`;
  }

  async readState(forceRefresh = false) {
    const now = Date.now();
    if (
      !forceRefresh &&
      this._cachedSnapshot &&
      this.cacheTtlMs > 0 &&
      now - this._cachedAt <= this.cacheTtlMs
    ) {
      return {
        state: structuredClone(this._cachedSnapshot.state),
        sha: this._cachedSnapshot.sha,
      };
    }

    if (!forceRefresh && this._inflightRead) {
      const shared = await this._inflightRead;
      return {
        state: structuredClone(shared.state),
        sha: shared.sha,
      };
    }

    const fetchPromise = (async () => {
      const res = await fetch(this._url(), {
        method: 'GET',
        headers: this._headers(),
      });
      if (res.status === 404) {
        const emptySnap = {
          state: { version: 1, updatedAt: 0, profiles: [] },
          sha: null,
        };
        this._cachedSnapshot = emptySnap;
        this._cachedAt = Date.now();
        return emptySnap;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Không thể đọc kho hồ sơ (${res.status}): ${text.slice(0, 120)}`);
      }
      const data = await res.json();
      const rawContent = Buffer.from(String(data.content || ''), 'base64').toString('utf8');
      const parsed = rawContent.trim() ? JSON.parse(rawContent) : {};
      const snap = {
        state: {
          version: 1,
          updatedAt: Number(parsed?.updatedAt || 0),
          profiles: Array.isArray(parsed?.profiles) ? parsed.profiles : [],
        },
        sha: data.sha || null,
      };
      this._cachedSnapshot = snap;
      this._cachedAt = Date.now();
      return snap;
    })();

    if (!forceRefresh) {
      this._inflightRead = fetchPromise;
    }
    try {
      const snap = await fetchPromise;
      return {
        state: structuredClone(snap.state),
        sha: snap.sha,
      };
    } finally {
      if (this._inflightRead === fetchPromise) {
        this._inflightRead = null;
      }
    }
  }

  mutateState(mutatorFn) {
    const run = async () => {
      let forceRefresh = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        const { state, sha } = await this.readState(forceRefresh);
        const working = structuredClone(state);
        const result = await mutatorFn(working);
        if (result?.changed === false) {
          return result;
        }
        working.updatedAt = Date.now();
        const body = {
          message: result?.commitMessage || 'update profiles state',
          content: Buffer.from(`${JSON.stringify(working, null, 2)}\n`, 'utf8').toString(
            'base64'
          ),
        };
        if (sha) {
          body.sha = sha;
        }
        const putRes = await fetch(this._url(), {
          method: 'PUT',
          headers: this._headers({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(body),
        });
        if (putRes.status === 409 || putRes.status === 422) {
          forceRefresh = true;
          this._cachedSnapshot = null;
          const jitter = Math.floor(Math.random() * 75);
          await new Promise((r) => setTimeout(r, 45 * Math.min(attempt + 1, 8) + jitter));
          continue;
        }
        if (!putRes.ok) {
          const errText = await putRes.text().catch(() => '');
          throw new Error(
            `Không thể lưu hồ sơ vào kho dữ liệu (${putRes.status}): ${errText.slice(0, 120)}`
          );
        }
        const putData = await putRes.json().catch(() => ({}));
        const nextSha = putData?.content?.sha || null;
        this._cachedSnapshot = {
          state: structuredClone(working),
          sha: nextSha,
        };
        this._cachedAt = Date.now();
        return result;
      }
      throw new Error('Xung đột ghi đồng thời vào kho hồ sơ, vui lòng thử lại.');
    };
    const next = this._queue.then(run, run);
    this._queue = next.catch(() => {});
    return next;
  }
}

export function serializeProfilesForOwner(
  storedProfiles = [],
  ownerProofHash = '',
  unlockedProfileIds = null
) {
  const unlockedSet =
    unlockedProfileIds instanceof Set
      ? unlockedProfileIds
      : new Set(Array.isArray(unlockedProfileIds) ? unlockedProfileIds : []);
  const defaultVoice = getVoiceMetadata('male');
  const list = [
    {
      id: 'default',
      name: DEFAULT_PROFILE_NAME,
      locked: true,
      isOwner: true,
      selectable: true,
      ownerNote: null,
      hasPin: true,
      requiresPin: true,
      isUnlocked: unlockedSet.has('default'),
      voiceGender: defaultVoice.voiceGender,
      voiceName: defaultVoice.voiceName,
      voiceLabel: defaultVoice.voiceLabel,
      createdAt: 0,
    },
  ];
  for (const p of storedProfiles) {
    if (!p || typeof p.id !== 'string' || typeof p.name !== 'string') continue;
    const isCreator = Boolean(
      ownerProofHash && isTimingSafeHexEqual(p.ownerProofHash, ownerProofHash)
    );
    const hasPin = Boolean(p.hasPin);
    const isUnlockedByPin = hasPin && unlockedSet.has(p.id);
    const isOwner = isCreator || isUnlockedByPin;
    const isUnlocked = hasPin ? unlockedSet.has(p.id) || isCreator : isCreator;
    const voiceMeta = getVoiceMetadata(p.voiceGender);
    list.push({
      id: p.id,
      name: p.name,
      locked: false,
      isOwner,
      selectable: isOwner,
      ownerNote: isOwner ? null : 'Chỉ chủ hồ sơ',
      hasPin,
      requiresPin: hasPin,
      isUnlocked,
      voiceGender: voiceMeta.voiceGender,
      voiceName: voiceMeta.voiceName,
      voiceLabel: voiceMeta.voiceLabel,
      createdAt: Number(p.createdAt || 0),
    });
  }
  return list;
}

export function createProfileStore(options = {}) {
  const encryptionKey =
    options.encryptionKey ?? process.env.PROFILE_ENCRYPTION_KEY ?? '';
  const sessionSecret =
    options.sessionSecret ?? process.env.PROFILE_SESSION_SECRET ?? '';
  const githubRepo =
    options.githubRepo ?? process.env.PROFILE_STORE_GITHUB_REPO ?? '';
  const githubToken =
    options.githubToken ?? process.env.PROFILE_STORE_GITHUB_TOKEN ?? '';

  const filePath = options.filePath ?? process.env.PROFILE_STORE_FILE_PATH ?? '';
  let adapter = options.storageAdapter || null;
  if (!adapter) {
    if (filePath) {
      adapter = new FileStorageAdapter(filePath);
    } else if (githubRepo && githubToken) {
      adapter = new GitHubRepoStorageAdapter({
        repo: githubRepo,
        token: githubToken,
        filePath: options.githubFilePath || 'profiles.json',
      });
    } else if (process.env.VERCEL) {
      throw new Error(
        'Thiếu cấu hình lưu trữ bền vững trên Vercel (PROFILE_STORE_GITHUB_REPO / PROFILE_STORE_GITHUB_TOKEN).'
      );
    } else {
      throw new Error(
        'Thiếu cấu hình kho dữ liệu hồ sơ (PROFILE_STORE_GITHUB_REPO / PROFILE_STORE_GITHUB_TOKEN hoặc filePath).'
      );
    }
  }

  if (!encryptionKey || !sessionSecret) {
    throw new Error(
      'Thiếu PROFILE_ENCRYPTION_KEY hoặc PROFILE_SESSION_SECRET trên môi trường Server.'
    );
  }

  const defaultPin = String(
    options.defaultPin ?? process.env.DEFAULT_PROFILE_PIN ?? DEFAULT_PROFILE_PIN
  ).trim();
  const defaultPinSalt = crypto
    .createHash('sha256')
    .update(`glt-default-pin-salt:${sessionSecret}`)
    .digest('hex')
    .slice(0, 32);
  const defaultPinHash = hashPin(defaultPin, defaultPinSalt);
  let defaultFailedAttempts = 0;
  let defaultLockedUntil = 0;

  return {
    sessionSecret,
    encryptionKey,
    adapter,
    defaultPin,

    async listProfiles(ownerProofHash, unlockedProfileIds = null) {
      const { state } = await adapter.readState();
      return serializeProfilesForOwner(
        state.profiles,
        ownerProofHash,
        unlockedProfileIds
      );
    },

    async createProfile({
      name,
      apiKey,
      pin,
      voiceGender,
      ownerProofHash,
      unlockedProfileIds = null,
    }) {
      if (!ownerProofHash) {
        const err = new Error('Không xác định được phiên chủ sở hữu.');
        err.status = 401;
        throw err;
      }
      const cleanName = typeof name === 'string' ? name.trim() : '';
      if (!cleanName) {
        const err = new Error('Vui lòng nhập tên hồ sơ.');
        err.status = 400;
        throw err;
      }
      if (cleanName.length > 24) {
        const err = new Error('Tên hồ sơ tối đa 24 ký tự.');
        err.status = 400;
        throw err;
      }
      const lowerName = cleanName.toLocaleLowerCase('vi');
      if (lowerName === 'tôi' || lowerName === 'tuấn anh' || lowerName === 'tuan anh') {
        const err = new Error(
          `Tên "${DEFAULT_PROFILE_NAME}" được dành riêng cho hồ sơ mặc định của chủ web.`
        );
        err.status = 400;
        throw err;
      }

      const cleanKey = typeof apiKey === 'string' ? apiKey.trim() : '';
      if (!cleanKey) {
        const err = new Error('Vui lòng nhập Gemini API Key.');
        err.status = 400;
        throw err;
      }
      if (cleanKey.length < 10 || cleanKey.length > 256 || /\s/.test(cleanKey)) {
        const err = new Error('Gemini API Key không đúng định dạng.');
        err.status = 400;
        throw err;
      }

      const cleanPin =
        pin === undefined || pin === null ? '' : String(pin).trim();
      if (cleanPin !== '' && !PIN_REGEX.test(cleanPin)) {
        const err = new Error('Mã PIN hồ sơ phải gồm từ 4 đến 8 chữ số (0–9).');
        err.status = 400;
        throw err;
      }

      const voiceMeta = getVoiceMetadata(voiceGender);
      const profileId = `prof_${crypto.randomBytes(8).toString('hex')}`;
      const encryptedKey = encryptApiKey(
        cleanKey,
        profileId,
        ownerProofHash,
        encryptionKey
      );
      const pinSalt = cleanPin ? crypto.randomBytes(16).toString('hex') : null;
      const pinHash = cleanPin ? hashPin(cleanPin, pinSalt) : null;
      const createdAt = Date.now();

      const newRecord = {
        id: profileId,
        name: cleanName,
        ownerProofHash,
        encryptedKey,
        hasPin: Boolean(cleanPin),
        pinSalt,
        pinHash,
        voiceGender: voiceMeta.voiceGender,
        voiceName: voiceMeta.voiceName,
        failedPinAttempts: 0,
        pinLockedUntil: 0,
        createdAt,
      };

      const nextUnlocked = new Set(
        unlockedProfileIds instanceof Set
          ? unlockedProfileIds
          : Array.isArray(unlockedProfileIds)
            ? unlockedProfileIds
            : []
      );
      nextUnlocked.add(profileId);

      const outcome = await adapter.mutateState(async (state) => {
        state.profiles.push(newRecord);
        const profiles = serializeProfilesForOwner(
          state.profiles,
          ownerProofHash,
          nextUnlocked
        );
        const created = profiles.find((item) => item.id === profileId);
        return {
          changed: true,
          commitMessage: `create profile ${profileId}`,
          value: {
            profile: created,
            profiles,
            unlockedProfileIds: [...nextUnlocked],
          },
        };
      });

      return outcome.value;
    },

    async unlockProfile({
      profileId,
      pin,
      ownerProofHash,
      unlockedProfileIds = null,
    }) {
      const targetId =
        typeof profileId === 'string' && profileId.trim()
          ? profileId.trim()
          : 'default';
      const cleanPin =
        pin === undefined || pin === null ? '' : String(pin).trim();
      const nextUnlocked = new Set(
        unlockedProfileIds instanceof Set
          ? unlockedProfileIds
          : Array.isArray(unlockedProfileIds)
            ? unlockedProfileIds
            : []
      );

      if (targetId === 'default') {
        const now = Date.now();
        if (defaultLockedUntil && defaultLockedUntil > now) {
          const err = new Error(
            `Đã nhập sai PIN quá số lần cho phép. Tạm khóa mở hồ sơ "${DEFAULT_PROFILE_NAME}", vui lòng thử lại sau.`
          );
          err.status = 429;
          err.body = {
            error: err.message,
            locked: true,
            remainingAttempts: 0,
          };
          throw err;
        }
        if (defaultLockedUntil && defaultLockedUntil <= now) {
          defaultFailedAttempts = 0;
          defaultLockedUntil = 0;
        }

        if (!PIN_REGEX.test(cleanPin)) {
          const err = new Error('Vui lòng nhập mã PIN (4–8 chữ số).');
          err.status = 400;
          err.body = { error: err.message, requiresPin: true };
          throw err;
        }

        const candidateHash = hashPin(cleanPin, defaultPinSalt);
        if (!isTimingSafeHexEqual(candidateHash, defaultPinHash)) {
          defaultFailedAttempts += 1;
          const remaining = Math.max(0, MAX_PIN_ATTEMPTS - defaultFailedAttempts);
          if (remaining === 0) {
            defaultLockedUntil = now + PIN_LOCKOUT_MS;
            const err = new Error(
              `Đã nhập sai PIN 5 lần. Tạm khóa mở hồ sơ "${DEFAULT_PROFILE_NAME}" trong 15 phút.`
            );
            err.status = 429;
            err.body = {
              error: err.message,
              locked: true,
              remainingAttempts: 0,
            };
            throw err;
          }
          const err = new Error(`Mã PIN không đúng. Còn ${remaining} lần thử.`);
          err.status = 403;
          err.body = {
            error: err.message,
            remainingAttempts: remaining,
          };
          throw err;
        }

        defaultFailedAttempts = 0;
        defaultLockedUntil = 0;
        nextUnlocked.add('default');
        const { state } = await adapter.readState();
        const profiles = serializeProfilesForOwner(
          state.profiles,
          ownerProofHash,
          nextUnlocked
        );
        return {
          unlocked: true,
          profileId: 'default',
          profileName: DEFAULT_PROFILE_NAME,
          profiles,
          unlockedProfileIds: [...nextUnlocked],
        };
      }

      const outcome = await adapter.mutateState(async (state) => {
        const record = state.profiles.find((p) => p && p.id === targetId);
        if (!record) {
          return {
            changed: false,
            error: {
              status: 404,
              body: { error: 'Hồ sơ không tồn tại hoặc đã bị xóa.' },
            },
          };
        }

        if (!record.hasPin) {
          const isCreator = Boolean(
            ownerProofHash &&
              isTimingSafeHexEqual(record.ownerProofHash, ownerProofHash)
          );
          if (!isCreator) {
            return {
              changed: false,
              error: {
                status: 403,
                body: {
                  error: `Hồ sơ "${record.name}" không đặt mã PIN nên chỉ dùng được trên trình duyệt đã tạo.`,
                },
              },
            };
          }
          nextUnlocked.add(targetId);
          return {
            changed: false,
            value: {
              unlocked: true,
              profileId: targetId,
              profileName: record.name,
              profiles: serializeProfilesForOwner(
                state.profiles,
                ownerProofHash,
                nextUnlocked
              ),
              unlockedProfileIds: [...nextUnlocked],
            },
          };
        }

        const now = Date.now();
        if (record.pinLockedUntil && record.pinLockedUntil > now) {
          return {
            changed: false,
            error: {
              status: 429,
              body: {
                error:
                  'Đã nhập sai PIN quá số lần cho phép. Tạm khóa hồ sơ này, vui lòng thử lại sau.',
                locked: true,
                remainingAttempts: 0,
              },
            },
          };
        }
        if (record.pinLockedUntil && record.pinLockedUntil <= now) {
          record.failedPinAttempts = 0;
          record.pinLockedUntil = 0;
        }

        if (!PIN_REGEX.test(cleanPin)) {
          return {
            changed: false,
            error: {
              status: 400,
              body: {
                error: 'Vui lòng nhập mã PIN của hồ sơ (4–8 chữ số).',
                requiresPin: true,
              },
            },
          };
        }

        const candidateHash = hashPin(cleanPin, record.pinSalt);
        if (!isTimingSafeHexEqual(candidateHash, record.pinHash)) {
          record.failedPinAttempts = Number(record.failedPinAttempts || 0) + 1;
          const remaining = Math.max(0, MAX_PIN_ATTEMPTS - record.failedPinAttempts);
          if (remaining === 0) {
            record.pinLockedUntil = now + PIN_LOCKOUT_MS;
            return {
              changed: true,
              commitMessage: `lockout pin for ${targetId}`,
              error: {
                status: 429,
                body: {
                  error:
                    'Đã nhập sai PIN 5 lần. Tạm khóa hồ sơ này trong 15 phút.',
                  locked: true,
                  remainingAttempts: 0,
                },
              },
            };
          }
          return {
            changed: true,
            commitMessage: `failed pin attempt for ${targetId}`,
            error: {
              status: 403,
              body: {
                error: `Mã PIN không đúng. Còn ${remaining} lần thử.`,
                remainingAttempts: remaining,
              },
            },
          };
        }

        const hadFailures = Number(record.failedPinAttempts || 0) > 0;
        record.failedPinAttempts = 0;
        record.pinLockedUntil = 0;
        nextUnlocked.add(targetId);
        return {
          changed: hadFailures,
          commitMessage: `reset pin attempts for ${targetId}`,
          value: {
            unlocked: true,
            profileId: targetId,
            profileName: record.name,
            profiles: serializeProfilesForOwner(
              state.profiles,
              ownerProofHash,
              nextUnlocked
            ),
            unlockedProfileIds: [...nextUnlocked],
          },
        };
      });

      if (outcome?.error) {
        const err = new Error(outcome.error.body.error);
        err.status = outcome.error.status;
        err.body = outcome.error.body;
        throw err;
      }
      return outcome.value;
    },

    async deleteProfile({
      profileId,
      pin,
      ownerProofHash,
      unlockedProfileIds = null,
    }) {
      const targetId = typeof profileId === 'string' ? profileId.trim() : '';
      if (!targetId || targetId === 'default') {
        const err = new Error(`Không thể xóa hồ sơ mặc định "${DEFAULT_PROFILE_NAME}".`);
        err.status = 403;
        throw err;
      }

      const nextUnlocked = new Set(
        unlockedProfileIds instanceof Set
          ? unlockedProfileIds
          : Array.isArray(unlockedProfileIds)
            ? unlockedProfileIds
            : []
      );

      const outcome = await adapter.mutateState(async (state) => {
        const idx = state.profiles.findIndex((p) => p && p.id === targetId);
        if (idx === -1) {
          return {
            changed: false,
            error: {
              status: 404,
              body: { error: 'Hồ sơ không tồn tại hoặc đã bị xóa.' },
            },
          };
        }

        const record = state.profiles[idx];
        const isOwner = Boolean(
          ownerProofHash && isTimingSafeHexEqual(record.ownerProofHash, ownerProofHash)
        );
        if (!isOwner) {
          return {
            changed: false,
            error: {
              status: 403,
              body: {
                error: 'Chỉ chủ sở hữu tạo hồ sơ này mới có quyền xóa.',
              },
            },
          };
        }

        if (record.hasPin) {
          const now = Date.now();
          if (record.pinLockedUntil && record.pinLockedUntil > now) {
            return {
              changed: false,
              error: {
                status: 429,
                body: {
                  error:
                    'Đã nhập sai PIN quá số lần cho phép. Tạm khóa xóa hồ sơ này, vui lòng thử lại sau.',
                  locked: true,
                  remainingAttempts: 0,
                },
              },
            };
          }
          if (record.pinLockedUntil && record.pinLockedUntil <= now) {
            record.failedPinAttempts = 0;
            record.pinLockedUntil = 0;
          }

          const cleanPin =
            pin === undefined || pin === null ? '' : String(pin).trim();
          if (!PIN_REGEX.test(cleanPin)) {
            return {
              changed: false,
              error: {
                status: 400,
                body: {
                  error: 'Vui lòng nhập đúng mã PIN của hồ sơ (4–8 chữ số).',
                  requiresPin: true,
                },
              },
            };
          }

          const candidateHash = hashPin(cleanPin, record.pinSalt);
          if (!isTimingSafeHexEqual(candidateHash, record.pinHash)) {
            record.failedPinAttempts = Number(record.failedPinAttempts || 0) + 1;
            const remaining = Math.max(0, MAX_PIN_ATTEMPTS - record.failedPinAttempts);
            if (remaining === 0) {
              record.pinLockedUntil = now + PIN_LOCKOUT_MS;
              return {
                changed: true,
                commitMessage: `lockout pin for ${targetId}`,
                error: {
                  status: 429,
                  body: {
                    error:
                      'Đã nhập sai PIN 5 lần. Tạm khóa xóa hồ sơ này trong 15 phút.',
                    locked: true,
                    remainingAttempts: 0,
                  },
                },
              };
            }
            return {
              changed: true,
              commitMessage: `failed pin attempt for ${targetId}`,
              error: {
                status: 403,
                body: {
                  error: `Mã PIN không đúng. Còn ${remaining} lần thử.`,
                  remainingAttempts: remaining,
                },
              },
            };
          }
        }

        state.profiles.splice(idx, 1);
        nextUnlocked.delete(targetId);
        return {
          changed: true,
          commitMessage: `delete profile ${targetId}`,
          value: {
            deletedId: targetId,
            profiles: serializeProfilesForOwner(
              state.profiles,
              ownerProofHash,
              nextUnlocked
            ),
            unlockedProfileIds: [...nextUnlocked],
          },
        };
      });

      if (outcome?.error) {
        const err = new Error(outcome.error.body.error);
        err.status = outcome.error.status;
        err.body = outcome.error.body;
        throw err;
      }
      return outcome.value;
    },

    async resolveProfileApiKey({
      profileId,
      ownerProofHash,
      unlockedProfileIds = null,
      pin = null,
      requireDefaultUnlock = false,
      defaultServerApiKey,
    }) {
      const targetId =
        typeof profileId === 'string' && profileId.trim()
          ? profileId.trim()
          : 'default';
      const unlockedSet =
        unlockedProfileIds instanceof Set
          ? unlockedProfileIds
          : new Set(Array.isArray(unlockedProfileIds) ? unlockedProfileIds : []);

      if (targetId === 'default') {
        if (pin !== null && pin !== undefined && String(pin).trim() !== '') {
          const candidateHash = hashPin(String(pin).trim(), defaultPinSalt);
          if (!isTimingSafeHexEqual(candidateHash, defaultPinHash)) {
            const err = new Error(
              `Mã PIN của hồ sơ "${DEFAULT_PROFILE_NAME}" không đúng.`
            );
            err.status = 403;
            err.requiresUnlock = true;
            err.profileError = true;
            throw err;
          }
        } else if (requireDefaultUnlock && !unlockedSet.has('default')) {
          const err = new Error(
            `Vui lòng nhập mã PIN để mở khóa hồ sơ "${DEFAULT_PROFILE_NAME}" trên thiết bị này.`
          );
          err.status = 403;
          err.requiresUnlock = true;
          err.profileError = true;
          throw err;
        }

        if (!defaultServerApiKey) {
          const err = new Error('Thiếu GEMINI_API_KEY của chủ web trên Server.');
          err.status = 400;
          throw err;
        }
        const defaultVoice = getVoiceMetadata('male');
        return {
          apiKey: defaultServerApiKey,
          profileId: 'default',
          profileName: DEFAULT_PROFILE_NAME,
          voiceGender: defaultVoice.voiceGender,
          voiceName: defaultVoice.voiceName,
          voiceLabel: defaultVoice.voiceLabel,
          isCustomProfile: false,
        };
      }

      const { state } = await adapter.readState();
      const record = state.profiles.find((p) => p && p.id === targetId);
      if (!record) {
        const err = new Error('Hồ sơ API đã chọn không tồn tại hoặc đã bị xóa.');
        err.status = 404;
        err.profileError = true;
        throw err;
      }

      const isCreator = Boolean(
        ownerProofHash && isTimingSafeHexEqual(record.ownerProofHash, ownerProofHash)
      );
      const isUnlockedByPin = Boolean(record.hasPin && unlockedSet.has(record.id));
      if (!isCreator && !isUnlockedByPin) {
        const err = new Error(
          record.hasPin
            ? `Hồ sơ "${record.name}" chỉ dành cho chủ hồ sơ. Vui lòng nhập mã PIN để mở khóa trên thiết bị này.`
            : `Hồ sơ "${record.name}" chỉ dành cho chủ hồ sơ. Bạn không có quyền sử dụng khóa này.`
        );
        err.status = 403;
        err.requiresUnlock = Boolean(record.hasPin);
        err.profileError = true;
        throw err;
      }

      const decryptedKey = decryptApiKey(
        record.encryptedKey,
        record.id,
        record.ownerProofHash,
        encryptionKey
      );
      const voiceMeta = getVoiceMetadata(record.voiceGender);
      return {
        apiKey: decryptedKey,
        profileId: record.id,
        profileName: record.name,
        voiceGender: voiceMeta.voiceGender,
        voiceName: voiceMeta.voiceName,
        voiceLabel: voiceMeta.voiceLabel,
        isCustomProfile: true,
      };
    },
  };
}
