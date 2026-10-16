'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import useSWR from 'swr'
import { analyze, backtest, DEFAULTS, type Analysis, type Filters, type Setup, type Settings, type TfStatus } from '@/lib/continuation/engine'
import type { Candle } from '@/lib/binance'

type Tab = 'main' | 'signals' | 'setups' | 'settings' | 'perf'
interface Prefs { symbol: string; settings: Settings; popup: boolean; sound: boolean; browser: boolean; trendNotify: boolean }
const PREF_KEY = 'cont-prefs-v1', SEEN_KEY = 'cont-seen-v1'
const fetcher = async (u: string) => {
  const r = await fetch(u, { cache: 'no-store' }); const j = await r.json()
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
  return j as { symbol: string; serverTime: number; candles: Candle[] }
}
const fmtT = (t: number) => new Date(t).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
const fmtP = (p: number) => (p >= 100 ? p.toFixed(2) : p >= 1 ? p.toFixed(4) : p.toPrecision(4))
const col = (v?: string) => v === 'BULLISH' || v === 'LONG' || v === 'RISING' || v === 'ABOVE' || v === 'EXPANDING' || v === 'ABOVE AVERAGE' || v === 'CONFIRMED' ? 'text-emerald-400'
  : v === 'BEARISH' || v === 'SHORT' || v === 'FALLING' || v === 'BELOW' || v === 'CONTRACTING' || v === 'WEAK' || v === 'CANCELLED' ? 'text-rose-400' : v === 'WAITING' ? 'text-amber-400' : 'text-zinc-300'

function beep() {
  try { const a = new AudioContext(), o = a.createOscillator(); o.connect(a.destination); o.frequency.value = 880; o.start(); o.stop(a.currentTime + 0.25) } catch { /* sound unavailable */ }
}

