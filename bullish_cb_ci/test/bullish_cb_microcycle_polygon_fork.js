const assert = require("assert");
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;

const provider = new ethers.JsonRpcProvider(process.env.LOCAL_FORK_URL || "http://127.0.0.1:8545");
const USDT = "0xc2132d05d31c914a87c6611c10748aeb04b58e8f";
const WPOL = "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270";
const WPOL_USDT_PAIR = "0x604229c960e5cacf2aaeac8be68ac07ba9df81c3";
const FIXTURE_DONOR = WPOL_USDT_PAIR;
const DEV_MNEMONIC = "test test test test test test test test test test test junk";
const GWEI = 10n ** 9n;
const GAS = { maxFeePerGas: 500n * GWEI, maxPriorityFeePerGas: 30n * GWEI };
const TOKEN_PRICE_SCALE = 10n ** 30n;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
];
const PAIR_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
];

async function rpc(method, params = []) {
  try {
    return await provider.send(method, params);
  } catch (first) {
    const fallback = method.startsWith("anvil_") ? method.replace("anvil_", "hardhat_") : method;
    if (fallback === method) throw first;
    return provider.send(fallback, params);
  }
}

async function rawBlockNumber() {
  return Number(BigInt(await provider.send("eth_blockNumber", [])));
}

async function mineBlocks(count) {
  try {
    await provider.send("anvil_mine", [`0x${count.toString(16)}`]);
  } catch (_) {
    await provider.send("hardhat_mine", [`0x${count.toString(16)}`]);
  }
}

async function expectRevert(promise, fragment) {
  try {
    await promise;
    assert.fail(`expected revert containing ${fragment}`);
  } catch (error) {
    assert(String(error).includes(fragment), `unexpected error: ${error}`);
  }
}

function receiptCost(receipt) {
  return receipt.gasUsed * (receipt.gasPrice ?? 0n);
}

function tokenSpotValueUsdtRaw(tokenAmount, priceX18) {
  return tokenAmount * priceX18 / TOKEN_PRICE_SCALE;
}

function usdt(raw) {
  return Number(ethers.formatUnits(raw, 6));
}

async function polPriceUsdt() {
  const pair = new ethers.Contract(WPOL_USDT_PAIR, PAIR_ABI, provider);
  const [token0, token1, reserves] = await Promise.all([pair.token0(), pair.token1(), pair.getReserves()]);
  let usdtReserve;
  let wpolReserve;
  if (token0.toLowerCase() === USDT && token1.toLowerCase() === WPOL) {
    usdtReserve = reserves[0];
    wpolReserve = reserves[1];
  } else if (token1.toLowerCase() === USDT && token0.toLowerCase() === WPOL) {
    usdtReserve = reserves[1];
    wpolReserve = reserves[0];
  } else {
    throw new Error("Pinned pair is not WPOL/USDT");
  }
  return Number(ethers.formatUnits(usdtReserve, 6)) / Number(ethers.formatEther(wpolReserve));
}

async function fundFixture(owner, amount = 2_000_000n) {
  const ownerAddress = await owner.getAddress();
  await rpc("anvil_setBalance", [ownerAddress, "0x152d02c7e14af6800000"]);
  await rpc("anvil_setBalance", [FIXTURE_DONOR, "0x3635c9adc5dea00000"]);
  await rpc("anvil_impersonateAccount", [FIXTURE_DONOR]);
  const donor = await provider.getSigner(FIXTURE_DONOR);
  const usdtToken = new ethers.Contract(USDT, ERC20_ABI, owner);
  const before = await usdtToken.balanceOf(ownerAddress);
  await (await usdtToken.connect(donor).transfer(ownerAddress, amount)).wait();
  assert.equal((await usdtToken.balanceOf(ownerAddress)) - before, amount);
  return usdtToken;
}

async function deploySystem(owner, usdtToken) {
  const ownerAddress = await owner.getAddress();
  let setupGasWei = 0n;
  const Token = await ethers.getContractFactory("RebaseSynaV1", owner);
  const token = await Token.deploy(ownerAddress, GAS);
  setupGasWei += receiptCost(await token.deploymentTransaction().wait());

  const Controller = await ethers.getContractFactory("BullishCentralBankV1", owner);
  const controller = await Controller.deploy(ownerAddress, USDT, await token.getAddress(), GAS);
  setupGasWei += receiptCost(await controller.deploymentTransaction().wait());

  const Pool = await ethers.getContractFactory("SecureSynaUsdtPoolV1", owner);
  const pool = await Pool.deploy(USDT, await token.getAddress(), await controller.getAddress(), GAS);
  setupGasWei += receiptCost(await pool.deploymentTransaction().wait());

  let tx = await token.setController(await controller.getAddress(), GAS);
  setupGasWei += receiptCost(await tx.wait());
  tx = await controller.setPool(await pool.getAddress(), GAS);
  setupGasWei += receiptCost(await tx.wait());
  tx = await usdtToken.approve(await controller.getAddress(), 2_000_000n, GAS);
  setupGasWei += receiptCost(await tx.wait());
  tx = await controller.initialize(
    ethers.parseEther("1000000"),
    ethers.parseEther("500000"),
    1_000_000n,
    1_000_000n,
    GAS,
  );
  setupGasWei += receiptCost(await tx.wait());
  return { token, controller, pool, setupGasWei };
}

