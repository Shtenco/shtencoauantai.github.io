const assert = require("assert");
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;

const provider = new ethers.JsonRpcProvider(process.env.LOCAL_FORK_URL || "http://127.0.0.1:8545");
const ROUTER = "0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff";
const FACTORY = "0x5757371414417b8c6caad45baef941abc7d3ab32";
const USDT = "0xc2132d05d31c914a87c6611c10748aeb04b58e8f";
const WPOL = "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270";
const WPOL_USDT_PAIR = "0x604229c960e5cacf2aaeac8be68ac07ba9df81c3";
const DEV_MNEMONIC = "test test test test test test test test test test test junk";
const CYCLE_GAS_LIMIT = 8_000_000n;
const ERC20 = [
  "function balanceOf(address) view returns(uint256)",
  "function transfer(address,uint256) returns(bool)",
  "function approve(address,uint256) returns(bool)"
];
const PAIR = [
  "function token0() view returns(address)",
  "function token1() view returns(address)",
  "function getReserves() view returns(uint112,uint112,uint32)"
];

async function rpc(method, params = []) {
  return provider.send(method, params);
}

async function mineBlocks(count) {
  await rpc("anvil_mine", [`0x${count.toString(16)}`]);
}

function receiptCost(receipt) {
  return receipt.gasUsed * (receipt.gasPrice || 0n);
}

function countEvent(contract, receipt, name) {
  let count = 0;
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed && parsed.name === name) count += 1;
    } catch (_) {}
  }
  return count;
}

async function fundUsdt(ownerAddress, amount) {
  await rpc("anvil_setBalance", [ownerAddress, "0x152d02c7e14af6800000"]);
  await rpc("anvil_setBalance", [WPOL_USDT_PAIR, "0x3635c9adc5dea00000"]);
  await rpc("anvil_impersonateAccount", [WPOL_USDT_PAIR]);
  const donor = await provider.getSigner(WPOL_USDT_PAIR);
  const token = new ethers.Contract(USDT, ERC20, donor);
  await (await token.transfer(ownerAddress, amount)).wait();
  await rpc("anvil_stopImpersonatingAccount", [WPOL_USDT_PAIR]);
}

async function polPriceUsdt() {
  const pair = new ethers.Contract(WPOL_USDT_PAIR, PAIR, provider);
  const [token0, token1, reserves] = await Promise.all([pair.token0(), pair.token1(), pair.getReserves()]);
  let usdtReserve;
  let polReserve;
  if (token0.toLowerCase() === USDT && token1.toLowerCase() === WPOL) {
    usdtReserve = reserves[0];
    polReserve = reserves[1];
  } else {
    assert.equal(token1.toLowerCase(), USDT);
    assert.equal(token0.toLowerCase(), WPOL);
    usdtReserve = reserves[1];
    polReserve = reserves[0];
  }
  return Number(ethers.formatUnits(usdtReserve, 6)) / Number(ethers.formatEther(polReserve));
}

async function deployFixture() {
  const baseWallet = ethers.Wallet.fromPhrase(DEV_MNEMONIC).connect(provider);
  const owner = new ethers.NonceManager(baseWallet);
  const ownerAddress = await owner.getAddress();
  for (const address of [ROUTER, FACTORY, USDT, WPOL]) {
    assert.notEqual(await provider.getCode(address), "0x", `missing code ${address}`);
  }
  const routerCheck = new ethers.Contract(ROUTER, ["function factory() view returns(address)", "function WETH() view returns(address)"], provider);
  assert.equal((await routerCheck.factory()).toLowerCase(), FACTORY);
  assert.equal((await routerCheck.WETH()).toLowerCase(), WPOL);
  await fundUsdt(ownerAddress, 3_000_000n);

  const tokenArtifact = await hre.artifacts.readArtifact("RebaseSynaV2");
  const controllerArtifact = await hre.artifacts.readArtifact("BullishQuickSwapCentralBankV2");
  let setupGas = 0n;

  const Token = new ethers.ContractFactory(tokenArtifact.abi, tokenArtifact.bytecode, owner);
  const token = await Token.deploy(ownerAddress);
  setupGas += receiptCost(await token.deploymentTransaction().wait());

  const Controller = new ethers.ContractFactory(controllerArtifact.abi, controllerArtifact.bytecode, owner);
  const controller = await Controller.deploy(ownerAddress, ROUTER, USDT, WPOL, await token.getAddress());
  setupGas += receiptCost(await controller.deploymentTransaction().wait());

  setupGas += receiptCost(await (await token.setController(await controller.getAddress())).wait());
  const usdt = new ethers.Contract(USDT, ERC20, owner);
  setupGas += receiptCost(await (await usdt.approve(await controller.getAddress(), 2_000_000n)).wait());
  const block = await provider.getBlock("latest");
  setupGas += receiptCost(await (
    await controller.initialize(
      ethers.parseEther("1000000"),
      ethers.parseEther("500000"),
      1_000_000n,
      1_000_000n,
      block.timestamp + 3600,
      { gasLimit: CYCLE_GAS_LIMIT }
    )
  ).wait());
  return { owner, ownerAddress, token, controller, setupGas };
}

async function executeCycles(controller, start, end) {
  let gas = 0n;
  let refillEvents = 0;
  for (let i = start; i < end; i += 1) {
    const block = await provider.getBlock("latest");
    const receipt = await (
      await controller.executeCycle(i, block.timestamp + 3600, 0, { gasLimit: CYCLE_GAS_LIMIT })
    ).wait();
    gas += receiptCost(receipt);
    refillEvents += countEvent(controller, receipt, "RobotRefill");
    await mineBlocks(9);
  }
  return { gas, refillEvents };
}

