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
const CHECKPOINTS = [15, 50, 100, 250, 500];

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

function receiptCost(receipt) {
  return receipt.gasUsed * (receipt.gasPrice ?? 0n);
}

function tokenSpotValueUsdtRaw(tokenAmount, priceX18) {
  return tokenAmount * priceX18 / TOKEN_PRICE_SCALE;
}

function formatUsdt(raw) {
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
  const usdt = new ethers.Contract(USDT, ERC20_ABI, owner);
  const before = await usdt.balanceOf(ownerAddress);
  await (await usdt.connect(donor).transfer(ownerAddress, amount)).wait();
  assert.equal((await usdt.balanceOf(ownerAddress)) - before, amount);
  return usdt;
}

async function deploySystem(owner, usdt) {
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
  tx = await usdt.approve(await controller.getAddress(), 2_000_000n, GAS);
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

async function snapshotValue(token, controller, pool, usdt) {
  const poolAddress = await pool.getAddress();
  const controllerAddress = await controller.getAddress();
  const price = await pool.priceX18();
  const poolUsdtRaw = await usdt.balanceOf(poolAddress);
  const poolSynaRaw = await token.balanceOf(poolAddress);
  const robotUsdtRaw = await controller.robotUsdt();
  const cbUsdtRaw = await controller.treasuryUsdt();
  const robotSynaRaw = await token.balanceOf(controllerAddress);
  const poolSynaSpotUsdtRaw = tokenSpotValueUsdtRaw(poolSynaRaw, price);
  const robotSynaSpotUsdtRaw = tokenSpotValueUsdtRaw(robotSynaRaw, price);
  const tvlRaw = poolUsdtRaw + poolSynaSpotUsdtRaw;
  const robotBalanceRaw = robotUsdtRaw + robotSynaSpotUsdtRaw;
  const cbBalanceRaw = cbUsdtRaw;
  return {
    price,
    poolUsdtRaw,
    poolSynaRaw,
    poolSynaSpotUsdtRaw,
    tvlRaw,
    robotUsdtRaw,
    robotSynaRaw,
    robotSynaSpotUsdtRaw,
    robotBalanceRaw,
    cbBalanceRaw,
    totalRaw: tvlRaw + robotBalanceRaw + cbBalanceRaw,
  };
}

function checkpointRow(cycles, initial, current, initialSupply, currentSupply, setupGasWei, cycleGasWei, polUsdt, initialBlock, currentBlock) {
  const totalGasWei = setupGasWei + cycleGasWei;
  const totalGasPol = Number(ethers.formatEther(totalGasWei));
  const totalGasUsdt = totalGasPol * polUsdt;
  const initialTotal = formatUsdt(initial.totalRaw);
  const finalTotal = formatUsdt(current.totalRaw);
  const grossGrowth = finalTotal - initialTotal;
  const netGrowth = grossGrowth - totalGasUsdt;
  return {
    cycles,
    blocks: currentBlock - initialBlock,
    trades: cycles * 7,
    priceMultiple: Number(current.price) / Number(initial.price),
    supplyChangePct: (Number(currentSupply) / Number(initialSupply) - 1) * 100,
    tvlUsdt: formatUsdt(current.tvlRaw),
    robotBalanceUsdt: formatUsdt(current.robotBalanceRaw),
    cbBalanceUsdt: formatUsdt(current.cbBalanceRaw),
    totalTvlRobotCbUsdt: finalTotal,
    grossGrowthUsdt: grossGrowth,
    setupGasPol: Number(ethers.formatEther(setupGasWei)),
    cycleGasPol: Number(ethers.formatEther(cycleGasWei)),
    fullGasPol: totalGasPol,
    fullGasUsdt: totalGasUsdt,
    netGrowthAfterGasUsdt: netGrowth,
    gasCoverageMultiple: totalGasUsdt > 0 ? grossGrowth / totalGasUsdt : null,
    solvent: netGrowth > 0,
    oneUsdtGasBudgetCovered: totalGasUsdt < 1,
  };
}

describe("SYNERGY bullish CB cumulative Polygon fork grid", function () {
  this.timeout(2_400_000);

  it("runs checkpoints 15/50/100/250/500 using only TVL + robot + CB versus gas", async function () {
    assert.equal(Number((await provider.getNetwork()).chainId), 137);
    const owner = new ethers.NonceManager(ethers.Wallet.fromPhrase(DEV_MNEMONIC).connect(provider));
    const usdt = await fundFixture(owner);
    const { token, controller, pool, setupGasWei } = await deploySystem(owner, usdt);
    const polUsdt = await polPriceUsdt();
    const initialBlock = await rawBlockNumber();
    const initialSupply = await token.totalSupply();
    const initial = await snapshotValue(token, controller, pool, usdt);

    let cycleGasWei = 0n;
    let completedCycles = 0;
    let stopReason = null;
    const grid = [];

    for (let i = 0; i < CHECKPOINTS[CHECKPOINTS.length - 1]; i += 1) {
      try {
        const block = await provider.getBlock("latest");
        const tx = await controller.executeCycle(i, block.timestamp + 3600, 2_000_000n, GAS);
        const receipt = await tx.wait();
        cycleGasWei += receiptCost(receipt);
        completedCycles = i + 1;
        await mineBlocks(9);
      } catch (error) {
        stopReason = String(error);
        break;
      }

      if (CHECKPOINTS.includes(completedCycles)) {
        const current = await snapshotValue(token, controller, pool, usdt);
        const currentSupply = await token.totalSupply();
        const currentBlock = await rawBlockNumber();
        const row = checkpointRow(
          completedCycles,
          initial,
          current,
          initialSupply,
          currentSupply,
          setupGasWei,
          cycleGasWei,
          polUsdt,
          initialBlock,
          currentBlock,
        );
        grid.push(row);
        console.log("GRID_POINT", JSON.stringify(row));
      }
    }

    const reached = new Set(grid.map((row) => row.cycles));
    const missing = CHECKPOINTS.filter((n) => !reached.has(n));
    const best = grid.length > 0
      ? grid.reduce((a, b) => (b.gasCoverageMultiple > a.gasCoverageMultiple ? b : a))
      : null;
    const report = {
      scenario: "SYNERGY_BULLISH_CB_CUMULATIVE_FORK_GRID_V1",
      criterion: "DELTA_TVL_PLUS_ROBOT_BALANCE_PLUS_CB_BALANCE_GREATER_THAN_GAS",
      chainId: 137,
      forkBlockConfigured: Number(process.env.FORK_BLOCK_NUMBER || 0),
      checkpointsRequested: CHECKPOINTS,
      completedCycles,
      stoppedEarly: completedCycles < CHECKPOINTS[CHECKPOINTS.length - 1],
      stopReason,
      missingCheckpoints: missing,
      initial: {
        tvlUsdt: formatUsdt(initial.tvlRaw),
        robotBalanceUsdt: formatUsdt(initial.robotBalanceRaw),
        cbBalanceUsdt: formatUsdt(initial.cbBalanceRaw),
        totalTvlRobotCbUsdt: formatUsdt(initial.totalRaw),
        priceX18: initial.price.toString(),
        supply: initialSupply.toString(),
      },
      polPriceUsdt: polUsdt,
      setupGasPol: Number(ethers.formatEther(setupGasWei)),
      grid,
      bestCheckpointByGasCoverage: best,
    };

    fs.mkdirSync(path.join(process.cwd(), "reports"), { recursive: true });
    fs.writeFileSync(
      path.join(process.cwd(), "reports", "bullish_cb_microcycle_polygon_fork_grid.json"),
      JSON.stringify(report, null, 2),
    );

    assert(grid.some((row) => row.cycles === 15), "15-cycle checkpoint was not reached");
  });
});
