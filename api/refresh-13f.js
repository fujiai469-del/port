const GITHUB_OWNER = process.env.GITHUB_OWNER || 'fujiai469-del';
const GITHUB_REPO = process.env.GITHUB_REPO || 'port';
const GITHUB_WORKFLOW = process.env.GITHUB_WORKFLOW || 'refresh-13f.yml';
const GITHUB_REF = process.env.GITHUB_REF || 'main';
const GITHUB_TOKEN = process.env.GITHUB_REFRESH_TOKEN || process.env.GITHUB_TOKEN;

function json(res, status, payload) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { ok: false, error: 'Method Not Allowed' });
  }

  const requiredApiKey = process.env.REFRESH_API_KEY;
  if (requiredApiKey) {
    const providedApiKey = req.headers['x-refresh-key'];
    if (!providedApiKey || providedApiKey !== requiredApiKey) {
      return json(res, 401, { ok: false, error: 'Unauthorized' });
    }
  }

  if (!GITHUB_TOKEN) {
    return json(res, 500, { ok: false, error: 'Missing GITHUB_REFRESH_TOKEN (or GITHUB_TOKEN)' });
  }

  const url = `https://api.github.com/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(
    GITHUB_REPO
  )}/actions/workflows/${encodeURIComponent(GITHUB_WORKFLOW)}/dispatches`;

  try {
    const ghRes = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'portfolio-visualizer-refresh-api'
      },
      body: JSON.stringify({ ref: GITHUB_REF })
    });

    if (!ghRes.ok) {
      const body = await ghRes.text();
      return json(res, ghRes.status, {
        ok: false,
        error: `GitHub dispatch failed (${ghRes.status})`,
        details: body || ghRes.statusText
      });
    }

    return json(res, 200, {
      ok: true,
      queuedAt: new Date().toISOString(),
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      workflow: GITHUB_WORKFLOW,
      ref: GITHUB_REF
    });
  } catch (err) {
    return json(res, 500, {
      ok: false,
      error: 'Failed to dispatch GitHub workflow',
      details: String(err?.message || err)
    });
  }
}
