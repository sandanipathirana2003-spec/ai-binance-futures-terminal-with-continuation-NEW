import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// Proxies Binance USDT-M Futures 1m klines. Only candles whose close time has passed are returned
// (the in-progress candle is dropped server-side), so the client can never see an unfinished bar.
export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get('symbol') ?? 'BTCUSDT').toUpperCase()
  if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol)) return NextResponse.json({ error: 'Invalid symbol' }, { status: 400 })
  try {
    const res = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1m&limit=1500`, {
      cache: 'no-store', signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return NextResponse.json({ error: `Binance responded ${res.status}${res.status === 451 ? ' (region blocked)' : ''}` }, { status: 502 })
    const raw = (await res.json()) as unknown[][]
    const now = Date.now()
    const candles = raw.filter((k) => (k[6] as number) < now).map((k) => ({
      openTime: k[0] as number, open: +(k[1] as string), high: +(k[2] as string), low: +(k[3] as string), close: +(k[4] as string), volume: +(k[5] as string),
    }))
    return NextResponse.json({ symbol, serverTime: now, candles })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'fetch failed' }, { status: 502 })
  }
}
