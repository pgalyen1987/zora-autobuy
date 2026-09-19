// What the bot remembers between runs: when it started (older posts are never bought), which posts it
// has seen, and every buy it reserved, made or failed. One JSON file, written atomically.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Spend } from "./plan.ts";

export type State = { startedAt: string; seen: string[]; ledger: Spend[] };

export function load(file: string): State {
  if (!existsSync(file)) return { startedAt: new Date().toISOString(), seen: [], ledger: [] };
  return JSON.parse(readFileSync(file, "utf8"));
}

export function save(file: string, s: State) {
  mkdirSync(dirname(file), { recursive: true });
  // keep the file small: 2,000 seen posts and 90 days of ledger is plenty
  const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const trimmed = { ...s, seen: s.seen.slice(-2000), ledger: s.ledger.filter((x) => x.at >= cutoff) };
  writeFileSync(`${file}.tmp`, JSON.stringify(trimmed, null, 2));
  renameSync(`${file}.tmp`, file);
}
