// Buying: always in USDC on Base, so a rule's dollar amount is exact. A dry run asks Zora for a
// quote and stops there; only a live run signs anything.
import { createTradeCall, tradeCoin } from "@zoralabs/coins-sdk";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

export const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
// a quote needs a sender; any address does when nothing will be sent
const QUOTE_SENDER = "0x000000000000000000000000000000000000dEaD";
const usdcUnits = (usd: number) => BigInt(Math.round(usd * 1e6));

/** Roughly how many coins `usd` buys right now, as a whole-coin number, or why it can't. */
export async function quote(coin: string, usd: number, slippage: number): Promise<{ coins: number } | { error: string }> {
  try {
    const q: any = await createTradeCall({ sell: { type: "erc20", address: USDC }, buy: { type: "erc20", address: coin as Hex }, amountIn: usdcUnits(usd), slippage, sender: QUOTE_SENDER });
    const out = BigInt(q?.quote?.amountOut ?? 0);
    return { coins: Number(out / 10n ** 12n) / 1e6 };
  } catch (e: any) {
    return { error: String(e?.error?.error ?? e?.message ?? e).slice(0, 120) };
  }
}

export type Wallet = { address: string; buy: (coin: string, usd: number, slippage: number) => Promise<string> };

/** A wallet from a private key in the environment. Only created for a live run. */
export function wallet(privateKey: string, rpcUrl?: string): Wallet {
  const account = privateKeyToAccount(privateKey as Hex);
  const transport = http(rpcUrl || "https://mainnet.base.org");
  const publicClient = createPublicClient({ chain: base, transport });
  const walletClient = createWalletClient({ account, chain: base, transport });
  return {
    address: account.address,
    async buy(coin, usd, slippage) {
      const receipt = await tradeCoin({
        tradeParameters: { sell: { type: "erc20", address: USDC }, buy: { type: "erc20", address: coin as Hex }, amountIn: usdcUnits(usd), slippage, sender: account.address },
        walletClient, account, publicClient,
      });
      if (receipt.status !== "success") throw new Error(`transaction ${receipt.transactionHash} reverted`);
      return receipt.transactionHash;
    },
  };
}
