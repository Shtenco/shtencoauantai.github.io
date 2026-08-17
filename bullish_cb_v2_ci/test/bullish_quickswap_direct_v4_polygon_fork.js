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
async function mine(count) { await rpc("anvil_mine", [`0x${count.toString(16)}`]); }
function cost(receipt) { return receipt.gasUsed * (receipt.gasPrice || 0n); }

function eventCount(contract, receipt, name) {
  let count = 0;
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed && parsed.name === name) count += 1;
    } catch (_) {}
  }
  return count;
}

async function fundUsdt(address, amount) {
  await rpc("anvil_setBalance", [address, "0x152d02c7e14af6800000"]);
  await rpc("anvil_setBalance", [WPOL_USDT_PAIR, "0x3635c9adc5dea00000"]);
  await rpc("anvil_impersonateAccount", [WPOL_USDT_PAIR]);
  const donor = await provider.getSigner(WPOL_USDT_PAIR);
  await (await new ethers.Contract(USDT, ERC20, donor).transfer(address, amount)).wait();
  await rpc("anvil_stopImpersonatingAccount", [WPOL_USDT_PAIR]);
}

async function polPriceUsdt() {
  const pair = new ethers.Contract(WPOL_USDT_PAIR, PAIR, provider);
  const [t0, t1, r] = await Promise.all([pair.token0(), pair.token1(), pair.getReserves()]);
  let u;
  let p;
  if (t0.toLowerCase() === USDT && t1.toLowerCase() === WPOL) {
    u = r[0]; p = r[1];
  } else {
    assert.equal(t1.toLowerCase(), USDT);
    assert.equal(t0.toLowerCase(), WPOL);
    u = r[1]; p = r[0];
  }
  return Number(ethers.formatUnits(u, 6)) / Number(ethers.formatEther(p));
}

async function deploy() {
  const owner = new ethers.NonceManager(ethers.Wallet.fromPhrase(DEV_MNEMONIC).connect(provider));
  const ownerAddress = await owner.getAddress();
  assert.equal((await new ethers.Contract(ROUTER, ["function factory() view returns(address)"], provider).factory()).toLowerCase(), FACTORY);
  await fundUsdt(ownerAddress, 3_000_000n);

  const tokenArtifact = await hre.artifacts.readArtifact("RebaseSynaExactV3");
  const controllerArtifact = await hre.artifacts.readArtifact("BullishQuickSwapDirectV4");
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
    ethers.parseEther("1000000"), ethers.parseEther("500000"), 1_000_000n, 1_000_000n,
    block.timestamp + 3600, { gasLimit: GAS_LIMIT }
  )).wait());
  return { owner, controller, setupGas };
}

async function cycles(controller, count) {
  let gas = 0n;
  for (let i = 0; i < count; i += 1) {
    const block = await provider.getBlock("latest");
    const receipt = await (await controller.executeCycle(i, block.timestamp + 3600, 0, { gasLimit: GAS_LIMIT })).wait();
    gas += cost(receipt);
    await mine(9);
  }
  return gas;
}

