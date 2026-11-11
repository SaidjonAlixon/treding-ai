type Side = "LONG" | "SHORT";

export type AiEnrichment = {
  forecast: string;
  analysis: string;
  recommendation: string;
  confidence: number;
  allowEntry: boolean;
  reasons: string[];
  provider: "openai" | "rules-only";
  model: string;
};

type AiNewsItem = {
  title: string;
  currency: string;
  impact: string;
  when: string;
  minutesUntil: number;
};

type AiInput = {
  symbol: "XAUUSD" | "BTCUSDT";
  candidate: Side | null;
  score: number;
  trend: string;
  regime: string;
  price: number;
  bid: number;
  ask: number;
  ema20: number;
  ema50: number;
  atr: number;
  momentumPct: number;
  volumeRatio: number;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  riskReasons: string[];
  counterEvidence: string[];
  /** Dunyo/iqtisodiy yangiliklar (ForexFactory va hokazo) */
  newsEvents?: AiNewsItem[];
  newsBiasHint?: string;
};

const lastCallAt = new Map<string, number>();

function hasOpenAiKey() {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

export function isAiConfigured() {
  return hasOpenAiKey();
}

export function getExnessConfig() {
  const login = process.env.EXNESS_MT5_LOGIN?.trim() ?? "";
  const server = process.env.EXNESS_MT5_SERVER?.trim() ?? "";
  const password = process.env.EXNESS_MT5_PASSWORD?.trim() ?? "";
  return {
    login,
    server,
    configured: Boolean(login && server && password),
  };
}

function cheapModel() {
  return process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/\{[\s\S]*\}/);
  if (!fenced) return null;
  try {
    return JSON.parse(fenced[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function enrichDecisionWithAi(
  input: AiInput,
  options: { force?: boolean } = {},
): Promise<AiEnrichment> {
  const fallback: AiEnrichment = {
    forecast: "",
    analysis: "",
    recommendation: "",
    confidence: 0,
    allowEntry: false,
    reasons: [],
    provider: "rules-only",
    model: "none",
  };

  if (!hasOpenAiKey()) return fallback;
  if (!input.candidate && !options.force) return fallback;

  const now = Date.now();
  const throttleMs = Number(process.env.OPENAI_MIN_INTERVAL_MS ?? 45_000);
  const last = lastCallAt.get(input.symbol) ?? 0;
  if (!options.force && now - last < throttleMs) {
    return {
      ...fallback,
      reasons: ["AI chaqiruvi tejash uchun cheklandi; qoida tahlili ishlatildi."],
    };
  }

  const system = `Sen professional XAU/BTC trading tahlilchisiz. Faqat o'zbek tilida javob ber.
Majburiy: texnik holat + dunyo/iqtisodiy yangiliklarni birgalikda bahola.
Yangilik (CPI, FOMC, NFP, GDP, ECB/Fed nutqlari va boshqalar) trend bilan mos bo'lsa — prognozda aniq yoz va confidence oshir.
Yangilik qarshi yoki yuqori ta'sirli voqea hozir shovqin qilayotgan bo'lsa — allowEntry=false.
QAT'IY PLUS-ONLY: minus ehtimoli bor bo'lsa allowEntry=false.
Faqat aniq prognoz + trend + (imkon qadar) yangilik mosligi bo'lsa allowEntry=true va confidence>=75.
Shubha, oraliq bozor, keng spred, yangilik shovqini → allowEntry=false.
Hech qachon kafolat bermagin.
Javob FAQAT JSON:
{"forecast":"...","analysis":"...","recommendation":"...","confidence":0-100,"allowEntry":true|false,"reasons":["..."],"newsImpact":"bullish|bearish|neutral|volatile"}`;

  const user = {
    symbol: input.symbol,
    candidate: input.candidate,
    ruleScore: input.score,
    trend: input.trend,
    regime: input.regime,
    price: input.price,
    bid: input.bid,
    ask: input.ask,
    ema20: input.ema20,
    ema50: input.ema50,
    atr: input.atr,
    momentumPct: input.momentumPct,
    volumeRatio: input.volumeRatio,
    entryPrice: input.entryPrice,
    stopLoss: input.stopLoss,
    takeProfit: input.takeProfit,
    riskReasons: input.riskReasons,
    counterEvidence: input.counterEvidence,
    worldNews: input.newsEvents ?? [],
    newsBiasHint: input.newsBiasHint ?? "",
    broker: "Exness MT5 live demo",
    instruction:
      "worldNews ro'yxatini o'qib, XAU/BTC ga ta'sirini analysis va forecast ichida aniq tilga ol.",
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY!.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: cheapModel(),
        temperature: 0.2,
        max_tokens: 320,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(user) },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return {
        ...fallback,
        reasons: [`AI xatosi: HTTP ${response.status}`],
        analysis: errText.slice(0, 180),
      };
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content ?? "";
    const parsed = parseJsonObject(content);
    if (!parsed) {
      return {
        ...fallback,
        reasons: ["AI javobi JSON emas."],
      };
    }

    lastCallAt.set(input.symbol, now);
    const confidence = Math.max(
      0,
      Math.min(100, Number(parsed.confidence ?? 0) || 0),
    );
    const allowEntry = Boolean(parsed.allowEntry) && confidence >= 75;
    return {
      forecast: String(parsed.forecast ?? "").trim(),
      analysis: String(parsed.analysis ?? "").trim(),
      recommendation: String(parsed.recommendation ?? "").trim(),
      confidence,
      allowEntry,
      reasons: Array.isArray(parsed.reasons)
        ? parsed.reasons.map((item) => String(item)).slice(0, 6)
        : [],
      provider: "openai",
      model: cheapModel(),
    };
  } catch (error) {
    return {
      ...fallback,
      reasons: [
        `AI chaqiruvi muvaffaqiyatsiz: ${
          error instanceof Error ? error.message : "noma’lum xato"
        }`,
      ],
    };
  } finally {
    clearTimeout(timeout);
  }
}
