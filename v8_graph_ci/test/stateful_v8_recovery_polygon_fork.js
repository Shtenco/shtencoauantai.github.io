"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ethers, network } = require("hardhat");

const WPOL = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const USDT = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";
const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const DAI = "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063";
const WETH = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";
const QS_V2_FACTORY = "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32";
const QS_V2_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const QS_V3_FACTORY = "0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28";
const QS_V3_QUOTER = "0xa15F0D7377B2A0C0c10db057f641beD21028FC89";
const QS_V3_ROUTER = "0xf5b509bB0909a69B1c207E495f687a596C168E12";
const GAS_PRICE = 274_000_000_000n;
const CYCLES = 3;
const U = (v) => ethers.parseUnits(v, 6);
const E = ethers.parseEther;
const fmt6 = (v) => Number(ethers.formatUnits(v, 6));
const id = (v) => ethers.keccak256(ethers.toUtf8Bytes(v));

const ERC20_ABI = [
  "function approve(address,uint256) returns(bool)",
  "function transfer(address,uint256) returns(bool)",
  "function balanceOf(address) view returns(uint256)",
  "function deposit() payable"
];
const V2_FACTORY_ABI = ["function getPair(address,address) view returns(address)"];
const V3_FACTORY_ABI = ["function poolByPair(address,address) view returns(address)"];
const PAIR_ABI = [
  "function token0() view returns(address)",
  "function token1() view returns(address)",
  "function getReserves() view returns(uint112,uint112,uint32)"
];
const V2_ROUTER_ABI = [
  "function getAmountsOut(uint256,address[]) view returns(uint256[])",
  "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns(uint256[])"
];
const V3_QUOTER_ABI = [
  "function quoteExactInputSingle(address,address,uint256,uint160) returns(uint256,uint16)"
];

async function eligible(registry, admin, account, label) {
  const block = await ethers.provider.getBlock("latest");
  await (await registry.connect(admin).setParticipant(
    account, true, BigInt(block.timestamp + 86400), id(label)
  )).wait();
}

async function impersonatedTransfer(token, donor, recipient, amount) {
  await network.provider.send("anvil_impersonateAccount", [donor]);
  await network.provider.send("anvil_setBalance", [donor, ethers.toBeHex(E("100"))]);
  const provider = new ethers.JsonRpcProvider(process.env.LOCAL_FORK_URL || "http://127.0.0.1:8545");
  const signer = await provider.getSigner(donor);
  const contract = new ethers.Contract(token, ERC20_ABI, signer);
  await (await contract.transfer(recipient, amount)).wait();
  await network.provider.send("anvil_stopImpersonatingAccount", [donor]);
}

async function findDonor(factory, token, alternatives, excluded, minimum) {
  const blocked = new Set(excluded.map((x) => x.toLowerCase()));
  const candidates = [];
  for (const other of alternatives) {
    const pair = await factory.getPair(token, other);
    if (pair === ethers.ZeroAddress || blocked.has(pair.toLowerCase())) continue;
    const balance = await new ethers.Contract(token, ERC20_ABI, ethers.provider).balanceOf(pair);
    candidates.push({ pair, other, balance });
  }
  candidates.sort((a, b) => a.balance > b.balance ? -1 : a.balance < b.balance ? 1 : 0);
  assert.ok(candidates.length && candidates[0].balance >= minimum, `no donor for ${token}`);
  return candidates[0];
}