export default function ContinuationPage() {
  const [prefs, setPrefs] = useState<Prefs>({ symbol: 'BTCUSDT', settings: DEFAULTS, popup: true, sound: false, browser: false, trendNotify: true })
  const [ready, setReady] = useState(false)
  const [tab, setTab] = useState<Tab>('main')
  const [popups, setPopups] = useState<Setup[]>([])
  const [notice, setNotice] = useState('')
  const [now, setNow] = useState(Date.now())
  const seen = useRef<Set<string>>(new Set())

  useEffect(() => {
    try {
      const p = localStorage.getItem(PREF_KEY); if (p) { const j = JSON.parse(p); setPrefs({ ...j, settings: { ...DEFAULTS, ...j.settings, quality: { ...DEFAULTS.quality, ...j.settings?.quality }, mandatory: { ...DEFAULTS.mandatory, ...j.settings?.mandatory } } }) }
      seen.current = new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]'))
    } catch { /* storage unavailable */ }
    setReady(true)
  }, [])
  useEffect(() => { if (ready) try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)) } catch { /* ignore */ } }, [prefs, ready])
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])

  const { data, error, isLoading } = useSWR(ready ? `/api/continuation?symbol=${prefs.symbol}` : null, fetcher, { refreshInterval: 10_000 })
  const A: Analysis | null = useMemo(() => (data ? analyze(data.symbol, data.candles, prefs.settings) : null), [data, prefs.settings])
  const bt = useMemo(() => (data && A ? backtest(data.candles, A.confirmed, prefs.settings) : null), [data, A, prefs.settings])
  const lastClose = data?.candles.length ? data.candles[data.candles.length - 1].openTime + 60_000 : 0
  const stale = !!data && now - lastClose > 150_000

  // Alerts: only NEW events (unseen id + recent). Trend-change and entry alerts are independent.
  useEffect(() => {
    if (!A || !data) return
    const fresh: Setup[] = []
    const notify = (title: string, body: string) => {
      if (prefs.browser && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try { new Notification(title, { body }); setNotice(`Browser notification dispatched: ${title}`) } catch { setNotice('Browser notification FAILED to dispatch') }
      }
    }
    for (const p of A.confirmed) if (!seen.current.has(p.id) && now - p.confirmTime! < 180_000) { seen.current.add(p.id); fresh.push(p); notify(`CONFIRMED ${p.side} — ${data.symbol}`, `Grade ${p.grade} @ ${fmtP(p.price!)}`) }
    if (prefs.trendNotify) for (const t of A.trendChanges) if (!seen.current.has(t.id) && now - t.closeTime < 120_000) { seen.current.add(t.id); notify(`Trend change ${t.tf.toUpperCase()} → ${t.dir}`, `${data.symbol} closed-candle Supertrend flip`) }
    // mark everything older as seen so history never alerts
    A.confirmed.forEach((p) => seen.current.add(p.id)); A.trendChanges.forEach((t) => seen.current.add(t.id))
    try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seen.current].slice(-500))) } catch { /* ignore */ }
    if (fresh.length) { if (prefs.popup) setPopups((x) => [...fresh, ...x]); if (prefs.sound) beep() }
  }, [A]) // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch: Partial<Settings>) => setPrefs((p) => ({ ...p, settings: { ...p.settings, ...patch } }))
  const num = (k: keyof Settings, label: string, step = 1) => (
    <label key={k} className="flex min-h-12 items-center justify-between gap-3 py-1 text-sm">{label}
      <input type="number" step={step} className="h-11 w-28 rounded bg-zinc-800 px-2 text-right text-base" value={prefs.settings[k] as number}
        onChange={(e) => { const v = +e.target.value; if (v > 0) set({ [k]: v } as Partial<Settings>) }} /></label>)
  const tog = (label: string, v: boolean, f: (b: boolean) => void) => (
    <label key={label} className="flex min-h-12 items-center justify-between gap-3 py-1 text-sm">{label}<input type="checkbox" className="h-6 w-6" checked={v} onChange={(e) => f(e.target.checked)} /></label>)
  const fKeys: (keyof Filters)[] = ['ema99', 'ribbon', 'adx', 'volume']

  const Row = ({ k, v, c }: { k: string; v: string; c?: string }) => <div className="flex justify-between gap-3 text-[13px] leading-snug"><span className="shrink-0 text-zinc-400">{k}</span><span className={`min-w-0 break-words text-right font-medium ${c ?? ''}`}>{v}</span></div>
  const Card = ({ s }: { s: TfStatus | null }) => !s ? <div className="rounded-lg bg-zinc-900 p-3 text-sm text-zinc-400">Not enough data</div> : (
    <div className="space-y-1.5 rounded-lg border border-zinc-800 bg-zinc-900 p-3">
      <div className="flex items-center justify-between"><span className="text-lg font-bold">{s.tf.toUpperCase()}</span><span className={`text-lg font-bold ${col(s.stDir)}`}>{s.stDir}</span></div>
      <Row k="Supertrend line" v={fmtP(s.stLine)} />
      <Row k="Last confirmed flip" v={s.lastFlip ? `${s.lastFlip.dir} · ${fmtT(s.lastFlip.closeTime)}` : 'none in window'} c={col(s.lastFlip?.dir)} />
      <Row k="Last candle close" v={fmtT(s.closeTime)} />
      <Row k="EMA99" v={`${s.ema99Slope} · price ${s.vsEma99}`} c={col(s.vsEma99)} />
      <Row k="EMA7/25" v={`${s.ma} (${s.emaGapPct.toFixed(3)}%)`} c={col(s.ma)} />
      <Row k="Ribbon" v={s.ribbon} c={col(s.ribbon)} />
      <Row k="VIDYA" v={s.vidya} c={col(s.vidya)} /><div className="text-[11px] text-zinc-500">{s.vidyaNote}</div>
      <Row k="ADX" v={`${s.adx.toFixed(1)} ${s.adxSlope} · ${s.adxStrong ? 'strong' : 'weak'}`} />
      <Row k="+DI / −DI" v={`${s.pdi.toFixed(1)} / ${s.mdi.toFixed(1)} → ${s.pdi > s.mdi ? 'bullish' : 'bearish'}`} c={s.pdi > s.mdi ? 'text-emerald-400' : 'text-rose-400'} />
      <Row k="Volume (closed)" v={`${s.volStatus} (${s.volRatio.toFixed(2)}×)`} c={col(s.volStatus)} />
      {A && <Row k={`vs main (${prefs.settings.mainSource.toUpperCase()})`} v={A.main === 'MIXED' ? 'main is MIXED' : s.stDir === A.main ? 'AGREES' : 'DISAGREES'} c={A.main !== 'MIXED' && s.stDir === A.main ? 'text-emerald-400' : 'text-amber-400'} />}
    </div>)
  const SetupCard = ({ p }: { p: Setup }) => (
    <div className="space-y-1 rounded-lg border border-zinc-800 bg-zinc-900 p-3">
      <div className="flex justify-between"><b className={col(p.side)}>{p.side} {p.grade ? `· Grade ${p.grade}` : ''}</b><b className={col(p.status)}>{p.status === 'WAITING' ? 'WAIT — 3M not confirmed' : p.status}</b></div>
      <Row k="1M flip (closed)" v={fmtT(p.t1)} /><Row k="1M flip price" v={fmtP(p.price1)} />
      {p.confirmTime && <><Row k="3M flip (closed)" v={fmtT(p.confirmTime)} /><Row k="Signal price" v={fmtP(p.price!)} />
        <Row k="Main at confirmation" v={p.mainAtConfirm ?? ''} c={col(p.mainAtConfirm)} />
        <Row k="Current vs signal" v={A?.tfs['1m'] ? `${(((A.tfs['1m'].price - p.price!) / p.price!) * 100 * (p.side === 'LONG' ? 1 : -1)).toFixed(2)}%` : '—'} /></>}
      <Row k="MA condition" v={p.maOk ? 'OK' : 'not yet'} c={p.maOk ? 'text-emerald-400' : 'text-amber-400'} />
      <Row k="VIDYA" v={p.vidyaOk ? 'OK' : 'not yet'} c={p.vidyaOk ? 'text-emerald-400' : 'text-amber-400'} />
      {p.checks?.map((c) => <Row key={c.label} k={`${c.label}${c.mandatory ? ' (mandatory)' : ''}`} v={!c.enabled ? 'off' : c.pass ? 'PASS' : 'FAIL'} c={!c.enabled ? '' : c.pass ? 'text-emerald-400' : 'text-amber-400'} />)}
      {p.status === 'WAITING' && <Row k="Expires in" v={`${Math.max(0, Math.round((p.expiresAt - now) / 1000))}s`} c="text-amber-400" />}
      {p.reason && <div className="text-xs text-rose-300">Reason: {p.reason}</div>}
    </div>)
  const tabs: [Tab, string][] = [['main', 'Main Trend'], ['signals', 'Signals'], ['setups', 'Setups'], ['perf', 'Backtest'], ['settings', 'Settings']]
  const waiting = A?.setups.filter((p) => p.status === 'WAITING') ?? []

  return (
    <main className="mx-auto min-h-screen max-w-5xl overflow-x-hidden bg-zinc-950 px-3 pb-[calc(5.5rem+env(safe-area-inset-bottom))] pt-[calc(0.75rem+env(safe-area-inset-top))] text-zinc-100">
      <header className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <input className="w-36 rounded bg-zinc-800 px-3 py-2.5 text-base font-bold uppercase" value={prefs.symbol} onChange={(e) => setPrefs((p) => ({ ...p, symbol: e.target.value.toUpperCase().trim() }))} aria-label="Symbol" />
        <span className={`rounded px-2 py-1 text-[11px] font-bold ${error ? 'bg-rose-900' : stale ? 'bg-amber-900' : 'bg-emerald-900'}`}>
          {error ? 'DISCONNECTED' : isLoading && !data ? 'LOADING…' : stale ? 'STALE DATA' : 'LIVE · Binance USDT-M REST (10s poll)'}</span>
        <span className="w-full text-[11px] text-zinc-500">Analysis & alerts only — not a trading bot.</span>
      </header>
      {error && <div className="mb-3 rounded bg-rose-950 p-3 text-sm">Error: {String(error.message)}. Showing last good data if any.</div>}
      {A?.warnings.map((w) => <div key={w} className="mb-2 rounded bg-amber-950 p-2 text-xs">{w}</div>)}
      {notice && <div className="mb-2 text-[11px] text-zinc-400">{notice}</div>}

      {tab === 'main' && A && <div className="space-y-3">
        <div className="rounded-lg border-2 border-zinc-700 bg-zinc-900 p-4 text-center">
          <div className="text-xs text-zinc-400">SELECTED MAIN TREND ({prefs.settings.mainSource === 'both' ? '3M + 5M must agree' : `${prefs.settings.mainSource.toUpperCase()} Supertrend`})</div>
          <div className={`text-3xl font-black ${A.main === 'MIXED' ? 'text-amber-400' : col(A.main)}`}>{A.main}{A.main === 'MIXED' && ' — uncertain'}</div>
        </div>
        {waiting.length > 0 && <div className="rounded bg-amber-950 p-2 text-sm">{waiting.length} setup(s) WAITING for 3M confirmation (see Setups) — not entries.</div>}
        <div className="grid gap-3 md:grid-cols-3">{(['1m', '3m', '5m'] as const).map((t) => <Card key={t} s={A.tfs[t]} />)}</div>
        <h3 className="text-sm font-semibold">Recent confirmed Supertrend flips (trend-change log — not entries)</h3>
        <div className="space-y-1 text-xs">{A.trendChanges.slice(0, 12).map((t) => <div key={t.id} className="flex justify-between rounded bg-zinc-900 px-2 py-1.5"><span>{t.tf.toUpperCase()}</span><span className={col(t.dir)}>{t.dir}</span><span className="text-zinc-400">{fmtT(t.closeTime)}</span></div>)}</div>
      </div>}
      {tab === 'signals' && <div className="space-y-3">{A?.confirmed.length ? A.confirmed.map((p) => <SetupCard key={p.id} p={p} />) : <p className="text-sm text-zinc-400">No confirmed signals in the loaded window (~25h of 1m data). Fewer, sequenced signals is by design.</p>}
        <p className="text-[11px] text-zinc-500">Grades describe filter agreement, not win probability.</p></div>}
      {tab === 'setups' && <div className="space-y-3">{A?.setups.length ? A.setups.map((p) => <SetupCard key={p.id} p={p} />) : <p className="text-sm text-zinc-400">No pending or rejected setups.</p>}</div>}
      {tab === 'perf' && bt && <div className="space-y-2 rounded-lg bg-zinc-900 p-3 text-sm">
        <Row k="Confirmed signals tested" v={`${bt.n} (${bt.longs} L / ${bt.shorts} S)`} /><Row k="Win rate (net > 0 after hold)" v={`${bt.winRate.toFixed(0)}%`} />
        <Row k="Avg net return" v={`${bt.avgRet.toFixed(3)}%`} /><Row k="Max drawdown (sum of %)" v={`${bt.maxDD.toFixed(2)}%`} />
        {(['A', 'B'] as const).map((g) => <Row key={g} k={`Grade ${g}`} v={`${bt.byGrade[g].n} trades · ${bt.byGrade[g].n ? ((bt.byGrade[g].win / bt.byGrade[g].n) * 100).toFixed(0) : 0}% win · ${bt.byGrade[g].avg.toFixed(3)}% avg`} />)}
        <p className="pt-2 text-[11px] text-zinc-500">Outcome rule: enter at the OPEN of the 1m bar after confirmation, exit at close {prefs.settings.holdBars} bars later, minus 2×(fee {prefs.settings.feePct}% + slippage {prefs.settings.slipPct}%). Only ~25h of data is loaded, so this is far too small a sample to trust; it is not a prediction. Per-pair/market-condition breakdowns are not implemented.</p></div>}
      {tab === 'settings' && <div className="divide-y divide-zinc-800 rounded-lg bg-zinc-900 p-3">
        <label className="flex items-center justify-between py-2 text-sm">Main trend source
          <select className="h-11 rounded bg-zinc-800 px-2 text-base" value={prefs.settings.mainSource} onChange={(e) => set({ mainSource: e.target.value as Settings['mainSource'] })}>
            <option value="5m">5M Supertrend (default)</option><option value="3m">3M Supertrend</option><option value="both">3M + 5M agree</option></select></label>
        {([['emaFast', 'EMA fast'], ['emaMid', 'EMA mid'], ['emaSlow', 'EMA slow'], ['stAtr', 'Supertrend ATR period'], ['stMult', 'Supertrend multiplier', 0.1], ['vLen', 'VIDYA length'], ['vMom', 'VIDYA momentum'], ['vBand', 'VIDYA band distance', 0.1], ['adxThr', 'ADX threshold'], ['volPeriod', 'Volume avg period'], ['expiryMin', 'Setup expiry (min)'], ['holdBars', 'Backtest hold (1m bars)'], ['feePct', 'Fee % per side', 0.01], ['slipPct', 'Slippage % per side', 0.01]] as [keyof Settings, string, number?][]).map(([k, l, st]) => num(k, l, st))}
        <div className="py-2 text-xs text-zinc-400">Optional quality filters — “show” affects the grade; “mandatory” blocks entry if failed.</div>
        {fKeys.map((k) => <div key={k} className="grid grid-cols-2 gap-6">{tog(`${k} show`, prefs.settings.quality[k], (b) => set({ quality: { ...prefs.settings.quality, [k]: b } }))}{tog('mandatory', prefs.settings.mandatory[k], (b) => set({ mandatory: { ...prefs.settings.mandatory, [k]: b } }))}</div>)}
        {tog('Entry popup', prefs.popup, (b) => setPrefs((p) => ({ ...p, popup: b })))}
        {tog('Sound', prefs.sound, (b) => setPrefs((p) => ({ ...p, sound: b })))}
        {tog('Trend-change notifications (separate)', prefs.trendNotify, (b) => setPrefs((p) => ({ ...p, trendNotify: b })))}
        {tog('Browser notifications', prefs.browser, async (b) => {
          if (b && typeof Notification !== 'undefined') { const r = await Notification.requestPermission(); setNotice(`Notification permission: ${r}`); setPrefs((p) => ({ ...p, browser: r === 'granted' })) }
          else if (b) setNotice('Browser notifications are not supported here.'); else setPrefs((p) => ({ ...p, browser: false })) })}
        <button className="mt-3 min-h-12 w-full rounded bg-zinc-800 text-sm" onClick={() => set({ ...DEFAULTS })}>Reset indicator settings</button>
        <p className="pt-2 text-[11px] text-zinc-500">VIDYA is an in-house re-implementation of the Volumatic VIDYA formula (not the TradingView source); defaults 14/9/1.5 are yours, unverified against the original. Alerts only fire while this page is open.</p></div>}

      <nav className="fixed inset-x-0 bottom-0 z-10 mx-auto flex max-w-5xl border-t border-zinc-800 bg-zinc-950 pb-[env(safe-area-inset-bottom)]">
        {tabs.map(([k, l]) => <button key={k} onClick={() => setTab(k)} className={`min-h-14 min-w-0 flex-1 truncate px-0.5 text-[11px] font-semibold ${tab === k ? 'border-t-2 border-emerald-400 text-emerald-400' : 'text-zinc-400'}`}>{l}{k === 'signals' && A?.confirmed.length ? ` (${A.confirmed.length})` : ''}{k === 'setups' && waiting.length ? ` (${waiting.length})` : ''}</button>)}
      </nav>

      {popups[0] && <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/70 p-4"><div className="max-h-[90dvh] w-full max-w-sm space-y-1 overflow-y-auto rounded-xl border border-zinc-600 bg-zinc-900 p-4">
        <div className={`text-xl font-black ${col(popups[0].side)}`}>CONFIRMED {popups[0].side} — {data?.symbol}</div>
        <Row k="1M Supertrend" v={popups[0].side === 'LONG' ? 'BULLISH' : 'BEARISH'} /><Row k="3M Supertrend" v={popups[0].side === 'LONG' ? 'BULLISH' : 'BEARISH'} />
        <Row k="Main trend" v={popups[0].mainAtConfirm ?? ''} /><Row k="MA ribbon / VIDYA" v="CONFIRMED" />
        {popups[0].checks?.filter((c) => c.enabled).map((c) => <Row key={c.label} k={c.label} v={c.pass ? 'PASS' : 'not met'} c={c.pass ? 'text-emerald-400' : 'text-amber-400'} />)}
        <Row k="Grade" v={popups[0].grade ?? ''} /><Row k="Confirmed at" v={fmtT(popups[0].confirmTime!)} /><Row k="Signal price" v={fmtP(popups[0].price!)} />
        <div className="text-[11px] text-zinc-500">Confirmed entry SETUP — not a guarantee of profit.</div>
        <button className="mt-2 min-h-12 w-full rounded bg-zinc-700" onClick={() => setPopups((x) => x.slice(1))}>Dismiss{popups.length > 1 ? ` (${popups.length - 1} more)` : ''}</button></div></div>}
    </main>)
}
