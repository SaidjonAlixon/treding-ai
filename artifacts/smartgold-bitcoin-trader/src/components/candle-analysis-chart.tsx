import { useMemo } from "react";

export type ChartCandle = {
  i: number;
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  up: boolean;
};

export type AnalysisChart = {
  symbol: string;
  label: string;
  timeframe: string;
  trend: string;
  price: number;
  ema20: number;
  ema50: number;
  swingHigh: number;
  swingLow: number;
  side: "LONG" | "SHORT" | null;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  pathLabel: string;
  analysis: string;
  forecast: string;
  recommendation: string;
  candles: ChartCandle[];
};

function money(value?: number | null, digits = 2) {
  if (value === undefined || value === null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("uz-UZ", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function trendUz(trend: string) {
  if (trend === "uptrend") return "O‘sish";
  if (trend === "downtrend") return "Pasayish";
  if (trend === "range") return "Oraliq / qaytish zonasi";
  return trend;
}

export function CandleAnalysisChart({ chart }: { chart: AnalysisChart }) {
  const digits = chart.symbol.includes("BTC") ? 2 : 3;
  const view = useMemo(() => {
    const candles = chart.candles.slice(-60);
    if (!candles.length) return null;
    const pad = 12;
    const width = 720;
    const height = 280;
    const left = 54;
    const right = 12;
    const top = 16;
    const bottom = 28;
    const plotW = width - left - right;
    const plotH = height - top - bottom;
    const prices = candles.flatMap((c) => [c.h, c.l]);
    if (chart.entry != null) prices.push(chart.entry);
    if (chart.stopLoss != null) prices.push(chart.stopLoss);
    if (chart.takeProfit != null) prices.push(chart.takeProfit);
    prices.push(chart.swingHigh, chart.swingLow, chart.ema20, chart.ema50);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const span = Math.max(max - min, 1e-6);
    const y = (price: number) => top + ((max - price) / span) * plotH;
    const x = (i: number) => left + (i + 0.5) * (plotW / candles.length);
    const bodyW = Math.max(3, (plotW / candles.length) * 0.62);
    return { candles, width, height, left, top, plotW, plotH, y, x, bodyW, min, max, pad };
  }, [chart]);

  if (!view) {
    return (
      <div className="rounded-xl border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
        Shamcha ma’lumoti yo‘q
      </div>
    );
  }

  const { candles, width, height, left, y, x, bodyW } = view;
  const level = (
    price: number | null,
    color: string,
    label: string,
  ) => {
    if (price == null) return null;
    const yy = y(price);
    return (
      <g key={label}>
        <line
          x1={left}
          x2={width - 12}
          y1={yy}
          y2={yy}
          stroke={color}
          strokeWidth={1.4}
          strokeDasharray="5 4"
        />
        <rect x={width - 118} y={yy - 9} width={106} height={16} rx={4} fill={color} opacity={0.92} />
        <text x={width - 65} y={yy + 3} textAnchor="middle" fontSize={9} fill="#fff" fontWeight={700}>
          {label} {money(price, digits)}
        </text>
      </g>
    );
  };

  const pathArrow =
    chart.side === "LONG"
      ? { from: chart.entry ?? chart.price, to: chart.takeProfit ?? chart.swingHigh, color: "#059669" }
      : chart.side === "SHORT"
        ? { from: chart.entry ?? chart.price, to: chart.takeProfit ?? chart.swingLow, color: "#dc2626" }
        : null;

  return (
    <article className="panel overflow-hidden p-4 sm:p-5" data-testid={`chart-analysis-${chart.symbol}`}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="eyebrow">Shamcha · tahlil chizmasi</p>
          <h3 className="font-display text-lg font-semibold tracking-tight">
            {chart.label} · {chart.symbol}
          </h3>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {chart.timeframe} · Trend: {trendUz(chart.trend)} · EMA20 {money(chart.ema20, digits)} / EMA50{" "}
            {money(chart.ema50, digits)}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <span className="rounded-full bg-muted px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wide text-muted-foreground">
            Qaytish: {money(chart.swingHigh, digits)} / {money(chart.swingLow, digits)}
          </span>
          {chart.side && (
            <span
              className={`rounded-full px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wide ${
                chart.side === "LONG"
                  ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                  : "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"
              }`}
            >
              {chart.side === "LONG" ? "Xarid yo‘li" : "Sotuv yo‘li"}
            </span>
          )}
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border/70 bg-gradient-to-b from-muted/40 to-card">
        <svg viewBox={`0 0 ${width} ${height}`} className="h-[280px] w-full min-w-[560px]" role="img" aria-label={`${chart.symbol} shamcha`}>
          {/* grid */}
          {[0.25, 0.5, 0.75].map((p) => {
            const yy = 16 + p * (height - 44);
            return (
              <line
                key={p}
                x1={left}
                x2={width - 12}
                y1={yy}
                y2={yy}
                stroke="currentColor"
                className="text-border"
                strokeWidth={1}
                opacity={0.5}
              />
            );
          })}

          {/* swing zone */}
          <rect
            x={left}
            y={y(chart.swingHigh)}
            width={width - left - 12}
            height={Math.max(2, y(chart.swingLow) - y(chart.swingHigh))}
            fill="#f59e0b"
            opacity={0.08}
          />

          {/* candles */}
          {candles.map((candle, idx) => {
            const cx = x(idx);
            const color = candle.up ? "#059669" : "#dc2626";
            const yO = y(candle.o);
            const yC = y(candle.c);
            const bodyTop = Math.min(yO, yC);
            const bodyH = Math.max(2, Math.abs(yC - yO));
            return (
              <g key={candle.t}>
                <line x1={cx} x2={cx} y1={y(candle.h)} y2={y(candle.l)} stroke={color} strokeWidth={1.2} />
                <rect
                  x={cx - bodyW / 2}
                  y={bodyTop}
                  width={bodyW}
                  height={bodyH}
                  fill={color}
                  rx={1}
                />
              </g>
            );
          })}

          {/* path arrow: qayerga boradi */}
          {pathArrow && pathArrow.to != null && pathArrow.from != null && (
            <g>
              <defs>
                <marker id={`arrow-${chart.symbol}`} markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                  <path d="M0,0 L6,3 L0,6 Z" fill={pathArrow.color} />
                </marker>
              </defs>
              <line
                x1={x(Math.max(0, candles.length - 8))}
                y1={y(pathArrow.from)}
                x2={x(candles.length - 1)}
                y2={y(pathArrow.to)}
                stroke={pathArrow.color}
                strokeWidth={2.2}
                markerEnd={`url(#arrow-${chart.symbol})`}
                opacity={0.85}
              />
              <text
                x={x(candles.length - 3)}
                y={y(pathArrow.to) + (chart.side === "LONG" ? -8 : 14)}
                fontSize={10}
                fontWeight={700}
                fill={pathArrow.color}
              >
                Qayerga: TP
              </text>
            </g>
          )}

          {/* reverse hint */}
          <text x={left + 6} y={y(chart.swingHigh) - 6} fontSize={9} fill="#b45309" fontWeight={700}>
            Qaytish yuqori
          </text>
          <text x={left + 6} y={y(chart.swingLow) + 12} fontSize={9} fill="#b45309" fontWeight={700}>
            Qaytish past
          </text>

          {level(chart.entry, "#2563eb", "Kirish")}
          {level(chart.stopLoss, "#dc2626", "SL")}
          {level(chart.takeProfit, "#059669", "TP")}
        </svg>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg bg-muted/50 p-3">
          <p className="eyebrow mb-1">Qayerga boradi</p>
          <p className="text-[11px] leading-5 text-foreground/90">{chart.pathLabel}</p>
        </div>
        <div className="rounded-lg bg-muted/50 p-3">
          <p className="eyebrow mb-1">Prognoz</p>
          <p className="text-[11px] leading-5 text-foreground/90">{chart.forecast}</p>
        </div>
        <div className="rounded-lg bg-muted/50 p-3">
          <p className="eyebrow mb-1">Agent qarori</p>
          <p className="text-[11px] leading-5 font-semibold text-foreground">{chart.recommendation}</p>
        </div>
      </div>
      <p className="mt-3 text-[10px] leading-4 text-muted-foreground">
        Tahlil: {chart.analysis}
      </p>
      <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-emerald-600" />Yashil sham = o‘sish</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-red-600" />Qizil sham = pasayish</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 bg-blue-600" />Kirish</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 bg-red-600" />Stop (SL)</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 bg-emerald-600" />Maqsad (TP)</span>
      </div>
    </article>
  );
}
