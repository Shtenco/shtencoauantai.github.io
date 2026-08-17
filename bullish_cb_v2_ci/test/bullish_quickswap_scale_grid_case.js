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
const SCALE_BPS = Number(process.env.DEAL_SCALE_BPS || "10000");
const BUY_USDT = Math.floor(100_000 * SCALE_BPS / 10_000);
const SELL_USDT = Math.floor(40_000 * SCALE_BPS / 10_000);
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
function receiptCost(receipt) { return receipt.gasUsed * (receipt.gasPrice || 0n); }

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
  return { controller, setupGas };
}

async function executeTen(controller) {
  let gas = 0n;
  for (let i = 0; i < 10; i += 1) {
    const block = await provider.getBlock("latest");
    const receipt = await (
      await controller.executeCycle(i, block.timestamp + 3600, 0, { gasLimit: CYCLE_GAS_LIMIT })
    ).wait();
    gas += receiptCost(receipt);
    await mineBlocks(9);
  }
  return gas;
}

describe(`Bullish QuickSwap deal scale ${SCALE_BPS} bps`, function () {
  this.timeout(600000);

  it("measures first-ten net after complete gas", async function () {
    const { controller, setupGas } = await deployFixture();
    assert.equal(await controller.BUY_USDT(), BigInt(BUY_USDT), "compiled BUY_USDT scale mismatch");
    assert.equal(await controller.SELL_NOTIONAL_USDT(), BigInt(SELL_USDT), "compiled SELL scale mismatch");

    const initialMetric = await controller.systemMetricUsdt();
    const initialPrice = await controller.spotPriceX18();
    const runtimeGas = await executeTen(controller);
    const finalMetric = await controller.systemMetricUsdt();
    const finalPrice = await controller.spotPriceX18();
    const fullGasPol = Number(ethers.formatEther(setupGas + runtimeGas));
    const fullGasUsdt = fullGasPol * await polPriceUsdt();
    const grossGrowth = Number(ethers.formatUnits(finalMetric - initialMetric, 6));
    const net = grossGrowth - fullGasUsdt;
    const gasCoverage = fullGasUsdt > 0 ? grossGrowth / fullGasUsdt : 0;

    const report = {
      scenario: "BULLISH_QUICKSWAP_DEAL_SCALE_GRID",
      chainId: 137,
      forkBlock: Number(process.env.FORK_BLOCK_NUMBER || 0),
      scaleBps: SCALE_BPS,
      scaleMultiple: SCALE_BPS / 10000,
      buyUsdt: BUY_USDT / 1e6,
      sellNotionalUsdt: SELL_USDT / 1e6,
      initialPoolUsdt: 1,
      initialRobotUsdt: 1,
      initialMetricUsdt: Number(ethers.formatUnits(initialMetric, 6)),
      finalMetricUsdt: Number(ethers.formatUnits(finalMetric, 6)),
      grossGrowthUsdt: grossGrowth,
      setupGasPol: Number(ethers.formatEther(setupGas)),
      runtimeGasPol: Number(ethers.formatEther(runtimeGas)),
      fullGasPol,
      fullGasUsdt,
      netGrowthAfterGasUsdt: net,
      gasCoverageMultiple: gasCoverage,
      priceMultiple: Number(finalPrice) / Number(initialPrice),
      verdict: net > 0 ? "PASS_POSITIVE_FIRST_10" : "STOP_FIRST_10_NON_POSITIVE"
    };

    fs.mkdirSync(path.join(process.cwd(), "reports"), { recursive: true });
    const reportPath = path.join(process.cwd(), "reports", `scale_${SCALE_BPS}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log("SCALE_RESULT", JSON.stringify(report));
    assert.equal(await controller.nonce(), 10n);
  });
});
