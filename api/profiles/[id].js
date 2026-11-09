import {
  createProfileStore,
  getOrCreateOwnerSession,
  getUnlockedProfileIds,
  setUnlockedProfileIdsCookie,
} from '../../profile-store.js';

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
  const unlockedProfileIds = getUnlockedProfileIds(req, store.sessionSecret);
  const profileId =
    req.query?.id ||
    req.body?.profileId ||
    req.body?.id ||
    '';

  if (req.method === 'POST' && req.body?.action === 'unlock') {
    const pin = req.body?.pin ?? req.query?.pin ?? '';
    try {
      const result = await store.unlockProfile({
        profileId: profileId || 'default',
        pin,
        ownerProofHash: session.ownerProofHash,
        unlockedProfileIds,
      });
      setUnlockedProfileIdsCookie(
        req,
        res,
        store.sessionSecret,
        result.unlockedProfileIds
      );
      return res.status(200).json(result);
    } catch (err) {
      const status = Number(err?.status) || 500;
      if (err?.body && typeof err.body === 'object') {
        return res.status(status).json(err.body);
      }
      return res.status(status).json({
        error: err?.message || 'Không thể mở khóa hồ sơ.',
      });
    }
  }

  if (req.method === 'DELETE' || (req.method === 'POST' && req.body?.action === 'delete')) {
    const pin = req.body?.pin ?? req.query?.pin ?? '';
    try {
      const result = await store.deleteProfile({
        profileId,
        pin,
        ownerProofHash: session.ownerProofHash,
        unlockedProfileIds,
      });
      setUnlockedProfileIdsCookie(
        req,
        res,
        store.sessionSecret,
        result.unlockedProfileIds
      );
      return res.status(200).json(result);
    } catch (err) {
      const status = Number(err?.status) || 500;
      if (err?.body && typeof err.body === 'object') {
        return res.status(status).json(err.body);
      }
      return res.status(status).json({
        error: err?.message || 'Không thể xóa hồ sơ.',
      });
    }
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}
