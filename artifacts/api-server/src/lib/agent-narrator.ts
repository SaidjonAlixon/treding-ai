type Tone = "good" | "bad" | "neutral";

export type AgentNarration = {
  id: number;
  at: Date;
  kind: string;
  message: string;
  tone: Tone;
};

const buffer: AgentNarration[] = [];
let seq = 1;

export function narrate(
  message: string,
  options: { kind?: string; tone?: Tone } = {},
) {
  const item: AgentNarration = {
    id: seq++,
    at: new Date(),
    kind: options.kind ?? "agent_status",
    message,
    tone: options.tone ?? "neutral",
  };
  buffer.unshift(item);
  if (buffer.length > 40) buffer.pop();
  return item;
}

export function getNarrations(limit = 12) {
  return buffer.slice(0, limit);
}
