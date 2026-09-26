#!/usr/bin/env -S npx tsx
// zora-autobuy backtest: replay your rules over the last N days against real Zora data, so you can
// see what they would have bought and what it would have cost — before you ever run it live.
//
//   npx tsx src/backtest.ts --rules rules.json                 last 7 days
//   npx tsx src/backtest.ts --rules rules.json --days 30       a longer window
//
// It buys nothing and needs no wallet. Cost is exact (buys are a fixed number of dollars in USDC);
// the coin counts are TODAY's quote from Zora, not the price at post time, so a real buy back then
// would have got a different amount. That gap is stated in the report.
import { readFileSync } from "node:fs";
import { replay, validate, type Config, type Post } from "./plan.ts";
import { postsSince } from "./zora.ts";
import { quote } from "./trade.ts";

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const rulesFile = opt("--rules", "rules.json");
const days = Math.max(1, Number(opt("--days", "7")));
const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();

const config: Config = JSON.parse(readFileSync(rulesFile, "utf8"));
const problems = validate(config);
if (problems.length) { console.error(`${rulesFile} can't run:\n  ${problems.join("\n  ")}`); process.exit(1); }
const slippage = config.slippage ?? 0.05;

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const utc = (iso: string) => iso.slice(0, 16).replace("T", " ");
const money = (n: number) => `$${n % 1 ? n.toFixed(2) : n}`;
const num = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const pad = (s: string, n: number) => clip(s, n).padEnd(n);

// 1) fetch each creator's real posts back to the window start
const creators = [...new Set(config.rules.map((r) => r.creator.replace(/^@/, "").toLowerCase()))];
type Cover = { earliest: string | null; complete: boolean; count: number; error?: string };
const coverage = new Map<string, Cover>();
const posts: Post[] = [];
for (const c of creators) {
  try {
    const r = await postsSince(c, sinceIso);
    coverage.set(c, { earliest: r.earliest, complete: r.complete, count: r.posts.length });
    posts.push(...r.posts);
  } catch (e: any) {
    coverage.set(c, { earliest: null, complete: false, count: 0, error: String(e?.message ?? e).slice(0, 100) });
  }
}

// 2) replay day by day, then quote each buy at the current price. The Zora SDK prints the raw
// request/response to the console when a coin has no swap route; mute it so the report stays clean.
const { buys, skipped } = replay(config, posts);
const rows = [];
let noRoute = 0;
const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
console.log = console.error = console.warn = console.info = () => {};
for (const b of buys) {
  const q = await quote(b.coin, b.usd, slippage);
  if ("coins" in q) rows.push({ ...b, quote: `${num(q.coins)} coins`, ok: true });
  else { noRoute++; rows.push({ ...b, quote: /route/i.test(q.error) ? "no route yet" : `no quote`, ok: false }); }
}
Object.assign(console, orig);

// 3) report
const anyIncomplete = [...coverage.values()].some((c) => !c.complete && !c.error);
console.log(`\nzora-autobuy backtest · ${rulesFile} · last ${days} day${days === 1 ? "" : "s"} (since ${utc(sinceIso)} UTC)`);
console.log(`dry run — nothing was bought · ${config.rules.length} rule(s) · at most ${money(config.maxUsdPerDay)}/day · slippage ${Math.round(slippage * 100)}%\n`);

console.log("Coverage");
for (const c of creators) {
  const cov = coverage.get(c)!;
  if (cov.error) { console.log(`  @${pad(c, 16)} could not read: ${cov.error}`); continue; }
  const state = cov.complete ? "complete" : `INCOMPLETE — profile only went back to ${utc(cov.earliest ?? "")}`;
  console.log(`  @${pad(c, 16)} ${String(cov.count).padStart(4)} post(s) in window · ${state}`);
}

console.log(`\nBuys it would have made (${rows.length})`);
if (rows.length) {
  console.log(`  ${pad("when (UTC)", 17)}${pad("rule", 18)}${pad("buys", 24)}${pad("$", 4)}${pad("~coins at today's price", 22)}coin`);
  for (const r of rows) {
    const what = r.symbol.endsWith("creator coin") ? `creator coin` : `post $${r.symbol}`;
    console.log(`  ${pad(utc(r.at), 17)}${pad(r.rule, 18)}${pad(what, 24)}${pad(String(r.usd), 4)}${pad(r.quote, 22)}${short(r.coin)}`);
  }
}
const total = rows.reduce((a, r) => a + r.usd, 0);
console.log(`  ${rows.length} buy(s) · ${money(total)} spent over the window` + (days ? ` (~${money(total / days)}/day avg)` : ""));
if (noRoute) console.log(`  ${noRoute} of them have no tradeable route right now — a live run would fail those buys until liquidity exists.`);

console.log(`\nPer rule`);
for (const rule of config.rules) {
  const mine = rows.filter((r) => r.rule === rule.name);
  const spent = mine.reduce((a, r) => a + r.usd, 0);
  console.log(`  ${pad(rule.name, 20)} ${String(mine.length).padStart(3)} buy(s) · ${pad(money(spent), 7)} · ${rule.buy} @${rule.creator} (cap ${rule.maxPerDay}/day, ${money(rule.usd)}/buy)`);
}
if (skipped.length) console.log(`\nSkipped ${skipped.length} matching post(s): a daily cap was reached, or that coin was already bought for the rule.`);

console.log(`\nNotes`);
console.log(`  · Cost is exact — every buy is a fixed number of dollars in USDC. Coin counts are TODAY's`);
console.log(`    Zora quote, not the price when the post went out, so a live buy then would differ.`);
if (anyIncomplete) console.log(`  · Coverage marked INCOMPLETE above is a floor: the profile API stops after so many pages, so a\n    very active creator's older posts in the window aren't counted. Real spend would be higher.`);
console.log(`  · This respects the daily caps a live run would, so these totals are what it would spend.\n`);
