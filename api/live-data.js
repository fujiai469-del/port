import fs from 'node:fs/promises';
import path from 'node:path';

const GITHUB_OWNER = process.env.GITHUB_DATA_OWNER || process.env.GITHUB_OWNER || 'fujiai469-del';
const GITHUB_REPO = process.env.GITHUB_DATA_REPO || process.env.GITHUB_REPO || 'port';
const PRIMARY_REF = process.env.GITHUB_DATA_REF || 'data-live';
const FALLBACK_REF = process.env.GITHUB_DATA_FALLBACK_REF || process.env.GITHUB_REF || 'main';

const FILE_MAP = {
  funds: 'data/funds.json',
  'funds-prev': 'data/funds-prev.json',
  'manual-funds': 'data/manual-funds.json',
  meta: 'data/meta.json',
  'ticker-map': 'data/ticker-map.json'
};

function sendJson(res, status, payload, extraHeaders = {}) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  Object.entries(extraHeaders).forEach(([key, value]) => res.setHeader(key, value));
  res.end(JSON.stringify(payload));
}

async function fetchJsonFromGitHub(ref, filePath) {
  const rawUrl = `https://raw.githubusercontent.com/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(
    GITHUB_REPO
  )}/${encodeURIComponent(ref)}/${filePath}`;
  const response = await fetch(rawUrl, { headers: { 'User-Agent': 'portfolio-visualizer-live-data' } });
  if (!response.ok) return null;
  const text = await response.text();
  const parsed = JSON.parse(text);
  return { parsed, source: `github:${ref}`, rawUrl };
}

async function readLocalJson(filePath) {
  const absolutePath = path.join(process.cwd(), filePath);
  const raw = await fs.readFile(absolutePath, 'utf8');
  return JSON.parse(raw);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
  }

  const name = String(req.query?.name || '').trim();
  const filePath = FILE_MAP[name];
  if (!filePath) {
    return sendJson(res, 400, { ok: false, error: 'Invalid dataset name' });
  }

  const refs = [];
  if (PRIMARY_REF) refs.push(PRIMARY_REF);
  if (FALLBACK_REF && FALLBACK_REF !== PRIMARY_REF) refs.push(FALLBACK_REF);

  for (const ref of refs) {
    try {
      const payload = await fetchJsonFromGitHub(ref, filePath);
      if (payload) {
        res.status(200);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store, max-age=0');
        res.setHeader('x-live-data-source', payload.source);
        res.end(JSON.stringify(payload.parsed));
        return;
      }
    } catch (_error) {
      // Try next ref or local fallback.
    }
  }

  try {
    const local = await readLocalJson(filePath);
    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('x-live-data-source', 'local');
    res.end(JSON.stringify(local));
    return;
  } catch (error) {
    return sendJson(res, 502, {
      ok: false,
      error: 'Failed to load data from GitHub and local fallback',
      details: String(error?.message || error)
    });
  }
}