async function discoverExternal(factoryV2, factoryV3) {
  const specs = [
    [WPOL, USDT, "v2"], [WPOL, USDT, "v3"], [WPOL, USDC, "auto"],
    [WPOL, WETH, "auto"], [WPOL, DAI, "auto"], [USDT, USDC, "auto"],
    [USDT, WETH, "auto"], [USDT, DAI, "auto"], [USDC, WETH, "auto"],
    [USDC, DAI, "auto"]
  ];
  const pools = [];
  const metadata = [];
  for (const [tokenA, tokenB, requested] of specs) {
    let pool = ethers.ZeroAddress;
    let kind = requested;
    if (requested !== "v2") {
      pool = await factoryV3.poolByPair(tokenA, tokenB);
      if (pool !== ethers.ZeroAddress) kind = "v3";
    }
    if (pool === ethers.ZeroAddress && requested !== "v3") {
      pool = await factoryV2.getPair(tokenA, tokenB);
      if (pool !== ethers.ZeroAddress) kind = "v2";
    }
    assert.notEqual(pool, ethers.ZeroAddress, `missing external ${tokenA}/${tokenB}`);
    assert.notEqual(await ethers.provider.getCode(pool), "0x");
    const balanceA = await new ethers.Contract(tokenA, ERC20_ABI, ethers.provider).balanceOf(pool);
    const balanceB = await new ethers.Contract(tokenB, ERC20_ABI, ethers.provider).balanceOf(pool);
    assert.ok(balanceA > 0n && balanceB > 0n, `empty external pool ${pool}`);
    pools.push(pool);
    metadata.push({ tokenA, tokenB, kind, pool });
  }
  assert.equal(new Set(pools.map((x) => x.toLowerCase())).size, 10);
  return { pools, metadata };
}

function internalOut(amountIn, reserveIn, reserveOut) {
  const effective = amountIn * 9970n;
  return effective * reserveOut / (reserveIn * 10000n + effective);
}
function internalIn(amountOut, reserveIn, reserveOut) {
  return reserveIn * amountOut * 10000n / ((reserveOut - amountOut) * 9970n) + 1n;
}
async function pairState(pair, synthetic, liquid) {
  const token0 = await pair.token0();
  const [r0, r1] = await pair.getReserves();
  const syntheticReserve = token0.toLowerCase() === synthetic.toLowerCase() ? r0 : r1;
  const liquidReserve = token0.toLowerCase() === liquid.toLowerCase() ? r0 : r1;
  return { syntheticReserve, liquidReserve, k: syntheticReserve * liquidReserve };
}
async function choosePlan(pair, synthetic, quoter, v2Router, minimumProfit) {
  const state = await pairState(pair, synthetic, USDT);
  for (const bps of [10n, 25n, 50n, 100n, 200n, 400n, 700n]) {
    const mint = state.syntheticReserve * bps / 10000n;
    if (!mint) continue;
    const extracted = internalOut(mint, state.syntheticReserve, state.liquidReserve);
    const buyback = internalIn(
      mint,
      state.liquidReserve - extracted,
      state.syntheticReserve + mint
    );
    const q = await quoter.quoteExactInputSingle.staticCall(USDT, WPOL, extracted, 0);
    const wpolOut = q[0];
    const v2 = await v2Router.getAmountsOut(wpolOut, [WPOL, USDT]);
    if (v2[1] > buyback + minimumProfit) {
      return { mint, extracted, buyback, wpolOut, usdtOut: v2[1] };
    }
  }
  return null;
}
async function shock(shocker, usdt, v2Router, amount) {
  await (await usdt.connect(shocker).approve(QS_V2_ROUTER, amount)).wait();
  const block = await ethers.provider.getBlock("latest");
  await (await v2Router.connect(shocker).swapExactTokensForTokens(
    amount, 1n, [USDT, WPOL], shocker.address, BigInt(block.timestamp + 600)
  )).wait();
}
async function boundaryTotal(token, addresses) {
  const contract = new ethers.Contract(token, ERC20_ABI, ethers.provider);
  let total = 0n;
  for (const address of addresses) total += await contract.balanceOf(address);
  return total;
}

function writeReport(value) {
  fs.mkdirSync(path.join(process.cwd(), "reports"), { recursive: true });
  fs.writeFileSync(
    path.join(process.cwd(), "reports/stateful_v8_recovery_polygon_fork.json"),
    JSON.stringify(value, null, 2)
  );
}

