import type { Candle } from './binance'

export function closes(candles: Candle[]): number[] {
  return candles.map((c) => c.close)
}

export function ema(values: number[], period: number): number {
  if (values.length === 0) return 0
  const k = 2 / (period + 1)
  let e = values[0]
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k)
  return e
}

/** Full EMA series (same length as input) — needed for Supertrend-style rolling calcs. */
export function emaSeries(values: number[], period: number): number[] {
  if (values.length === 0) return []
  const k = 2 / (period + 1)
  const out: number[] = [values[0]]
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k))
  return out
}

/** Simple Moving Average — arithmetic mean of the last `period` closes, same definition TradingView uses. */
export function sma(values: number[], period: number): number {
  if (values.length === 0) return 0
  const p = Math.min(period, values.length)
  let sum = 0
  for (let i = values.length - p; i < values.length; i++) sum += values[i]
  return sum / p
}

export function rsi(values: number[], period = 14): number {
  if (values.length < period + 1) return 50
  let gains = 0
  let losses = 0
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1]
    if (diff >= 0) gains += diff
    else losses -= diff
  }
  if (losses === 0) return 100
  const rs = gains / period / (losses / period)
  return 100 - 100 / (1 + rs)
}

export function macdHist(values: number[]): number {
  if (values.length < 26) return 0
  const fastSeries = emaSeries(values, 12)
  const slowSeries = emaSeries(values, 26)
  const macdLine = fastSeries.map((f, i) => f - slowSeries[i])
  const signalLine = emaSeries(macdLine, 9)
  return macdLine[macdLine.length - 1] - signalLine[signalLine.length - 1]
}

function slopePct(values: number[]): number {
  if (values.length < 2) return 0
  const first = values[0]
  const last = values[values.length - 1]
  if (first === 0) return 0
  return ((last - first) / Math.abs(first)) * 100
}

/** True Range series. */
function trueRange(candles: Candle[]): number[] {
  const out: number[] = []
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      out.push(candles[i].high - candles[i].low)
      continue
    }
    const prevClose = candles[i - 1].close
    const hl = candles[i].high - candles[i].low
    const hc = Math.abs(candles[i].high - prevClose)
    const lc = Math.abs(candles[i].low - prevClose)
    out.push(Math.max(hl, hc, lc))
  }
  return out
}

/** Wilder ATR (RMA smoothing), standard for Supertrend. */
function atrSeries(candles: Candle[], period: number): number[] {
  const tr = trueRange(candles)
  const out: number[] = []
  let prevAtr = 0
  for (let i = 0; i < tr.length; i++) {
    if (i < period) {
      // seed with simple average of the first `period` TRs
      prevAtr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period
      out.push(i === period - 1 ? prevAtr : NaN)
    } else {
      prevAtr = (prevAtr * (period - 1) + tr[i]) / period
      out.push(prevAtr)
    }
  }
  return out
}

/**
 * Latest real ATR value in price units — the same volatility measure that
 * drives Supertrend, now exposed directly for ATR-based stop-loss sizing.
 * Gracefully shrinks the period for short candle series instead of returning 0/NaN.
 */
export function atr(candles: Candle[], period = 14): number {
  if (candles.length < 2) return 0
  const effectivePeriod = Math.max(1, Math.min(period, candles.length - 1))
  const series = atrSeries(candles, effectivePeriod)
  for (let i = series.length - 1; i >= 0; i--) {
    if (!Number.isNaN(series[i])) return series[i]
  }
  return 0
}

export interface SupertrendResult {
  /** Direction of the last closed candle: 1 = uptrend (bullish), -1 = downtrend (bearish). */
  direction: 1 | -1
  /** The current Supertrend line value (acts as trailing stop / support-resistance). */
  value: number
  /** True if direction flipped on the most recent candle vs the one before it. */
  justFlipped: boolean
  /** Index (candles ago) of the most recent flip, or -1 if none found in the window. */
  barsSinceFlip: number
}

/**
 * Classic ATR-based Supertrend (period, multiplier). This is the real indicator —
 * not a slope/EMA proxy. Direction only changes when price closes through the band,
 * which is what makes it change over time instead of looking "frozen".
 */
export function supertrend(candles: Candle[], period = 10, multiplier = 3): SupertrendResult | null {
  if (candles.length < period + 2) return null
  const atr = atrSeries(candles, period)

  let dir: 1 | -1 = 1
  let st = 0
  let flipIndex = -1
  const dirs: (1 | -1)[] = []

  for (let i = 0; i < candles.length; i++) {
    const a = atr[i]
    if (Number.isNaN(a) || a === 0) {
      dirs.push(dir)
      continue
    }
    const hl2 = (candles[i].high + candles[i].low) / 2
    const upperBasic = hl2 + multiplier * a
    const lowerBasic = hl2 - multiplier * a

    if (i === 0 || dirs.length === 0) {
      st = upperBasic
      dir = candles[i].close <= upperBasic ? -1 : 1
      dirs.push(dir)
      continue
    }

    const prevClose = candles[i - 1].close
    const prevDir = dirs[dirs.length - 1]

    // Band continuity rules (standard Supertrend logic)
    const finalUpper = prevDir === 1 || upperBasic < st ? upperBasic : Math.min(upperBasic, st)
    const finalLower = prevDir === -1 || lowerBasic > st ? lowerBasic : Math.max(lowerBasic, st)

    let newDir: 1 | -1 = prevDir
    let newSt: number

    if (prevDir === 1) {
      newSt = finalLower
      if (candles[i].close < newSt) {
        newDir = -1
        newSt = finalUpper
      }
    } else {
      newSt = finalUpper
      if (candles[i].close > newSt) {
        newDir = 1
        newSt = finalLower
      }
    }

    if (newDir !== prevDir) flipIndex = i
    dir = newDir
    st = newSt
    dirs.push(dir)
    void prevClose
  }

  const last = dirs.length - 1
  return {
    direction: dir,
    value: st,
    justFlipped: flipIndex === last,
    barsSinceFlip: flipIndex === -1 ? -1 : last - flipIndex,
  }
}

/** Aggregate N consecutive candles into one OHLC bar (real resampling, oldest -> newest). */
export function resample(candles: Candle[], factor: number): Candle[] {
  const out: Candle[] = []
  for (let i = 0; i + factor <= candles.length; i += factor) {
    const chunk = candles.slice(i, i + factor)
    out.push({
      openTime: chunk[0].openTime,
      open: chunk[0].open,
      high: Math.max(...chunk.map((c) => c.high)),
      low: Math.min(...chunk.map((c) => c.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, c) => s + c.volume, 0),
    })
  }
  return out
}

export { slopePct }
