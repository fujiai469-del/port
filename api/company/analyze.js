import { z } from 'zod';

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const PEXELS_BASE_URL = 'https://api.pexels.com/v1/search';

const RATE_LIMIT_WINDOW_MS = 45_000;
const RATE_LIMIT_MAX = 8;
const RETRY_COUNT = 2;
const RETRY_DELAY_MS = 350;
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX_ENTRIES = 120;
const REQUEST_TIMEOUT_MS = 15_000;
const IMAGE_TIMEOUT_MS = 2_800;
const DAILY_QUOTA_TZ = process.env.COMPANY_ANALYZE_QUOTA_TZ || 'Asia/Tokyo';
const parsedDailyLimit = Number(process.env.COMPANY_ANALYZE_DAILY_LIMIT);
const DAILY_QUOTA_LIMIT = Number.isFinite(parsedDailyLimit) ? Math.max(0, Math.floor(parsedDailyLimit)) : 120;

const rateStore = new Map();
const cacheStore = new Map();
const dailyQuotaStore = new Map();

const AnalyzeInputSchema = z.object({
  query: z.string().trim().min(1).max(120),
  lang: z.enum(['ja', 'en']).default('en'),
  tickerHint: z.string().trim().min(1).max(20).optional(),
  companyHint: z.string().trim().min(1).max(220).optional(),
  sectorHint: z.string().trim().min(1).max(80).optional()
});

const ModelPillarSchema = z.object({
  icon: z.string().trim().min(1).max(40),
  title: z.string().trim().min(1).max(64),
  description: z.string().trim().min(1).max(700),
  imagePrompt: z.string().trim().min(1).max(120).optional()
});

const ModelAnalysisSchema = z.object({
  companyName: z.string().trim().min(1).max(180),
  ticker: z.string().trim().min(1).max(24).optional().default(''),
  categoryTitle: z.string().trim().min(1).max(140),
  summary3: z.string().trim().min(1).max(500),
  summary: z.string().trim().min(1).max(1800),
  pillars: z.array(ModelPillarSchema).min(3).max(5),
  tags: z.array(z.string().trim().min(1).max(32)).min(1).max(12)
});

const MESSAGES = {
  ja: {
    badRequest: '企業名またはティッカーを入力してください',
    config: '管理者がAPIキーを設定してください（GEMINI_API_KEY）',
    rateLimit: 'リクエストが集中しています。少し待って再試行してください',
    dailyLimit: '本日の分析上限に達しました。日付が変わってから再試行してください',
    notFound: '企業を特定できませんでした',
    invalidJson: 'AI応答の解析に失敗しました',
    upstream: '外部AIサービスからの応答取得に失敗しました'
  },
  en: {
    badRequest: 'Please provide a company name or ticker',
    config: 'Administrator must configure GEMINI_API_KEY',
    rateLimit: 'Too many requests. Please wait and try again',
    dailyLimit: 'Daily analysis limit reached. Please try again after the date changes',
    notFound: 'Company could not be identified',
    invalidJson: 'Failed to parse AI response',
    upstream: 'Failed to get response from upstream AI service'
  }
};

class AnalyzeError extends Error {
  constructor(code, message, status = 500, retryable = false) {
    super(message);
    this.name = 'AnalyzeError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function message(lang, key) {
  const locale = lang === 'ja' ? 'ja' : 'en';
  return MESSAGES[locale][key] || MESSAGES.en[key] || MESSAGES.en.upstream;
}

function getQuotaHeaders(quota) {
  if (!quota) return {};
  return {
    'x-company-quota-date': String(quota.date || ''),
    'x-company-quota-limit': quota.unlimited ? '-1' : String(quota.limit),
    'x-company-quota-used': String(quota.used),
    'x-company-quota-remaining': quota.unlimited ? '-1' : String(quota.remaining),
    'x-company-quota-unlimited': quota.unlimited ? '1' : '0'
  };
}

function toQuotaPayload(quota) {
  if (!quota) return null;
  return {
    date: quota.date,
    limit: quota.unlimited ? null : quota.limit,
    used: quota.used,
    remaining: quota.unlimited ? null : quota.remaining,
    unlimited: quota.unlimited
  };
}

function json(res, status, payload, extraHeaders = {}) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  Object.entries(extraHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });
  res.end(JSON.stringify(payload));
}

function success(res, data, quota = null) {
  return json(res, 200, {
    success: true,
    data,
    error: null,
    quota: toQuotaPayload(quota)
  }, getQuotaHeaders(quota));
}

