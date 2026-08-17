const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ethers, network } = require("hardhat");

const WPOL = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const USDT = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";
const AAVE_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const V2_FACTORY = "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32";
const V2_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const V3_FACTORY = "0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28";
const V3_QUOTER = "0xa15F0D7377B2A0C0c10db057f641beD21028FC89";
const V3_ROUTER = "0xf5b509bB0909a69B1c207E495f687a596C168E12";
const GAS_PRICE = 274_000_000_000n;
const FLASH = ethers.parseEther("100");
const E = ethers.parseEther;
const U = (v) => ethers.parseUnits(v, 6);
const id = (v) => ethers.keccak256(ethers.toUtf8Bytes(v));

const TOKENS = {
  WPOL: [WPOL, 18], USDT: [USDT, 6],
  USDC: ["0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", 6],
  DAI: ["0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", 18],
  WETH: ["0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", 18],
  WBTC: ["0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", 8],
  LINK: ["0x53E0bca35eC356BD5ddDFebBD1Fc0fD03FaBad39", 18],
  AAVE: ["0xD6DF932A45C0f255f85145f286eA0B292B21C90B", 18],
  CRV: ["0x172370d5Cd63279eFa6d502DAB29171933a610AF", 18],
  GHST: ["0x385Eeac5cB85A38A9a07A70c73e0A3271CfB54A7", 18],
  SUSHI: ["0x0b3F868E0BE5597D5DB7fEB59E1CADBb0fdDa50a", 18],
  UNI: ["0xb33EaAd8d922B1083446DC23f610c2567fB5180f", 18],
  BAL: ["0x9a71012B13CA4d3D0Cdc72A177DF3ef03b0E76A3", 18],
  GRT: ["0x5fe2B58c013d7601147DcdD68C143A77499f5531", 18]
};
const SYMBOL = Object.fromEntries(Object.entries(TOKENS).map(([s, [a]]) => [a.toLowerCase(), s]));

const ERC20 = [
  "function balanceOf(address) view returns(uint256)",
  "function transfer(address,uint256) returns(bool)",
  "function approve(address,uint256) returns(bool)",
  "function deposit() payable"
];
const V2F = ["function getPair(address,address) view returns(address)"];
const V3F = ["function poolByPair(address,address) view returns(address)"];
const V2P = ["function token0() view returns(address)", "function token1() view returns(address)", "function getReserves() view returns(uint112,uint112,uint32)"];
const V3P = ["function token0() view returns(address)", "function token1() view returns(address)", "function globalState() view returns(uint160,int24,uint16,uint16,uint8,uint8,bool)", "function liquidity() view returns(uint128)"];
const V2R = [
  "function getAmountsOut(uint256,address[]) view returns(uint256[])",
  "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns(uint256[])"
];
const V3Q = ["function quoteExactInputSingle(address,address,uint256,uint160) returns(uint256,uint16)"];
const AAVE = ["function getReservesList() view returns(address[])", "function FLASHLOAN_PREMIUM_TOTAL() view returns(uint128)", "function ADDRESSES_PROVIDER() view returns(address)"];
const PAIR = ["function token0() view returns(address)", "function token1() view returns(address)", "function getReserves() view returns(uint112,uint112,uint32)"];

function rawNumber(x, d) { return Number(ethers.formatUnits(x, d)); }
function cpOut(x, rin, rout) { const y = x * 9970n; return y * rout / (rin * 10000n + y); }
function cpIn(out, rin, rout) { return rin * out * 10000n / ((rout - out) * 9970n) + 1n; }

async function impersonatedTransfer(token, donor, recipient, amount) {
  await network.provider.send("anvil_impersonateAccount", [donor]);
  await network.provider.send("anvil_setBalance", [donor, ethers.toBeHex(E("100"))]);
  const direct = new ethers.JsonRpcProvider(process.env.LOCAL_FORK_URL || "http://127.0.0.1:8545");
  const signer = await direct.getSigner(donor);
  await (await new ethers.Contract(token, ERC20, signer).transfer(recipient, amount)).wait();
  await network.provider.send("anvil_stopImpersonatingAccount", [donor]);
}

