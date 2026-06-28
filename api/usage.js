/**
 * api/usage.js
 * ─────────────────────────────────────────────────────────
 * Server-side usage tracking using Vercel KV (Redis).
 * Ties usage count to Gmail email — not the browser.
 * This prevents incognito mode from resetting the count.
 *
 * SETUP (one-time, 5 minutes):
 *   1. Go to vercel.com → your project → Storage tab
 *   2. Click Create Database → choose KV (Redis)
 *   3. Name it: resumeiq-usage → Create
 *   4. Vercel auto-adds KV_REST_API_URL and KV_REST_API_TOKEN
 *      to your Environment Variables
 *   5. Redeploy — done
 *
 * HOW IT WORKS:
 *   - Key format:  usage:{email}:{YYYY-MM-DD}  → count (integer)
 *   - Key expiry:  48 hours (auto cleanup)
 *   - Plan format: plan:{email}               → { plan, expiry }
 *   - Count resets automatically at midnight (new date = new key)
 * ─────────────────────────────────────────────────────────
 */

const ALLOWED_ORIGINS = [
  'https://resumeiq-gules-nine.vercel.app',   // ← replace with your Vercel URL
  'https://resumestrength.com', 
  'https://www.resumestrength.com',     // ← replace with your custom domain
  'http://127.0.0.1:5500',
  'http://localhost:5500',
];

// Helper — call Vercel KV REST API
async function kv(method, path, body, env) {
  const url     = env.KV_REST_API_URL + path;
  const token   = env.KV_REST_API_TOKEN;
  const options = {
    method,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type':  'application/json',
    },
  };
  if (body !== undefined) options.body = JSON.stringify(body);
  const res  = await fetch(url, options);
  const data = await res.json();
  return data.result;
}

function getTodayUTC() {
  return new Date().toISOString().split('T')[0]; // e.g. "2025-06-07"
}

export default async function handler(req, res) {
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

  // Check KV is configured
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    // KV not set up yet — return zeroes so app still works
    return res.status(200).json({ count: 0, plan: null, planExpiry: null });
  }

  const { email, action, plan } = req.body || {};

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required.' });
  }

  // Sanitise email for use as Redis key (no spaces, lowercase)
  const safeEmail = email.toLowerCase().replace(/[^a-z0-9@._-]/g, '');
  const today     = getTodayUTC();
  const usageKey  = `usage:${safeEmail}:${today}`;
  const planKey   = `plan:${safeEmail}`;

  try {
    // ── GET — return current count + active plan ──────────────
    if (action === 'get') {
      const [rawCount, rawPlan] = await Promise.all([
        kv('GET', `/get/${usageKey}`, undefined, process.env),
        kv('GET', `/get/${planKey}`,  undefined, process.env),
      ]);

      const count    = parseInt(rawCount || '0', 10);
      let activePlan = null;
      let planExpiry = null;

      if (rawPlan) {
        try {
          const parsed = JSON.parse(rawPlan);
          if (parsed.expiry && Date.now() < parsed.expiry) {
            activePlan = parsed.plan;
            planExpiry = parsed.expiry;
          }
        } catch { /* malformed — ignore */ }
      }

      return res.status(200).json({ count, plan: activePlan, planExpiry });
    }

    // ── INCREMENT — add 1 to today's count ───────────────────
    if (action === 'increment') {
      // INCR atomically increments and returns new value
      const newCount = await kv('POST', `/incr/${usageKey}`, undefined, process.env);

      // Set 48-hour TTL so keys self-clean (first increment only needs this)
      await kv('POST', `/expire/${usageKey}/172800`, undefined, process.env);

      return res.status(200).json({ count: parseInt(newCount || '1', 10) });
    }

    // ── DECREMENT — rollback on analysis error ────────────────
    if (action === 'decrement') {
      const rawCount   = await kv('GET', `/get/${usageKey}`, undefined, process.env);
      const current    = parseInt(rawCount || '0', 10);
      if (current > 0) {
        await kv('POST', `/set/${usageKey}`, [String(current - 1), 'EX', '172800'], process.env);
      }
      return res.status(200).json({ count: Math.max(0, current - 1) });
    }

    // ── ACTIVATE_PLAN — save paid plan for 24 hours ──────────
    if (action === 'activate_plan') {
      if (!plan || !['basic', 'pro'].includes(plan)) {
        return res.status(400).json({ error: 'Invalid plan.' });
      }
      const expiry    = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
      const planData  = JSON.stringify({ plan, expiry });

      // Store with 25-hour TTL (slightly over 24h for safety)
      await kv('POST', `/set/${planKey}`, [planData, 'EX', '90000'], process.env);

      return res.status(200).json({ success: true, plan, expiry });
    }

    return res.status(400).json({ error: 'Invalid action. Use: get | increment | decrement | activate_plan' });

  } catch (err) {
    // Never crash the app if KV is unavailable — return safe defaults
    console.error('KV error:', err.message);
    return res.status(200).json({ count: 0, plan: null, planExpiry: null });
  }
}