function failure(res, status, code, messageText, quota = null) {
  return json(res, status, {
    success: false,
    data: null,
    error: {
      code,
      message: messageText
    },
    quota: toQuotaPayload(quota)
  }, getQuotaHeaders(quota));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTicker(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeHintText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeQuery(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function compactTicker(value) {
  return normalizeTicker(value).replace(/[^A-Z0-9]/g, '');
}

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.trim()) {
    try {
      return JSON.parse(req.body);
    } catch (_error) {
      return null;
    }
  }
  return {};
}

function getClientKey(req) {
  const xff = req.headers['x-forwarded-for'];
  const forwarded = Array.isArray(xff) ? xff[0] : String(xff || '');
  const ip = forwarded.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  const uaHeader = req.headers['user-agent'];
  const ua = Array.isArray(uaHeader) ? uaHeader[0] : String(uaHeader || 'unknown');
  return `${ip}|${ua.slice(0, 140)}`;
}

function getQuotaDateKey(date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: DAILY_QUOTA_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date);
    const year = parts.find((part) => part.type === 'year')?.value;
    const month = parts.find((part) => part.type === 'month')?.value;
    const day = parts.find((part) => part.type === 'day')?.value;
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch (_error) {
    // fallback to UTC below
  }
  return date.toISOString().slice(0, 10);
}

function toQuotaSnapshot(entry) {
  if (!entry) return null;
  if (DAILY_QUOTA_LIMIT <= 0) {
    return {
      date: entry.date,
      limit: null,
      used: entry.used,
      remaining: null,
      unlimited: true
    };
  }
  return {
    date: entry.date,
    limit: DAILY_QUOTA_LIMIT,
    used: entry.used,
    remaining: Math.max(DAILY_QUOTA_LIMIT - entry.used, 0),
    unlimited: false
  };
}

function getOrInitDailyEntry(clientKey) {
  const today = getQuotaDateKey();
  const current = dailyQuotaStore.get(clientKey);
  if (!current || current.date !== today) {
    const next = { date: today, used: 0 };
    dailyQuotaStore.set(clientKey, next);
    return next;
  }
  return current;
}

function getDailyQuota(clientKey) {
  const entry = getOrInitDailyEntry(clientKey);
  return toQuotaSnapshot(entry);
}

function consumeDailyQuota(clientKey) {
  const entry = getOrInitDailyEntry(clientKey);
  if (DAILY_QUOTA_LIMIT > 0 && entry.used >= DAILY_QUOTA_LIMIT) {
    return { allowed: false, quota: toQuotaSnapshot(entry) };
  }

  entry.used += 1;
  dailyQuotaStore.set(clientKey, entry);

  if (dailyQuotaStore.size > 4000) {
    const today = getQuotaDateKey();
    for (const [key, value] of dailyQuotaStore.entries()) {
      if (value.date !== today && value.used === 0) {
        dailyQuotaStore.delete(key);
      }
    }
  }

  return { allowed: true, quota: toQuotaSnapshot(entry) };
}

function isRateLimited(clientKey) {
  const now = Date.now();
  const bucket = rateStore.get(clientKey) || [];
  const recent = bucket.filter((stamp) => now - stamp < RATE_LIMIT_WINDOW_MS);

  if (recent.length >= RATE_LIMIT_MAX) {
    rateStore.set(clientKey, recent);
    return true;
  }

  recent.push(now);
  rateStore.set(clientKey, recent);

  if (rateStore.size > 2000) {
    for (const [key, stamps] of rateStore.entries()) {
      const keep = stamps.filter((stamp) => now - stamp < RATE_LIMIT_WINDOW_MS);
      if (keep.length === 0) rateStore.delete(key);
      else rateStore.set(key, keep);
    }
  }

  return false;
}

function getCache(cacheKey) {
  const hit = cacheStore.get(cacheKey);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cacheStore.delete(cacheKey);
    return null;
  }

  cacheStore.delete(cacheKey);
  cacheStore.set(cacheKey, hit);
  return hit.value;
}

