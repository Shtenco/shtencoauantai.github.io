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
const GAS_LIMIT = 8_000_000n;
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

async function rpc(method, params = []) { return provider.send(method, params); }
async function mineBlocks(count) { await rpc("anvil_mine", [`0x${count.toString(16)}`]); }
function cost(receipt) { return receipt.gasUsed * (receipt.gasPrice || 0n); }

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
  await (await new ethers.Contract(USDT, ERC20, donor).transfer(ownerAddress, amount)).wait();
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
  const owner = new ethers.NonceManager(ethers.Wallet.fromPhrase(DEV_MNEMONIC).connect(provider));
  const ownerAddress = await owner.getAddress();
  for (const address of [ROUTER, FACTORY, USDT, WPOL]) {
    assert.notEqual(await provider.getCode(address), "0x", `missing code ${address}`);
  }
  const routerCheck = new ethers.Contract(
    ROUTER,
    ["function factory() view returns(address)", "function WETH() view returns(address)"],
    provider
  );
  assert.equal((await routerCheck.factory()).toLowerCase(), FACTORY);
  assert.equal((await routerCheck.WETH()).toLowerCase(), WPOL);
  await fundUsdt(ownerAddress, 3_000_000n);

  const tokenArtifact = await hre.artifacts.readArtifact("RebaseSynaExactV3");
  const controllerArtifact = await hre.artifacts.readArtifact("BullishQuickSwapScaled150");
  let setupGas = 0n;

  const token = await new ethers.ContractFactory(tokenArtifact.abi, tokenArtifact.bytecode, owner).deploy(ownerAddress);
  setupGas += cost(await token.deploymentTransaction().wait());
  const controller = await new ethers.ContractFactory(controllerArtifact.abi, controllerArtifact.bytecode, owner)
    .deploy(ownerAddress, ROUTER, USDT, WPOL, await token.getAddress());
  setupGas += cost(await controller.deploymentTransaction().wait());
  setupGas += cost(await (await token.setController(await controller.getAddress())).wait());

  const usdt = new ethers.Contract(USDT, ERC20, owner);
  setupGas += cost(await (await usdt.approve(await controller.getAddress(), 2_000_000n)).wait());
  const block = await provider.getBlock("latest");
  setupGas += cost(await (await controller.initialize(
    ethers.parseEther("1000000"),
    ethers.parseEther("500000"),
    1_000_000n,
    1_000_000n,
    block.timestamp + 3600,
    { gasLimit: GAS_LIMIT }
  )).wait());

  assert.equal(await controller.DEAL_SCALE_BPS(), 15_000n);
  assert.equal(await controller.SCALED_BUY_USDT(), 150_000n);
  assert.equal(await controller.SCALED_SELL_NOTIONAL_USDT(), 60_000n);
  return { owner, ownerAddress, token, controller, setupGas };
}

async function executeTen(controller) {
  let runtimeGas = 0n;
  for (let i = 0; i < 10; i += 1) {
    const block = await provider.getBlock("latest");
    const receipt = await (await controller.executeScaledCycle(
      i,
      block.timestamp + 3600,
      0,
      { gasLimit: GAS_LIMIT }
    )).wait();
    runtimeGas += cost(receipt);
    assert.equal(countEvent(controller, receipt, "ScaledCycleExecuted"), 1);
    await mineBlocks(9);
  }
  return runtimeGas;
}