describe("BullishQuickSwapCentralBankV2 exact Polygon fork", function () {
  this.timeout(600000);

  it("makes the first ten cycles positive after full setup and cycle gas", async function () {
    const { controller, setupGas } = await deployFixture();
    const initialMetric = await controller.systemMetricUsdt();
    const initialPrice = await controller.spotPriceX18();
    const cycleRun = await executeCycles(controller, 0, 10);
    const finalMetric = await controller.systemMetricUsdt();
    const finalPrice = await controller.spotPriceX18();
    const fullGasPol = Number(ethers.formatEther(setupGas + cycleRun.gas));
    const fullGasUsdt = fullGasPol * await polPriceUsdt();
    const grossGrowth = Number(ethers.formatUnits(finalMetric - initialMetric, 6));
    const net = grossGrowth - fullGasUsdt;
    const report = {
      scenario: "BULLISH_QUICKSWAP_REFILL_V2_FIRST10_POLYGON_FORK",
      chainId: 137,
      forkBlock: Number(process.env.FORK_BLOCK_NUMBER || 0),
      cycles: 10,
      trades: 70,
      initialMetricUsdt: Number(ethers.formatUnits(initialMetric, 6)),
      finalMetricUsdt: Number(ethers.formatUnits(finalMetric, 6)),
      grossGrowthUsdt: grossGrowth,
      fullGasPol,
      fullGasUsdt,
      netGrowthAfterGasUsdt: net,
      priceMultiple: Number(finalPrice) / Number(initialPrice),
      verdict: net > 0 ? "PASS_POSITIVE_FIRST_10" : "STOP_FIRST_10_NON_POSITIVE"
    };
    fs.mkdirSync(path.join(process.cwd(), "reports"), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), "reports", "bullish_qs_v2_first10_fork.json"), JSON.stringify(report, null, 2));
    console.log("FIRST10_RESULT", JSON.stringify(report));
    assert(finalPrice > initialPrice, "price did not rise");
    assert(net > 0, `first ten cycles were not positive: ${net}`);
  });

  it("executes bounded robot-capital refill and exact POL gas refill", async function () {
    const { controller } = await deployFixture();
    await (await controller.setRefillConfig(1_040_000n, 0, 100, 500, 10)).wait();
    const robotBefore = await controller.robotUsdt();
    const block0 = await provider.getBlock("latest");
    const refillReceipt = await (
      await controller.refillRobotCapital(1_040_000n, block0.timestamp + 3600, { gasLimit: 5_000_000n })
    ).wait();
    const robotRefillEvents = countEvent(controller, refillReceipt, "RobotRefill");
    const robotAfter = await controller.robotUsdt();
    assert(robotRefillEvents > 0, "robot refill event missing");
    assert(robotAfter > robotBefore, "robot USDT did not increase");

    const block1 = await provider.getBlock("latest");
    const cycleReceipt = await (
      await controller.executeCycle(0, block1.timestamp + 3600, 0, { gasLimit: CYCLE_GAS_LIMIT })
    ).wait();
    assert.equal(await controller.nonce(), 1n);

    const router = new ethers.Contract(ROUTER, ["function getAmountsIn(uint256,address[]) view returns(uint256[] memory)"], provider);
    const exactPol = ethers.parseEther("0.001");
    const quote = await router.getAmountsIn(exactPol, [USDT, WPOL]);
    const maxUsdt = quote[0] * 10100n / 10000n + 1n;
    const treasuryBefore = await controller.treasuryUsdt();
    assert(treasuryBefore >= maxUsdt, "treasury did not accumulate enough fees for gas refill");
    const block2 = await provider.getBlock("latest");
    const gasReceipt = await (
      await controller.refillKeeperGas(exactPol, maxUsdt, block2.timestamp + 3600, { gasLimit: 2_000_000n })
    ).wait();
    const gasRefillEvents = countEvent(controller, gasReceipt, "KeeperGasRefill");
    assert.equal(gasRefillEvents, 1);
    assert((await controller.cumulativeGasRefillUsdt()) > 0n);

    const report = {
      scenario: "BULLISH_QUICKSWAP_REFILL_V2_DIRECT_REFILL_FORK",
      cycles: 1,
      robotRefillEvents,
      gasRefillEvents,
      robotUsdtBefore: Number(ethers.formatUnits(robotBefore, 6)),
      robotUsdtAfter: Number(ethers.formatUnits(robotAfter, 6)),
      treasuryBeforeGasRefillUsdt: Number(ethers.formatUnits(treasuryBefore, 6)),
      gasRefillSpentUsdt: Number(ethers.formatUnits(await controller.cumulativeGasRefillUsdt(), 6)),
      gasRefillPol: Number(ethers.formatEther(exactPol)),
      tvlUsdt: Number(ethers.formatUnits(await controller.poolTvlUsdt(), 6)),
      systemMetricUsdt: Number(ethers.formatUnits(await controller.systemMetricUsdt(), 6)),
      cycleGasUsed: cycleReceipt.gasUsed.toString(),
      verdict: "PASS_BOUNDED_ROBOT_AND_GAS_REFILL"
    };
    fs.mkdirSync(path.join(process.cwd(), "reports"), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), "reports", "bullish_qs_v2_refill_fork.json"), JSON.stringify(report, null, 2));
    console.log("REFILL_RESULT", JSON.stringify(report));
  });
});
