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

## See it on real history first (`backtest`)

A fresh run never buys posts made before it started, so on day one it does nothing until a creator
posts again. To see what your rules *would* have done, replay them over the last few days against
real Zora data:

```sh
npm run backtest -- --rules rules.json                # last 7 days
npm run backtest -- --rules rules.json --days 30      # a longer window
```

It buys nothing and needs no wallet. It prints every buy it would have made — when, which rule fired
and why, the coin's current market cap (a rough real-coin-vs-throwaway signal) and how many coins that
dollar amount buys at the current Zora quote — plus a per-rule breakdown and the total. It applies the
same daily caps a live run would, so the totals are what a live run would actually spend. Three honest
limits it states in the report:

- **Cost is exact; coin counts are not.** Every buy is a fixed number of dollars in USDC, so the
  spend is precise. The coin counts are *today's* quote, not the price when the post went out.
- **Some coins have no route yet.** A brand-new coin may not have a tradeable swap route, so a live
  buy would fail until liquidity exists. The backtest models this the way a live run behaves: it
  fails such a buy for `$0` and — because a failed buy frees that day's slot — buys the next eligible
  post instead. So every buy it lists is one that would really fill, and the total is real spend, not
  an optimistic count. It reports separately how many matched coins had no route and were skipped.
- **A firehose creator's older posts may be missing.** The profile API returns a bounded number of
  pages, so for a creator who posts constantly the window can't be fully reconstructed. When that
  happens the report marks the creator `INCOMPLETE` and treats its spend as a floor.

### What a real run looks like

A real 7-day backtest against live Zora data (2026-09-26, four active creators, `$25`/day cap).
Handles and coin symbols are replaced with placeholders below; the numbers are unchanged.

```
Coverage
  @creator-a         178 post(s) in window · complete
  @creator-b           8 post(s) in window · complete
  @creator-c           4 post(s) in window · complete
  @creator-d           2 post(s) in window · complete

Buys it would have made (29)
  when (UTC)       rule              bought (why)                $   mkt cap  ~coins (now)          coin
  2026-09-19 14:51 a-posts           post $COIN1                 3   $147     16,135,002 coins      0x…6b12
  2026-09-20 03:06 c-posts           post $COIN2                 4   $114     25,065,802 coins      0x…5248
  2026-09-24 15:16 b-posts           post $COIN3                 4   $106     27,249,355 coins      0x…b3b9
  2026-09-25 12:33 a-posts           post $COIN4                 3   $2       158,125,556 coins     0x…fbb9
  2026-09-26 02:21 d-coin            creator coin ← $COIN0       5   —        698,208 coins         0x…0d56
  … 24 more rows …
  29 buy(s), all buyable now · $98 would have changed hands over the window (~$14/day)
  (6 matched coins had no swap route; a live run would have failed them for $0 and bought the next eligible post — that substitution is already reflected above.)
  Ceiling: your $25/day cap makes $175 the most it could spend over 7 days, however much anyone posts.

Per rule
  a-posts               19 buy(s) · $57     (6 skipped, no route) · post @creator-a (cap 3/day, $3/buy)
  b-posts                5 buy(s) · $20                           · post @creator-b (cap 2/day, $4/buy)
  c-posts                4 buy(s) · $16                           · post @creator-c (cap 2/day, $4/buy)
  d-coin                 1 buy(s) · $5                            · creator-coin @creator-d (cap 1/day, $5/buy)

Skipped 157 matching post(s): a daily cap was reached, or that coin was already bought for the rule.
```

The caps are the story: `@creator-a` posts dozens of times a day, so its `3/day` limit fires three
buys and skips the rest — 157 skipped posts against 29 buys. A prolific creator can't drain the
wallet, and the `$25`/day ceiling means the whole set can't spend more than `$175` in a week no
matter who posts. (Here even that ceiling never binds: the per-rule `maxPerDay` limits keep the week
to `$98`.)

## Can what it buys be sold? (`roundtrip`)

The backtest answers what your rules would *spend*. It does not answer whether the coins they buy
can be *sold* — and for post coins that is the question that decides everything. `roundtrip` settles
it the only way that does: for each coin the rules would buy, it quotes buying `$N` of it, then
immediately quotes selling back every coin that buy returned. What comes back is what the position
is worth the moment you own it, before any price move, before any thesis.

```sh
npm run roundtrip -- --rules rules.json --days 7
```

