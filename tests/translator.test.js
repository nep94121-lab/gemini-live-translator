import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import {
  cleanVietnameseFillers,
  isOnlyFillerOrNoise,
  STRICT_TRANSLATOR_PROMPT,
} from '../filler-filter.js';
import { createTranslatorServer } from '../server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

function extractCookieHeader(res) {
  const setCookies =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean);
  return setCookies.map((c) => c.split(';')[0]).join('; ');
}

test('1. Bộ lọc từ ngập ngừng tiếng Việt ("à, ừ, ạ ừm") hoạt động chính xác với input ngẫu nhiên', () => {
  assert.equal(cleanVietnameseFillers('ạ ừm'), '');
  assert.equal(cleanVietnameseFillers('à... ừm... ờ...'), '');
  assert.equal(cleanVietnameseFillers('   à ừ   '), '');
  assert.equal(isOnlyFillerOrNoise('ạ ừm... à'), true);

  assert.equal(
    cleanVietnameseFillers('À ừm, bạn tên là gì?'),
    'Bạn tên là gì?'
  );

  const nonce = crypto.randomBytes(4).toString('hex');
  const cleanedWithNonce = cleanVietnameseFillers(
    `ạ ừm, à mã kiểm thử ${nonce} ừm đang chạy tốt`
  );
  assert.equal(cleanedWithNonce, `Mã kiểm thử ${nonce} đang chạy tốt`);
});

test('2. System Prompt khóa chặt vai trò Phiên dịch viên Việt -> Anh và giữ cố định giọng đọc', () => {
  assert.match(STRICT_TRANSLATOR_PROMPT, /Vietnamese-to-English/i);
  assert.match(STRICT_TRANSLATOR_PROMPT, /NEVER answer questions/i);
  assert.match(STRICT_TRANSLATOR_PROMPT, /Bạn tên là gì\?/);
  assert.match(STRICT_TRANSLATOR_PROMPT, /What's your name\?/);
  assert.match(STRICT_TRANSLATOR_PROMPT, /ạ ừm/);
  assert.match(STRICT_TRANSLATOR_PROMPT, /VOICE CONSISTENCY/i);
});

test('3. Server HTTP, Giao diện Swiss thống nhất, Zero-Leak và Kết nối thực tế WebSocket /ws/live tới Gemini Live API', async () => {
  const tmpStoreFile = path.join(
    os.tmpdir(),
    `glt-test-store-${crypto.randomBytes(6).toString('hex')}.json`
  );
  const { server } = createTranslatorServer({
    profileStoreOptions: {
      filePath: tmpStoreFile,
      encryptionKey: 'test-encryption-key-32bytes-long!!',
      sessionSecret: 'test-session-secret-32bytes-long!!',
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const cfgRes = await fetch(`${baseUrl}/api/config`);
    assert.equal(cfgRes.status, 200);
    const cfg = await cfgRes.json();
    assert.equal(cfg.hasConfiguredKey, true);
    assert.ok(
      !JSON.stringify(cfg).includes('Ab8RN6LQLOKk8LDnTiYDIOAG24ukTtm0yIZVlesTZOpw')
    );

    const htmlRes = await fetch(`${baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();

    assert.ok(html.includes('id="btnToggleMic"'));
    assert.ok(html.includes('id="vnTranscriptBox"'));
    assert.ok(html.includes('id="vnPendingBox"'));
    assert.ok(html.includes('id="vnLiveBufferBox"'));
    assert.ok(html.includes('id="enPlaybackBanner"'));
    assert.ok(html.includes('id="enTranscriptBox"'));
    assert.ok(html.includes('id="rollingStatus"'));
    assert.ok(html.includes('id="speedSlider"'));
    assert.ok(html.includes('id="latencyList"'));
    assert.ok(html.includes('id="profileBar"'));
    assert.ok(html.includes('id="profileSearchInput"'));
    assert.ok(html.includes('id="profileSortSelect"'));
    assert.ok(html.includes('id="btnAddProfile"'));
    assert.ok(html.includes('id="profileFormDrawer"'));
    assert.ok(html.includes('id="profileVoiceGenderGroup"'));
    assert.ok(html.includes('id="profileDeleteConfirm"'));
    assert.ok(html.includes('Tuấn Anh'));

    const vnIdx = html.indexOf('id="vnTranscriptBox"');
    const enIdx = html.indexOf('id="enTranscriptBox"');
    const profileIdx = html.indexOf('id="profileBar"');
    const micIdx = html.indexOf('id="btnToggleMic"');
    const latencyIdx = html.indexOf('id="latencyList"');
    assert.ok(
      vnIdx < enIdx &&
        enIdx < profileIdx &&
        profileIdx < micIdx &&
        micIdx < latencyIdx
    );

    // Kiểm thử kết nối thực tế /ws/live tới Gemini Live API
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/live`);
      let englishOut = '';
      let vnOut = '';
      let audioChunks = 0;

      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('Timeout waiting for Gemini Live translation response'));
      }, 15000);

      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            type: 'start',
            model: 'gemini-3.8-live',
            profileId: 'default',
            voiceGender: 'male',
            filterFillers: true,
          })
        );
      });

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'error') {
          clearTimeout(timer);
          ws.close();
          reject(new Error(`WebSocket returned error: ${msg.message}`));
        } else if (msg.type === 'status' && msg.status === 'connected') {
          assert.equal(msg.voiceName, 'Puck');
          ws.send(JSON.stringify({ type: 'text', text: 'À ừm, bạn tên là gì?' }));
        } else if (msg.type === 'input_transcription') {
          vnOut += msg.text;
        } else if (
          msg.type === 'output_transcription' ||
          msg.type === 'output_text'
        ) {
          englishOut += msg.text;
        } else if (msg.type === 'audio') {
          audioChunks += 1;
        } else if (msg.type === 'turn_complete') {
          clearTimeout(timer);
          ws.close();
          try {
            assert.equal(vnOut, 'Bạn tên là gì?');
            assert.match(englishOut.toLowerCase(), /what.*name/);
            assert.ok(
              audioChunks > 0,
              'Phải nhận được luồng âm thanh PCM 24kHz'
            );
            resolve();
          } catch (err) {
            reject(err);
          }
        }
      });
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpStoreFile, { force: true });
  }
});

