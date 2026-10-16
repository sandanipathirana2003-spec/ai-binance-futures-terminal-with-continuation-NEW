// Trend-continuation engine. PURE: takes closed 1m candles + settings, replays history bar by bar
// (each step only sees data up to that bar's close => no repainting / lookahead) and returns every
// event. Deterministic ids make duplicate alerts impossible.
import type { Candle } from '../binance'

export type Side = 'LONG' | 'SHORT'
export type TF = '1m' | '3m' | '5m'
export type MainSource = '3m' | '5m' | 'both'
export interface Filters { ema99: boolean; ribbon: boolean; adx: boolean; volume: boolean }
export interface Settings {
  emaFast: number; emaMid: number; emaSlow: number
  stAtr: number; stMult: number
  vLen: number; vMom: number; vBand: number
  mainSource: MainSource
  adxLen: number; adxThr: number
  volPeriod: number; expiryMin: number; maCrossBars: number
  quality: Filters     // shown / graded
  mandatory: Filters   // must pass before entry
  holdBars: number; feePct: number; slipPct: number // backtest only
}
export const DEFAULTS: Settings = {
  emaFast: 7, emaMid: 25, emaSlow: 99, stAtr: 12, stMult: 4,
  vLen: 14, vMom: 9, vBand: 1.5, mainSource: '5m', adxLen: 14, adxThr: 22,
  volPeriod: 20, expiryMin: 9, maCrossBars: 5,
  quality: { ema99: true, ribbon: true, adx: true, volume: true },
  mandatory: { ema99: false, ribbon: false, adx: false, volume: false },
  holdBars: 15, feePct: 0.04, slipPct: 0.02,
}
const MS: Record<TF, number> = { '1m': 60_000, '3m': 180_000, '5m': 300_000 }
const nan = Number.NaN

/** Aggregate closed 1m candles into n-minute candles aligned to exchange time. Incomplete buckets are dropped. */
export function aggregate(c1: Candle[], n: number): Candle[] {
  const ms = n * 60_000, out: Candle[] = []
  let i = 0
  while (i < c1.length) {
    const b = Math.floor(c1[i].openTime / ms) * ms
    let j = i
    while (j < c1.length && c1[j].openTime < b + ms) j++
    const ch = c1.slice(i, j)
    if (ch.length === n && ch[0].openTime === b)
      out.push({
        openTime: b, open: ch[0].open, close: ch[n - 1].close,
        high: Math.max(...ch.map((x) => x.high)), low: Math.min(...ch.map((x) => x.low)),
        volume: ch.reduce((s, x) => s + x.volume, 0),
      })
    i = j
  }
  return out
}

function ema(v: number[], p: number): number[] {
  const out = v.map(() => nan), k = 2 / (p + 1)
  if (v.length < p) return out
  let e = v.slice(0, p).reduce((a, b) => a + b, 0) / p
  out[p - 1] = e
  for (let i = p; i < v.length; i++) out[i] = e = v[i] * k + e * (1 - k)
  return out
}
function sma(v: number[], p: number): number[] {
  const out = v.map(() => nan)
  for (let i = p - 1; i < v.length; i++) {
    let s = 0, ok = true
    for (let j = i - p + 1; j <= i; j++) { if (Number.isNaN(v[j])) { ok = false; break } s += v[j] }
    if (ok) out[i] = s / p
  }
  return out
}
function tr(c: Candle[]): number[] {
  return c.map((x, i) => i === 0 ? x.high - x.low
    : Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close)))
}
/** Wilder RMA of a series, seeded with SMA (same as TradingView ta.rma / ta.atr). */
function rma(v: number[], p: number, start = 0): number[] {
  const out = v.map(() => nan)
  if (v.length < start + p) return out
  let r = 0
  for (let i = start; i < start + p; i++) r += v[i]
  r /= p; out[start + p - 1] = r
  for (let i = start + p; i < v.length; i++) out[i] = r = (r * (p - 1) + v[i]) / p
  return out
}
const atr = (c: Candle[], p: number) => rma(tr(c), p)

