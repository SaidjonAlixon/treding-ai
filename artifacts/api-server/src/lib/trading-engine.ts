import { and, desc, eq, gte } from "drizzle-orm";
import {
  db,
  tradingAuditTable,
  tradingBacktestsTable,
  tradingPositionsTable,
  tradingSettingsTable,
  tradingSignalsTable,
} from "@workspace/db";
import { runSyntheticBacktest } from "./backtest-engine";
import {
  calculateAtr,
  calculateEma,
  generateCandles,
  getMarketSnapshot,
  type SymbolCode,
} from "./market-simulator";

type EngineState = "stopped" | "running" | "paused" | "emergency_stop";
type Side = "LONG" | "SHORT";

const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;

function startOfTashkentDay(now: Date): Date {
  const local = new Date(now.getTime() + TASHKENT_OFFSET_MS);
  return new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) -
      TASHKENT_OFFSET_MS,
  );
}

function startOfTashkentWeek(now: Date): Date {
  const local = new Date(now.getTime() + TASHKENT_OFFSET_MS);
  const day = local.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  return new Date(
    Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate() - daysSinceMonday,
    ) - TASHKENT_OFFSET_MS,
  );
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export async function ensureTradingSettings() {
  const [existing] = await db
    .select()
    .from(tradingSettingsTable)
    .where(eq(tradingSettingsTable.id, 1))
    .limit(1);
  if (existing) return existing;

  await db
    .insert(tradingSettingsTable)
    .values({ id: 1 })
    .onConflictDoNothing();

  const [created] = await db
    .select()
    .from(tradingSettingsTable)
    .where(eq(tradingSettingsTable.id, 1))
    .limit(1);
  if (!created) throw new Error("Could not initialize paper trading settings");
  return created;
}

async function writeAudit(
  eventType: string,
  message: string,
  options: {
    severity?: "info" | "warning" | "critical";
    symbol?: string | null;
    details?: Record<string, unknown>;
  } = {},
) {
  const [event] = await db
    .insert(tradingAuditTable)
    .values({
      eventType,
      message,
      severity: options.severity ?? "info",
      symbol: options.symbol ?? null,
      details: options.details ?? {},
    })
    .returning();
  return event!;
}

function mapPosition(row: typeof tradingPositionsTable.$inferSelect) {
  return {
    id: row.id,
    symbol: row.symbol as SymbolCode,
    side: row.side as Side,
    quantity: row.quantity,
    entryPrice: row.entryPrice,
    currentPrice: row.currentPrice,
    stopLoss: row.stopLoss,
    takeProfit: row.takeProfit,
    riskAmount: row.riskAmount,
    unrealizedPnl: row.unrealizedPnl,
    status: row.status as "open" | "closed",
    openedAt: row.openedAt,
    closedAt: row.closedAt,
  };
}

function mapSignal(row: typeof tradingSignalsTable.$inferSelect) {
  return {
    id: row.id,
    symbol: row.symbol as SymbolCode,
    strategy: row.strategy,
    action: row.action as Side | "NO_TRADE",
    score: row.score,
    marketRegime: row.marketRegime as
      | "trend"
      | "range"
      | "high_volatility"
      | "unknown",
    entryPrice: row.entryPrice,
    stopLoss: row.stopLoss,
    takeProfit: row.takeProfit,
    riskReward: row.riskReward,
    allowed: row.allowed,
    reasons: row.reasons,
    counterEvidence: row.counterEvidence,
    dataSource: row.dataSource,
    createdAt: row.createdAt,
  };
}

function mapAudit(row: typeof tradingAuditTable.$inferSelect) {
  return {
    id: row.id,
    eventType: row.eventType,
    severity: row.severity as "info" | "warning" | "critical",
    symbol: row.symbol,
    message: row.message,
    details: row.details,
    createdAt: row.createdAt,
  };
}

