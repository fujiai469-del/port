import fs from 'node:fs/promises';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, 'config', 'funds.json');
const TICKER_MAP_PATH = path.join(ROOT, 'config', 'ticker-map.json');
const MANUAL_PATH = path.join(ROOT, 'data', 'manual-funds.json');
const OUTPUT_PATH = path.join(ROOT, 'data', 'funds.json');
const META_PATH = path.join(ROOT, 'data', 'meta.json');

const SEC_BASE = 'https://data.sec.gov';
const ARCHIVES_BASE = 'https://www.sec.gov/Archives/edgar/data';

const USER_AGENT = process.env.SEC_USER_AGENT;
if (!USER_AGENT) {
  console.error('SEC_USER_AGENT is required. Example: "Your Name your.email@example.com"');
  process.exit(1);
}

const MAX_HOLDINGS = Number(process.env.MAX_HOLDINGS || 50);
const REQUEST_DELAY_MS = Number(process.env.SEC_DELAY_MS || 200);

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  trimValues: true
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (fallback !== undefined) return fallback;
    throw err;
  }
}

async function fetchSec(url, responseType = 'json') {
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Encoding': 'gzip, deflate'
    }
  });
  if (!res.ok) {
    throw new Error(`SEC request failed: ${res.status} ${res.statusText} for ${url}`);
  }
  const data = responseType === 'text' ? await res.text() : await res.json();
  await sleep(REQUEST_DELAY_MS);
  return data;
}

function toPaddedCik(cik) {
  const digits = String(cik).replace(/\D/g, '');
  return digits.padStart(10, '0');
}

function toArchiveCik(cik) {
  return String(Number(String(cik).replace(/\D/g, '')));
}

