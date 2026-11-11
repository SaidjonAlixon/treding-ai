import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type Mt5AccountSnapshot = {
  login: number;
  name: string;
  server: string;
  company: string;
  currency: string;
  balance: number;
  equity: number;
  margin: number;
  marginFree: number;
  profit: number;
  dayPnl: number;
  weekPnl: number;
  monthPnl: number;
  leverage: number;
  tradeAllowed: boolean;
  tradeExpert: boolean;
  tradeMode: number;
  isDemo: boolean;
  isReal: boolean;
};

export type Mt5BridgeStatus = {
  installed: boolean;
  terminalPath: string | null;
  connected: boolean;
  detail: string;
  account?: Mt5AccountSnapshot;
};

export type Mt5OrderRequest = {
  symbol: string;
  side: "LONG" | "SHORT";
  volume?: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
  comment?: string;
};

export type Mt5OrderResult = {
  ok: boolean;
  error?: string;
  retcode?: number;
  order?: number;
  deal?: number;
  volume?: number;
  price?: number;
  symbol?: string;
  side?: string;
  sl?: number;
  tp?: number;
  comment?: string;
};

const DEFAULT_PATH =
  "C:\\Program Files\\MetaTrader 5 EXNESS\\terminal64.exe";

function resolveTerminalPath() {
  const configured = process.env.EXNESS_MT5_PATH?.trim();
  if (configured && fs.existsSync(configured)) return configured;
  if (fs.existsSync(DEFAULT_PATH)) return DEFAULT_PATH;
  return null;
}

function resolveBridgeScript() {
  const candidates = [
    path.resolve(process.cwd(), "scripts/mt5_bridge.py"),
    path.resolve(process.cwd(), "../../scripts/mt5_bridge.py"),
    path.resolve(
      "C:\\Users\\Saidmuhammadalixon\\Desktop\\AI-Trading-Platform\\scripts\\mt5_bridge.py",
    ),
  ];
  return candidates.find((file) => fs.existsSync(file)) ?? candidates[0]!;
}

function runBridge(
  action: "status" | "symbols" | "positions" | "order" | "close",
  payload?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const file = resolveBridgeScript();
    const child = spawn("python", [file, action], {
      env: { ...process.env },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, error: "MT5 bridge timeout" });
    }, 25_000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    if (payload) {
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    } else {
      child.stdin.end();
    }
    child.on("close", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(stdout) as Record<string, unknown>);
      } catch {
        resolve({
          ok: false,
          error: stderr || stdout || "MT5 bridge parse error",
        });
      }
    });
  });
}

function mapAccount(raw: Record<string, unknown>): Mt5AccountSnapshot {
  const tradeMode = Number(raw.trade_mode ?? 0);
  const profit = Number(raw.profit ?? 0);
  return {
    login: Number(raw.login ?? 0),
    name: String(raw.name ?? ""),
    server: String(raw.server ?? ""),
    company: String(raw.company ?? "Exness"),
    currency: String(raw.currency ?? "USD"),
    balance: Number(raw.balance ?? 0),
    equity: Number(raw.equity ?? 0),
    margin: Number(raw.margin ?? 0),
    marginFree: Number(raw.margin_free ?? 0),
    profit,
    dayPnl: Number(raw.day_pnl ?? profit),
    weekPnl: Number(raw.week_pnl ?? profit),
    monthPnl: Number(raw.month_pnl ?? profit),
    leverage: Number(raw.leverage ?? 0),
    tradeAllowed: Boolean(raw.trade_allowed),
    tradeExpert: Boolean(raw.trade_expert),
    tradeMode,
    isDemo: tradeMode === 0,
    isReal: tradeMode === 2,
  };
}

let cached: { at: number; status: Mt5BridgeStatus } | null = null;

