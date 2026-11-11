export type CalendarImpact = "high" | "medium" | "low";

export type CalendarItem = {
  id: string;
  title: string;
  currency: string;
  impact: CalendarImpact;
  scheduledAt: Date;
  source: string;
  verified: boolean;
};

type Cache = {
  fetchedAt: number;
  items: CalendarItem[];
};

let cache: Cache | null = null;

function mapImpact(value: string): CalendarImpact {
  const normalized = value.toLowerCase();
  if (normalized === "high") return "high";
  if (normalized === "medium") return "medium";
  return "low";
}

export async function refreshEconomicCalendar() {
  const response = await fetch(
    "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!response.ok) throw new Error(`Calendar HTTP ${response.status}`);
  const rows = (await response.json()) as Array<{
    title?: string;
    country?: string;
    date?: string;
    impact?: string;
  }>;

  const now = Date.now();
  const items = rows
    .map((row, index) => {
      const scheduledAt = new Date(row.date ?? "");
      if (Number.isNaN(scheduledAt.getTime())) return null;
      const impact = mapImpact(row.impact ?? "Low");
      // Holiday impactini low qilib olamiz
      return {
        id: `${scheduledAt.toISOString()}-${row.country ?? "XX"}-${index}`,
        title: String(row.title ?? "Voqea"),
        currency: String(row.country ?? "USD"),
        impact: row.impact?.toLowerCase() === "holiday" ? ("low" as const) : impact,
        scheduledAt,
        source: "ForexFactory public calendar",
        verified: true,
      } satisfies CalendarItem;
    })
    .filter((item): item is CalendarItem => Boolean(item))
    .filter((item) => item.scheduledAt.getTime() >= now - 2 * 60 * 60 * 1000)
    .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())
    .slice(0, 40);

  cache = { fetchedAt: Date.now(), items };
  return items;
}

export function getEconomicCalendar(limit = 8): CalendarItem[] {
  if (!cache) return [];
  if (Date.now() - cache.fetchedAt > 30 * 60_000) return cache.items.slice(0, limit);
  return cache.items.slice(0, limit);
}

export function getCalendarStatus() {
  if (!cache) {
    return { connected: false, detail: "Iqtisodiy taqvim hali yuklanmagan." };
  }
  const age = Math.round((Date.now() - cache.fetchedAt) / 1000);
  return {
    connected: true,
    detail: `ForexFactory taqvim · ${cache.items.length} voqea · yoshi ${age}s`,
  };
}

export function isInsideNewsBuffer(
  beforeMinutes: number,
  afterMinutes: number,
  now = new Date(),
) {
  if (!cache) return { blocked: false, reason: null as string | null };
  const beforeMs = beforeMinutes * 60_000;
  const afterMs = afterMinutes * 60_000;
  for (const event of cache.items) {
    if (event.impact !== "high" && event.impact !== "medium") continue;
    const t = event.scheduledAt.getTime();
    if (now.getTime() >= t - beforeMs && now.getTime() <= t + afterMs) {
      return {
        blocked: true,
        reason: `Yangilik buferi: ${event.currency} · ${event.title}`,
      };
    }
  }
  return { blocked: false, reason: null as string | null };
}
