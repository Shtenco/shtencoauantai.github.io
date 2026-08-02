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

describe("SYNERGY bullish CB microcycle on pinned Polygon fork", function () {
  it("runs 15 atomic cycles over 150 blocks and blocks mainnet on strict economics", async function () {
    const chainId = Number((await provider.getNetwork()).chainId);
    assert.equal(chainId, 137);
    const owner = new ethers.NonceManager(ethers.Wallet.fromPhrase(DEV_MNEMONIC).connect(provider));
    const usdt = await fundFixture(owner);
    const { token, controller, pool, setupGasWei } = await deploySystem(owner, usdt);

    const initialBlock = await provider.getBlockNumber();
    const initialPrice = await pool.priceX18();
    const initialSupply = await token.totalSupply();
    const initialHardNav = await controller.hardNavUsdt();
    const initialPoolUsdt = await usdt.balanceOf(await pool.getAddress());
    assert.equal(initialHardNav, 2_000_000n);

    let cycleGasWei = 0n;
    const cycles = [];
    for (let i = 0; i < 15; i += 1) {
      const block = await provider.getBlock("latest");
      const tx = await controller.executeCycle(i, block.timestamp + 3600, 2_000_000n, GAS);
      const receipt = await tx.wait();
      cycleGasWei += receiptCost(receipt);
      cycles.push({
        cycle: i + 1,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        effectiveGasPriceWei: (receipt.gasPrice ?? 0n).toString(),
        priceX18: (await pool.priceX18()).toString(),
        supply: (await token.totalSupply()).toString(),
        hardNavUsdtRaw: (await controller.hardNavUsdt()).toString(),
      });
      await mineBlocks(9);
    }

    const finalBlock = await provider.getBlockNumber();
    const finalPrice = await pool.priceX18();
    const finalSupply = await token.totalSupply();
    const finalHardNav = await controller.hardNavUsdt();
    const finalPoolUsdt = await usdt.balanceOf(await pool.getAddress());
    const controllerUsdt = await usdt.balanceOf(await controller.getAddress());
    const totalGasWei = setupGasWei + cycleGasWei;
    const polUsdt = await polPriceUsdt();
    const setupGasPol = Number(ethers.formatEther(setupGasWei));
    const cycleGasPol = Number(ethers.formatEther(cycleGasWei));
    const totalGasPol = Number(ethers.formatEther(totalGasWei));
    const totalGasUsdt = totalGasPol * polUsdt;
    const grossTvlInitial = Number(ethers.formatUnits(initialPoolUsdt * 2n, 6));
    const grossTvlFinal = Number(ethers.formatUnits(finalPoolUsdt * 2n, 6));
    const hardNavInitialIncludingGas = 3.0;
    const hardNavFinalIncludingGas = Number(ethers.formatUnits(finalHardNav, 6)) + Math.max(0, 1.0 - totalGasUsdt);
    const hardNavDelta = hardNavFinalIncludingGas - hardNavInitialIncludingGas;

    assert.equal(finalBlock - initialBlock, 150);
    assert(finalPrice > initialPrice, "price did not rise");
    assert(finalSupply < initialSupply, "supply did not contract");
    assert.equal(finalHardNav, initialHardNav);
    assert.equal(controllerUsdt + finalPoolUsdt, 2_000_000n);
    assert(totalGasUsdt < 1.0, `full setup + run gas exceeded 1 USDT: ${totalGasUsdt}`);
    assert(hardNavDelta < 0.0, "internal activity invented external value");

    const report = {
      scenario: "SYNERGY_BULLISH_CB_MICROCYCLE_V1_POLYGON_FORK",
      evidenceClass: "STRUCTURAL_FORK_REAL_USDT_REAL_GAS_FIXTURE_FUNDING",
      chainId,
      forkBlockConfigured: Number(process.env.FORK_BLOCK_NUMBER || 0),
      coveredBlocks: finalBlock - initialBlock,
      cycles: 15,
      trades: 105,
      startingCapital: {
        cbAndRobotUsdt: 1,
        poolUsdt: 1,
        gasBudgetUsdt: 1,
        fixtureSource: FIXTURE_DONOR,
        fixtureIsRevenue: false,
      },
      price: {
        initialX18: initialPrice.toString(),
        finalX18: finalPrice.toString(),
        multiple: Number(finalPrice) / Number(initialPrice),
      },
      supply: {
        initial: initialSupply.toString(),
        final: finalSupply.toString(),
        changePct: (Number(finalSupply) / Number(initialSupply) - 1) * 100,
      },
      tvl: {
        grossInitialUsdt: grossTvlInitial,
        grossFinalUsdt: grossTvlFinal,
        grossChangeUsdt: grossTvlFinal - grossTvlInitial,
        organicExternalChangeUsdt: 0,
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
        oneUsdtBudgetCovered: totalGasUsdt < 1,
      },
      accounting: {
        hardNavBeforeGasUsdt: Number(ethers.formatUnits(finalHardNav, 6)),
        externalRevenueUsdt: 0,
        hardNavInitialIncludingGasUsdt: hardNavInitialIncludingGas,
        hardNavFinalIncludingRemainingGasUsdt: hardNavFinalIncludingGas,
        hardNavDeltaUsdt: hardNavDelta,
      },
      protections: {
        atomicSevenTradeBatch: true,
        poolControllerOnly: true,
        zeroPriceGuard: true,
        nonce: true,
        deadline: true,
        hardNavGate: true,
        publicIntermediateState: false,
      },
      strictVerdict: "FAIL_NO_EXTERNAL_VALUE",
      mainnetGate: "BLOCKED_BY_FORK_ECONOMICS",
      cyclesDetail: cycles,
    };
    fs.mkdirSync(path.join(process.cwd(), "reports"), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), "reports", "bullish_cb_microcycle_polygon_fork.json"), JSON.stringify(report, null, 2));
  });

  it("rejects public calls, replay, stale deadline and invented NAV", async function () {
    const owner = new ethers.NonceManager(ethers.Wallet.fromPhrase(DEV_MNEMONIC).connect(provider));
    const attacker = ethers.Wallet.createRandom().connect(provider);
    const attackerAddress = await attacker.getAddress();
    await rpc("anvil_setBalance", [attackerAddress, "0x3635c9adc5dea00000"]);
    const usdt = await fundFixture(owner);
    const { controller, pool } = await deploySystem(owner, usdt);
    await expectRevert(pool.connect(attacker).buyWithNetUsdt(1n, 1n), "CONTROLLER");
    const block = await provider.getBlock("latest");
    await expectRevert(controller.executeCycle(1, block.timestamp + 100, 2_000_000n, GAS), "NONCE");
    await expectRevert(controller.executeCycle(0, block.timestamp - 1, 2_000_000n, GAS), "DEADLINE");
    await expectRevert(controller.executeCycle(0, block.timestamp + 100, 2_000_001n, GAS), "HARD_NAV_LOSS");
  });
});