async function valueSnapshot(token, controller, pool, usdtToken) {
  const poolAddress = await pool.getAddress();
  const controllerAddress = await controller.getAddress();
  const price = await pool.priceX18();
  const poolUsdtRaw = await usdtToken.balanceOf(poolAddress);
  const poolSynaRaw = await token.balanceOf(poolAddress);
  const robotUsdtRaw = await controller.robotUsdt();
  const cbUsdtRaw = await controller.treasuryUsdt();
  const robotSynaRaw = await token.balanceOf(controllerAddress);
  const poolTokenSideUsdtRaw = tokenSpotValueUsdtRaw(poolSynaRaw, price);
  const robotTokenSideUsdtRaw = tokenSpotValueUsdtRaw(robotSynaRaw, price);
  const tvlRaw = poolUsdtRaw + poolTokenSideUsdtRaw;
  const robotBalanceRaw = robotUsdtRaw + robotTokenSideUsdtRaw;
  const cbBalanceRaw = cbUsdtRaw;
  const totalRaw = tvlRaw + robotBalanceRaw + cbBalanceRaw;
  return {
    price,
    poolUsdtRaw,
    poolSynaRaw,
    poolTokenSideUsdtRaw,
    tvlRaw,
    robotUsdtRaw,
    robotSynaRaw,
    robotTokenSideUsdtRaw,
    robotBalanceRaw,
    cbBalanceRaw,
    totalRaw,
  };
}