export async function getMt5BridgeStatus(force = false): Promise<Mt5BridgeStatus> {
  if (!force && cached && Date.now() - cached.at < 8_000) return cached.status;

  const terminalPath = resolveTerminalPath();
  if (!terminalPath) {
    const status: Mt5BridgeStatus = {
      installed: false,
      terminalPath: null,
      connected: false,
      detail: "Exness MT5 o‘rnatilmagan.",
    };
    cached = { at: Date.now(), status };
    return status;
  }

  const result = await runBridge("status");
  if (result.ok && result.account && typeof result.account === "object") {
    const account = mapAccount(result.account as Record<string, unknown>);
    const status: Mt5BridgeStatus = {
      installed: true,
      terminalPath,
      connected: true,
      detail: `${account.isDemo ? "Demo" : "Real"} · #${account.login} · ${account.name} · ${account.server}`,
      account,
    };
    cached = { at: Date.now(), status };
    return status;
  }

  const status: Mt5BridgeStatus = {
    installed: true,
    terminalPath,
    connected: false,
    detail: `MT5 topildi, lekin ulanmadi: ${String(result.error ?? "noma’lum")}`,
  };
  cached = { at: Date.now(), status };
  return status;
}

export async function placeMt5MarketOrder(
  request: Mt5OrderRequest,
): Promise<Mt5OrderResult> {
  const result = await runBridge("order", { ...request });
  const order =
    result.order && typeof result.order === "object"
      ? (result.order as Record<string, unknown>)
      : result;
  return {
    ok: Boolean(result.ok),
    error: result.error ? String(result.error) : order.error ? String(order.error) : undefined,
    retcode: order.retcode != null ? Number(order.retcode) : undefined,
    order: order.order != null ? Number(order.order) : undefined,
    deal: order.deal != null ? Number(order.deal) : undefined,
    volume: order.volume != null ? Number(order.volume) : undefined,
    price: order.price != null ? Number(order.price) : undefined,
    symbol: order.symbol != null ? String(order.symbol) : undefined,
    side: order.side != null ? String(order.side) : undefined,
    sl: order.sl != null ? Number(order.sl) : undefined,
    tp: order.tp != null ? Number(order.tp) : undefined,
    comment: order.comment != null ? String(order.comment) : undefined,
  };
}

export async function closeMt5Position(input: {
  ticket?: number;
  symbol?: string;
}): Promise<Mt5OrderResult> {
  const result = await runBridge("close", {
    ticket: input.ticket ?? 0,
    symbol: input.symbol ?? "",
    magic: 260311,
  });
  const close =
    result.close && typeof result.close === "object"
      ? (result.close as Record<string, unknown>)
      : result;
  return {
    ok: Boolean(result.ok),
    error: result.error ? String(result.error) : close.error ? String(close.error) : undefined,
    retcode: close.retcode != null ? Number(close.retcode) : undefined,
    order: close.order != null ? Number(close.order) : undefined,
    deal: close.deal != null ? Number(close.deal) : undefined,
    price: close.price != null ? Number(close.price) : undefined,
    symbol: close.symbol != null ? String(close.symbol) : undefined,
    comment: close.comment != null ? String(close.comment) : undefined,
  };
}

export async function listMt5Positions(): Promise<
  Array<{
    ticket: number;
    symbol: string;
    type: string;
    volume: number;
    priceOpen: number;
    sl: number;
    tp: number;
    profit: number;
  }>
> {
  const result = await runBridge("positions");
  const rows = Array.isArray(result.positions) ? result.positions : [];
  return rows.map((row) => {
    const item = row as Record<string, unknown>;
    return {
      ticket: Number(item.ticket ?? 0),
      symbol: String(item.symbol ?? ""),
      type: String(item.type ?? ""),
      volume: Number(item.volume ?? 0),
      priceOpen: Number(item.price_open ?? 0),
      sl: Number(item.sl ?? 0),
      tp: Number(item.tp ?? 0),
      profit: Number(item.profit ?? 0),
    };
  });
}

/** Map app symbols to Exness MT5 names and clamp to broker min lot. */
export function mt5VolumeForRisk(riskUsd: number, stopDistance: number): number {
  if (!Number.isFinite(riskUsd) || !Number.isFinite(stopDistance) || stopDistance <= 0) {
    return 0.01;
  }
  // Exness micro (m) lots: keep at least 0.01 so phone MT5 shows the trade.
  const raw = riskUsd / stopDistance;
  return Math.max(0.01, Math.min(1, Number(raw.toFixed(2))));
}
