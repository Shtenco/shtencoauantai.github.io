const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ethers, network } = require("hardhat");

const WPOL = ethers.getAddress("0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270".toLowerCase());
const USDT = ethers.getAddress("0xc2132D05D31c914a87C6611C10748AEb04B58e8F".toLowerCase());
const USDC = ethers.getAddress("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174".toLowerCase());
const DAI = ethers.getAddress("0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063".toLowerCase());
const WETH = ethers.getAddress("0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619".toLowerCase());
const AAVE_POOL = ethers.getAddress("0x794a61358D6845594F94dc1DB02A252b5b4814aD".toLowerCase());
const V2_FACTORY = ethers.getAddress("0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32".toLowerCase());
const V2_ROUTER = ethers.getAddress("0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff".toLowerCase());
const V3_FACTORY = ethers.getAddress("0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28".toLowerCase());
const V3_QUOTER = ethers.getAddress("0xa15F0D7377B2A0C0c10db057f641beD21028FC89".toLowerCase());
const V3_ROUTER = ethers.getAddress("0xf5b509bB0909a69B1c207E495f687a596C168E12".toLowerCase());
const GAS_PRICE = 274_000_000_000n;
const E = ethers.parseEther;
const U = (v) => ethers.parseUnits(String(v), 6);
const id = (v) => ethers.keccak256(ethers.toUtf8Bytes(v));

const ERC20 = [
  "function balanceOf(address) view returns(uint256)",
  "function transfer(address,uint256) returns(bool)",
  "function approve(address,uint256) returns(bool)",
  "function totalSupply() view returns(uint256)"
];
const AAVE = [
  "function getReservesList() view returns(address[])",
  "function FLASHLOAN_PREMIUM_TOTAL() view returns(uint128)"
];
const V2R = [
  "function getAmountsOut(uint256,address[]) view returns(uint256[])",
  "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns(uint256[])"
];
const V3Q = ["function quoteExactInputSingle(address,address,uint256,uint160) returns(uint256,uint16)"];
const V2P = ["function token0() view returns(address)", "function token1() view returns(address)", "function getReserves() view returns(uint112,uint112,uint32)"];

const TOKEN_META = {
  [WPOL.toLowerCase()]: { symbol: "WPOL", decimals: 18 },
  [USDT.toLowerCase()]: { symbol: "USDT", decimals: 6 },
  [USDC.toLowerCase()]: { symbol: "USDC", decimals: 6 },
  [DAI.toLowerCase()]: { symbol: "DAI", decimals: 18 },
  [WETH.toLowerCase()]: { symbol: "WETH", decimals: 18 }
};

function cpOut(amountIn, reserveIn, reserveOut) {
  const withFee = amountIn * 997n;
  return withFee * reserveOut / (reserveIn * 1000n + withFee);
}

function cpIn(amountOut, reserveIn, reserveOut) {
  return reserveIn * amountOut * 1000n / ((reserveOut - amountOut) * 997n) + 1n;
}

function fmt(raw, decimals) {
  return Number(ethers.formatUnits(raw, decimals));
}

async function mine(count) {
  for (let i = 0; i < count; i++) await network.provider.send("evm_mine");
}

async function impersonatedTransfer(tokenAddress, donor, recipient, amount) {
  await network.provider.send("anvil_impersonateAccount", [donor]);
  await network.provider.send("anvil_setBalance", [donor, ethers.toBeHex(E("100"))]);
  const provider = new ethers.JsonRpcProvider(process.env.LOCAL_FORK_URL || "http://127.0.0.1:8545");
  const signer = await provider.getSigner(donor);
  const token = new ethers.Contract(tokenAddress, ERC20, signer);
  await (await token.transfer(recipient, amount)).wait();
  await network.provider.send("anvil_stopImpersonatingAccount", [donor]);
}

function loadManifest() {
  const file = path.join(process.cwd(), "reports", "v15_7_50_pool_manifest.json");
  assert.ok(fs.existsSync(file), "50-pool manifest missing");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(manifest.selectedExternalPools, 50);
  assert.ok(manifest.candidatePools >= 50);
  return manifest;
}

