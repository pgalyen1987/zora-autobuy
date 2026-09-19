// Reading Zora: a creator's newest posts (each post is a content coin) and their creator coin.
import { getProfileCoins, setApiKey } from "@zoralabs/coins-sdk";
import type { Post } from "./plan.ts";

if (process.env.ZORA_API_KEY) setApiKey(process.env.ZORA_API_KEY);

/** The creator's latest posts, newest first, with their creator coin's address. */
export async function latestPosts(handle: string, count = 10): Promise<Post[]> {
  const creator = handle.replace(/^@/, "");
  const r: any = await getProfileCoins({ identifier: creator, count });
  const p = r.data?.profile;
  if (!p) throw new Error(`no Zora profile called "${creator}"`);
  const creatorCoin: string | null = p.creatorCoin?.address?.toLowerCase() ?? null;
  return (p.createdCoins?.edges ?? [])
    .map((e: any) => e.node)
    .filter((n: any) => n.coinType === "CONTENT")
    .map((n: any) => ({ creator, coin: String(n.address).toLowerCase(), symbol: n.symbol ?? "", createdAt: new Date(n.createdAt).toISOString(), creatorCoin }));
}
