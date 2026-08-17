const assert = require("assert");
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

async function rpc(method, params = []) { return provider.send(method, params); }

async function fundUsdt(ownerAddress, amount) {
  await rpc("anvil_setBalance", [ownerAddress, "0x152d02c7e14af6800000"]);
  await rpc("anvil_setBalance", [WPOL_USDT_PAIR, "0x3635c9adc5dea00000"]);
  await rpc("anvil_impersonateAccount", [WPOL_USDT_PAIR]);
  const donor = await provider.getSigner(WPOL_USDT_PAIR);
  await (await new ethers.Contract(USDT, ERC20, donor).transfer(ownerAddress, amount)).wait();
  await rpc("anvil_stopImpersonatingAccount", [WPOL_USDT_PAIR]);
}

function errorDetails(error) {
  return {
    name: error.name,
    code: error.code,
    shortMessage: error.shortMessage,
    reason: error.reason,
    data: error.data,
    message: error.message,
    rpcMessage: error.info && error.info.error && error.info.error.message,
    rpcData: error.info && error.info.error && error.info.error.data,
  };
}

async function traceCall(contract, method, args, overrides = {}) {
  const from = await contract.runner.getAddress();
  const populated = await contract[method].populateTransaction(...args, overrides);
  const request = {
    from,
    to: await contract.getAddress(),
    data: populated.data,
    gas: `0x${BigInt(overrides.gasLimit || GAS_LIMIT).toString(16)}`,
  };
  try {
    await provider.call({ from, to: request.to, data: request.data, gasLimit: BigInt(overrides.gasLimit || GAS_LIMIT) });
    return;
  } catch (error) {
    console.log("STATIC_REVERT", method, JSON.stringify(errorDetails(error)));
    try {
      const trace = await rpc("debug_traceCall", [request, "latest", { tracer: "callTracer" }]);
      console.log("CALL_TRACE", method, JSON.stringify(trace));
    } catch (traceError) {
      console.log("TRACE_ERROR", method, JSON.stringify(errorDetails(traceError)));
    }
    throw error;
  }
}

async function deployFixture() {
  const owner = new ethers.NonceManager(ethers.Wallet.fromPhrase(DEV_MNEMONIC).connect(provider));
  const ownerAddress = await owner.getAddress();
  assert.equal((await new ethers.Contract(ROUTER, ["function factory() view returns(address)"], provider).factory()).toLowerCase(), FACTORY);
  await fundUsdt(ownerAddress, 3_000_000n);
  const tokenArtifact = await hre.artifacts.readArtifact("RebaseSynaV2");
  const controllerArtifact = await hre.artifacts.readArtifact("BullishQuickSwapCentralBankV2");
  const token = await new ethers.ContractFactory(tokenArtifact.abi, tokenArtifact.bytecode, owner).deploy(ownerAddress);
  await token.deploymentTransaction().wait();
  const controller = await new ethers.ContractFactory(controllerArtifact.abi, controllerArtifact.bytecode, owner)
    .deploy(ownerAddress, ROUTER, USDT, WPOL, await token.getAddress());
  await controller.deploymentTransaction().wait();
  await (await token.setController(await controller.getAddress())).wait();
  const usdt = new ethers.Contract(USDT, ERC20, owner);
  await (await usdt.approve(await controller.getAddress(), 2_000_000n)).wait();
  const block = await provider.getBlock("latest");
  await traceCall(controller, "initialize", [
    ethers.parseEther("1000000"), ethers.parseEther("500000"), 1_000_000n, 1_000_000n, block.timestamp + 3600
  ]);
  await (await controller.initialize(
    ethers.parseEther("1000000"), ethers.parseEther("500000"), 1_000_000n, 1_000_000n,
    block.timestamp + 3600, { gasLimit: GAS_LIMIT }
  )).wait();
  return { controller };
}

describe("QuickSwap V2 diagnostic trace", function () {
  this.timeout(600000);

  it("traces cycle execution until the first revert", async function () {
    const { controller } = await deployFixture();
    for (let i = 0; i < 10; i += 1) {
      const block = await provider.getBlock("latest");
      console.log("CYCLE_DIAG", i, "robot", (await controller.robotUsdt()).toString(), "treasury", (await controller.treasuryUsdt()).toString(), "price", (await controller.spotPriceX18()).toString());
      await traceCall(controller, "executeCycle", [i, block.timestamp + 3600, 0]);
      await (await controller.executeCycle(i, block.timestamp + 3600, 0, { gasLimit: GAS_LIMIT })).wait();
      await rpc("anvil_mine", ["0x9"]);
    }
  });

  it("traces direct robot refill", async function () {
    const { controller } = await deployFixture();
    await (await controller.setRefillConfig(1_040_000n, 0, 100, 500, 10)).wait();
    const block = await provider.getBlock("latest");
    await traceCall(controller, "refillRobotCapital", [1_040_000n, block.timestamp + 3600], { gasLimit: 5_000_000n });
    await (await controller.refillRobotCapital(1_040_000n, block.timestamp + 3600, { gasLimit: 5_000_000n })).wait();
  });
});