function setCache(cacheKey, value) {
  cacheStore.delete(cacheKey);
  cacheStore.set(cacheKey, {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS
  });

  while (cacheStore.size > CACHE_MAX_ENTRIES) {
    const oldest = cacheStore.keys().next().value;
    cacheStore.delete(oldest);
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function buildPrompt(query, lang, hints = {}) {
  const tickerHint = normalizeTicker(hints.tickerHint || '');
  const companyHint = normalizeHintText(hints.companyHint || '');
  const sectorHint = normalizeHintText(hints.sectorHint || '');
  const inJapanese = lang === 'ja';
  const languageInstruction = inJapanese
    ? '出力は日本語で、自然な投資家向け説明にしてください。'
    : 'Write the output in natural English for investors.';

  const disambiguationLines = [];
  if (tickerHint) disambiguationLines.push(`- Ticker hint: ${tickerHint}`);
  if (companyHint) disambiguationLines.push(`- Company label hint from holdings table: ${companyHint}`);
  if (sectorHint) disambiguationLines.push(`- Sector hint: ${sectorHint}`);
  if (tickerHint || companyHint || sectorHint) {
    disambiguationLines.push('- Resolve ambiguity by prioritizing these hints over same-symbol companies on other exchanges.');
    if (tickerHint) {
      disambiguationLines.push(`- If ticker is present, returned ticker must match "${tickerHint}" (same symbol, punctuation allowed).`);
    }
  }

  return `You are a senior equity analyst.
Analyze the company identified by: ${query}

${languageInstruction}
- Target only publicly listed companies.
- If you cannot identify the company confidently, return: {"companyName":"NOT_FOUND"}
- No markdown, no commentary, JSON only.
- Keep "summary3" to exactly 3 short lines separated by "\\n".
- Return 3 to 5 pillars.
${disambiguationLines.join('\n')}

Return JSON with this exact schema:
{
  "companyName": "string",
  "ticker": "string",
  "categoryTitle": "string",
  "summary3": "line1\\nline2\\nline3",
  "summary": "string",
  "pillars": [
    {
      "icon": "string",
      "title": "string",
      "description": "string",
      "imagePrompt": "string"
    }
  ],
  "tags": ["string"]
}`;
}

function stripCodeFence(text) {
  return text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

const COMPANY_STOPWORDS = new Set([
  'INC',
  'INCORPORATED',
  'CORP',
  'CORPORATION',
  'CO',
  'COMPANY',
  'LTD',
  'LIMITED',
  'PLC',
  'HOLDINGS',
  'HLDGS',
  'HOLDING',
  'GROUP',
  'CLASS',
  'THE',
  'SA',
  'NV',
  'N',
  'NEW',
  'ADR',
  'ADS',
  'COMMON',
  'STOCK'
]);

function companyTokens(value) {
  return normalizeHintText(value)
    .toUpperCase()
    .replace(/&/g, ' ')
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => token.length >= 2 && !COMPANY_STOPWORDS.has(token));
}

function companySimilarity(left, right) {
  const a = new Set(companyTokens(left));
  const b = new Set(companyTokens(right));
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  a.forEach((token) => {
    if (b.has(token)) intersection += 1;
  });
  return intersection / (a.size + b.size - intersection);
}

function normalizeSummary3(summary3, summary, lang) {
  const lines = String(summary3 || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\-\*\d\.\)\s]+/, '').trim())
    .filter(Boolean);

  const fallback = lang === 'ja' ? '取得不可' : 'Unavailable';
  if (lines.length === 0 && summary) {
    const firstSentence = String(summary).split(/[。.!?]/)[0].trim();
    if (firstSentence) lines.push(firstSentence);
  }
  while (lines.length < 3) lines.push(fallback);
  return lines.slice(0, 3).join('\n');
}

function toAnalyzeError(error, lang) {
  if (error instanceof AnalyzeError) return error;
  return new AnalyzeError('UPSTREAM', message(lang, 'upstream'), 502, true);
}

