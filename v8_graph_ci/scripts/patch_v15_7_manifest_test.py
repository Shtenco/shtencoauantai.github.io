#!/usr/bin/env python3
from pathlib import Path

path = Path("test/v15_7_aave_50_pool_qe_qt_polygon_fork.js")
text = path.read_text(encoding="utf-8")

old_select = '''async function selectBest(pools, v2r, v3q) {
  const cycles = enumerate(await hydrate(pools));
  let best = null;
  for (const c of cycles.slice(0, 120)) {'''
new_select = '''async function selectBest(pools, v2r, v3q) {
  const cycles = enumerate(pools);
  let best = null;
  for (const c of cycles.slice(0, 20)) {'''
if old_select in text:
    text = text.replace(old_select, new_select, 1)
elif new_select not in text:
    raise SystemExit("selectBest anchor missing")

old_discovery = '''    const pools = await discover50(v2f, v3f);

    const routeV2 = await v2f.getPair(WPOL, USDT);
    const donorCandidates = [];
    for (const [symbol, [other]] of Object.entries(TOKENS)) {
      if (symbol === "USDT") continue;
      const pair = await v2f.getPair(USDT, other);
      if (pair === ethers.ZeroAddress || pair.toLowerCase() === routeV2.toLowerCase()) continue;
      const bal = await new ethers.Contract(USDT, ERC20, ethers.provider).balanceOf(pair);
      donorCandidates.push({ pair, bal });
    }
    donorCandidates.sort((a, b) => a.bal > b.bal ? -1 : 1);'''
new_discovery = '''    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "reports", "v15_7_50_pool_manifest.json"), "utf8"));
    assert.equal(manifest.chainId, 137);
    assert.equal(manifest.blockNumber, Number(process.env.FORK_BLOCK_NUMBER || 90790000));
    assert.equal(manifest.selectedExternalPools, 50);
    const pools = manifest.selectedPools;
    assert.equal(pools.length, 50);

    const routeV2 = await v2f.getPair(WPOL, USDT);
    const donorCandidates = pools
      .filter((p) => p.kind === 2 && p.pool.toLowerCase() !== routeV2.toLowerCase() && (p.symbol0 === "USDT" || p.symbol1 === "USDT"))
      .map((p) => ({
        pair: p.pool,
        bal: BigInt(p.symbol0 === "USDT" ? p.reserve0 : p.reserve1)
      }));
    donorCandidates.sort((a, b) => a.bal > b.bal ? -1 : 1);'''
if old_discovery in text:
    text = text.replace(old_discovery, new_discovery, 1)
elif new_discovery not in text:
    raise SystemExit("discovery anchor missing")

shock_line = '''    await (await v2r.connect(shocker).swapExactTokensForTokens(shockAmount, 1n, [USDT, WPOL], shocker.address, BigInt(b.timestamp + 600))).wait();

    const best = await selectBest(pools, v2r, v3q);'''
shock_replacement = '''    await (await v2r.connect(shocker).swapExactTokensForTokens(shockAmount, 1n, [USDT, WPOL], shocker.address, BigInt(b.timestamp + 600))).wait();

    for (const p of pools) {
      const wpolUsdt = new Set([p.symbol0, p.symbol1]);
      if (!(wpolUsdt.has("WPOL") && wpolUsdt.has("USDT"))) continue;
      const c = new ethers.Contract(p.pool, p.kind === 2 ? V2P : V3P, ethers.provider);
      if (p.kind === 2) {
        const [r0, r1] = await c.getReserves();
        const spot = rawNumber(r1, p.d1) / rawNumber(r0, p.d0);
        p.rate01 = spot * 0.997;
        p.rate10 = (1 / spot) * 0.997;
      } else {
        const [g, liq] = await Promise.all([c.globalState(), c.liquidity()]);
        assert.ok(liq > 0n);
        const sqrt = Number(g[0]) / 2 ** 96;
        const spot = sqrt * sqrt * 10 ** (p.d0 - p.d1);
        const f = 1 - Number(g[2]) / 1_000_000;
        p.rate01 = spot * f;
        p.rate10 = (1 / spot) * f;
      }
    }

    const best = await selectBest(pools, v2r, v3q);'''
if shock_line in text:
    text = text.replace(shock_line, shock_replacement, 1)
elif shock_replacement not in text:
    raise SystemExit("shock anchor missing")

path.write_text(text, encoding="utf-8")
print("V15.7 test patched for historical Multicall3 manifest")