It signs nothing and needs no wallet — two quotes per coin, same as the backtest. A real 7-day run
against live Zora data, the same four creators as the backtest above (symbols replaced, numbers
unchanged):

```
  coin        mkt cap  in     back    keeps  coin addr     note
  $COIN-A     $228     $3     $2.40   80%    0x…d944
  $COIN-B     $1k      $3     $0.06   2%     0x…2dd8
  $COIN-C     $9k      $3     $0.20   7%     0x…ac37
  $COIN-D     $1.3M    $3     $0.22   7%     0x…c738
  $COIN-E     $105     $4     —       0%     0x…b3b9   CANNOT SELL: SwapError: Failed to get quote
  $COIN-F     $100     $3     —       —      0x…f720   no buy route: SwapError: Failed to create route
  creator coin—        $5     —       0%     0x…0d56   CANNOT SELL: Not enough liquidity available
  … 23 more rows …

  In $86.00 · back $7.37 · keeps 9% on an immediate exit,
  so the round trip costs 91% the moment you buy.
  11 position(s) could not be sold AT ALL — that money is gone, not down.
  12 more lost over half their value on the way out.
  (5 coin(s) could not even be bought; a live run fails those for $0.)

  Read it as a hurdle: a coin has to rise 1066% before the position breaks even.

Per rule
  a-posts               20 coin(s) · in $45  → back $4.42   · keeps  10% · 2 can't sell, 5 no buy route
  b-posts                5 coin(s) · in $20  → back $2.95   · keeps  15% · 4 can't sell
  c-posts                4 coin(s) · in $16  → back $0.00   · keeps   0% · 4 can't sell
  d-coin                 1 coin(s) · in $5   → back $0.00   · keeps   0% · 1 can't sell
```

That is the whole point of running it before you run live. These four creators post constantly, but
their post coins are thin: put `$86` across a week of them and about `$7` is what you could get back
out the same minute — most of it in coins that can't be sold at any size. This isn't a knock on the
tool; it's the tool doing its job. Pick creators whose coins have real two-way liquidity, or the
caps above just meter how fast you lose it.

The **Per rule** roll-up is the line to read before going live. It sets each rule's spend beside what
that spend sells back, so the leak names itself: `c-posts` puts `$16` in and gets `$0` back — every
coin it bought is unsellable — so it is the first rule to cut, whatever its market caps looked like.
`keeps` well under `100%` for a rule is the signal to drop it or change its creator.

## What keeps it from overspending

- It never buys a post made before it first started, so turning it on doesn't buy anyone's back catalogue.
- Each post is judged once, when it's new. A post skipped because a limit was reached isn't bought later.
- It never buys the same coin twice for one rule.
- `maxPerDay` per rule and `maxUsdPerDay` overall are checked before every buy. Failed buys don't count against them.
- In live mode, each buy is written to the state file before it's signed. If the bot stops mid-buy, it
  refuses to start live again until you look up that transaction and mark it `done` or `failed`, so
  an unknown outcome can't turn into a second buy.
- Buys are paid in USDC, so a rule's dollar amount is exact.

The wallet needs USDC on Base for the buys and a little ETH on Base for gas. The first live buy
also sends a one-time approval letting Uniswap's Permit2 move your USDC; after that each buy is one
signed permit and one transaction, simulated before it's sent.

Use a wallet that holds only what you're willing to spend. The key stays in your environment, and
nothing else is sent anywhere except the trade itself (through Zora's trade API and Base).

## How it works

Every interval it asks Zora for each creator's latest posts (each post is a coin), keeps the ones it
hasn't seen, and plans buys within your limits (`src/plan.ts`, tested in `test/plan.test.ts`). A dry
run gets a quote from Zora for each planned buy. A live run buys with the Zora coins SDK's
`tradeCoin`, selling USDC for the coin, and logs the Basescan link.

The live path uses the SDK's `tradeCoin`, which gets a fresh quote, signs the permit, sends any
approval it needs, simulates the trade and then sends it. Try it with a small `maxUsdPerDay` first.

## Not financial advice

Creator and post coins are volatile and often illiquid; a coin bought seconds after a post can fall
as fast as it rose. The backtest's `mkt cap` column hints at this — many post coins are sub-$1,000
microcaps — and the `roundtrip` command above measures it exactly: for the example rules, an
immediate exit returns about 9 cents on the dollar. You're responsible for your rules and your wallet.

MIT licensed.
