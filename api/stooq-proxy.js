/**
 * Vercel serverless proxy for Stooq CSV price data.
 * Avoids CORS issues by fetching server-side.
 * Rate-limits to 1 request per second per symbol.
 */

const STOOQ_BASE = 'https://stooq.com/q/d/l/';
const MAX_SYMBOL_LEN = 20;

// Simple in-memory rate limit (per cold-start instance)
const lastFetch = {};
const MIN_INTERVAL_MS = 1200;

function json(res, status, payload) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return json(res, 405, { ok: false, error: 'Method Not Allowed' });
  }

  const symbol = String(req.query.s || '').trim().toLowerCase();
  if (!symbol || symbol.length > MAX_SYMBOL_LEN || !/^[a-z0-9.\-]+$/.test(symbol)) {
    return json(res, 400, { ok: false, error: 'Invalid symbol' });
  }

  // Rate limiting per symbol
  const now = Date.now();
  if (lastFetch[symbol] && now - lastFetch[symbol] < MIN_INTERVAL_MS) {
    return json(res, 429, { ok: false, error: 'Rate limited. Try again shortly.' });
  }
  lastFetch[symbol] = now;

  const url = `${STOOQ_BASE}?s=${encodeURIComponent(symbol)}&i=d`;

  try {
    const stooqRes = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PortfolioVisualizer/1.0)'
      }
    });

    if (!stooqRes.ok) {
      return json(res, stooqRes.status, {
        ok: false,
        error: `Stooq returned ${stooqRes.status}`
      });
    }

    const csv = await stooqRes.text();

    // Detect CAPTCHA / error pages
    if (csv.includes('<html') || csv.includes('Exceeded') || csv.length < 30) {
      return json(res, 503, {
        ok: false,
        error: 'Stooq rate limit or CAPTCHA triggered',
        detail: csv.slice(0, 200)
      });
    }

    // Cache for 1 hour at CDN, 5 min browser
    res.setHeader('Cache-Control', 's-maxage=3600, max-age=300, stale-while-revalidate=600');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.status(200).end(csv);
  } catch (err) {
    return json(res, 500, {
      ok: false,
      error: 'Failed to fetch from Stooq',
      detail: String(err?.message || err)
    });
  }
}