function mapSettings(
  row: typeof tradingSettingsTable.$inferSelect,
) {
  return {
    mode: "paper" as const,
    engineState: row.engineState as EngineState,
    liveExecutionEnabled: false,
    initialBalance: row.initialBalance,
    riskPerTradePct: row.riskPerTradePct,
    maxDailyLossPct: row.maxDailyLossPct,
    maxWeeklyLossPct: row.maxWeeklyLossPct,
    maxDrawdownPct: row.maxDrawdownPct,
    minRiskReward: row.minRiskReward,
    minimumSignalScore: row.minimumSignalScore,
    newsBufferBeforeMinutes: row.newsBufferBeforeMinutes,
    newsBufferAfterMinutes: row.newsBufferAfterMinutes,
    enabledSymbols: row.enabledSymbols as SymbolCode[],
    updatedAt: row.updatedAt,
  };
}

async function getClosedPositions() {
  return db
    .select()
    .from(tradingPositionsTable)
    .where(eq(tradingPositionsTable.status, "closed"));
}

async function calculateAccount(settings: typeof tradingSettingsTable.$inferSelect) {
  const now = new Date();
  const dayStart = startOfTashkentDay(now);
  const weekStart = startOfTashkentWeek(now);
  const closed = await getClosedPositions();
  const realized = closed.reduce((sum, position) => sum + position.realizedPnl, 0);
  const dayPnl = closed
    .filter((position) => position.closedAt && position.closedAt >= dayStart)
    .reduce((sum, position) => sum + position.realizedPnl, 0);
  const weekPnl = closed
    .filter((position) => position.closedAt && position.closedAt >= weekStart)
    .reduce((sum, position) => sum + position.realizedPnl, 0);
  const monthPnl = closed
    .filter(
      (position) =>
        position.closedAt &&
        position.closedAt.getUTCFullYear() === now.getUTCFullYear() &&
        position.closedAt.getUTCMonth() === now.getUTCMonth(),
    )
    .reduce((sum, position) => sum + position.realizedPnl, 0);
  const open = await db
    .select()
    .from(tradingPositionsTable)
    .where(eq(tradingPositionsTable.status, "open"));
  const openPnl = open.reduce((sum, position) => sum + position.unrealizedPnl, 0);
  const balance = settings.initialBalance + realized;
  const equity = balance + openPnl;

  return {
    currency: "USD",
    balance: round(balance),
    equity: round(equity),
    availableBalance: round(Math.max(0, equity - open.reduce((sum, p) => sum + p.riskAmount, 0))),
    dayPnl: round(dayPnl),
    weekPnl: round(weekPnl),
    monthPnl: round(monthPnl),
    currentDrawdownPct: round(
      Math.max(0, ((settings.initialBalance - equity) / settings.initialBalance) * 100),
    ),
    openPositions: open,
    closedPositions: closed,
  };
}

async function calculateRisk(settings: typeof tradingSettingsTable.$inferSelect) {
  const account = await calculateAccount(settings);
  const dayUsed = Math.max(
    0,
    (-account.dayPnl / settings.initialBalance) * 100,
  );
  const weekUsed = Math.max(
    0,
    (-account.weekPnl / settings.initialBalance) * 100,
  );
  const openRisk = account.openPositions.reduce(
    (sum, position) => sum + position.riskAmount,
    0,
  );
  const reasons: string[] = [];
  if (dayUsed >= settings.maxDailyLossPct) {
    reasons.push("Kunlik zarar limiti yetdi.");
  }
  if (weekUsed >= settings.maxWeeklyLossPct) {
    reasons.push("Haftalik zarar limiti yetdi.");
  }
  if (account.currentDrawdownPct >= settings.maxDrawdownPct) {
    reasons.push("Umumiy drawdown chegarasi yetdi.");
  }
  return {
    snapshot: {
      status: reasons.length === 0 ? ("clear" as const) : ("blocked" as const),
      dailyLossUsedPct: round(dayUsed, 3),
      dailyLossLimitPct: settings.maxDailyLossPct,
      weeklyLossUsedPct: round(weekUsed, 3),
      weeklyLossLimitPct: settings.maxWeeklyLossPct,
      maxDrawdownPct: settings.maxDrawdownPct,
      openRiskPct: round((openRisk / Math.max(account.equity, 1)) * 100, 3),
      reasons,
    },
    account,
  };
}