async function eligible(registry, admin, account, label) {
  const b = await ethers.provider.getBlock("latest");
  await (await registry.connect(admin).setParticipant(account, true, BigInt(b.timestamp + 86400), id(label))).wait();
}

async function discover50(v2f, v3f) {
  const symbols = Object.keys(TOKENS);
  const found = [];
  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      const [sa, sb] = [symbols[i], symbols[j]];
      const [a, b] = [TOKENS[sa][0], TOKENS[sb][0]];
      const [p2, p3] = await Promise.all([v2f.getPair(a, b), v3f.poolByPair(a, b)]);
      for (const [kind, pool] of [[2, p2], [3, p3]]) {
        if (pool === ethers.ZeroAddress || await ethers.provider.getCode(pool) === "0x") continue;
        try {
          const c = new ethers.Contract(pool, kind === 2 ? V2P : V3P, ethers.provider);
          const [t0, t1] = await Promise.all([c.token0(), c.token1()]);
          const s0 = SYMBOL[t0.toLowerCase()], s1 = SYMBOL[t1.toLowerCase()];
          if (!s0 || !s1) continue;
          const [b0, b1] = await Promise.all([
            new ethers.Contract(t0, ERC20, ethers.provider).balanceOf(pool),
            new ethers.Contract(t1, ERC20, ethers.provider).balanceOf(pool)
          ]);
          if (b0 === 0n || b1 === 0n) continue;
          found.push({ kind, pool: ethers.getAddress(pool), token0: t0, token1: t1, symbol0: s0, symbol1: s1, d0: TOKENS[s0][1], d1: TOKENS[s1][1] });
        } catch (_) {}
      }
    }
  }
  const unique = [...new Map(found.map((p) => [`${p.kind}:${p.pool.toLowerCase()}`, p])).values()];
  const route2 = (await v2f.getPair(WPOL, USDT)).toLowerCase();
  const route3 = (await v3f.poolByPair(WPOL, USDT)).toLowerCase();
  unique.sort((a, b) => {
    const ar = a.pool.toLowerCase() === route2 || a.pool.toLowerCase() === route3 ? 0 : 1;
    const br = b.pool.toLowerCase() === route2 || b.pool.toLowerCase() === route3 ? 0 : 1;
    return ar - br || a.pool.localeCompare(b.pool) || a.kind - b.kind;
  });
  assert.ok(unique.length >= 50, `only ${unique.length} real pools discovered`);
  const selected = unique.slice(0, 50);
  assert.equal(new Set(selected.map((p) => `${p.kind}:${p.pool.toLowerCase()}`)).size, 50);
  assert.ok(selected.some((p) => p.kind === 2 && p.pool.toLowerCase() === route2));
  assert.ok(selected.some((p) => p.kind === 3 && p.pool.toLowerCase() === route3));
  return selected;
}

async function hydrate(pools) {
  const out = [];
  for (const p of pools) {
    const c = new ethers.Contract(p.pool, p.kind === 2 ? V2P : V3P, ethers.provider);
    if (p.kind === 2) {
      const [r0, r1] = await c.getReserves();
      const spot = rawNumber(r1, p.d1) / rawNumber(r0, p.d0);
      out.push({ ...p, rate01: spot * 0.997, rate10: (1 / spot) * 0.997 });
    } else {
      const [g, liq] = await Promise.all([c.globalState(), c.liquidity()]);
      if (liq === 0n) continue;
      const sqrt = Number(g[0]) / 2 ** 96;
      const spot = sqrt * sqrt * 10 ** (p.d0 - p.d1);
      const f = 1 - Number(g[2]) / 1_000_000;
      out.push({ ...p, rate01: spot * f, rate10: (1 / spot) * f });
    }
  }
  return out;
}