/** Classic ATR Supertrend. dir: 1 bullish, -1 bearish, 0 not yet defined. */
function supertrend(c: Candle[], period: number, mult: number) {
  const a = atr(c, period), dir: number[] = [], line: number[] = []
  let up = nan, dn = nan, d = 0
  for (let i = 0; i < c.length; i++) {
    if (Number.isNaN(a[i])) { dir.push(0); line.push(nan); continue }
    const hl2 = (c[i].high + c[i].low) / 2, bu = hl2 - mult * a[i], bd = hl2 + mult * a[i]
    if (d === 0) { up = bu; dn = bd; d = 1 }
    else {
      const pu = up, pd = dn
      up = c[i - 1].close > pu ? Math.max(bu, pu) : bu
      dn = c[i - 1].close < pd ? Math.min(bd, pd) : bd
      if (d === -1 && c[i].close > pd) d = 1
      else if (d === 1 && c[i].close < pu) d = -1
    }
    dir.push(d); line.push(d === 1 ? up : dn)
  }
  return { dir, line }
}

function adxCalc(c: Candle[], len: number) {
  const n = c.length, pdi = Array(n).fill(nan), mdi = Array(n).fill(nan), adx = Array(n).fill(nan)
  if (n < len * 2 + 1) return { pdi, mdi, adx }
  const t = tr(c), pdm = [0], mdm = [0]
  for (let i = 1; i < n; i++) {
    const u = c[i].high - c[i - 1].high, d = c[i - 1].low - c[i].low
    pdm.push(u > d && u > 0 ? u : 0); mdm.push(d > u && d > 0 ? d : 0)
  }
  let st = 0, sp = 0, sm = 0
  for (let i = 1; i <= len; i++) { st += t[i]; sp += pdm[i]; sm += mdm[i] }
  const dx: number[] = []
  for (let i = len; i < n; i++) {
    if (i > len) { st = st - st / len + t[i]; sp = sp - sp / len + pdm[i]; sm = sm - sm / len + mdm[i] }
    pdi[i] = (100 * sp) / st; mdi[i] = (100 * sm) / st
    dx.push(pdi[i] + mdi[i] === 0 ? 0 : (100 * Math.abs(pdi[i] - mdi[i])) / (pdi[i] + mdi[i]))
    if (dx.length === len) adx[i] = dx.reduce((a, b) => a + b, 0) / len
    else if (dx.length > len) adx[i] = (adx[i - 1] * (len - 1) + dx[dx.length - 1]) / len
  }
  return { pdi, mdi, adx }
}

/**
 * Volumatic VIDYA — OWN RE-IMPLEMENTATION of the published formula (CMO-weighted VIDYA, SMA(15) smoothed,
 * ATR(200) bands, trend flips when close breaks the opposite band). It is NOT a copy of the TradingView
 * source and has not been verified against it; the "volumatic" volume histogram is not part of this output.
 */
function vidya(c: Candle[], len: number, mom: number, bandMult: number) {
  const n = c.length, src = c.map((x) => x.close), pos: number[] = [], neg: number[] = []
  for (let i = 0; i < n; i++) {
    const m = i >= mom ? src[i] - src[i - mom] : nan
    pos.push(Number.isNaN(m) ? nan : m >= 0 ? m : 0); neg.push(Number.isNaN(m) ? nan : m < 0 ? -m : 0)
  }
  const sp = sma(pos, mom).map((x) => x * mom), sn = sma(neg, mom).map((x) => x * mom)
  const alpha = 2 / (len + 1), raw: number[] = []
  let prev = nan
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(sp[i])) { raw.push(nan); continue }
    const cmo = sp[i] + sn[i] === 0 ? 0 : Math.abs((100 * (sp[i] - sn[i])) / (sp[i] + sn[i]))
    const k = (alpha * cmo) / 100
    prev = Number.isNaN(prev) ? src[i] : k * src[i] + (1 - k) * prev
    raw.push(prev)
  }
  const line = sma(raw, 15), a = atr(c, Math.min(200, Math.max(2, n - 1))), dir: number[] = []
  let d = 0
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(line[i]) || Number.isNaN(a[i])) { dir.push(0); continue }
    if (src[i] > line[i] + a[i] * bandMult) d = 1
    else if (src[i] < line[i] - a[i] * bandMult) d = -1
    dir.push(d)
  }
  return { dir, line, atr: a }
}

