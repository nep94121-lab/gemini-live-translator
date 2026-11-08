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
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/api/config', (_req, res) => {
    res.json({
      hasConfiguredKey: Boolean(apiKey),
      maskedKey: maskKey(apiKey),
      defaultModel: DEFAULT_MODEL,
      supportedModels: SUPPORTED_MODELS,
      systemPromptPreview: STRICT_TRANSLATOR_PROMPT,
    });
  });

  app.post('/api/ephemeral-token', async (req, res) => {
    const activeKey = req.body?.apiKey || apiKey;
    const model = req.body?.model || DEFAULT_MODEL;
    if (!activeKey) {
      return res.status(400).json({ error: 'Thiếu GEMINI_API_KEY trong .env' });
    }
    try {
      const client = new GoogleGenAI({
        apiKey: activeKey,
        vertexai: false,
        httpOptions: { apiVersion: 'v1alpha' },
      });
      const token = await client.authTokens.create({
        config: {
          uses: 10,
        },
      });
      return res.json({
        token: token?.name || null,
        model,
        systemInstruction: STRICT_TRANSLATOR_PROMPT,
      });
    } catch (err) {
      return res.status(502).json({
        error: err?.message || 'Chuyển sang kết nối qua Backend Bridge.',
        fallbackBridge: true,
      });
    }
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws/live' });

  wss.on('connection', (ws) => {
    let geminiSession = null;
    let filterFillersEnabled = true;
    let pendingQueue = [];
    let isSessionReady = false;

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
        const activeKey = msg.apiKey || apiKey;
        const model = msg.model || DEFAULT_MODEL;
        filterFillersEnabled = msg.filterFillers !== false;
        isSessionReady = false;
        pendingQueue = [];

        if (!activeKey) {
          sendToClient({
            type: 'error',
            message: 'Thiếu GEMINI_API_KEY trong .env',
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
            apiKey: activeKey,
            vertexai: false,
            httpOptions: { apiVersion: 'v1beta' },
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
                  });
                }

                const content = response?.serverContent;
                if (!content) return;

                if (content.modelTurn?.parts) {
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
                  sendToClient({
                    type: 'turn_complete',
                    serverTimestamp: Date.now(),
                  });
                }
              },
              onerror: (err) => {
                sendToClient({
                  type: 'error',
                  message: err?.message || 'Lỗi kết nối Gemini Live API',
                });
              },
              onclose: (evt) => {
                isSessionReady = false;
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
            });
          }

          for (const item of pendingQueue) {
            geminiSession.sendRealtimeInput(item);
          }
          pendingQueue = [];
        } catch (err) {
          sendToClient({
            type: 'error',
            message: `Lỗi kết nối: ${err?.message || err}`,
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
        if (geminiSession && isSessionReady) {
          geminiSession.sendRealtimeInput(payload);
        } else {
          pendingQueue.push(payload);
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
          if (geminiSession && isSessionReady) {
            geminiSession.sendRealtimeInput({
              audioStreamEnd: true,
            });
          }
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
          if (geminiSession) {
            geminiSession.close();
            geminiSession = null;
          }
          isSessionReady = false;
          pendingQueue = [];
        }
      } catch (err) {
        sendToClient({
          type: 'error',
          message: err?.message || 'Lỗi gửi dữ liệu tới Gemini Live API',
        });
      }
    });

    ws.on('close', () => {
      if (geminiSession) {
        try {
          geminiSession.close();
        } catch {}
        geminiSession = null;
      }
      isSessionReady = false;
      pendingQueue = [];
    });
  });

  return { app, server, wss };
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const port = Number(process.env.PORT || 3030);
  const { server } = createTranslatorServer();
  server.listen(port, () => {
    console.log(`Gemini Live Translator running at http://localhost:${port}`);
  });
}
