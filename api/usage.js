/**
 * api/usage.js
 * Uses REDIS_URL from Vercel Redis integration
 * Tracks usage per Gmail — blocks incognito bypass
 */

const { createClient } = require('redis');

const ALLOWED_ORIGINS = [
  'https://resumeiq-gules-nine.vercel.app',
  'https://resumestrength.com',
  'https://www.resumestrength.com',
  'http://127.0.0.1:5500',
  'http://localhost:5500',
];

let client = null;

async function getClient() {
  if (client && client.isOpen) return client;
  client = createClient({ url: process.env.REDIS_URL });
  client.on('error', err => console.error('Redis error:', err));
  await client.connect();
  return client;
}

function getTodayUTC() {
  return new Date().toISOString().split('T')[0];
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';

  if (!ALLOWED_ORIGINS.includes(origin)) {
    return res.status(403).json({ error: 'Unauthorized origin.' });
  }

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed.' });

  if (!process.env.REDIS_URL) {
    return res.status(200).json({ count: 0, plan: null, planExpiry: null });
  }

  const { email, action, plan } = req.body || {};

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required.' });
  }

  const safeEmail = email.toLowerCase().replace(/[^a-z0-9@._-]/g, '');
  const today     = getTodayUTC();
  const usageKey  = `usage:${safeEmail}:${today}`;
  const planKey   = `plan:${safeEmail}`;

  try {
    const redis = await getClient();

    if (action === 'get') {
      const [rawCount, rawPlan] = await Promise.all([
        redis.get(usageKey),
        redis.get(planKey),
      ]);

      const count = parseInt(rawCount || '0', 10);
      let activePlan = null;
      let planExpiry = null;

      if (rawPlan) {
        try {
          const parsed = JSON.parse(rawPlan);
          if (parsed.expiry && Date.now() < parsed.expiry) {
            activePlan = parsed.plan;
            planExpiry = parsed.expiry;
          }
        } catch { /* ignore */ }
      }

      return res.status(200).json({ count, plan: activePlan, planExpiry });
    }

    if (action === 'increment') {
      const newCount = await redis.incr(usageKey);
      await redis.expire(usageKey, 172800);
      return res.status(200).json({ count: newCount });
    }

    if (action === 'decrement') {
      const current = parseInt(await redis.get(usageKey) || '0', 10);
      if (current > 0) {
        await redis.set(usageKey, String(current - 1), { EX: 172800 });
      }
      return res.status(200).json({ count: Math.max(0, current - 1) });
    }

    if (action === 'activate_plan') {
      if (!plan || !['basic', 'pro'].includes(plan)) {
        return res.status(400).json({ error: 'Invalid plan.' });
      }
      const expiry   = Date.now() + 24 * 60 * 60 * 1000;
      const planData = JSON.stringify({ plan, expiry });
      await redis.set(planKey, planData, { EX: 90000 });
      return res.status(200).json({ success: true, plan, expiry });
    }

    return res.status(400).json({ error: 'Invalid action.' });

  } catch (err) {
    console.error('Redis error:', err.message);
    return res.status(200).json({ count: 0, plan: null, planExpiry: null });
  }
};
