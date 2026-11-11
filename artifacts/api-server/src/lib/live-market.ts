import {
  calculateEma,
  generateCandles,
  getSyntheticSnapshot,
  type Candle,
  type SymbolCode,
} from "./market-simulator";

type LiveSnapshot = {
  symbol: SymbolCode;
  label: string;
  price: number;
  bid: number;
  ask: number;
  change24hPct: number;
  volume24h: number;
  timeframe: string;
  trend: "uptrend" | "downtrend" | "range";
  source: string;
  isSynthetic: boolean;
  candles: Candle[];
  spreadHealthy: boolean;
  quoteAgeSeconds: number;
};

type CacheEntry = {
  fetchedAt: number;
  snapshot: LiveSnapshot;
};

const cache = new Map<SymbolCode, CacheEntry>();
const LABELS: Record<SymbolCode, string> = {
  XAUUSD: "Gold / US Dollar",
  BTCUSDT: "Bitcoin / Tether",
};

function spreadPct(symbol: SymbolCode) {
  return symbol === "BTCUSDT" ? 0.00035 : 0.00018;
}

function buildTrend(candles: Candle[]) {
  const closes = candles.map((candle) => candle.close);
  const ema20 = calculateEma(closes.slice(-40), 20);
  const ema50 = calculateEma(closes.slice(-90), 50);
  if (ema20 > ema50 * 1.0005) return "uptrend" as const;
  if (ema20 < ema50 * 0.9995) return "downtrend" as const;
  return "range" as const;
}

function toSnapshot(
  symbol: SymbolCode,
  candles: Candle[],
  source: string,
  isSynthetic: boolean,
  fetchedAt: number,
): LiveSnapshot {
  const latest = candles.at(-1)!;
  const previous = candles.at(-Math.min(25, candles.length - 1))!;
  const pct = spreadPct(symbol);
  const bid = latest.close * (1 - pct / 2);
  const ask = latest.close * (1 + pct / 2);
  const dayVolume = candles
    .slice(-24)
    .reduce((sum, candle) => sum + candle.volume, 0);
  return {
    symbol,
    label: LABELS[symbol],
    price: latest.close,
    bid,
    ask,
    change24hPct: ((latest.close - previous.close) / previous.close) * 100,
    volume24h: dayVolume,
    timeframe: isSynthetic ? "M1 synthetic" : "M1 live API",
    trend: buildTrend(candles),
    source,
    isSynthetic,
    candles,
    spreadHealthy: ask - bid < latest.close * 0.002,
    quoteAgeSeconds: Math.max(0, Math.round((Date.now() - fetchedAt) / 1000)),
  };
}

async function fetchBtcSpot(): Promise<number> {
  try {
    const response = await fetch(
      "https://api.coinbase.com/v2/prices/BTC-USD/spot",
      { signal: AbortSignal.timeout(8_000) },
    );
    if (response.ok) {
      const payload = (await response.json()) as {
        data?: { amount?: string };
      };
      const price = Number(payload.data?.amount ?? 0);
      if (price > 0) return price;
    }
  } catch {
    // fall through
  }

  const response = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
    { signal: AbortSignal.timeout(8_000) },
  );
  if (!response.ok) throw new Error(`BTC spot HTTP ${response.status}`);
  const payload = (await response.json()) as {
    bitcoin?: { usd?: number };
  };
  const price = Number(payload.bitcoin?.usd ?? 0);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("BTC spot price invalid");
  }
  return price;
}

function stitchSpotCandles(symbol: SymbolCode, spot: number): Candle[] {
  const base = generateCandles(symbol, 180);
  const last = base.at(-1)!;
  const scale = spot / last.close;
  const scaled = base.map((candle) => ({
    timestamp: candle.timestamp,
    open: candle.open * scale,
    high: candle.high * scale,
    low: candle.low * scale,
    close: candle.close * scale,
    volume: candle.volume,
  }));
  const tip = scaled.at(-1)!;
  const micro = spot * 0.00005;
  scaled[scaled.length - 1] = {
    ...tip,
    close: spot,
    high: Math.max(tip.high, spot + micro),
    low: Math.min(tip.low, spot - micro),
  };
  return scaled;
}

async function fetchGoldSpot(): Promise<number> {
  const response = await fetch("https://xaus.com/api/v1/spot", {
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`XAUS HTTP ${response.status}`);
  const payload = (await response.json()) as {
    spot_usd_oz?: number;
    xau?: { price?: number };
  };
  const price = Number(payload.spot_usd_oz ?? payload.xau?.price ?? 0);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("Gold spot price invalid");
  }
  return price;
}

export async function refreshLiveMarket(symbol?: SymbolCode) {
  const symbols: SymbolCode[] = symbol
    ? [symbol]
    : (["XAUUSD", "BTCUSDT"] as SymbolCode[]);

  await Promise.all(
    symbols.map(async (code) => {
      try {
        if (code === "BTCUSDT") {
          const spot = await fetchBtcSpot();
          const candles = stitchSpotCandles(code, spot);
          const fetchedAt = Date.now();
          cache.set(code, {
            fetchedAt,
            snapshot: toSnapshot(
              code,
              candles,
              "Coinbase/CoinGecko BTC spot",
              false,
              fetchedAt,
            ),
          });
          return;
        }

        const spot = await fetchGoldSpot();
        const candles = stitchSpotCandles(code, spot);
        const fetchedAt = Date.now();
        cache.set(code, {
          fetchedAt,
          snapshot: toSnapshot(
            code,
            candles,
            "XAUS gold spot API",
            false,
            fetchedAt,
          ),
        });
      } catch {
        // keep previous cache; synthetic fallback happens in getter
      }
    }),
  );
}

export function getLiveOrSyntheticSnapshot(symbol: SymbolCode) {
  const cached = cache.get(symbol);
  const maxAgeMs = Number(process.env.MARKET_CACHE_MAX_MS ?? 90_000);
  if (cached && Date.now() - cached.fetchedAt <= maxAgeMs) {
    return {
      ...cached.snapshot,
      quoteAgeSeconds: Math.max(
        0,
        Math.round((Date.now() - cached.fetchedAt) / 1000),
      ),
    };
  }

  const synthetic = getSyntheticSnapshot(symbol);
  return {
    ...synthetic,
    source: "Synthetic fallback (live API vaqtincha yo‘q)",
    quoteAgeSeconds: 0,
  };
}

export function getMarketFeedStatus() {
  const now = Date.now();
  const btc = cache.get("BTCUSDT");
  const xau = cache.get("XAUUSD");
  const fresh = (entry?: CacheEntry) =>
    Boolean(entry && now - entry.fetchedAt <= 90_000 && !entry.snapshot.isSynthetic);
  return {
    btcLive: fresh(btc),
    xauLive: fresh(xau),
    btcAge: btc ? Math.round((now - btc.fetchedAt) / 1000) : null,
    xauAge: xau ? Math.round((now - xau.fetchedAt) / 1000) : null,
  };
}