test('4. Quản lý Hồ sơ API ("Tuấn Anh" mặc định, chọn giọng Nam/Nữ cố định), mã hóa AES-256-GCM, phân quyền chủ sở hữu và giới hạn thử PIN', async () => {
  const tmpStoreFile = path.join(
    os.tmpdir(),
    `glt-profile-sec-${crypto.randomBytes(6).toString('hex')}.json`
  );
  const usedKeys = [];
  const { server } = createTranslatorServer({
    apiKey: 'SERVER_DEFAULT_OWNER_KEY_123456',
    profileStoreOptions: {
      filePath: tmpStoreFile,
      encryptionKey: 'unit-test-encryption-secret-key-01',
      sessionSecret: 'unit-test-session-hmac-secret-key-01',
    },
    createEphemeralTokenFn: async ({ activeKey, profileId }) => {
      usedKeys.push({ activeKey, profileId });
      if (activeKey.includes('BROKEN_QUOTA_KEY')) {
        throw new Error(`Quota exceeded for key ${activeKey}`);
      }
      return `ephemeral_tok_for_${profileId}_${activeKey.slice(0, 8)}`;
    },
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Phiên trình duyệt A khởi tạo
    const listResA1 = await fetch(`${baseUrl}/api/profiles`);
    assert.equal(listResA1.status, 200);
    const cookieA = extractCookieHeader(listResA1);
    assert.match(cookieA, /glt_owner_session=/);
    const setCookieRaw = listResA1.headers.get('set-cookie') || '';
    assert.match(setCookieRaw, /HttpOnly/i);
    assert.match(setCookieRaw, /SameSite=Lax/i);

    const dataA1 = await listResA1.json();
    assert.equal(dataA1.profiles.length, 1);
    assert.equal(dataA1.profiles[0].id, 'default');
    assert.equal(dataA1.profiles[0].name, 'Tuấn Anh');
    assert.equal(dataA1.profiles[0].locked, true);
    assert.equal(dataA1.profiles[0].hasPin, true);
    assert.equal(dataA1.profiles[0].isUnlocked, false);
    assert.equal(dataA1.profiles[0].voiceGender, 'male');
    assert.equal(dataA1.profiles[0].voiceName, 'Puck');
    assert.equal(dataA1.profiles[0].voiceLabel, 'Nam');

    // Khi thiết bị chưa mở khóa PIN "Tuấn Anh", gọi /api/ephemeral-token từ web bị chặn 403 yêu cầu PIN
    const lockedDefaultTokRes = await fetch(`${baseUrl}/api/ephemeral-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GLT-Client': 'web',
        Cookie: cookieA,
      },
      body: JSON.stringify({
        model: 'gemini-3.8-live',
        profileId: 'default',
      }),
    });
    assert.equal(lockedDefaultTokRes.status, 403);
    const lockedDefaultTokBody = await lockedDefaultTokRes.json();
    assert.equal(lockedDefaultTokBody.requiresUnlock, true);

    // Mở khóa "Tuấn Anh" với PIN sai -> bị chặn 403
    const unlockWrongRes = await fetch(`${baseUrl}/api/profiles`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieA,
      },
      body: JSON.stringify({
        action: 'unlock',
        profileId: 'default',
        pin: '000000',
      }),
    });
    assert.equal(unlockWrongRes.status, 403);

    // Mở khóa "Tuấn Anh" với PIN đúng "512005" -> thành công và lưu cookie trên thiết bị
    const unlockRightRes = await fetch(`${baseUrl}/api/profiles`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieA,
      },
      body: JSON.stringify({
        action: 'unlock',
        profileId: 'default',
        pin: '512005',
      }),
    });
    assert.equal(unlockRightRes.status, 200);
    const unlockCookie = extractCookieHeader(unlockRightRes);
    assert.match(unlockCookie, /glt_unlocked_profiles=/);
    const combinedCookieA = `${cookieA}; ${unlockCookie}`;
    const unlockRightBody = await unlockRightRes.json();
    assert.equal(unlockRightBody.unlocked, true);
    assert.equal(unlockRightBody.profiles[0].isUnlocked, true);

    // Sau khi đã lưu mở khóa trên thiết bị, gọi /api/ephemeral-token cho "Tuấn Anh" thành công ngay
    const unlockedDefaultTokRes = await fetch(`${baseUrl}/api/ephemeral-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GLT-Client': 'web',
        Cookie: combinedCookieA,
      },
      body: JSON.stringify({
        model: 'gemini-3.8-live',
        profileId: 'default',
      }),
    });
    assert.equal(unlockedDefaultTokRes.status, 200);

    // Không thể xóa hồ sơ "Tuấn Anh" (default)
    const delDefaultRes = await fetch(`${baseUrl}/api/profiles/default`, {
      method: 'DELETE',
      headers: { Cookie: cookieA },
    });
    assert.equal(delDefaultRes.status, 403);

    // Không thể đặt tên trùng "Tuấn Anh" hoặc "Tôi"
    const reservedRes = await fetch(`${baseUrl}/api/profiles`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieA,
      },
      body: JSON.stringify({
        name: 'Tuấn Anh',
        apiKey: 'AIzaSyReservedTestKey123456789',
      }),
    });
    assert.equal(reservedRes.status, 400);

    // Phiên A tạo hồ sơ "Minh" giọng Nữ ("female" -> "Kore") có PIN "1234"
    const secretKeyMinh = 'AIzaSyTestSecretKeyForMinh987654321';
    const createMinhRes = await fetch(`${baseUrl}/api/profiles`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieA,
      },
      body: JSON.stringify({
        name: 'Minh',
        apiKey: secretKeyMinh,
        pin: '1234',
        voiceGender: 'female',
      }),
    });
    assert.equal(createMinhRes.status, 201);
    const createdMinhData = await createMinhRes.json();
    const minhProfile = createdMinhData.profile;
    assert.ok(minhProfile.id.startsWith('prof_'));
    assert.equal(minhProfile.name, 'Minh');
    assert.equal(minhProfile.isOwner, true);
    assert.equal(minhProfile.selectable, true);
    assert.equal(minhProfile.hasPin, true);
    assert.equal(minhProfile.voiceGender, 'female');
    assert.equal(minhProfile.voiceName, 'Kore');
    assert.equal(minhProfile.voiceLabel, 'Nữ');

    // Đảm bảo response và file lưu trữ bền vững KHÔNG chứa raw API key hoặc PIN
    const responseText = JSON.stringify(createdMinhData);
    assert.ok(!responseText.includes(secretKeyMinh));
    assert.ok(!responseText.includes('1234'));
    assert.ok(!responseText.includes('ownerProofHash'));
    const rawDiskContent = fs.readFileSync(tmpStoreFile, 'utf8');
    assert.ok(!rawDiskContent.includes(secretKeyMinh));
    assert.ok(!rawDiskContent.includes('"1234"'));

    // Phiên trình duyệt B độc lập xem danh sách hồ sơ
    const listResB = await fetch(`${baseUrl}/api/profiles`);
    const cookieB = extractCookieHeader(listResB);
    assert.notEqual(cookieA, cookieB);
    const listDataB = await listResB.json();
    const minhInB = listDataB.profiles.find((p) => p.id === minhProfile.id);
    assert.ok(minhInB);
    assert.equal(minhInB.isOwner, false);
    assert.equal(minhInB.selectable, false);
    assert.equal(minhInB.ownerNote, 'Chỉ chủ hồ sơ');
    assert.equal(minhInB.voiceGender, 'female');
    assert.equal(minhInB.voiceLabel, 'Nữ');

    // Phiên B cố tình gọi thẳng /api/ephemeral-token với profileId của Minh -> Bị chặn 403
    const stealTokRes = await fetch(`${baseUrl}/api/ephemeral-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieB,
      },
      body: JSON.stringify({
        model: 'gemini-3.8-live',
        profileId: minhProfile.id,
      }),
    });
    assert.equal(stealTokRes.status, 403);
    const stealTokBody = await stealTokRes.json();
    assert.match(stealTokBody.error, /chủ hồ sơ/i);

    // Phiên B cố tình gọi thẳng DELETE /api/profiles/:id kể cả khi biết đúng PIN "1234" -> Bị chặn 403
    const stealDelRes = await fetch(
      `${baseUrl}/api/profiles/${minhProfile.id}`,
      {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieB,
        },
        body: JSON.stringify({ pin: '1234' }),
      }
    );
    assert.equal(stealDelRes.status, 403);

    // Phiên A (chủ sở hữu) gọi /api/ephemeral-token cho "Minh" -> Thành công với đúng key của Minh và giọng Kore (Nữ)
    const ownerTokRes = await fetch(`${baseUrl}/api/ephemeral-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieA,
      },
      body: JSON.stringify({
        model: 'gemini-3.8-live',
        profileId: minhProfile.id,
      }),
    });
    assert.equal(ownerTokRes.status, 200);
    const ownerTokData = await ownerTokRes.json();
    assert.equal(ownerTokData.profileId, minhProfile.id);
    assert.equal(ownerTokData.voiceGender, 'female');
    assert.equal(ownerTokData.voiceName, 'Kore');
    assert.equal(ownerTokData.voiceLabel, 'Nữ');
    assert.equal(usedKeys.at(-1).activeKey, secretKeyMinh);

    // Phiên A tạo hồ sơ có key lỗi -> Khi lấy token phải báo lỗi của hồ sơ đó, KHÔNG tự chuyển sang key chủ web và KHÔNG lộ key trong lỗi
    const brokenKey = 'AIzaSyBROKEN_QUOTA_KEY_999999999';
    const createBrokenRes = await fetch(`${baseUrl}/api/profiles`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieA,
      },
      body: JSON.stringify({
        name: 'KeyLỗi',
        apiKey: brokenKey,
      }),
    });
    assert.equal(createBrokenRes.status, 201);
    const brokenProfile = (await createBrokenRes.json()).profile;

    const brokenTokRes = await fetch(`${baseUrl}/api/ephemeral-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieA,
      },
      body: JSON.stringify({
        model: 'gemini-3.8-live',
        profileId: brokenProfile.id,
      }),
    });
    assert.equal(brokenTokRes.status, 502);
    const brokenTokBody = await brokenTokRes.json();
    assert.match(brokenTokBody.error, /KeyLỗi/);
    assert.ok(!brokenTokBody.error.includes(brokenKey));

    // Xóa hồ sơ không có PIN (KeyLỗi) bởi chủ sở hữu -> Thành công ngay
    const delNoPinRes = await fetch(
      `${baseUrl}/api/profiles/${brokenProfile.id}`,
      {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieA,
        },
        body: JSON.stringify({}),
      }
    );
    assert.equal(delNoPinRes.status, 200);

    // Kiểm tra PIN sai và giới hạn 5 lần thử trên hồ sơ "Minh"
    const wrongPin1 = await fetch(`${baseUrl}/api/profiles/${minhProfile.id}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieA,
      },
      body: JSON.stringify({ pin: '0000' }),
    });
    assert.equal(wrongPin1.status, 403);
    const wrongPin1Body = await wrongPin1.json();
    assert.equal(wrongPin1Body.remainingAttempts, 4);

    // Xóa với PIN đúng "1234" trước khi bị khóa -> Thành công
    const rightPinRes = await fetch(
      `${baseUrl}/api/profiles/${minhProfile.id}`,
      {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieA,
        },
        body: JSON.stringify({ pin: '1234' }),
      }
    );
    assert.equal(rightPinRes.status, 200);

    // Tạo hồ sơ khác để test khóa cứng sau 5 lần nhập sai PIN
    const createLockTest = await fetch(`${baseUrl}/api/profiles`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieA,
      },
      body: JSON.stringify({
        name: 'LockTest',
        apiKey: 'AIzaSyLockTestKey1234567890',
        pin: '5678',
      }),
    });
    const lockProfile = (await createLockTest.json()).profile;

    for (let i = 1; i <= 5; i++) {
      const r = await fetch(`${baseUrl}/api/profiles/${lockProfile.id}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieA,
        },
        body: JSON.stringify({ pin: '9999' }),
      });
      assert.equal(r.status, i < 5 ? 403 : 429);
    }

    // Sau 5 lần sai, kể cả nhập đúng PIN "5678" cũng bị chặn 429 trong thời gian khóa
    const lockedTryRightPin = await fetch(
      `${baseUrl}/api/profiles/${lockProfile.id}`,
      {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieA,
        },
        body: JSON.stringify({ pin: '5678' }),
      }
    );
    assert.equal(lockedTryRightPin.status, 429);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpStoreFile, { force: true });
  }
});

test('5. Kiểm thử chịu tải 20 người dùng đồng thời (20 Concurrent Users) tạo hồ sơ, truy vấn danh sách và cấp Ephemeral Token không bị lag hay mất dữ liệu', async () => {
  const tmpStoreFile = path.join(
    os.tmpdir(),
    `glt-20users-${crypto.randomBytes(6).toString('hex')}.json`
  );
  const { server } = createTranslatorServer({
    apiKey: 'SERVER_DEFAULT_OWNER_KEY_20USERS',
    profileStoreOptions: {
      filePath: tmpStoreFile,
      encryptionKey: 'concurrent-20-encryption-secret!!',
      sessionSecret: 'concurrent-20-session-hmac-sec!!',
    },
    createEphemeralTokenFn: async ({ activeKey, profileId }) => {
      await new Promise((r) => setTimeout(r, 15));
      return `tok_${profileId}_${activeKey.slice(-6)}`;
    },
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const USER_COUNT = 20;
    const startMs = performance.now();

    // 1. 20 người dùng mở trang cùng lúc để nhận phiên riêng
    const initResponses = await Promise.all(
      Array.from({ length: USER_COUNT }, () => fetch(`${baseUrl}/api/profiles`))
    );
    const userSessions = initResponses.map((res, idx) => {
      assert.equal(res.status, 200);
      const cookie = extractCookieHeader(res);
      assert.ok(cookie.includes('glt_owner_session='));
      return {
        index: idx + 1,
        name: `Người dùng ${idx + 1}`,
        voiceGender: idx % 2 === 0 ? 'male' : 'female',
        apiKey: `AIzaSyConcurrentUserKey_${String(idx + 1).padStart(2, '0')}_987654`,
        pin: String(1000 + idx),
        cookie,
      };
    });

    // 2. 20 người dùng đồng thời bấm "Lưu & Dùng" cùng một thời điểm
    const createResults = await Promise.all(
      userSessions.map(async (u) => {
        const res = await fetch(`${baseUrl}/api/profiles`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: u.cookie,
          },
          body: JSON.stringify({
            name: u.name,
            apiKey: u.apiKey,
            pin: u.pin,
            voiceGender: u.voiceGender,
          }),
        });
        const body = await res.json();
        assert.equal(res.status, 201, `User ${u.index} create failed: ${JSON.stringify(body)}`);
        return { user: u, profile: body.profile };
      })
    );

    assert.equal(createResults.length, USER_COUNT);

    // 3. Kiểm tra không mất bất kỳ hồ sơ nào (1 mặc định "Tuấn Anh" + 20 hồ sơ mới = 21)
    const verifyListRes = await fetch(`${baseUrl}/api/profiles`, {
      headers: { Cookie: userSessions[0].cookie },
    });
    const verifyListData = await verifyListRes.json();
    assert.equal(verifyListData.profiles.length, USER_COUNT + 1);
    assert.equal(verifyListData.profiles[0].name, 'Tuấn Anh');

    // 4. 20 người dùng đồng thời lấy Ephemeral Token + tải danh sách hồ sơ cùng lúc (40 requests song song)
    const parallelOpsStart = performance.now();
    const tokenResults = await Promise.all(
      createResults.map(async ({ user, profile }) => {
        const [tokRes, listRes] = await Promise.all([
          fetch(`${baseUrl}/api/ephemeral-token`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Cookie: user.cookie,
            },
            body: JSON.stringify({
              model: 'gemini-3.8-live',
              profileId: profile.id,
            }),
          }),
          fetch(`${baseUrl}/api/profiles`, {
            headers: { Cookie: user.cookie },
          }),
        ]);
        assert.equal(tokRes.status, 200);
        assert.equal(listRes.status, 200);
        const tokData = await tokRes.json();
        assert.equal(tokData.profileId, profile.id);
        assert.equal(tokData.voiceGender, user.voiceGender);
        assert.equal(
          tokData.voiceName,
          user.voiceGender === 'female' ? 'Kore' : 'Puck'
        );
        assert.ok(tokData.token.endsWith(user.apiKey.slice(-6)));
        return tokData;
      })
    );
    const parallelOpsDurationMs = performance.now() - parallelOpsStart;
    assert.equal(tokenResults.length, USER_COUNT);
    assert.ok(
      parallelOpsDurationMs < 3000,
      `40 requests đồng thời từ 20 người dùng phải xử lý nhanh (<3000ms), thực tế: ${Math.round(parallelOpsDurationMs)}ms`
    );

    const totalElapsed = performance.now() - startMs;
    assert.ok(totalElapsed < 8000);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpStoreFile, { force: true });
  }

  const filesToCheck = [
    'package.json',
    'filler-filter.js',
    'profile-store.js',
    'server.js',
    'api/config.js',
    'api/ephemeral-token.js',
    'api/profiles.js',
    'api/profiles/[id].js',
    'public/index.html',
    'public/style.css',
    'public/app.js',
    'public/audio-worklet.js',
  ];
  for (const rel of filesToCheck) {
    const rawBytes = fs.readFileSync(path.join(ROOT_DIR, rel));
    assert.equal(
      rawBytes.includes(0x0d),
      false,
      `File ${rel} không được chứa ký tự CR (\\r)`
    );
  }
});

test('6. AudioWorklet PcmNoiseGateProcessor: Pre-roll 240ms, thu giọng nhỏ (RMS 0.0045), downsample 48kHz->16kHz, khử click <220ms (speech_cancel) và đuôi lặng 700ms', () => {
  const workletCode = fs.readFileSync(
    path.join(ROOT_DIR, 'public/audio-worklet.js'),
    'utf8'
  );

  function loadProcessorClass(mockSampleRate) {
    let RegisteredProcessor = null;
    const fn = new Function(
      'AudioWorkletProcessor',
      'registerProcessor',
      'sampleRate',
      workletCode
    );
    class MockAudioWorkletProcessor {
      constructor() {
        this.events = [];
        this.port = {
          onmessage: null,
          postMessage: (msg) => {
            this.events.push(msg);
          },
        };
      }
    }
    fn(
      MockAudioWorkletProcessor,
      (_name, cls) => {
        RegisteredProcessor = cls;
      },
      mockSampleRate
    );
    return RegisteredProcessor;
  }

  // 1. Kiểm thử ở 16kHz với giọng nói nhỏ thực tế (amplitude 0.005 < ngưỡng cũ 0.012)
  const Processor16k = loadProcessorClass(16000);
  const proc = new Processor16k();

  const makeBlock = (amp, len = 128) => {
    const arr = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      arr[i] = i % 2 === 0 ? amp : -amp;
    }
    return [[arr]];
  };

  // Đẩy 30 block im lặng (240ms) làm dữ liệu pre-roll
  for (let i = 0; i < 30; i++) {
    proc.process(makeBlock(0.0002));
  }
  assert.equal(proc.events.length, 0);

  // Đẩy 50 block giọng nói nhỏ (amp = 0.005, tương đương ~400ms > minVoiceMs 220ms)
  for (let i = 0; i < 50; i++) {
    proc.process(makeBlock(0.005));
  }
  assert.equal(proc.events[0]?.type, 'speech_start');
  const pcmEventsDuringSpeech = proc.events.filter(
    (e) => e.type === 'pcm_chunk'
  );
  assert.ok(
    pcmEventsDuringSpeech.length >= 2,
    'Phải xả Pre-roll 240ms + các chunk PCM đang nói'
  );

  // Đẩy 120 block im lặng (~960ms > silenceMsThreshold 850ms) để kích hoạt speech_end + đuôi lặng 700ms
  for (let i = 0; i < 120; i++) {
    proc.process(makeBlock(0.0001));
  }
  assert.equal(proc.events.at(-1)?.type, 'speech_end');
  const totalPcmBytes = proc.events
    .filter((e) => e.type === 'pcm_chunk')
    .reduce((sum, e) => sum + e.pcm16.byteLength, 0);
  assert.ok(
    totalPcmBytes >= (3840 + 6400 + 11200) * 2,
    'Tổng dữ liệu PCM phải bao gồm Pre-roll 240ms + giọng nói + đuôi lặng 700ms (11200 mẫu Int16)'
  );

  // 2. Kiểm thử tạp âm/click ngắn (< 220ms) phải phát speech_cancel thay vì speech_end
  proc.events.length = 0;
  for (let i = 0; i < 10; i++) {
    proc.process(makeBlock(0.008)); // ~80ms (< 220ms)
  }
  for (let i = 0; i < 120; i++) {
    proc.process(makeBlock(0.0001));
  }
  assert.ok(proc.events.some((e) => e.type === 'speech_cancel'));
  assert.equal(
    proc.events.some((e) => e.type === 'speech_end'),
    false,
    'Click ngắn dưới 220ms không được phát speech_end gây kẹt trạng thái'
  );

  // 3. Kiểm thử downsample tự động khi phần cứng chạy ở 48000 Hz
  const Processor48k = loadProcessorClass(48000);
  const proc48 = new Processor48k();
  for (let i = 0; i < 150; i++) {
    proc48.process(makeBlock(0.006, 128));
  }
  const chunks48 = proc48.events.filter((e) => e.type === 'pcm_chunk');
  assert.ok(chunks48.length >= 1, '48kHz phải downsample về 16kHz và phát pcm_chunk');
});

