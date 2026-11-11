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
  enrichDecisionWithAi,
  getExnessConfig,
  isAiConfigured,
} from "./ai-analyst";
import { narrate, getNarrations } from "./agent-narrator";
import {
  getCalendarStatus,
  getEconomicCalendar,
  isInsideNewsBuffer,
  refreshEconomicCalendar,
} from "./calendar-feed";
import {
  getLiveOrSyntheticSnapshot,
  getMarketFeedStatus,
  refreshLiveMarket,
} from "./live-market";
import {
  closeMt5Position,
  getMt5BridgeStatus,
  listMt5Positions,
  mt5VolumeForRisk,
  placeMt5MarketOrder,
} from "./mt5-bridge";
import {
  calculateAtr,
  calculateEma,
  generateCandles,
  type SymbolCode,
} from "./market-simulator";

const getMarketSnapshot = getLiveOrSyntheticSnapshot;

type EngineState = "stopped" | "running" | "paused" | "emergency_stop";
type Side = "LONG" | "SHORT";

/** Umumiy ochiq zilka limiti — holat yaxshi bo‘lsa ko‘proq ochiladi. */
const MAX_OPEN_POSITIONS = Number(process.env.MAX_OPEN_POSITIONS ?? 10);
/** Bir aktivda bir vaqtda nechta zilka (pyramiding). */
const MAX_PER_SYMBOL = Number(process.env.MAX_PER_SYMBOL ?? 4);

/** positionId -> MT5 ticket */
const mt5Tickets = new Map<number, number>();
/** symbol -> MT5 ticket (fallback) */
const mt5TicketsBySymbol = new Map<string, number>();

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
    forecast: row.forecast,
    analysis: row.analysis,
    recommendation: row.recommendation,
    agentVerdict: row.agentVerdict as
      | "auto_enter"
      | "manual_confirm"
      | "no_trade",
    entered: row.entered,
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
    autoEnterMinScore: row.autoEnterMinScore,
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

