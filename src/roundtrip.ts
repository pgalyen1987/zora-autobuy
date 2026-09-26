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
//
// Or vet ONE creator before you add them to rules.json — sample their recent post coins directly,
// past any rule's daily caps, so you measure the creator's own two-way liquidity, not your config's:
//   npx tsx src/roundtrip.ts --creator somehandle            last 12 post coins, $3 each
//   npx tsx src/roundtrip.ts --creator somehandle --usd 5 --posts 8
import { readFileSync } from "node:fs";
import { distinctByCoin, replay, validate, type Config, type Post } from "./plan.ts";
import { latestPosts, postsSince } from "./zora.ts";
import { USDC } from "./trade.ts";
import { createTradeCall } from "@zoralabs/coins-sdk";
import type { Hex } from "viem";

const QUOTE_SENDER = "0x000000000000000000000000000000000000dEaD";
const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const rulesFile = opt("--rules", "rules.json");
const days = Math.max(1, Number(opt("--days", "7")));
const creatorArg = opt("--creator", "").replace(/^@/, "").toLowerCase(); // vet one creator, past any rule caps
// Set from the rules file below, or left at the 5% default when vetting a bare --creator. buyLeg/sellLeg
// read it at call time (after the branch), so the reassignment lands before any quote is made.
let slippage = 0.05;

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

// 1) the coins to probe — one entry per distinct coin, since the question is about the coin, not how
// many times a rule fired on it. Two ways to choose them:
//   · a rules file — every coin the rules would pick over the window, from the same replay() the
//     backtest uses. We pass an empty noRoute set so every pick is probed: an un-buyable one surfaces
//     as its own "no buy route" row rather than being swapped out, so this set can differ slightly
//     from the backtest's buys.
//   · --creator <handle> — that creator's most recent post coins, sampled directly, past any rule's
//     daily caps. Vetting a creator wants their whole recent output, not the 2-3/day your caps admit;
//     that biased sample is exactly what makes the rules-mode number about your config, not the coin.
type Position = { rule: string; coin: string; symbol: string; usd: number };
const posts: Post[] = [];
let positions: Position[];
let source: string;      // what the header names as the thing being probed
let scope: string;       // one line describing the coin set
let ruleNames: string[]; // rules to break the roll-up down by (empty in --creator mode)

if (creatorArg) {
  const usd = Math.max(1, Number(opt("--usd", "3")));
  const k = Math.max(1, Math.min(20, Number(opt("--posts", "12")))); // Zora's profile API caps a page at 20
  try { posts.push(...(await latestPosts(creatorArg, k))); }
  catch (e: any) { console.error(`could not read @${creatorArg}: ${why(e)}`); process.exit(1); }
  positions = distinctByCoin(posts).slice(0, k).map((p) => ({ rule: creatorArg, coin: p.coin, symbol: p.symbol, usd }));
  if (!positions.length) { console.error(`@${creatorArg} has no recent post coins to check.`); process.exit(1); }
  ruleNames = [];
  source = `@${creatorArg}`;
  scope = `its ${positions.length} most recent post coin(s), $${usd} each`;
} else {
  const config: Config = JSON.parse(readFileSync(rulesFile, "utf8"));
  const problems = validate(config);
  if (problems.length) { console.error(`${rulesFile} can't run:\n  ${problems.join("\n  ")}`); process.exit(1); }
  slippage = config.slippage ?? 0.05;
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();
  const maxPages = Math.min(60, Math.max(20, days * 5));
  const creators = [...new Set(config.rules.map((r) => r.creator.replace(/^@/, "").toLowerCase()))];
  for (const c of creators) {
    try { posts.push(...(await postsSince(c, sinceIso, maxPages)).posts); }
    catch (e: any) { console.error(`  could not read @${c}: ${why(e)}`); }
  }
  positions = distinctByCoin(replay(config, posts, { noRoute: new Set() }).buys);
  ruleNames = config.rules.map((r) => r.name);
  source = rulesFile;
  scope = `every coin the rules picked in ${days} day(s) (${positions.length} distinct)`;
}

