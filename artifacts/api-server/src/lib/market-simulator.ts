export type SymbolCode = "XAUUSD" | "BTCUSDT";

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const MARKETS: Record<
  SymbolCode,
  { base: number; label: string; amplitude: number; volumeBase: number }
> = {
  XAUUSD: {
    base: 2325,
    label: "Gold / US Dollar",
    amplitude: 0.014,
    volumeBase: 1250,
  },
  BTCUSDT: {
    base: 92000,
    label: "Bitcoin / Tether",
    amplitude: 0.075,
    volumeBase: 220,
  },
};

function closeAt(symbol: SymbolCode, index: number): number {
  const market = MARKETS[symbol];
  const a = market.amplitude;
  const wave =
    a * Math.sin(index / 260) +
    a * 0.32 * Math.sin(index / 61) +
    a * 0.075 * Math.sin(index / 11);
  return market.base * Math.exp(wave);
}

export function generateCandles(
  symbol: SymbolCode,
  count = 180,
  endIndex = Math.floor(Date.now() / 60_000),
): Candle[] {
  const market = MARKETS[symbol];
  const startIndex = endIndex - count + 1;
  const candles: Candle[] = [];

  for (let offset = 0; offset < count; offset += 1) {
    const index = startIndex + offset;
    const close = closeAt(symbol, index);
    const open = offset === 0 ? closeAt(symbol, index - 1) : candles[offset - 1]!.close;
    const rangeFactor =
      symbol === "BTCUSDT" ? 0.0025 : 0.00075;
    const wick =
      rangeFactor *
      (0.35 + 0.65 * Math.abs(Math.sin(index * 1.73)));
    const high = Math.max(open, close) * (1 + wick);
    const low = Math.min(open, close) * (1 - wick);
    const volume =
      market.volumeBase *
      (0.55 + Math.abs(Math.sin(index * 0.71)) * 0.9) *
      (1 + Math.abs(Math.sin(index * 0.11)) * 0.15);

    candles.push({
      timestamp: index * 60_000,
      open,
      high,
      low,
      close,
      volume,
    });
  }

  return candles;
}

export function calculateEma(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const multiplier = 2 / (period + 1);
  let value = values[0]!;
  for (let index = 1; index < values.length; index += 1) {
    value = values[index]! * multiplier + value * (1 - multiplier);
  }
  return value;
}

export function calculateAtr(candles: Candle[], period = 14): number {
  if (candles.length < 2) return 0;
  const start = Math.max(1, candles.length - period);
  const trueRanges: number[] = [];

  for (let index = start; index < candles.length; index += 1) {
    const candle = candles[index]!;
    const previousClose = candles[index - 1]!.close;
    trueRanges.push(
      Math.max(
        candle.high - candle.low,
        Math.abs(candle.high - previousClose),
        Math.abs(candle.low - previousClose),
      ),
    );
  }

  return trueRanges.reduce((sum, value) => sum + value, 0) / trueRanges.length;
}

export function getMarketSnapshot(symbol: SymbolCode) {
  const candles = generateCandles(symbol, 180);
  const market = MARKETS[symbol];
  const latest = candles.at(-1)!;
  const previousDay = candles.at(-25)!;
  const spreadPct = symbol === "BTCUSDT" ? 0.00035 : 0.0002;
  const bid = latest.close * (1 - spreadPct / 2);
  const ask = latest.close * (1 + spreadPct / 2);
  const closes = candles.map((candle) => candle.close);
  const ema20 = calculateEma(closes.slice(-40), 20);
  const ema50 = calculateEma(closes.slice(-90), 50);
  const trend =
    ema20 > ema50 * 1.0005
      ? "uptrend"
      : ema20 < ema50 * 0.9995
        ? "downtrend"
        : "range";
  const dayVolume = candles
    .slice(-24)
    .reduce((sum, candle) => sum + candle.volume, 0);

  return {
    symbol,
    label: market.label,
    price: latest.close,
    bid,
    ask,
    change24hPct: ((latest.close - previousDay.close) / previousDay.close) * 100,
    volume24h: dayVolume,
    timeframe: "M1 synthetic stream",
    trend: trend as "uptrend" | "downtrend" | "range",
    source: "Synthetic demo feed",
    isSynthetic: true,
    candles,
    spreadHealthy: ask - bid < latest.close * 0.002,
  };
}