function parseGeminiResult(rawText, query, lang, hints = {}) {
  const cleaned = stripCodeFence(String(rawText || '').trim());
  const jsonText = extractJsonObject(cleaned) || cleaned;

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (_error) {
    throw new AnalyzeError('INVALID_JSON', message(lang, 'invalidJson'), 502, true);
  }

  if (String(parsed?.companyName || '').trim().toUpperCase() === 'NOT_FOUND') {
    throw new AnalyzeError('NOT_FOUND', `${message(lang, 'notFound')}: ${query}`, 404, false);
  }

  const validated = ModelAnalysisSchema.safeParse(parsed);
  if (!validated.success) {
    throw new AnalyzeError('INVALID_JSON', message(lang, 'invalidJson'), 502, true);
  }

  const value = validated.data;
  const explicitTickerHint = normalizeTicker(hints.tickerHint || '');
  const tickerGuess = explicitTickerHint || (
    /^[A-Za-z][A-Za-z0-9.\-]{0,9}$/.test(String(query || '').trim())
      ? normalizeTicker(query)
      : ''
  );

  return {
    companyName: value.companyName.trim(),
    ticker: normalizeTicker(value.ticker || tickerGuess),
    categoryTitle: value.categoryTitle.trim(),
    summary3: normalizeSummary3(value.summary3, value.summary, lang),
    summary: value.summary.trim(),
    pillars: value.pillars.slice(0, 5).map((pillar) => ({
      icon: pillar.icon.trim(),
      title: pillar.title.trim(),
      description: pillar.description.trim(),
      imagePrompt: String(pillar.imagePrompt || '').trim(),
      imageUrl: null
    })),
    tags: Array.from(new Set(value.tags.map((tag) => tag.trim()).filter(Boolean))).slice(0, 8)
  };
}

function validateDisambiguation(result, query, lang, hints = {}) {
  const tickerHint = normalizeTicker(hints.tickerHint || '');
  const companyHint = normalizeHintText(hints.companyHint || '');
  if (!tickerHint && !companyHint) return;

  if (tickerHint) {
    const expected = compactTicker(tickerHint);
    const actual = compactTicker(result?.ticker || '');
    if (expected && actual && expected !== actual) {
      throw new AnalyzeError('NOT_FOUND', `${message(lang, 'notFound')}: ${query}`, 404, false);
    }
  }

  if (tickerHint && companyHint) {
    const score = companySimilarity(companyHint, result?.companyName || '');
    if (score < 0.2) {
      throw new AnalyzeError('NOT_FOUND', `${message(lang, 'notFound')}: ${query}`, 404, false);
    }
  }
}

function extractGeminiText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const joined = parts
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('\n')
      .trim();
    if (joined) return joined;
  }
  return '';
}

