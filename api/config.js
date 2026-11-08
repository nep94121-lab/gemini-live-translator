import { STRICT_TRANSLATOR_PROMPT } from '../filler-filter.js';

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

export default function handler(_req, res) {
  const apiKey = process.env.GEMINI_API_KEY || '';
  res.status(200).json({
    hasConfiguredKey: Boolean(apiKey),
    maskedKey: maskKey(apiKey),
    defaultModel: DEFAULT_MODEL,
    supportedModels: SUPPORTED_MODELS,
    systemPromptPreview: STRICT_TRANSLATOR_PROMPT,
  });
}
