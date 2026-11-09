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

test('2. System Prompt khóa chặt vai trò Phiên dịch viên Việt -> Anh (không trả lời câu hỏi)', () => {
  assert.match(STRICT_TRANSLATOR_PROMPT, /Vietnamese-to-English/i);
  assert.match(STRICT_TRANSLATOR_PROMPT, /NEVER answer questions/i);
  assert.match(STRICT_TRANSLATOR_PROMPT, /Bạn tên là gì\?/);
  assert.match(STRICT_TRANSLATOR_PROMPT, /What's your name\?/);
  assert.match(STRICT_TRANSLATOR_PROMPT, /ạ ừm/);
});

test('3. Server HTTP, Giao diện gọn 4 khối, Zero-Leak và Kết nối thực tế WebSocket /ws/live tới Gemini Live API (không lỗi 404)', async () => {
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
    assert.ok(html.includes('id="enTranscriptBox"'));
    assert.ok(html.includes('id="speedSlider"'));
    assert.ok(html.includes('id="latencyList"'));
    assert.ok(html.includes('id="profileBar"'));
    assert.ok(html.includes('id="btnAddProfile"'));
    assert.ok(html.includes('id="profileFormDrawer"'));
    assert.ok(html.includes('id="profileDeleteConfirm"'));

    const vnIdx = html.indexOf('id="vnTranscriptBox"');
    const enIdx = html.indexOf('id="enTranscriptBox"');
    const profileIdx = html.indexOf('id="profileBar"');
    const micIdx = html.indexOf('id="btnToggleMic"');
    const latencyIdx = html.indexOf('id="latencyList"');
    assert.ok(vnIdx < enIdx && enIdx < profileIdx && profileIdx < micIdx && micIdx < latencyIdx);

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

test('4. Quản lý Hồ sơ API đa phiên, mã hóa AES-256-GCM, phân quyền chủ sở hữu, giới hạn thử PIN và chống vượt quyền bằng profile ID', async () => {
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
    assert.equal(dataA1.profiles[0].name, 'Tôi');
    assert.equal(dataA1.profiles[0].locked, true);

    // Không thể xóa hồ sơ "Tôi" (default)
    const delDefaultRes = await fetch(`${baseUrl}/api/profiles/default`, {
      method: 'DELETE',
      headers: { Cookie: cookieA },
    });
    assert.equal(delDefaultRes.status, 403);

    // Phiên A tạo hồ sơ "Minh" có PIN "1234"
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

    // Phiên A (chủ sở hữu) gọi /api/ephemeral-token cho "Minh" -> Thành công với đúng key của Minh
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
