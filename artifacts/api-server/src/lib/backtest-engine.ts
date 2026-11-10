import {
  calculateAtr,
  calculateEma,
  generateCandles,
  type Candle,
  type SymbolCode,
} from "./market-simulator";

interface BacktestInput {
  symbol: SymbolCode;
  strategy: "gold-breakout-retest" | "btc-trend-momentum";
  initialBalance: number;
  riskPerTradePct: number;
  feeBps: number;
  slippageBps: number;
}

interface CompletedTrade {
  pnl: number;
  fees: number;
  slippage: number;
}

function findEntry(
  candles: Candle[],
  index: number,
  symbol: SymbolCode,
  strategy: BacktestInput["strategy"],
): "LONG" | "SHORT" | null {
  const history = candles.slice(Math.max(0, index - 80), index);
  const closes = history.map((candle) => candle.close);
  if (closes.length < 50) return null;

  const fast = calculateEma(closes.slice(-40), 20);
  const slow = calculateEma(closes.slice(-80), 50);
  const previous = history.at(-1)!;
  const volumeAverage =
    history.slice(-20).reduce((sum, candle) => sum + candle.volume, 0) / 20;

  if (symbol === "XAUUSD" && strategy === "gold-breakout-retest") {
    const range = history.slice(-21, -1);
    const high = Math.max(...range.map((candle) => candle.high));
    const low = Math.min(...range.map((candle) => candle.low));
    if (fast > slow && previous.close > high && previous.low <= high * 1.001) {
      return "LONG";
    }
    if (fast < slow && previous.close < low && previous.high >= low * 0.999) {
      return "SHORT";
    }
    return null;
  }

  const momentum = previous.close / history.at(-4)!.close - 1;
  const volumeConfirmed = previous.volume >= volumeAverage * 1.05;
  if (fast > slow && momentum > 0.001 && volumeConfirmed) return "LONG";
  if (fast < slow && momentum < -0.001 && volumeConfirmed) return "SHORT";
  return null;
}

export function runSyntheticBacktest(input: BacktestInput) {
  const candles = generateCandles(input.symbol, 720, 720);
  const trades: CompletedTrade[] = [];
  const equityCurve: Array<{ timestamp: Date; equity: number }> = [];
  let equity = input.initialBalance;
  let peakEquity = equity;
  let maxDrawdownPct = 0;
  let index = 80;

  while (index < candles.length - 2) {
    const side = findEntry(candles, index, input.symbol, input.strategy);
    if (!side) {
      if (index % 8 === 0) {
        equityCurve.push({
          timestamp: new Date(candles[index]!.timestamp),
          equity: Number(equity.toFixed(2)),
        });
      }
      index += 1;
      continue;
    }

    const entryBar = candles[index]!;
    const entryPrice = entryBar.open;
    const atr = calculateAtr(candles.slice(index - 30, index), 14);
    const stopDistance = Math.max(
      atr * 1.4,
      entryPrice * (input.symbol === "BTCUSDT" ? 0.003 : 0.0008),
    );
    const stopLoss = side === "LONG" ? entryPrice - stopDistance : entryPrice + stopDistance;
    const takeProfit =
      side === "LONG" ? entryPrice + stopDistance * 2 : entryPrice - stopDistance * 2;
    const quantity = (equity * (input.riskPerTradePct / 100)) / stopDistance;
    let exitPrice = candles[Math.min(index + 20, candles.length - 1)]!.close;
    let exitIndex = Math.min(index + 20, candles.length - 1);

    for (
      let forward = index;
      forward <= Math.min(index + 20, candles.length - 1);
      forward += 1
    ) {
      const candle = candles[forward]!;
      const stopHit =
        side === "LONG" ? candle.low <= stopLoss : candle.high >= stopLoss;
      const targetHit =
        side === "LONG" ? candle.high >= takeProfit : candle.low <= takeProfit;
      if (stopHit) {
        exitPrice = stopLoss;
        exitIndex = forward;
        break;
      }
      if (targetHit) {
        exitPrice = takeProfit;
        exitIndex = forward;
        break;
      }
    }

    const grossPnl =
      (side === "LONG" ? exitPrice - entryPrice : entryPrice - exitPrice) * quantity;
    const notional = (Math.abs(entryPrice) + Math.abs(exitPrice)) * quantity;
    const fees = (notional * input.feeBps) / 10_000;
    const slippage = (notional * input.slippageBps) / 10_000;
    const pnl = grossPnl - fees - slippage;
    trades.push({ pnl, fees, slippage });
    equity += pnl;
    peakEquity = Math.max(peakEquity, equity);
    maxDrawdownPct = Math.max(
      maxDrawdownPct,
      ((peakEquity - equity) / Math.max(peakEquity, 1)) * 100,
    );
    equityCurve.push({
      timestamp: new Date(candles[exitIndex]!.timestamp),
      equity: Number(equity.toFixed(2)),
    });
    index = exitIndex + 1;
  }

  const winners = trades.filter((trade) => trade.pnl > 0);
  const losers = trades.filter((trade) => trade.pnl < 0);
  const grossProfit = winners.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = Math.abs(losers.reduce((sum, trade) => sum + trade.pnl, 0));
  const totalFees = trades.reduce((sum, trade) => sum + trade.fees, 0);
  const totalSlippage = trades.reduce((sum, trade) => sum + trade.slippage, 0);
  const netProfit = trades.reduce((sum, trade) => sum + trade.pnl, 0);

  return {
    symbol: input.symbol,
    strategy: input.strategy,
    datasetLabel: "Synthetic sample — not historical market data",
    initialBalance: input.initialBalance,
    netProfit: Number(netProfit.toFixed(2)),
    netProfitPct: Number(((netProfit / input.initialBalance) * 100).toFixed(2)),
    profitFactor:
      grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : 0,
    maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
    winRatePct:
      trades.length > 0
        ? Number(((winners.length / trades.length) * 100).toFixed(2))
        : 0,
    tradeCount: trades.length,
    expectancy:
      trades.length > 0 ? Number((netProfit / trades.length).toFixed(2)) : 0,
    fees: Number(totalFees.toFixed(2)),
    slippage: Number(totalSlippage.toFixed(2)),
    equityCurve,
    disclaimer:
      "These results use a generated synthetic sample. They are not historical performance, do not predict future returns, and cannot be used to approve live trading.",
  };
}
