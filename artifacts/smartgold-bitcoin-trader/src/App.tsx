import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ClerkProvider, SignIn, SignUp, useClerk, useUser } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import {
  Activity, AlertOctagon, AlertTriangle, ArrowDownRight, ArrowLeftRight, ArrowUpRight,
  BarChart3, Bell, Bitcoin, Check, ChevronRight, Clock3, Coins, Database,
  Gauge, History, LayoutDashboard, LoaderCircle, LockKeyhole, Menu, Play, RefreshCw,
  Settings2, Shield, ShieldCheck, Sparkles, Square, X,
} from 'lucide-react';
import { Link, Redirect, Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import {
  getGetTradingAuditQueryKey, getGetTradingBacktestsQueryKey,
  getGetTradingDashboardQueryKey, getGetTradingPositionsQueryKey,
  getGetTradingSettingsQueryKey, getGetTradingSignalsQueryKey,
  useCloseTradingPosition, useControlTradingEngine, useEnterTradingSignal,
  useEvaluateTradingSignal,
  useGetTradingAudit, useGetTradingBacktests, useGetTradingDashboard,
  useGetTradingPositions, useGetTradingSettings, useGetTradingSignals, useHealthCheck,
  useRunTradingBacktest, useUpdateTradingSettings,
} from '@workspace/api-client-react';
import type {
  AuditEvent, BacktestInput, BacktestRun, SignalDecision, TradingDashboard,
  TradingPosition, TradingSettingsUpdate,
} from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { CandleAnalysisChart, type AnalysisChart } from '@/components/candle-analysis-chart';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 4_000, refetchInterval: 5_000, retry: 1 },
  },
});
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const adminEmail = (import.meta.env.VITE_TRADING_ADMIN_EMAIL ?? '').trim().toLowerCase();
const localDevAuth = import.meta.env.VITE_LOCAL_DEV_AUTH === '1';
// Lokal rejimda Clerk JS umuman yuklanmasin (clerk.localhost xatosini oldini oladi).
const clerkPubKey = localDevAuth
  ? ''
  : publishableKeyFromHost(
      window.location.hostname,
      import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
    );
const clerkProxyUrl = localDevAuth ? undefined : import.meta.env.VITE_CLERK_PROXY_URL;
const routes = [
  { href: '/dashboard', label: 'Umumiy ko‘rinish', icon: LayoutDashboard },
  { href: '/backtests', label: 'Backtestlar', icon: BarChart3 },
  { href: '/journal', label: 'Jurnal', icon: History },
  { href: '/settings', label: 'Sozlamalar', icon: Settings2 },
];

