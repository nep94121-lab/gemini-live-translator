import { GoogleGenAI } from '@google/genai';
import { STRICT_TRANSLATOR_PROMPT } from '../filler-filter.js';

const DEFAULT_MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live';

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const apiKey = req.body?.apiKey || process.env.GEMINI_API_KEY || '';
  const model = req.body?.model || req.query?.model || DEFAULT_MODEL;

  if (!apiKey) {
    return res.status(400).json({ error: 'Thiếu GEMINI_API_KEY trên môi trường Server' });
  }

  try {
    const client = new GoogleGenAI({
      apiKey,
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
      systemInstruction: STRICT_TRANSLATOR_PROMPT,
    });
  } catch (err) {
    return res.status(502).json({
      error: err?.message || 'Không thể khởi tạo Ephemeral Token',
      fallbackBridge: true,
    });
  }
}
