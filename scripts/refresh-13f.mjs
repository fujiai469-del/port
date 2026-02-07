import fs from 'node:fs/promises';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, 'config', 'funds.json');
const TICKER_MAP_PATH = path.join(ROOT, 'config', 'ticker-map.json');
const MANUAL_PATH = path.join(ROOT, 'data', 'manual-funds.json');
const OUTPUT_PATH = path.join(ROOT, 'data', 'funds.json');
const PREV_OUTPUT_PATH = path.join(ROOT, 'data', 'funds-prev.json');
const META_PATH = path.join(ROOT, 'data', 'meta.json');

const SEC_BASE = 'https://data.sec.gov';
const ARCHIVES_BASE = 'https://www.sec.gov/Archives/edgar/data';
const ONLINE_TICKER_MAP_URL =
  'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/master/data/constituents.csv';

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

const SECTOR_BY_TICKER = {
  ABT: 'Healthcare',
  ACHR: 'Industrial',
  ACN: 'Technology',
  ALVO: 'Healthcare',
  AGI: 'Materials',
  ALSN: 'Industrial',
  ABNB: 'Consumer',
  ARKB: 'ETF',
  APP: 'Technology',
  AU: 'Materials',
  AVAV: 'Industrial',
  B: 'Materials',
  BBIO: 'Healthcare',
  BHC: 'Healthcare',
  BL: 'Technology',
  BLSH: 'Technology',
  BMNR: 'Financial',
  BMRN: 'Healthcare',
  BN: 'Financial',
  BOX: 'Technology',
  BREA: 'Consumer',
  BRKR: 'Healthcare',
  BSY: 'Technology',
  BTSG: 'Healthcare',
  BV: 'Industrial',
  BZ: 'Communication',
  CABO: 'Communication',
  CALM: 'Consumer',
  CRWD: 'Technology',
  CBOE: 'Financial',
  CELC: 'Healthcare',
  CGON: 'Healthcare',
  CHRS: 'Healthcare',
  CNP: 'Energy',
  COIN: 'Financial',
  CRCL: 'Financial',
  CRGY: 'Energy',
  CRH: 'Materials',
  CNI: 'Industrial',
  CRSP: 'Healthcare',
  CORT: 'Healthcare',
  CVLT: 'Technology',
  CVNA: 'Consumer',
  DASH: 'Consumer',
  DKNG: 'Consumer',
  DBX: 'Technology',
  DEC: 'Energy',
  DXCM: 'Healthcare',
  ETSY: 'Consumer',
  EXEL: 'Healthcare',
  EXPE: 'Consumer',
  EXAS: 'Healthcare',
  ENOV: 'Healthcare',
  FNV: 'Materials',
  FERG: 'Industrial',
  FNF: 'Financial',
  FIP: 'Industrial',
  FSK: 'Financial',
  FTAI: 'Industrial',
  GEHC: 'Healthcare',
  GEV: 'Industrial',
  GH: 'Healthcare',
  GIL: 'Consumer',
  GOLF: 'Consumer',
  GPN: 'Financial',
  GRAB: 'Technology',
  HAE: 'Healthcare',
  HDB: 'Financial',
  HHH: 'Financial',
  HIMS: 'Healthcare',
  HOOD: 'Financial',
  HOUS: 'Consumer',
  HSIC: 'Healthcare',
  HTZ: 'Consumer',
  HTZWW: 'Consumer',
  IBKR: 'Financial',
  IMCR: 'Healthcare',
  ILMN: 'Healthcare',
  IONQ: 'Technology',
  IRON: 'Healthcare',
  IRDM: 'Communication',
  ITUB: 'Financial',
  IVV: 'ETF',
  IVZ: 'Financial',
  JBLU: 'Industrial',
  JBS: 'Consumer',
  KGC: 'Materials',
  KREF: 'Financial',
  KTOS: 'Industrial',
  LHX: 'Industrial',
  LAUR: 'Consumer',
  MOH: 'Healthcare',
  MELI: 'Consumer',
  MTN: 'Consumer',
  NCLH: 'Consumer',
  NIQ: 'Technology',
  RBLX: 'Communication',
  NBIX: 'Healthcare',
  NTRA: 'Healthcare',
  NTLA: 'Healthcare',
  NTNX: 'Technology',
  PLTR: 'Technology',
  NVCR: 'Healthcare',
  NVST: 'Healthcare',
  NVO: 'Healthcare',
  PCG: 'Energy',
  PD: 'Technology',
  PEB: 'Financial',
  POWL: 'Industrial',
  PPL: 'Energy',
  PSKY: 'Communication',
  PSTG: 'Technology',
  PRM: 'Materials',
  QSR: 'Consumer',
  RDFN: 'Consumer',
  RDDT: 'Communication',
  RKLB: 'Industrial',
  ROKU: 'Communication',
  RXRX: 'Healthcare',
  SABR: 'Technology',
  SE: 'Consumer',
  SE: 'Consumer',
  SEG: 'Communication',
  SFM: 'Consumer',
  SHCO: 'Consumer',
  SHOP: 'Technology',
  SNAP: 'Communication',
  SNOW: 'Technology',
  SAP: 'Technology',
  SOLV: 'Healthcare',
  SGI: 'Consumer',
  SOFI: 'Financial',
  SPOT: 'Communication',
  SQ: 'Financial',
  STX: 'Technology',
  STRL: 'Industrial',
  SW: 'Industrial',
  TER: 'Technology',
  TDOC: 'Healthcare',
  TECK: 'Materials',
  TEM: 'Technology',
  SLM: 'Financial',
  TOST: 'Technology',
  TRMB: 'Industrial',
  TTD: 'Communication',
  TWST: 'Healthcare',
  TWST: 'Healthcare',
  TX: 'Materials',
  TXG: 'Healthcare',
  UTHR: 'Healthcare',
  UBER: 'Technology',
  UGI: 'Energy',
  VCYT: 'Healthcare',
  VEL: 'Financial',
  VRSN: 'Technology',
  VRT: 'Industrial',
  W: 'Consumer',
  BWXT: 'Industrial',
  WEC: 'Energy',
  WEN: 'Consumer',
  XP: 'Financial',
  YMM: 'Technology',
  ALLY: 'Financial',
  APH: 'Technology',
  ARMK: 'Consumer',
  AUR: 'Technology',
  BGC: 'Financial',
  BHF: 'Financial',
  BTI: 'Consumer',
  CASY: 'Consumer',
  COOP: 'Financial',
  CORZ: 'Technology',
  CPNG: 'Consumer',
  CRBG: 'Financial',
  CRS: 'Industrial',
  CYH: 'Healthcare',
  DPZ: 'Consumer',
  EWY: 'ETF',
  FIGR: 'Financial',
  FIX: 'Industrial',
  FLYX: 'Industrial',
  FND: 'Consumer',
  GFL: 'Industrial',
  GWRE: 'Technology',
  HIG: 'Financial',
  HRI: 'Industrial',
  IDA: 'Energy',
  IPG: 'Communication',
  IXUS: 'ETF',
  KDK: 'Technology',
  KOF: 'Consumer',
  LPLA: 'Financial',
  LYV: 'Communication',
  LYEL: 'Healthcare',
  MAZE: 'Healthcare',
  MBB: 'ETF',
  MTZ: 'Industrial',
  NRP: 'Energy',
  PONY: 'Technology',
  PRMB: 'Consumer',
  RIVN: 'Consumer',
  RKT: 'Financial',
  RPD: 'Technology',
  RSP: 'ETF',
  RUN: 'Energy',
  SDGR: 'Healthcare',
  SGU: 'Energy',
  SNOW: 'Technology',
  SRTA: 'Healthcare',
  TDS: 'Communication',
  TLN: 'Energy',
  VAC: 'Consumer',
  WCN: 'Industrial',
  WST: 'Healthcare',
  AMRZ: 'Financial',
  FLUT: 'Consumer',
  MRUS: 'Healthcare',
  ONON: 'Consumer',
  SN: 'Consumer'
};

