import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export interface StoredMarketCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export const tradingSettingsTable = pgTable("trading_settings", {
  id: integer("id").primaryKey().default(1),
  mode: text("mode").notNull().default("paper"),
  engineState: text("engine_state").notNull().default("stopped"),
  initialBalance: doublePrecision("initial_balance").notNull().default(10000),
  riskPerTradePct: doublePrecision("risk_per_trade_pct").notNull().default(0.25),
  maxDailyLossPct: doublePrecision("max_daily_loss_pct").notNull().default(1),
  maxWeeklyLossPct: doublePrecision("max_weekly_loss_pct").notNull().default(3),
  maxDrawdownPct: doublePrecision("max_drawdown_pct").notNull().default(5),
  minRiskReward: doublePrecision("min_risk_reward").notNull().default(2),
  minimumSignalScore: integer("minimum_signal_score").notNull().default(80),
  newsBufferBeforeMinutes: integer("news_buffer_before_minutes")
    .notNull()
    .default(30),
  newsBufferAfterMinutes: integer("news_buffer_after_minutes")
    .notNull()
    .default(15),
  enabledSymbols: text("enabled_symbols")
    .array()
    .notNull()
    .default(["XAUUSD", "BTCUSDT"]),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const tradingSignalsTable = pgTable("trading_signals", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  strategy: text("strategy").notNull(),
  action: text("action").notNull(),
  score: integer("score").notNull(),
  marketRegime: text("market_regime").notNull(),
  entryPrice: doublePrecision("entry_price"),
  stopLoss: doublePrecision("stop_loss"),
  takeProfit: doublePrecision("take_profit"),
  riskReward: doublePrecision("risk_reward"),
  allowed: boolean("allowed").notNull(),
  reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
  counterEvidence: jsonb("counter_evidence")
    .$type<string[]>()
    .notNull()
    .default([]),
  dataSource: text("data_source").notNull().default("synthetic"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const tradingPositionsTable = pgTable("trading_positions", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  side: text("side").notNull(),
  quantity: doublePrecision("quantity").notNull(),
  entryPrice: doublePrecision("entry_price").notNull(),
  currentPrice: doublePrecision("current_price").notNull(),
  stopLoss: doublePrecision("stop_loss").notNull(),
  takeProfit: doublePrecision("take_profit").notNull(),
  riskAmount: doublePrecision("risk_amount").notNull(),
  unrealizedPnl: doublePrecision("unrealized_pnl").notNull().default(0),
  realizedPnl: doublePrecision("realized_pnl").notNull().default(0),
  status: text("status").notNull().default("open"),
  openedAt: timestamp("opened_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

export const tradingAuditTable = pgTable("trading_audit", {
  id: serial("id").primaryKey(),
  eventType: text("event_type").notNull(),
  severity: text("severity").notNull().default("info"),
  symbol: text("symbol"),
  message: text("message").notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const tradingBacktestsTable = pgTable("trading_backtests", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  strategy: text("strategy").notNull(),
  datasetLabel: text("dataset_label").notNull(),
  result: jsonb("result").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const mt5MarketDataTable = pgTable("mt5_market_data", {
  symbol: text("symbol").primaryKey(),
  brokerSymbol: text("broker_symbol").notNull(),
  timeframe: text("timeframe").notNull(),
  bid: doublePrecision("bid").notNull(),
  ask: doublePrecision("ask").notNull(),
  lastPrice: doublePrecision("last_price").notNull(),
  volume: doublePrecision("volume").notNull(),
  marketTimestamp: timestamp("market_timestamp", { withTimezone: true }).notNull(),
  candles: jsonb("candles").$type<StoredMarketCandle[]>().notNull(),
  source: text("source").notNull().default("Exness MT5"),
  receivedAt: timestamp("received_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