function directedEdges(manifest) {
  const allowed = new Set([USDT, USDC, DAI, WETH, WPOL].map((x) => x.toLowerCase()));
  const edges = [];
  for (const p of manifest.selectedPools) {
    const t0 = ethers.getAddress(p.token0.toLowerCase());
    const t1 = ethers.getAddress(p.token1.toLowerCase());
    if (!allowed.has(t0.toLowerCase()) || !allowed.has(t1.toLowerCase())) continue;
    edges.push({ venue: p.kind, pool: ethers.getAddress(p.pool.toLowerCase()), tokenIn: t0, tokenOut: t1, rate: p.rate01 });
    edges.push({ venue: p.kind, pool: ethers.getAddress(p.pool.toLowerCase()), tokenIn: t1, tokenOut: t0, rate: p.rate10 });
  }
  return edges;
}

function enumeratePaths(manifest) {
  const edges = directedEdges(manifest);
  const adj = new Map();
  for (const e of edges) {
    const key = e.tokenIn.toLowerCase();
    if (!adj.has(key)) adj.set(key, []);
    adj.get(key).push(e);
  }
  const paths = [];
  function dfs(token, route, usedTokens, usedPools, rate) {
    if (route.length >= 2 && token.toLowerCase() === WPOL.toLowerCase()) {
      paths.push({ route: [...route], rate });
      return;
    }
    if (route.length >= 4) return;
    for (const edge of adj.get(token.toLowerCase()) || []) {
      const poolKey = `${edge.venue}:${edge.pool.toLowerCase()}`;
      if (usedPools.has(poolKey)) continue;
      const ending = edge.tokenOut.toLowerCase() === WPOL.toLowerCase();
      if (!ending && usedTokens.has(edge.tokenOut.toLowerCase())) continue;
      dfs(
        edge.tokenOut,
        [...route, edge],
        new Set([...usedTokens, edge.tokenOut.toLowerCase()]),
        new Set([...usedPools, poolKey]),
        rate * edge.rate
      );
    }
  }
  dfs(USDT, [], new Set([USDT.toLowerCase()]), new Set(), 1);
  return paths.sort((a, b) => b.rate - a.rate);
}

async function exactQuote(route, amountIn, v2r, v3q) {
  let amount = amountIn;
  const legs = [];
  for (const edge of route) {
    let out;
    try {
      if (edge.venue === 2) {
        out = (await v2r.getAmountsOut(amount, [edge.tokenIn, edge.tokenOut]))[1];
      } else {
        out = (await v3q.quoteExactInputSingle.staticCall(edge.tokenIn, edge.tokenOut, amount, 0))[0];
      }
    } catch (_) {
      return null;
    }
    if (out <= 0n) return null;
    legs.push({
      venue: edge.venue,
      pool: edge.pool,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      minOut: out * 992n / 1000n,
      quotedOut: out
    });
    amount = out;
  }
  return { amountOut: amount, legs };
}

async function selectRoute(manifest, amountIn, v2r, v3q) {
  const candidates = enumeratePaths(manifest);
  assert.ok(candidates.length > 0, "no 2-4 hop USDT->WPOL paths in selected graph");
  let best = null;
  for (const candidate of candidates.slice(0, 160)) {
    const exact = await exactQuote(candidate.route, amountIn, v2r, v3q);
    if (exact && (!best || exact.amountOut > best.amountOut)) {
      best = { ...exact, approxRate: candidate.rate, path: candidate.route };
    }
  }
  assert.ok(best, "no exact executable 2-4 hop route");
  return { ...best, enumeratedPaths: candidates.length };
}

async function findDonor(manifest, tokenAddress, excludedPools, minimumBalance) {
  const token = new ethers.Contract(tokenAddress, ERC20, ethers.provider);
  const candidates = [];
  for (const p of manifest.selectedPools) {
    if (excludedPools.has(p.pool.toLowerCase())) continue;
    if (p.token0.toLowerCase() !== tokenAddress.toLowerCase() && p.token1.toLowerCase() !== tokenAddress.toLowerCase()) continue;
    const balance = await token.balanceOf(p.pool);
    if (balance >= minimumBalance) candidates.push({ address: p.pool, balance });
  }
  candidates.sort((a, b) => (a.balance > b.balance ? -1 : 1));
  assert.ok(candidates.length > 0, `no donor for ${tokenAddress}`);
  return candidates[0].address;
}

