/**
 * PriceWatch — Cloudflare Worker Proxy
 * ─────────────────────────────────────
 * Deploy FREE to Cloudflare Workers (100k req/day on free tier).
 * This sits between your website and AWS API Gateway,
 * injecting the API key server-side so it never appears
 * in frontend code.
 *
 * One-time setup (takes ~3 minutes):
 *   npm install -g wrangler
 *   wrangler login
 *   wrangler secret put API_KEY            ← paste your AWS API Gateway key
 *   wrangler secret put API_GATEWAY_URL    ← paste your full AWS endpoint URL
 *   wrangler deploy
 *
 * Then in index.html set:
 *   const PROXY_URL = 'https://pricewatch-proxy.YOUR-NAME.workers.dev';
 */

export default {
  async fetch(request, env) {

    // ── CORS: lock to your hosted domain ──────────────────────────
    // After you deploy to Netlify/GitHub Pages, change this env var
    // in wrangler.toml to your actual URL.
    const ALLOWED_ORIGIN = env.ALLOWED_ORIGIN || '*';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(ALLOWED_ORIGIN) });
    }

    // ── Route guard ────────────────────────────────────────────────
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/alerts') {
      return json({ error: 'Not found' }, 404, ALLOWED_ORIGIN);
    }

    // ── Rate limit: 5 submissions per IP per minute ────────────────
    const ip  = request.headers.get('CF-Connecting-IP') || 'unknown';
    const now = Date.now();
    if (!globalThis._rl) globalThis._rl = new Map();
    const slot = globalThis._rl.get(ip) || { n: 0, reset: now + 60_000 };
    if (now > slot.reset) { slot.n = 0; slot.reset = now + 60_000; }
    slot.n++;
    globalThis._rl.set(ip, slot);
    if (slot.n > 5) {
      return json({ error: 'Too many requests — try again in a minute.' }, 429, ALLOWED_ORIGIN);
    }

    // ── Parse body ─────────────────────────────────────────────────
    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'Invalid JSON body' }, 400, ALLOWED_ORIGIN); }

    // ── Validate & sanitize ────────────────────────────────────────
    const err = validate(body);
    if (err) return json({ error: err }, 400, ALLOWED_ORIGIN);

    // ── Forward to AWS — API key injected here, never in browser ──
    try {
      const awsRes = await fetch(env.API_GATEWAY_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.API_KEY,    // secret lives only in Cloudflare env
        },
        body: JSON.stringify({
          productUrl:   sanitize(body.productUrl,   500),
          productName:  sanitize(body.productName,  200),
          userEmail:    sanitize(body.userEmail,     254),
          currentPrice: body.currentPrice,
          targetPrice:  body.targetPrice,
        }),
      });
      const data = await awsRes.json().catch(() => ({}));
      return json(data, awsRes.status, ALLOWED_ORIGIN);
    } catch (e) {
      return json({ error: 'Upstream error: ' + e.message }, 502, ALLOWED_ORIGIN);
    }
  },
};

// ── Validation ─────────────────────────────────────────────────────
function validate(b) {
  if (!b.productUrl  || typeof b.productUrl  !== 'string') return 'productUrl is required';
  if (!b.productName || typeof b.productName !== 'string') return 'productName is required';
  if (!b.userEmail   || typeof b.userEmail   !== 'string') return 'userEmail is required';
  if (typeof b.currentPrice !== 'number' || b.currentPrice <= 0)  return 'currentPrice must be a positive number';
  if (typeof b.targetPrice  !== 'number' || b.targetPrice  <= 0)  return 'targetPrice must be a positive number';
  if (b.targetPrice >= b.currentPrice) return 'targetPrice must be below currentPrice';
  if (!/^https?:\/\/(www\.)?amazon\.in\//.test(b.productUrl)) return 'Only amazon.in URLs are accepted';
  if (b.productName.length > 200)  return 'productName too long';
  if (b.userEmail.length   > 254)  return 'Email address too long';
  if (!b.userEmail.includes('@'))  return 'Invalid email address';
  return null;
}

function sanitize(str, maxLen) {
  return String(str).trim().slice(0, maxLen).replace(/[<>]/g, '');
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}