interface TfData {
  tf: TF; c: Candle[]; st: ReturnType<typeof supertrend>
  e7: number[]; e25: number[]; e99: number[]; adx: ReturnType<typeof adxCalc>
  vid: ReturnType<typeof vidya>; volAvg: number[]
}
const closeT = (d: TfData, i: number) => d.c[i].openTime + MS[d.tf]
function build(tf: TF, c: Candle[], s: Settings): TfData {
  const cl = c.map((x) => x.close)
  const vol = sma(c.map((x) => x.volume), s.volPeriod)
  // volAvg[i] = average of the PRIOR volPeriod candles (excludes the candle being judged)
  return {
    tf, c, st: supertrend(c, s.stAtr, s.stMult),
    e7: ema(cl, s.emaFast), e25: ema(cl, s.emaMid), e99: ema(cl, s.emaSlow),
    adx: adxCalc(c, s.adxLen), vid: vidya(c, s.vLen, s.vMom, s.vBand),
    volAvg: vol.map((_, i) => (i > 0 ? vol[i - 1] : nan)),
  }
}
/** index of the last candle of d that had CLOSED at or before time T (-1 if none) */
function idxAt(d: TfData, T: number): number {
  let lo = 0, hi = d.c.length - 1, r = -1
  while (lo <= hi) { const m = (lo + hi) >> 1; if (closeT(d, m) <= T) { r = m; lo = m + 1 } else hi = m - 1 }
  return r
}
function flips(d: TfData) {
  const out: { tf: TF; dir: 1 | -1; closeTime: number; i: number }[] = []
  for (let i = 1; i < d.c.length; i++) {
    const a = d.st.dir[i - 1], b = d.st.dir[i]
    if (a !== 0 && b !== 0 && a !== b) out.push({ tf: d.tf, dir: b as 1 | -1, closeTime: closeT(d, i), i })
  }
  return out
}

export interface Check { label: string; pass: boolean; enabled: boolean; mandatory: boolean }
export type Grade = 'A' | 'B'
export interface Setup {
  id: string; side: Side; t1: number; price1: number; expiresAt: number
  status: 'WAITING' | 'CONFIRMED' | 'CANCELLED'
  reason?: string; endedAt?: number
  maOk: boolean; vidyaOk: boolean
  grade?: Grade; confirmTime?: number; price?: number; checks?: Check[]; mainAtConfirm?: string
}
export interface TfStatus {
  tf: TF; closeTime: number; price: number
  stDir: 'BULLISH' | 'BEARISH' | 'N/A'; stLine: number
  lastFlip: { dir: 'BULLISH' | 'BEARISH'; closeTime: number } | null
  ema99Slope: 'RISING' | 'FALLING' | 'FLAT'; vsEma99: 'ABOVE' | 'BELOW'
  ma: 'BULLISH' | 'BEARISH'; emaGapPct: number
  ribbon: 'EXPANDING' | 'CONTRACTING' | 'TANGLED'
  vidya: 'BULLISH' | 'BEARISH' | 'N/A'; vidyaNote: string
  adx: number; adxSlope: 'RISING' | 'FALLING'; pdi: number; mdi: number; adxStrong: boolean
  volRatio: number; volStatus: 'ABOVE AVERAGE' | 'WEAK' | 'NORMAL'
}
export interface Analysis {
  tfs: Record<TF, TfStatus | null>
  main: 'BULLISH' | 'BEARISH' | 'MIXED'
  setups: Setup[]; confirmed: Setup[]
  trendChanges: { id: string; tf: TF; dir: 'BULLISH' | 'BEARISH'; closeTime: number }[]
  warnings: string[]
}
const nm = (d: number) => (d === 1 ? 'BULLISH' : d === -1 ? 'BEARISH' : 'N/A') as 'BULLISH' | 'BEARISH' | 'N/A'

