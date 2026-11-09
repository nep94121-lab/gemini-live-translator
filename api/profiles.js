import {
  createProfileStore,
  getOrCreateOwnerSession,
  sanitizeSecretFromText,
} from '../profile-store.js';

let cachedStore = null;
function getStore() {
  if (!cachedStore) {
    cachedStore = createProfileStore();
  }
  return cachedStore;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  let store;
  try {
    store = getStore();
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'Lỗi cấu hình kho hồ sơ' });
  }

  const session = getOrCreateOwnerSession(req, res, store.sessionSecret);

  try {
    if (req.method === 'GET') {
      const profiles = await store.listProfiles(session.ownerProofHash);
      return res.status(200).json({ profiles });
    }

    if (req.method === 'POST') {
      const action = req.body?.action;
      if (action === 'delete') {
        const result = await store.deleteProfile({
          profileId: req.body?.profileId || req.body?.id,
          pin: req.body?.pin,
          ownerProofHash: session.ownerProofHash,
        });
        return res.status(200).json(result);
      }

      const result = await store.createProfile({
        name: req.body?.name,
        apiKey: req.body?.apiKey,
        pin: req.body?.pin,
        voiceGender: req.body?.voiceGender,
        ownerProofHash: session.ownerProofHash,
      });
      return res.status(201).json(result);
    }

    if (req.method === 'DELETE') {
      const profileId =
        req.body?.profileId ||
        req.body?.id ||
        req.query?.profileId ||
        req.query?.id ||
        '';
      const pin = req.body?.pin ?? req.query?.pin ?? '';
      const result = await store.deleteProfile({
        profileId,
        pin,
        ownerProofHash: session.ownerProofHash,
      });
      return res.status(200).json(result);
    }

    return res.status(405).json({ error: 'Method Not Allowed' });
  } catch (err) {
    const status = Number(err?.status) || 500;
    if (err?.body && typeof err.body === 'object') {
      return res.status(status).json(err.body);
    }
    return res.status(status).json({
      error: sanitizeSecretFromText(
        err?.message || 'Không thể xử lý yêu cầu hồ sơ.',
        req.body?.apiKey
      ),
    });
  }
}
