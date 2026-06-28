/**
 * api/analyze.js
 * ─────────────────────────────────────────────────────────
 * Secure backend proxy for the Anthropic API.
 * - Keeps ANTHROPIC_API_KEY out of the browser
 * - Only accepts requests from your own domain
 * - Handles large PDF uploads (up to 10MB via vercel.json)
 *
 * SETUP:
 *   1. Add ANTHROPIC_API_KEY to Vercel → Settings → Environment Variables
 *   2. Replace the allowed origins below with your real URLs
 * ─────────────────────────────────────────────────────────
 */

const ALLOWED_ORIGINS = [
  'https://resumeiq-gules-nine.vercel.app',   // ← replace with your Vercel URL
  'https://resumestrength.com', 
  'https://www.resumestrength.com',    // ← replace with your custom domain
  'http://127.0.0.1:5500',             // local dev (Live Server)
  'http://localhost:5500',             // local dev (Live Server)
];

export default async function handler(req, res) {
  const origin = req.headers.origin || '';

  // Block requests not coming from your own site
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return res.status(403).json({ error: { message: 'Unauthorized origin.' } });
  }

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: { message: 'Method not allowed.' } });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: { message: 'Server configuration error: API key not set.' } });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();
    return res.status(response.status).json(data);

  } catch (err) {
    return res.status(500).json({ error: { message: 'Server error: ' + err.message } });
  }
}