function enumerate(pools) {
  const edges = [];
  for (const p of pools) {
    edges.push({ pool: p, from: p.token0, to: p.token1, rate: p.rate01 });
    edges.push({ pool: p, from: p.token1, to: p.token0, rate: p.rate10 });
  }
  const adj = new Map();
  for (const e of edges) { const k = e.from.toLowerCase(); if (!adj.has(k)) adj.set(k, []); adj.get(k).push(e); }
  const cycles = [];
  function dfs(token, route, usedTokens, usedPools, rate) {
    if (route.length >= 2 && token.toLowerCase() === WPOL.toLowerCase()) { cycles.push({ route: [...route], rate }); return; }
    if (route.length >= 4) return;
    for (const e of adj.get(token.toLowerCase()) || []) {
      const pk = `${e.pool.kind}:${e.pool.pool.toLowerCase()}`;
      if (usedPools.has(pk)) continue;
      const end = e.to.toLowerCase() === WPOL.toLowerCase();
      if (!end && usedTokens.has(e.to.toLowerCase())) continue;
      dfs(e.to, [...route, e], new Set([...usedTokens, e.to.toLowerCase()]), new Set([...usedPools, pk]), rate * e.rate);
    }
  }
  dfs(WPOL, [], new Set([WPOL.toLowerCase()]), new Set(), 1);
  return cycles.sort((a, b) => b.rate - a.rate);
}

async function exactQuote(route, amount, v2r, v3q) {
  let x = amount;
  const legs = [];
  for (const e of route) {
    try {
      let y;
      if (e.pool.kind === 2) y = (await v2r.getAmountsOut(x, [e.from, e.to]))[1];
      else y = (await v3q.quoteExactInputSingle.staticCall(e.from, e.to, x, 0))[0];
      if (y <= 0n) return null;
      legs.push({ venue: e.pool.kind, pool: e.pool.pool, tokenIn: e.from, tokenOut: e.to, minOut: y * 995n / 1000n, quotedOut: y });
      x = y;
    } catch (_) { return null; }
  }
  return { output: x, legs };
}

async function selectBest(pools, v2r, v3q) {
  const cycles = enumerate(await hydrate(pools));
  let best = null;
  for (const c of cycles.slice(0, 120)) {
    const q = await exactQuote(c.route, FLASH, v2r, v3q);
    if (q && (!best || q.output > best.output)) best = { ...q, approxRate: c.rate };
  }
  assert.ok(best, "no exact route from the 50-pool graph");
  return { ...best, cycleCount: cycles.length };
}

async function pairState(pair, syn) {
  const [t0, [r0, r1]] = await Promise.all([pair.token0(), pair.getReserves()]);
  const sr = t0.toLowerCase() === syn.toLowerCase() ? r0 : r1;
  const wr = t0.toLowerCase() === syn.toLowerCase() ? r1 : r0;
  return { sr, wr, k: sr * wr };
}

