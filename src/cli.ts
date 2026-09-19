#!/usr/bin/env -S npx tsx
// zora-autobuy: watch Zora creators and buy their new posts by your rules.
//
//   npx tsx src/cli.ts --rules rules.json                 dry run: says what it would buy, with a live quote
//   npx tsx src/cli.ts --rules rules.json --once          one pass, then exit
//   PRIVATE_KEY=0x… npx tsx src/cli.ts --rules rules.json --live
//                                                         buys for real, in USDC on Base, within your caps
//
// Flags: --interval <seconds> (default 60), --state <file> (default state/state.json)
// Env:   PRIVATE_KEY (live only), BASE_RPC_URL (optional), ZORA_API_KEY (optional, raises rate limits)
import { readFileSync } from "node:fs";
import { newPosts, plan, validate, type Config, type Post } from "./plan.ts";
import { load, save } from "./state.ts";
import { quote, wallet, type Wallet } from "./trade.ts";
import { latestPosts } from "./zora.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string, dflt: string) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(0, 19).replace("T", " "), ...a);

const rulesFile = opt("--rules", "rules.json");
const stateFile = opt("--state", "state/state.json");
const interval = Math.max(15, Number(opt("--interval", "60"))) * 1000;
const live = flag("--live");

const config: Config = JSON.parse(readFileSync(rulesFile, "utf8"));
const problems = validate(config);
if (problems.length) {
  console.error(`${rulesFile} can't run:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
const slippage = config.slippage ?? 0.05;

let buyer: Wallet | null = null;
if (live) {
  if (!process.env.PRIVATE_KEY) { console.error("--live needs PRIVATE_KEY in the environment (a wallet holding USDC on Base)."); process.exit(1); }
  const pending = load(stateFile).ledger.filter((s) => s.status === "reserved");
  if (pending.length) {
    // a buy was started and the bot stopped before it learned the outcome; buying again could double it
    console.error(`${pending.length} buy(s) in ${stateFile} never finished (${pending.map((p) => p.coin).join(", ")}). Check them on basescan, set their status to "done" or "failed", then start again.`);
    process.exit(1);
  }
  buyer = wallet(process.env.PRIVATE_KEY, process.env.BASE_RPC_URL);
}

log(live ? `LIVE from ${buyer!.address}` : "dry run (nothing is bought; add --live and PRIVATE_KEY to buy)",
  `· ${config.rules.length} rule(s) · at most $${config.maxUsdPerDay} a day · slippage ${Math.round(slippage * 100)}%`);

async function pass() {
  const state = load(stateFile);
  const creators = [...new Set(config.rules.map((r) => r.creator.replace(/^@/, "").toLowerCase()))];
  const posts: Post[] = [];
  for (const c of creators) {
    try { posts.push(...(await latestPosts(c))); } catch (e: any) { log(`@${c}: ${String(e?.message ?? e).slice(0, 120)}`); }
  }
  const fresh = newPosts(posts, new Set(state.seen), state.startedAt);
  const buys = plan(config, fresh, state.ledger, new Date());
  for (const p of fresh) if (!buys.some((b) => b.post === p.coin)) log(`skipped $${p.symbol} by @${p.creator}: a daily limit is reached, or no rule buys it`);
  for (const b of buys) {
    if (!buyer) {
      const q = await quote(b.coin, b.usd, slippage);
      log(`would buy $${b.usd} of ${b.symbol} (${b.coin}) for rule "${b.rule}": ${"coins" in q ? `about ${q.coins.toLocaleString("en-US")} coins at the current price` : `no quote (${q.error})`}. ${b.reason}`);
      state.ledger.push({ rule: b.rule, coin: b.coin, usd: b.usd, at: new Date().toISOString(), status: "dry-run" });
      continue;
    }
    const entry = { rule: b.rule, coin: b.coin, usd: b.usd, at: new Date().toISOString(), status: "reserved" as const };
    state.ledger.push(entry);
    save(stateFile, state); // on disk before anything is signed
    try {
      const tx = await buyer.buy(b.coin, b.usd, slippage);
      Object.assign(entry, { status: "done", tx });
      log(`bought $${b.usd} of ${b.symbol} for rule "${b.rule}": https://basescan.org/tx/${tx}`);
    } catch (e: any) {
      Object.assign(entry, { status: "failed" });
      log(`buy failed for ${b.symbol} (rule "${b.rule}"): ${String(e?.message ?? e).slice(0, 160)}`);
    }
    save(stateFile, state);
  }
  state.seen.push(...fresh.map((p) => p.coin)); // a post is judged once, when it's new
  save(stateFile, state);
}

let stopping = false;
process.on("SIGINT", () => { stopping = true; log("stopping after this pass"); });
do {
  try { await pass(); } catch (e: any) { log(`pass failed: ${String(e?.message ?? e).slice(0, 160)}`); }
  if (flag("--once") || stopping) break;
  await new Promise((r) => setTimeout(r, interval));
} while (!stopping);