function trendFor(
  symbol: SymbolCode,
  candles: ReturnType<typeof generateCandles>,
) {
  const closes = candles.map((candle) => candle.close);
  const ema20 = calculateEma(closes.slice(-40), 20);
  const ema50 = calculateEma(closes.slice(-90), 50);
  const slope = closes.at(-1)! - closes.at(-7)!;
  if (ema20 > ema50 * 1.0005 && slope > 0) return "uptrend";
  if (ema20 < ema50 * 0.9995 && slope < 0) return "downtrend";
  return "range";
}

async function evaluateSignal(symbol: SymbolCode) {
  const settings = await ensureTradingSettings();
  const snapshot = getMarketSnapshot(symbol);
  const candles = snapshot.candles;
  const closes = candles.map((candle) => candle.close);
  const last = candles.at(-1)!;
  const prior = candles.at(-2)!;
  const ema20 = calculateEma(closes.slice(-40), 20);
  const ema50 = calculateEma(closes.slice(-90), 50);
  const atr = calculateAtr(candles, 14);
  const trend = trendFor(symbol, candles);
  const volumeAverage =
    candles.slice(-21, -1).reduce((sum, candle) => sum + candle.volume, 0) / 20;
  const momentum = last.close / candles.at(-4)!.close - 1;
  const highVolatility =
    atr / last.close > (symbol === "BTCUSDT" ? 0.02 : 0.005);
  const regime = highVolatility
    ? "high_volatility"
    : trend === "range"
      ? "range"
      : "trend";

  let candidate: Side | null = null;
  let strategy = symbol === "XAUUSD" ? "Trend + breakout retest" : "Trend + momentum + volume";
  let triggerConfirmed = false;
  let volumeConfirmed = last.volume >= volumeAverage * 1.05;

  if (symbol === "XAUUSD") {
    const range = candles.slice(-21, -1);
    const rangeHigh = Math.max(...range.map((candle) => candle.high));
    const rangeLow = Math.min(...range.map((candle) => candle.low));
    const longRetest = last.close > rangeHigh && last.low <= rangeHigh * 1.001;
    const shortRetest = last.close < rangeLow && last.high >= rangeLow * 0.999;
    if (trend === "uptrend" && longRetest) candidate = "LONG";
    if (trend === "downtrend" && shortRetest) candidate = "SHORT";
    triggerConfirmed = Boolean(candidate);
    volumeConfirmed = true;
  } else {
    strategy = "Trend + momentum + volume";
    if (trend === "uptrend" && momentum > 0.001 && volumeConfirmed) candidate = "LONG";
    if (trend === "downtrend" && momentum < -0.001 && volumeConfirmed) candidate = "SHORT";
    triggerConfirmed = Boolean(candidate);
  }

  const trendConfirmed =
    (candidate === "LONG" && ema20 > ema50) ||
    (candidate === "SHORT" && ema20 < ema50);
  const momentumConfirmed =
    candidate === "LONG" ? momentum > 0 : candidate === "SHORT" ? momentum < 0 : false;
  const score = Math.min(
    100,
    (trendConfirmed ? 30 : 0) +
      (triggerConfirmed ? 30 : 0) +
      (momentumConfirmed ? 15 : 0) +
      (volumeConfirmed ? 10 : 0) +
      (!highVolatility ? 10 : 0) +
      (snapshot.spreadHealthy ? 5 : 0),
  );
  const stopDistance = Math.max(
    atr * 1.5,
    last.close * (symbol === "BTCUSDT" ? 0.003 : 0.0008),
  );
  const entryPrice = candidate ? (snapshot.bid + snapshot.ask) / 2 : null;
  const stopLoss =
    candidate && entryPrice !== null
      ? candidate === "LONG"
        ? entryPrice - stopDistance
        : entryPrice + stopDistance
      : null;
  const takeProfit =
    candidate && entryPrice !== null
      ? candidate === "LONG"
        ? entryPrice + stopDistance * settings.minRiskReward
        : entryPrice - stopDistance * settings.minRiskReward
      : null;
  const { snapshot: risk, account } = await calculateRisk(settings);
  const activePositions = account.openPositions;
  const alreadyOpen = activePositions.some((position) => position.symbol === symbol);
  const reasons: string[] = [];
  const counterEvidence: string[] = [];

  if (candidate) reasons.push(`${trend} yo‘nalishi strategiya bilan mos.`);
  if (triggerConfirmed) reasons.push("Kirish sharti tasdiqlandi.");
  else reasons.push("Kirish sharti tasdiqlanmadi; NO TRADE.");
  if (volumeConfirmed) reasons.push("Hajm filtri mos.");
  else counterEvidence.push("Hajm tasdig‘i yetarli emas.");
  if (highVolatility) counterEvidence.push("Volatililik yuqori; signal bloklanadi.");
  if (!snapshot.spreadHealthy) counterEvidence.push("Spred nazorat chegarasidan yuqori.");
  if (risk.status === "blocked") counterEvidence.push(...risk.reasons);
  if (alreadyOpen) counterEvidence.push("Ushbu aktivda ochiq paper pozitsiya mavjud.");
  if (activePositions.length >= 2) counterEvidence.push("Ikki pozitsiya limiti yetdi.");
  if (!settings.enabledSymbols.includes(symbol)) {
    counterEvidence.push("Aktiv sozlamalarda o‘chirilgan.");
  }
  if (Math.abs(last.close - prior.close) / prior.close > 0.02) {
    counterEvidence.push("Oxirgi shamda keskin narx sakrashi bor.");
  }
  if (trend === "range") counterEvidence.push("Bozor trendi aniqlanmadi.");

  const allowed =
    candidate !== null &&
    score >= settings.minimumSignalScore &&
    risk.status === "clear" &&
    !alreadyOpen &&
    activePositions.length < 2 &&
    settings.enabledSymbols.includes(symbol) &&
    !highVolatility &&
    snapshot.spreadHealthy &&
    Math.abs(last.close - prior.close) / prior.close <= 0.02;
  if (candidate && score < settings.minimumSignalScore) {
    counterEvidence.push(`Signal balli ${settings.minimumSignalScore} chegarasidan past.`);
  }
  const action = allowed && candidate ? candidate : "NO_TRADE";
  if (action === "NO_TRADE" && reasons.length === 0) {
    reasons.push("Majburiy tekshiruvlardan o‘tgan signal topilmadi.");
  }

  const [saved] = await db
    .insert(tradingSignalsTable)
    .values({
      symbol,
      strategy,
      action,
      score,
      marketRegime: regime,
      entryPrice,
      stopLoss,
      takeProfit,
      riskReward: entryPrice === null ? null : settings.minRiskReward,
      allowed,
      reasons,
      counterEvidence,
      dataSource: "synthetic-demo",
    })
    .returning();

  await writeAudit(
    allowed ? "signal_approved_for_paper" : "signal_rejected",
    allowed
      ? `${symbol}: paper signal approved (${action}).`
      : `${symbol}: ${action}; strategy or risk gate did not approve entry.`,
    {
      severity: allowed ? "info" : "warning",
      symbol,
      details: { score, reasons, counterEvidence, dataSource: "synthetic-demo" },
    },
  );
  return mapSignal(saved!);
}

