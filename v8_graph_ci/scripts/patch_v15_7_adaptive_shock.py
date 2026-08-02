#!/usr/bin/env python3
from pathlib import Path

path = Path("test/v15_7_aave_50_pool_qe_qt_polygon_fork.js")
text = path.read_text(encoding="utf-8")

old = '''    donorCandidates.sort((a, b) => a.bal > b.bal ? -1 : 1);
    assert.ok(donorCandidates[0].bal >= U("10000"));
    const shockAmount = donorCandidates[0].bal / 10n > U("15000") ? U("15000") : donorCandidates[0].bal / 10n;
    await impersonatedTransfer(USDT, donorCandidates[0].pair, shocker.address, shockAmount);
    const usdtShocker = new ethers.Contract(USDT, ERC20, shocker);'''
new = '''    donorCandidates.sort((a, b) => a.bal > b.bal ? -1 : 1);
    const routePoolMeta = pools.find((p) => p.kind === 2 && p.pool.toLowerCase() === routeV2.toLowerCase());
    assert.ok(routePoolMeta, "route V2 pool missing from 50-pool manifest");
    const routeUsdtReserve = BigInt(routePoolMeta.symbol0 === "USDT" ? routePoolMeta.reserve0 : routePoolMeta.reserve1);
    const shockAmount = routeUsdtReserve / 20n;
    assert.ok(shockAmount >= U("10000"), "adaptive shock too small");
    let remainingShock = shockAmount;
    for (const donor of donorCandidates) {
      if (remainingShock === 0n) break;
      const safeAvailable = donor.bal / 4n;
      if (safeAvailable === 0n) continue;
      const take = safeAvailable < remainingShock ? safeAvailable : remainingShock;
      await impersonatedTransfer(USDT, donor.pair, shocker.address, take);
      remainingShock -= take;
    }
    assert.equal(remainingShock, 0n, "insufficient independent USDT donor liquidity");
    const usdtShocker = new ethers.Contract(USDT, ERC20, shocker);'''
if old in text:
    text = text.replace(old, new, 1)
elif new not in text:
    raise SystemExit("adaptive shock anchor missing")

old_select = '''  let best = null;
  for (const c of cycles.slice(0, 20)) {
    const q = await exactQuote(c.route, FLASH, v2r, v3q);'''
new_select = '''  let best = null;
  const prioritized = [];
  const seen = new Set();
  for (const c of [...cycles.filter((x) => x.route.length === 2), ...cycles]) {
    const key = c.route.map((e) => `${e.pool.kind}:${e.pool.pool.toLowerCase()}`).join(">");
    if (seen.has(key)) continue;
    seen.add(key);
    prioritized.push(c);
    if (prioritized.length >= 40) break;
  }
  for (const c of prioritized) {
    const q = await exactQuote(c.route, FLASH, v2r, v3q);'''
if old_select in text:
    text = text.replace(old_select, new_select, 1)
elif new_select not in text:
    raise SystemExit("prioritized select anchor missing")

assert_line = '''    assert.ok(best.output > FLASH, "selected graph route is not gross profitable");'''
assert_replacement = '''    console.log(`V157_SELECTED_ROUTE quotedOut=${ethers.formatEther(best.output)} hops=${best.legs.length} cycles=${best.cycleCount}`);
    assert.ok(best.output > FLASH, "selected graph route is not gross profitable");'''
if assert_line in text:
    text = text.replace(assert_line, assert_replacement, 1)
elif assert_replacement not in text:
    raise SystemExit("selected route assertion anchor missing")

path.write_text(text, encoding="utf-8")
print("V15.7 adaptive liquidity shock enabled")