const GICS_TO_SECTOR = {
  'COMMUNICATION SERVICES': 'Communication',
  'CONSUMER DISCRETIONARY': 'Consumer',
  'CONSUMER STAPLES': 'Consumer',
  'ENERGY': 'Energy',
  'FINANCIALS': 'Financial',
  'HEALTH CARE': 'Healthcare',
  'INDUSTRIALS': 'Industrial',
  'INFORMATION TECHNOLOGY': 'Technology',
  'MATERIALS': 'Materials',
  'REAL ESTATE': 'Financial',
  'UTILITIES': 'Energy'
};

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

function normalizeCompanyName(value) {
  if (!value) return '';
  let text = normalizeText(value).toUpperCase();
  text = text.replace(/&/g, ' AND ');
  text = text.replace(/\b(CLASS|CL)\s+[A-Z0-9]+\b/g, ' ');
  text = text.replace(/[^A-Z0-9 ]+/g, ' ');
  const suffixes = new Set([
    'INC',
    'INCORPORATED',
    'CORP',
    'CORPORATION',
    'CO',
    'COMPANY',
    'LTD',
    'LIMITED',
    'PLC',
    'HOLDING',
    'HOLDINGS',
    'GROUP',
    'SA',
    'NV',
    'AG',
    'SE',
    'THE',
    'ORDINARY',
    'SHS',
    'SHARES',
    'COMMON'
  ]);
  const tokens = text.split(/\s+/).filter(Boolean);
  const filtered = tokens.filter((token) => !suffixes.has(token));
  return filtered.join(' ');
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      const next = line[i + 1];
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      values.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  values.push(current);
  return values.map((value) => value.trim());
}

