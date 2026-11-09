import { GoogleGenAI } from '@google/genai';
import { STRICT_TRANSLATOR_PROMPT } from '../filler-filter.js';
import {
  createProfileStore,
  getOrCreateOwnerSession,
  sanitizeSecretFromText,
} from '../profile-store.js';

const DEFAULT_MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live';

let cachedStore = null;
function getStore() {
  if (!cachedStore) {
    cachedStore = createProfileStore();
  }
  return cachedStore;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  let store;
  try {
    store = getStore();
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'Lỗi cấu hình kho hồ sơ' });
  }

  const session = getOrCreateOwnerSession(req, res, store.sessionSecret);
  const profileId =
    req.body?.profileId || req.query?.profileId || 'default';
  const model = req.body?.model || req.query?.model || DEFAULT_MODEL;
  const defaultServerApiKey = process.env.GEMINI_API_KEY || '';

  let resolved;
  try {
    resolved = await store.resolveProfileApiKey({
      profileId,
      ownerProofHash: session.ownerProofHash,
      defaultServerApiKey,
    });
  } catch (err) {
    const status = Number(err?.status) || 400;
    return res.status(status).json({
      error: err?.message || 'Không thể sử dụng hồ sơ đã chọn.',
      profileId,
      profileError: true,
    });
  }

  try {
    const client = new GoogleGenAI({
      apiKey: resolved.apiKey,
      vertexai: false,
      httpOptions: { apiVersion: 'v1alpha' },
    });

    const token = await client.authTokens.create({
      config: {
        uses: 10,
      },
    });

    return res.status(200).json({
      token: token?.name || null,
      model,
      profileId: resolved.profileId,
      profileName: resolved.profileName,
      systemInstruction: STRICT_TRANSLATOR_PROMPT,
    });
  } catch (err) {
    const cleanMsg = sanitizeSecretFromText(
      err?.message || 'Không thể khởi tạo Ephemeral Token',
      resolved.apiKey
    );
    if (resolved.isCustomProfile) {
      return res.status(502).json({
        error: `Khóa API của hồ sơ "${resolved.profileName}" không hợp lệ hoặc đã hết hạn mức (${cleanMsg}).`,
        profileId: resolved.profileId,
        profileName: resolved.profileName,
        profileError: true,
      });
    }
    return res.status(502).json({
      error: cleanMsg,
      fallbackBridge: true,
    });
  }
}