async function refreshOpenPositions() {
  const openPositions = await db
    .select()
    .from(tradingPositionsTable)
    .where(eq(tradingPositionsTable.status, "open"));

  for (const position of openPositions) {
    const snapshot = getMarketSnapshot(position.symbol as SymbolCode);
    const currentPrice = snapshot.price;
    const sign = position.side === "LONG" ? 1 : -1;
    const unrealizedPnl = (currentPrice - position.entryPrice) * sign * position.quantity;
    const stopHit =
      position.side === "LONG"
        ? snapshot.candles.at(-1)!.low <= position.stopLoss
        : snapshot.candles.at(-1)!.high >= position.stopLoss;
    const targetHit =
      position.side === "LONG"
        ? snapshot.candles.at(-1)!.high >= position.takeProfit
        : snapshot.candles.at(-1)!.low <= position.takeProfit;

    if (stopHit || targetHit) {
      const exitPrice = stopHit ? position.stopLoss : position.takeProfit;
      const realizedPnl =
        (exitPrice - position.entryPrice) * sign * position.quantity;
      await db
        .update(tradingPositionsTable)
        .set({
          currentPrice: exitPrice,
          unrealizedPnl: 0,
          realizedPnl,
          status: "closed",
          closedAt: new Date(),
        })
        .where(eq(tradingPositionsTable.id, position.id));
      await writeAudit(
        stopHit ? "paper_stop_loss" : "paper_take_profit",
        `${position.symbol} paper position closed at ${stopHit ? "stop-loss" : "take-profit"}.`,
        {
          symbol: position.symbol,
          details: { positionId: position.id, exitPrice, realizedPnl },
        },
      );
    } else {
      await db
        .update(tradingPositionsTable)
        .set({ currentPrice, unrealizedPnl })
        .where(eq(tradingPositionsTable.id, position.id));
    }
  }
}

