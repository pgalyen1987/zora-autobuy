// The part that decides. Pure: rules + what the creators posted + what was already bought → the buys
// to make now. Everything that spends money is capped here, before any wallet is involved.

export type Rule = {
  name: string;
  /** Zora handle whose posts trigger the rule */
  creator: string;
  /** what to buy: the new post's coin, or the creator's own creator coin */
  buy: "post" | "creator-coin";
  /** dollars per buy (paid in USDC on Base) */
  usd: number;
  /** most buys this rule may make in a UTC day */
  maxPerDay: number;
};

export type Config = {
  rules: Rule[];
  /** hard ceiling across every rule, dollars per UTC day */
  maxUsdPerDay: number;
  /** 0.05 = accept up to 5% worse than quoted */
  slippage?: number;
};

export type Post = { creator: string; coin: string; symbol: string; createdAt: string; creatorCoin: string | null };
export type Spend = { rule: string; coin: string; usd: number; at: string; status: "reserved" | "done" | "failed" | "dry-run"; tx?: string };
export type Buy = { rule: string; creator: string; post: string; coin: string; symbol: string; usd: number; reason: string };

export const MAX_SLIPPAGE = 0.2;
const HANDLE = /^[a-z0-9_.-]{1,40}$/i;

/** Every problem with a config, in words; empty means it can run. */
export function validate(c: Config): string[] {
  const errs: string[] = [];
  if (!Array.isArray(c?.rules) || !c.rules.length) errs.push("rules: add at least one rule");
  if (!(c?.maxUsdPerDay > 0)) errs.push("maxUsdPerDay: set a daily ceiling in dollars (it caps every rule together)");
  if (c?.slippage != null && !(c.slippage > 0 && c.slippage <= MAX_SLIPPAGE)) errs.push(`slippage: between 0 and ${MAX_SLIPPAGE}`);
  const names = new Set<string>();
  for (const [i, r] of (c?.rules ?? []).entries()) {
    const at = `rules[${i}]${r?.name ? ` (${r.name})` : ""}`;
    if (!r?.name) errs.push(`${at}: name it`);
    else if (names.has(r.name)) errs.push(`${at}: names must be unique`);
    else names.add(r.name);
    if (!HANDLE.test(String(r?.creator ?? "").replace(/^@/, ""))) errs.push(`${at}: creator must be a Zora handle`);
    if (r?.buy !== "post" && r?.buy !== "creator-coin") errs.push(`${at}: buy must be "post" or "creator-coin"`);
    if (!(r?.usd > 0)) errs.push(`${at}: usd must be more than 0`);
    if (r?.usd > c?.maxUsdPerDay) errs.push(`${at}: usd is more than maxUsdPerDay, so it could never run`);
    if (!(Number.isInteger(r?.maxPerDay) && r.maxPerDay > 0)) errs.push(`${at}: maxPerDay must be a whole number above 0`);
  }
  return errs;
}

const utcDay = (iso: string) => iso.slice(0, 10);

/**
 * Posts that are new to us: not seen before, and made after the bot started (so starting it never
 * buys a creator's back catalogue).
 */
export function newPosts(posts: Post[], seen: Set<string>, startedAt: string): Post[] {
  return posts.filter((p) => !seen.has(p.coin.toLowerCase()) && p.createdAt > startedAt);
}

/** The buys to make for these new posts, within every cap. Oldest post first. */
export function plan(config: Config, posts: Post[], ledger: Spend[], now: Date): Buy[] {
  const today = utcDay(now.toISOString());
  const counts = (s: Spend) => s.status !== "failed" && s.status !== "dry-run" && utcDay(s.at) === today;
  let spentToday = ledger.filter(counts).reduce((a, s) => a + s.usd, 0);
  const perRule = new Map<string, number>();
  for (const s of ledger.filter(counts)) perRule.set(s.rule, (perRule.get(s.rule) ?? 0) + 1);
  const bought = new Set(ledger.filter((s) => s.status !== "failed" && s.status !== "dry-run").map((s) => `${s.rule}|${s.coin.toLowerCase()}`));
  const out: Buy[] = [];
  for (const p of [...posts].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    for (const r of config.rules) {
      if (r.creator.replace(/^@/, "").toLowerCase() !== p.creator.toLowerCase()) continue;
      const coin = r.buy === "post" ? p.coin : p.creatorCoin;
      if (!coin) continue; // no creator coin to buy
      const key = `${r.name}|${coin.toLowerCase()}`;
      if (bought.has(key)) continue; // never the same coin twice for one rule
      if ((perRule.get(r.name) ?? 0) >= r.maxPerDay) continue;
      if (spentToday + r.usd > config.maxUsdPerDay) continue;
      out.push({ rule: r.name, creator: p.creator, post: p.coin, coin, symbol: r.buy === "post" ? p.symbol : `${p.creator} creator coin`, usd: r.usd,
        reason: `@${p.creator} posted $${p.symbol} at ${p.createdAt}` });
      bought.add(key);
      perRule.set(r.name, (perRule.get(r.name) ?? 0) + 1);
      spentToday += r.usd;
    }
  }
  return out;
}

/**
 * Replay `posts` as if the bot had watched them arrive, day by day, applying every cap exactly as a
 * live run would: `maxPerDay` and `maxUsdPerDay` reset each UTC day, a coin is bought once per rule
 * across the whole window. Pure — no network, no wallet. Used by the backtest to answer "what would
 * this have bought, and cost, over the last N days" honestly. Unlike a dry run of the watch loop,
 * these simulated buys count against the caps, so the totals are what a live run would really spend.
 *
 * Returns each buy with the timestamp it would have fired at, and the posts a rule matched but did
 * not buy (a cap was reached, or that coin was already bought for the rule).
 */
export function replay(config: Config, posts: Post[]): { buys: (Buy & { at: string })[]; skipped: Post[] } {
  const byDay = new Map<string, Post[]>();
  for (const p of posts) {
    const d = utcDay(p.createdAt);
    const a = byDay.get(d);
    if (a) a.push(p); else byDay.set(d, [p]);
  }
  const ledger: Spend[] = [];
  const buys: (Buy & { at: string })[] = [];
  const skipped: Post[] = [];
  for (const d of [...byDay.keys()].sort()) {
    const dayPosts = byDay.get(d)!;
    const dayBuys = plan(config, dayPosts, ledger, new Date(`${d}T23:59:59.999Z`));
    for (const b of dayBuys) {
      const post = dayPosts.find((p) => p.coin === b.post)!;
      ledger.push({ rule: b.rule, coin: b.coin, usd: b.usd, at: post.createdAt, status: "done" });
      buys.push({ ...b, at: post.createdAt });
    }
    for (const p of dayPosts) {
      const matched = config.rules.some((r) => r.creator.replace(/^@/, "").toLowerCase() === p.creator.toLowerCase());
      if (matched && !dayBuys.some((b) => b.post === p.coin)) skipped.push(p);
    }
  }
  return { buys, skipped };
}
