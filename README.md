# zora-autobuy

A small open-source bot that buys Zora coins by rules you write. When a creator you follow posts
on Zora, it buys a set dollar amount of the new post's coin, or of the creator's own creator coin.
It runs on your machine with your wallet. There is no service, account or fee.

**It starts in dry run.** Without `--live` it never signs anything: it says what it would buy and
asks Zora for a live quote, so you can watch your rules work before any money moves.

## Rules

```json
{
  "maxUsdPerDay": 30,
  "slippage": 0.05,
  "rules": [
    { "name": "jesse-posts", "creator": "jessepollak", "buy": "post", "usd": 5, "maxPerDay": 3 },
    { "name": "basecompany-coin", "creator": "basecompany", "buy": "creator-coin", "usd": 10, "maxPerDay": 1 }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `maxUsdPerDay` | Required. The most the bot spends in a UTC day across every rule. |
| `slippage` | How much worse than the quote a buy may fill, 0.05 = 5% (at most 20%). Default 5%. |
| `rules[].creator` | The Zora handle whose new posts trigger the rule. |
| `rules[].buy` | `"post"`: the new post's coin. `"creator-coin"`: the creator's coin. |
| `rules[].usd` | Dollars per buy, paid in USDC on Base. |
| `rules[].maxPerDay` | The most buys this rule makes in a UTC day. |

## Run it

Node 20 or newer.

```sh
npm install
cp rules.example.json rules.json      # then edit it
npx tsx src/cli.ts --rules rules.json               # dry run, checks every 60 seconds
npx tsx src/cli.ts --rules rules.json --once        # one check, then exit
PRIVATE_KEY=0x… npx tsx src/cli.ts --rules rules.json --live   # buys for real
```

Options: `--interval <seconds>` (at least 15), `--state <file>` (default `state/state.json`).
Environment: `PRIVATE_KEY` (live only), `BASE_RPC_URL` (defaults to Base's public RPC),
`ZORA_API_KEY` (optional, raises Zora's rate limits).

## What keeps it from overspending

- It never buys a post made before it first started, so turning it on doesn't buy anyone's back catalogue.
- Each post is judged once, when it's new. A post skipped because a limit was reached isn't bought later.
- It never buys the same coin twice for one rule.
- `maxPerDay` per rule and `maxUsdPerDay` overall are checked before every buy. Failed buys don't count against them.
- In live mode, each buy is written to the state file before it's signed. If the bot stops mid-buy, it
  refuses to start live again until you look up that transaction and mark it `done` or `failed`, so
  an unknown outcome can't turn into a second buy.
- Buys are paid in USDC, so a rule's dollar amount is exact.

Use a wallet that holds only what you're willing to spend. The key stays in your environment, and
nothing else is sent anywhere except the trade itself (through Zora's trade API and Base).

## How it works

Every interval it asks Zora for each creator's latest posts (each post is a coin), keeps the ones it
hasn't seen, and plans buys within your limits (`src/plan.ts`, tested in `test/plan.test.ts`). A dry
run gets a quote from Zora for each planned buy. A live run buys with the Zora coins SDK's
`tradeCoin`, selling USDC for the coin, and logs the Basescan link.

The live path follows the SDK's documented trade call. Try it with a small `maxUsdPerDay` first.

## Not financial advice

Creator and post coins are volatile and often illiquid; a coin bought seconds after a post can fall
as fast as it rose. You're responsible for your rules and your wallet.

MIT licensed.
