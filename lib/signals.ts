import type { Candle } from './binance'
import { atr, ema, macdHist, resample, rsi, sma, slopePct, supertrend, closes as closesOf } from './indicators'
import { buildRibbonBoard } from './ribbon'
import { TIMEFRAMES, type BtcTrend, type CoinSignal, type IndicatorCheck, type RibbonBoard, type Signal, type SupertrendInfo, type Timeframe, type Trend } from './types'
import { buildWideScalpData } from './wide-scalp'

// 3m/5m/15m are built by resampling the real native 1m series (factor = minutes / 1).
// 1m and 1h are each fetched natively from Binance — see lib/binance.ts + app/api/market/route.ts.
const RESAMPLE_FACTOR: Partial<Record<Timeframe, number>> = {
  '3m': 3,
  '5m': 5,
  '15m': 15,
}

function toSupertrendInfo(candles: Candle[]): SupertrendInfo {
  const st = supertrend(candles, 10, 3)
  if (!st) return { direction: 'UP', value: candles.at(-1)?.close ?? 0, justFlipped: false, barsSinceFlip: -1 }
  return {
    direction: st.direction === 1 ? 'UP' : 'DOWN',
    value: st.value,
    justFlipped: st.justFlipped,
    barsSinceFlip: st.barsSinceFlip,
  }
}

/**
 * A timeframe bucket votes BUY/SELL only when Supertrend direction, RSI momentum,
 * and MACD histogram all agree. This mirrors real "confluence" trading logic
 * instead of noisy slope math on fake windows.
 */
function bucketSignal(candles: Candle[]): Signal {
  if (candles.length < 15) return 'NEUTRAL'
  const st = supertrend(candles, 10, 3)
  if (!st) return 'NEUTRAL'
  const cl = closesOf(candles)
  const r = rsi(cl, Math.min(14, cl.length - 1))
  const m = macdHist(cl)

  const bullish = st.direction === 1
  let agree = 0
  if (bullish && r >= 52) agree++
  if (!bullish && r <= 48) agree++
  if (bullish && m > 0) agree++
  if (!bullish && m < 0) agree++

  if (agree >= 2) return bullish ? 'BUY' : 'SELL'
  return 'NEUTRAL'
}

interface TfResult {
  signals: Record<Timeframe, Signal>
  sparklines: Record<Timeframe, number[]>
  /** Real Wilder ATR(14) on each timeframe's OWN candles — feeds ATR-based stop sizing per mode (scalp/balanced/safe). */
  atrs: Record<Timeframe, number>
  /** The 1m-derived bars actually used per bucket — handy for the confluence gate's "enough data" checks. */
  bars: Record<Timeframe, Candle[]>
}

/**
 * Builds real per-timeframe candle buckets from native 1m + native 1h data.
 * 1m: used directly. 3m/5m/15m: real resample of the native 1m series (same
 * technique as the old 1h->4H resample, just applied to genuine minute candles).
 * 1h: native hourly candles, unchanged.
 */
function buildTimeframes(oneMinCandles: Candle[], hourlyCandles: Candle[]): TfResult {
  const signals = {} as Record<Timeframe, Signal>
  const sparklines = {} as Record<Timeframe, number[]>
  const atrs = {} as Record<Timeframe, number>
  const bars = {} as Record<Timeframe, Candle[]>

  for (const tf of TIMEFRAMES) {
    let tfCandles: Candle[]
    if (tf === '1h') tfCandles = hourlyCandles
    else if (tf === '1m') tfCandles = oneMinCandles
    else tfCandles = resample(oneMinCandles, RESAMPLE_FACTOR[tf] ?? 1)

    signals[tf] = bucketSignal(tfCandles)
    sparklines[tf] = closesOf(tfCandles).slice(-60)
    atrs[tf] = atr(tfCandles, 14)
    bars[tf] = tfCandles
  }

  return { signals, sparklines, atrs, bars }
}

function trendFromSignals(tfs: Record<Timeframe, Signal>): Trend {
  const buys = TIMEFRAMES.filter((t) => tfs[t] === 'BUY').length
  const sells = TIMEFRAMES.filter((t) => tfs[t] === 'SELL').length
  // Require at least 3 of 5 real timeframes aligned — stricter than before to cut noise trades.
  if (buys >= 3) return 'BULLISH'
  if (sells >= 3) return 'BEARISH'
  return 'NEUTRAL'
}

export interface ConfluenceGate {
  passed: boolean
  bias: Trend
  checks: { label: string; passed: boolean }[]
}

interface TrendStack {
  ema20: number
  ema50: number
  ema200: number
  sma50: number
  sma200: number
}

/**
 * Computes the EMA/SMA trend stack exactly ONCE, the same way, for use by both
 * confluenceGate() and computeScore(). Previously each function computed its own
 * EMA20/50 over different-length slices of the same candle array — same period,
 * different values — which meant the score and the gate could silently disagree.
 * Always warming up over the FULL available candle history (never a short slice)
 * also gives EMA20 the ~60-80 bars it needs to actually converge.
 */
