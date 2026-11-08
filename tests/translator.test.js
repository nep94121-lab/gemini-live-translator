import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  const { server } = createTranslatorServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const cfgRes = await fetch(`${baseUrl}/api/config`);
    assert.equal(cfgRes.status, 200);
    const cfg = await cfgRes.json();
    assert.equal(cfg.hasConfiguredKey, true);
    assert.ok(!JSON.stringify(cfg).includes('Ab8RN6LQLOKk8LDnTiYDIOAG24ukTtm0yIZVlesTZOpw'));

    const htmlRes = await fetch(`${baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();

    assert.ok(html.includes('id="btnToggleMic"'));
    assert.ok(html.includes('id="vnTranscriptBox"'));
    assert.ok(html.includes('id="enTranscriptBox"'));
    assert.ok(html.includes('id="speedSlider"'));
    assert.ok(html.includes('id="latencyList"'));

    const vnIdx = html.indexOf('id="vnTranscriptBox"');
    const enIdx = html.indexOf('id="enTranscriptBox"');
    const latencyIdx = html.indexOf('id="latencyList"');
    assert.ok(vnIdx < enIdx && enIdx < latencyIdx);

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
        ws.send(JSON.stringify({ type: 'start', model: 'gemini-3.8-live', filterFillers: true }));
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
        } else if (msg.type === 'output_transcription' || msg.type === 'output_text') {
          englishOut += msg.text;
        } else if (msg.type === 'audio') {
          audioChunks += 1;
        } else if (msg.type === 'turn_complete') {
          clearTimeout(timer);
          ws.close();
          try {
            assert.equal(vnOut, 'Bạn tên là gì?');
            assert.match(englishOut.toLowerCase(), /what.*name/);
            assert.ok(audioChunks > 0, 'Phải nhận được luồng âm thanh PCM 24kHz');
            resolve();
          } catch (err) {
            reject(err);
          }
        }
      });
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const filesToCheck = [
    'package.json',
    'filler-filter.js',
    'server.js',
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
