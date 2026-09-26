import { test } from "node:test";
import assert from "node:assert/strict";
import { newPosts, plan, replay, validate, type Config, type Post, type Spend } from "../src/plan.ts";

const rule = { name: "jesse", creator: "jessepollak", buy: "post" as const, usd: 10, maxPerDay: 3 };
const config: Config = { rules: [rule], maxUsdPerDay: 25 };
const post = (n: number, creator = "jessepollak"): Post => ({ creator, coin: `0x${String(n).padStart(40, "0")}`, symbol: `P${n}`, createdAt: `2026-09-19T0${n}:00:00Z`, creatorCoin: "0xcc" });
const now = new Date("2026-09-19T12:00:00Z");

test("a config without a daily ceiling or with a bad rule doesn't run", () => {
  assert.deepEqual(validate(config), []);
  assert.match(validate({ rules: [rule], maxUsdPerDay: 0 }).join(), /maxUsdPerDay/);
  assert.match(validate({ rules: [{ ...rule, buy: "everything" as never }], maxUsdPerDay: 25 }).join(), /buy must be/);
  assert.match(validate({ rules: [{ ...rule, usd: 50 }], maxUsdPerDay: 25 }).join(), /could never run/);
  assert.match(validate({ rules: [rule], maxUsdPerDay: 25, slippage: 0.5 }).join(), /slippage/);
  assert.match(validate({ rules: [rule, rule], maxUsdPerDay: 25 }).join(), /unique/);
});

test("posts from before the bot started, or already seen, are not new", () => {
  const posts = [post(1), post(2), post(3)];
  assert.deepEqual(newPosts(posts, new Set([post(3).coin]), "2026-09-19T01:30:00Z").map((p) => p.symbol), ["P2"]);
});

test("one buy per new post, oldest first, within the daily ceiling", () => {
  const buys = plan(config, [post(3), post(1), post(2)], [], now);
  // $10 each against a $25 ceiling: two buys, the third waits
  assert.deepEqual(buys.map((b) => b.symbol), ["P1", "P2"]);
});

test("the per-rule daily count and earlier spending both count", () => {
  const ledger: Spend[] = [{ rule: "jesse", coin: "0xold", usd: 10, at: "2026-09-19T01:00:00Z", status: "done" }];
  assert.equal(plan(config, [post(1), post(2)], ledger, now).length, 1); // $10 spent + 1 more = $20; a third would pass $25
  const failed: Spend[] = [{ rule: "jesse", coin: "0xold", usd: 10, at: "2026-09-19T01:00:00Z", status: "failed" }];
  assert.equal(plan(config, [post(1), post(2)], failed, now).length, 2); // a failed buy spent nothing
  const yesterday: Spend[] = [{ rule: "jesse", coin: "0xold", usd: 20, at: "2026-09-18T23:00:00Z", status: "done" }];
  assert.equal(plan(config, [post(1), post(2)], yesterday, now).length, 2); // the ceiling is per UTC day
});

test("never the same coin twice for one rule, and other creators' posts are ignored", () => {
  const ledger: Spend[] = [{ rule: "jesse", coin: post(1).coin, usd: 10, at: "2026-09-18T01:00:00Z", status: "done" }];
  assert.deepEqual(plan(config, [post(1), post(2, "someoneelse")], ledger, now), []);
});

test("creator-coin rules buy the creator coin, once", () => {
  const cc: Config = { rules: [{ ...rule, name: "cc", buy: "creator-coin" }], maxUsdPerDay: 100 };
  const buys = plan(cc, [post(1), post(2)], [], now);
  assert.deepEqual(buys.map((b) => b.coin), ["0xcc"]);
});

// backtest replay: the caps a live run enforces per UTC day must reset each day, and dedup holds across days.
const rp = (n: number, day: number, creator = "jessepollak"): Post =>
  ({ creator, coin: `0x${String(n).padStart(40, "0")}`, symbol: `P${n}`, createdAt: `2026-09-${String(day).padStart(2, "0")}T0${n}:00:00Z`, creatorCoin: "0xdead" });

test("replay resets the daily ceiling each UTC day", () => {
  const cfg: Config = { rules: [{ name: "r", creator: "jessepollak", buy: "post", usd: 10, maxPerDay: 5 }], maxUsdPerDay: 25 };
  // day 20: P1,P2 buy ($20); P3 would pass $25 so it waits. day 21: caps reset, P4,P5 buy.
  const { buys, skipped } = replay(cfg, [rp(1, 20), rp(2, 20), rp(3, 20), rp(4, 21), rp(5, 21)]);
  assert.deepEqual(buys.map((b) => b.symbol), ["P1", "P2", "P4", "P5"]);
  assert.deepEqual(skipped.map((p) => p.symbol), ["P3"]);
});

test("replay buys a creator coin only once across the whole window", () => {
  const cfg: Config = { rules: [{ name: "cc", creator: "jessepollak", buy: "creator-coin", usd: 5, maxPerDay: 2 }], maxUsdPerDay: 100 };
  const { buys } = replay(cfg, [rp(1, 20), rp(2, 21)]); // two posts on different days, one creator coin
  assert.deepEqual(buys.map((b) => b.coin), ["0xdead"]);
});

test("replay stamps each buy with the triggering post's time and respects per-rule maxPerDay", () => {
  const cfg: Config = { rules: [{ name: "r", creator: "jessepollak", buy: "post", usd: 1, maxPerDay: 2 }], maxUsdPerDay: 100 };
  const { buys, skipped } = replay(cfg, [rp(1, 20), rp(2, 20), rp(3, 20)]); // 3 posts, cap 2/day
  assert.equal(buys.length, 2);
  assert.equal(buys[0].at, rp(1, 20).createdAt); // fires at the post's time, oldest first
  assert.deepEqual(skipped.map((p) => p.symbol), ["P3"]);
});

test("replay: an un-routable coin fails for $0 and hands its daily slot to the next post", () => {
  const cfg: Config = { rules: [{ name: "r", creator: "jessepollak", buy: "post", usd: 10, maxPerDay: 3 }], maxUsdPerDay: 100 };
  const posts = [rp(1, 20), rp(2, 20), rp(3, 20), rp(4, 20)];
  const noRoute = new Set([rp(2, 20).coin.toLowerCase()]);
  const { buys, noRouteBuys } = replay(cfg, posts, { noRoute });
  // P2 can't route: a live run fails it for $0 and the slot goes to P4, so three real buys — not P1–P3.
  assert.deepEqual(buys.map((b) => b.symbol), ["P1", "P3", "P4"]);
  assert.deepEqual(noRouteBuys.map((b) => b.symbol), ["P2"]);
});

test("replay: when nothing routes, no money moves and failures never burn the cap", () => {
  const cfg: Config = { rules: [{ name: "r", creator: "jessepollak", buy: "post", usd: 10, maxPerDay: 2 }], maxUsdPerDay: 100 };
  const posts = [rp(1, 20), rp(2, 20), rp(3, 20)];
  const noRoute = new Set(posts.map((p) => p.coin.toLowerCase()));
  const { buys, noRouteBuys } = replay(cfg, posts, { noRoute });
  // A failed buy spends nothing and doesn't count against maxPerDay, so all three are attempted and $0 moves.
  assert.deepEqual(buys, []);
  assert.deepEqual(noRouteBuys.map((b) => b.symbol), ["P1", "P2", "P3"]);
});