const mcap = new Map(posts.map((p) => [p.coin.toLowerCase(), p.marketCap ?? null]));
const fmtMcap = (n: number | null | undefined) =>
  n == null ? "—" : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${Math.round(n)}`;

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s).padEnd(n);

console.log(`\nzora-autobuy round trip · ${source} · ${scope}`);
console.log(`Buy $N, then immediately quote selling back every coin that buy returned. Nothing is signed.`);
console.log(`Not all of these can be bought — a "no buy route" coin is a pick a live run never fills. What can be bought is what the totals are measured against.\n`);
console.log(`  ${pad("coin", 12)}${pad("mkt cap", 9)}${pad("in", 7)}${pad("back", 8)}${pad("keeps", 7)}${pad("coin addr", 14)}note`);

// Roll the coin-by-coin result up by the rule that bought each coin, so the closing report can name
// which rule is losing the money — the one thing a reader changes. `in`/`back` count only coins that
// had a buy route (a live run spends $0 on the rest), matching the overall totals below.
type RuleAgg = { coins: number; in: number; back: number; unsellable: number; noRoute: number };
const byRule = new Map<string, RuleAgg>();
const bucket = (name: string) => { let a = byRule.get(name); if (!a) { a = { coins: 0, in: 0, back: 0, unsellable: 0, noRoute: 0 }; byRule.set(name, a); } return a; };

let totalIn = 0, totalBack = 0, noRoute = 0, unsellable = 0, halved = 0;
for (const b of positions) {
  const agg = bucket(b.rule);
  agg.coins++;
  const cap = fmtMcap(mcap.get(b.coin.toLowerCase()));
  const sym = b.symbol.endsWith("creator coin") ? "creator coin" : `$${b.symbol}`;
  const bought = await buyLeg(b.coin, b.usd);
  if (typeof bought === "object") {
    noRoute++; agg.noRoute++;
    console.log(`  ${pad(sym, 12)}${pad(cap, 9)}${pad(`$${b.usd}`, 7)}${pad("—", 8)}${pad("—", 7)}${pad(short(b.coin), 14)}no buy route: ${bought.error}`);
    continue;
  }
  totalIn += b.usd; agg.in += b.usd;
  const back = await sellLeg(b.coin, bought);
  if (typeof back === "object") {
    unsellable++; agg.unsellable++;
    console.log(`  ${pad(sym, 12)}${pad(cap, 9)}${pad(`$${b.usd}`, 7)}${pad("—", 8)}${pad("0%", 7)}${pad(short(b.coin), 14)}CANNOT SELL: ${back.error}`);
    continue;
  }
  totalBack += back; agg.back += back;
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

// Which rule is the leak? A per-rule roll-up, in config order, mirroring the backtest's per-rule
// spend table so the two commands read as one report: there you see what each rule costs, here what
// each buys back. A rule whose coins keep next to nothing is the one to drop, whatever it spends.
// A per-rule roll-up only helps when there is more than one rule to compare; --creator mode probes a
// single creator, so the totals above already say it. Break it down by rule otherwise.
const anyRule = !creatorArg && ruleNames.some((n) => byRule.get(n)?.coins);
if (anyRule) {
  console.log(`\nPer rule`);
  for (const name of ruleNames) {
    const a = byRule.get(name);
    if (!a?.coins) continue; // this rule matched no coins in the window
    const keeps = a.in ? (a.back / a.in) * 100 : 0;
    const flags = [a.unsellable ? `${a.unsellable} can't sell` : "", a.noRoute ? `${a.noRoute} no buy route` : ""].filter(Boolean).join(", ");
    console.log(`  ${pad(name, 20)} ${String(a.coins).padStart(3)} coin(s) · in ${pad(`$${a.in}`, 5)}→ back ${pad(`$${a.back.toFixed(2)}`, 7)} · keeps ${`${keeps.toFixed(0)}%`.padStart(4)}${flags ? ` · ${flags}` : ""}`);
  }
}

console.log(`\n  Quotes are slippage-adjusted minimums at ${Math.round(slippage * 100)}% and priced now, not at post time.`);
if (creatorArg) {
  // Vetting mode samples the creator's own recent posts directly, so the number is about the creator's
  // liquidity, not about how your caps would have thinned their output. Say that, and how to widen it.
  console.log(`  These are @${creatorArg}'s most recent post coins, sampled directly — past any rule's daily caps,`);
  console.log(`  so "keeps" here is the creator's own two-way liquidity. Vet it before adding them to rules.json.`);
  console.log(`  --usd and --posts change the sample; a bigger --usd usually keeps less (thin pools move on size).\n`);
} else {
  // The backtest and this report count different sets on purpose, so say why rather than let the two
  // dollar figures read as a contradiction: the backtest fills a no-route coin's freed daily slot with
  // the next eligible post (so it can list buys and dollars this probe doesn't), while this probes each
  // pick as-is with no substitution. Both are dry; neither spends anything.
  console.log(`  "In $" here can differ from the backtest's spend: this probes every pick as-is, while the backtest`);
  console.log(`  refills a no-route coin's freed daily slot with the next post. Same rules, two questions.\n`);
}
