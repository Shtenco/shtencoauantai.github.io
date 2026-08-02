const assert = require("assert");
const hre = require("hardhat");
const { ethers } = hre;

const provider = new ethers.JsonRpcProvider(process.env.LOCAL_FORK_URL || "http://127.0.0.1:8545");
const ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const USDT = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";
const WPOL_USDT_PAIR = "0x604229c960e5CACF2aaEAc8Be68Ac07BA9dF81c3";
const DEV_MNEMONIC = "test test test test test test test test test test test junk";
const ERC20 = [
  "function balanceOf(address) view returns(uint256)",
  "function transfer(address,uint256) returns(bool)",
  "function approve(address,uint256) returns(bool)"
];
const PAIR = ["function sync()"];
const ROUTER_ABI = [
  "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns(uint256[])"
];

async function rpc(method, params = []) { return provider.send(method, params); }

async function freshLatestBlock() {
  const raw = await rpc("eth_getBlockByNumber", ["latest", false]);
  assert(raw && raw.hash && raw.timestamp, "fresh latest block unavailable");
  return { hash: raw.hash, timestamp: Number(BigInt(raw.timestamp)) };
}

async function fundUsdt(target, amount) {
  await rpc("anvil_setBalance", [target, "0x152d02c7e14af6800000"]);
  await rpc("anvil_setBalance", [WPOL_USDT_PAIR, "0x3635c9adc5dea00000"]);
  await rpc("anvil_impersonateAccount", [WPOL_USDT_PAIR]);
  const donor = await provider.getSigner(WPOL_USDT_PAIR);
  await (await new ethers.Contract(USDT, ERC20, donor).transfer(target, amount)).wait();
  await (await new ethers.Contract(WPOL_USDT_PAIR, PAIR, donor).sync()).wait();
  await rpc("anvil_stopImpersonatingAccount", [WPOL_USDT_PAIR]);
}

async function expectCallRevert(promise, fragment) {
  try {
    await promise;
  } catch (error) {
    assert(String(error.message).includes(fragment), `expected ${fragment}, got ${error.message}`);
    return;
  }
  assert.fail(`expected call revert ${fragment}`);
}

async function deployFixture() {
  const owner = new ethers.NonceManager(ethers.Wallet.fromPhrase(DEV_MNEMONIC).connect(provider));
  const ownerAddress = await owner.getAddress();
  await fundUsdt(ownerAddress, 3_000_000n);
  const usdt = new ethers.Contract(USDT, ERC20, owner);
  const artifact = await hre.artifacts.readArtifact("SynergyQuickSwapBootstrapV5");
  const nonce = await provider.getTransactionCount(ownerAddress, "pending");
  const predicted = ethers.getCreateAddress({ from: ownerAddress, nonce: nonce + 2 });
  await (await usdt.approve(predicted, 2_000_000n)).wait();
  await (await usdt.transfer(predicted, 1n)).wait();
  const salt = ethers.keccak256(ethers.toUtf8Bytes("SYNERGY_V5_SECURITY_FORK_SECRET"));
  const bootstrap = await new ethers.ContractFactory(artifact.abi, artifact.bytecode, owner)
    .deploy(ownerAddress, salt, { gasLimit: 28_000_000n });
  await bootstrap.deploymentTransaction().wait();
  assert.equal((await bootstrap.getAddress()).toLowerCase(), predicted.toLowerCase());
  assert.equal(await usdt.balanceOf(await bootstrap.getAddress()), 1n, "prefunded dust missing");
  await (await bootstrap.rescueToken(USDT, ownerAddress, 1n)).wait();
  assert.equal(await usdt.balanceOf(await bootstrap.getAddress()), 0n, "dust rescue failed");

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
  return { owner, ownerAddress, bootstrap, token, controller };
}

describe("Synergy Shielded V5 explicit security proof", function () {
  this.timeout(600000);

  it("fails closed on zero quote, dust, public bypass, QuickSwap front-run and stale parent", async function () {
    const { owner, ownerAddress, bootstrap, token, controller } = await deployFixture();
    assert.equal(await token.name(), "Synergy Coin");
    assert.equal(await token.symbol(), "SYNA");
    assert.notEqual(await provider.getCode(await bootstrap.pair()), "0x");
    assert((await provider.getCode(await bootstrap.getAddress())).length / 2 - 1 <= 24_576);
    assert((await provider.getCode(await controller.getAddress())).length / 2 - 1 <= 24_576);

    const initialBlock = await freshLatestBlock();
    await expectCallRevert(
      controller.connect(owner).executeCycle.staticCall(0, initialBlock.timestamp + 60, 0),
      "OPERATOR"
    );
    await expectCallRevert(
      controller.checkedQuoteOut(await token.getAddress(), USDT, 1n),
      "ZERO_LOCAL_PRICE"
    );

    const committedState = await controller.currentExecutionStateHash();
    const committedNonce = await controller.nonce();
    const router = new ethers.Contract(ROUTER, ROUTER_ABI, owner);
    await (await token.approve(ROUTER, ethers.MaxUint256)).wait();
    const attackBlock = await freshLatestBlock();
    await (await router.swapExactTokensForTokens(
      ethers.parseEther("100"),
      1,
      [await token.getAddress(), USDT],
      ownerAddress,
      attackBlock.timestamp + 60
    )).wait();

    const postAttackBlock = await freshLatestBlock();
    await expectCallRevert(
      bootstrap.executeProtectedCycle.staticCall(
        committedNonce,
        committedState,
        postAttackBlock.hash,
        postAttackBlock.timestamp + 60,
        ethers.parseUnits("500", "gwei"),
        0
      ),
      "STATE_CHANGED"
    );

    const validState = await controller.currentExecutionStateHash();
    const staleParent = postAttackBlock.hash;
    await rpc("anvil_mine", ["0x1"]);
    const latest = await freshLatestBlock();
    await expectCallRevert(
      bootstrap.executeProtectedCycle.staticCall(
        await controller.nonce(),
        validState,
        staleParent,
        latest.timestamp + 60,
        ethers.parseUnits("500", "gwei"),
        0
      ),
      "PARENT_BLOCK_CHANGED"
    );
  });
});
