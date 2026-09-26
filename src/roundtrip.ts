#!/usr/bin/env -S npx tsx
// Does this bot EARN? The backtest answers the other half — what it would spend. This asks whether
// what it bought can be sold.
//
// The test is a round trip, because that is the only thing that settles the question: quote buying
// $N of a coin, then immediately quote selling back every coin that buy returned. What comes back is
// what the position is worth the moment you own it — before any price move, before any thesis. A
// round trip that returns well under what went in is not a bad entry price, it is a position you
// cannot exit at that size, and no later price move helps you.
//
// It buys nothing, signs nothing and needs no wallet — two quotes per coin, same as the backtest.
//
//   npx tsx src/roundtrip.ts --rules rules.json --days 7
import { readFileSync } from "node:fs";
import { replay, validate, type Config, type Post } from "./plan.ts";
import { postsSince } from "./zora.ts";
import { USDC } from "./trade.ts";
import { createTradeCall } from "@zoralabs/coins-sdk";
import type { Hex } from "viem";

const QUOTE_SENDER = "0x000000000000000000000000000000000000dEaD";
const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const rulesFile = opt("--rules", "rules.json");
const days = Math.max(1, Number(opt("--days", "7")));

const config: Config = JSON.parse(readFileSync(rulesFile, "utf8"));
const problems = validate(config);
if (problems.length) { console.error(`${rulesFile} can't run:\n  ${problems.join("\n  ")}`); process.exit(1); }
const slippage = config.slippage ?? 0.05;

// Same muting as trade.ts: a coin with no swap route makes the SDK dump the raw request/response.
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const saved = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  console.log = console.error = console.warn = console.info = () => {};
  try { return await fn(); } finally { Object.assign(console, saved); }
};
const why = (e: any) => String(e?.error?.error ?? e?.message ?? e).replace(/\s+/g, " ").slice(0, 52);

/** USDC -> coin, in the coin's own base units, so the sell leg sells exactly what the buy returned. */
async function buyLeg(coin: string, usd: number): Promise<bigint | { error: string }> {
  try {
    const q: any = await quiet(() => createTradeCall({
      sell: { type: "erc20", address: USDC }, buy: { type: "erc20", address: coin as Hex },
      amountIn: BigInt(Math.round(usd * 1e6)), slippage, sender: QUOTE_SENDER,
    }));
    return BigInt(q?.quote?.amountOut ?? 0);
  } catch (e: any) { return { error: why(e) }; }
}

/** coin -> USDC, for exactly `amount` base units. Returns dollars. */
async function sellLeg(coin: string, amount: bigint): Promise<number | { error: string }> {
  try {
    const q: any = await quiet(() => createTradeCall({
      sell: { type: "erc20", address: coin as Hex }, buy: { type: "erc20", address: USDC },
      amountIn: amount, slippage, sender: QUOTE_SENDER,
    }));
    return Number(BigInt(q?.quote?.amountOut ?? 0)) / 1e6;
  } catch (e: any) { return { error: why(e) }; }
}

// 1) the coins the rules point at, from the same replay() the backtest uses — not a hand-copied
// list. Note we pass an empty noRoute set: the backtest substitutes away coins with no buy route,
// but here we want to probe every pick, so an un-buyable one surfaces as its own "no buy route" row
// rather than being silently swapped out. So this set can differ slightly from the backtest's buys.
const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();
const maxPages = Math.min(60, Math.max(20, days * 5));
const creators = [...new Set(config.rules.map((r) => r.creator.replace(/^@/, "").toLowerCase()))];
const posts: Post[] = [];
for (const c of creators) {
  try { posts.push(...(await postsSince(c, sinceIso, maxPages)).posts); }
  catch (e: any) { console.error(`  could not read @${c}: ${why(e)}`); }
}
const { buys } = replay(config, posts, { noRoute: new Set() });
const mcap = new Map(posts.map((p) => [p.coin.toLowerCase(), p.marketCap ?? null]));
const fmtMcap = (n: number | null | undefined) =>
  n == null ? "—" : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${Math.round(n)}`;

// One entry per distinct coin: the question is about the coin, not about how many times a rule fired.
const seen = new Set<string>();
const positions = buys.filter((b) => { const k = b.coin.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s).padEnd(n);

console.log(`\nzora-autobuy round trip · ${rulesFile} · the ${positions.length} distinct coin(s) it would have bought in ${days} day(s)`);
console.log(`Buy $N, then immediately quote selling back every coin that buy returned. Nothing is signed.\n`);
console.log(`  ${pad("coin", 12)}${pad("mkt cap", 9)}${pad("in", 7)}${pad("back", 8)}${pad("keeps", 7)}${pad("coin addr", 14)}note`);

let totalIn = 0, totalBack = 0, noRoute = 0, unsellable = 0, halved = 0;
for (const b of positions) {
  const cap = fmtMcap(mcap.get(b.coin.toLowerCase()));
  const sym = b.symbol.endsWith("creator coin") ? "creator coin" : `$${b.symbol}`;
  const bought = await buyLeg(b.coin, b.usd);
  if (typeof bought === "object") {
    noRoute++;
    console.log(`  ${pad(sym, 12)}${pad(cap, 9)}${pad(`$${b.usd}`, 7)}${pad("—", 8)}${pad("—", 7)}${pad(short(b.coin), 14)}no buy route: ${bought.error}`);
    continue;
  }
  totalIn += b.usd;
  const back = await sellLeg(b.coin, bought);
  if (typeof back === "object") {
    unsellable++;
    console.log(`  ${pad(sym, 12)}${pad(cap, 9)}${pad(`$${b.usd}`, 7)}${pad("—", 8)}${pad("0%", 7)}${pad(short(b.coin), 14)}CANNOT SELL: ${back.error}`);
    continue;
  }
  totalBack += back;
  const keeps = (back / b.usd) * 100;
  if (keeps < 50) halved++;
  console.log(`  ${pad(sym, 12)}${pad(cap, 9)}${pad(`$${b.usd}`, 7)}${pad(`$${back.toFixed(2)}`, 8)}${pad(`${keeps.toFixed(0)}%`, 7)}${pad(short(b.coin), 14)}`);
}

const keptPct = totalIn ? (totalBack / totalIn) * 100 : 0;
console.log(`\n  In $${totalIn.toFixed(2)} · back $${totalBack.toFixed(2)} · keeps ${keptPct.toFixed(0)}% on an immediate exit,`);
console.log(`  so the round trip costs ${(100 - keptPct).toFixed(0)}% the moment you buy.`);
if (unsellable) console.log(`  ${unsellable} position(s) could not be sold AT ALL — that money is gone, not down.`);
if (halved) console.log(`  ${halved} more lost over half their value on the way out.`);
if (noRoute) console.log(`  (${noRoute} coin(s) could not even be bought; a live run fails those for $0.)`);
console.log(`\n  Read it as a hurdle: a coin has to rise ${keptPct > 0 ? `${(100 / (keptPct / 100) - 100).toFixed(0)}%` : "infinitely"} before the position breaks even.`);
console.log(`  Quotes are slippage-adjusted minimums at ${Math.round(slippage * 100)}% and priced now, not at post time.\n`);