function computeTrendStack(closes: number[]): TrendStack {
  return {
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    ema200: ema(closes, Math.min(200, closes.length)),
    sma50: sma(closes, 50),
    sma200: sma(closes, Math.min(200, closes.length)),
  }
}

/**
 * Phase 1 confluence gate (higher-timeframe trend filter).
 * A raw timeframe-vote trend (BULLISH/BEARISH) only survives if it's confirmed by:
 *  1. 1H EMA200 direction (price above/below EMA200)
 *  2. EMA stack alignment (EMA20 vs EMA50 vs EMA200)
 *  3. Real SMA50/SMA200 confirmation (matching TradingView's SMA definition)
 *  4. MACD histogram sign agreement
 *  5. MA Ribbon Analysis (5m/15m/45m/1h/4h EMA9/21/50/100/200 stack) agrees with direction
 * Requires at least 200 hourly candles so SMA200/EMA200 are backed by real
 * history rather than a too-short, unreliable window.
 */
function confluenceGate(hourlyCandles: Candle[], rawTrend: Trend, ribbon: RibbonBoard): ConfluenceGate {
  const cl = closesOf(hourlyCandles)
  if (rawTrend === 'NEUTRAL' || cl.length < 200) {
    return { passed: rawTrend === 'NEUTRAL', bias: 'NEUTRAL', checks: [] }
  }

  const wantBullish = rawTrend === 'BULLISH'
  const price = cl[cl.length - 1]
  const stack = computeTrendStack(cl)

  const trendFilterPassed = wantBullish ? price >= stack.ema200 : price <= stack.ema200
  const emaAlignedPassed = wantBullish
    ? stack.ema20 >= stack.ema50 && stack.ema50 >= stack.ema200
    : stack.ema20 <= stack.ema50 && stack.ema50 <= stack.ema200
  const smaAlignedPassed = wantBullish ? stack.sma50 >= stack.sma200 : stack.sma50 <= stack.sma200

  const m = macdHist(cl)
  const macdPassed = wantBullish ? m > 0 : m < 0

  // MA Ribbon module feeds directly into the trading decision, not a standalone widget.
  const ribbonPassed = wantBullish
    ? ribbon.label === 'BUY' || ribbon.label === 'VERY_STRONG_BUY'
    : ribbon.label === 'SELL' || ribbon.label === 'STRONG_SELL'

  const checks = [
    { label: '1H EMA200 Trend Filter', passed: trendFilterPassed },
    { label: 'EMA 20/50/200 Alignment', passed: emaAlignedPassed },
    { label: 'SMA 50/200 Confirmation', passed: smaAlignedPassed },
    { label: 'MACD Confirmation', passed: macdPassed },
    { label: 'MA Ribbon Confirmation', passed: ribbonPassed },
  ]

  // Require all five — this is the gate. Any single failure kills the signal.
  const passed = trendFilterPassed && emaAlignedPassed && smaAlignedPassed && macdPassed && ribbonPassed
  return { passed, bias: rawTrend, checks }
}

/** Score 0-100: alignment across real timeframes + Supertrend freshness + RSI/EMA/SMA health. */
function computeScore(hourlyCandles: Candle[], tfs: Record<Timeframe, Signal>, st: SupertrendInfo, gate?: ConfluenceGate): number {
  const buys = TIMEFRAMES.filter((t) => tfs[t] === 'BUY').length
  const sells = TIMEFRAMES.filter((t) => tfs[t] === 'SELL').length
  const aligned = Math.max(buys, sells)
  const alignmentScore = (aligned / TIMEFRAMES.length) * 40

  const cl = closesOf(hourlyCandles)
  const r = rsi(cl)
  const bullish = st.direction === 'UP'
  let rsiScore = 0
  if (bullish) rsiScore = r >= 55 && r <= 72 ? 18 : r > 50 ? 9 : 2
  else rsiScore = r <= 45 && r >= 28 ? 18 : r < 50 ? 9 : 2

  // Same stack computation as the gate — score and gate can never contradict each other.
  const stack = computeTrendStack(cl)
  const emaAligned = bullish
    ? stack.ema20 >= stack.ema50 && stack.ema50 >= stack.ema200
    : stack.ema20 <= stack.ema50 && stack.ema50 <= stack.ema200
  const emaScore = emaAligned ? 12 : 2

  const smaAligned = cl.length >= 200 && (bullish ? stack.sma50 >= stack.sma200 : stack.sma50 <= stack.sma200)
  const smaScore = smaAligned ? 10 : 2

  // A trend that JUST flipped is less proven than one that's held for a while.
  const maturity = st.barsSinceFlip < 0 ? 10 : Math.min(15, st.barsSinceFlip * 1.5)

  const momentum = Math.min(5, Math.abs(slopePct(cl.slice(-24))))

  const raw = alignmentScore + rsiScore + emaScore + smaScore + maturity + momentum

  // Confluence gate is now the single biggest lever: an unconfirmed trend
  // (fails 1H EMA200 / EMA stack / SMA50-200 / MACD) gets capped hard so it can't
  // masquerade as a high-confidence signal the way "78-89% score, hit SL" trades did before.
  if (gate && !gate.passed) {
    const failedCount = gate.checks.filter((c) => !c.passed).length
    const penalty = failedCount === 0 ? 1 : failedCount / gate.checks.length
    return Math.round(Math.min(35, raw * (1 - penalty * 0.7)))
  }

  return Math.round(Math.min(99, raw))
}