describe("V15.7 real Aave + selected 50-pool graph + QE/QT", function () {
  this.timeout(1_800_000);

  it("borrows 100 real WPOL, executes the selected route and closes QE/QT profitably", async function () {
    const [admin, treasury, shocker] = await ethers.getSigners();
    for (const a of [WPOL, USDT, AAVE_POOL, V2_FACTORY, V2_ROUTER, V3_FACTORY, V3_QUOTER, V3_ROUTER]) {
      assert.notEqual(await ethers.provider.getCode(a), "0x", `missing code ${a}`);
    }

    const aave = new ethers.Contract(AAVE_POOL, AAVE, admin);
    const reserves = (await aave.getReservesList()).map((a) => a.toLowerCase());
    assert.ok(reserves.includes(WPOL.toLowerCase()), "Aave WPOL reserve missing");
    assert.notEqual(await aave.ADDRESSES_PROVIDER(), ethers.ZeroAddress);
    const premiumBps = await aave.FLASHLOAN_PREMIUM_TOTAL();
    assert.ok(premiumBps > 0n);

    const v2f = new ethers.Contract(V2_FACTORY, V2F, admin);
    const v3f = new ethers.Contract(V3_FACTORY, V3F, admin);
    const v2r = new ethers.Contract(V2_ROUTER, V2R, admin);
    const v3q = new ethers.Contract(V3_QUOTER, V3Q, admin);
    const pools = await discover50(v2f, v3f);

    const routeV2 = await v2f.getPair(WPOL, USDT);
    const donorCandidates = [];
    for (const [symbol, [other]] of Object.entries(TOKENS)) {
      if (symbol === "USDT") continue;
      const pair = await v2f.getPair(USDT, other);
      if (pair === ethers.ZeroAddress || pair.toLowerCase() === routeV2.toLowerCase()) continue;
      const bal = await new ethers.Contract(USDT, ERC20, ethers.provider).balanceOf(pair);
      donorCandidates.push({ pair, bal });
    }
    donorCandidates.sort((a, b) => a.bal > b.bal ? -1 : 1);
    assert.ok(donorCandidates[0].bal >= U("10000"));
    const shockAmount = donorCandidates[0].bal / 10n > U("15000") ? U("15000") : donorCandidates[0].bal / 10n;
    await impersonatedTransfer(USDT, donorCandidates[0].pair, shocker.address, shockAmount);
    const usdtShocker = new ethers.Contract(USDT, ERC20, shocker);
    await (await usdtShocker.approve(V2_ROUTER, shockAmount)).wait();
    const b = await ethers.provider.getBlock("latest");
    await (await v2r.connect(shocker).swapExactTokensForTokens(shockAmount, 1n, [USDT, WPOL], shocker.address, BigInt(b.timestamp + 600))).wait();

    const best = await selectBest(pools, v2r, v3q);
    assert.ok(best.output > FLASH, "selected graph route is not gross profitable");
    const selectedKeys = new Set(pools.map((p) => `${p.kind}:${p.pool.toLowerCase()}`));
    for (const leg of best.legs) assert.ok(selectedKeys.has(`${leg.venue}:${leg.pool.toLowerCase()}`));
    assert.ok(best.legs.length >= 2 && best.legs.length <= 4);

    const Registry = await ethers.getContractFactory("ParticipantTaxRegistry", admin);
    const registry = await Registry.deploy(admin.address); await registry.waitForDeployment();
    await eligible(registry, admin, admin.address, "v157-admin");
    await eligible(registry, admin, treasury.address, "v157-treasury");
    const Factory = await ethers.getContractFactory("SynergyDexFactoryV5", admin);
    const factory = await Factory.deploy(await registry.getAddress()); await factory.waitForDeployment();
    const Router = await ethers.getContractFactory("SynergyDexRouterV5", admin);
    const router = await Router.deploy(await registry.getAddress(), await factory.getAddress()); await router.waitForDeployment();
    await (await factory.setRouter(await router.getAddress(), true)).wait();
    const Token = await ethers.getContractFactory("TemporaryQETokenV11", admin);
    const syn = await Token.deploy(); await syn.waitForDeployment();
    const SYN = await syn.getAddress();
    await (await factory.createPair(SYN, WPOL)).wait();
    const pairAddress = await factory.getPair(SYN, WPOL);
    const pair = new ethers.Contract(pairAddress, PAIR, admin);

    const wpol = new ethers.Contract(WPOL, ERC20, admin);
    await (await wpol.deposit({ value: E("500") })).wait();
    await (await syn.mintBootstrap(admin.address, U("5000"))).wait();
    await (await syn.approve(await router.getAddress(), ethers.MaxUint256)).wait();
    await (await wpol.approve(await router.getAddress(), ethers.MaxUint256)).wait();
    const now = await ethers.provider.getBlock("latest");
    await (await router.addLiquidity(SYN, WPOL, U("5000"), E("500"), admin.address, BigInt(now.timestamp + 3600))).wait();

    const Receiver = await ethers.getContractFactory("AaveFiftyPoolQeQtV157", admin);
    const receiver = await Receiver.deploy(AAVE_POOL, WPOL, SYN, await router.getAddress(), pairAddress, V2_ROUTER, V3_ROUTER, V2_FACTORY, V3_FACTORY, admin.address, treasury.address);
    await receiver.waitForDeployment();
    await eligible(registry, admin, await receiver.getAddress(), "v157-receiver");
    await (await syn.setController(await receiver.getAddress())).wait();
    assert.equal(await wpol.balanceOf(await receiver.getAddress()), 0n);

    const qeMint = U("1");
    const beforePair = await pairState(pair, SYN);
    const extracted = cpOut(qeMint, beforePair.sr, beforePair.wr);
    const buyback = cpIn(qeMint, beforePair.wr - extracted, beforePair.sr + qeMint);
    const expectedPremium = FLASH * premiumBps / 10000n;
    const theoretical = best.output - FLASH + extracted - buyback - expectedPremium;
    assert.ok(theoretical > E("0.05"), `insufficient theoretical net ${ethers.formatEther(theoretical)}`);

    const latest = await ethers.provider.getBlock("latest");
    const plan = {
      sourceId: id("v15.7-real-aave-50-pool-cycle"), nonce: 1n,
      deadline: BigInt(latest.timestamp + 600), flashAmountWpol: FLASH,
      qeMint, minExtractedWpol: extracted * 995n / 1000n, routeAmountWpol: FLASH,
      legs: best.legs.map(({ quotedOut, ...leg }) => leg),
      maxPremiumWpol: expectedPremium + 1n,
      minProfitWpol: theoretical * 80n / 100n
    };

    await receiver.run.staticCall(plan, { gasPrice: GAS_PRICE, gasLimit: 16_000_000 });
    const treasuryBefore = await wpol.balanceOf(treasury.address);
    const tx = await receiver.run(plan, { gasPrice: GAS_PRICE, gasLimit: 16_000_000 });
    const receipt = await tx.wait();
    const treasuryAfter = await wpol.balanceOf(treasury.address);
    const afterPair = await pairState(pair, SYN);
    const gas = receipt.gasUsed * receipt.gasPrice;
    const profit = treasuryAfter - treasuryBefore;

    assert.equal(await receiver.completedCycles(), 1n);
    assert.equal(await receiver.lastFlashAmountWpol(), FLASH);
    assert.equal(await receiver.lastPremiumWpol(), expectedPremium);
    assert.equal(await receiver.temporaryOutstanding(), 0n);
    assert.equal(await syn.totalSupply(), U("5000"));
    assert.equal(await wpol.balanceOf(await receiver.getAddress()), 0n);
    assert.ok(afterPair.wr >= beforePair.wr && afterPair.k >= beforePair.k);
    assert.ok(profit > gas, `profit ${ethers.formatEther(profit)} <= gas ${ethers.formatEther(gas)}`);

    const report = {
      scenario: "v15_7_real_aave_50_pool_dynamic_qe_qt",
      verdict: "PASS",
      forkBlock: Number(process.env.FORK_BLOCK_NUMBER || 90790000),
      externalPoolsDiscoveredAndSelected: 50,
      graphCyclesEnumerated: best.cycleCount,
      selectedRouteHops: best.legs.length,
      selectedRoute: best.legs.map((l) => ({ venue: l.venue === 2 ? "QuickSwapV2" : "QuickSwapV3", pool: l.pool, tokenIn: l.tokenIn, tokenOut: l.tokenOut })),
      independentShockUsdt: rawNumber(shockAmount, 6),
      realAavePool: AAVE_POOL,
      flashAsset: WPOL,
      flashPrincipalWpol: Number(ethers.formatEther(FLASH)),
      actualAavePremiumWpol: Number(ethers.formatEther(await receiver.lastPremiumWpol())),
      qeMintSyn: rawNumber(qeMint, 6),
      extractedInternalWpol: Number(ethers.formatEther(await receiver.lastExtractedWpol())),
      routeOutputWpol: Number(ethers.formatEther(await receiver.lastRouteOutputWpol())),
      exactBuybackWpol: Number(ethers.formatEther(await receiver.lastBuybackWpol())),
      realizedProfitWpol: Number(ethers.formatEther(profit)),
      measuredGasPolAt274Gwei: Number(ethers.formatEther(gas)),
      netAfterMeasuredGasWpol: Number(ethers.formatEther(profit - gas)),
      temporarySupplyClosed: true,
      syntheticSupplyRestored: true,
      internalKNonDecreasing: afterPair.k >= beforePair.k,
      receiverHadZeroPrefunding: true,
      fullFlashPrincipalRouted: true
    };
    fs.mkdirSync(path.join(process.cwd(), "reports"), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), "reports", "v15_7_real_aave_50_pool_qe_qt.json"), JSON.stringify(report, null, 2));
    console.log(`V157_RESULT ${JSON.stringify(report)}`);
  });
});
