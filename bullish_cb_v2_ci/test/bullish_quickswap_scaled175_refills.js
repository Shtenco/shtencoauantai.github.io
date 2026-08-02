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
const ERC20 = ["function transfer(address,uint256) returns(bool)", "function approve(address,uint256) returns(bool)"];

async function rpc(method, params = []) { return provider.send(method, params); }
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

async function deployFixture() {
  const owner = new ethers.NonceManager(ethers.Wallet.fromPhrase(DEV_MNEMONIC).connect(provider));
  const ownerAddress = await owner.getAddress();
  assert.equal((await new ethers.Contract(ROUTER, ["function factory() view returns(address)"], provider).factory()).toLowerCase(), FACTORY);
  await fundUsdt(ownerAddress, 3_000_000n);
  const tokenArtifact = await hre.artifacts.readArtifact("RebaseSynaExactV3");
  const controllerArtifact = await hre.artifacts.readArtifact("BullishQuickSwapScaled175");
  const token = await new ethers.ContractFactory(tokenArtifact.abi, tokenArtifact.bytecode, owner).deploy(ownerAddress);
  await token.deploymentTransaction().wait();
  const controller = await new ethers.ContractFactory(controllerArtifact.abi, controllerArtifact.bytecode, owner)
    .deploy(ownerAddress, ROUTER, USDT, WPOL, await token.getAddress());
  await controller.deploymentTransaction().wait();
  await (await token.setController(await controller.getAddress())).wait();
  const usdt = new ethers.Contract(USDT, ERC20, owner);
  await (await usdt.approve(await controller.getAddress(), 2_000_000n)).wait();
  const block = await provider.getBlock("latest");
  await (await controller.initialize(
    ethers.parseEther("1000000"),
    ethers.parseEther("500000"),
    1_000_000n,
    1_000_000n,
    block.timestamp + 3600,
    { gasLimit: GAS_LIMIT }
  )).wait();
  return controller;
}

describe("BullishQuickSwapScaled175 focused refill regression", function () {
  this.timeout(600000);

  it("preserves bounded robot refill and exact POL refill", async function () {
    const controller = await deployFixture();
    await (await controller.setRefillConfig(1_040_000n, 0, 100, 500, 10)).wait();
    const robotBefore = await controller.robotUsdt();
    const block0 = await provider.getBlock("latest");
    const robotReceipt = await (await controller.refillRobotCapital(
      1_040_000n,
      block0.timestamp + 3600,
      { gasLimit: 5_000_000n }
    )).wait();
    const robotAfter = await controller.robotUsdt();
    const robotRefillEvents = countEvent(controller, robotReceipt, "RobotRefill");
    assert(robotRefillEvents > 0, "robot refill event missing");
    assert(robotAfter > robotBefore, "robot capital did not increase");

    const block1 = await provider.getBlock("latest");
    await (await controller.executeScaledCycle(
      0,
      block1.timestamp + 3600,
      0,
      { gasLimit: GAS_LIMIT }
    )).wait();

    const router = new ethers.Contract(
      ROUTER,
      ["function getAmountsIn(uint256,address[]) view returns(uint256[] memory)"],
      provider
    );
    const exactPol = ethers.parseEther("0.001");
    const quote = await router.getAmountsIn(exactPol, [USDT, WPOL]);
    const maxUsdt = quote[0] * 10100n / 10000n + 1n;
    const treasuryBefore = await controller.treasuryUsdt();
    assert(treasuryBefore >= maxUsdt, "treasury cannot fund POL refill");
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
      scenario: "BULLISH_QUICKSWAP_SCALED175_REFILLS",
      chainId: 137,
      forkBlock: Number(process.env.FORK_BLOCK_NUMBER || 0),
      robotRefillEvents,
      gasRefillEvents,
      robotUsdtBefore: Number(ethers.formatUnits(robotBefore, 6)),
      robotUsdtAfter: Number(ethers.formatUnits(robotAfter, 6)),
      treasuryBeforeGasRefillUsdt: Number(ethers.formatUnits(treasuryBefore, 6)),
      gasRefillPol: Number(ethers.formatEther(exactPol)),
      gasRefillSpentUsdt: Number(ethers.formatUnits(await controller.cumulativeGasRefillUsdt(), 6)),
      verdict: "PASS_BOUNDED_ROBOT_AND_EXACT_POL_REFILL"
    };
    fs.mkdirSync(path.join(process.cwd(), "reports", "scaled175-refills"), { recursive: true });
    fs.writeFileSync(
      path.join(process.cwd(), "reports", "scaled175-refills", "refills.json"),
      JSON.stringify(report, null, 2)
    );
    console.log("SCALED175_REFILLS", JSON.stringify(report));
  });
});