async function evaluateSignal(
  symbol: SymbolCode,
  options: { forceAi?: boolean } = {},
) {
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
  let strategy =
    symbol === "XAUUSD" ? "Plus-only · XAU aniq signal" : "Plus-only · BTC aniq signal";
  const volumeConfirmed = last.volume >= volumeAverage * 1.0;
  // Minusdan qochish: faqat aniq trend + momentum bir tomonda bo‘lsa kandidat.
  if (trend === "uptrend" && momentum > 0.0008 && ema20 > ema50) candidate = "LONG";
  if (trend === "downtrend" && momentum < -0.0008 && ema20 < ema50) candidate = "SHORT";
  const triggerConfirmed = Boolean(candidate);
  const trendConfirmed =
    (candidate === "LONG" && ema20 > ema50 && trend === "uptrend") ||
    (candidate === "SHORT" && ema20 < ema50 && trend === "downtrend");
  const momentumConfirmed =
    candidate === "LONG" ? momentum > 0.0008 : candidate === "SHORT" ? momentum < -0.0008 : false;
  const score = Math.min(
    100,
    (trendConfirmed ? 30 : 0) +
      (triggerConfirmed ? 25 : 0) +
      (momentumConfirmed ? 15 : 0) +
      (volumeConfirmed ? 10 : 0) +
      (!highVolatility ? 10 : 0) +
      (snapshot.spreadHealthy ? 10 : 0),
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
  const sameSymbol = activePositions.filter((position) => position.symbol === symbol);
  const sameSideOpen = sameSymbol.filter((position) => position.side === candidate);
  const sameSymbolPnl = sameSymbol.reduce((sum, p) => sum + p.unrealizedPnl, 0);
  // Plusda ko‘paytirish mumkin; minusda yangi zilka yo‘q; qarshi tomon — avval yopiladi.
  const canPyramid =
    Boolean(candidate) &&
    sameSideOpen.length > 0 &&
    sameSideOpen.length < MAX_PER_SYMBOL &&
    sameSymbolPnl > 0;
  const blockedSameSymbol =
    sameSymbol.length > 0 &&
    !canPyramid &&
    sameSymbol.some((p) => p.side === candidate);
  const reasons: string[] = [];
  const counterEvidence: string[] = [];

  if (candidate) reasons.push(`${trend} · aniq tomon: ${candidate}.`);
  else reasons.push("Aniq tomon yo‘q — minus xavfi uchun kirish yopiq.");
  reasons.push("Plus-only: minus setup ochilmaydi; plusda yana ochaveradi.");
  if (canPyramid) {
    reasons.push(
      `Plus pyramiding: ${symbol} da +${round(sameSymbolPnl)} — yana ochish mumkin (${sameSideOpen.length}/${MAX_PER_SYMBOL}).`,
    );
  }
  if (volumeConfirmed) reasons.push("Hajm tasdig‘i bor.");
  else counterEvidence.push("Hajm zaif — minus ehtimoli yuqori.");
  if (highVolatility) counterEvidence.push("Volatililik yuqori — minus/silif xavfi.");
  if (!snapshot.spreadHealthy) counterEvidence.push("Spred keng — minus xavfi.");
  if (risk.status === "blocked") counterEvidence.push(...risk.reasons);
  if (blockedSameSymbol && sameSymbolPnl <= 0) {
    counterEvidence.push("Shu aktivda minusdagi zilka bor — yangisi ochilmaydi.");
  }
  if (sameSymbol.length >= MAX_PER_SYMBOL) {
    counterEvidence.push(`Shu aktiv limiti (${MAX_PER_SYMBOL}) to‘ldi.`);
  }
  if (activePositions.length >= MAX_OPEN_POSITIONS) {
    counterEvidence.push(`Umumiy zilka limiti (${MAX_OPEN_POSITIONS}) yetdi.`);
  }
  if (!settings.enabledSymbols.includes(symbol)) {
    counterEvidence.push("Aktiv sozlamalarda o‘chirilgan.");
  }
  if (trend === "range") counterEvidence.push("Oraliq bozor — minus bo‘lishi mumkin, ochilmaydi.");
  if (!trendConfirmed) counterEvidence.push("Trend tasdiqlanmadi — minusdan qochish.");
  if (!momentumConfirmed) counterEvidence.push("Momentum qarshi/zaif — minusdan qochish.");
  if (snapshot.isSynthetic) counterEvidence.push("Sintetik narx — aniq prognoz yo‘q.");

  const sideLabel =
    candidate === "LONG" ? "xarid (LONG)" : candidate === "SHORT" ? "sotuv (SHORT)" : "kuzatuv";
  const trendUz =
    trend === "uptrend" ? "o'sish" : trend === "downtrend" ? "pasayish" : "oraliq";
  let analysis = [
    `${shortSymbolLabel(symbol)} bozor holati: ${trendUz} trendi, rejim=${regime}.`,
    `EMA20=${round(ema20, 2)}, EMA50=${round(ema50, 2)}, ATR=${round(atr, 4)}.`,
    `Momentum=${round(momentum * 100, 3)}%, hajm o‘rtacha nisbati=${round(last.volume / Math.max(volumeAverage, 1), 2)}.`,
    triggerConfirmed
      ? "Strategiya triggeri faol: kirish sharti bajarildi."
      : "Strategiya triggeri faol emas: aniq kirish sharti yo‘q.",
  ].join(" ");

  let forecast = candidate
    ? `${shortSymbolLabel(symbol)} uchun yaqin muddatli stsenariy: ${sideLabel} yo‘nalishida harakat ehtimoli. Maqsad ${takeProfit == null ? "aniqlanmagan" : round(takeProfit, 2)}, himoya ${stopLoss == null ? "aniqlanmagan" : round(stopLoss, 2)}. Bu prognoz kafolat emas.`
    : `${shortSymbolLabel(symbol)} uchun aniq yo‘nalishli prognoz shakllanmadi. Bozor ${trendUz} holatida; kuzatuv davom etadi.`;

  // AI ga dunyo yangiliklarini berish (kalendar cache bo'sh bo'lsa yangilash)
  if (getEconomicCalendar(1).length === 0) {
    try {
      await refreshEconomicCalendar();
    } catch {
      /* ignore — AI newsiz ishlayveradi */
    }
  }
  const newsForAi = getEconomicCalendar(12)
    .filter((event) => {
      const mins = (event.scheduledAt.getTime() - Date.now()) / 60_000;
      return mins >= -180 && mins <= 48 * 60;
    })
    .slice(0, 8)
    .map((event) => ({
      title: event.title,
      currency: event.currency,
      impact: event.impact,
      when: event.scheduledAt.toISOString(),
      minutesUntil: Math.round(
        (event.scheduledAt.getTime() - Date.now()) / 60_000,
      ),
    }));
  const usdHigh = newsForAi.filter(
    (e) =>
      (e.currency === "USD" || e.currency === "ALL") &&
      (e.impact === "high" || e.impact === "medium"),
  );
  const newsBiasHint =
    usdHigh.length > 0
      ? `USD yuqori/o'rta yangiliklar bor (${usdHigh.map((e) => e.title).join("; ")}). XAU odatda USD kuchida pastga, USD zaifida tepaga; BTC risk-on/off ga sezgir.`
      : "Yaqin USD high-impact yangilik kam — asosan texnik + umumiy risk sentiment.";

  const ai = await enrichDecisionWithAi(
    {
      symbol,
      candidate,
      score,
      trend,
      regime,
      price: snapshot.price,
      bid: snapshot.bid,
      ask: snapshot.ask,
      ema20,
      ema50,
      atr,
      momentumPct: round(momentum * 100, 3),
      volumeRatio: round(last.volume / Math.max(volumeAverage, 1), 2),
      entryPrice,
      stopLoss,
      takeProfit,
      riskReasons: risk.reasons,
      counterEvidence,
      newsEvents: newsForAi,
      newsBiasHint,
    },
    { force: options.forceAi === true },
  );

  let aiConfidence = 0;
  let aiAllows = false;
  if (ai.provider === "openai" && ai.analysis) {
    analysis = ai.analysis;
    forecast = ai.forecast || forecast;
    aiConfidence = ai.confidence;
    aiAllows = ai.allowEntry && aiConfidence >= 75;
    if (ai.reasons.length) reasons.push(...ai.reasons.map((item) => `AI: ${item}`));
    if (aiAllows) {
      reasons.push(`AI aniq tasdiq · ishonch ${ai.confidence}/100.`);
    } else {
      counterEvidence.push(
        `AI minus ehtimolini ko‘rdi yoki ishonch past (${ai.confidence}/100) — ochilmaydi.`,
      );
    }
  } else if (isAiConfigured()) {
    counterEvidence.push(
      ai.reasons[0] ?? "AI aniq tahlilsiz kirish yopiq (minusdan himoya).",
    );
  } else {
    counterEvidence.push("OPENAI_API_KEY yo‘q — aniq prognozsiz ochilmaydi.");
  }

  const upcomingNews = getEconomicCalendar(6).filter((event) => {
    const mins = (event.scheduledAt.getTime() - Date.now()) / 60_000;
    return mins >= -15 && mins <= 180 && (event.impact === "high" || event.impact === "medium");
  });
  if (newsForAi.length > 0) {
    reasons.push(
      `Yangiliklar AI ga berildi: ${newsForAi
        .slice(0, 3)
        .map((e) => `${e.currency} ${e.title}`)
        .join(" · ")}`,
    );
  }
  const newsAligned =
    upcomingNews.length > 0 &&
    aiAllows &&
    candidate !== null &&
    trendConfirmed;
  if (newsAligned) {
    reasons.push(
      `Yangilik/prognoz mos: ${upcomingNews[0]!.currency} · ${upcomingNews[0]!.title}`,
    );
  }

  const hasClearForecast =
    analysis.trim().length > 50 &&
    forecast.trim().length > 50 &&
    aiAllows &&
    aiConfidence >= 75 &&
    candidate !== null &&
    trendConfirmed &&
    momentumConfirmed;

  const newsGate = isInsideNewsBuffer(
    settings.newsBufferBeforeMinutes,
    settings.newsBufferAfterMinutes,
  );
  // Yuqori ta’sirli yangilik buffferida faqat AI+trend aniq bo‘lsa (newsAligned) ochiladi; aks holda yopiq.
  if (newsGate.blocked && !newsAligned) {
    counterEvidence.push(
      `${newsGate.reason ?? "Yangilik buferi"} — minus/silif xavfi, ochilmaydi.`,
    );
  }

  const minScore = 70;
  const plusOnlySafe =
    hasClearForecast &&
    !highVolatility &&
    snapshot.spreadHealthy &&
    !snapshot.isSynthetic &&
    trend !== "range" &&
    volumeConfirmed &&
    risk.status === "clear";

  let allowed =
    candidate !== null &&
    score >= minScore &&
    plusOnlySafe &&
    !blockedSameSymbol &&
    sameSymbol.length < MAX_PER_SYMBOL &&
    activePositions.length < MAX_OPEN_POSITIONS &&
    settings.enabledSymbols.includes(symbol) &&
    triggerConfirmed &&
    (!newsGate.blocked || newsAligned);

  if (candidate && score < minScore) {
    counterEvidence.push(`Ball ${score} < ${minScore} — minusdan himoya.`);
  }
  if (!hasClearForecast) {
    counterEvidence.push("Aniq prognoz/AI tasdiqi yo‘q — zilka ochilmaydi.");
    allowed = false;
  }
  if (!plusOnlySafe) {
    counterEvidence.push("Plus-only shartlari bajarilmadi — minus bo‘lishi mumkin zilka rad.");
    allowed = false;
  }

  const combinedScore = Math.round(score * 0.45 + aiConfidence * 0.55);
  const autoThreshold = 78;
  let agentVerdict: "auto_enter" | "manual_confirm" | "no_trade" = "no_trade";
  if (allowed && candidate && combinedScore >= autoThreshold && aiAllows) {
    agentVerdict = "auto_enter";
  } else if (allowed && candidate && aiAllows) {
    agentVerdict = "manual_confirm";
  }

  const recommendation =
    ai.recommendation ||
    (agentVerdict === "auto_enter"
      ? `Aniq prognoz + plus-only: ${sideLabel}, risk $0.1. Agent o‘zi ochadi/yopadi.`
      : agentVerdict === "manual_confirm"
        ? `Signal aniq, lekin avto-ishonch ${combinedScore}/${autoThreshold}. Bir tugma mumkin.`
        : `Minus ehtimoli yoki aniq signal yo‘q — ochilmaydi. ${counterEvidence[0] ?? ""}`);

  const action = allowed && candidate ? candidate : "NO_TRADE";
  if (action === "NO_TRADE" && reasons.length === 0) {
    reasons.push("Majburiy tekshiruvlardan o‘tgan signal topilmadi.");
  }

  const dataSource =
    ai.provider === "openai" ? `rules+openai:${ai.model}` : "synthetic-demo";

  const [saved] = await db
    .insert(tradingSignalsTable)
    .values({
      symbol,
      strategy,
      action,
      score: combinedScore || score,
      marketRegime: regime,
      entryPrice,
      stopLoss,
      takeProfit,
      riskReward: entryPrice === null ? null : settings.minRiskReward,
      allowed,
      reasons,
      counterEvidence,
      forecast,
      analysis,
      recommendation,
      agentVerdict,
      entered: false,
      dataSource,
    })
    .returning();

  const summary = allowed
    ? `${symbol}: ${agentVerdict} · ${action} · ball ${combinedScore || score} · AI ${aiConfidence}.`
    : `${symbol}: NO_TRADE · ball ${score}; ${counterEvidence[0] ?? "shart bajarilmadi"}.`;
  await writeAudit(allowed ? "signal_approved_for_paper" : "signal_rejected", summary, {
    severity: allowed ? "info" : "warning",
    symbol,
    details: {
      score,
      combinedScore,
      aiConfidence,
      aiProvider: ai.provider,
      reasons,
      counterEvidence,
      forecast,
      analysis,
      recommendation,
      agentVerdict,
      dataSource,
    },
  });
  narrate(
    allowed
      ? `Agent: ${shortSymbolLabel(symbol)} uchun ${action}. ${recommendation}`
      : `Agent: ${shortSymbolLabel(symbol)} da kutaman. ${counterEvidence[0] ?? "Aniq signal yo‘q."}`,
    {
      kind: allowed ? "agent_ready" : "agent_wait",
      tone: allowed ? "good" : "neutral",
    },
  );
  return mapSignal(saved!);
}

function shortSymbolLabel(symbol: SymbolCode) {
  return symbol === "XAUUSD" ? "Oltin/USD" : "Bitcoin/USDT";
}

async function closeOnMt5(symbol: string, positionId?: number) {
  const ticket =
    (positionId ? mt5Tickets.get(positionId) : undefined) ??
    mt5TicketsBySymbol.get(symbol);
  const result = await closeMt5Position({ ticket, symbol });
  if (positionId) mt5Tickets.delete(positionId);
  mt5TicketsBySymbol.delete(symbol);
  return result;
}

async function finalizeClose(
  position: typeof tradingPositionsTable.$inferSelect,
  exitPrice: number,
  reason: "stop_loss" | "take_profit" | "trail_lock" | "slip_guard" | "reverse" | "manual",
) {
  const sign = position.side === "LONG" ? 1 : -1;
  const realizedPnl =
    (exitPrice - position.entryPrice) * sign * position.quantity;
  const mt5 = await closeOnMt5(position.symbol, position.id);
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
  const label =
    reason === "stop_loss"
      ? "Stop-loss"
      : reason === "take_profit"
        ? "Take-profit"
        : reason === "trail_lock"
          ? "Foyda qulflash"
          : reason === "reverse"
            ? "Teskari signal"
            : reason === "slip_guard"
              ? "Silif himoya"
              : "Qo‘lda";
  await writeAudit(
    `agent_${reason}_close`,
    `${position.symbol}: agent yopdi · ${label} · PnL ${round(realizedPnl)} · MT5 ${mt5.ok ? "ok" : mt5.error ?? "yo‘q"}`,
    {
      severity: realizedPnl >= 0 ? "info" : "warning",
      symbol: position.symbol,
      details: {
        positionId: position.id,
        exitPrice,
        realizedPnl,
        reason,
        mt5,
      },
    },
  );
  narrate(
    `Agent yopdi: ${shortSymbolLabel(position.symbol as SymbolCode)} · ${label} · ${realizedPnl >= 0 ? "+" : ""}${round(realizedPnl)} USD`,
    { kind: "agent_exit", tone: realizedPnl >= 0 ? "good" : "bad" },
  );
}

async function refreshOpenPositions() {
  const openPositions = await db
    .select()
    .from(tradingPositionsTable)
    .where(eq(tradingPositionsTable.status, "open"));

  let mt5Open: Awaited<ReturnType<typeof listMt5Positions>> = [];
  try {
    mt5Open = await listMt5Positions();
    // Mavjud broker pozitsiyalarini ticket xotirasiga bog‘lash
    for (const position of openPositions) {
      if (mt5Tickets.has(position.id)) continue;
      const match = mt5Open.find((row) => {
        const mapped =
          position.symbol === "XAUUSD"
            ? row.symbol.startsWith("XAU")
            : row.symbol.startsWith("BTC");
        const sideOk =
          (position.side === "LONG" && row.type === "LONG") ||
          (position.side === "SHORT" && row.type === "SHORT");
        return mapped && sideOk;
      });
      if (match) {
        mt5Tickets.set(position.id, match.ticket);
        mt5TicketsBySymbol.set(position.symbol, match.ticket);
      }
    }
  } catch {
    mt5Open = [];
  }

  for (const position of openPositions) {
    const snapshot = getMarketSnapshot(position.symbol as SymbolCode);
    const currentPrice = snapshot.price;
    const sign = position.side === "LONG" ? 1 : -1;
    const unrealizedPnl =
      (currentPrice - position.entryPrice) * sign * position.quantity;
    const last = snapshot.candles.at(-1)!;
    const stopHit =
      position.side === "LONG"
        ? last.low <= position.stopLoss
        : last.high >= position.stopLoss;
    const targetHit =
      position.side === "LONG"
        ? last.high >= position.takeProfit
        : last.low <= position.takeProfit;

    // Brokerda allaqachon yopilgan bo‘lsa — DB ni ham yopamiz
    const brokerAlive = mt5Open.some((row) => {
      const mapped =
        position.symbol === "XAUUSD"
          ? row.symbol.startsWith("XAU")
          : row.symbol.startsWith("BTC");
      const ticket = mt5Tickets.get(position.id);
      return mapped && (ticket ? row.ticket === ticket : true);
    });
    if (mt5Open.length > 0 && !brokerAlive && mt5Tickets.has(position.id)) {
      await finalizeClose(position, currentPrice, "take_profit");
      continue;
    }

    if (stopHit || targetHit) {
      await finalizeClose(
        position,
        stopHit ? position.stopLoss : position.takeProfit,
        stopHit ? "stop_loss" : "take_profit",
      );
      continue;
    }

    let nextStop = position.stopLoss;
    const progressR =
      position.riskAmount > 0 ? unrealizedPnl / position.riskAmount : 0;
    // Foyda 0.4R+: stop → breakeven; 1R+: stop → yarim yo‘l (foydani qulflash)
    if (progressR >= 1) {
      if (position.side === "LONG") {
        nextStop = Math.max(
          position.stopLoss,
          position.entryPrice + (position.takeProfit - position.entryPrice) * 0.35,
        );
      } else {
        nextStop = Math.min(
          position.stopLoss,
          position.entryPrice - (position.entryPrice - position.takeProfit) * 0.35,
        );
      }
    } else if (progressR >= 0.4) {
      if (position.side === "LONG") {
        nextStop = Math.max(position.stopLoss, position.entryPrice);
      } else {
        nextStop = Math.min(position.stopLoss, position.entryPrice);
      }
    }

    // 1.2R foydada agent o‘zi yopadi (plus qulflash)
    if (progressR >= 1.2) {
      await finalizeClose(position, currentPrice, "trail_lock");
      continue;
    }

    // Silifni qoldirmaslik: minus riskning 70%iga yetishi yoki SL yaqinlashishi bilan yopiladi.
    const towardStop =
      position.side === "LONG"
        ? (position.entryPrice - currentPrice) /
          Math.max(position.entryPrice - position.stopLoss, 1e-9)
        : (currentPrice - position.entryPrice) /
          Math.max(position.stopLoss - position.entryPrice, 1e-9);
    const slipCut =
      unrealizedPnl < 0 &&
      (Math.abs(unrealizedPnl) >= Math.max(position.riskAmount * 0.7, 0.05) ||
        towardStop >= 0.85);
    if (slipCut) {
      await finalizeClose(position, currentPrice, "slip_guard");
      continue;
    }

    await db
      .update(tradingPositionsTable)
      .set({ currentPrice, unrealizedPnl, stopLoss: nextStop })
      .where(eq(tradingPositionsTable.id, position.id));
    if (nextStop !== position.stopLoss) {
      await writeAudit(
        "breakeven_trail",
        `${position.symbol}: stop trail · ${round(nextStop)} (plus himoya).`,
        {
          symbol: position.symbol,
          details: { positionId: position.id, stopLoss: nextStop, progressR },
        },
      );
    }
  }
}

async function openPaperPosition(
  signal: Awaited<ReturnType<typeof evaluateSignal>>,
  source: "auto" | "manual" = "auto",
) {
  if (
    !signal.allowed ||
    signal.action === "NO_TRADE" ||
    !signal.entryPrice ||
    !signal.stopLoss ||
    !signal.takeProfit ||
    !signal.forecast?.trim() ||
    !signal.analysis?.trim() ||
    !signal.recommendation?.trim()
  ) {
    return null;
  }
  if (signal.entered) return null;

  const settings = await ensureTradingSettings();
  if (settings.engineState === "emergency_stop") {
    throw new Error("Favqulodda to‘xtash faol: yangi kirishlar yopiq.");
  }
  const { snapshot: risk, account } = await calculateRisk(settings);
  if (risk.status === "blocked") {
    throw new Error(risk.reasons[0] ?? "Xavf bloki sababli kirish mumkin emas.");
  }
  const sameSymbol = account.openPositions.filter(
    (position) => position.symbol === signal.symbol,
  );
  const samePnl = sameSymbol.reduce((sum, p) => sum + p.unrealizedPnl, 0);
  if (sameSymbol.length >= MAX_PER_SYMBOL) {
    throw new Error(`Ushbu aktivda ${MAX_PER_SYMBOL} zilka limiti to‘ldi.`);
  }
  if (
    sameSymbol.length > 0 &&
    samePnl <= 0 &&
    sameSymbol.some((p) => p.side === signal.action)
  ) {
    throw new Error("Minusdagi zilka ustiga yangisi ochilmaydi (plus-only).");
  }
  if (account.openPositions.length >= MAX_OPEN_POSITIONS) {
    throw new Error(`Maksimal ochiq zilka limiti (${MAX_OPEN_POSITIONS}) yetdi.`);
  }

  const stopDistance = Math.abs(signal.entryPrice - signal.stopLoss);
  if (stopDistance <= 0 || account.equity <= 0) return null;
  // Foydalanuvchi: har doim $0.1 risk; minusni kattalashtirmaslik uchun scale yo‘q.
  const riskAmount = Number(process.env.BASE_RISK_USD ?? 0.1);
  const quantity = mt5VolumeForRisk(riskAmount, stopDistance);
  const mt5 = await placeMt5MarketOrder({
    symbol: signal.symbol,
    side: signal.action as Side,
    volume: quantity,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    comment: `Mizan ${source}`,
  });
  if (!mt5.ok) {
    await writeAudit(
      "mt5_order_failed",
      `${signal.symbol}: MT5 buyurtma xato — ${mt5.error ?? "noma’lum"}`,
      {
        severity: "critical",
        symbol: signal.symbol,
        details: { ...mt5, source },
      },
    );
    narrate(
      `MT5 ga yuborilmadi (${signal.symbol}): ${mt5.error ?? "AutoTrading/bridge xatosi"}`,
      { kind: "mt5_order_failed", tone: "bad" },
    );
    throw new Error(
      mt5.error?.includes("10027")
        ? "MT5 da Algo Trading o‘chiq. Terminalda AlgoTrading tugmasini yoqing."
        : `MT5 buyurtma bajarilmadi: ${mt5.error ?? "xato"}`,
    );
  }

  const fillPrice = mt5.price ?? signal.entryPrice;
  const [position] = await db
    .insert(tradingPositionsTable)
    .values({
      symbol: signal.symbol,
      side: signal.action as Side,
      quantity: mt5.volume ?? quantity,
      entryPrice: fillPrice,
      currentPrice: fillPrice,
      stopLoss: mt5.sl ?? signal.stopLoss,
      takeProfit: mt5.tp ?? signal.takeProfit,
      riskAmount,
      unrealizedPnl: 0,
      status: "open",
    })
    .returning();

  await db
    .update(tradingSignalsTable)
    .set({ entered: true })
    .where(eq(tradingSignalsTable.id, signal.id));

  if (mt5.order) {
    mt5Tickets.set(position!.id, mt5.order);
    mt5TicketsBySymbol.set(signal.symbol, mt5.order);
  }

  await writeAudit(
    source === "manual" ? "manual_mt5_entry" : "mt5_position_opened",
    source === "manual"
      ? `${mt5.symbol ?? signal.symbol}: MT5 ga bir tugmali kirish (#${mt5.order}).`
      : `${mt5.symbol ?? signal.symbol}: agent MT5 da pozitsiya ochdi (#${mt5.order}).`,
    {
      symbol: signal.symbol,
      details: {
        positionId: position!.id,
        quantity: mt5.volume ?? quantity,
        entryPrice: fillPrice,
        stopLoss: mt5.sl ?? signal.stopLoss,
        takeProfit: mt5.tp ?? signal.takeProfit,
        riskAmount,
        source,
        mt5,
        agentVerdict: signal.agentVerdict,
        forecast: signal.forecast,
      },
    },
  );
  const maxMinus = round(
    Math.abs(fillPrice - (mt5.sl ?? signal.stopLoss)) * (mt5.volume ?? quantity),
  );
  const planPlus = round(
    Math.abs((mt5.tp ?? signal.takeProfit) - fillPrice) * (mt5.volume ?? quantity),
  );
  narrate(
    `OCHILDI ${mt5.symbol}: ${signal.action === "LONG" ? "BUY" : "SELL"} ${mt5.volume} lot @ ${round(fillPrice)} · yopish TP ${round(mt5.tp ?? signal.takeProfit)} (≈+$${planPlus}) · SL ${round(mt5.sl ?? signal.stopLoss)} (maks minus ≈-$${maxMinus}) · ticket #${mt5.order}`,
    { kind: "mt5_enter", tone: "good" },
  );
  return mapPosition(position!);
}

export async function runPaperEngineCycle(): Promise<void> {
  const settings = await ensureTradingSettings();
  if (settings.engineState !== "running") return;

  narrate("Agent sikli: pozitsiyalar yangilanmoqda, bozor qayta baholanmoqda…", {
    kind: "agent_cycle",
    tone: "neutral",
  });
  await refreshOpenPositions();
  const openRows = await db
    .select()
    .from(tradingPositionsTable)
    .where(eq(tradingPositionsTable.status, "open"));

  for (const symbol of settings.enabledSymbols as SymbolCode[]) {
    const signal = await evaluateSignal(symbol);
    const openSame = openRows.find((row) => row.symbol === symbol);

    // Teskari aniq signal → avval yopadi, keyin yangi tomonga kiradi
    if (
      openSame &&
      signal.allowed &&
      signal.agentVerdict === "auto_enter" &&
      signal.action !== "NO_TRADE" &&
      signal.action !== openSame.side
    ) {
      await finalizeClose(openSame, getMarketSnapshot(symbol).price, "reverse");
    }

    if (signal.agentVerdict === "auto_enter") {
      try {
        const opened = await openPaperPosition(signal, "auto");
        if (opened) {
          narrate(
            `Agent kirdi: ${shortSymbolLabel(symbol)} · ${signal.action} · risk ~$${Number(process.env.BASE_RISK_USD ?? 0.1)}`,
            { kind: "agent_enter", tone: "good" },
          );
        }
      } catch (error) {
        narrate(
          `Agent kira olmadi (${symbol}): ${error instanceof Error ? error.message : "xato"}`,
          { kind: "agent_enter_blocked", tone: "bad" },
        );
      }
    }
  }
}

export async function enterTradingSignal(signalId: number) {
  const [row] = await db
    .select()
    .from(tradingSignalsTable)
    .where(eq(tradingSignalsTable.id, signalId))
    .limit(1);
  if (!row) return null;
  const signal = mapSignal(row);
  if (!signal.allowed || signal.agentVerdict === "no_trade") {
    throw new Error(
      "Bu signal uchun kirish yopiq: aniq tahlil/prognoz yoki ruxsat yo‘q.",
    );
  }
  if (signal.entered) {
    throw new Error("Bu signal bo‘yicha allaqachon kirilgan.");
  }
  const position = await openPaperPosition(signal, "manual");
  if (!position) {
    throw new Error("Kirish bajarilmadi: narx yoki risk shartlari yetarli emas.");
  }
  return position;
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
      isSynthetic: market.isSynthetic,
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
      .limit(16),
  ]);
  const now = new Date();
  const exness = getExnessConfig();
  const aiReady = isAiConfigured();
  const feed = getMarketFeedStatus();
  const mt5 = await getMt5BridgeStatus();
  const mappedSignals = signals.map(mapSignal);
  const mappedPositions = positions.map(mapPosition);
  const openPositions = mappedPositions.filter((item) => item.status === "open");
  const latestSignal = mappedSignals[0];
  const baseRiskUsd = Number(process.env.BASE_RISK_USD ?? 0.1);
  const unavailable = [
    {
      id: "mt5" as const,
      label: "Exness · MetaTrader 5",
      status: (mt5.connected
        ? "connected"
        : mt5.installed || exness.configured
          ? "degraded"
          : "disconnected") as "connected" | "degraded" | "disconnected",
      detail: mt5.connected
        ? mt5.detail
        : mt5.installed
          ? `Terminal topildi. ${exness.login}@${exness.server} — MT5 ichida login qilib Algo Trading yoqing.`
          : exness.configured
            ? `Hisob ${exness.login} · ${exness.server} sozlandi, terminal hali tayyor emas.`
            : "Exness MT5 sozlanmagan.",
      lastCheckedAt: now,
    },
    {
      id: "crypto" as const,
      label: "BTC live oqimi",
      status: (feed.btcLive ? "connected" : "degraded") as
        | "connected"
        | "degraded",
      detail: feed.btcLive
        ? `BTCUSDT live · yoshi ${feed.btcAge ?? 0}s`
        : "BTC spot API yangilanmadi; fallback ishlatilishi mumkin.",
      lastCheckedAt: now,
    },
    {
      id: "calendar" as const,
      label: "Iqtisodiy taqvim",
      status: (getCalendarStatus().connected ? "connected" : "disconnected") as
        | "connected"
        | "disconnected",
      detail: getCalendarStatus().detail,
      lastCheckedAt: now,
    },
    {
      id: "ai" as const,
      label: "OpenAI agent tahlili",
      status: (aiReady ? "connected" : "unavailable") as
        | "connected"
        | "unavailable",
      detail: aiReady
        ? "gpt-4o-mini · plus-only: AI rad etsa / noaniq bo‘lsa kirmaydi."
        : "OPENAI_API_KEY yo‘q. AI tahlilsiz kirish yopiq.",
      lastCheckedAt: now,
    },
  ];

  const liveBoth = feed.btcLive && feed.xauLive;
  const anyLive = feed.btcLive || feed.xauLive;
  const openCount = openPositions.length;
  const engineAction =
    settings.engineState === "running"
      ? openCount > 0
        ? `Agent boshqaradi: ${openCount}/${MAX_OPEN_POSITIONS} ochiq · plusda yana ochadi · SL/TP/trail yopadi`
        : latestSignal?.agentVerdict === "auto_enter"
          ? `${latestSignal.symbol} · agent avtokirishga tayyor`
          : latestSignal?.agentVerdict === "manual_confirm"
            ? `${latestSignal.symbol} · bir tugma kutilyapti`
            : "Kuzatuv: aniq signal yo‘q — kirmaydi"
      : settings.engineState === "paused"
        ? "Pauza: yangi kirish yo‘q"
        : "To‘xtatilgan";

  const charts = (["XAUUSD", "BTCUSDT"] as SymbolCode[]).map((symbol) => {
    const market = getMarketSnapshot(symbol);
    const candles = market.candles.slice(-80);
    const closes = candles.map((c) => c.close);
    const ema20 = calculateEma(closes.slice(-40), 20);
    const ema50 = calculateEma(closes.slice(-90), 50);
    const openPos = openPositions.find((p) => p.symbol === symbol);
    const signal =
      mappedSignals.find((s) => s.symbol === symbol && s.allowed) ??
      mappedSignals.find((s) => s.symbol === symbol);
    const window = candles.slice(-20);
    const swingHigh = Math.max(...window.map((c) => c.high));
    const swingLow = Math.min(...window.map((c) => c.low));
    const side =
      openPos?.side ??
      (signal?.action === "LONG" || signal?.action === "SHORT"
        ? signal.action
        : market.trend === "uptrend"
          ? ("LONG" as const)
          : market.trend === "downtrend"
            ? ("SHORT" as const)
            : null);
    const entry = openPos?.entryPrice ?? signal?.entryPrice ?? market.price;
    const stop =
      openPos?.stopLoss ??
      signal?.stopLoss ??
      (side === "SHORT"
        ? round(Math.max(swingHigh, market.price * 1.0025), 3)
        : side === "LONG"
          ? round(Math.min(swingLow, market.price * 0.9975), 3)
          : null);
    const target =
      openPos?.takeProfit ??
      signal?.takeProfit ??
      (side === "SHORT"
        ? round(Math.min(swingLow, market.price * 0.9965), 3)
        : side === "LONG"
          ? round(Math.max(swingHigh, market.price * 1.0035), 3)
          : null);
    const pathLabel =
      side === "LONG"
        ? "Narx yuqoriga (TP) ketishi kutiladi; pastda SL himoya."
        : side === "SHORT"
          ? "Narx pastga (TP) ketishi kutiladi; tepada SL himoya."
          : "Oraliq: aniq yo‘nalish kutilyapti.";
    const structuralAnalysis =
      symbol === "XAUUSD"
        ? `Oltin M5: ~4043 dan ~4013 gacha kuchli pasayish, hozir ~${round(market.price, 3)}. Qaytish zonasi ${round(swingLow, 3)}–${round(swingHigh, 3)}. EMA20=${round(ema20, 3)} / EMA50=${round(ema50, 3)}. ${side === "SHORT" ? "Sotuv (SHORT) tahlili: pastga davom — TP past, SL qaytish yuqorisida." : "Kuzatuv."}`
        : `Bitcoin: trend=${market.trend}, narx ~${round(market.price, 2)}. Qaytish ${round(swingLow, 2)}–${round(swingHigh, 2)}. ${side === "SHORT" ? "Pasayishda SHORT: TP past, SL yuqorida." : side === "LONG" ? "O‘sishda LONG." : "Kuzatuv."}`;
    return {
      symbol,
      label: symbol === "XAUUSD" ? "Oltin / USD · M5 ish maydoni" : "Bitcoin / USDT · M5 ish maydoni",
      timeframe: "M5 tahlil · live",
      trend: market.trend,
      price: market.price,
      ema20: round(ema20, symbol === "BTCUSDT" ? 2 : 3),
      ema50: round(ema50, symbol === "BTCUSDT" ? 2 : 3),
      swingHigh: round(swingHigh, symbol === "BTCUSDT" ? 2 : 3),
      swingLow: round(swingLow, symbol === "BTCUSDT" ? 2 : 3),
      side,
      entry,
      stopLoss: stop,
      takeProfit: target,
      pathLabel,
      analysis: signal?.analysis || structuralAnalysis,
      forecast:
        signal?.forecast ||
        (side === "SHORT"
          ? `Prognoz: pastga harakat · maqsad ${target} · himoya ${stop}.`
          : side === "LONG"
            ? `Prognoz: yuqoriga harakat · maqsad ${target} · himoya ${stop}.`
            : "Aniq prognoz shakllanmagan."),
      recommendation:
        signal?.recommendation ||
        (openPos
          ? `Ochiq ${side}: agent SL/TP/trail bilan o‘zi yopadi.`
          : side
            ? `Eng yaxshi setup: ${side}. Imkoniyat bo‘lsa agent kiradi.`
            : "Kutish."),
      candles: candles.map((c, i) => ({
        i,
        t: c.timestamp,
        o: c.open,
        h: c.high,
        l: c.low,
        c: c.close,
        v: c.volume,
        up: c.close >= c.open,
      })),
    };
  });

  const mt5Account = mt5.account;
  const linkedAccount = mt5Account
    ? {
        currency: mt5Account.currency || "USD",
        balance: round(mt5Account.balance),
        equity: round(mt5Account.equity),
        availableBalance: round(mt5Account.marginFree),
        dayPnl: round(mt5Account.dayPnl),
        weekPnl: round(mt5Account.weekPnl),
        monthPnl: round(mt5Account.monthPnl),
        currentDrawdownPct: round(
          Math.max(
            0,
            ((Math.max(mt5Account.balance, mt5Account.equity) - mt5Account.equity) /
              Math.max(mt5Account.balance, 1)) *
              100,
          ),
          2,
        ),
      }
    : {
        currency: account.currency,
        balance: account.balance,
        equity: account.equity,
        availableBalance: account.availableBalance,
        dayPnl: account.dayPnl,
        weekPnl: account.weekPnl,
        monthPnl: account.monthPnl,
        currentDrawdownPct: account.currentDrawdownPct,
      };

  const openRiskPct = mt5Account
    ? round(
        (mt5Account.margin / Math.max(mt5Account.equity, 1)) * 100,
        3,
      )
    : risk.openRiskPct;

  const broker = mt5Account
    ? {
        connected: true as const,
        login: mt5Account.login,
        name: mt5Account.name,
        server: mt5Account.server,
        company: mt5Account.company,
        leverage: mt5Account.leverage,
        currency: mt5Account.currency,
        balance: mt5Account.balance,
        equity: mt5Account.equity,
        marginFree: mt5Account.marginFree,
        floatingProfit: mt5Account.profit,
        tradeAllowed: mt5Account.tradeAllowed,
        isDemo: mt5Account.isDemo,
        isReal: mt5Account.isReal,
        tradeMode: mt5Account.tradeMode,
        label: mt5Account.isReal ? "REAL" : mt5Account.isDemo ? "DEMO" : "CONTEST",
        title: mt5Account.isReal ? "Jonli hisob" : "Demo hisob",
        detail: mt5Account.isReal
          ? `Exness #${mt5Account.login} · buyurtmalar broker orqali (MT5).`
          : `Exness demo #${mt5Account.login} · depozit va balans jonli MT5 dan.`,
      }
    : {
        connected: false as const,
        login: exness.login ? Number(exness.login) : null,
        name: null,
        server: exness.server || null,
        company: "Exness",
        leverage: null,
        currency: "USD",
        balance: null,
        equity: null,
        marginFree: null,
        floatingProfit: null,
        tradeAllowed: false,
        isDemo: true,
        isReal: false,
        tradeMode: 0,
        label: "PAPER",
        title: "Sinov rejimi",
        detail: "Brokerga buyurtma yuborilmaydi. MT5 ulanishi kutilmoqda.",
      };

  return {
    mode: "paper" as const,
    engineState: settings.engineState as EngineState,
    liveExecutionEnabled: Boolean(mt5Account?.isReal && mt5Account.tradeAllowed),
    lastUpdatedAt: now,
    account: linkedAccount,
    broker,
    risk: {
      ...risk,
      openRiskPct,
    },
    dataQuality: {
      status: (liveBoth ? "degraded" : anyLive ? "degraded" : "simulated") as
        | "degraded"
        | "simulated",
      provider: liveBoth
        ? "BTC spot + XAUS gold live"
        : anyLive
          ? "Qisman live API"
          : "Synthetic fallback",
      quoteAgeSeconds: Math.min(
        feed.btcAge ?? 999,
        feed.xauAge ?? 999,
      ),
      stale: !anyLive,
      spreadHealthy: assets.every((asset) => true),
      timestampHealthy: anyLive,
      detail: mt5Account
        ? `Exness MT5 ulangan · #${mt5Account.login} · equity ${round(mt5Account.equity).toLocaleString("en-US")} ${mt5Account.currency}.`
        : liveBoth
          ? "Real API narxlari yangilanmoqda. Exness MT5 hisobi hali ulanmagan."
          : "Live API to‘liq emas yoki fallback. Plus-only rejim sintetikda kirmaydi.",
    },
    connections: unavailable,
    assets,
    charts,
    signals: mappedSignals,
    positions: mappedPositions,
    calendarEvents: getEconomicCalendar(8).map((event) => ({
      id: event.id,
      title: event.title,
      currency: event.currency,
      impact: event.impact,
      scheduledAt: event.scheduledAt,
      source: event.source,
      verified: event.verified,
    })),
    recentAudit: audit.map(mapAudit),
    liveFeed: {
      profitMode: "plus_only_no_minus",
      baseRiskUsd: 0.1,
      agentStatus:
        settings.engineState === "running" ? "Kuzatmoqda" : stateLabel(settings.engineState),
      currentAction: engineAction,
      watching: settings.enabledSymbols as SymbolCode[],
      openCount: openPositions.length,
      lastSymbol: latestSignal?.symbol ?? null,
      lastVerdict: latestSignal?.agentVerdict ?? null,
      lastScore: latestSignal?.score ?? null,
      tradePlans: await (async () => {
        let mt5Rows: Awaited<ReturnType<typeof listMt5Positions>> = [];
        try {
          mt5Rows = await listMt5Positions();
        } catch {
          mt5Rows = [];
        }
        if (mt5Rows.length) {
          return mt5Rows.map((row) => {
            const maxMinus = round(Math.abs(row.priceOpen - row.sl) * row.volume);
            const planPlus = round(Math.abs(row.tp - row.priceOpen) * row.volume);
            return {
              ticket: row.ticket,
              symbol: row.symbol,
              side: row.type as "LONG" | "SHORT",
              volume: row.volume,
              openedAt: row.priceOpen,
              currentPnl: round(row.profit),
              stopLoss: row.sl,
              takeProfit: row.tp,
              maxMinusUsd: maxMinus,
              planPlusUsd: planPlus,
              closePlan: `${row.type === "LONG" ? "BUY" : "SELL"} @ ${round(row.priceOpen)} → TP ${round(row.tp)} (≈+$${planPlus}) / SL ${round(row.sl)} (maks -$${maxMinus})`,
              slipPolicy: "Silif qoldirilmaydi: minus 70% risk yoki SL 85% yaqinlashsa agent yopadi.",
            };
          });
        }
        return openPositions.map((row) => {
          const maxMinus = round(
            Math.abs(row.entryPrice - row.stopLoss) * row.quantity,
          );
          const planPlus = round(
            Math.abs(row.takeProfit - row.entryPrice) * row.quantity,
          );
          return {
            ticket: row.id,
            symbol: row.symbol,
            side: row.side,
            volume: row.quantity,
            openedAt: row.entryPrice,
            currentPnl: round(row.unrealizedPnl),
            stopLoss: row.stopLoss,
            takeProfit: row.takeProfit,
            maxMinusUsd: maxMinus,
            planPlusUsd: planPlus,
            closePlan: `${row.side === "LONG" ? "BUY" : "SELL"} @ ${round(row.entryPrice)} → TP ${round(row.takeProfit)} (≈+$${planPlus}) / SL ${round(row.stopLoss)} (maks -$${maxMinus})`,
            slipPolicy: "Silif qoldirilmaydi: minus 70% risk yoki SL 85% yaqinlashsa agent yopadi.",
          };
        });
      })(),
      events: [
        ...getNarrations(8).map((item) => ({
          id: item.id,
          at: item.at,
          kind: item.kind,
          message: item.message,
          tone: item.tone,
        })),
        ...audit.slice(0, 8).map((row) => ({
          id: row.id + 100000,
          at: row.createdAt,
          kind: row.eventType,
          message: row.message,
          tone:
            row.severity === "critical" ||
            row.eventType.includes("stop_loss") ||
            row.eventType.includes("slip")
              ? ("bad" as const)
              : row.eventType.includes("take_profit") ||
                  row.eventType.includes("opened") ||
                  row.eventType.includes("breakeven")
                ? ("good" as const)
                : ("neutral" as const),
        })),
      ].slice(0, 12),
    },
  };
}