function parseCsv(text) {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const rows = [];
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    rows.push(parseCsvLine(line));
  }
  return rows;
}

function mapGicsSector(value) {
  if (!value) return '';
  const key = normalizeText(value).toUpperCase();
  return GICS_TO_SECTOR[key] || '';
}

async function fetchOnlineTickerMap() {
  try {
    const res = await fetch(ONLINE_TICKER_MAP_URL);
    if (!res.ok) {
      throw new Error(`Online ticker map failed: ${res.status} ${res.statusText}`);
    }
    const text = await res.text();
    const rows = parseCsv(text);
    if (!rows.length) return { nameToTicker: {}, sectorByTicker: {} };

    const header = rows[0].map((value) => value.toUpperCase());
    const symbolIndex = header.findIndex((col) => col === 'SYMBOL');
    const nameIndex = header.findIndex((col) => col.includes('SECURITY') || col.includes('COMPANY'));
    const sectorIndex = header.findIndex((col) => col.includes('GICS SECTOR'));

    const nameToTicker = {};
    const sectorByTicker = {};

    for (let i = 1; i < rows.length; i += 1) {
      const row = rows[i];
      const symbol = row[symbolIndex] ? row[symbolIndex].trim().toUpperCase() : '';
      const company = row[nameIndex] ? row[nameIndex].trim() : '';
      if (!symbol || !company) continue;
      const normalizedName = normalizeCompanyName(company);
      if (normalizedName) {
        nameToTicker[normalizedName] = symbol;
      }
      if (sectorIndex >= 0) {
        const mappedSector = mapGicsSector(row[sectorIndex] || '');
        if (mappedSector) {
          sectorByTicker[symbol] = mappedSector;
        }
      }
    }

    return { nameToTicker, sectorByTicker };
  } catch (err) {
    console.warn(String(err.message || err));
    return { nameToTicker: {}, sectorByTicker: {} };
  }
}

const FALLBACK_TICKER_GUESSES = [
  { pattern: /APPLE/, ticker: 'AAPL' },
  { pattern: /MICROSOFT/, ticker: 'MSFT' },
  { pattern: /AMAZON/, ticker: 'AMZN' },
  { pattern: /ALPHABET|GOOGLE/, ticker: 'GOOGL' },
  { pattern: /META|FACEBOOK/, ticker: 'META' },
  { pattern: /NVIDIA/, ticker: 'NVDA' },
  { pattern: /TESLA/, ticker: 'TSLA' },
  { pattern: /BERKSHIRE/, ticker: 'BRK.B' },
  { pattern: /JPMORGAN/, ticker: 'JPM' },
  { pattern: /JOHNSON\s*&\s*JOHNSON|JOHNSON AND JOHNSON/, ticker: 'JNJ' }
];

function guessTickerByName(name) {
  const key = normalizeCompanyName(name);
  if (!key) return '';
  for (const guess of FALLBACK_TICKER_GUESSES) {
    if (guess.pattern.test(key)) return guess.ticker;
  }
  return '';
}