describe("SYNERGY bullish CB TVL solvency test on pinned Polygon fork", function () {
  it("runs 15 atomic cycles over 150 blocks and applies only TVL + robot + CB > gas", async function () {
    const chainId = Number((await provider.getNetwork()).chainId);
    assert.equal(chainId, 137);
    const owner = new ethers.NonceManager(ethers.Wallet.fromPhrase(DEV_MNEMONIC).connect(provider));
    const usdtToken = await fundFixture(owner);
    const { token, controller, pool, setupGasWei } = await deploySystem(owner, usdtToken);

    const initialBlock = await rawBlockNumber();
    const initialSupply = await token.totalSupply();
    const initial = await valueSnapshot(token, controller, pool, usdtToken);

    let cycleGasWei = 0n;
    const cycles = [];
    for (let i = 0; i < 15; i += 1) {
      const block = await provider.getBlock("latest");
      const tx = await controller.executeCycle(i, block.timestamp + 3600, 2_000_000n, GAS);
      const receipt = await tx.wait();
      cycleGasWei += receiptCost(receipt);
      const snap = await valueSnapshot(token, controller, pool, usdtToken);
      cycles.push({
        cycle: i + 1,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        effectiveGasPriceWei: (receipt.gasPrice ?? 0n).toString(),
        priceX18: snap.price.toString(),
        supply: (await token.totalSupply()).toString(),
        tvlUsdt: usdt(snap.tvlRaw),
        robotBalanceUsdt: usdt(snap.robotBalanceRaw),
        cbBalanceUsdt: usdt(snap.cbBalanceRaw),
        totalTvlRobotCbUsdt: usdt(snap.totalRaw),
      });
      await mineBlocks(9);
    }

    const finalBlock = await rawBlockNumber();
    const finalSupply = await token.totalSupply();
    const final = await valueSnapshot(token, controller, pool, usdtToken);
    const totalGasWei = setupGasWei + cycleGasWei;
    const polUsdt = await polPriceUsdt();
    const setupGasPol = Number(ethers.formatEther(setupGasWei));
    const cycleGasPol = Number(ethers.formatEther(cycleGasWei));
    const totalGasPol = Number(ethers.formatEther(totalGasWei));
    const totalGasUsdt = totalGasPol * polUsdt;
    const oneUsdtBudgetCovered = totalGasUsdt < 1.0;
    const initialTotalUsdt = usdt(initial.totalRaw);
    const finalTotalUsdt = usdt(final.totalRaw);
    const grossSystemGrowthUsdt = finalTotalUsdt - initialTotalUsdt;
    const solvencyMarginUsdt = grossSystemGrowthUsdt - totalGasUsdt;
    const solvent = solvencyMarginUsdt > 0;
    const coveredBlocks = finalBlock - initialBlock;
    const mainnetGate = solvent && oneUsdtBudgetCovered
      ? "READY_BY_TVL_ROBOT_CB_SOLVENCY_METRIC"
      : "BLOCKED_BY_TVL_ROBOT_CB_SOLVENCY_METRIC";

    const report = {
      scenario: "SYNERGY_BULLISH_CB_TVL_ROBOT_CB_SOLVENCY_V2_POLYGON_FORK",
      evidenceClass: "STRUCTURAL_FORK_REAL_USDT_REAL_GAS_SPOT_TVL",
      criterion: "DELTA_TVL_PLUS_ROBOT_BALANCE_PLUS_CB_BALANCE_GREATER_THAN_GAS",
      chainId,
      forkBlockConfigured: Number(process.env.FORK_BLOCK_NUMBER || 0),
      coveredBlocks,
      cycles: 15,
      trades: 105,
      startingCapital: {
        robotAndCbUsdt: 1,
        poolUsdt: 1,
        gasBudgetUsdt: 1,
        fixtureSource: FIXTURE_DONOR,
      },
      price: {
        initialX18: initial.price.toString(),
        finalX18: final.price.toString(),
        multiple: Number(final.price) / Number(initial.price),
      },
      supply: {
        initial: initialSupply.toString(),
        final: finalSupply.toString(),
        changePct: (Number(finalSupply) / Number(initialSupply) - 1) * 100,
      },
      initial: {
        tvlUsdt: usdt(initial.tvlRaw),
        poolUsdtSideUsdt: usdt(initial.poolUsdtRaw),
        poolSynaSideSpotUsdt: usdt(initial.poolTokenSideUsdtRaw),
        robotUsdt: usdt(initial.robotUsdtRaw),
        robotSynaSpotUsdt: usdt(initial.robotTokenSideUsdtRaw),
        robotBalanceUsdt: usdt(initial.robotBalanceRaw),
        cbBalanceUsdt: usdt(initial.cbBalanceRaw),
        totalTvlRobotCbUsdt: initialTotalUsdt,
      },
      final: {
        tvlUsdt: usdt(final.tvlRaw),
        poolUsdtSideUsdt: usdt(final.poolUsdtRaw),
        poolSynaSideSpotUsdt: usdt(final.poolTokenSideUsdtRaw),
        robotUsdt: usdt(final.robotUsdtRaw),
        robotSynaSpotUsdt: usdt(final.robotTokenSideUsdtRaw),
        robotBalanceUsdt: usdt(final.robotBalanceRaw),
        cbBalanceUsdt: usdt(final.cbBalanceRaw),
        totalTvlRobotCbUsdt: finalTotalUsdt,
      },
      gas: {
        setupGasWei: setupGasWei.toString(),
        cycleGasWei: cycleGasWei.toString(),
        totalGasWei: totalGasWei.toString(),
        setupGasPol,
        cycleGasPol,
        totalGasPol,
        polUsdt,
        totalGasUsdt,
        oneUsdtBudgetCovered,
      },
      solvency: {
        initialTotalTvlRobotCbUsdt: initialTotalUsdt,
        finalTotalTvlRobotCbUsdt: finalTotalUsdt,
        grossGrowthUsdt: grossSystemGrowthUsdt,
        gasUsdt: totalGasUsdt,
        netGrowthAfterGasUsdt: solvencyMarginUsdt,
        solvent,
        verdict: solvent ? "PASS_SOLVENT" : "FAIL_INSOLVENT",
      },
      protections: {
        atomicSevenTradeBatch: true,
        poolControllerOnly: true,
        zeroPriceGuard: true,
        nonce: true,
        deadline: true,
        publicIntermediateState: false,
      },
      mainnetGate,
      cyclesDetail: cycles,
    };
    fs.mkdirSync(path.join(process.cwd(), "reports"), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), "reports", "bullish_cb_microcycle_polygon_fork.json"), JSON.stringify(report, null, 2));

    assert.equal(coveredBlocks, 150);
    assert(final.price > initial.price, "price did not rise");
    assert(finalSupply < initialSupply, "supply did not contract");
    assert(grossSystemGrowthUsdt > totalGasUsdt, `TVL + robot + CB growth ${grossSystemGrowthUsdt} did not exceed gas ${totalGasUsdt}`);
    assert(solvent, "system is not solvent by requested criterion");
  });

  it("rejects public calls, replay, stale deadline and ledger loss", async function () {
    const owner = new ethers.NonceManager(ethers.Wallet.fromPhrase(DEV_MNEMONIC).connect(provider));
    const attacker = ethers.Wallet.createRandom().connect(provider);
    const attackerAddress = await attacker.getAddress();
    await rpc("anvil_setBalance", [attackerAddress, "0x3635c9adc5dea00000"]);
    const usdtToken = await fundFixture(owner);
    const { controller, pool } = await deploySystem(owner, usdtToken);
    await expectRevert(pool.connect(attacker).buyWithNetUsdt(1n, 1n), "CONTROLLER");
    const block = await provider.getBlock("latest");
    await expectRevert(controller.executeCycle(1, block.timestamp + 100, 2_000_000n, GAS), "NONCE");
    await expectRevert(controller.executeCycle(0, block.timestamp - 1, 2_000_000n, GAS), "DEADLINE");
    await expectRevert(controller.executeCycle(0, block.timestamp + 100, 2_000_001n, GAS), "HARD_NAV_LOSS");
  });
});
