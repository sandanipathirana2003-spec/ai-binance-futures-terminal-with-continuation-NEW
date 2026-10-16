import type { WideScalpData } from './wide-scalp'

export type Signal = 'BUY' | 'SELL' | 'NEUTRAL'
export type Trend = 'BULLISH' | 'BEARISH' | 'NEUTRAL'

// Real Binance kline intervals. 1m is fetched natively; 3m/5m/15m are built by
// resampling that SAME real 1m series (genuine OHLC aggregation, not synthetic
// data); 1h is fetched natively. No fake/mislabeled timeframes anywhere here.
export const TIMEFRAMES = ['1m', '3m', '5m', '15m', '1h'] as const
export type Timeframe = (typeof TIMEFRAMES)[number]

export const TIMEFRAME_LABELS: Record<Timeframe, string> = {
  '1m': '1M',
  '3m': '3M',
  '5m': '5M',
  '15m': '15M',
  '1h': '1H',
}

export interface SupertrendInfo {
  direction: 'UP' | 'DOWN'
  value: number
  justFlipped: boolean
  barsSinceFlip: number
}

export interface CoinSignal {
  symbol: string
  name: string
  price: number
  change24h: number
  timeframes: Record<Timeframe, Signal>
  /** Per-timeframe recent closes for the mini chart in each grid cell — real candle data, not a shared slice. */
  tfSparklines: Record<Timeframe, number[]>
  /** Real Wilder ATR(14) computed on each timeframe's own real candles — used for ATR-based stop sizing. */
  tfAtr: Record<Timeframe, number>
  score: number
  trend: Trend
  sparkline: number[]
  supertrend: SupertrendInfo
  /** 1H EMA200 filter / EMA stack alignment / MACD confirmation — the Phase 1 confluence gate. */
  gateChecks: IndicatorCheck[]
  /** Multi-timeframe EMA/SMA ribbon (5m/15m/45m/1h/4h) — feeds into the confluence gate, not just a display widget. */
  ribbon: RibbonBoard
  /** Raw inputs for the Wide-Stop Scalp strategy (3-candle-low SL basis, 15m ATR, 15m EMA20). */
  wideScalp: WideScalpData
}

export interface IndicatorCheck {
  label: string
  passed: boolean
}

export interface BtcTrend {
  price: number
  change24h: number
  dominance: number
  fearGreed: number
  fearGreedLabel: string
  trend: Trend
  strength: number
  timeframes: Record<Timeframe, Signal>
  indicators: IndicatorCheck[]
  sparkline: number[]
  supertrend: SupertrendInfo
  ribbon: RibbonBoard
}

export interface MarketResponse {
  btc: BtcTrend
  coins: CoinSignal[]
  updatedAt: number
  live: boolean
  /** Present when live is false — tells the UI why (so it never silently shows fake data as real). */
  error?: string
}

export type TradeSide = 'LONG' | 'SHORT'
export type TradeStatus = 'OPEN' | 'CLOSED'
export type CloseReason = 'SL' | 'TP' | 'MANUAL' | null

export type TradeStrategy = 'default' | 'wideScalp'

export interface Trade {
  id: string
  symbol: string
  side: TradeSide
  entry: number
  exit: number | null
  size: number // position size in quote currency (USDT notional)
  stop: number | null // current/live stop — moves during breakeven+ATR trailing
  initialStop: number | null // the stop at trade open, never changes — used to compute 1R distance for trailing
  target: number | null
  status: TradeStatus
  notes: string
  openedAt: number
  closedAt: number | null
  closeReason: CloseReason
  /** 'wideScalp' trades use their own TP1/TP2/breakeven rules instead of generic 1R breakeven+ATR trailing. */
  strategy?: TradeStrategy
  /** 15m ATR frozen at trade open — the fixed basis for wideScalp's TP1 (1x)/TP2 (1.5x)/breakeven (1x) triggers. */
  atrAtEntry?: number | null
  /** True once the wideScalp 50% partial close at TP1 has fired, so it only fires once. */
  partialTaken?: boolean
}

/** A confirmed BULLISH/BEARISH signal captured the moment it fires, for the Alerts tab + browser notifications. */
export interface SignalAlert {
  id: string
  symbol: string
  trend: Trend
  score: number
  price: number
  timestamp: number
}

// --- MA Ribbon Analysis (EMA9/21/50/100/200 + SMA200 across 5m/15m/45m/1h/4h) ---

export const RIBBON_TIMEFRAMES = ['5m', '15m', '45m', '1h', '4h'] as const
export type RibbonTimeframe = (typeof RIBBON_TIMEFRAMES)[number]

export type RibbonArrangement = 'STRONG_BULLISH' | 'BULLISH' | 'MIXED' | 'BEARISH' | 'STRONG_BEARISH'
export type RibbonDynamic = 'EXPANDING' | 'CONTRACTING' | 'STABLE'
export type RibbonLabel = 'VERY_STRONG_BUY' | 'BUY' | 'NEUTRAL' | 'SELL' | 'STRONG_SELL'

export interface RibbonEmas {
  ema9: number
  ema21: number
  ema50: number
  ema100: number
  ema200: number
  sma200: number
}

export interface RibbonCell {
  arrangement: RibbonArrangement
  dynamic: RibbonDynamic
  /** -2 (strong bearish) to +2 (strong bullish) — this timeframe's contribution to the total score. */
  score: number
  /** False when this timeframe has fewer than ~210 real candles — EMA200/SMA200 aren't fully converged yet. */
  sufficientData: boolean
  emas: RibbonEmas
  bars: number
}

export interface RibbonBoard {
  cells: Record<RibbonTimeframe, RibbonCell>
  /** Sum of all 5 timeframe scores, -10 to +10. */
  totalScore: number
  confidence: number
  label: RibbonLabel
}