async function openPaperPosition(signal: Awaited<ReturnType<typeof evaluateSignal>>) {
  if (!signal.allowed || !signal.entryPrice || !signal.stopLoss || !signal.takeProfit) {
    return;
  }
  const settings = await ensureTradingSettings();
  const { account } = await calculateRisk(settings);
  const stopDistance = Math.abs(signal.entryPrice - signal.stopLoss);
  if (stopDistance <= 0 || account.equity <= 0) return;
  const riskAmount = account.equity * (settings.riskPerTradePct / 100);
  const quantity = riskAmount / stopDistance;
  const [position] = await db
    .insert(tradingPositionsTable)
    .values({
      symbol: signal.symbol,
      side: signal.action as Side,
      quantity,
      entryPrice: signal.entryPrice,
      currentPrice: signal.entryPrice,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      riskAmount,
      unrealizedPnl: 0,
      status: "open",
    })
    .returning();
  await writeAudit(
    "paper_position_opened",
    `${signal.symbol} paper position opened; no broker order was sent.`,
    {
      symbol: signal.symbol,
      details: {
        positionId: position!.id,
        quantity,
        entryPrice: signal.entryPrice,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        riskAmount,
      },
    },
  );
}

export async function runPaperEngineCycle(): Promise<void> {
  const settings = await ensureTradingSettings();
  if (settings.engineState !== "running") return;

  await refreshOpenPositions();
  for (const symbol of settings.enabledSymbols as SymbolCode[]) {
    const signal = await evaluateSignal(symbol);
    if (signal.allowed) {
      await openPaperPosition(signal);
    }
  }
}

