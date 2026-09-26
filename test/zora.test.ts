import { test } from "node:test";
import assert from "node:assert/strict";
import { mktCap } from "../src/zora.ts";

// Zora's own `marketCap` field is 0 for coins whose pool trades against a creator/exotic token, even
// when a USD price exists (measured 2026-09-26: @mowlik's post coins all reported marketCap 0 with a
// live priceInUsdc). mktCap must derive market cap from price × supply so those don't read as "$0".

test("mktCap derives from price × supply (and matches Zora's field when both are set)", () => {
  // $ROOTS 2026-09-26: field 1069835.12 == 0.0010698351… × 1e9
  assert.equal(mktCap({ tokenPrice: { priceInUsdc: "0.0010698351197326106" }, totalSupply: "1000000000", marketCap: "1069835.12" }), 1069835.1197326106);
});

test("mktCap ignores a bogus 0 field when a price exists (the @mowlik case)", () => {
  const mc = mktCap({ tokenPrice: { priceInUsdc: "0.00000010333030736656" }, totalSupply: "1000000000", marketCap: "0" });
  assert.ok(mc !== null && mc > 100 && mc < 110, `expected ~$103, got ${mc}`);
});

test("mktCap falls back to the field when there is no price", () => {
  assert.equal(mktCap({ tokenPrice: null, totalSupply: "1000000000", marketCap: "500" }), 500);
});

test("mktCap returns null when nothing can price the coin (so the report shows —, not a made-up 0)", () => {
  assert.equal(mktCap({ tokenPrice: null, totalSupply: "1000000000", marketCap: "0" }), null);
  assert.equal(mktCap({}), null);
});
