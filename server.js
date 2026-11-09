import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';
import {
  STRICT_TRANSLATOR_PROMPT,
  cleanVietnameseFillers,
} from './filler-filter.js';
import {
  createProfileStore,
  getExistingOwnerSession,
  getOrCreateOwnerSession,
  sanitizeSecretFromText,
} from './profile-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const DEFAULT_MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live';
const SUPPORTED_MODELS = [
  'gemini-3.8-live',
  'gemini-3.8-live-extended-thinking',
  'gemini-3.5-live-translate-preview',
];

function maskKey(key) {
  if (!key || key.length < 10) return 'Chưa cấu hình';
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

export function createTranslatorServer(options = {}) {
  const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY ?? '';
  const profileStore =
    options.profileStore || createProfileStore(options.profileStoreOptions || {});
  const createEphemeralTokenFn =
    options.createEphemeralTokenFn ||
    (async ({ activeKey }) => {
      const client = new GoogleGenAI({
        apiKey: activeKey,
        vertexai: false,
        httpOptions: { apiVersion: 'v1alpha' },
      });
      const token = await client.authTokens.create({
        config: {
          uses: 50,
        },
      });
      return token?.name || null;
    });

  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  app.get('/api/config', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    getOrCreateOwnerSession(req, res, profileStore.sessionSecret);
    res.json({
      hasConfiguredKey: Boolean(apiKey),
      maskedKey: maskKey(apiKey),
      defaultModel: DEFAULT_MODEL,
      supportedModels: SUPPORTED_MODELS,
      systemPromptPreview: STRICT_TRANSLATOR_PROMPT,
    });
  });

  app.get('/api/profiles', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const session = getOrCreateOwnerSession(req, res, profileStore.sessionSecret);
    try {
      const profiles = await profileStore.listProfiles(session.ownerProofHash);
      return res.status(200).json({ profiles });
    } catch (err) {
      return res.status(Number(err?.status) || 500).json({
        error: err?.message || 'Không thể tải danh sách hồ sơ.',
      });
    }
  });

  app.post('/api/profiles', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const session = getOrCreateOwnerSession(req, res, profileStore.sessionSecret);
    try {
      if (req.body?.action === 'delete') {
        const deleted = await profileStore.deleteProfile({
          profileId: req.body?.profileId || req.body?.id,
          pin: req.body?.pin,
          ownerProofHash: session.ownerProofHash,
        });
        return res.status(200).json(deleted);
      }

      const created = await profileStore.createProfile({
        name: req.body?.name,
        apiKey: req.body?.apiKey,
        pin: req.body?.pin,
        voiceGender: req.body?.voiceGender,
        ownerProofHash: session.ownerProofHash,
      });
      return res.status(201).json(created);
    } catch (err) {
      const status = Number(err?.status) || 500;
      if (err?.body && typeof err.body === 'object') {
        return res.status(status).json(err.body);
      }
      return res.status(status).json({
        error: sanitizeSecretFromText(
          err?.message || 'Không thể lưu hồ sơ.',
          req.body?.apiKey
        ),
      });
    }
  });

  const handleDeleteProfile = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const session = getOrCreateOwnerSession(req, res, profileStore.sessionSecret);
    const profileId =
      req.params?.id ||
      req.body?.profileId ||
      req.body?.id ||
      req.query?.profileId ||
      req.query?.id ||
      '';
    const pin = req.body?.pin ?? req.query?.pin ?? '';
    try {
      const result = await profileStore.deleteProfile({
        profileId,
        pin,
        ownerProofHash: session.ownerProofHash,
      });
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
  };

  app.delete('/api/profiles', handleDeleteProfile);
  app.delete('/api/profiles/:id', handleDeleteProfile);

  app.post('/api/ephemeral-token', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const session = getOrCreateOwnerSession(req, res, profileStore.sessionSecret);
    const profileId = req.body?.profileId || 'default';
    const model = req.body?.model || DEFAULT_MODEL;

    let resolved;
    try {
      resolved = await profileStore.resolveProfileApiKey({
        profileId,
        ownerProofHash: session.ownerProofHash,
        defaultServerApiKey: apiKey,
      });
    } catch (err) {
      const status = Number(err?.status) || 400;
      return res.status(status).json({
        error: err?.message || 'Không thể dùng hồ sơ đã chọn.',
        profileId,
        profileError: true,
      });
    }

    try {
      const tokenName = await createEphemeralTokenFn({
        activeKey: resolved.apiKey,
        model,
        profileId: resolved.profileId,
        voiceGender: resolved.voiceGender,
        voiceName: resolved.voiceName,
      });
      return res.json({
        token: tokenName,
        model,
        profileId: resolved.profileId,
        profileName: resolved.profileName,
        voiceGender: resolved.voiceGender,
        voiceName: resolved.voiceName,
        voiceLabel: resolved.voiceLabel,
        systemInstruction: STRICT_TRANSLATOR_PROMPT,
      });
    } catch (err) {
      const cleanMsg = sanitizeSecretFromText(
        err?.message || 'Chuyển sang kết nối qua Backend Bridge.',
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
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({
    server,
    path: '/ws/live',
    maxPayload: 5 * 1024 * 1024,
  });

  wss.on('connection', (ws, req) => {
    let geminiSession = null;
    let filterFillersEnabled = true;
    let pendingQueue = [];
    let rollingQueue = [];
    let isSessionReady = false;
    let isGeneratingTurn = false;
    let generationGuardTimer = null;
    const wsOwnerSession = getExistingOwnerSession(req, profileStore.sessionSecret);

    const clearGenerationGuard = () => {
      if (generationGuardTimer) {
        clearTimeout(generationGuardTimer);
        generationGuardTimer = null;
      }
    };

    const markGenerating = () => {
      isGeneratingTurn = true;
      clearGenerationGuard();
      generationGuardTimer = setTimeout(() => {
        isGeneratingTurn = false;
        flushRollingQueue();
      }, 6500);
    };

    const flushRollingQueue = () => {
      if (!geminiSession || !isSessionReady || isGeneratingTurn) return;
      while (rollingQueue.length > 0 && !isGeneratingTurn) {
        const nextPayload = rollingQueue.shift();
        geminiSession.sendRealtimeInput(nextPayload);
        if (nextPayload.text || nextPayload.audioStreamEnd) {
          markGenerating();
        }
      }
    };

    const sendToClient = (payload) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(payload));
      }
    };

    ws.on('message', async (rawData) => {
      let msg;
      try {
        msg = JSON.parse(rawData.toString());
      } catch {
        return;
      }

      if (msg.type === 'start') {
        const profileId = msg.profileId || 'default';
        const model = msg.model || DEFAULT_MODEL;
        filterFillersEnabled = msg.filterFillers !== false;
        isSessionReady = false;
        isGeneratingTurn = false;
        clearGenerationGuard();
        pendingQueue = [];
        rollingQueue = [];

        let resolved;
        try {
          resolved = await profileStore.resolveProfileApiKey({
            profileId,
            ownerProofHash: wsOwnerSession?.ownerProofHash || '',
            defaultServerApiKey: apiKey,
          });
        } catch (err) {
          sendToClient({
            type: 'error',
            message: err?.message || 'Không thể dùng hồ sơ API đã chọn.',
          });
          return;
        }

        try {
          if (geminiSession) {
            try {
              geminiSession.close();
            } catch {}
            geminiSession = null;
          }

          // Bắt buộc chỉ định apiVersion: 'v1beta' để tránh lỗi 404 trên Live WebSocket endpoint
          const ai = new GoogleGenAI({
            apiKey: resolved.apiKey,
            vertexai: false,
            httpOptions: { apiVersion: 'v1beta' },
          });

          const lockedVoiceName = resolved.voiceName || 'Puck';
          const speechConfig = {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: lockedVoiceName,
              },
            },
          };
          const realtimeInputConfig = {
            activityHandling: 'NO_INTERRUPTION',
            automaticActivityDetection: {
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
                  parts: [{ text: STRICT_TRANSLATOR_PROMPT }],
                },
                inputAudioTranscription: {},
                outputAudioTranscription: {},
                contextWindowCompression: {
                  slidingWindow: {},
                },
                sessionResumption: {},
              };

          geminiSession = await ai.live.connect({
            model,
            config: liveConfig,
            callbacks: {
              onopen: () => {},
              onmessage: (response) => {
                if (response?.setupComplete && !isSessionReady) {
                  isSessionReady = true;
                  sendToClient({
                    type: 'status',
                    status: 'connected',
                    model,
                    profileId: resolved.profileId,
                    profileName: resolved.profileName,
                    voiceGender: resolved.voiceGender,
                    voiceName: lockedVoiceName,
                  });
                }

                const content = response?.serverContent;
                if (!content) return;

                if (content.modelTurn?.parts) {
                  if (!isGeneratingTurn) markGenerating();
                  for (const part of content.modelTurn.parts) {
                    if (part.inlineData?.data) {
                      sendToClient({
                        type: 'audio',
                        data: part.inlineData.data,
                        mimeType:
                          part.inlineData.mimeType || 'audio/pcm;rate=24000',
                        serverTimestamp: Date.now(),
                      });
                    }
                    if (part.text) {
                      sendToClient({
                        type: 'output_text',
                        text: part.text,
                        serverTimestamp: Date.now(),
                      });
                    }
                  }
                }

                if (content.inputTranscription?.text) {
                  const rawVn = content.inputTranscription.text;
                  const cleanedVn = cleanVietnameseFillers(
                    rawVn,
                    filterFillersEnabled
                  );
                  sendToClient({
                    type: 'input_transcription',
                    rawText: rawVn,
                    text: cleanedVn,
                    filteredOut:
                      rawVn.trim().length > 0 && cleanedVn.length === 0,
                    serverTimestamp: Date.now(),
                  });
                }

                if (content.outputTranscription?.text) {
                  if (!isGeneratingTurn) markGenerating();
                  sendToClient({
                    type: 'output_transcription',
                    text: content.outputTranscription.text,
                    serverTimestamp: Date.now(),
                  });
                }

                if (content.interrupted === true) {
                  sendToClient({
                    type: 'interrupted',
                    serverTimestamp: Date.now(),
                  });
                }

                if (content.turnComplete === true) {
                  isGeneratingTurn = false;
                  clearGenerationGuard();
                  sendToClient({
                    type: 'turn_complete',
                    serverTimestamp: Date.now(),
                  });
                  flushRollingQueue();
                }
              },
              onerror: (err) => {
                isGeneratingTurn = false;
                clearGenerationGuard();
                sendToClient({
                  type: 'error',
                  message: sanitizeSecretFromText(
                    err?.message || 'Lỗi kết nối Gemini Live API',
                    resolved.apiKey
                  ),
                });
              },
              onclose: (evt) => {
                isSessionReady = false;
                isGeneratingTurn = false;
                clearGenerationGuard();
                sendToClient({
                  type: 'status',
                  status: 'closed',
                  reason: evt?.reason || '',
                });
              },
            },
          });

          if (!isSessionReady) {
            isSessionReady = true;
            sendToClient({
              type: 'status',
              status: 'connected',
              model,
              profileId: resolved.profileId,
              profileName: resolved.profileName,
              voiceGender: resolved.voiceGender,
              voiceName: lockedVoiceName,
            });
          }

          for (const item of pendingQueue) {
            rollingQueue.push(item);
          }
          pendingQueue = [];
          flushRollingQueue();
        } catch (err) {
          const cleanErr = sanitizeSecretFromText(
            String(err?.message || err),
            resolved.apiKey
          );
          sendToClient({
            type: 'error',
            message: resolved.isCustomProfile
              ? `Khóa API của hồ sơ "${resolved.profileName}" không hợp lệ hoặc đã hết hạn mức: ${cleanErr}`
              : `Lỗi kết nối: ${cleanErr}`,
          });
        }
        return;
      }

      if (msg.type === 'update_settings') {
        if (typeof msg.filterFillers === 'boolean') {
          filterFillersEnabled = msg.filterFillers;
        }
        return;
      }

      const sendOrQueue = (payload) => {
        if (!geminiSession || !isSessionReady) {
          pendingQueue.push(payload);
          return;
        }
        if (isGeneratingTurn) {
          rollingQueue.push(payload);
          return;
        }
        geminiSession.sendRealtimeInput(payload);
        if (payload.text || payload.audioStreamEnd) {
          markGenerating();
        }
      };

      try {
        if (msg.type === 'audio' && msg.data) {
          sendOrQueue({
            audio: {
              data: msg.data,
              mimeType: 'audio/pcm;rate=16000',
            },
          });
        } else if (msg.type === 'audio_stream_end') {
          sendOrQueue({
            audioStreamEnd: true,
          });
        } else if (msg.type === 'text' && msg.text) {
          const cleaned = cleanVietnameseFillers(msg.text, filterFillersEnabled);
          if (!cleaned) {
            sendToClient({
              type: 'input_transcription',
              rawText: msg.text,
              text: '',
              filteredOut: true,
              serverTimestamp: Date.now(),
            });
            return;
          }
          sendToClient({
            type: 'input_transcription',
            rawText: msg.text,
            text: cleaned,
            filteredOut: false,
            serverTimestamp: Date.now(),
          });
          sendOrQueue({ text: cleaned });
        } else if (msg.type === 'stop') {
          clearGenerationGuard();
          isGeneratingTurn = false;
          if (geminiSession) {
            geminiSession.close();
            geminiSession = null;
          }
          isSessionReady = false;
          pendingQueue = [];
          rollingQueue = [];
        }
      } catch (err) {
        sendToClient({
          type: 'error',
          message: err?.message || 'Lỗi gửi dữ liệu tới Gemini Live API',
        });
      }
    });

    ws.on('close', () => {
      clearGenerationGuard();
      isGeneratingTurn = false;
      if (geminiSession) {
        try {
          geminiSession.close();
        } catch {}
        geminiSession = null;
      }
      isSessionReady = false;
      pendingQueue = [];
      rollingQueue = [];
    });
  });

  return { app, server, wss, profileStore };
}

const defaultInstance = createTranslatorServer();
export default defaultInstance.app;

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const port = Number(process.env.PORT || 3030);
  defaultInstance.server.listen(port, () => {
    console.log(`Gemini Live Translator running at http://localhost:${port}`);
  });
}