export async function getDashboard() {
  const settings = await ensureTradingSettings();
  await refreshOpenPositions();
  const { snapshot: risk, account } = await calculateRisk(settings);
  const assets = (["XAUUSD", "BTCUSDT"] as SymbolCode[]).map((symbol) => {
    const market = getMarketSnapshot(symbol);
    return {
      symbol,
      label: market.label,
      price: market.price,
      bid: market.bid,
      ask: market.ask,
      change24hPct: round(market.change24hPct, 3),
      volume24h: round(market.volume24h, 2),
      timeframe: market.timeframe,
      trend: market.trend,
      source: market.source,
      isSynthetic: true,
    };
  });
  const [signals, positions, audit] = await Promise.all([
    db
      .select()
      .from(tradingSignalsTable)
      .orderBy(desc(tradingSignalsTable.createdAt))
      .limit(12),
    db
      .select()
      .from(tradingPositionsTable)
      .orderBy(desc(tradingPositionsTable.openedAt))
      .limit(20),
    db
      .select()
      .from(tradingAuditTable)
      .orderBy(desc(tradingAuditTable.createdAt))
      .limit(8),
  ]);
  const now = new Date();
  const unavailable = [
    {
      id: "mt5" as const,
      label: "MetaTrader 5",
      status: "disconnected" as const,
      detail: "Secure MT5 terminal bridge is not configured.",
      lastCheckedAt: now,
    },
    {
      id: "crypto" as const,
      label: "Crypto exchange",
      status: "disconnected" as const,
      detail: "Exchange and WebSocket provider are not selected or connected.",
      lastCheckedAt: now,
    },
    {
      id: "calendar" as const,
      label: "Economic calendar",
      status: "disconnected" as const,
      detail: "No verified calendar provider is connected; no events are assumed.",
      lastCheckedAt: now,
    },
    {
      id: "ai" as const,
      label: "AI explanation",
      status: "unavailable" as const,
      detail: "AI provider is not configured; deterministic rules remain active.",
      lastCheckedAt: now,
    },
  ];

  return {
    mode: "paper" as const,
    engineState: settings.engineState as EngineState,
    liveExecutionEnabled: false,
    lastUpdatedAt: now,
    account: {
      currency: account.currency,
      balance: account.balance,
      equity: account.equity,
      availableBalance: account.availableBalance,
      dayPnl: account.dayPnl,
      weekPnl: account.weekPnl,
      monthPnl: account.monthPnl,
      currentDrawdownPct: account.currentDrawdownPct,
    },
    risk,
    dataQuality: {
      status: "simulated" as const,
      provider: "Synthetic demo feed",
      quoteAgeSeconds: 0,
      stale: false,
      spreadHealthy: true,
      timestampHealthy: true,
      detail:
        "Synthetic prices are generated for testing only. They are not exchange or broker quotes.",
    },
    connections: unavailable,
    assets,
    signals: signals.map(mapSignal),
    positions: positions.map(mapPosition),
    calendarEvents: [],
    recentAudit: audit.map(mapAudit),
  };
}

export async function getTradingSettings() {
  return mapSettings(await ensureTradingSettings());
}

export async function updateTradingSettings(input: Record<string, unknown>) {
  const settings = await ensureTradingSettings();
  if (Object.keys(input).length === 0) {
    throw new Error("At least one setting must be provided.");
  }
  if (input.initialBalance !== undefined) {
    const [openPosition] = await db
      .select({ id: tradingPositionsTable.id })
      .from(tradingPositionsTable)
      .where(eq(tradingPositionsTable.status, "open"))
      .limit(1);
    if (openPosition) {
      throw new Error("Initial balance cannot change while paper positions are open.");
    }
  }

  const allowedKeys = [
    "initialBalance",
    "riskPerTradePct",
    "maxDailyLossPct",
    "maxWeeklyLossPct",
    "maxDrawdownPct",
    "minRiskReward",
    "minimumSignalScore",
    "newsBufferBeforeMinutes",
    "newsBufferAfterMinutes",
    "enabledSymbols",
  ];
  const update = Object.fromEntries(
    Object.entries(input).filter(([key]) => allowedKeys.includes(key)),
  );
  const [updated] = await db
    .update(tradingSettingsTable)
    .set({ ...update, updatedAt: new Date() })
    .where(eq(tradingSettingsTable.id, 1))
    .returning();

  await writeAudit(
    "settings_updated",
    "Paper trading risk settings were updated.",
    { details: { changedFields: Object.keys(update) } },
  );
  return mapSettings(updated ?? settings);
}

export async function controlEngine(action: "start" | "pause" | "stop" | "kill-switch") {
  const settings = await ensureTradingSettings();
  const nextState: EngineState =
    action === "start"
      ? settings.engineState === "emergency_stop"
        ? "emergency_stop"
        : "running"
      : action === "pause"
        ? "paused"
        : action === "kill-switch"
          ? "emergency_stop"
          : "stopped";
  if (action === "start" && settings.engineState === "emergency_stop") {
    throw new Error("Emergency stop is latched. Use Stop to reset before starting.");
  }
  const [updated] = await db
    .update(tradingSettingsTable)
    .set({ engineState: nextState, updatedAt: new Date() })
    .where(eq(tradingSettingsTable.id, 1))
    .returning();
  const message =
    action === "start"
      ? "Paper engine started. Only synthetic data and virtual orders are used."
      : action === "pause"
        ? "Paper engine paused; no new paper entries will be opened."
        : action === "kill-switch"
          ? "Emergency stop latched. The engine will not open new positions."
          : "Paper engine stopped; no broker or exchange orders were sent.";
  await writeAudit(
    action === "kill-switch" ? "kill_switch" : `engine_${action}`,
    message,
    {
      severity: action === "kill-switch" ? "critical" : "info",
      details: { previousState: settings.engineState, nextState },
    },
  );
  return {
    mode: "paper" as const,
    engineState: updated!.engineState as EngineState,
    liveExecutionEnabled: false,
    message,
    updatedAt: updated!.updatedAt,
  };
}