describe("Bullish QuickSwap direct-pair V4", function () {
  this.timeout(600000);

  it("passes the first-ten full-gas solvency criterion", async function () {
    const { controller, setupGas } = await deploy();
    const initialMetric = await controller.systemMetricUsdt();
    const initialPrice = await controller.spotPriceX18();
    const cycleGas = await cycles(controller, 10);
    const finalMetric = await controller.systemMetricUsdt();
    const finalPrice = await controller.spotPriceX18();
    const setupGasPol = Number(ethers.formatEther(setupGas));
    const cycleGasPol = Number(ethers.formatEther(cycleGas));
    const fullGasPol = setupGasPol + cycleGasPol;
    const fullGasUsdt = fullGasPol * await polPriceUsdt();
    const grossGrowth = Number(ethers.formatUnits(finalMetric - initialMetric, 6));
    const net = grossGrowth - fullGasUsdt;
    const report = {
      scenario: "BULLISH_QUICKSWAP_DIRECT_V4_FIRST10_POLYGON_FORK",
      chainId: 137,
      forkBlock: Number(process.env.FORK_BLOCK_NUMBER || 0),
      cycles: 10,
      trades: 70,
      initialMetricUsdt: Number(ethers.formatUnits(initialMetric, 6)),
      finalMetricUsdt: Number(ethers.formatUnits(finalMetric, 6)),
      grossGrowthUsdt: grossGrowth,
      setupGasPol,
      cycleGasPol,
      fullGasPol,
      fullGasUsdt,
      netGrowthAfterGasUsdt: net,
      priceMultiple: Number(finalPrice) / Number(initialPrice),
      verdict: net > 0 ? "PASS_POSITIVE_FIRST_10" : "STOP_FIRST_10_NON_POSITIVE"
    };
    fs.mkdirSync(path.join(process.cwd(), "reports"), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), "reports", "bullish_qs_v2_first10_fork.json"), JSON.stringify(report, null, 2));
    console.log("FIRST10_RESULT", JSON.stringify(report));
    assert(net > 0, `first ten cycles were not positive: ${net}`);
  });

  it("passes bounded robot and exact POL refills", async function () {
    const { controller } = await deploy();
    await (await controller.setRefillConfig(1_040_000n, 0, 500, 10)).wait();
    const robotBefore = await controller.robotUsdt();
    const b0 = await provider.getBlock("latest");
    const robotReceipt = await (await controller.refillRobotCapital(
      1_040_000n, b0.timestamp + 3600, { gasLimit: 5_000_000n }
    )).wait();
    const robotAfter = await controller.robotUsdt();
    const robotEvents = eventCount(controller, robotReceipt, "RobotRefill");
    assert(robotEvents > 0 && robotAfter > robotBefore);

    const b1 = await provider.getBlock("latest");
    await (await controller.executeCycle(0, b1.timestamp + 3600, 0, { gasLimit: GAS_LIMIT })).wait();
    const router = new ethers.Contract(ROUTER, ["function getAmountsIn(uint256,address[]) view returns(uint256[] memory)"], provider);
    const exactPol = ethers.parseEther("0.001");
    const quote = await router.getAmountsIn(exactPol, [USDT, WPOL]);
    const maxUsdt = quote[0] * 10100n / 10000n + 1n;
    const treasuryBefore = await controller.treasuryUsdt();
    assert(treasuryBefore >= maxUsdt);
    const b2 = await provider.getBlock("latest");
    const gasReceipt = await (await controller.refillKeeperGas(
      exactPol, maxUsdt, b2.timestamp + 3600, { gasLimit: 2_000_000n }
    )).wait();
    const gasEvents = eventCount(controller, gasReceipt, "GasRefill");
    assert.equal(gasEvents, 1);

    const report = {
      scenario: "BULLISH_QUICKSWAP_DIRECT_V4_REFILL_POLYGON_FORK",
      cycles: 1,
      robotRefillEvents: robotEvents,
      gasRefillEvents: gasEvents,
      robotUsdtBefore: Number(ethers.formatUnits(robotBefore, 6)),
      robotUsdtAfter: Number(ethers.formatUnits(robotAfter, 6)),
      treasuryBeforeGasRefillUsdt: Number(ethers.formatUnits(treasuryBefore, 6)),
      gasRefillSpentUsdt: Number(ethers.formatUnits(await controller.cumulativeGasRefillUsdt(), 6)),
      gasRefillPol: Number(ethers.formatEther(exactPol)),
      tvlUsdt: Number(ethers.formatUnits(await controller.poolTvlUsdt(), 6)),
      systemMetricUsdt: Number(ethers.formatUnits(await controller.systemMetricUsdt(), 6)),
      verdict: "PASS_BOUNDED_ROBOT_AND_GAS_REFILL"
    };
    fs.writeFileSync(path.join(process.cwd(), "reports", "bullish_qs_v2_refill_fork.json"), JSON.stringify(report, null, 2));
    console.log("REFILL_RESULT", JSON.stringify(report));
  });
});