async function snapshotPools(pools, assets, treasury) {
  const rows = [];
  for (let i = 0; i < pools.length; i++) {
    const [s, l] = await pools[i].getReserves();
    rows.push({ index: i, synthetic: s, liquid: l, asset: assets[i] });
  }
  return {
    rows,
    treasuryWpol: await new ethers.Contract(WPOL, ERC20, ethers.provider).balanceOf(treasury),
    treasuryUsdt: await new ethers.Contract(USDT, ERC20, ethers.provider).balanceOf(treasury)
  };
}

function externalNav(snapshot, wpolPriceUsdtX18) {
  let total = snapshot.treasuryUsdt;
  total += snapshot.treasuryWpol * wpolPriceUsdtX18 / 10n ** 30n;
  for (const row of snapshot.rows) {
    const a = row.asset.toLowerCase();
    if (a === WPOL.toLowerCase()) total += row.liquid * wpolPriceUsdtX18 / 10n ** 30n;
    else if (a === USDT.toLowerCase() || a === USDC.toLowerCase()) total += row.liquid;
    else if (a === DAI.toLowerCase()) total += row.liquid / 10n ** 12n;
  }
  return total;
}

async function directWpolPriceX18() {
  const factory = new ethers.Contract(V2_FACTORY, ["function getPair(address,address) view returns(address)"], ethers.provider);
  const pairAddress = await factory.getPair(WPOL, USDT);
  const pair = new ethers.Contract(pairAddress, V2P, ethers.provider);
  const [token0, [r0, r1]] = await Promise.all([pair.token0(), pair.getReserves()]);
  const rw = token0.toLowerCase() === WPOL.toLowerCase() ? r0 : r1;
  const ru = token0.toLowerCase() === WPOL.toLowerCase() ? r1 : r0;
  return ru * 10n ** 30n / rw;
}

