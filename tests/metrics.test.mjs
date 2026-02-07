/**
 * Performance Metrics Unit Tests
 *
 * Tests for TotalReturn, MaxDrawdown, Volatility, Sharpe, and edge cases.
 * Run with: node --test tests/metrics.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Re-implement metrics functions (same logic as in index.html) ──

const TRADING_DAYS_PER_YEAR = 252;

function computeMetrics(priceSeries) {
  if (!priceSeries || priceSeries.length < 2) return null;

  const valid = priceSeries
    .filter(p => p && p.date && typeof p.price === 'number' && p.price > 0)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  if (valid.length < 2) return null;

  const firstDate = new Date(valid[0].date);
  const lastDate = new Date(valid[valid.length - 1].date);
  const firstPrice = valid[0].price;
  const lastPrice = valid[valid.length - 1].price;

  const dailyReturns = [];
  for (let i = 1; i < valid.length; i++) {
    const ret = (valid[i].price - valid[i - 1].price) / valid[i - 1].price;
    dailyReturns.push(ret);
  }

  function findAsOfPoint(series, targetDate) {
    const target = new Date(targetDate).getTime();
    let best = null;
    for (const p of series) {
      const d = new Date(p.date).getTime();
      if (d <= target) {
        if (!best || d > new Date(best.date).getTime()) best = p;
      }
    }
    return best;
  }

  function totalReturnSince(startDate) {
    const startPoint = findAsOfPoint(valid, startDate);
    if (!startPoint) return null;
    return (lastPrice - startPoint.price) / startPoint.price;
  }

  const now = lastDate;
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();

  const totalReturn = {
    '1M': totalReturnSince(new Date(y, m - 1, d)),
    '3M': totalReturnSince(new Date(y, m - 3, d)),
    '6M': totalReturnSince(new Date(y, m - 6, d)),
    '1Y': totalReturnSince(new Date(y - 1, m, d)),
    'YTD': totalReturnSince(new Date(y, 0, 1)),
    'MAX': (lastPrice - firstPrice) / firstPrice
  };

  const totalDays = (lastDate - firstDate) / (1000 * 60 * 60 * 24);
  const totalYears = totalDays / 365.25;
  const annualizedReturn = totalYears >= 1
    ? Math.pow(lastPrice / firstPrice, 1 / totalYears) - 1
    : null;

  let volatility = null;
  if (dailyReturns.length >= 5) {
    const mean = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length;
    const variance = dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (dailyReturns.length - 1);
    volatility = Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR);
  }

  let maxDrawdown = 0;
  let peak = valid[0].price;
  for (const p of valid) {
    if (p.price > peak) peak = p.price;
    const dd = (p.price - peak) / peak;
    if (dd < maxDrawdown) maxDrawdown = dd;
  }

  let sharpe = null;
  if (annualizedReturn !== null && volatility !== null && volatility > 0) {
    sharpe = annualizedReturn / volatility;
  }

  return {
    totalReturn,
    annualizedReturn,
    volatility,
    maxDrawdown,
    sharpe,
    firstDate: valid[0].date,
    lastDate: valid[valid.length - 1].date,
    dataPoints: valid.length
  };
}

function parseStooqCsv(csvText) {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return [];
  const header = lines[0].toLowerCase();
  if (!header.includes('date') || !header.includes('close')) return [];
  const cols = lines[0].split(',').map(c => c.trim().toLowerCase());
  const dateIdx = cols.indexOf('date');
  const closeIdx = cols.indexOf('close');
  if (dateIdx < 0 || closeIdx < 0) return [];

  const series = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length <= Math.max(dateIdx, closeIdx)) continue;
    const date = parts[dateIdx].trim();
    const price = parseFloat(parts[closeIdx].trim());
    if (!date || isNaN(price) || price <= 0) continue;
    series.push({ date, price });
  }
  return series.sort((a, b) => new Date(a.date) - new Date(b.date));
}

// ── Test Data ──

function generateDailySeries(startDate, days, startPrice, dailyReturn) {
  const series = [];
  let price = startPrice;
  const d = new Date(startDate);
  for (let i = 0; i < days; i++) {
    series.push({
      date: d.toISOString().split('T')[0],
      price: Number(price.toFixed(4))
    });
    price *= (1 + dailyReturn);
    d.setDate(d.getDate() + 1);
    // Skip weekends
    if (d.getDay() === 0) d.setDate(d.getDate() + 1);
    if (d.getDay() === 6) d.setDate(d.getDate() + 2);
  }
  return series;
}

// ── Tests ──

describe('computeMetrics', () => {
  it('returns null for empty series', () => {
    assert.equal(computeMetrics([]), null);
    assert.equal(computeMetrics(null), null);
    assert.equal(computeMetrics(undefined), null);
  });

  it('returns null for series with < 2 valid points', () => {
    assert.equal(computeMetrics([{ date: '2024-01-01', price: 100 }]), null);
  });

  it('returns null for series with invalid prices', () => {
    assert.equal(computeMetrics([
      { date: '2024-01-01', price: -10 },
      { date: '2024-01-02', price: 0 },
    ]), null);
  });

  it('calculates MAX total return correctly', () => {
    const series = [
      { date: '2024-01-01', price: 100 },
      { date: '2024-06-01', price: 120 },
      { date: '2025-01-01', price: 150 },
    ];
    const m = computeMetrics(series);
    assert.ok(m);
    assert.equal(m.totalReturn['MAX'], 0.5); // 50%
  });

  it('calculates max drawdown correctly', () => {
    const series = [
      { date: '2024-01-01', price: 100 },
      { date: '2024-02-01', price: 120 },
      { date: '2024-03-01', price: 90 },  // 25% drawdown from peak 120
      { date: '2024-04-01', price: 110 },
    ];
    const m = computeMetrics(series);
    assert.ok(m);
    assert.ok(Math.abs(m.maxDrawdown - (-0.25)) < 0.001, `Expected -0.25, got ${m.maxDrawdown}`);
  });

  it('calculates zero drawdown for monotonically increasing', () => {
    const series = [
      { date: '2024-01-01', price: 100 },
      { date: '2024-02-01', price: 110 },
      { date: '2024-03-01', price: 120 },
      { date: '2024-04-01', price: 130 },
    ];
    const m = computeMetrics(series);
    assert.ok(m);
    assert.equal(m.maxDrawdown, 0);
  });

  it('calculates volatility for sufficient data', () => {
    const series = generateDailySeries('2024-01-01', 30, 100, 0.001);
    const m = computeMetrics(series);
    assert.ok(m);
    assert.ok(m.volatility !== null);
    assert.ok(m.volatility >= 0);
    // Low daily return => low vol
    assert.ok(m.volatility < 0.1, `Expected low vol, got ${m.volatility}`);
  });

  it('returns null volatility for < 5 data points', () => {
    const series = [
      { date: '2024-01-01', price: 100 },
      { date: '2024-01-02', price: 101 },
      { date: '2024-01-03', price: 102 },
    ];
    const m = computeMetrics(series);
    assert.ok(m);
    assert.equal(m.volatility, null);
  });

  it('calculates annualized return for > 1 year', () => {
    const series = [
      { date: '2023-01-01', price: 100 },
      { date: '2023-06-01', price: 110 },
      { date: '2024-01-01', price: 120 },
      { date: '2024-06-01', price: 130 },
      { date: '2025-01-01', price: 121 }, // 21% over 2 years
    ];
    const m = computeMetrics(series);
    assert.ok(m);
    assert.ok(m.annualizedReturn !== null);
    // ~10% annualized
    assert.ok(Math.abs(m.annualizedReturn - 0.10) < 0.02, `Got ${m.annualizedReturn}`);
  });

  it('returns null annualized return for < 1 year', () => {
    const series = [
      { date: '2024-06-01', price: 100 },
      { date: '2024-09-01', price: 110 },
    ];
    const m = computeMetrics(series);
    assert.ok(m);
    assert.equal(m.annualizedReturn, null);
  });

  it('calculates sharpe ratio (rf=0)', () => {
    const series = generateDailySeries('2023-01-01', 400, 100, 0.0004);
    const m = computeMetrics(series);
    assert.ok(m);
    assert.ok(m.sharpe !== null);
    assert.ok(m.sharpe > 0, `Sharpe should be positive for uptrending, got ${m.sharpe}`);
  });

  it('excludes invalid prices (0, negative, NaN)', () => {
    const series = [
      { date: '2024-01-01', price: 100 },
      { date: '2024-01-02', price: 0 },
      { date: '2024-01-03', price: -10 },
      { date: '2024-01-04', price: NaN },
      { date: '2024-01-05', price: 110 },
      { date: '2024-01-06', price: 115 },
      { date: '2024-01-07', price: 120 },
      { date: '2024-01-08', price: 125 },
      { date: '2024-01-09', price: 130 },
    ];
    const m = computeMetrics(series);
    assert.ok(m);
    assert.equal(m.dataPoints, 6); // only valid points
    assert.equal(m.totalReturn['MAX'], 0.3); // 100 -> 130
  });

  it('handles unsorted input correctly', () => {
    const series = [
      { date: '2024-06-01', price: 130 },
      { date: '2024-01-01', price: 100 },
      { date: '2024-03-01', price: 115 },
    ];
    const m = computeMetrics(series);
    assert.ok(m);
    assert.equal(m.totalReturn['MAX'], 0.3); // 100 -> 130
  });
});

describe('parseStooqCsv', () => {
  it('parses valid CSV', () => {
    const csv = `Date,Open,High,Low,Close,Volume
2024-01-02,100.0,102.0,99.0,101.0,1000000
2024-01-03,101.0,103.0,100.0,102.5,1200000`;
    const series = parseStooqCsv(csv);
    assert.equal(series.length, 2);
    assert.equal(series[0].date, '2024-01-02');
    assert.equal(series[0].price, 101.0);
    assert.equal(series[1].price, 102.5);
  });

  it('returns empty for invalid CSV', () => {
    assert.deepEqual(parseStooqCsv(''), []);
    assert.deepEqual(parseStooqCsv('just one line'), []);
    assert.deepEqual(parseStooqCsv('No,Header,Here\n1,2,3'), []);
  });

  it('skips rows with invalid prices', () => {
    const csv = `Date,Close
2024-01-01,100
2024-01-02,abc
2024-01-03,0
2024-01-04,-5
2024-01-05,110`;
    const series = parseStooqCsv(csv);
    assert.equal(series.length, 2);
    assert.equal(series[0].price, 100);
    assert.equal(series[1].price, 110);
  });
});

describe('edge cases', () => {
  it('MDD is 0 for constant price', () => {
    const series = [
      { date: '2024-01-01', price: 100 },
      { date: '2024-01-02', price: 100 },
      { date: '2024-01-03', price: 100 },
      { date: '2024-01-04', price: 100 },
      { date: '2024-01-05', price: 100 },
      { date: '2024-01-06', price: 100 },
    ];
    const m = computeMetrics(series);
    assert.ok(m);
    assert.equal(m.maxDrawdown, 0);
    assert.equal(m.totalReturn['MAX'], 0);
  });

  it('handles single-day gap correctly', () => {
    const series = [
      { date: '2024-01-01', price: 100 },
      { date: '2024-01-03', price: 105 }, // gap on 01-02
    ];
    const m = computeMetrics(series);
    assert.ok(m);
    assert.equal(m.totalReturn['MAX'], 0.05);
  });
});
