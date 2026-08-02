const assert = require("assert");
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;

const provider = new ethers.JsonRpcProvider(process.env.LOCAL_FORK_URL || "http://127.0.0.1:8545");
const USDT = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";
const WPOL = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const WPOL_USDT_PAIR = "0x604229c960e5CACF2aaEAc8Be68Ac07BA9dF81c3";
const DEV_MNEMONIC = "test test test test test test test test test test test junk";
const ERC20 = [
  "function balanceOf(address) view returns(uint256)",
  "function transfer(address,uint256) returns(bool)",
  "function approve(address,uint256) returns(bool)"
];
const PAIR = [
  "function token0() view returns(address)",
  "function getReserves() view returns(uint112,uint112,uint32)",
  "function sync()"
];

async function rpc(method, params = []) { return provider.send(method, params); }
function cost(receipt) { return receipt.gasUsed * (receipt.gasPrice || 0n); }

async function fundUsdt(target, amount) {
  await rpc("anvil_setBalance", [target, "0x152d02c7e14af6800000"]);
  await rpc("anvil_setBalance", [WPOL_USDT_PAIR, "0x3635c9adc5dea00000"]);
  await rpc("anvil_impersonateAccount", [WPOL_USDT_PAIR]);
  const donor = await provider.getSigner(WPOL_USDT_PAIR);
  const usdt = new ethers.Contract(USDT, ERC20, donor);
  await (await usdt.transfer(target, amount)).wait();
  await (await new ethers.Contract(WPOL_USDT_PAIR, PAIR, donor).sync()).wait();
  await rpc("anvil_stopImpersonatingAccount", [WPOL_USDT_PAIR]);
}

async function polPriceUsdt() {
  const pair = new ethers.Contract(WPOL_USDT_PAIR, PAIR, provider);
  const [token0, reserves] = await Promise.all([pair.token0(), pair.getReserves()]);
  const usdtReserve = token0.toLowerCase() === USDT.toLowerCase() ? reserves[0] : reserves[1];
  const polReserve = token0.toLowerCase() === WPOL.toLowerCase() ? reserves[0] : reserves[1];
  return Number(ethers.formatUnits(usdtReserve, 6)) / Number(ethers.formatEther(polReserve));
}

async function deployFixture() {
  const owner = new ethers.NonceManager(ethers.Wallet.fromPhrase(DEV_MNEMONIC).connect(provider));
  const ownerAddress = await owner.getAddress();
  await fundUsdt(ownerAddress, 3_000_000n);
  const usdt = new ethers.Contract(USDT, ERC20, owner);
  const artifact = await hre.artifacts.readArtifact("SynergyQuickSwapBootstrapV5");
  const currentNonce = await provider.getTransactionCount(ownerAddress, "pending");
  const predictedBootstrap = ethers.getCreateAddress({
    from: ownerAddress,
    nonce: currentNonce + 1
  });
  const secretSalt = ethers.keccak256(
    ethers.toUtf8Bytes("SYNERGY_SHIELDED_V5_PINNED_FORK_SECRET")
  );

  let setupGas = 0n;
  setupGas += cost(await (await usdt.approve(predictedBootstrap, 2_000_000n)).wait());
  const bootstrap = await new ethers.ContractFactory(artifact.abi, artifact.bytecode, owner)
    .deploy(ownerAddress, secretSalt, { gasLimit: 28_000_000n });
  setupGas += cost(await bootstrap.deploymentTransaction().wait());
  assert.equal((await bootstrap.getAddress()).toLowerCase(), predictedBootstrap.toLowerCase());

  const token = new ethers.Contract(
    await bootstrap.token(),
    (await hre.artifacts.readArtifact("RebaseSynaExactV3")).abi,
    owner
  );
  const controller = new ethers.Contract(
    await bootstrap.controller(),
    (await hre.artifacts.readArtifact("BullishQuickSwapShieldedV5")).abi,
    owner
  );
  return { owner, ownerAddress, bootstrap, token, controller, setupGas };
}

async function executeProtected(bootstrap, controller, minMetric = 0n) {
  const block = await provider.getBlock("latest");
  const tx = await bootstrap.executeProtectedCycle(
    await controller.nonce(),
    await controller.currentExecutionStateHash(),
    block.hash,
    block.timestamp + 60,
    ethers.parseUnits("500", "gwei"),
    minMetric,
    { gasLimit: 10_000_000n }
  );
  return tx.wait();
}

async function expectRevert(promise, fragment) {
  let failed = false;
  try { await promise; }
  catch (error) {
    failed = true;
    assert(String(error.message).includes(fragment), `expected ${fragment}, got ${error.message}`);
  }
  assert(failed, `expected revert ${fragment}`);
}