function matchOnlineTickerByName(name, onlineLookup) {
  const key = normalizeCompanyName(name);
  if (!key) return '';
  return onlineLookup?.nameToTicker?.[key] || '';
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

function stripTags(text) {
  return String(text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractInfoTableXmlFromText(text) {
  const match = text.match(/<informationTable[\s\S]*?<\/informationTable>/i);
  if (match) return match[0];
  return null;
}

function extractDocumentsFromText(text) {
  const docs = [];
  const re = /<DOCUMENT>([\s\S]*?)<\/DOCUMENT>/gi;
  let m;
  while ((m = re.exec(text))) {
    docs.push(m[1]);
  }
  return docs.length ? docs : [text];
}

function parseSgmlInfoTable(doc) {
  const tableMatch = doc.match(/<TABLE>[\s\S]*?<\/TABLE>/i);
  if (!tableMatch) return [];
  const table = tableMatch[0];
  const rows = table.split(/<S>/i);
  const entries = [];

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (/NAME OF ISSUER/i.test(row)) continue;
    if (!row.includes('<C>') && !row.includes('<c>')) continue;

    const rawCells = row.split(/<C>/i);
    const cells = rawCells.map(stripTags).filter(Boolean);
    if (cells.length < 3) continue;

    const cusipIndex = cells.findIndex((cell) => /^[0-9A-Z]{9}$/.test(cell.replace(/\s+/g, '')));
    if (cusipIndex === -1) continue;

    const name = cells[0];
    const cusip = cells[cusipIndex].replace(/\s+/g, '');

    let value = null;
    for (let j = cusipIndex + 1; j < cells.length; j += 1) {
      const digits = cells[j].replace(/[^0-9]/g, '');
      if (digits) {
        value = Number(digits);
        break;
      }
    }

    if (!name || !cusip || !Number.isFinite(value) || value <= 0) continue;
    entries.push({ nameOfIssuer: name, cusip, value });
  }

  return entries;
}

function extractInfoTableEntriesFromText(text) {
  const docs = extractDocumentsFromText(text);

  const preferredDocs = docs.filter((doc) =>
    /<TYPE>\s*INFORMATION TABLE/i.test(doc) || /<TYPE>\s*13F/i.test(doc)
  );
  const candidates = preferredDocs.length ? preferredDocs : docs;

  for (const doc of candidates) {
    const xmlSnippet = extractInfoTableXmlFromText(doc);
    if (xmlSnippet) {
      try {
        const parsed = parser.parse(xmlSnippet);
        const entries = extractInfoTableEntries(parsed);
        if (entries.length) return entries;
      } catch (err) {
        // fall through to SGML parsing
      }
    }

    const sgmlEntries = parseSgmlInfoTable(doc);
    if (sgmlEntries.length) return sgmlEntries;
  }

  return [];
}

function buildTickerLookup(tickerMap) {
  const cusipMap = {};
  const patterns = [];

  for (const [rawKey, ticker] of Object.entries(tickerMap || {})) {
    const normalizedKey = normalizeText(rawKey).toUpperCase();
    if (!normalizedKey) continue;
    const cusipKey = normalizedKey.replace(/[^0-9A-Z]/g, '');
    const looksLikeCusip = cusipKey.length > 0 && cusipKey.length <= 9 && /\d/.test(cusipKey);
    if (looksLikeCusip) {
      const paddedCusip = cusipKey.padStart(9, '0');
      cusipMap[cusipKey] = ticker;
      cusipMap[paddedCusip] = ticker;
    } else {
      patterns.push({ key: normalizedKey, ticker, len: normalizedKey.length });
    }
  }

  patterns.sort((a, b) => b.len - a.len);
  return { cusipMap, patterns };
}

function matchTickerByName(name, title, lookup) {
  if (!lookup?.patterns?.length) return '';
  const nameKey = normalizeText(name).toUpperCase();
  const titleKey = normalizeText(title).toUpperCase();

  for (const pattern of lookup.patterns) {
    if (nameKey.includes(pattern.key) || titleKey.includes(pattern.key)) {
      return pattern.ticker;
    }
  }

  return '';
}

function buildHoldings(entries, lookup, onlineLookup) {
  const cleaned = entries
    .map((entry) => {
      const name = normalizeText(entry.nameOfIssuer);
      const cusip = normalizeText(entry.cusip);
      const cusipKey = cusip.replace(/[^0-9A-Z]/gi, '').toUpperCase();
      const paddedCusip = cusipKey.length < 9 ? cusipKey.padStart(9, '0') : cusipKey;
      const title = normalizeText(entry.titleOfClass);
      const rawTicker = normalizeText(
        entry.ticker || entry.tickerOrSymbol || entry.tickerSymbol || entry.symbol
      );
      const normalizedRawTicker = rawTicker.toUpperCase();
      const sanitizedRawTicker = normalizedRawTicker.replace(/[^0-9A-Z]/g, '');
      const looksLikeCusip =
        sanitizedRawTicker.length >= 1 &&
        sanitizedRawTicker.length <= 9 &&
        /\d/.test(sanitizedRawTicker);
      const safeRawTicker = looksLikeCusip ? '' : normalizedRawTicker;
      const value = Number(entry.value || 0);
      const putCall = normalizeText(entry.putCall).toUpperCase();
      if (!name || !cusip || !Number.isFinite(value) || value <= 0) return null;
      if (putCall === 'PUT' || putCall === 'CALL') return null;
      const mappedTicker =
        safeRawTicker ||
        lookup?.cusipMap?.[cusipKey] ||
        lookup?.cusipMap?.[paddedCusip] ||
        matchTickerByName(name, title, lookup);
      const onlineTicker = mappedTicker ? '' : matchOnlineTickerByName(name, onlineLookup);
      const guessedTicker = mappedTicker || onlineTicker ? '' : guessTickerByName(name);
      const finalTicker = mappedTicker || onlineTicker || guessedTicker;
      const sector =
        (finalTicker && onlineLookup?.sectorByTicker?.[finalTicker]) ||
        (finalTicker ? SECTOR_BY_TICKER[finalTicker] || '' : '');
      return {
        name,
        cusip,
        value,
        ticker: finalTicker || cusip,
        sector: sector || undefined
      };
    })
    .filter(Boolean);

  const totalValue = cleaned.reduce((sum, item) => sum + item.value, 0);
  const holdings = cleaned
    .map((item) => ({
      ticker: item.ticker,
      name: item.name,
      sector: item.sector,
      percent: totalValue > 0 ? Number(((item.value / totalValue) * 100).toFixed(1)) : 0
    }))
    .sort((a, b) => b.percent - a.percent)
    .slice(0, MAX_HOLDINGS);

  return holdings;
}

async function fetch13fHoldings({ name, cik }, tickerLookup, onlineLookup) {
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
  let entries = [];

  if (infoFilename) {
    const infoUrl = `${ARCHIVES_BASE}/${archiveCik}/${accessionNoNoDashes}/${infoFilename}`;
    const xmlText = await fetchSec(infoUrl, 'text');
    try {
      const parsed = parser.parse(xmlText);
      entries = extractInfoTableEntries(parsed);
    } catch (err) {
      entries = [];
    }
  }

  if (!entries.length) {
    const textFiles = (items || [])
      .filter((item) => item.name?.toLowerCase().endsWith('.txt'))
      .filter((item) => !/index-headers|index\.html|index\.json|index/i.test(item.name))
      .sort((a, b) => Number(b.size || 0) - Number(a.size || 0));

    for (const file of textFiles) {
      const textUrl = `${ARCHIVES_BASE}/${archiveCik}/${accessionNoNoDashes}/${file.name}`;
      const text = await fetchSec(textUrl, 'text');
      entries = extractInfoTableEntriesFromText(text);
      if (entries.length) break;
    }
  }

  if (!entries.length) {
    throw new Error(`No holdings parsed for ${name} (${cik}) ${latest.accessionNumber}`);
  }

  const holdings = buildHoldings(entries, tickerLookup, onlineLookup);
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
  const tickerLookup = buildTickerLookup(tickerMap);
  const onlineLookup = await fetchOnlineTickerMap();
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
      const dynamicFund = await fetch13fHoldings(fund, tickerLookup, onlineLookup);
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

  // Rotate: save current as previous before overwriting
  try {
    await fs.access(OUTPUT_PATH);
    await fs.copyFile(OUTPUT_PATH, PREV_OUTPUT_PATH);
    console.log(`Rotated previous data to ${PREV_OUTPUT_PATH}`);
  } catch {
    // No existing data to rotate
  }

  await fs.writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2));
  await fs.writeFile(META_PATH, JSON.stringify(meta, null, 2));

  console.log(`Wrote ${output.length} funds to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