export function buildCoinSignal(input: {
  symbol: string
  name: string
  price: number
  change24h: number
  hourlyCandles: Candle[]
  oneMinCandles: Candle[]
  fifteenMinCandles: Candle[]
}): CoinSignal {
  const candles = input.hourlyCandles
  const { signals: timeframes, sparklines: tfSparklines, atrs: tfAtr } = buildTimeframes(input.oneMinCandles, candles)
  const st = toSupertrendInfo(candles)
  const rawTrend = trendFromSignals(timeframes)
  const ribbon = buildRibbonBoard({
    oneMinCandles: input.oneMinCandles,
    fifteenMinCandles: input.fifteenMinCandles,
    hourlyCandles: candles,
    resample,
  })
  const wideScalp = buildWideScalpData(input.fifteenMinCandles)
  const gate = confluenceGate(candles, rawTrend, ribbon)
  // No trade fires unless 1H EMA200 + EMA stack + SMA + MACD + MA Ribbon all confirm the timeframe-vote trend.
  const trend: Trend = gate.passed ? rawTrend : 'NEUTRAL'
  const score = computeScore(candles, timeframes, st, gate)
  const cl = closesOf(candles)

  return {
    symbol: input.symbol,
    name: input.name,
    price: input.price,
    change24h: input.change24h,
    timeframes,
    tfSparklines,
    tfAtr,
    score,
    trend,
    sparkline: cl.slice(-60),
    supertrend: st,
    gateChecks: gate.checks,
    ribbon,
    wideScalp,
  }
}

function fearGreedFromMomentum(change24h: number, strength: number): { value: number; label: string } {
  const value = Math.max(4, Math.min(96, Math.round(50 + change24h * 4 + (strength - 50) * 0.4)))
  let label = 'Neutral'
  if (value >= 75) label = 'Extreme Greed'
  else if (value >= 60) label = 'Greed'
  else if (value >= 45) label = 'Neutral'
  else if (value >= 25) label = 'Fear'
  else label = 'Extreme Fear'
  return { value, label }
}

export function buildBtcTrend(input: {
  price: number
  change24h: number
  dominance: number
  hourlyCandles: Candle[]
  oneMinCandles: Candle[]
  fifteenMinCandles: Candle[]
}): BtcTrend {
  const candles = input.hourlyCandles
  const { signals: timeframes } = buildTimeframes(input.oneMinCandles, candles)
  const st = toSupertrendInfo(candles)
  const rawTrend = trendFromSignals(timeframes)
  const ribbon = buildRibbonBoard({
    oneMinCandles: input.oneMinCandles,
    fifteenMinCandles: input.fifteenMinCandles,
    hourlyCandles: candles,
    resample,
  })
  const gate = confluenceGate(candles, rawTrend, ribbon)
  const trend: Trend = gate.passed ? rawTrend : 'NEUTRAL'
  const score = computeScore(candles, timeframes, st, gate)
  const cl = closesOf(candles)

  const bullish = st.direction === 'UP'
  const r = rsi(cl)
  const adx = Math.min(60, 18 + Math.abs(slopePct(cl.slice(-48))) * 6)

  const indicators: IndicatorCheck[] = [
    { label: 'Supertrend Bullish', passed: bullish },
    ...(gate.checks.length ? gate.checks : [
      { label: 'EMA Alignment (20/50/200)', passed: false },
      { label: 'SMA 50/200 Confirmation', passed: false },
      { label: 'MACD Confirmation', passed: false },
      { label: 'MA Ribbon Confirmation', passed: false },
    ]),
    { label: 'RSI Healthy (45-72)', passed: r >= 45 && r <= 72 },
    { label: 'ADX > 25 (trending)', passed: adx > 25 },
    { label: 'Multi-TF Alignment', passed: score >= 70 },
  ]

  const fg = fearGreedFromMomentum(input.change24h, score)

  return {
    price: input.price,
    change24h: input.change24h,
    dominance: input.dominance,
    fearGreed: fg.value,
    fearGreedLabel: fg.label,
    trend,
    strength: score,
    timeframes,
    indicators,
    sparkline: cl.slice(-60),
    supertrend: st,
    ribbon,
  }
}
