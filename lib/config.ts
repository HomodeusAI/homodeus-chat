import type { Budget } from "./threads";

const num = (v: string | undefined, d: number) => (v ? Number(v) : d);

export const DB_URL =
  process.env.CHAT_DATABASE_URL ?? "postgresql://joaopanizzutti@localhost:5432/gbrain";

export const BUDGET: Budget = {
  maxTurns: num(process.env.CHAT_MAX_TURNS, 12),
  maxTokens: num(process.env.CHAT_MAX_TOKENS, 200_000),
  maxCostUsd: num(process.env.CHAT_MAX_COST_USD, 5),
};

export const PAIR_WAKES_PER_MIN = num(process.env.CHAT_PAIR_WAKES_PER_MIN, 6);