async function callGemini(apiKey, query, lang, hints = {}) {
  const url = `${GEMINI_BASE_URL}/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const prompt = buildPrompt(query, lang, hints);

  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.25,
          maxOutputTokens: 1400,
          responseMimeType: 'application/json'
        }
      })
    },
    REQUEST_TIMEOUT_MS
  );

  if (!response.ok) {
    await response.text().catch(() => '');
    if (response.status === 429) {
      throw new AnalyzeError('RATE_LIMIT', message(lang, 'rateLimit'), 429, false);
    }
    if (response.status >= 500) {
      throw new AnalyzeError('UPSTREAM', `${message(lang, 'upstream')} (${response.status})`, 502, true);
    }
    throw new AnalyzeError('UPSTREAM', `${message(lang, 'upstream')} (${response.status})`, 502, false);
  }

  const payload = await response.json().catch(() => null);
  if (!payload) {
    throw new AnalyzeError('INVALID_JSON', message(lang, 'invalidJson'), 502, true);
  }

  const text = extractGeminiText(payload);
  if (!text) {
    throw new AnalyzeError('UPSTREAM', message(lang, 'upstream'), 502, true);
  }

  const result = parseGeminiResult(text, query, lang, hints);
  validateDisambiguation(result, query, lang, hints);
  return result;
}

function buildImageQueries(result, pillar) {
  const candidates = [];
  if (pillar.imagePrompt) candidates.push(pillar.imagePrompt);
  candidates.push(`${result.companyName} ${pillar.title}`);
  if (Array.isArray(result.tags) && result.tags.length > 0) {
    candidates.push(`${result.tags[0]} business`);
  }
  return Array.from(new Set(candidates.map((q) => String(q || '').trim()).filter(Boolean)));
}

async function fetchPexelsImage(apiKey, query) {
  const url = `${PEXELS_BASE_URL}?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape`;
  try {
    const response = await fetchWithTimeout(
      url,
      { headers: { Authorization: apiKey } },
      IMAGE_TIMEOUT_MS
    );
    if (!response.ok) return null;

    const payload = await response.json().catch(() => null);
    if (!payload) return null;

    return payload?.photos?.[0]?.src?.medium || payload?.photos?.[0]?.src?.large || null;
  } catch (_error) {
    return null;
  }
}

async function enrichImages(result) {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) {
    return {
      ...result,
      pillars: result.pillars.map((pillar) => ({
        icon: pillar.icon,
        title: pillar.title,
        description: pillar.description,
        imageUrl: null
      }))
    };
  }

  const pillars = await Promise.all(
    result.pillars.map(async (pillar) => {
      const queries = buildImageQueries(result, pillar);
      let imageUrl = null;

      for (const query of queries) {
        imageUrl = await fetchPexelsImage(apiKey, query);
        if (imageUrl) break;
      }

      return {
        icon: pillar.icon,
        title: pillar.title,
        description: pillar.description,
        imageUrl: imageUrl || null
      };
    })
  );

  return {
    companyName: result.companyName,
    ticker: result.ticker,
    categoryTitle: result.categoryTitle,
    summary3: result.summary3,
    summary: result.summary,
    pillars,
    tags: result.tags
  };
}

async function runWithRetries(task, retries, lang) {
  let attempt = 0;
  let lastError = null;

  while (attempt <= retries) {
    try {
      return await task();
    } catch (error) {
      const typed = toAnalyzeError(error, lang);
      lastError = typed;

      if (!typed.retryable || attempt >= retries) {
        throw typed;
      }

      await sleep(RETRY_DELAY_MS * (attempt + 1));
      attempt += 1;
    }
  }

  throw lastError || new AnalyzeError('UPSTREAM', message(lang, 'upstream'), 502, true);
}

export default async function handler(req, res) {
  const clientKey = getClientKey(req);
  let quotaSnapshot = getDailyQuota(clientKey);

  if (req.method === 'GET') {
    const mode = String(req.query?.mode || '').trim().toLowerCase();
    if (mode === 'quota') {
      return json(res, 200, {
        success: true,
        data: null,
        error: null,
        quota: toQuotaPayload(quotaSnapshot)
      }, getQuotaHeaders(quotaSnapshot));
    }

    res.setHeader('Allow', 'POST, GET');
    return failure(res, 405, 'BAD_REQUEST', 'Method Not Allowed', quotaSnapshot);
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, GET');
    return failure(res, 405, 'BAD_REQUEST', 'Method Not Allowed', quotaSnapshot);
  }

  const body = parseBody(req);
  if (body === null) {
    return failure(res, 400, 'BAD_REQUEST', message('en', 'badRequest'), quotaSnapshot);
  }

  const parsedInput = AnalyzeInputSchema.safeParse(body);
  if (!parsedInput.success) {
    return failure(res, 400, 'BAD_REQUEST', message('en', 'badRequest'), quotaSnapshot);
  }

  const { query, lang } = parsedInput.data;
  const hints = {
    tickerHint: normalizeTicker(parsedInput.data.tickerHint || ''),
    companyHint: normalizeHintText(parsedInput.data.companyHint || ''),
    sectorHint: normalizeHintText(parsedInput.data.sectorHint || '')
  };
  const normalized = normalizeQuery(query);
  if (!normalized || !/[\p{L}\p{N}]/u.test(normalized)) {
    return failure(res, 400, 'BAD_REQUEST', message(lang, 'badRequest'), quotaSnapshot);
  }

  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    console.error('[api/company/analyze] GEMINI_API_KEY is missing');
    return failure(res, 500, 'CONFIG', message(lang, 'config'), quotaSnapshot);
  }

  if (isRateLimited(clientKey)) {
    quotaSnapshot = getDailyQuota(clientKey);
    return failure(res, 429, 'RATE_LIMIT', message(lang, 'rateLimit'), quotaSnapshot);
  }

  const cacheKey = `${lang}:${normalized}:${normalizeQuery(hints.tickerHint)}:${normalizeQuery(hints.companyHint)}:${normalizeQuery(hints.sectorHint)}`;
  const cached = getCache(cacheKey);
  if (cached) {
    quotaSnapshot = getDailyQuota(clientKey);
    return success(res, cached, quotaSnapshot);
  }

  const consumed = consumeDailyQuota(clientKey);
  quotaSnapshot = consumed.quota;
  if (!consumed.allowed) {
    return failure(res, 429, 'RATE_LIMIT', message(lang, 'dailyLimit'), quotaSnapshot);
  }

  try {
    const analyzed = await runWithRetries(
      async () => {
        const base = await callGemini(geminiApiKey, query.trim(), lang, hints);
        return enrichImages(base);
      },
      RETRY_COUNT,
      lang
    );

    setCache(cacheKey, analyzed);
    return success(res, analyzed, quotaSnapshot);
  } catch (error) {
    const typed = toAnalyzeError(error, lang);
    return failure(res, typed.status, typed.code, typed.message, quotaSnapshot);
  }
}