function cx(...values: Array<string | false | undefined>) { return values.filter(Boolean).join(' '); }
function money(value?: number, digits = 2) {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('uz-UZ', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}
function dateTime(value?: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('uz-UZ', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
function shortSymbol(symbol: string) { return symbol === 'XAUUSD' ? 'Oltin / USD' : symbol === 'BTCUSDT' ? 'Bitcoin / USDT' : symbol; }
function actionUz(value: string) { return value === 'LONG' ? 'Xarid' : value === 'SHORT' ? 'Sotuv' : 'Savdo yo‘q'; }
function strategyUz(value: string) {
  if (value === 'gold-breakout-retest') return 'Oltin · yorib o‘tish va qayta sinov';
  if (value === 'btc-trend-momentum') return 'Bitcoin · trend impulsi';
  return value;
}
function stateUz(value?: string) {
  return ({ running: 'Ishlamoqda', paused: 'Pauzada', stopped: 'To‘xtatilgan', emergency_stop: 'Favqulodda to‘xtash' } as Record<string, string>)[value ?? ''] ?? 'Noma’lum';
}
function ErrorState({ retry, text = 'Ma’lumotni yuklab bo‘lmadi.' }: { retry: () => void; text?: string }) {
  return <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-5 text-sm" data-testid="status-load-error">
    <div className="flex items-center gap-2 font-semibold text-destructive"><AlertTriangle size={16} />{text}</div>
    <button data-testid="button-retry-load" onClick={retry} className="mt-3 inline-flex items-center gap-2 text-xs font-bold text-foreground hover:text-primary"><RefreshCw size={13} /> Qayta urinish</button>
  </div>;
}
function LoadingRows({ count = 3 }: { count?: number }) {
  return <div className="space-y-3" aria-label="Yuklanmoqda">{Array.from({ length: count }, (_, i) => <div key={i} className="h-14 animate-pulse rounded-lg bg-muted/70" />)}</div>;
}
function EmptyState({ title, body }: { title: string; body: string }) {
  return <div className="flex min-h-40 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/20 px-5 text-center" data-testid="status-empty">
    <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-secondary text-secondary-foreground"><Database size={17} /></span>
    <p className="text-sm font-bold">{title}</p><p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">{body}</p>
  </div>;
}
function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'gold' }) {
  const tones = { neutral: 'bg-muted text-muted-foreground', good: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300', warn: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200', bad: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300', gold: 'bg-primary/15 text-primary' };
  return <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-[.08em]', tones[tone])}>{children}</span>;
}
function Button({ children, onClick, disabled, variant = 'primary', className = '', type = 'button', testId }: {
  children: ReactNode; onClick?: () => void; disabled?: boolean; variant?: 'primary' | 'outline' | 'danger' | 'ghost'; className?: string; type?: 'button' | 'submit'; testId?: string;
}) {
  const styles = { primary: 'bg-primary text-primary-foreground hover:brightness-95', outline: 'border border-border bg-card text-foreground hover:bg-muted', danger: 'bg-destructive text-destructive-foreground hover:brightness-95', ghost: 'text-muted-foreground hover:bg-muted hover:text-foreground' };
  return <button type={type} data-testid={testId} disabled={disabled} onClick={onClick} className={cx('inline-flex min-h-9 items-center justify-center gap-2 rounded-lg px-3.5 text-xs font-extrabold transition duration-150 disabled:cursor-not-allowed disabled:opacity-50', styles[variant], className)}>{children}</button>;
}
function SectionTitle({ kicker, title, trailing }: { kicker?: string; title: string; trailing?: ReactNode }) {
  return <div className="mb-4 flex items-end justify-between gap-4"><div>{kicker && <p className="eyebrow mb-1">{kicker}</p>}<h2 className="font-display text-xl font-semibold tracking-tight">{title}</h2></div>{trailing}</div>;
}
type BrokerInfo = {
  connected: boolean;
  login?: number | null;
  name?: string | null;
  server?: string | null;
  company?: string | null;
  leverage?: number | null;
  currency?: string;
  balance?: number | null;
  equity?: number | null;
  marginFree?: number | null;
  floatingProfit?: number | null;
  tradeAllowed?: boolean;
  isDemo?: boolean;
  isReal?: boolean;
  label?: string;
  title?: string;
  detail?: string;
};

function brokerFromDashboard(data?: TradingDashboard | null): BrokerInfo {
  const raw = (data as TradingDashboard & { broker?: BrokerInfo } | undefined)?.broker;
  if (raw) return raw;
  const mt5 = data?.connections?.find((item) => item.id === 'mt5');
  const connected = mt5?.status === 'connected';
  return {
    connected: Boolean(connected),
    label: connected ? 'DEMO' : 'PAPER',
    title: connected ? 'Demo hisob' : 'Sinov rejimi',
    detail: connected
      ? (mt5?.detail ?? 'Exness MT5 ulangan.')
      : 'Brokerga buyurtma yuborilmaydi.',
  };
}

function AccountNotice({ broker }: { broker: BrokerInfo }) {
  if (broker.connected) {
    return <div className="flex flex-wrap items-center justify-between gap-3 border-b border-emerald-400/35 bg-emerald-50 px-4 py-2.5 text-[11px] font-semibold text-emerald-950 dark:bg-emerald-950/35 dark:text-emerald-100 sm:px-8">
      <div className="flex items-center gap-2"><ShieldCheck size={14} /><span><b>Exness {broker.label}</b> · #{broker.login} · {broker.name || broker.server}</span></div>
      <span className="flex items-center gap-1.5"><Coins size={13} /> Equity {money(broker.equity ?? undefined)} {broker.currency ?? 'USD'} · Balans {money(broker.balance ?? undefined)}</span>
    </div>;
  }
  return <div className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-300/40 bg-amber-50 px-4 py-2.5 text-[11px] font-semibold text-amber-950 dark:bg-amber-950/35 dark:text-amber-100 sm:px-8">
    <div className="flex items-center gap-2"><LockKeyhole size={14} /><span><b>Sinov (PAPER).</b> Exness MT5 hisobi hali ulanmagan.</span></div>
    <span className="flex items-center gap-1.5 text-amber-800 dark:text-amber-200"><Database size={13} /> Depozit ko‘rinishi uchun MT5 ulanishi kerak.</span>
  </div>;
}

function Shell({ children, current }: { children: ReactNode; current: string }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const dashboard = useGetTradingDashboard({ query: { refetchInterval: 5_000 } });
  const broker = brokerFromDashboard(dashboard.data);
  const aiConn = dashboard.data?.connections?.find((item) => item.id === 'ai');
  const modeTone = broker.connected ? (broker.isReal ? 'good' : 'gold') : 'warn';
  const statusDot = broker.connected ? (broker.isReal ? 'bg-emerald-400' : 'bg-sky-400') : 'bg-amber-400';
  return <div className="min-h-[100dvh] bg-background text-foreground">
    <aside className={cx('fixed inset-y-0 left-0 z-40 flex w-[252px] flex-col bg-sidebar text-sidebar-foreground transition-transform duration-200 md:translate-x-0', menuOpen ? 'translate-x-0' : '-translate-x-full')}>
      <div className="flex h-[76px] items-center gap-3 border-b border-sidebar-border px-6">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground"><ArrowLeftRight size={19} /></span>
        <div><p className="font-display text-[15px] font-bold tracking-tight">Mizan Trader</p><p className="font-mono text-[9px] uppercase tracking-[.17em] text-sidebar-foreground/55">XAU · BTC / {broker.label ?? 'PAPER'}</p></div>
        <button onClick={() => setMenuOpen(false)} className="ml-auto md:hidden" aria-label="Menyuni yopish"><X size={18} /></button>
      </div>
      <div className="mx-4 mt-5 rounded-lg border border-sidebar-border bg-sidebar-accent/50 p-3" data-testid="panel-execution-env">
        <div className="flex items-center justify-between"><span className="eyebrow text-sidebar-foreground/50">Ijro muhiti</span><span className={cx('h-2 w-2 rounded-full', statusDot)} /></div>
        <div className="mt-2 flex items-center justify-between gap-2"><span className="text-sm font-bold">{broker.title ?? 'Sinov rejimi'}</span><Badge tone={modeTone}>{broker.label ?? 'PAPER'}</Badge></div>
        {broker.connected ? (
          <div className="mt-2 space-y-1 text-[10px] leading-4 text-sidebar-foreground/70">
            <p className="font-semibold text-sidebar-foreground">#{broker.login} · {broker.name || 'Exness'}</p>
            <p>{broker.server} · 1:{broker.leverage ?? '—'}</p>
            <p>Balans: <span className="font-mono font-bold text-sidebar-foreground">{money(broker.balance ?? undefined)} {broker.currency ?? 'USD'}</span></p>
            <p>Equity: <span className="font-mono font-bold text-sidebar-foreground">{money(broker.equity ?? undefined)} {broker.currency ?? 'USD'}</span></p>
            <p>Mavjud: <span className="font-mono font-bold text-sidebar-foreground">{money(broker.marginFree ?? undefined)} {broker.currency ?? 'USD'}</span></p>
          </div>
        ) : (
          <p className="mt-2 text-[10px] leading-4 text-sidebar-foreground/55">{broker.detail ?? 'Brokerga buyurtma yuborilmaydi.'}</p>
        )}
      </div>
      <nav className="mt-7 flex-1 space-y-1 px-3">
        <p className="eyebrow mb-2 px-3 text-sidebar-foreground/40">Ish maydoni</p>
        {routes.map(({ href, label, icon: Icon }) => <Link key={href} href={href} data-testid={`link-nav-${href === '/' ? 'overview' : href.slice(1)}`} onClick={() => setMenuOpen(false)} className={cx('group flex h-11 items-center gap-3 rounded-lg px-3 text-[12px] font-bold transition-colors', current === href ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-sidebar-foreground/65 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground')}>
          <Icon size={16} className={current === href ? 'text-sidebar-primary' : ''} /><span>{label}</span>{current === href && <ChevronRight size={14} className="ml-auto text-sidebar-primary" />}
        </Link>)}
      </nav>
      <div className="m-4 rounded-lg border border-sidebar-border p-3">
        <div className="flex items-center gap-2 text-[11px] font-bold"><Sparkles size={14} className="text-sidebar-primary" /> AI provayder</div>
        <p className="mt-1.5 text-[10px] leading-4 text-sidebar-foreground/55">{aiConn?.status === 'connected' ? (aiConn.detail ?? 'OpenAI ulangan.') : 'Ulanmagan. Qarorlar qoidaga asoslangan.'}</p>
      </div>
      <div className="border-t border-sidebar-border px-5 py-4 text-[9px] text-sidebar-foreground/45">1.0.0 · Xavfsizlik birinchi o‘rinda</div>
    </aside>
    {menuOpen && <button aria-label="Menyuni yopish" onClick={() => setMenuOpen(false)} className="fixed inset-0 z-30 bg-slate-950/45 md:hidden" />}
    <main className="min-h-[100dvh] md:pl-[252px]">
      <header className="sticky top-0 z-20 flex h-[62px] items-center justify-between border-b border-border bg-background/95 px-4 backdrop-blur-md sm:px-8">
        <div className="flex items-center gap-3"><button onClick={() => setMenuOpen(true)} className="rounded-md p-1.5 hover:bg-muted md:hidden" aria-label="Menyuni ochish"><Menu size={18} /></button><p className="text-xs font-bold text-muted-foreground">{routes.find(route => route.href === current)?.label ?? 'Mizan Trader'}</p></div>
        <div className="flex items-center gap-3"><span className="hidden items-center gap-1.5 text-[10px] font-semibold text-muted-foreground sm:flex"><span className={cx('h-1.5 w-1.5 rounded-full', broker.connected ? 'bg-emerald-600' : 'bg-amber-500')} /> {broker.connected ? `Exness #${broker.login}` : 'Panel faol'}</span><div className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-card text-muted-foreground"><Bell size={15} /></div></div>
      </header>
      <AccountNotice broker={broker} />
      <div className="mx-auto max-w-[1520px] px-4 py-6 sm:px-8 sm:py-8">{children}</div>
      <footer className="border-t border-border px-4 py-5 text-center text-[10px] text-muted-foreground sm:px-8">{broker.connected ? `Ulangan hisob: Exness #${broker.login} · ${broker.server}. Investitsion maslahat berilmaydi.` : 'Sinov hisobidagi ko‘rsatkichlar real savdo natijasi emas. Investitsion maslahat berilmaydi.'}</footer>
    </main>
  </div>;
}
function Metric({ label, value, hint, icon: Icon, accent = false }: { label: string; value: string; hint?: string; icon: typeof Gauge; accent?: boolean }) {
  return <div className="panel min-w-0 p-4 sm:p-5"><div className="flex items-center justify-between"><span className="eyebrow">{label}</span><span className={cx('flex h-8 w-8 items-center justify-center rounded-lg', accent ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground')}><Icon size={15} /></span></div><p className="mt-3 truncate font-display text-[22px] font-semibold tracking-tight">{value}</p>{hint && <p className="mt-1 truncate text-[10px] text-muted-foreground">{hint}</p>}</div>;
}
function ConnectionList({ connections }: { connections: TradingDashboard['connections'] }) {
  const localized: Record<string, string> = { connected: 'Ulangan', disconnected: 'Ulanmagan', degraded: 'Cheklangan', unavailable: 'Mavjud emas' };
  return <div className="space-y-2">{connections.map(item => <div key={item.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/70 px-3 py-2.5" data-testid={`connection-${item.id}`}>
    <div className="min-w-0"><p className="truncate text-xs font-bold">{item.label}</p><p className="truncate text-[10px] text-muted-foreground">{item.detail}</p></div>
    <Badge tone={item.status === 'connected' ? 'good' : item.status === 'degraded' ? 'warn' : 'bad'}>{localized[item.status] ?? item.status}</Badge>
  </div>)}</div>;
}
function verdictUz(value?: string) {
  return value === 'auto_enter' ? 'Agent o‘zi kiradi' : value === 'manual_confirm' ? 'Bir tugma bilan kirish' : 'Kirish yo‘q';
}
function DecisionCard({ decision, onEntered }: { decision: SignalDecision; onEntered?: () => void }) {
  const [expanded, setExpanded] = useState(true);
  const enter = useEnterTradingSignal();
  const sideTone = decision.action === 'LONG' ? 'good' : decision.action === 'SHORT' ? 'bad' : 'neutral';
  const verdictTone = decision.agentVerdict === 'auto_enter' ? 'good' : decision.agentVerdict === 'manual_confirm' ? 'gold' : 'warn';
  const canEnter = decision.allowed && !decision.entered && decision.agentVerdict === 'manual_confirm';
  const doEnter = () => enter.mutate({ signalId: decision.id }, {
    onSuccess: () => onEntered?.(),
  });
  return <article className="rounded-xl border border-border bg-card p-4 shadow-[0_10px_30px_-24px_rgba(40,30,10,.55)]" data-testid={`card-decision-${decision.id}`}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><div className="flex flex-wrap items-center gap-2"><span className="font-mono text-xs font-bold">{decision.symbol}</span><Badge tone={sideTone}>{actionUz(decision.action)}</Badge><Badge tone={verdictTone}>{verdictUz(decision.agentVerdict)}</Badge></div><p className="mt-1 text-[10px] text-muted-foreground">{strategyUz(decision.strategy)} · {dateTime(decision.createdAt)}</p></div>
      <div className="text-right"><p className="font-mono text-sm font-bold">{money(decision.score, 0)}<span className="text-[10px] text-muted-foreground"> / 100</span></p><Badge tone={decision.allowed ? 'good' : 'warn'}>{decision.entered ? 'Kirilgan' : decision.allowed ? 'Ruxsat berilgan' : 'Bloklangan'}</Badge></div>
    </div>
    <div className="mt-4 grid gap-3 rounded-xl bg-gradient-to-br from-primary/8 via-card to-emerald-500/5 p-3 sm:grid-cols-3">
      <div className="sm:col-span-1"><p className="eyebrow mb-1">Prognoz</p><p className="text-[11px] leading-5 text-foreground/90">{decision.forecast || 'Aniq prognoz shakllanmagan — kirish yo‘q.'}</p></div>
      <div className="sm:col-span-1"><p className="eyebrow mb-1">Tahlil</p><p className="text-[11px] leading-5 text-foreground/90">{decision.analysis || 'Tahlil yetarli emas.'}</p></div>
      <div className="sm:col-span-1"><p className="eyebrow mb-1">Nima qilish</p><p className="text-[11px] leading-5 font-semibold text-foreground">{decision.recommendation || 'Kutish.'}</p></div>
    </div>
    <div className="mt-4 grid grid-cols-2 gap-2 border-y border-border/70 py-3 text-[10px] sm:grid-cols-4">
      <div><span className="eyebrow">Kirish</span><p className="mt-1 font-mono font-semibold">{decision.entryPrice == null ? '—' : money(decision.entryPrice, 2)}</p></div>
      <div><span className="eyebrow">Stop-loss</span><p className="mt-1 font-mono font-semibold">{decision.stopLoss == null ? '—' : money(decision.stopLoss, 2)}</p></div>
      <div><span className="eyebrow">Take-profit</span><p className="mt-1 font-mono font-semibold">{decision.takeProfit == null ? '—' : money(decision.takeProfit, 2)}</p></div>
      <div><span className="eyebrow">Risk / foyda</span><p className="mt-1 font-mono font-semibold">{decision.riskReward == null ? '—' : `${money(decision.riskReward, 2)} : 1`}</p></div>
    </div>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
      <p className="text-[10px] text-muted-foreground">Bozor: <span className="font-semibold text-foreground">{decision.marketRegime === 'high_volatility' ? 'Yuqori o‘zgaruvchanlik' : decision.marketRegime === 'trend' ? 'Trend' : decision.marketRegime === 'range' ? 'Oraliq' : 'Noma’lum'}</span> · Exness paper · {decision.dataSource}</p>
      <button onClick={() => setExpanded(v => !v)} data-testid={`button-explain-${decision.id}`} className="text-[10px] font-bold text-primary hover:underline">{expanded ? 'Sabablarni yopish' : 'Sabablar va qarshi dalillar'}</button>
    </div>
    {expanded && <div className="mt-3 grid gap-3 rounded-lg bg-muted/50 p-3 sm:grid-cols-2">
      <div><p className="eyebrow mb-2">Asosiy sabablar</p>{decision.reasons.length ? <ul className="space-y-1.5">{decision.reasons.map((reason, i) => <li key={i} className="flex gap-2 text-[10px] leading-4"><Check size={12} className="mt-0.5 shrink-0 text-emerald-700" />{reason}</li>)}</ul> : <p className="text-[10px] text-muted-foreground">Sabablar qayd etilmagan.</p>}</div>
      <div><p className="eyebrow mb-2">Qarshi dalillar</p>{decision.counterEvidence.length ? <ul className="space-y-1.5">{decision.counterEvidence.map((reason, i) => <li key={i} className="flex gap-2 text-[10px] leading-4"><AlertTriangle size={12} className="mt-0.5 shrink-0 text-amber-700" />{reason}</li>)}</ul> : <p className="text-[10px] text-muted-foreground">Qarshi dalil yo‘q — shartlar toza.</p>}</div>
    </div>}
    {canEnter && <Button className="mt-4 w-full min-h-11 text-sm" onClick={doEnter} disabled={enter.isPending} testId={`button-enter-${decision.id}`}>
      {enter.isPending ? <LoaderCircle className="animate-spin" size={15} /> : <Play size={15} />}
      Exness paper · Bir tugma bilan kirish
    </Button>}
    {decision.agentVerdict === 'auto_enter' && !decision.entered && <p className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-50/70 px-3 py-2 text-[10px] font-semibold text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-100">Agent ishonchi yuqori — dvigatel ishlayotganda o‘zi kiradi.</p>}
    {decision.agentVerdict === 'no_trade' && <p className="mt-3 rounded-lg border border-amber-400/35 bg-amber-50/70 px-3 py-2 text-[10px] text-amber-950 dark:bg-amber-950/20 dark:text-amber-100">Aniq ma’lumot/prognoz yo‘q yoki xavf bloki bor — kirish yopiq.</p>}
    {enter.isError && <p className="mt-2 text-[10px] text-destructive">Kirish bajarilmadi. Signal hali ham ruxsatli ekanini tekshiring.</p>}
  </article>;
}
function DashboardPage() {
  const dashboard = useGetTradingDashboard({ query: { refetchInterval: 5_000 } });
  const health = useHealthCheck({ query: { refetchInterval: 10_000 } });
  const client = useQueryClient();
  const engine = useControlTradingEngine();
  const evaluate = useEvaluateTradingSignal();
  const [feedback, setFeedback] = useState('');
  const d = dashboard.data;
  const connections = d?.connections ?? [];
  const refresh = () => {
    void client.invalidateQueries({ queryKey: getGetTradingDashboardQueryKey() });
    void client.invalidateQueries({ queryKey: getGetTradingSignalsQueryKey() });
    void client.invalidateQueries({ queryKey: getGetTradingPositionsQueryKey() });
  };
  const operate = (action: 'start' | 'pause' | 'stop' | 'kill-switch') => engine.mutate({ data: { action } }, {
    onSuccess: async () => { setFeedback('Agent dvigateli holati yangilandi.'); await Promise.all([client.invalidateQueries({ queryKey: getGetTradingDashboardQueryKey() }), client.invalidateQueries({ queryKey: getGetTradingAuditQueryKey() })]); },
    onError: () => setFeedback('Dvigatel holatini o‘zgartirib bo‘lmadi. Qayta urinib ko‘ring.'),
  });
  const runEval = (symbol: 'XAUUSD' | 'BTCUSDT') => evaluate.mutate({ data: { symbol } }, {
    onSuccess: async (signal) => {
      setFeedback(`${shortSymbol(symbol)}: ${verdictUz(signal.agentVerdict)} · ball ${signal.score}.`);
      await Promise.all([client.invalidateQueries({ queryKey: getGetTradingSignalsQueryKey() }), client.invalidateQueries({ queryKey: getGetTradingAuditQueryKey() }), refresh()]);
    },
    onError: () => setFeedback('Baholash bajarilmadi. Ulanish va ma’lumot holatini tekshiring.'),
  });
  if (dashboard.isLoading) return <Shell current="/dashboard"><div className="space-y-5"><div className="h-10 w-64 animate-pulse rounded bg-muted" /><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[1,2,3,4].map(n => <div key={n} className="h-28 animate-pulse rounded-xl bg-muted" />)}</div><LoadingRows /></div></Shell>;
  if (dashboard.isError || !d) return <Shell current="/dashboard"><ErrorState retry={refresh} text="Operatsion panelga ulanish imkoni bo‘lmadi." /></Shell>;
  const positive = d.account.dayPnl >= 0;
  const liveSignal = d.signals[0];
  const feed = d.liveFeed;
  const broker = brokerFromDashboard(d);
  const openPositions = d.positions.filter((item) => item.status === 'open');
  return <Shell current="/dashboard"><div className="animate-enter">
    <div className="mb-6 flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
      <div><div className="mb-2 flex items-center gap-2"><Badge tone={broker.connected ? (broker.isReal ? 'good' : 'gold') : 'warn'}>Exness · {broker.label ?? 'PAPER'} · Real-time</Badge><Badge tone="good">Plus-only · $0.10 · minus yo‘q</Badge><span className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-600" />Jonli yangilanadi · {dateTime(d.lastUpdatedAt)}</span></div><h1 className="font-display text-3xl font-semibold tracking-tight sm:text-[38px]">Real-time kuzatuv paneli</h1><p className="mt-2 max-w-xl text-xs leading-5 text-muted-foreground">Faqat aniq prognoz/yangilik/AI tasdiqida kiradi · risk $0.1. Minus bo‘lishi mumkin zilka ochilmaydi; imkoniyat bo‘lsa XAU+BTC ikkalasiga ham kiradi.</p></div>
      <div className="flex flex-wrap gap-2">
        {d.engineState === 'running' ? <Button variant="outline" disabled={engine.isPending} onClick={() => operate('pause')} testId="button-engine-pause"><Square size={13} /> Pauza</Button> : <Button disabled={engine.isPending} onClick={() => operate('start')} testId="button-engine-start"><Play size={13} /> Agentni ishga tushirish</Button>}
        {d.engineState !== 'stopped' && <><Button variant="outline" disabled={engine.isPending} onClick={() => operate('stop')} testId="button-engine-stop"><Square size={13} /> To‘xtatish</Button><Button variant="danger" disabled={engine.isPending} onClick={() => operate('kill-switch')} testId="button-engine-kill"><AlertOctagon size={14} /> Favqulodda to‘xtatish</Button></>}
      </div>
    </div>
    {feedback && <div className="mb-4 flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2 text-xs" role="status">{feedback}<button onClick={() => setFeedback('')} aria-label="Xabarni yopish"><X size={14} /></button></div>}
    <section className="mb-5 overflow-hidden rounded-2xl border border-emerald-500/25 bg-gradient-to-br from-emerald-500/10 via-card to-card p-4 sm:p-5">
      <SectionTitle kicker="Jonli agent" title="Nima qilyapti hozir" trailing={<Badge tone={d.engineState === 'running' ? 'good' : 'warn'}>{feed?.agentStatus ?? stateUz(d.engineState)}</Badge>} />
      <div className="grid gap-3 lg:grid-cols-[1.2fr_1fr]">
        <div className="rounded-xl border border-border/70 bg-background/70 p-4">
          <p className="eyebrow">Joriy harakat</p>
          <p className="mt-2 font-display text-lg font-semibold tracking-tight">{feed?.currentAction ?? 'Kuzatuv yuklanmoqda…'}</p>
          <div className="mt-3 flex flex-wrap gap-2 text-[10px]">
            <Badge tone="gold">Kuzatuv: {(feed?.watching ?? d.assets.map(a => a.symbol)).join(' · ')}</Badge>
            <Badge tone={feed?.lastVerdict === 'auto_enter' ? 'good' : feed?.lastVerdict === 'manual_confirm' ? 'gold' : 'warn'}>{verdictUz(feed?.lastVerdict ?? 'no_trade')}</Badge>
            {feed?.lastSymbol && <Badge tone="neutral">{feed.lastSymbol} · ball {feed.lastScore ?? '—'}</Badge>}
            <Badge tone="good">Bazaviy risk ${money(feed?.baseRiskUsd ?? 0.1, 2)}</Badge>
          </div>
          <p className="mt-3 text-[10px] leading-4 text-muted-foreground">Ma’lumot: {d.dataQuality.provider} · {d.dataQuality.detail}</p>
        </div>
        <div className="rounded-xl border border-border/70 bg-background/70 p-4">
          <p className="eyebrow mb-2">Ochiq zilka · aniq reja (silif yo‘q)</p>
          {(((feed as { tradePlans?: Array<{
            ticket: number; symbol: string; side: string; volume: number; openedAt: number;
            currentPnl: number; stopLoss: number; takeProfit: number; maxMinusUsd: number;
            planPlusUsd: number; closePlan: string; slipPolicy: string;
          }> } | undefined)?.tradePlans) ?? []).length === 0 && openPositions.length === 0
            ? <p className="text-[11px] text-muted-foreground">Hozir ochiq savdo yo‘q. Aniq BUY yoki SELL bo‘lsa agent kiradi.</p>
            : <div className="space-y-2.5">
                {(((feed as { tradePlans?: Array<{
                  ticket: number; symbol: string; side: string; volume: number; openedAt: number;
                  currentPnl: number; stopLoss: number; takeProfit: number; maxMinusUsd: number;
                  planPlusUsd: number; closePlan: string; slipPolicy: string;
                }> })?.tradePlans) ?? openPositions.map(pos => ({
                  ticket: pos.id, symbol: pos.symbol, side: pos.side, volume: pos.quantity,
                  openedAt: pos.entryPrice, currentPnl: pos.unrealizedPnl, stopLoss: pos.stopLoss,
                  takeProfit: pos.takeProfit,
                  maxMinusUsd: Math.abs(pos.entryPrice - pos.stopLoss) * pos.quantity,
                  planPlusUsd: Math.abs(pos.takeProfit - pos.entryPrice) * pos.quantity,
                  closePlan: '', slipPolicy: '',
                }))).map((plan) => {
                  const up = plan.currentPnl >= 0;
                  return <div key={plan.ticket} className="rounded-lg border border-border/60 px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-mono text-xs font-bold">{plan.symbol} · {plan.side === 'LONG' || plan.side === 'BUY' ? 'BUY' : 'SELL'} · {money(plan.volume, 2)} lot</p>
                      <p className={cx('font-mono text-sm font-bold', up ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-600 dark:text-red-300')}>{up ? '+' : ''}{money(plan.currentPnl)} USD</p>
                    </div>
                    <p className="mt-1 text-[10px] leading-4 text-muted-foreground">Ochilgan: <span className="font-semibold text-foreground">{money(plan.openedAt)}</span> · Yopish TP: <span className="font-semibold text-emerald-700">{money(plan.takeProfit)}</span> (≈+${money(plan.planPlusUsd)}) · SL: <span className="font-semibold text-red-600">{money(plan.stopLoss)}</span> (maks minus ≈−${money(plan.maxMinusUsd)})</p>
                    <p className="mt-0.5 text-[9px] text-muted-foreground">#{plan.ticket} · Silif qoldirilmaydi — minus oshsa agent yopadi.</p>
                  </div>;
                })}
              </div>}
        </div>
      </div>
      <div className="mt-4 max-h-48 space-y-2 overflow-auto pr-1">
        {(feed?.events ?? []).length ? feed!.events.map((event) => (
          <div key={event.id} className="flex items-start justify-between gap-3 rounded-lg border border-border/60 px-3 py-2 text-[10px]">
            <div className="min-w-0"><p className="font-semibold text-foreground">{event.message}</p><p className="mt-0.5 text-muted-foreground">{event.kind} · {dateTime(event.at)}</p></div>
            <Badge tone={event.tone === 'good' ? 'good' : event.tone === 'bad' ? 'bad' : 'neutral'}>{event.tone === 'good' ? 'Plus' : event.tone === 'bad' ? 'Minus' : 'Info'}</Badge>
          </div>
        )) : <p className="text-[10px] text-muted-foreground">Hali jonli hodisa yo‘q — agent ishga tushgach ochish/yopish shu yerda ko‘rinadi.</p>}
      </div>
    </section>
    <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Metric label="Hisob kapitali" value={`${money(d.account.equity)} ${d.account.currency}`} hint={`Balans: ${money(d.account.balance)} ${d.account.currency}`} icon={Coins} accent />
      <Metric label="Kunlik natija" value={`${positive ? '+' : ''}${money(d.account.dayPnl)} ${d.account.currency}`} hint={`Hafta: ${d.account.weekPnl >= 0 ? '+' : ''}${money(d.account.weekPnl)} ${d.account.currency}`} icon={positive ? ArrowUpRight : ArrowDownRight} />
      <Metric label="Joriy drawdown" value={`${money(d.account.currentDrawdownPct, 2)}%`} hint={`Maksimum: ${money(d.risk.maxDrawdownPct, 2)}%`} icon={Activity} />
      <Metric label="Ochiq xavf" value={`${money(d.risk.openRiskPct, 2)}%`} hint={`Kunlik limit: ${money(d.risk.dailyLossUsedPct, 2)} / ${money(d.risk.dailyLossLimitPct, 2)}%`} icon={Shield} />
    </div>
    <div className="mb-5 grid gap-3 sm:grid-cols-3">
      <div className="panel flex items-center justify-between gap-3 px-4 py-3"><div><p className="eyebrow">Mavjud mablag‘</p><p className="mt-1 font-mono text-sm font-bold">{money(d.account.availableBalance)} {d.account.currency}</p></div><Coins size={16} className="text-primary" /></div>
      <div className="panel flex items-center justify-between gap-3 px-4 py-3"><div><p className="eyebrow">Haftalik natija</p><p className={cx('mt-1 font-mono text-sm font-bold', d.account.weekPnl >= 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300')}>{d.account.weekPnl >= 0 ? '+' : ''}{money(d.account.weekPnl)} {d.account.currency}</p></div><Activity size={16} className="text-muted-foreground" /></div>
      <div className="panel flex items-center justify-between gap-3 px-4 py-3"><div><p className="eyebrow">Oylik natija</p><p className={cx('mt-1 font-mono text-sm font-bold', d.account.monthPnl >= 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300')}>{d.account.monthPnl >= 0 ? '+' : ''}{money(d.account.monthPnl)} {d.account.currency}</p></div><BarChart3 size={16} className="text-muted-foreground" /></div>
    </div>
    <section className="mb-5" data-testid="workspace-gold-btc">
      <SectionTitle
        kicker="Ish maydoni · MT5 uslubi"
        title="Chapda Oltin · o‘ngda Bitcoin"
        trailing={<Badge tone="good">Tahlil + kirish/chiqish chiziqlari</Badge>}
      />
      <p className="mb-3 max-w-3xl text-[11px] leading-5 text-muted-foreground">
        Har bir panelda shamcha, qayerga boradi (TP strelka), qayerdan qaytadi (swing zona), Kirish / SL / TP. Qaysi bozor aniqroq bo‘lsa (XAU/BTC) agent shunga kiradi; ochilgan zilkani o‘zi yopadi.
      </p>
      <div className="grid gap-4 xl:grid-cols-2">
        {(((d as TradingDashboard & { charts?: AnalysisChart[] }).charts) ?? [])
          .slice()
          .sort((a, b) => (a.symbol === 'XAUUSD' ? -1 : b.symbol === 'XAUUSD' ? 1 : 0))
          .map((chart) => (
            <CandleAnalysisChart key={chart.symbol} chart={chart} />
          ))}
      </div>
    </section>
    <div className="mb-5 grid gap-4 xl:grid-cols-[1.6fr_1fr]">
      <section className="panel p-4 sm:p-5">
        <SectionTitle kicker="Xavfsizlik nazorati" title="Operatsion holat" trailing={<Badge tone={d.risk.status === 'clear' ? 'good' : 'bad'}>{d.risk.status === 'clear' ? 'Chegaralar ichida' : 'Xavf bloki'}</Badge>} />
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg bg-muted/60 p-3"><p className="eyebrow">Dvigatel</p><div className="mt-2 flex items-center gap-2"><span className={cx('h-2 w-2 rounded-full', d.engineState === 'running' ? 'bg-emerald-600' : 'bg-amber-500')} /><p className="text-sm font-bold">{stateUz(d.engineState)}</p></div><p className="mt-1 text-[10px] text-muted-foreground">{broker.connected ? `Exness ${broker.label} · #${broker.login}` : 'Faqat virtual ijro'}</p></div>
          <div className="rounded-lg bg-muted/60 p-3"><p className="eyebrow">Ma’lumot sifati</p><div className="mt-2"><Badge tone={d.dataQuality.status === 'simulated' ? 'warn' : d.dataQuality.status === 'blocked' ? 'bad' : 'neutral'}>{d.dataQuality.status === 'simulated' ? 'Sintetik' : d.dataQuality.status === 'degraded' ? 'Cheklangan' : 'Bloklangan'}</Badge></div><p className="mt-1.5 text-[10px] text-muted-foreground">{d.dataQuality.detail}</p><p className="mt-2 text-[9px] leading-4 text-muted-foreground">Manba: {d.dataQuality.provider} · kotirovka yoshi {money(d.dataQuality.quoteAgeSeconds, 0)} soniya</p><p className="text-[9px] text-muted-foreground">Eskirgan: {d.dataQuality.stale ? 'ha' : 'yo‘q'} · spred: {d.dataQuality.spreadHealthy ? 'sog‘lom' : 'tekshirish kerak'} · vaqt belgisi: {d.dataQuality.timestampHealthy ? 'sog‘lom' : 'tekshirish kerak'}</p></div>
          <div className="rounded-lg bg-muted/60 p-3"><p className="eyebrow">Sog‘liq tekshiruvi</p><div className="mt-2 flex items-center gap-2"><span className={cx('h-2 w-2 rounded-full', health.isSuccess ? 'bg-emerald-600' : health.isError ? 'bg-red-600' : 'bg-amber-500')} /><p className="text-sm font-bold">{health.data?.status ?? (health.isError ? 'Ulanishda xatolik' : 'Tekshirilmoqda')}</p></div><p className="mt-1 text-[10px] text-muted-foreground">{broker.connected ? `Hisob jonli · equity ${money(d.account.equity)} ${d.account.currency}` : 'Jonli ijro: o‘chiq'}</p></div>
        </div>
        {d.risk.reasons.length > 0 && <div className="mt-3 rounded-lg border border-amber-400/35 bg-amber-50/70 px-3 py-2.5 dark:bg-amber-950/20"><p className="mb-1 text-[10px] font-extrabold text-amber-900 dark:text-amber-200">Xavf sabab va ogohlantirishlari</p><ul className="space-y-1">{d.risk.reasons.map((reason, i) => <li key={i} className="flex gap-2 text-[10px] text-foreground/80"><AlertTriangle size={12} className="shrink-0 text-amber-700" />{reason}</li>)}</ul></div>}
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {[{ label: 'Kunlik zarar limiti', used: d.risk.dailyLossUsedPct, limit: d.risk.dailyLossLimitPct }, { label: 'Haftalik zarar limiti', used: d.risk.weeklyLossUsedPct, limit: d.risk.weeklyLossLimitPct }].map(item => {
            const pct = item.limit > 0 ? Math.min(100, Math.max(0, item.used / item.limit * 100)) : 0;
            return <div key={item.label} className="rounded-lg border border-border/70 px-3 py-2.5"><div className="flex justify-between gap-2 text-[10px]"><span className="font-bold">{item.label}</span><span className="font-mono text-muted-foreground">{money(item.used, 2)} / {money(item.limit, 2)}%</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"><div className={cx('h-full rounded-full transition-[width] duration-300', pct > 80 ? 'bg-destructive' : 'bg-primary')} style={{ width: `${pct}%` }} /></div></div>;
          })}
        </div>
      </section>
      <section className="panel p-4 sm:p-5"><SectionTitle kicker="Exness · Integratsiyalar" title="Ulanishlar" /><ConnectionList connections={connections} /><p className="mt-3 rounded-lg bg-muted/60 px-3 py-2 text-[10px] leading-4 text-muted-foreground">{broker.connected ? `MT5 hisob ulangan: #${broker.login} · ${broker.name} · ${broker.server}. Depozit/equity har 5 soniyada yangilanadi.` : 'Live narx + AI + taqvim ulanadi. Exness MT5 terminal login qilinganda depozit shu yerda chiqadi.'}</p></section>
    </div>
    {liveSignal && <section className="mb-5 panel overflow-hidden border-primary/25 bg-gradient-to-br from-primary/10 via-card to-card p-4 sm:p-5">
      <SectionTitle kicker="Agent · so‘nggi qaror" title="Prognoz va kirish holati" trailing={<Badge tone={liveSignal.agentVerdict === 'auto_enter' ? 'good' : liveSignal.agentVerdict === 'manual_confirm' ? 'gold' : 'warn'}>{verdictUz(liveSignal.agentVerdict)}</Badge>} />
      <DecisionCard decision={liveSignal} onEntered={() => { setFeedback('Bir tugmali kirish bajarildi.'); refresh(); }} />
    </section>}
    <section className="mb-5">
      <SectionTitle kicker="Real-time kuzatuv" title="Aktivlar" trailing={<Button variant="ghost" onClick={refresh} testId="button-refresh-dashboard"><RefreshCw size={13} /> Yangilash</Button>} />
      {d.assets.length === 0 ? <EmptyState title="Aktivlar yo‘q" body="API hozircha instrument snapshotlarini qaytarmadi." /> :
        <div className="grid gap-3 lg:grid-cols-2">{d.assets.map(asset => <article key={asset.symbol} className="panel market-grid overflow-hidden p-4 sm:p-5" data-testid={`asset-${asset.symbol}`}>
          <div className="flex items-start justify-between gap-4"><div className="flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15 text-primary">{asset.symbol === 'BTCUSDT' ? <Bitcoin size={20} /> : <Coins size={20} />}</span><div><p className="font-display text-lg font-semibold">{asset.label}</p><p className="font-mono text-[10px] text-muted-foreground">{asset.symbol} · {asset.timeframe}</p></div></div><Badge tone={asset.change24hPct >= 0 ? 'good' : 'bad'}>{asset.change24hPct >= 0 ? '+' : ''}{money(asset.change24hPct, 2)}%</Badge></div>
          <div className="mt-4 flex items-end justify-between"><div><p className="eyebrow">Ko‘rsatilgan narx · {asset.source}</p><p className="mt-1 font-mono text-2xl font-medium tracking-tight">{money(asset.price, asset.symbol === 'BTCUSDT' ? 2 : 2)}</p></div><div className="text-right text-[10px] leading-5 text-muted-foreground">Bid {money(asset.bid, 2)}<br />Ask {money(asset.ask, 2)}</div></div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-3 text-[10px]"><span className="text-muted-foreground">Trend · {asset.trend === 'uptrend' ? 'O‘sish' : asset.trend === 'downtrend' ? 'Pasayish' : asset.trend === 'range' ? 'Oraliq' : 'Noma’lum'} · 24 soatlik hajm {money(asset.volume24h, 0)}</span><Badge tone={asset.isSynthetic ? 'warn' : 'good'}>{asset.isSynthetic ? 'Fallback' : 'Live API'}</Badge></div>
          <Button className="mt-3 w-full" variant="outline" onClick={() => runEval(asset.symbol)} disabled={evaluate.isPending} testId={`button-evaluate-${asset.symbol}`}>{evaluate.isPending ? <LoaderCircle className="animate-spin" size={14} /> : <Sparkles size={14} />} Analiz + prognozni yangilash</Button>
        </article>)}</div>}
      <p className="mt-2 text-[10px] leading-4 text-muted-foreground">Narxlar sinov oqimi. Aniq tahlil va prognoz bo‘lmasa agent kirmaydi.</p>
    </section>
    <div className="grid gap-5 xl:grid-cols-[1.45fr_1fr]">
      <section><SectionTitle kicker="Tushuntiriladigan qarorlar" title="So‘nggi signallar" trailing={<Link href="/journal" className="text-[10px] font-extrabold text-primary">Jurnalga o‘tish <ChevronRight size={13} className="inline" /></Link>} />
        {d.signals.length ? <div className="space-y-3">{d.signals.slice(0, 4).map(signal => <DecisionCard key={signal.id} decision={signal} onEntered={() => { setFeedback('Kirish ochildi.'); refresh(); }} />)}</div> : <EmptyState title="Hali qaror yo‘q" body="Aktiv uchun baholashni ishga tushiring. Prognoz, sabab va tavsiya shu yerda ochiladi." />}
      </section>
      <section><SectionTitle kicker="Yaqin voqealar" title="Iqtisodiy taqvim" />
        {d.calendarEvents.length ? <div className="panel divide-y divide-border/70">{d.calendarEvents.slice(0, 5).map(event => <div key={event.id} className="flex items-center justify-between gap-3 px-4 py-3"><div className="min-w-0"><p className="truncate text-xs font-bold">{event.title}</p><p className="mt-1 text-[10px] text-muted-foreground">{event.currency} · {dateTime(event.scheduledAt)}</p></div><Badge tone={event.impact === 'high' ? 'bad' : event.impact === 'medium' ? 'warn' : 'neutral'}>{event.impact === 'high' ? 'Yuqori' : event.impact === 'medium' ? 'O‘rta' : 'Past'}</Badge></div>)}</div> : <EmptyState title="Taqvim hodisasi yo‘q" body="API iqtisodiy taqvim ma’lumotini hozircha bermadi." />}
      </section>
    </div>
    <section className="mt-5"><SectionTitle kicker="Tizim yozuvlari" title="So‘nggi audit" trailing={<Link href="/journal" className="text-[10px] font-extrabold text-primary">To‘liq jurnal <ChevronRight size={13} className="inline" /></Link>} />
      {d.recentAudit.length ? <div className="panel divide-y divide-border/70">{d.recentAudit.slice(0, 4).map(event => <AuditRow key={event.id} event={event} />)}</div> : <EmptyState title="Audit yozuvi yo‘q" body="Boshqaruv va sinov amallari sodir bo‘lgach, qisqacha tarix shu yerda ko‘rinadi." />}
    </section>
  </div></Shell>;
}

function PositionRow({ position, close, pending }: { position: TradingPosition; close: () => void; pending: boolean }) {
  const [confirm, setConfirm] = useState(false);
  const tone = position.unrealizedPnl >= 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300';
  return <div className="grid gap-3 border-b border-border/70 px-4 py-4 last:border-0 md:grid-cols-[1.1fr_1fr_1fr_1fr_auto] md:items-center" data-testid={`position-row-${position.id}`}>
    <div><p className="font-mono text-xs font-bold">{position.symbol}</p><p className="mt-1 text-[10px] text-muted-foreground">{position.side === 'LONG' ? 'Xarid pozitsiyasi' : 'Sotuv pozitsiyasi'} · {dateTime(position.openedAt)}</p></div>
    <div><p className="eyebrow">Kirish / joriy</p><p className="mt-1 font-mono text-[11px]">{money(position.entryPrice)} / {money(position.currentPrice)}</p></div>
    <div><p className="eyebrow">Stop / maqsad</p><p className="mt-1 font-mono text-[11px]">{money(position.stopLoss)} / {money(position.takeProfit)}</p></div>
    <div><p className="eyebrow">Hajm · xavf · P/L</p><p className="mt-1 font-mono text-[11px]">{money(position.quantity, 4)} · {money(position.riskAmount)} · <span className={tone}>{position.unrealizedPnl >= 0 ? '+' : ''}{money(position.unrealizedPnl)}</span></p></div>
    <div className="flex justify-start md:justify-end">{position.status === 'open' ? confirm ? <div className="flex gap-1.5"><Button variant="danger" className="min-h-8 px-2.5" onClick={close} disabled={pending} testId={`button-confirm-close-${position.id}`}>{pending ? 'Yopilmoqda' : 'Tasdiqlash'}</Button><Button className="min-h-8 px-2" variant="ghost" onClick={() => setConfirm(false)}>Bekor</Button></div> : <Button variant="outline" className="min-h-8" onClick={() => setConfirm(true)} testId={`button-close-${position.id}`}>Qog‘ozda yopish</Button> : <Badge>Yopilgan</Badge>}</div>
  </div>;
}
function JournalPage() {
  const client = useQueryClient();
  const dashboard = useGetTradingDashboard();
  const signals = useGetTradingSignals();
  const positions = useGetTradingPositions();
  const audit = useGetTradingAudit({ limit: 50 });
  const closePosition = useCloseTradingPosition();
  const [tab, setTab] = useState<'positions' | 'decisions' | 'audit'>('positions');
  const [feedback, setFeedback] = useState('');
  const refresh = () => {
    void client.invalidateQueries({ queryKey: getGetTradingPositionsQueryKey() });
    void client.invalidateQueries({ queryKey: getGetTradingSignalsQueryKey() });
    void client.invalidateQueries({ queryKey: getGetTradingAuditQueryKey({ limit: 50 }) });
  };
  const close = (positionId: number) => closePosition.mutate({ positionId }, {
    onSuccess: async () => {
      setFeedback('Qog‘oz pozitsiyasi yopildi.');
      await Promise.all([client.invalidateQueries({ queryKey: getGetTradingPositionsQueryKey() }), client.invalidateQueries({ queryKey: getGetTradingDashboardQueryKey() }), client.invalidateQueries({ queryKey: getGetTradingAuditQueryKey({ limit: 50 }) })]);
    },
    onError: () => setFeedback('Pozitsiyani yopib bo‘lmadi. Qayta urinib ko‘ring.'),
  });
  const anyLoading = positions.isLoading || signals.isLoading || audit.isLoading;
  const anyError = positions.isError || signals.isError || audit.isError;
  return <Shell current="/journal"><div className="animate-enter">
    <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><Badge tone="gold">Audit izi saqlanadi</Badge><h1 className="mt-3 font-display text-3xl font-semibold tracking-tight">Savdo jurnali</h1><p className="mt-2 max-w-2xl text-xs leading-5 text-muted-foreground">Ochiq qog‘oz pozitsiyalar, strategiya qarorlari va tizim hodisalari. Bu yozuvlar real broker ijrosi emas.</p></div><div className="flex items-center gap-2 text-[10px] text-muted-foreground"><ShieldCheck size={14} /> PAPER muhit · jonli ijro o‘chiq</div></div>
    {dashboard.data && <div className="mb-5 grid gap-3 sm:grid-cols-3">
      <Metric label="Ochiq pozitsiyalar" value={String(dashboard.data.positions.filter(p => p.status === 'open').length)} hint="Faqat simulyatsiya" icon={ArrowLeftRight} accent />
      <Metric label="So‘nggi qarorlar" value={String(dashboard.data.signals.length)} hint="Tushuntirish bilan" icon={Sparkles} />
      <Metric label="Xavf holati" value={dashboard.data.risk.status === 'clear' ? 'Chegaralar ichida' : 'Bloklangan'} hint={`Ochiq xavf ${money(dashboard.data.risk.openRiskPct, 2)}%`} icon={Shield} />
    </div>}
    {feedback && <div role="status" className="mb-4 flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2 text-xs">{feedback}<button aria-label="Xabarni yopish" onClick={() => setFeedback('')}><X size={13} /></button></div>}
    <div className="mb-4 flex flex-wrap gap-2 border-b border-border pb-3">
      {(['positions', 'decisions', 'audit'] as const).map(key => <button key={key} onClick={() => setTab(key)} data-testid={`tab-${key}`} className={cx('rounded-lg px-3 py-2 text-xs font-extrabold transition', tab === key ? 'bg-sidebar text-sidebar-foreground' : 'text-muted-foreground hover:bg-muted')}>
        {key === 'positions' ? 'Pozitsiyalar' : key === 'decisions' ? 'Qarorlar' : 'Audit tarixi'}
      </button>)}
      <Button variant="ghost" className="ml-auto" onClick={refresh} testId="button-refresh-journal"><RefreshCw size={13} /> Yangilash</Button>
    </div>
    {anyLoading ? <LoadingRows count={4} /> : anyError ? <ErrorState retry={refresh} text="Jurnal yozuvlaridan ayrimlarini yuklab bo‘lmadi." /> : <>
      {tab === 'positions' && (positions.data?.length ? <div className="panel overflow-hidden"><div className="border-b border-border bg-muted/50 px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Pozitsiyalar · yopish faqat qog‘oz hisobga ta’sir qiladi</div>{positions.data.map(position => <PositionRow key={position.id} position={position} close={() => close(position.id)} pending={closePosition.isPending} />)}</div> : <EmptyState title="Pozitsiya mavjud emas" body="Hozircha qog‘oz hisobda ochiq yoki yopilgan pozitsiyalar qaytmadi." />)}
      {tab === 'decisions' && (signals.data?.length ? <div className="space-y-3">{signals.data.map(signal => <DecisionCard key={signal.id} decision={signal} />)}</div> : <EmptyState title="Qarorlar tarixi bo‘sh" body="Baholash bajarilgandan so‘ng signallar va qarshi dalillar shu yerda saqlanadi." />)}
      {tab === 'audit' && (audit.data?.length ? <div className="panel divide-y divide-border/70">{audit.data.map(event => <AuditRow key={event.id} event={event} />)}</div> : <EmptyState title="Audit hodisasi yo‘q" body="Dvigatel va qog‘oz pozitsiya amallari qayd etilgach, bu yerda ko‘rinadi." />)}
    </>}
  </div></Shell>;
}
function AuditRow({ event }: { event: AuditEvent }) {
  const tone = event.severity === 'critical' ? 'bad' : event.severity === 'warning' ? 'warn' : 'neutral';
  const [open, setOpen] = useState(false);
  const hasDetails = Object.keys(event.details ?? {}).length > 0;
  return <div className="px-4 py-3" data-testid={`audit-event-${event.id}`}>
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="flex min-w-0 gap-3"><span className="mt-1 text-muted-foreground"><Clock3 size={14} /></span><div className="min-w-0"><p className="text-xs font-semibold">{event.message}</p><p className="mt-1 text-[10px] text-muted-foreground">{event.eventType}{event.symbol ? ` · ${event.symbol}` : ''} · {dateTime(event.createdAt)}</p></div></div><Badge tone={tone}>{event.severity === 'critical' ? 'Muhim' : event.severity === 'warning' ? 'Ogohlantirish' : 'Ma’lumot'}</Badge></div>
    {hasDetails && <button onClick={() => setOpen(v => !v)} className="ml-7 mt-2 text-[10px] font-bold text-primary">{open ? 'Tafsilotni yashirish' : 'Tafsilotlar'}</button>}
    {open && <pre className="ml-7 mt-2 max-h-40 overflow-auto rounded-lg bg-muted p-3 font-mono text-[10px]">{JSON.stringify(event.details, null, 2)}</pre>}
  </div>;
}

function EquityChart({ run }: { run: BacktestRun }) {
  const points = run.equityCurve;
  if (!points.length) return <EmptyState title="Kapital chizig‘i yo‘q" body="Ushbu natijada equity curve ma’lumoti berilmagan." />;
  const values = points.map(point => point.equity);
  const min = Math.min(...values); const max = Math.max(...values); const range = max - min || 1;
  const coords = values.map((value, index) => `${(index / Math.max(1, values.length - 1)) * 100},${94 - ((value - min) / range) * 80}`).join(' ');
  const positive = values[values.length - 1] >= values[0];
  return <div className="panel p-4 sm:p-5" data-testid={`chart-equity-${run.id}`}>
    <div className="mb-4 flex items-start justify-between"><div><p className="eyebrow">Kapital trayektoriyasi</p><p className="mt-1 font-display text-lg font-semibold">{money(values[0])} <span className="text-muted-foreground">→</span> {money(values[values.length - 1])}</p></div><Badge tone={positive ? 'good' : 'bad'}>{positive ? 'Yakuniy o‘sish' : 'Yakuniy pasayish'}</Badge></div>
    <div className="market-grid h-44 rounded-lg border border-border/70 p-2"><svg className="h-full w-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Sintetik backtest kapital grafigi"><polyline points={coords} fill="none" stroke={positive ? 'hsl(158 42% 37%)' : 'hsl(3 64% 54%)'} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" /><circle cx="100" cy={coords.split(' ').slice(-1)[0]?.split(',')[1] ?? '50'} r="1.8" fill="hsl(39 77% 48%)" vectorEffect="non-scaling-stroke" /></svg></div>
    <div className="mt-2 flex justify-between text-[9px] text-muted-foreground"><span>{dateTime(points[0]?.timestamp)}</span><span>{dateTime(points[points.length - 1]?.timestamp)}</span></div>
  </div>;
}
function BacktestPage() {
  const client = useQueryClient();
  const backtests = useGetTradingBacktests();
  const settings = useGetTradingSettings();
  const runBacktest = useRunTradingBacktest();
  const [symbol, setSymbol] = useState<BacktestInput['symbol']>('XAUUSD');
  const [strategy, setStrategy] = useState<BacktestInput['strategy']>('gold-breakout-retest');
  const [initialBalance, setInitialBalance] = useState('10000');
  const [risk, setRisk] = useState('0.25');
  const [fees, setFees] = useState('6');
  const [slippage, setSlippage] = useState('8');
  const [selected, setSelected] = useState<number | null>(null);
  const [feedback, setFeedback] = useState('');
  useEffect(() => { if (settings.data) { setInitialBalance(String(settings.data.initialBalance)); setRisk(String(settings.data.riskPerTradePct)); } }, [settings.data?.initialBalance, settings.data?.riskPerTradePct]);
  useEffect(() => { setStrategy(symbol === 'XAUUSD' ? 'gold-breakout-retest' : 'btc-trend-momentum'); }, [symbol]);
  const refresh = () => client.invalidateQueries({ queryKey: getGetTradingBacktestsQueryKey() });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const payload: BacktestInput = { symbol, strategy, initialBalance: Number(initialBalance), riskPerTradePct: Number(risk), feeBps: Number(fees), slippageBps: Number(slippage) };
    if (![payload.initialBalance, payload.riskPerTradePct, payload.feeBps, payload.slippageBps].every(Number.isFinite) || payload.initialBalance < 100 || payload.riskPerTradePct < .05 || payload.riskPerTradePct > .5) {
      setFeedback('Qiymatlarni tekshiring: balans kamida 100, savdo xavfi 0.05%–0.5% bo‘lishi kerak.'); return;
    }
    runBacktest.mutate({ data: payload }, { onSuccess: async result => { setSelected(result.id); setFeedback('Sintetik namunada backtest yakunlandi. Natija bozor tarixini bildirmaydi.'); await Promise.all([refresh(), client.invalidateQueries({ queryKey: getGetTradingAuditQueryKey() })]); }, onError: () => setFeedback('Backtest bajarilmadi. Kiritilgan qiymatlarni tekshiring.') });
  };
  const runs = backtests.data ?? [];
  const activeRun = runs.find(run => run.id === selected) ?? runs[0];
  return <Shell current="/backtests"><div className="animate-enter">
    <div className="mb-6 flex flex-col justify-between gap-4 lg:flex-row lg:items-end"><div><Badge tone="warn"><Database size={11} /> Sintetik dataset</Badge><h1 className="mt-3 font-display text-3xl font-semibold tracking-tight">Strategiya backtesti</h1><p className="mt-2 max-w-2xl text-xs leading-5 text-muted-foreground">Qoidalarni sintetik namunada ko‘ring. Komissiya va sirpanish hisobga olinadi; bu natijalar kelajakni yoki real bozor tarixini ifodalamaydi.</p></div><Button variant="outline" onClick={() => void refresh()} testId="button-refresh-backtests"><RefreshCw size={13} /> Natijalarni yangilash</Button></div>
    <div className="mb-5 grid items-start gap-5 xl:grid-cols-[340px_1fr]">
      <form className="panel p-4 sm:p-5" onSubmit={submit}>
        <SectionTitle kicker="Sinov parametrlari" title="Backtestni sozlash" />
        <div className="space-y-4">
          <label className="block"><span className="eyebrow">Instrument</span><select value={symbol} onChange={e => setSymbol(e.target.value as BacktestInput['symbol'])} data-testid="select-backtest-symbol" className="mt-1.5 h-10 w-full rounded-lg border border-input bg-background px-3 text-xs"><option value="XAUUSD">XAU/USD · Oltin</option><option value="BTCUSDT">BTC/USDT · Bitcoin</option></select></label>
          <label className="block"><span className="eyebrow">Strategiya</span><select value={strategy} onChange={e => setStrategy(e.target.value as BacktestInput['strategy'])} data-testid="select-backtest-strategy" className="mt-1.5 h-10 w-full rounded-lg border border-input bg-background px-3 text-xs"><option value="gold-breakout-retest">Oltin · yorib o‘tish va qayta sinov</option><option value="btc-trend-momentum">Bitcoin · trend impulsi</option></select></label>
          <label className="block"><span className="eyebrow">Boshlang‘ich balans</span><input type="number" min="100" max="10000000" step="100" value={initialBalance} onChange={e => setInitialBalance(e.target.value)} data-testid="input-backtest-balance" className="mt-1.5 h-10 w-full rounded-lg border border-input bg-background px-3 font-mono text-xs" /></label>
          <label className="block"><span className="eyebrow">Har savdoda xavf (%)</span><input type="number" min=".05" max=".5" step=".05" value={risk} onChange={e => setRisk(e.target.value)} data-testid="input-backtest-risk" className="mt-1.5 h-10 w-full rounded-lg border border-input bg-background px-3 font-mono text-xs" /></label>
          <div className="grid grid-cols-2 gap-3"><label className="block"><span className="eyebrow">Komissiya (bps)</span><input type="number" min="0" max="100" step="1" value={fees} onChange={e => setFees(e.target.value)} data-testid="input-backtest-fees" className="mt-1.5 h-10 w-full rounded-lg border border-input bg-background px-3 font-mono text-xs" /></label><label className="block"><span className="eyebrow">Sirpanish (bps)</span><input type="number" min="0" max="200" step="1" value={slippage} onChange={e => setSlippage(e.target.value)} data-testid="input-backtest-slippage" className="mt-1.5 h-10 w-full rounded-lg border border-input bg-background px-3 font-mono text-xs" /></label></div>
          <Button type="submit" disabled={runBacktest.isPending} className="w-full" testId="button-run-backtest">{runBacktest.isPending ? <LoaderCircle size={14} className="animate-spin" /> : <Play size={14} />} {runBacktest.isPending ? 'Hisoblanmoqda' : 'Sintetik backtestni boshlash'}</Button>
          {feedback && <p className="rounded-lg bg-muted px-3 py-2 text-[10px] leading-4" role="status">{feedback}</p>}
        </div>
        <div className="mt-4 flex gap-2 rounded-lg border border-amber-400/40 bg-amber-50/60 p-3 text-[10px] leading-4 text-amber-950 dark:bg-amber-950/20 dark:text-amber-100"><AlertTriangle size={14} className="mt-0.5 shrink-0" /><span>Namuna ma’lumotlarida olingan natija tarixiy bozor sinovi emas. Real ijro mavjud emas.</span></div>
      </form>
      <div className="space-y-4">
        {backtests.isLoading ? <LoadingRows count={4} /> : backtests.isError ? <ErrorState retry={() => void refresh()} text="Backtestlar tarixini yuklab bo‘lmadi." /> : runs.length ? <>
          {activeRun && <><EquityChart run={activeRun} /><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Sof foyda" value={`${activeRun.netProfit >= 0 ? '+' : ''}${money(activeRun.netProfit)}`} hint={`${activeRun.netProfitPct >= 0 ? '+' : ''}${money(activeRun.netProfitPct, 2)}%`} icon={activeRun.netProfit >= 0 ? ArrowUpRight : ArrowDownRight} accent />
            <Metric label="Profit factor" value={money(activeRun.profitFactor, 2)} hint="Yutuq / yo‘qotish" icon={Gauge} />
            <Metric label="Maks. drawdown" value={`${money(activeRun.maxDrawdownPct, 2)}%`} hint="Eng katta pasayish" icon={ArrowDownRight} />
            <Metric label="Yutuq ulushi" value={`${money(activeRun.winRatePct, 1)}%`} hint={`${activeRun.tradeCount} ta savdo · kutilma ${money(activeRun.expectancy)}`} icon={Activity} />
          </div><div className="rounded-lg border border-amber-400/40 bg-amber-50/60 px-4 py-3 text-[10px] leading-4 text-amber-950 dark:bg-amber-950/20 dark:text-amber-100"><b>{activeRun.datasetLabel}</b> · {activeRun.disclaimer}</div></>}
          <section><SectionTitle kicker="Saqlangan sinovlar" title="Backtest tarixi" /><div className="panel divide-y divide-border/70">{runs.map(run => <button key={run.id} onClick={() => setSelected(run.id)} data-testid={`button-select-backtest-${run.id}`} className={cx('flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-muted/50', activeRun?.id === run.id && 'bg-primary/5')}>
            <div><p className="text-xs font-bold">{shortSymbol(run.symbol)} <span className="font-normal text-muted-foreground">· {strategyUz(run.strategy)}</span></p><p className="mt-1 text-[10px] text-muted-foreground">{run.datasetLabel} · {dateTime(run.createdAt)}</p></div><div className="text-right"><p className={cx('font-mono text-xs font-bold', run.netProfit >= 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300')}>{run.netProfit >= 0 ? '+' : ''}{money(run.netProfitPct, 2)}%</p><p className="mt-1 text-[9px] text-muted-foreground">{run.tradeCount} savdo · komissiya {money(run.fees)} · sirpanish {money(run.slippage)}</p></div>
          </button>)}</div></section>
        </> : <EmptyState title="Backtest tarixi bo‘sh" body="Chapdagi parametrlarni tanlab, birinchi sintetik sinovni ishga tushiring." />}
      </div>
    </div>
  </div></Shell>;
}

type NumericSettingKey = Exclude<keyof TradingSettingsUpdate, 'enabledSymbols'>;
const settingFields: Array<{ key: NumericSettingKey; label: string; unit: string; min: number; max: number; step: number; helper: string }> = [
  { key: 'initialBalance', label: 'Boshlang‘ich balans', unit: 'USD', min: 100, max: 10000000, step: 100, helper: 'Qog‘oz hisobining boshlang‘ich kapitali.' },
  { key: 'riskPerTradePct', label: 'Har savdoda xavf', unit: '%', min: .05, max: .5, step: .05, helper: 'Bitta pozitsiya uchun kapitalning ulushi.' },
  { key: 'maxDailyLossPct', label: 'Kunlik yo‘qotish chegarasi', unit: '%', min: .1, max: 1, step: .1, helper: 'Chegaraga yetganda yangi kirishlar to‘xtatiladi.' },
  { key: 'maxWeeklyLossPct', label: 'Haftalik yo‘qotish chegarasi', unit: '%', min: .5, max: 3, step: .1, helper: 'Hafta davomida ruxsat etilgan jami yo‘qotish.' },
  { key: 'maxDrawdownPct', label: 'Maksimal drawdown', unit: '%', min: 1, max: 5, step: .25, helper: 'Hisob kapitali cho‘qqisidan pasayish chegarasi.' },
  { key: 'minRiskReward', label: 'Minimal risk / foyda', unit: ': 1', min: 1, max: 5, step: .1, helper: 'Signal uchun minimal maqsad va xavf nisbati.' },
  { key: 'minimumSignalScore', label: 'Minimal signal bahosi', unit: '/ 100', min: 50, max: 100, step: 1, helper: 'Qo‘lda kirish uchun eng past ball. Past ballda kirish yopiq.' },
  { key: 'autoEnterMinScore', label: 'Avtokirish ishonch bali', unit: '/ 100', min: 80, max: 100, step: 1, helper: 'Shu balldan yuqorida agent o‘zi kiradi; pastroqda bir tugma.' },
  { key: 'newsBufferBeforeMinutes', label: 'Yangilikdan oldin kutish', unit: 'daqiqa', min: 0, max: 240, step: 5, helper: 'Muhim voqea oldidan savdoni cheklash.' },
  { key: 'newsBufferAfterMinutes', label: 'Yangilikdan keyin kutish', unit: 'daqiqa', min: 0, max: 240, step: 5, helper: 'Muhim voqeadan keyin savdoni cheklash.' },
];
function SettingsPage() {
  const client = useQueryClient();
  const query = useGetTradingSettings();
  const dashboard = useGetTradingDashboard();
  const updateSettings = useUpdateTradingSettings();
  const engine = useControlTradingEngine();
  const [form, setForm] = useState<TradingSettingsUpdate>({});
  const [feedback, setFeedback] = useState('');
  const [initializedAt, setInitializedAt] = useState('');
  const enabledSymbols = useMemo(() => query.data?.enabledSymbols.join('|') ?? '', [query.data?.enabledSymbols]);
  useEffect(() => {
    const setting = query.data;
    if (!setting || setting.updatedAt === initializedAt) return;
    setForm({
      initialBalance: setting.initialBalance, riskPerTradePct: setting.riskPerTradePct,
      maxDailyLossPct: setting.maxDailyLossPct, maxWeeklyLossPct: setting.maxWeeklyLossPct,
      maxDrawdownPct: setting.maxDrawdownPct, minRiskReward: setting.minRiskReward,
      minimumSignalScore: setting.minimumSignalScore, autoEnterMinScore: setting.autoEnterMinScore,
      newsBufferBeforeMinutes: setting.newsBufferBeforeMinutes,
      newsBufferAfterMinutes: setting.newsBufferAfterMinutes, enabledSymbols: setting.enabledSymbols,
    });
    setInitializedAt(setting.updatedAt);
  }, [query.data, initializedAt, enabledSymbols]);
  const refresh = () => {
    void client.invalidateQueries({ queryKey: getGetTradingSettingsQueryKey() });
    void client.invalidateQueries({ queryKey: getGetTradingDashboardQueryKey() });
  };
  const toggleSymbol = (symbol: 'XAUUSD' | 'BTCUSDT') => setForm(current => {
    const currentSymbols = current.enabledSymbols ?? query.data?.enabledSymbols ?? [];
    return { ...current, enabledSymbols: currentSymbols.includes(symbol) ? currentSymbols.filter(item => item !== symbol) : [...currentSymbols, symbol] };
  });
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const numericValues = settingFields.map(field => Number(form[field.key]));
    if (numericValues.some(value => !Number.isFinite(value))) { setFeedback('Barcha xavf va hisob qiymatlarini tekshiring.'); return; }
    if (!(form.enabledSymbols?.length ?? 0)) { setFeedback('Kamida bitta instrument yoqilgan bo‘lishi kerak.'); return; }
    updateSettings.mutate({ data: form }, {
      onSuccess: async () => {
        setFeedback('Qog‘oz hisob sozlamalari saqlandi.');
        await Promise.all([client.invalidateQueries({ queryKey: getGetTradingSettingsQueryKey() }), client.invalidateQueries({ queryKey: getGetTradingDashboardQueryKey() }), client.invalidateQueries({ queryKey: getGetTradingAuditQueryKey() })]);
      },
      onError: () => setFeedback('Sozlamalarni saqlab bo‘lmadi. Qiymatlar ruxsat etilgan chegarada ekanini tekshiring.'),
    });
  };
  const operate = (action: 'start' | 'pause' | 'stop' | 'kill-switch') => engine.mutate({ data: { action } }, {
    onSuccess: async () => { setFeedback('Qog‘oz dvigateli boshqaruvi yangilandi.'); await Promise.all([client.invalidateQueries({ queryKey: getGetTradingDashboardQueryKey() }), client.invalidateQueries({ queryKey: getGetTradingSettingsQueryKey() }), client.invalidateQueries({ queryKey: getGetTradingAuditQueryKey() })]); },
    onError: () => setFeedback('Dvigatel boshqaruvi bajarilmadi.'),
  });
  if (query.isLoading) return <Shell current="/settings"><LoadingRows count={5} /></Shell>;
  if (query.isError || !query.data) return <Shell current="/settings"><ErrorState retry={refresh} text="Sozlamalarni yuklab bo‘lmadi." /></Shell>;
  const setting = query.data;
  const currentSymbols = form.enabledSymbols ?? setting.enabledSymbols;
  return <Shell current="/settings"><div className="animate-enter">
    <div className="mb-6"><Badge tone="gold"><LockKeyhole size={11} /> Faqat qog‘oz hisob</Badge><h1 className="mt-3 font-display text-3xl font-semibold tracking-tight">Xavf va dvigatel sozlamalari</h1><p className="mt-2 max-w-2xl text-xs leading-5 text-muted-foreground">Konservativ chegaralar yangi qog‘oz sinovlariga qo‘llanadi. Jonli hisobga ulanish yoki real buyurtma yuborish funksiyasi yo‘q.</p></div>
    {feedback && <div className="mb-4 flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2 text-xs" role="status">{feedback}<button onClick={() => setFeedback('')} aria-label="Xabarni yopish"><X size={13} /></button></div>}
    <div className="grid items-start gap-5 xl:grid-cols-[1fr_320px]">
      <form onSubmit={save} className="panel p-4 sm:p-6">
        <SectionTitle kicker="Hisob parametrlari" title="Xavf chegaralari" trailing={<span className="text-[9px] text-muted-foreground">Yangilandi: {dateTime(setting.updatedAt)}</span>} />
        <div className="mb-5 grid gap-3 sm:grid-cols-2">
          {settingFields.map(field => <label key={field.key} className="rounded-lg border border-border/70 p-3.5">
            <span className="flex items-center justify-between gap-2 text-[11px] font-bold">{field.label}<span className="font-mono text-[9px] text-muted-foreground">{field.unit}</span></span>
            <input type="number" min={field.min} max={field.max} step={field.step} value={form[field.key] ?? ''} onChange={e => setForm(current => ({ ...current, [field.key]: e.target.value === '' ? undefined : Number(e.target.value) }))} data-testid={`input-setting-${field.key}`} className="mt-2 h-10 w-full rounded-lg border border-input bg-background px-3 font-mono text-sm" />
            <span className="mt-1.5 block text-[9px] leading-4 text-muted-foreground">{field.helper} Ruxsat etilgan: {field.min}–{field.max}{field.unit}</span>
          </label>)}
        </div>
        <div className="border-t border-border pt-5">
          <SectionTitle kicker="Ruxsat etilgan instrumentlar" title="Aktivlar" />
          <div className="grid gap-3 sm:grid-cols-2">
            {(['XAUUSD', 'BTCUSDT'] as const).map(symbol => {
              const checked = currentSymbols.includes(symbol);
              return <label key={symbol} className={cx('flex cursor-pointer items-center justify-between rounded-lg border p-4 transition', checked ? 'border-primary/50 bg-primary/5' : 'border-border bg-muted/20')} data-testid={`setting-symbol-${symbol}`}>
                <span><span className="block font-mono text-xs font-bold">{symbol}</span><span className="mt-1 block text-[10px] text-muted-foreground">{shortSymbol(symbol)}</span></span>
                <input type="checkbox" checked={checked} onChange={() => toggleSymbol(symbol)} aria-label={`${symbol} instrumentini yoqish`} className="h-4 w-4 accent-[hsl(var(--primary))]" data-testid={`checkbox-symbol-${symbol}`} />
              </label>;
            })}
          </div>
        </div>
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
          <p className="max-w-sm text-[10px] leading-4 text-muted-foreground">Saqlash server validatsiyasidan o‘tadi. O‘zgarishlar faqat PAPER rejimiga tegishli.</p>
          <Button type="submit" disabled={updateSettings.isPending} testId="button-save-settings">{updateSettings.isPending ? <LoaderCircle size={14} className="animate-spin" /> : <Check size={14} />} Sozlamalarni saqlash</Button>
        </div>
      </form>
      <aside className="space-y-4">
        <section className="panel overflow-hidden">
          <div className="border-b border-border bg-muted/45 p-4"><p className="eyebrow">Ijro dvigateli</p><h2 className="mt-1 font-display text-lg font-semibold">Qog‘oz boshqaruv</h2></div>
          <div className="p-4">
            <div className="flex items-center justify-between rounded-lg bg-muted/50 p-3"><div><p className="text-xs font-bold">{stateUz(setting.engineState)}</p><p className="mt-1 text-[10px] text-muted-foreground">Rejim: PAPER</p></div><Badge tone={setting.engineState === 'running' ? 'good' : 'warn'}>{setting.engineState === 'running' ? 'Faol' : 'Xavfsiz'}</Badge></div>
            {dashboard.data?.risk.reasons.length ? <div className="mt-3 rounded-lg border border-amber-400/40 bg-amber-50/60 p-3 text-[10px] leading-4 text-amber-950 dark:bg-amber-950/20 dark:text-amber-100"><p className="mb-1 font-extrabold">Ishga tushishdan oldin</p>{dashboard.data.risk.reasons.map((reason, i) => <p key={i}>• {reason}</p>)}</div> : <p className="mt-3 text-[10px] leading-4 text-muted-foreground">Har qanday boshqaruv faqat sinov hisobida ishlaydi.</p>}
            <div className="mt-3 grid grid-cols-2 gap-2">
              {setting.engineState === 'running' ? <Button variant="outline" onClick={() => operate('pause')} disabled={engine.isPending} testId="button-settings-pause"><Square size={12} /> Pauza</Button> : <Button onClick={() => operate('start')} disabled={engine.isPending} testId="button-settings-start"><Play size={12} /> Boshlash</Button>}
              {setting.engineState !== 'stopped' && <Button variant="outline" onClick={() => operate('stop')} disabled={engine.isPending} testId="button-settings-stop"><Square size={12} /> Oddiy to‘xtatish</Button>}
              <Button variant="danger" onClick={() => operate('kill-switch')} disabled={engine.isPending} testId="button-settings-kill"><AlertOctagon size={12} /> Favqulodda to‘xtatish</Button>
            </div>
            <div className="mt-4 flex gap-2 rounded-lg border border-border p-3"><LockKeyhole size={14} className="mt-0.5 shrink-0 text-primary" /><p className="text-[10px] leading-4"><b>Jonli ijro o‘chirilgan.</b> Uni yoqish boshqaruvi mavjud emas.</p></div>
          </div>
        </section>
        <section className="panel p-4">
          <p className="eyebrow">Ulanishlar holati</p>
          <div className="mt-3 space-y-2">
            {(dashboard.data?.connections ?? []).map(item => <div key={item.id} className="flex items-center justify-between gap-2 text-[10px]"><span className="truncate">{item.label}</span><Badge tone={item.status === 'connected' ? 'good' : 'bad'}>{item.id === 'ai' ? 'AI mavjud emas' : item.status === 'connected' ? 'Ulangan' : item.status === 'degraded' ? 'Cheklangan' : 'Ulanmagan'}</Badge></div>)}
            {!dashboard.data && <p className="text-[10px] text-muted-foreground">Ulanish holati yuklanmadi.</p>}
          </div>
          <p className="mt-3 border-t border-border pt-3 text-[10px] leading-4 text-muted-foreground">AI provayder sozlanmagan. Qarorlar AI tomonidan yaratilmaydi.</p>
        </section>
      </aside>
    </div>
  </div></Shell>;
}
function Router() {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}><Switch>
    <Route path="/sign-in/*?" component={SignInPage} />
    <Route path="/sign-up/*?" component={SignUpPage} />
    <Route path="/" component={HomePage} />
    <Route path="/dashboard" component={DashboardRoute} />
    <Route path="/backtests" component={BacktestRoute} />
    <Route path="/journal" component={JournalRoute} />
    <Route path="/settings" component={SettingsRoute} />
    <Route><Shell current=""><div className="panel p-8 text-center"><p className="eyebrow">404 · Sahifa topilmadi</p><h1 className="mt-3 font-display text-3xl font-semibold">Bu manzil mavjud emas</h1><p className="mt-2 text-xs text-muted-foreground">Boshqaruv paneliga qaytib, sinovni davom ettiring.</p><Link href="/dashboard" className="mt-5 inline-flex text-xs font-bold text-primary">Umumiy ko‘rinishga qaytish</Link></div></Shell></Route>
  </Switch></ErrorBoundary>;
}

function LoadingPage() {
  return <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4 text-sm text-muted-foreground">Tekshirilmoqda…</div>;
}

function AccessMessage({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return <main className="flex min-h-[100dvh] items-center justify-center bg-background px-4 py-10 text-foreground">
    <section className="panel w-full max-w-lg p-7 text-center sm:p-9">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/15 text-primary"><LockKeyhole size={22} /></div>
      <p className="eyebrow mt-5">Xavfsiz kirish</p>
      <h1 className="mt-2 font-display text-2xl font-semibold">{title}</h1>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">{body}</p>
      {action && <div className="mt-6 flex justify-center gap-3">{action}</div>}
    </section>
  </main>;
}

function PublicLanding() {
  return <main className="min-h-[100dvh] bg-[radial-gradient(circle_at_top_left,rgba(39_77%_48%_/_0.14),transparent_34%),radial-gradient(circle_at_bottom_right,rgba(158_42%_37%_/_0.1),transparent_40%),hsl(var(--background))] px-5 py-8 text-foreground sm:px-10">
    <div className="mx-auto flex max-w-6xl items-center justify-between border-b border-border pb-5">
      <div className="flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-sidebar text-sidebar-primary"><ArrowLeftRight size={19} /></span><div><p className="font-display text-base font-bold">Mizan Trader</p><p className="font-mono text-[9px] uppercase tracking-[.15em] text-muted-foreground">Exness · XAU · BTC · Agent</p></div></div>
      <div className="flex gap-2"><Link href="/sign-in" className="rounded-lg border border-border px-4 py-2.5 text-xs font-bold hover:bg-muted">Kirish</Link><Link href="/sign-up" className="rounded-lg bg-primary px-4 py-2.5 text-xs font-extrabold text-primary-foreground hover:brightness-95">Hisob yaratish</Link></div>
    </div>
    <div className="mx-auto grid max-w-6xl gap-12 py-16 lg:grid-cols-[1.1fr_.9fr] lg:items-center lg:py-24">
      <div><Badge tone="gold"><LockKeyhole size={11} /> Exness paper · Agent nazorati</Badge><h1 className="mt-5 max-w-3xl font-display text-4xl font-semibold leading-tight tracking-tight sm:text-6xl">Real-time tahlil, prognoz va xavfsiz kirish</h1><p className="mt-5 max-w-2xl text-sm leading-7 text-muted-foreground">Agent bozorni kuzatadi, sabab va prognozni yozadi. Ishonch yuqori bo‘lsa o‘zi kiradi; bo‘lmasa bir tugma bilan ruxsat berasiz. Aniq ma’lumot bo‘lmasa umuman kirmaydi.</p>
        <div className="mt-8 flex flex-wrap gap-3"><Link href="/sign-in" className="rounded-lg bg-primary px-5 py-3 text-xs font-extrabold text-primary-foreground">Panelga kirish</Link><a href="#xavfsizlik" className="rounded-lg border border-border px-5 py-3 text-xs font-extrabold hover:bg-muted">Qanday ishlaydi</a></div>
        <p className="mt-6 text-[10px] leading-5 text-muted-foreground">Paper rejim. Real broker buyurtmasi yuborilmaydi. Prognoz kafolat emas; zarar limitlari bilan himoyalangan.</p>
      </div>
      <div className="panel relative overflow-hidden p-5 sm:p-7">
        <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-primary via-emerald-600 to-primary" />
        <div className="flex items-start justify-between gap-4"><div><p className="eyebrow">Agent qoidalari</p><h2 className="mt-2 font-display text-xl font-semibold">Kirish faqat aniq signalda</h2></div><Badge tone="good">Faol</Badge></div>
        <div className="mt-6 space-y-3">{[
          ['Exness · MT5', 'Paper oqim · bridge keyin ulanadi'],
          ['Prognoz + tahlil', 'Har qarorda majburiy'],
          ['Avtokirish', 'Faqat yuqori ishonch bali'],
          ['Bir tugma', 'Ishonch o‘rtacha bo‘lsa ruxsat'],
          ['Zarar himoyasi', 'Kunlik/haftalik/drawdown limit'],
        ].map(([label, value]) => <div key={label} className="flex items-center justify-between gap-4 rounded-lg border border-border/70 px-3 py-3"><span className="text-xs font-bold">{label}</span><span className="text-right text-[10px] text-muted-foreground">{value}</span></div>)}</div>
        <p id="xavfsizlik" className="mt-5 rounded-lg bg-muted/60 p-3 text-[10px] leading-5 text-muted-foreground">Exness orqali kirish paper hisobda simulyatsiya qilinadi. Jonli MT5 bridge ulanganda kotirovka manbai yangilanadi; maxfiy kalitlar chatga yuborilmaydi.</p>
      </div>
    </div>
  </main>;
}

function LandingPage() {
  if (localDevAuth) return <Redirect to="/dashboard" />;
  return <ClerkLandingPage />;
}

function ClerkLandingPage() {
  const { isLoaded, isSignedIn, user } = useUser();
  if (!isLoaded) return <LoadingPage />;
  if (isSignedIn && user) {
    const email = user.primaryEmailAddress?.emailAddress.trim().toLowerCase();
    if (adminEmail && email === adminEmail) return <Redirect to="/dashboard" />;
    return <AccessMessage title="Ruxsat berilmagan" body="Bu hisob savdo platformasini boshqarish huquqiga ega emas. Administrator hisobidan kiring." action={<Link href="/sign-in" className="rounded-lg border border-border px-4 py-2 text-xs font-bold">Boshqa hisob bilan kirish</Link>} />;
  }
  return <PublicLanding />;
}

function HomePage() {
  return <LandingPage />;
}

function ClerkAdminOnly({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, user } = useUser();
  if (!isLoaded) return <LoadingPage />;
  if (!isSignedIn || !user) {
    return <AccessMessage title="Kirish talab qilinadi" body="Boshqaruv panelini ko‘rish uchun administrator hisobiga kiring." action={<Link href="/sign-in" className="rounded-lg bg-primary px-4 py-2.5 text-xs font-extrabold text-primary-foreground">Kirish</Link>} />;
  }
  if (!adminEmail) {
    return <AccessMessage title="Administrator hali sozlanmagan" body="Bu loyiha uchun boshqaruvchi email tasdiqlanmaguncha savdo ma’lumotlari yopiq qoladi." />;
  }
  const email = user.primaryEmailAddress?.emailAddress.trim().toLowerCase();
  if (email !== adminEmail) {
    return <AccessMessage title="Ruxsat berilmagan" body="Ushbu hisobda savdo boshqaruvi uchun ruxsat yo‘q." action={<Link href="/" className="rounded-lg border border-border px-4 py-2.5 text-xs font-bold">Bosh sahifa</Link>} />;
  }
  return children;
}
function AdminOnly({ children }: { children: ReactNode }) {
  if (localDevAuth) return children;
  return <ClerkAdminOnly>{children}</ClerkAdminOnly>;
}

function DashboardRoute() { return <AdminOnly><DashboardPage /></AdminOnly>; }
function BacktestRoute() { return <AdminOnly><BacktestPage /></AdminOnly>; }
function JournalRoute() { return <AdminOnly><JournalPage /></AdminOnly>; }
function SettingsRoute() { return <AdminOnly><SettingsPage /></AdminOnly>; }
function SignInPage() {
  return <main className="flex min-h-[100dvh] items-center justify-center bg-background px-4 py-8"><div className="w-full max-w-md"><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} /></div></main>;
}
function SignUpPage() {
  return <main className="flex min-h-[100dvh] items-center justify-center bg-background px-4 py-8"><div className="w-full max-w-md"><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} /></div></main>;
}
function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const client = useQueryClient();
  const previousUser = useRef<string | null | undefined>(undefined);
  useEffect(() => addListener(({ user }) => {
    const userId = user?.id ?? null;
    if (previousUser.current !== undefined && previousUser.current !== userId) client.clear();
    previousUser.current = userId;
  }), [addListener, client]);
  return null;
}
function LocalDevApp() {
  return <QueryClientProvider client={queryClient}>
    <TooltipProvider><Router /><Toaster /></TooltipProvider>
  </QueryClientProvider>;
}

function ClerkApp() {
  const [, setLocation] = useLocation();
  const stripBase = (path: string) => basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path;
  if (!clerkPubKey) throw new Error('VITE_CLERK_PUBLISHABLE_KEY sozlanmagan.');
  const appearance = {
    theme: shadcn,
    cssLayerName: 'clerk',
    options: {
      logoPlacement: 'inside' as const,
      logoLinkUrl: basePath || '/',
      logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
    },
    variables: {
      colorPrimary: '#aa711d',
      colorForeground: '#29303b',
      colorMutedForeground: '#6d7480',
      colorDanger: '#b53b35',
      colorBackground: '#fcfbf8',
      colorInput: '#fffefa',
      colorInputForeground: '#29303b',
      colorNeutral: '#29303b',
      fontFamily: 'Manrope, sans-serif',
      borderRadius: '0.75rem',
    },
    elements: {
      rootBox: 'w-full flex justify-center',
      cardBox: 'bg-card rounded-2xl w-[440px] max-w-full overflow-hidden',
      card: '!shadow-none !border-0 !bg-transparent !rounded-none',
      footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
      headerTitle: 'text-foreground',
      headerSubtitle: 'text-muted-foreground',
      socialButtonsBlockButtonText: 'text-foreground',
      formFieldLabel: 'text-foreground',
      footerActionLink: 'text-primary',
      footerActionText: 'text-muted-foreground',
      dividerText: 'text-muted-foreground',
      identityPreviewEditButton: 'text-primary',
      formFieldSuccessText: 'text-emerald-700',
      alertText: 'text-foreground',
      logoBox: 'mx-auto',
      logoImage: 'h-9 w-auto',
      socialButtonsBlockButton: 'border-border bg-background',
      formButtonPrimary: 'bg-primary text-primary-foreground',
      formFieldInput: 'border-input bg-background text-foreground',
      footerAction: 'text-muted-foreground',
      dividerLine: 'bg-border',
      alert: 'border-border bg-muted',
      otpCodeFieldInput: 'border-input bg-background text-foreground',
      formFieldRow: 'text-foreground',
      main: 'text-foreground',
    },
  };
  return <ClerkProvider
    publishableKey={clerkPubKey}
    proxyUrl={clerkProxyUrl}
    appearance={appearance}
    signInUrl={`${basePath}/sign-in`}
    signUpUrl={`${basePath}/sign-up`}
    localization={{
      signIn: { start: { title: 'Hisobga kiring', subtitle: 'Xavfsiz boshqaruv paneliga o‘ting.' } },
      signUp: { start: { title: 'Hisob yarating', subtitle: 'Faqat administrator hisobiga boshqaruv ruxsati beriladi.' } },
    }}
    routerPush={(to) => setLocation(stripBase(to))}
    routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
  >
    <QueryClientProvider client={queryClient}>
      <ClerkQueryClientCacheInvalidator />
      <TooltipProvider><Router /><Toaster /></TooltipProvider>
    </QueryClientProvider>
  </ClerkProvider>;
}
function App() {
  return <WouterRouter base={basePath}>{localDevAuth ? <LocalDevApp /> : <ClerkApp />}</WouterRouter>;
}
export default App;