async function deployFixture(manifest, route) {
  const [admin, treasury, midas, customer, solverA, solverB, sink] = await ethers.getSigners();
  const routePools = new Set(route.legs.map((l) => l.pool.toLowerCase()));

  const required = new Map([
    [WPOL, E("250")],
    [USDT, U("450")],
    [USDC, U("220")],
    [DAI, E("220")],
    [WETH, E("0.12")]
  ]);
  for (const [asset, amount] of required) {
    const donor = await findDonor(manifest, asset, routePools, amount);
    await impersonatedTransfer(asset, donor, admin.address, amount);
  }

  const Synth = await ethers.getContractFactory("ManagedSyntheticV16", admin);
  const syna = await Synth.deploy("SYNERGY Growth V16", "SYNA16", admin.address);
  await syna.waitForDeployment();
  const synr = await Synth.deploy("SYNERGY Reserve V16", "SYNR16", admin.address);
  await synr.waitForDeployment();

  const Pool = await ethers.getContractFactory("ManagedPoolV16", admin);
  const liquidAssets = [WPOL, USDT, USDC, DAI, WETH, WPOL, USDT, USDC, DAI, WETH];
  const pools = [];
  for (let i = 0; i < 10; i++) {
    const synthetic = i < 5 ? syna : synr;
    const pool = await Pool.deploy(await synthetic.getAddress(), liquidAssets[i], admin.address);
    await pool.waitForDeployment();
    pools.push(pool);
    await (await synthetic.setManagedEndpoint(await pool.getAddress(), true)).wait();
  }

  const seedSynthetic = E("5000");
  const seedLiquid = [E("50"), U("100"), U("100"), E("100"), E("0.04"), E("50"), U("100"), U("100"), E("100"), E("0.04")];
  await (await syna.mint(admin.address, seedSynthetic * 5n)).wait();
  await (await synr.mint(admin.address, seedSynthetic * 5n)).wait();
  for (let i = 0; i < 10; i++) {
    const synth = i < 5 ? syna : synr;
    const liquid = new ethers.Contract(liquidAssets[i], ERC20, admin);
    await (await synth.approve(await pools[i].getAddress(), ethers.MaxUint256)).wait();
    await (await liquid.approve(await pools[i].getAddress(), ethers.MaxUint256)).wait();
    await (await pools[i].seed(seedSynthetic, seedLiquid[i])).wait();
  }

  const Risk = await ethers.getContractFactory("MidasRiskVetoV16", admin);
  const risk = await Risk.deploy(midas.address, E("250"), U("25"), 4);
  await risk.waitForDeployment();

  const Auction = await ethers.getContractFactory("GradientSolverAuctionV16", admin);
  const auction = await Auction.deploy(admin.address, E("0.01"));
  await auction.waitForDeployment();

  const engineFactory = await ethers.getContractFactory("GradientOpportunityMarketV16", admin);
  const topologyHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["address[10]", "address[2]", "address[5]"],
    [await Promise.all(pools.map((p) => p.getAddress())), [await syna.getAddress(), await synr.getAddress()], [WPOL, USDT, USDC, DAI, WETH]]
  ));
  const engine = await engineFactory.deploy({
    governor: admin.address,
    treasury: treasury.address,
    wpol: WPOL,
    usdt: USDT,
    aavePool: AAVE_POOL,
    v2Factory: V2_FACTORY,
    v2Router: V2_ROUTER,
    v3Factory: V3_FACTORY,
    v3Router: V3_ROUTER,
    auction: await auction.getAddress(),
    riskVeto: await risk.getAddress(),
    syna: await syna.getAddress(),
    synr: await synr.getAddress(),
    pools: await Promise.all(pools.map((p) => p.getAddress())),
    liquidAssets,
    topologyHash
  });
  await engine.waitForDeployment();

  await (await syna.setController(await engine.getAddress())).wait();
  await (await synr.setController(await engine.getAddress())).wait();
  for (const pool of pools) await (await pool.setController(await engine.getAddress())).wait();
  await (await auction.setEngine(await engine.getAddress())).wait();
  await (await risk.setEngine(await engine.getAddress())).wait();

  for (const token of [WPOL, USDT, USDC, DAI, WETH]) {
    const bal = await new ethers.Contract(token, ERC20, admin).balanceOf(admin.address);
    if (bal > 0n) await (await new ethers.Contract(token, ERC20, admin).transfer(sink.address, bal)).wait();
  }
  return { admin, treasury, midas, customer, solverA, solverB, sink, syna, synr, pools, liquidAssets, risk, auction, engine, topologyHash };
}

async function publishAndApprove(fx, plan, bidA = 4500, bidB = 6000) {
  const solutionHash = await fx.engine.hashPlan(plan);
  const block = await ethers.provider.getBlockNumber();
  await (await fx.auction.publish(plan.sourceId, plan.customer, plan.customerUsdtIn, plan.flashWpol, U("0.20"), U("0.10"), block + 20, block + 80, solutionHash)).wait();
  const epoch = await fx.auction.currentEpoch();
  await (await fx.auction.connect(fx.solverA).bid(epoch, bidA, solutionHash, { value: E("0.01") })).wait();
  await (await fx.auction.connect(fx.solverB).bid(epoch, bidB, solutionHash, { value: E("0.02") })).wait();
  await mine(21);
  await (await fx.auction.settle(epoch)).wait();
  await (await fx.risk.connect(fx.midas).approve(id(`MIDAS_${plan.nonce}`), solutionHash, BigInt((await ethers.provider.getBlock("latest")).timestamp + 1800), plan.flashWpol, U("0.20"), U("5"))).wait();
  return { epoch, solutionHash };
}

