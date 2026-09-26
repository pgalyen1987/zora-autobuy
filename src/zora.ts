// Reading Zora: a creator's newest posts (each post is a content coin) and their creator coin.
import { getProfileCoins, setApiKey } from "@zoralabs/coins-sdk";
import type { Post } from "./plan.ts";

if (process.env.ZORA_API_KEY) setApiKey(process.env.ZORA_API_KEY);

/**
 * USD market cap = price per coin × total supply. Derive it rather than trust Zora's own `marketCap`
 * field, which comes back 0 for coins whose pool trades against a creator/exotic token (e.g. a
 * creator coin) even though a USD price exists — reporting that 0 would read as "worthless" when it
 * only means "unpriced against USD in the field". Fall back to the field, then to null when we
 * genuinely can't price it, so the backtest can honestly show "—" instead of a made-up number.
 */
export function mktCap(n: any): number | null {
  const derived = Number(n.tokenPrice?.priceInUsdc ?? 0) * Number(n.totalSupply ?? 0);
  if (derived > 0) return derived;
  const field = Number(n.marketCap ?? 0);
  return field > 0 ? field : null;
}

/** One profile page's content coins, as Posts, carrying the creator's creator-coin address. */
function toPosts(creator: string, profile: any): Post[] {
  const creatorCoin: string | null = profile.creatorCoin?.address?.toLowerCase() ?? null;
  return (profile.createdCoins?.edges ?? [])
    .map((e: any) => e.node)
    .filter((n: any) => n.coinType === "CONTENT")
    .map((n: any) => ({ creator, coin: String(n.address).toLowerCase(), symbol: n.symbol ?? "", createdAt: new Date(n.createdAt).toISOString(), creatorCoin, marketCap: mktCap(n) }));
}

/** The creator's latest posts, newest first, with their creator coin's address. */
export async function latestPosts(handle: string, count = 10): Promise<Post[]> {
  const creator = handle.replace(/^@/, "");
  const r: any = await getProfileCoins({ identifier: creator, count });
  const p = r.data?.profile;
  if (!p) throw new Error(`no Zora profile called "${creator}"`);
  return toPosts(creator, p);
}

/**
 * Every post a creator made at or after `sinceIso`, paging back through their profile until we pass
 * the cutoff, the API runs out, or `maxPages` is hit. `complete` is true when the window is fully
 * covered — either we saw a post older than the cutoff, or the creator has no more posts. It is
 * false only when `maxPages` cut us off while still inside the window, so a caller can say so
 * honestly. `earliest` is the oldest post we actually fetched (how far back we really looked).
 *
 * The Zora profile API returns at most 20 coins per page whatever `count` we ask for (measured
 * 2026-09-26 — `count: 100` still yields 20), so `maxPages` is what really bounds how far back we
 * can look: a creator who posts ~20/day needs about one page per day. The caller scales `maxPages`
 * to the window so an ordinarily active creator is fully covered; the cap only bites on a true
 * firehose, and when it does `complete` comes back false so the report can say the total is a floor.
 */
export async function postsSince(handle: string, sinceIso: string, maxPages = 40): Promise<{ posts: Post[]; earliest: string | null; complete: boolean }> {
  const creator = handle.replace(/^@/, "");
  let after: string | undefined;
  const all: Post[] = [];
  let complete = false;
  for (let page = 0; page < maxPages; page++) {
    // count is capped at 20 server-side; we still ask for it so the intent reads clearly.
    const r: any = await getProfileCoins({ identifier: creator, count: 100, after });
    const p = r.data?.profile;
    if (!p) { if (page === 0) throw new Error(`no Zora profile called "${creator}"`); complete = true; break; }
    const batch = toPosts(creator, p);
    all.push(...batch);
    const oldest = batch.reduce<string | null>((m, x) => (m === null || x.createdAt < m ? x.createdAt : m), null);
    if (oldest !== null && oldest < sinceIso) { complete = true; break; } // covered the window
    const pi = p.createdCoins?.pageInfo;
    if (!pi?.hasNextPage || !pi?.endCursor) { complete = true; break; } // creator has no more posts
    after = pi.endCursor;
  }
  const earliest = all.reduce<string | null>((m, x) => (m === null || x.createdAt < m ? x.createdAt : m), null);
  return { posts: all.filter((p) => p.createdAt >= sinceIso), earliest, complete };
}