function normalizeText(value) {
  if (!value) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function ensureArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function pickLatest13F(recent) {
  if (!recent || !Array.isArray(recent.form)) return null;
  const forms = recent.form;
  let bestIndex = -1;
  for (let i = 0; i < forms.length; i += 1) {
    if (forms[i] === '13F-HR' || forms[i] === '13F-HR/A') {
      if (bestIndex === -1 || recent.filingDate[i] > recent.filingDate[bestIndex]) {
        bestIndex = i;
      }
    }
  }
  if (bestIndex === -1) return null;
  return {
    accessionNumber: recent.accessionNumber[bestIndex],
    filingDate: recent.filingDate[bestIndex],
    reportDate: recent.reportDate?.[bestIndex] || null,
    primaryDocument: recent.primaryDocument?.[bestIndex] || null
  };
}

function pickInfoTableFilename(items) {
  if (!Array.isArray(items)) return null;
  const xmlItems = items
    .filter((item) => item.name?.toLowerCase().endsWith('.xml'))
    .map((item) => ({
      name: item.name,
      size: Number(item.size || 0)
    }));
  const preferred = xmlItems.find((item) => /infotable|informationtable|form13f/i.test(item.name));
  if (preferred) return preferred.name;
  if (xmlItems.length === 1) return xmlItems[0].name;
  const holdingByName = xmlItems.find((item) => /holding|holdings/i.test(item.name));
  if (holdingByName) return holdingByName.name;
  const nonPrimary = xmlItems.filter((item) => item.name.toLowerCase() !== 'primary_doc.xml');
  if (nonPrimary.length) {
    return nonPrimary.sort((a, b) => b.size - a.size)[0].name;
  }
  return xmlItems.sort((a, b) => b.size - a.size)[0]?.name || null;
}

function extractInfoTableEntries(parsed) {
  const root =
    parsed?.informationTable ||
    parsed?.form13fInfoTable ||
    parsed?.document?.informationTable ||
    parsed?.document?.form13fInfoTable;

  if (!root) return [];
  const entries = root.infoTable || root.infoTableEntry || root.infoTableRow;
  return ensureArray(entries);
}

function buildHoldings(entries, tickerMap) {
  const cleaned = entries
    .map((entry) => {
      const name = normalizeText(entry.nameOfIssuer);
      const cusip = normalizeText(entry.cusip);
      const rawTicker = normalizeText(
        entry.ticker || entry.tickerOrSymbol || entry.tickerSymbol || entry.symbol
      );
      const value = Number(entry.value || 0);
      const putCall = normalizeText(entry.putCall).toUpperCase();
      if (!name || !cusip || !Number.isFinite(value) || value <= 0) return null;
      if (putCall === 'PUT' || putCall === 'CALL') return null;
      const mappedTicker = rawTicker || tickerMap[cusip] || tickerMap[name] || '';
      return {
        name,
        cusip,
        value,
        ticker: mappedTicker || cusip
      };
    })
    .filter(Boolean);

  const totalValue = cleaned.reduce((sum, item) => sum + item.value, 0);
  const holdings = cleaned
    .map((item) => ({
      ticker: item.ticker,
      name: item.name,
      percent: totalValue > 0 ? Number(((item.value / totalValue) * 100).toFixed(1)) : 0
    }))
    .sort((a, b) => b.percent - a.percent)
    .slice(0, MAX_HOLDINGS);

  return holdings;
}

async function fetch13fHoldings({ name, cik }, tickerMap) {
  const paddedCik = toPaddedCik(cik);
  const submissionsUrl = `${SEC_BASE}/submissions/CIK${paddedCik}.json`;
  const submissions = await fetchSec(submissionsUrl);
  const latest = pickLatest13F(submissions?.filings?.recent);
  if (!latest) {
    throw new Error(`No 13F filings found for ${name} (${cik})`);
  }

  const archiveCik = toArchiveCik(cik);
  const accessionNoNoDashes = latest.accessionNumber.replace(/-/g, '');
  const indexUrl = `${ARCHIVES_BASE}/${archiveCik}/${accessionNoNoDashes}/index.json`;
  const indexJson = await fetchSec(indexUrl);
  const items = indexJson?.directory?.item || [];
  const infoFilename = pickInfoTableFilename(items) || latest.primaryDocument;
  if (!infoFilename) {
    throw new Error(`Info table not found for ${name} (${cik}) ${latest.accessionNumber}`);
  }

  const infoUrl = `${ARCHIVES_BASE}/${archiveCik}/${accessionNoNoDashes}/${infoFilename}`;
  const xmlText = await fetchSec(infoUrl, 'text');
  const parsed = parser.parse(xmlText);
  const entries = extractInfoTableEntries(parsed);
  if (!entries.length) {
    throw new Error(`No holdings parsed for ${name} (${cik}) ${latest.accessionNumber}`);
  }

  const holdings = buildHoldings(entries, tickerMap);
  return {
    name,
    cik: String(cik),
    reportDate: latest.reportDate,
    filingDate: latest.filingDate,
    holdings
  };
}

async function main() {
  const config = await readJson(CONFIG_PATH, []);
  const tickerMap = await readJson(TICKER_MAP_PATH, {});
  const manualFunds = await readJson(MANUAL_PATH, []);
  const existingMeta = await readJson(META_PATH, null);

  const manualByName = new Map(manualFunds.map((fund) => [fund.name, fund]));
  const combined = new Map();
  manualByName.forEach((value, key) => combined.set(key, value));

  const orderedNames = [];
  let dynamicCount = 0;

  for (const fund of config) {
    if (!fund?.name) continue;
    orderedNames.push(fund.name);
    if (!fund.cik) continue;
    try {
      const dynamicFund = await fetch13fHoldings(fund, tickerMap);
      combined.set(fund.name, dynamicFund);
      dynamicCount += 1;
    } catch (err) {
      console.warn(String(err.message || err));
    }
  }

  const output = [];
  for (const name of orderedNames) {
    if (combined.has(name)) {
      output.push(combined.get(name));
      combined.delete(name);
    }
  }
  combined.forEach((value) => output.push(value));

  const reportDates = output
    .map((fund) => fund.reportDate)
    .filter(Boolean)
    .sort();
  const asOf = reportDates.length ? reportDates[reportDates.length - 1] : null;
  const fallbackAsOf = existingMeta?.asOf || new Date().toISOString().slice(0, 10);

  const meta = {
    asOf: asOf || (dynamicCount > 0 ? new Date().toISOString().slice(0, 10) : fallbackAsOf),
    source: dynamicCount > 0 ? 'sec-edgar' : 'manual',
    generatedAt: new Date().toISOString(),
    totals: {
      funds: output.length,
      dynamic: dynamicCount,
      manual: Math.max(0, output.length - dynamicCount)
    }
  };

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2));
  await fs.writeFile(META_PATH, JSON.stringify(meta, null, 2));

  console.log(`Wrote ${output.length} funds to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