function status(d: TfData, flipsOf: ReturnType<typeof flips>, s: Settings): TfStatus | null {
  const i = d.c.length - 1
  if (i < 5 || d.st.dir[i] === 0) return null
  const lf = flipsOf[flipsOf.length - 1]
  const gap = (k: number) => Math.abs(d.e7[k] - d.e25[k])
  const slope = (d.e99[i] - d.e99[i - 5]) / d.e99[i] * 100
  const bull = d.e7[i] > d.e25[i] && d.e25[i] > d.e99[i], bear = d.e7[i] < d.e25[i] && d.e25[i] < d.e99[i]
  const g0 = gap(i), g3 = gap(i - 3)
  const vi = d.vid.dir[i], vSl = d.vid.line[i] - d.vid.line[i - 3]
  const flat = Math.abs(d.vid.line[i] - d.vid.line[i - 5]) < 0.1 * d.vid.atr[i]
  const unstable = d.vid.dir.slice(i - 5, i + 1).some((x) => x !== vi)
  const vr = d.volAvg[i] > 0 ? d.c[i].volume / d.volAvg[i] : nan
  return {
    tf: d.tf, closeTime: closeT(d, i), price: d.c[i].close,
    stDir: nm(d.st.dir[i]), stLine: d.st.line[i],
    lastFlip: lf ? { dir: nm(lf.dir) as 'BULLISH' | 'BEARISH', closeTime: lf.closeTime } : null,
    ema99Slope: Math.abs(slope) < 0.005 ? 'FLAT' : slope > 0 ? 'RISING' : 'FALLING',
    vsEma99: d.c[i].close > d.e99[i] ? 'ABOVE' : 'BELOW',
    ma: d.e7[i] > d.e25[i] ? 'BULLISH' : 'BEARISH', emaGapPct: ((d.e7[i] - d.e25[i]) / d.e25[i]) * 100,
    ribbon: !bull && !bear ? 'TANGLED' : g0 > g3 * 1.02 ? 'EXPANDING' : 'CONTRACTING',
    vidya: nm(vi),
    vidyaNote: vi === 0 ? 'insufficient data' : [vSl * vi > 0 ? 'momentum aligned' : 'momentum against', flat ? 'FLAT' : '', unstable ? 'UNSTABLE (recent change)' : ''].filter(Boolean).join(' · '),
    adx: d.adx.adx[i], adxSlope: d.adx.adx[i] >= d.adx.adx[i - 1] ? 'RISING' : 'FALLING',
    pdi: d.adx.pdi[i], mdi: d.adx.mdi[i], adxStrong: d.adx.adx[i] >= s.adxThr,
    volRatio: vr, volStatus: Number.isNaN(vr) ? 'NORMAL' : vr >= 1.2 ? 'ABOVE AVERAGE' : vr < 0.7 ? 'WEAK' : 'NORMAL',
  }
}

