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
  const controllerArtifact = await hre.artifacts.readArtifact("BullishQuickSwapScaled175");
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

  assert.equal(await controller.DEAL_SCALE_BPS(), 17_500n);
  assert.equal(await controller.SCALED_BUY_USDT(), 175_000n);
  assert.equal(await controller.SCALED_SELL_NOTIONAL_USDT(), 70_000n);
  return { controller, setupGas };
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
    await mineBlocks(9);
  }
  return runtimeGas;
}

describe("BullishQuickSwapScaled175 exact first-ten", function () {
  this.timeout(600000);

  it("covers complete gas with robust margin", async function () {
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

    const report = {
      scenario: "BULLISH_QUICKSWAP_SCALED175_FIRST10",
      chainId: 137,
      forkBlock: Number(process.env.FORK_BLOCK_NUMBER || 0),
      cycles: 10,
      trades: 70,
      dealScaleBps: 17500,
      buyUsdt: 0.175,
      sellNotionalUsdt: 0.07,
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
      priceMultiple: Number(finalPrice) / Number(initialPrice),
      verdict: net > 0 && coverage >= 1.5 && netAt150PctGas > 0
        ? "PASS_ROBUST_POSITIVE_FIRST_10"
        : "STOP_NON_ROBUST"
    };

    fs.mkdirSync(path.join(process.cwd(), "reports", "scaled175"), { recursive: true });
    fs.writeFileSync(
      path.join(process.cwd(), "reports", "scaled175", "first10.json"),
      JSON.stringify(report, null, 2)
    );
    console.log("SCALED175_FIRST10", JSON.stringify(report));
    assert(net > 0, "net after complete gas is non-positive");
    assert(coverage >= 1.5, `gas coverage below 1.5x: ${coverage}`);
    assert(netAt150PctGas > 0, "fails +50% gas stress");
  });
});