describe("Synergy Coin Shielded V5", function () {
  this.timeout(600000);

  it("deploys below the runtime limit and blocks zero/stale/public bypass paths", async function () {
    const { owner, ownerAddress, bootstrap, token, controller } = await deployFixture();
    assert.equal(await token.name(), "Synergy Coin");
    assert.equal(await token.symbol(), "SYNA");
    assert.notEqual(await bootstrap.pair(), ethers.ZeroAddress);
    assert.notEqual(await provider.getCode(await bootstrap.pair()), "0x");
    assert.equal((await controller.owner()).toLowerCase(), (await bootstrap.getAddress()).toLowerCase());
    assert((await provider.getCode(await bootstrap.getAddress())).length / 2 - 1 <= 24_576);
    assert((await token.balanceOf(ownerAddress)) > 0n, "free float not delivered to admin");

    const block0 = await provider.getBlock("latest");
    await expectRevert(
      controller.connect(owner).executeCycle(0, block0.timestamp + 60, 0),
      "OPERATOR"
    );
    await expectRevert(
      controller.checkedQuoteOut(await token.getAddress(), USDT, 1n),
      "ZERO_LOCAL_PRICE"
    );

    const staleState = await controller.currentExecutionStateHash();
    const staleParent = block0.hash;
    await executeProtected(bootstrap, controller);
    const block1 = await provider.getBlock("latest");
    await expectRevert(
      bootstrap.executeProtectedCycle(
        await controller.nonce(), staleState, block1.hash, block1.timestamp + 60,
        ethers.parseUnits("500", "gwei"), 0, { gasLimit: 10_000_000n }
      ),
      "STATE_CHANGED"
    );
    await expectRevert(
      bootstrap.executeProtectedCycle(
        await controller.nonce(), await controller.currentExecutionStateHash(), staleParent,
        block1.timestamp + 60, ethers.parseUnits("500", "gwei"), 0,
        { gasLimit: 10_000_000n }
      ),
      "PARENT_BLOCK_CHANGED"
    );
  });

  it("remains positive after complete constructor V5 setup and ten protected cycles", async function () {
    const { bootstrap, controller, setupGas } = await deployFixture();
    const initialMetric = await controller.systemMetricUsdt();
    const initialPrice = await controller.spotPriceX18();
    let runtimeGas = 0n;
    for (let i = 0; i < 10; i += 1) runtimeGas += cost(await executeProtected(bootstrap, controller));
    const finalMetric = await controller.systemMetricUsdt();
    const finalPrice = await controller.spotPriceX18();
    const fullGasPol = Number(ethers.formatEther(setupGas + runtimeGas));
    const fullGasUsdt = fullGasPol * await polPriceUsdt();
    const gross = Number(ethers.formatUnits(finalMetric - initialMetric, 6));
    const net = gross - fullGasUsdt;
    const report = {
      scenario: "SYNERGY_SHIELDED_V5_FIRST10",
      chainId: 137,
      forkBlock: Number(process.env.FORK_BLOCK_NUMBER || 0),
      tokenName: "Synergy Coin",
      tokenSymbol: "SYNA",
      cycles: 10,
      trades: 70,
      initialMetricUsdt: Number(ethers.formatUnits(initialMetric, 6)),
      finalMetricUsdt: Number(ethers.formatUnits(finalMetric, 6)),
      grossGrowthUsdt: gross,
      fullGasPol,
      fullGasUsdt,
      netGrowthAfterGasUsdt: net,
      priceMultiple: Number(finalPrice) / Number(initialPrice),
      verdict: net > 0 ? "PASS_POSITIVE_SHIELDED_FIRST10" : "STOP_NON_POSITIVE_SHIELDED_FIRST10"
    };
    fs.mkdirSync(path.join(process.cwd(), "reports", "shielded-v5"), { recursive: true });
    fs.writeFileSync(
      path.join(process.cwd(), "reports", "shielded-v5", "first10.json"),
      JSON.stringify(report, null, 2)
    );
    console.log("SHIELDED_V5_FIRST10", JSON.stringify(report));
    assert(finalPrice > initialPrice, "price did not rise");
    assert(net > 0, `shielded V5 net is non-positive: ${net}`);
  });

  it("passes protected robot refill and exact POL refill", async function () {
    const { bootstrap, controller } = await deployFixture();
    await (await bootstrap.setRefillConfig(1_040_000n, 0, 100, 500, 10)).wait();
    const block0 = await provider.getBlock("latest");
    const before = await controller.robotUsdt();
    await (await bootstrap.refillRobotCapitalProtected(
      1_040_000n,
      await controller.currentExecutionStateHash(),
      block0.hash,
      block0.timestamp + 60,
      ethers.parseUnits("500", "gwei"),
      { gasLimit: 6_000_000n }
    )).wait();
    assert((await controller.robotUsdt()) > before);

    await executeProtected(bootstrap, controller);
    const exactPol = ethers.parseEther("0.001");
    const required = await controller.checkedQuoteIn(USDT, WPOL, exactPol);
    const maxUsdt = required * 10100n / 10000n + 1n;
    const block1 = await provider.getBlock("latest");
    const beforePol = await provider.getBalance(await bootstrap.getAddress());
    await (await bootstrap.refillKeeperGasProtected(
      exactPol,
      maxUsdt,
      await controller.currentGasRouteStateHash(),
      block1.hash,
      block1.timestamp + 60,
      ethers.parseUnits("500", "gwei"),
      { gasLimit: 3_000_000n }
    )).wait();
    assert((await controller.cumulativeGasRefillUsdt()) > 0n);
    assert((await provider.getBalance(await bootstrap.getAddress())) > beforePol);
  });
});