describe("Recovered SYNERGY V8/V11 internal-external graph", function () {
  this.timeout(1800000);

  it("executes three profitable QE graph buyback QT cycles in a 10+10 topology", async function () {
    const [admin, keeper, treasury, shocker] = await ethers.getSigners();
    for (const address of [WPOL, USDT, USDC, DAI, WETH, QS_V2_FACTORY, QS_V2_ROUTER, QS_V3_FACTORY, QS_V3_QUOTER, QS_V3_ROUTER]) {
      assert.notEqual(await ethers.provider.getCode(address), "0x", `missing code ${address}`);
    }

    const factoryV2 = new ethers.Contract(QS_V2_FACTORY, V2_FACTORY_ABI, admin);
    const factoryV3 = new ethers.Contract(QS_V3_FACTORY, V3_FACTORY_ABI, admin);
    const v2Router = new ethers.Contract(QS_V2_ROUTER, V2_ROUTER_ABI, admin);
    const quoter = new ethers.Contract(QS_V3_QUOTER, V3_QUOTER_ABI, admin);
    const external = await discoverExternal(factoryV2, factoryV3);
    const routeV2 = await factoryV2.getPair(WPOL, USDT);

    const wpol = new ethers.Contract(WPOL, ERC20_ABI, admin);
    const usdt = new ethers.Contract(USDT, ERC20_ABI, admin);
    const usdc = new ethers.Contract(USDC, ERC20_ABI, admin);
    const weth = new ethers.Contract(WETH, ERC20_ABI, admin);
    await (await wpol.deposit({ value: E("100") })).wait();

    const usdtDonor = await findDonor(factoryV2, USDT, [USDC, DAI, WETH, WPOL], [routeV2], U("20000"));
    const adminUsdt = usdtDonor.balance * 30n / 100n;
    const shockFunding = usdtDonor.balance * 60n / 100n;
    const mainDepth = adminUsdt * 70n / 100n;
    assert.ok(mainDepth >= U("3000"));
    await impersonatedTransfer(USDT, usdtDonor.pair, admin.address, adminUsdt);
    await impersonatedTransfer(USDT, usdtDonor.pair, shocker.address, shockFunding);

    const usdcDonor = await findDonor(factoryV2, USDC, [USDT, DAI, WETH, WPOL], [], U("1000"));
    const wethDonor = await findDonor(factoryV2, WETH, [USDT, USDC, DAI, WPOL], [], E("2"));
    await impersonatedTransfer(USDC, usdcDonor.pair, admin.address, U("1000"));
    await impersonatedTransfer(WETH, wethDonor.pair, admin.address, E("2"));

    const Registry = await ethers.getContractFactory("ParticipantTaxRegistry", admin);
    const registry = await Registry.deploy(admin.address);
    await registry.waitForDeployment();
    await eligible(registry, admin, admin.address, "admin");
    await eligible(registry, admin, keeper.address, "keeper");
    await eligible(registry, admin, treasury.address, "treasury");

    const Factory = await ethers.getContractFactory("SynergyDexFactoryV5", admin);
    const internalFactory = await Factory.deploy(await registry.getAddress());
    await internalFactory.waitForDeployment();
    const Router = await ethers.getContractFactory("SynergyDexRouterV5", admin);
    const internalRouter = await Router.deploy(await registry.getAddress(), await internalFactory.getAddress());
    await internalRouter.waitForDeployment();
    await (await internalFactory.setRouter(await internalRouter.getAddress(), true)).wait();

    const Token = await ethers.getContractFactory("TemporaryQETokenV11", admin);
    const synthetic = await Token.deploy();
    await synthetic.waitForDeployment();
    const SYN = await synthetic.getAddress();
    const specs = [
      [SYN, WPOL], [SYN, USDT], [SYN, USDC], [SYN, WETH], [WPOL, USDT],
      [WPOL, USDC], [WPOL, WETH], [USDT, USDC], [USDT, WETH], [USDC, WETH]
    ];
    for (const [a, b] of specs) await (await internalFactory.createPair(a, b)).wait();
    assert.equal(await internalFactory.allPairsLength(), 10n);
    const internalPools = [];
    for (const [a, b] of specs) internalPools.push(await internalFactory.getPair(a, b));
    assert.equal(new Set(internalPools.map((x) => x.toLowerCase())).size, 10);

    await (await synthetic.mintBootstrap(admin.address, mainDepth + U("4000"))).wait();
    for (const token of [synthetic, wpol, usdt, usdc, weth]) {
      await (await token.approve(await internalRouter.getAddress(), ethers.MaxUint256)).wait();
    }
    async function add(a, b, aa, bb) {
      const block = await ethers.provider.getBlock("latest");
      await (await internalRouter.addLiquidity(a, b, aa, bb, admin.address, BigInt(block.timestamp + 3600))).wait();
    }
    await add(SYN, WPOL, U("500"), E("1"));
    await add(SYN, USDT, mainDepth, mainDepth);
    await add(SYN, USDC, U("500"), U("100"));
    await add(SYN, WETH, U("500"), E("0.1"));
    await add(WPOL, USDT, E("1"), U("10"));
    await add(WPOL, USDC, E("1"), U("10"));
    await add(WPOL, WETH, E("1"), E("0.01"));
    await add(USDT, USDC, U("10"), U("10"));
    await add(USDT, WETH, U("10"), E("0.01"));
    await add(USDC, WETH, U("10"), E("0.01"));

    const mainPairAddress = await internalFactory.getPair(SYN, USDT);
    const mainPair = new ethers.Contract(mainPairAddress, PAIR_ABI, admin);
    const Executor = await ethers.getContractFactory("SynergyAtomicQeQtCycleV11", admin);
    const executor = await Executor.deploy(
      SYN, USDT, WPOL, await internalRouter.getAddress(), mainPairAddress,
      QS_V3_ROUTER, QS_V2_ROUTER, treasury.address
    );
    await executor.waitForDeployment();
    await (await synthetic.setController(await executor.getAddress())).wait();
    await eligible(registry, admin, await executor.getAddress(), "executor");

    const V8 = await ethers.getContractFactory("StatefulSupercycleV8", admin);
    const supercycle = await V8.deploy(await executor.getAddress(), USDT, treasury.address, U("0.25"));
    await supercycle.waitForDeployment();
    await (await supercycle.setKeeper(keeper.address, true)).wait();
    await (await executor.setKeeper(await supercycle.getAddress(), true)).wait();
    await (await supercycle.configureTopology(internalPools, external.pools)).wait();

    const boundary = [treasury.address, await executor.getAddress(), await supercycle.getAddress(), ...internalPools];
    const before = {
      wpol: await boundaryTotal(WPOL, boundary),
      usdt: await boundaryTotal(USDT, boundary),
      usdc: await boundaryTotal(USDC, boundary),
      weth: await boundaryTotal(WETH, boundary),
      supply: await synthetic.totalSupply()
    };
    assert.equal(await choosePlan(mainPair, SYN, quoter, v2Router, U("0.5")), null, "unexpected pre-shock edge");

    let remainingShock = shockFunding;
    let totalShock = 0n;
    let gasTotal = 0n;
    const rows = [];
    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      let chosen = await choosePlan(mainPair, SYN, quoter, v2Router, U("0.5"));
      for (const bps of [500n, 750n, 1000n, 1250n, 1500n]) {
        if (chosen) break;
        const amount = shockFunding * bps / 10000n;
        if (!amount || amount > remainingShock) continue;
        await shock(shocker, usdt, v2Router, amount);
        remainingShock -= amount;
        totalShock += amount;
        chosen = await choosePlan(mainPair, SYN, quoter, v2Router, U("0.5"));
      }
      assert.ok(chosen, `cycle ${cycle}: no profitable route`);
      const block = await ethers.provider.getBlock("latest");
      const plan = {
        sourceId: id(`source-${cycle}`), nonce: BigInt(cycle), deadline: BigInt(block.timestamp + 600),
        qeMint: chosen.mint, minExtractedUsdt: chosen.extracted * 999n / 1000n,
        minWpolFromV3: chosen.wpolOut * 995n / 1000n,
        minUsdtFromV2: chosen.usdtOut * 995n / 1000n,
        minTreasuryProfit: U("0.25")
      };
      const stateBefore = await pairState(mainPair, SYN, USDT);
      const treasuryBefore = await usdt.balanceOf(treasury.address);
      const tx = await supercycle.connect(keeper).executeCycle(plan, id(`cycle-${cycle}`), { gasPrice: GAS_PRICE });
      const receipt = await tx.wait();
      const stateAfter = await pairState(mainPair, SYN, USDT);
      const treasuryAfter = await usdt.balanceOf(treasury.address);
      const gasPol = receipt.gasUsed * receipt.gasPrice;
      const gasUsdt = (await v2Router.getAmountsOut(gasPol, [WPOL, USDT]))[1];
      gasTotal += gasUsdt;
      assert.equal(await executor.temporaryOutstanding(), 0n);
      assert.equal(await synthetic.totalSupply(), before.supply);
      assert.ok(stateAfter.liquidReserve >= stateBefore.liquidReserve);
      assert.ok(stateAfter.k >= stateBefore.k);
      assert.ok(treasuryAfter - treasuryBefore > gasUsdt);
      rows.push({
        cycle,
        qeMint: fmt6(chosen.mint),
        externalUsdt: fmt6(await executor.lastExternalUsdt()),
        buybackUsdt: fmt6(await executor.lastBuybackUsdt()),
        treasuryProfitUsdt: fmt6(treasuryAfter - treasuryBefore),
        gasUsdt: fmt6(gasUsdt),
        kBefore: stateBefore.k.toString(),
        kAfter: stateAfter.k.toString()
      });
    }

    const after = {
      wpol: await boundaryTotal(WPOL, boundary),
      usdt: await boundaryTotal(USDT, boundary),
      usdc: await boundaryTotal(USDC, boundary),
      weth: await boundaryTotal(WETH, boundary)
    };
    assert.equal(after.wpol, before.wpol);
    assert.equal(after.usdc, before.usdc);
    assert.equal(after.weth, before.weth);
    assert.ok(after.usdt > before.usdt);
    assert.equal(await supercycle.completedCycles(), 3n);
    assert.ok(await supercycle.cumulativeConsolidatedProfit() > gasTotal);

    writeReport({
      scenario: "recovered_stateful_v8_v11_polygon_fork",
      verdict: "PASS",
      forkBlock: Number(process.env.FORK_BLOCK_NUMBER || 90790000),
      internalPools: 10,
      externalPools: 10,
      executedInternalPools: 1,
      executedExternalEdges: 2,
      successfulCycles: CYCLES,
      independentExternalShockUsdt: fmt6(totalShock),
      cumulativeTreasuryProfitUsdt: fmt6(await supercycle.cumulativeConsolidatedProfit()),
      cumulativeGasUsdtAt274Gwei: fmt6(gasTotal),
      consolidatedUsdtGain: fmt6(after.usdt - before.usdt),
      syntheticSupplyRestored: (await synthetic.totalSupply()) === before.supply,
      temporarySupplyClosed: (await executor.temporaryOutstanding()) === 0n,
      otherProtocolAssetsPreserved: after.wpol === before.wpol && after.usdc === before.usdc && after.weth === before.weth,
      profitAfterGasPositive: (await supercycle.cumulativeConsolidatedProfit()) > gasTotal,
      externalPoolMetadata: external.metadata,
      cycles: rows,
      limitation: "The recovered positive fork executes one internal SYN/USDT edge and two external QuickSwap V3/V2 edges inside a validated 10+10 topology. It does not yet execute arbitrary 50-pool routes or an Aave flash loan."
    });
  });
});
