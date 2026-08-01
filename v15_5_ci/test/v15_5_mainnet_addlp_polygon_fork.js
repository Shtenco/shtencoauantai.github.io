"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ethers, network } = require("hardhat");

const ADDR = {
  AAVE_POOL: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  WPOL: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  QUICKSWAP_ROUTER: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  QUICKSWAP_FACTORY: "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32"
};

const E = ethers.parseEther;

function snapshotPair(raw) {
  return {
    wpolReserve: raw.wpolReserve ?? raw[0],
    experimentTokenReserve: raw.experimentTokenReserve ?? raw[1],
    ownedLp: raw.ownedLp ?? raw[2]
  };
}

async function expectRevert(promise, label) {
  let reverted = false;
  try {
    const tx = await promise;
    if (tx && typeof tx.wait === "function") await tx.wait();
  } catch (_) {
    reverted = true;
  }
  assert.ok(reverted, label);
}

function writeReport(value) {
  fs.mkdirSync(path.join(process.cwd(), "reports"), { recursive: true });
  fs.writeFileSync(
    path.join(process.cwd(), "reports/v15_5_polygon_mainnet_addlp_fork.json"),
    JSON.stringify(value, null, 2)
  );
}

describe("SYNERGY V15.5 Polygon mainnet atomic ADDLP experiment", function () {
  this.timeout(300000);

  it("reverts the complete real-protocol flash cycle when internal actions cannot pay Aave premium", async function () {
    const forkUrl = process.env.POLYGON_RPC_URL;
    assert.ok(forkUrl, "POLYGON_RPC_URL archive/full RPC is required");

    await network.provider.send("hardhat_reset", [{
      forking: {
        jsonRpcUrl: forkUrl,
        blockNumber: process.env.V155_FORK_BLOCK ? Number(process.env.V155_FORK_BLOCK) : undefined
      }
    }]);

    const [operator, reinvestmentVault, retainedTreasury] = await ethers.getSigners();
    for (const address of Object.values(ADDR)) {
      assert.notEqual(await ethers.provider.getCode(address), "0x", `missing code at ${address}`);
    }

    const Experiment = await ethers.getContractFactory(
      "MainnetAtomicAddLpExperimentV155",
      operator
    );
    const experiment = await Experiment.deploy(
      ADDR.AAVE_POOL,
      ADDR.WPOL,
      ADDR.QUICKSWAP_ROUTER,
      ADDR.QUICKSWAP_FACTORY,
      operator.address,
      reinvestmentVault.address,
      retainedTreasury.address
    );
    await experiment.waitForDeployment();

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    await (
      await experiment.seedPools(
        E("0.1"),
        E("1000000"),
        1,
        1,
        deadline,
        { value: E("0.2") }
      )
    ).wait();

    const pairAAddress = await experiment.pairA();
    const pairBAddress = await experiment.pairB();
    const tokenAAddress = await experiment.tokenA();
    const tokenBAddress = await experiment.tokenB();
    const wpol = await ethers.getContractAt("IERC20", ADDR.WPOL);
    const pairA = await ethers.getContractAt("IQuickSwapV2PairV155", pairAAddress);
    const pairB = await ethers.getContractAt("IQuickSwapV2PairV155", pairBAddress);
    const tokenA = await ethers.getContractAt("SynergyExperimentTokenV155", tokenAAddress);
    const tokenB = await ethers.getContractAt("SynergyExperimentTokenV155", tokenBAddress);

    const statesBeforeRaw = await experiment.currentPairStates();
    const pairABefore = snapshotPair(statesBeforeRaw.stateA ?? statesBeforeRaw[0]);
    const pairBBefore = snapshotPair(statesBeforeRaw.stateB ?? statesBeforeRaw[1]);
    const balancesBefore = {
      aaveWpol: await wpol.balanceOf(ADDR.AAVE_POOL),
      experimentWpol: await wpol.balanceOf(await experiment.getAddress()),
      reinvestmentWpol: await wpol.balanceOf(reinvestmentVault.address),
      retainedWpol: await wpol.balanceOf(retainedTreasury.address),
      tokenASupply: await tokenA.totalSupply(),
      tokenBSupply: await tokenB.totalSupply(),
      pairALp: await pairA.balanceOf(await experiment.getAddress()),
      pairBLp: await pairB.balanceOf(await experiment.getAddress())
    };

    const plan = {
      flashAmountWpol: E("100"),
      lpWpolA: E("20"),
      lpTokenA: E("200000000"),
      lpWpolB: E("20"),
      lpTokenB: E("200000000"),
      gradientWpolA: E("1"),
      gradientTokenB: E("10000000"),
      minTokenAOut: 1,
      minWpolBackFromA: 1,
      minWpolOutFromB: 1,
      minTokenBBack: 1,
      minAddWpolA: 1,
      minAddTokenA: 1,
      minAddWpolB: 1,
      minAddTokenB: 1,
      minRemoveWpolA: 1,
      minRemoveTokenA: 1,
      minRemoveWpolB: 1,
      minRemoveTokenB: 1,
      maxPremiumWpol: E("1"),
      minNetProfitWpol: 1,
      deadline
    };

    await expectRevert(
      experiment.runAtomicCycle(plan, { gasLimit: 15_000_000, maxFeePerGas: 500_000_000_000n }),
      "internal ADDLP/gradient/unwind must not invent enough WPOL to pay Aave premium"
    );

    const statesAfterRaw = await experiment.currentPairStates();
    const pairAAfter = snapshotPair(statesAfterRaw.stateA ?? statesAfterRaw[0]);
    const pairBAfter = snapshotPair(statesAfterRaw.stateB ?? statesAfterRaw[1]);

    assert.deepEqual(pairAAfter, pairABefore);
    assert.deepEqual(pairBAfter, pairBBefore);
    assert.equal(await wpol.balanceOf(ADDR.AAVE_POOL), balancesBefore.aaveWpol);
    assert.equal(await wpol.balanceOf(await experiment.getAddress()), balancesBefore.experimentWpol);
    assert.equal(await wpol.balanceOf(reinvestmentVault.address), balancesBefore.reinvestmentWpol);
    assert.equal(await wpol.balanceOf(retainedTreasury.address), balancesBefore.retainedWpol);
    assert.equal(await tokenA.totalSupply(), balancesBefore.tokenASupply);
    assert.equal(await tokenB.totalSupply(), balancesBefore.tokenBSupply);
    assert.equal(await pairA.balanceOf(await experiment.getAddress()), balancesBefore.pairALp);
    assert.equal(await pairB.balanceOf(await experiment.getAddress()), balancesBefore.pairBLp);
    assert.equal(await experiment.completedCycles(), 0n);
    assert.equal(await experiment.cumulativeNetProfitWpol(), 0n);
    assert.equal(await experiment.cumulativeReinvestedWpol(), 0n);
    assert.equal(await experiment.cumulativeRetainedWpol(), 0n);

    writeReport({
      scenario: "v15_5_polygon_mainnet_protocol_fork_expected_revert",
      evidenceClass: "REAL_PROTOCOL_FORK_ATOMIC_ROLLBACK_NOT_MAINNET_BROADCAST",
      chainId: 137,
      aavePool: ADDR.AAVE_POOL,
      wpol: ADDR.WPOL,
      quickSwapRouter: ADDR.QUICKSWAP_ROUTER,
      quickSwapFactory: ADDR.QUICKSWAP_FACTORY,
      experiment: await experiment.getAddress(),
      pairA: pairAAddress,
      pairB: pairBAddress,
      seedPol: "0.2",
      flashPrincipalWpol: "100",
      expectedOutcome: "ATOMIC_REVERT_REPAYMENT_OR_NET_EDGE",
      actualOutcome: "ATOMIC_REVERT",
      poolsRestoredExactly: true,
      aaveLiquidityRestoredExactly: true,
      experimentTokenSupplyRestoredExactly: true,
      countedRevenueWpol: "0",
      reinvestedWpol: "0",
      interpretation:
        "The real Aave/QuickSwap fork rejects a closed internal-only cycle because ADDLP, reversible swaps, mint and burn do not create external WPOL surplus. All protocol state rolls back."
    });
  });
});