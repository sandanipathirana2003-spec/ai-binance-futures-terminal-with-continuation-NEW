'use client'

import { useEffect, useState } from 'react'
import { BellRing, BookOpen, LineChart, Waves } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useMarket } from '@/hooks/use-market'
import { useSignalAlerts } from '@/hooks/use-signal-alerts'
import { useTrades } from '@/hooks/use-trades'
import { AlertsPanel } from './alerts-panel'
import { BotPanel } from './bot-panel'
import { BtcSidebar } from './btc-sidebar'
import { CoinScanner } from './coin-scanner'
import { RibbonTable } from './ribbon-table'
import { TimeframeGrid } from './timeframe-grid'
import { TopBar } from './top-bar'
import { TradeJournal } from './trade-journal'

type Tab = 'terminal' | 'journal' | 'ribbon' | 'signals'

export function Terminal() {
  const { market, isLoading } = useMarket()
  const { autoCheckTrades } = useTrades()
  const { alerts, permission, requestPermission, soundEnabled, toggleSound, clearAlerts } = useSignalAlerts(market?.coins)
  const [selected, setSelected] = useState('BTCUSDT')
  const [tab, setTab] = useState<Tab>('terminal')
  const [lastSeenAlertCount, setLastSeenAlertCount] = useState(0)

  // Every time fresh prices come in (every 15s), check open trades against
  // their locked stop/target — trailing the stop first (breakeven + ATR) — and
  // auto-close anything that's been hit.
  useEffect(() => {
    if (!market) return
    const context: Record<string, { price: number; atr: number }> = {}
    for (const c of market.coins) context[c.symbol] = { price: c.price, atr: c.tfAtr['1h'] ?? 0 }
    autoCheckTrades(context)
  }, [market, autoCheckTrades])

  // If the selected symbol is missing from the feed, fall back to the first coin.
  useEffect(() => {
    if (!market) return
    if (!market.coins.some((c) => c.symbol === selected) && market.coins[0]) {
      setSelected(market.coins[0].symbol)
    }
  }, [market, selected])

  useEffect(() => {
    if (tab === 'signals') setLastSeenAlertCount(alerts.length)
  }, [tab, alerts.length])

  const coin = market?.coins.find((c) => c.symbol === selected)
  const unread = Math.max(0, alerts.length - lastSeenAlertCount)

  return (
    <div className="bg-background flex h-dvh flex-col">
      <TopBar live={market?.live ?? false} updatedAt={market?.updatedAt} error={market?.error} />
      {market && !market.live ? (
        <div className="border-bear/30 bg-bear/10 text-bear border-b px-4 py-2 text-center font-mono text-xs">
          Binance data is unavailable right now ({market.error ?? 'unknown error'}). No signals are shown — retrying automatically, nothing fake is being displayed.
        </div>
      ) : null}

      <nav className="border-border bg-sidebar flex items-center gap-1 border-b px-3">
        <TabButton active={tab === 'terminal'} onClick={() => setTab('terminal')} icon={<LineChart className="size-4" />}>
          Live Terminal
        </TabButton>
        <TabButton active={tab === 'journal'} onClick={() => setTab('journal')} icon={<BookOpen className="size-4" />}>
          Trade Journal
        </TabButton>
        <TabButton active={tab === 'ribbon'} onClick={() => setTab('ribbon')} icon={<Waves className="size-4" />}>
          MA Ribbon
        </TabButton>
        <TabButton
          active={tab === 'signals'}
          onClick={() => setTab('signals')}
          icon={<BellRing className="size-4" />}
          badge={unread > 0 ? unread : undefined}
        >
          Signals
        </TabButton>
      </nav>

      {isLoading && !market ? (
        <div className="text-muted-foreground flex flex-1 items-center justify-center font-mono text-sm">
          Loading market feed…
        </div>
      ) : tab === 'terminal' ? (
        <main className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[21rem_minmax(0,1fr)_20rem]">
          <BtcSidebar btc={market?.btc} />

          <section className="flex min-h-0 flex-col gap-3 overflow-y-auto p-3">
            <TimeframeGrid coin={coin} />
            <div className="flex min-h-0 flex-1 flex-col lg:min-h-[20rem]">
              <CoinScanner coins={market?.coins ?? []} selected={selected} onSelect={setSelected} />
            </div>
          </section>

          <BotPanel coin={coin} btc={market?.btc} />
        </main>
      ) : tab === 'journal' ? (
        <main className="min-h-0 flex-1 overflow-y-auto">
          <TradeJournal coins={market?.coins ?? []} />
        </main>
      ) : tab === 'ribbon' ? (
        <main className="min-h-0 flex-1 overflow-y-auto">
          <RibbonTable coins={market?.coins ?? []} />
        </main>
      ) : (
        <main className="min-h-0 flex-1 overflow-y-auto">
          <AlertsPanel
            alerts={alerts}
            permission={permission}
            onRequestPermission={requestPermission}
            soundEnabled={soundEnabled}
            onToggleSound={toggleSound}
            onClear={clearAlerts}
          />
        </main>
      )}
    </div>
  )
}

function TabButton({
  active,
  onClick,
  icon,
  children,
  badge,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  children: React.ReactNode
  badge?: number
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors',
        active
          ? 'border-primary text-foreground'
          : 'text-muted-foreground hover:text-foreground border-transparent',
      )}
    >
      {icon}
      {children}
      {badge ? (
        <span className="bg-bear text-bear-foreground flex size-4 items-center justify-center rounded-full text-[10px] font-bold">
          {badge > 9 ? '9+' : badge}
        </span>
      ) : null}
    </button>
  )
}
