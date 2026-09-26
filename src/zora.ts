// Reading Zora: a creator's newest posts (each post is a content coin) and their creator coin.
import { getProfileCoins, setApiKey } from "@zoralabs/coins-sdk";
import type { Post } from "./plan.ts";

if (process.env.ZORA_API_KEY) setApiKey(process.env.ZORA_API_KEY);

/** One profile page's content coins, as Posts, carrying the creator's creator-coin address. */
function toPosts(creator: string, profile: any): Post[] {
  const creatorCoin: string | null = profile.creatorCoin?.address?.toLowerCase() ?? null;
  return (profile.createdCoins?.edges ?? [])
    .map((e: any) => e.node)
    .filter((n: any) => n.coinType === "CONTENT")
    .map((n: any) => ({ creator, coin: String(n.address).toLowerCase(), symbol: n.symbol ?? "", createdAt: new Date(n.createdAt).toISOString(), creatorCoin }));
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
 */
export async function postsSince(handle: string, sinceIso: string, maxPages = 8): Promise<{ posts: Post[]; earliest: string | null; complete: boolean }> {
  const creator = handle.replace(/^@/, "");
  let after: string | undefined;
  const all: Post[] = [];
  let complete = false;
  for (let page = 0; page < maxPages; page++) {
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
