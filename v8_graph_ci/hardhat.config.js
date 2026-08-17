"use strict";

const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD).setAction(async ({ solcVersion }) => ({
  compilerPath: require.resolve("solc/soljson.js"),
  isSolcJs: true,
  version: solcVersion,
  longVersion: require("solc").version()
}));

require("@nomicfoundation/hardhat-ethers");

module.exports = {
  solidity: {
    version: "0.8.26",
    settings: {
      optimizer: { enabled: true, runs: 500 },
      viaIR: true,
      evmVersion: "cancun"
    }
  },
  networks: {
    hardhat: { chainId: 31337, hardfork: "cancun" },
    polygonFork: {
      chainId: 137,
      url: process.env.LOCAL_FORK_URL || "http://127.0.0.1:8545",
      accounts: {
        mnemonic: "test test test test test test test test test test test junk",
        count: 20
      }
    }
  },
  mocha: { timeout: 1800000 }
};