describe("BullishQuickSwapScaled150 exact confirmation", function () {
  this.timeout(600000);

  it("covers full setup and runtime gas with a robust margin", async function () {
    const { controller, setupGas } = await deployFixture();
    const initialMetric = await controller.systemMetricUsdt();
    const initialPrice = await controller.spotPriceX18();
    const runtimeGas = await executeTen(controller);
    const finalMetric = await controller.systemMetricUsdt();
    const finalPrice = await controller.spotPriceX18();
    const fullGasPol = Number(ethers.formatEther(setupGas + runtimeGas));
    const fullGasUsdt = fullGasPol * await polPriceUsdt();
    const gross = Number(ethers.formatUnits(finalMetric - initialMetric, 6));
    const net = gross - fullGasUsdt;
    const coverage = gross / fullGasUsdt;
    const netAt150PctGas = gross - fullGasUsdt * 1.5;
    const netAt200PctGas = gross - fullGasUsdt * 2.0;

    const report = {
      scenario: "BULLISH_QUICKSWAP_SCALED150_CONFIRM",
      chainId: 137,
      forkBlock: Number(process.env.FORK_BLOCK_NUMBER || 0),
      cycles: 10,
      trades: 70,
      dealScaleBps: 15000,
      buyUsdt: 0.15,
      sellNotionalUsdt: 0.06,
      initialPoolUsdt: 1,
      initialRobotUsdt: 1,
      initialMetricUsdt: Number(ethers.formatUnits(initialMetric, 6)),
      finalMetricUsdt: Number(ethers.formatUnits(finalMetric, 6)),
      grossGrowthUsdt: gross,
      setupGasPol: Number(ethers.formatEther(setupGas)),
      runtimeGasPol: Number(ethers.formatEther(runtimeGas)),
      fullGasPol,
      fullGasUsdt,
      netGrowthAfterGasUsdt: net,
      gasCoverageMultiple: coverage,
      netAt150PctGasUsdt: netAt150PctGas,
      netAt200PctGasUsdt: netAt200PctGas,
      priceMultiple: Number(finalPrice) / Number(initialPrice),
      verdict: net > 0 && coverage >= 1.5 ? "PASS_ROBUST_POSITIVE_FIRST_10" : "STOP_NON_ROBUST"
    };
    fs.mkdirSync(path.join(process.cwd(), "reports", "scaled150"), { recursive: true });
    fs.writeFileSync(
      path.join(process.cwd(), "reports", "scaled150", "first10.json"),
      JSON.stringify(report, null, 2)
    );
    console.log("SCALED150_FIRST10", JSON.stringify(report));
    assert(net > 0, "net after complete gas is non-positive");
    assert(coverage >= 1.5, `gas coverage below robust threshold: ${coverage}`);
    assert(netAt150PctGas > 0, "fails +50% gas stress");
  });

  it("preserves bounded robot refill and exact POL gas refill", async function () {
    const { controller } = await deployFixture();
    await (await controller.setRefillConfig(1_040_000n, 0, 100, 500, 10)).wait();
    const robotBefore = await controller.robotUsdt();
    const block0 = await provider.getBlock("latest");
    const refillReceipt = await (await controller.refillRobotCapital(
      1_040_000n,
      block0.timestamp + 3600,
      { gasLimit: 5_000_000n }
    )).wait();
    const robotAfter = await controller.robotUsdt();
    const robotRefillEvents = countEvent(controller, refillReceipt, "RobotRefill");
    assert(robotRefillEvents > 0);
    assert(robotAfter > robotBefore);

    const block1 = await provider.getBlock("latest");
    await (await controller.executeScaledCycle(0, block1.timestamp + 3600, 0, { gasLimit: GAS_LIMIT })).wait();

    const router = new ethers.Contract(
      ROUTER,
      ["function getAmountsIn(uint256,address[]) view returns(uint256[] memory)"],
      provider
    );
    const exactPol = ethers.parseEther("0.001");
    const quote = await router.getAmountsIn(exactPol, [USDT, WPOL]);
    const maxUsdt = quote[0] * 10100n / 10000n + 1n;
    const treasuryBefore = await controller.treasuryUsdt();
    assert(treasuryBefore >= maxUsdt, "treasury cannot fund exact POL refill");
    const block2 = await provider.getBlock("latest");
    const gasReceipt = await (await controller.refillKeeperGas(
      exactPol,
      maxUsdt,
      block2.timestamp + 3600,
      { gasLimit: 2_000_000n }
    )).wait();
    const gasRefillEvents = countEvent(controller, gasReceipt, "KeeperGasRefill");
    assert.equal(gasRefillEvents, 1);

    const report = {
      scenario: "BULLISH_QUICKSWAP_SCALED150_REFILLS",
      robotRefillEvents,
      gasRefillEvents,
      robotUsdtBefore: Number(ethers.formatUnits(robotBefore, 6)),
      robotUsdtAfter: Number(ethers.formatUnits(robotAfter, 6)),
      gasRefillPol: Number(ethers.formatEther(exactPol)),
      gasRefillSpentUsdt: Number(ethers.formatUnits(await controller.cumulativeGasRefillUsdt(), 6)),
      treasuryBeforeGasRefillUsdt: Number(ethers.formatUnits(treasuryBefore, 6)),
      verdict: "PASS_BOUNDED_ROBOT_AND_EXACT_GAS_REFILL"
    };
    fs.mkdirSync(path.join(process.cwd(), "reports", "scaled150"), { recursive: true });
    fs.writeFileSync(
      path.join(process.cwd(), "reports", "scaled150", "refills.json"),
      JSON.stringify(report, null, 2)
    );
    console.log("SCALED150_REFILLS", JSON.stringify(report));
  });
});