export async function warmExternalFeeds() {
  await Promise.allSettled([
    refreshLiveMarket(),
    refreshEconomicCalendar().then(() =>
      narrate("Iqtisodiy taqvim yangilandi.", { kind: "calendar_ready", tone: "good" }),
    ),
  ]);
}

function stateLabel(state: string) {
  return (
    (
      {
        running: "Ishlamoqda",
        paused: "Pauzada",
        stopped: "To‘xtatilgan",
        emergency_stop: "Favqulodda",
      } as Record<string, string>
    )[state] ?? state
  );
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
    "autoEnterMinScore",
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
  const signal = await evaluateSignal(symbol, { forceAi: true });
  if (signal.agentVerdict === "auto_enter" && signal.allowed && !signal.entered) {
    try {
      const opened = await openPaperPosition(signal, "auto");
      if (opened) {
        narrate(
          `Agent kirdi: ${shortSymbolLabel(symbol)} · ${signal.action} · risk ~$${Number(process.env.BASE_RISK_USD ?? 0.1)}`,
          { kind: "agent_enter", tone: "good" },
        );
        return { ...signal, entered: true };
      }
    } catch (error) {
      narrate(
        `Agent kira olmadi (${symbol}): ${error instanceof Error ? error.message : "xato"}`,
        { kind: "agent_enter_blocked", tone: "bad" },
      );
    }
  }
  return signal;
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
  await finalizeClose(position, price, "manual");
  const [closed] = await db
    .select()
    .from(tradingPositionsTable)
    .where(eq(tradingPositionsTable.id, positionId))
    .limit(1);
  return closed ? mapPosition(closed) : null;
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