export function analyze(symbol: string, c1: Candle[], s: Settings): Analysis {
  const warnings: string[] = []
  // use only the contiguous tail (no missing 1m candles) so aggregation and indicators are consistent
  let start = 0
  for (let i = 1; i < c1.length; i++) if (c1[i].openTime - c1[i - 1].openTime !== 60_000) start = i
  if (start > 0) warnings.push(`Missing 1m candle(s) detected — using only the ${c1.length - start} contiguous candles after the gap.`)
  const c = c1.slice(start)
  const empty: Analysis = { tfs: { '1m': null, '3m': null, '5m': null }, main: 'MIXED', setups: [], confirmed: [], trendChanges: [], warnings }
  if (c.length < 400) { warnings.push('Not enough contiguous history yet.'); return empty }

  const D1 = build('1m', c, s), D3 = build('3m', aggregate(c, 3), s), D5 = build('5m', aggregate(c, 5), s)
  const F1 = flips(D1), F3 = flips(D3), F5 = flips(D5)
  const dirAt = (d: TfData, T: number) => { const i = idxAt(d, T); return i < 0 ? 0 : d.st.dir[i] }
  const mainAt = (T: number): 0 | 1 | -1 => {
    const a = dirAt(D3, T), b = dirAt(D5, T)
    const v = s.mainSource === '3m' ? a : s.mainSource === '5m' ? b : a === b ? a : 0
    return v as 0 | 1 | -1
  }
  // Before the 3M flip, the 3M leg IS the pending confirmation, so only the 5M part of the rule can be checked.
  // At confirmation the FULL selected rule (3M / 5M / both) must agree with the trade.
  const mainPre = (T: number, n: number): boolean => (s.mainSource === '3m' ? true : dirAt(D5, T) === n)
  const f1 = new Map(F1.map((f) => [f.i, f])), f3 = new Map<number, typeof F3>()
  F3.forEach((f) => f3.set(f.closeTime, [...(f3.get(f.closeTime) ?? []), f]))

  const expiry = s.expiryMin * 60_000, setups: Setup[] = []
  const sideN = (x: Side) => (x === 'LONG' ? 1 : -1)
  const maCheck = (side: Side, i: number) => {
    const n = sideN(side)
    if ((D1.e7[i] - D1.e25[i]) * n <= 0) return false
    const rising = (D1.e7[i] - D1.e7[i - 1]) * n > 0
    let crossed = false
    for (let k = Math.max(1, i - s.maCrossBars + 1); k <= i; k++)
      if ((D1.e7[k] - D1.e25[k]) * n > 0 && (D1.e7[k - 1] - D1.e25[k - 1]) * n <= 0) crossed = true
    return crossed || rising
  }
  const vidCheck = (side: Side, i: number) => {
    const n = sideN(side)
    return D1.vid.dir[i] === n && (D1.vid.line[i] - D1.vid.line[i - 3]) * n > 0
  }
  const cancel = (p: Setup, T: number, reason: string) => { p.status = 'CANCELLED'; p.reason = reason; p.endedAt = T }

  for (let i = 120; i < c.length; i++) {
    const T = closeT(D1, i), live = setups.filter((p) => p.status === 'WAITING')
    // 1) invalidate pending setups
    for (const p of live) {
      const n = sideN(p.side), tag = p.side === 'LONG' ? 'bullish' : 'bearish'
      if (T - p.t1 > expiry) cancel(p, T, `Expired: no 3M ${tag} flip within ${s.expiryMin} min`)
      else if (f1.get(i) && f1.get(i)!.dir !== n) cancel(p, T, '1M Supertrend flipped back before 3M confirmation')
      else if (!mainPre(T, n)) cancel(p, T, `Selected main trend (${s.mainSource.toUpperCase()}) no longer ${tag}`)
      else {
        const ma = maCheck(p.side, i), vi = vidCheck(p.side, i)
        if (p.maOk && !ma) cancel(p, T, 'MA condition (EMA fast/mid) failed before confirmation')
        else if (p.vidyaOk && !vi) cancel(p, T, 'VIDYA support failed before confirmation')
        else { p.maOk ||= ma; p.vidyaOk ||= vi }
      }
    }
    // 2) 3M flips closing now confirm only setups opened STRICTLY earlier (never stale 3M flips)
    for (const f of f3.get(T) ?? []) {
      for (const p of setups.filter((x) => x.status === 'WAITING' && x.t1 < T && sideN(x.side) === f.dir)) {
        const ma = maCheck(p.side, i), vi = vidCheck(p.side, i), n = f.dir
        if (mainAt(T) !== n) { cancel(p, T, `At 3M flip: selected main trend (${s.mainSource.toUpperCase()}) does not agree`); continue }
        if (!ma) { cancel(p, T, 'At 3M flip: MA condition not satisfied'); continue }
        if (!vi) { cancel(p, T, 'At 3M flip: VIDYA does not support the trade'); continue }
        const j = idxAt(D3, T), k = i
        const q: Record<keyof Filters, boolean> = {
          ema99: (D1.c[k].close - D1.e99[k]) * n > 0,
          ribbon: Math.abs(D1.e7[k] - D1.e25[k]) > Math.abs(D1.e7[k - 3] - D1.e25[k - 3]) * 1.02,
          adx: D3.adx.adx[j] >= s.adxThr && D3.adx.adx[j] > D3.adx.adx[j - 1] && (D3.adx.pdi[j] - D3.adx.mdi[j]) * n > 0,
          volume: D3.c[j].volume > D3.volAvg[j],
        }
        const lbl: Record<keyof Filters, string> = { ema99: 'Price vs EMA99', ribbon: 'Ribbon expanding', adx: 'ADX rising ≥ threshold & DI aligned', volume: 'Volume above average' }
        const checks = (Object.keys(q) as (keyof Filters)[]).map((key) => ({ label: lbl[key], pass: q[key], enabled: s.quality[key], mandatory: s.mandatory[key] }))
        const failedMand = checks.find((x) => x.mandatory && !x.pass)
        if (failedMand) { cancel(p, T, `Mandatory filter failed: ${failedMand.label}`); continue }
        p.status = 'CONFIRMED'; p.confirmTime = T; p.price = D1.c[i].close; p.checks = checks; p.endedAt = T
        p.grade = checks.every((x) => !x.enabled || x.pass) ? 'A' : 'B'
        p.mainAtConfirm = nm(mainAt(T))
      }
    }
    // 3) new 1M flip -> new setup (or an explicit rejection record)
    const f = f1.get(i)
    if (f) {
      const side: Side = f.dir === 1 ? 'LONG' : 'SHORT', n = f.dir, tag = n === 1 ? 'bullish' : 'bearish'
      const p: Setup = { id: `${symbol}:${side}:${T}`, side, t1: T, price1: c[i].close, expiresAt: T + expiry, status: 'WAITING', maOk: maCheck(side, i), vidyaOk: vidCheck(side, i) }
      if (!mainPre(T, n)) cancel(p, T, `Rejected: selected main trend (${s.mainSource.toUpperCase()}) is not ${tag}`)
      else if (dirAt(D3, T) === n) cancel(p, T, `Rejected: 3M Supertrend already ${tag} — no 3M flip can follow this 1M flip`)
      setups.push(p)
    }
  }
  const nowT = closeT(D1, c.length - 1)
  const tfs = { '1m': status(D1, F1, s), '3m': status(D3, F3, s), '5m': status(D5, F5, s) }
  const m = mainAt(nowT)
  const trendChanges = [...F1, ...F3, ...F5].sort((a, b) => b.closeTime - a.closeTime).slice(0, 40)
    .map((x) => ({ id: `${symbol}:${x.tf}:${x.closeTime}`, tf: x.tf, dir: nm(x.dir) as 'BULLISH' | 'BEARISH', closeTime: x.closeTime }))
  return {
    tfs, main: m === 1 ? 'BULLISH' : m === -1 ? 'BEARISH' : 'MIXED', warnings, trendChanges,
    setups: setups.filter((p) => p.status !== 'CONFIRMED').reverse().slice(0, 40),
    confirmed: setups.filter((p) => p.status === 'CONFIRMED').reverse(),
  }
}