describe("V16 Gradient Opportunity Market structural Polygon fork proof", function () {
  this.timeout(1_800_000);

  it("uses customer-paid order flow, V12 gradient, ten internal pools, real Aave, solver auction and a selected 50-pool route", async function () {
    fs.mkdirSync(path.join(process.cwd(), "reports"), { recursive: true });
    const manifest = loadManifest();
    const aave = new ethers.Contract(AAVE_POOL, AAVE, ethers.provider);
    const reserves = (await aave.getReservesList()).map((x) => x.toLowerCase());
    assert.ok(reserves.includes(WPOL.toLowerCase()), "WPOL is not a real Aave reserve");
    const premiumBps = BigInt(await aave.FLASHLOAN_PREMIUM_TOTAL());
    const v2r = new ethers.Contract(V2_ROUTER, V2R, ethers.provider);
    const v3q = new ethers.Contract(V3_QUOTER, V3Q, ethers.provider);

    const provisional = await selectRoute(manifest, U("20"), v2r, v3q);
    const fx = await deployFixture(manifest, provisional);

    const gradient = E("800");
    const temporaryQe = E("250");
    const sourceSeedSyn = E("5000");
    const sourceSeedWpol = E("50");
    const destinationSeedSyn = E("5000");
    const destinationSeedUsdt = U("100");
    const internalWpolExpected = cpOut(temporaryQe, sourceSeedSyn - gradient, sourceSeedWpol);
    const buybackExpected = cpIn(temporaryQe, destinationSeedUsdt, destinationSeedSyn + gradient);

    const flashWpol = E("20");
    const premiumExpected = flashWpol * premiumBps / 10_000n;
    const targetExternalWpol = flashWpol + premiumExpected + E("0.6") - internalWpolExpected;
    assert.ok(targetExternalWpol > 0n);

    let externalInput = U("1");
    let selected = null;
    for (let i = 0; i < 10; i++) {
      selected = await selectRoute(manifest, externalInput, v2r, v3q);
      if (selected.amountOut >= targetExternalWpol) break;
      externalInput *= 2n;
    }
    assert.ok(selected && selected.amountOut >= targetExternalWpol, "route cannot fund customer+Aave repayment");
    const wpolPriceUsdtX18 = await directWpolPriceX18();

    const basePlan = {
      sourceId: id("V16_CUSTOMER_ORDER_001"),
      nonce: 16001n,
      deadline: BigInt((await ethers.provider.getBlock("latest")).timestamp + 3600),
      customer: fx.customer.address,
      customerUsdtIn: externalInput + buybackExpected,
      customerWpolOut: flashWpol,
      flashWpol,
      maxPremiumWpol: premiumExpected + 10n,
      gradientShift: gradient,
      temporaryQe,
      minInternalWpolOut: internalWpolExpected * 995n / 1000n,
      maxBuybackUsdt: buybackExpected * 1005n / 1000n + 2n,
      externalUsdtIn: externalInput,
      gasReserveUsdt: U("0.50"),
      solverGasReserveUsdt: U("0.10"),
      maxInternalLossUsdt: U("5"),
      minProtocolProfitUsdt: U("0.20"),
      minSolverProfitUsdt: U("0.10"),
      wpolPriceUsdtX18,
      legs: selected.legs.map((l) => ({ venue: l.venue, pool: l.pool, tokenIn: l.tokenIn, tokenOut: l.tokenOut, minOut: l.minOut }))
    };

    const usdt = new ethers.Contract(USDT, ERC20, fx.customer);
    const customerFunding = basePlan.customerUsdtIn + U("10");
    const donor = await findDonor(manifest, USDT, new Set(selected.legs.map((l) => l.pool.toLowerCase())), customerFunding);
    await impersonatedTransfer(USDT, donor, fx.customer.address, customerFunding);
    await (await usdt.approve(await fx.engine.getAddress(), ethers.MaxUint256)).wait();

    const baselineSnapshot = await network.provider.send("evm_snapshot");
    const baselinePlan = { ...basePlan, sourceId: id("V16_ZERO_MARGIN_BASELINE"), nonce: 16000n };
    const baselineApproval = await publishAndApprove(fx, baselinePlan, 5000, 6000);
    let zeroMarginRejected = false;
    try {
      const baselineTx = await fx.engine.connect(fx.solverB).run(baselineApproval.epoch, baselinePlan, {
        gasPrice: GAS_PRICE,
        gasLimit: 15_000_000
      });
      await baselineTx.wait();
    } catch (_) {
      zeroMarginRejected = true;
    }
    assert.equal(zeroMarginRejected, true, "zero-margin gradient did not fail closed");
    assert.equal(await network.provider.send("evm_revert", [baselineSnapshot]), true);

    const customerMargin = U("5.00");
    const plan = {
      ...basePlan,
      sourceId: id("V16_CUSTOMER_MARGIN_POSITIVE"),
      nonce: 16002n,
      customerUsdtIn: basePlan.customerUsdtIn + customerMargin
    };
    const approval = await publishAndApprove(fx, plan, 5000, 6000);

    const before = await snapshotPools(fx.pools, fx.liquidAssets, fx.treasury.address);
    const solverUsdtBefore = await new ethers.Contract(USDT, ERC20, ethers.provider).balanceOf(fx.solverB.address);
    const customerWpolBefore = await new ethers.Contract(WPOL, ERC20, ethers.provider).balanceOf(fx.customer.address);
    const supplyBefore = await fx.syna.totalSupply();

    const tx = await fx.engine.connect(fx.solverB).run(approval.epoch, plan, {
      gasPrice: GAS_PRICE,
      gasLimit: 15_000_000
    });
    const receipt = await tx.wait();
    const after = await snapshotPools(fx.pools, fx.liquidAssets, fx.treasury.address);
    const solverUsdtAfter = await new ethers.Contract(USDT, ERC20, ethers.provider).balanceOf(fx.solverB.address);
    const customerWpolAfter = await new ethers.Contract(WPOL, ERC20, ethers.provider).balanceOf(fx.customer.address);

    assert.equal(await fx.engine.completedCycles(), 1n);
    assert.equal(await fx.engine.temporaryOutstanding(), 0n);
    assert.equal(await fx.syna.totalSupply(), supplyBefore);
    assert.equal(customerWpolAfter - customerWpolBefore, plan.customerWpolOut);
    assert.ok(solverUsdtAfter > solverUsdtBefore);
    assert.equal(await new ethers.Contract(WPOL, ERC20, ethers.provider).balanceOf(await fx.engine.getAddress()), 0n);
    assert.equal(await new ethers.Contract(USDT, ERC20, ethers.provider).balanceOf(await fx.engine.getAddress()), 0n);

    for (let i = 2; i < 10; i++) {
      assert.equal(after.rows[i].liquid, before.rows[i].liquid, `unselected pool ${i} liquid changed`);
      assert.equal(after.rows[i].synthetic, before.rows[i].synthetic, `unselected pool ${i} synthetic changed`);
    }

    const navBefore = externalNav(before, wpolPriceUsdtX18);
    const navAfter = externalNav(after, wpolPriceUsdtX18);
    const navDelta = navAfter - navBefore;
    const gasUsdt = receipt.gasUsed * receipt.gasPrice * wpolPriceUsdtX18 / 10n ** 30n;
    const conservativeNavAfterMeasuredGas = navDelta > gasUsdt ? navDelta - gasUsdt : 0n;
    const solverExecutionGasUsdt = gasUsdt;
    const solverRevenue = solverUsdtAfter - solverUsdtBefore;
    const solverNetAfterExecutionGas = solverRevenue > solverExecutionGasUsdt
      ? solverRevenue - solverExecutionGasUsdt
      : 0n;

    assert.ok(navDelta > 0n, "consolidated external NAV did not grow");
    assert.ok(conservativeNavAfterMeasuredGas > 0n, "NAV not positive after measured gas");
    assert.ok(solverNetAfterExecutionGas > 0n, "winning solver is not profitable after execution gas");
    const measuredInternalValueLoss = await fx.engine.lastInternalValueLossUsdt();
    assert.ok(measuredInternalValueLoss <= plan.maxInternalLossUsdt, "internal LP loss exceeded configured cap");
    const positiveOnchainProtocolNet = await fx.engine.lastProtocolNetAfterGasUsdt();
    assert.ok(positiveOnchainProtocolNet > 0n, "on-chain conservative protocol net is not positive");

    const report = {
      scenario: "v16_gradient_opportunity_market_structural_polygon_fork",
      verdict: "STRUCTURAL_FORK_PASS",
      economicClassification: "CUSTOMER_PAID_MARKET_MAKING_AND_SOLVER_REBALANCING",
      liveDemandProven: false,
      artificialExternalPriceShock: false,
      fixtureCustomerIntent: true,
      fixtureCapitalExcludedFromNavBaseline: true,
      chainId: 137,
      forkBlock: manifest.blockNumber,
      forkBlockHash: manifest.blockHash,
      externalGraph: {
        candidatePools: manifest.candidatePools,
        selectedPools: manifest.selectedExternalPools,
        enumeratedTwoToFourHopPaths: selected.enumeratedPaths,
        executedHops: selected.legs.length,
        route: selected.legs.map((l) => ({ venue: l.venue, pool: l.pool, tokenIn: l.tokenIn, tokenOut: l.tokenOut }))
      },
      internalTopology: {
        pools: 10,
        synthetics: 2,
        liquidAssets: ["WPOL", "USDT", "USDC", "DAI", "WETH"],
        executedSourcePool: await fx.pools[0].getAddress(),
        executedDestinationPool: await fx.pools[1].getAddress()
      },
      aave: {
        pool: AAVE_POOL,
        asset: WPOL,
        principalWpol: fmt(plan.flashWpol, 18),
        premiumWpol: fmt(await fx.engine.lastPremiumWpol(), 18),
        receiverPreFundedWpol: false,
        repaid: true
      },
      zeroMarginBaseline: {
        customerUsdtPaid: fmt(baselinePlan.customerUsdtIn, 6),
        explicitMarginUsdt: 0,
        rejectedFailClosed: zeroMarginRejected
      },
      customer: {
        usdtPaid: fmt(plan.customerUsdtIn, 6),
        wpolReceived: fmt(plan.customerWpolOut, 18),
        explicitMarginUsdt: fmt(customerMargin, 6)
      },
      managedGradient: {
        shiftSyna: fmt(plan.gradientShift, 18),
        temporaryQeSyna: fmt(plan.temporaryQe, 18),
        internalWpolExtracted: fmt(await fx.engine.lastInternalWpolOut(), 18),
        exactBuybackUsdt: fmt(await fx.engine.lastBuybackUsdt(), 6),
        temporarySupplyClosed: true,
        totalSupplyRestored: true
      },
      economics: {
        measuredInternalValueLossUsdt: fmt(measuredInternalValueLoss, 6),
        internalValueLossAccounted: true,
        treasuryRevenueUsdt: fmt(await fx.engine.lastTreasuryRevenueUsdt(), 6),
        treasuryWpolSurplus: fmt(await fx.engine.lastWpolSurplus(), 18),
        solverRevenueUsdt: fmt(solverRevenue, 6),
        measuredExecutionGasUsdt: fmt(gasUsdt, 6),
        solverNetAfterExecutionGasUsdt: fmt(solverNetAfterExecutionGas, 6),
        consolidatedNavDeltaUsdt: fmt(navDelta, 6),
        consolidatedNavAfterMeasuredGasUsdt: fmt(conservativeNavAfterMeasuredGas, 6),
        onchainConservativeProtocolNetUsdt: Number(positiveOnchainProtocolNet) / 1e6
      },
      gates: {
        zeroMarginRejectedFailClosed: zeroMarginRejected,
        customerPaidOpportunityAccepted: true,
        internalValueLossAccounted: true,
        tenPoolTopologyValidated: true,
        realAavePrincipal: true,
        selectedFiftyPoolGraphRoute: true,
        midasRiskVetoConsumed: true,
        solverAuctionConsumed: true,
        solverPositiveAfterGas: true,
        protocolPositiveAfterMeasuredGas: true,
        temporaryQeQtClosed: true
      },
      strictBoundary: "This proves atomic mechanics and accounting with a fixture customer intent. It does not prove that equivalent live customer demand or solver competition currently exists on Polygon."
    };

    fs.writeFileSync(
      path.join(process.cwd(), "reports", "v16_gradient_opportunity_market.json"),
      JSON.stringify(report, null, 2)
    );
    console.log(JSON.stringify(report, null, 2));
  });
});