export async function evaluateTradingSignal(symbol: SymbolCode) {
  return evaluateSignal(symbol);
}

export async function getTradingSignals() {
  const rows = await db
    .select()
    .from(tradingSignalsTable)
    .orderBy(desc(tradingSignalsTable.createdAt))
    .limit(50);
  return rows.map(mapSignal);
}

export async function getTradingPositions() {
  await refreshOpenPositions();
  const rows = await db
    .select()
    .from(tradingPositionsTable)
    .orderBy(desc(tradingPositionsTable.openedAt))
    .limit(100);
  return rows.map(mapPosition);
}

export async function closeTradingPosition(positionId: number) {
  const [position] = await db
    .select()
    .from(tradingPositionsTable)
    .where(
      and(
        eq(tradingPositionsTable.id, positionId),
        eq(tradingPositionsTable.status, "open"),
      ),
    )
    .limit(1);
  if (!position) return null;
  const price = getMarketSnapshot(position.symbol as SymbolCode).price;
  const side = position.side === "LONG" ? 1 : -1;
  const realizedPnl = (price - position.entryPrice) * side * position.quantity;
  const [closed] = await db
    .update(tradingPositionsTable)
    .set({
      currentPrice: price,
      unrealizedPnl: 0,
      realizedPnl,
      status: "closed",
      closedAt: new Date(),
    })
    .where(eq(tradingPositionsTable.id, position.id))
    .returning();
  await writeAudit(
    "paper_position_closed",
    `${position.symbol} paper position closed manually; no exchange order was sent.`,
    {
      symbol: position.symbol,
      details: { positionId, exitPrice: price, realizedPnl },
    },
  );
  return mapPosition(closed!);
}

export async function getTradingAudit(limit: number) {
  const events = await db
    .select()
    .from(tradingAuditTable)
    .orderBy(desc(tradingAuditTable.createdAt))
    .limit(limit);
  return events.map(mapAudit);
}

export async function getTradingBacktests() {
  const rows = await db
    .select()
    .from(tradingBacktestsTable)
    .orderBy(desc(tradingBacktestsTable.createdAt))
    .limit(50);
  return rows.map((row) => ({
    ...(row.result as Record<string, unknown>),
    id: row.id,
    symbol: row.symbol as SymbolCode,
    strategy: row.strategy,
    datasetLabel: row.datasetLabel,
    createdAt: row.createdAt,
  }));
}

export async function createTradingBacktest(input: {
  symbol: SymbolCode;
  strategy: "gold-breakout-retest" | "btc-trend-momentum";
  initialBalance: number;
  riskPerTradePct: number;
  feeBps: number;
  slippageBps: number;
}) {
  if (
    (input.symbol === "XAUUSD" && input.strategy !== "gold-breakout-retest") ||
    (input.symbol === "BTCUSDT" && input.strategy !== "btc-trend-momentum")
  ) {
    throw new Error("The selected strategy does not match the chosen symbol.");
  }
  const result = runSyntheticBacktest(input);
  const [saved] = await db
    .insert(tradingBacktestsTable)
    .values({
      symbol: result.symbol,
      strategy: result.strategy,
      datasetLabel: result.datasetLabel,
      result,
    })
    .returning();
  await writeAudit(
    "backtest_completed",
    `${result.symbol} backtest completed on synthetic sample data.`,
    {
      symbol: result.symbol,
      details: {
        backtestId: saved!.id,
        datasetLabel: result.datasetLabel,
        tradeCount: result.tradeCount,
      },
    },
  );
  return {
    ...result,
    id: saved!.id,
    createdAt: saved!.createdAt,
  };
}