export interface BtResult { n: number; longs: number; shorts: number; winRate: number; avgRet: number; maxDD: number; byGrade: Record<Grade, { n: number; win: number; avg: number }> }
/** Entry = OPEN of the 1m bar AFTER confirmation (no lookahead); exit = close `holdBars` later; fees+slippage both ways. */
export function backtest(c1: Candle[], confirmed: Setup[], s: Settings): BtResult {
  const byGrade = { A: { n: 0, win: 0, avg: 0 }, B: { n: 0, win: 0, avg: 0 } }
  const rets: number[] = [], cost = 2 * (s.feePct + s.slipPct)
  let longs = 0, shorts = 0
  for (const p of [...confirmed].reverse()) {
    const ei = c1.findIndex((x) => x.openTime >= p.confirmTime!), xi = ei + s.holdBars
    if (ei < 0 || xi >= c1.length) continue
    const raw = ((c1[xi].close - c1[ei].open) / c1[ei].open) * 100 * (p.side === 'LONG' ? 1 : -1)
    const r = raw - cost
    rets.push(r); p.side === 'LONG' ? longs++ : shorts++
    const g = byGrade[p.grade!]; g.n++; g.avg += r; if (r > 0) g.win++
  }
  ;(['A', 'B'] as Grade[]).forEach((g) => { if (byGrade[g].n) byGrade[g].avg /= byGrade[g].n })
  let eq = 0, peak = 0, dd = 0
  for (const r of rets) { eq += r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq) }
  return { n: rets.length, longs, shorts, winRate: rets.length ? (rets.filter((r) => r > 0).length / rets.length) * 100 : 0, avgRet: rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0, maxDD: dd, byGrade }
}
