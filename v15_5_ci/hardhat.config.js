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
    hardhat: {
      chainId: 31337,
      hardfork: "cancun",
      forking: process.env.POLYGON_RPC_URL
        ? {
            url: process.env.POLYGON_RPC_URL,
            blockNumber: process.env.V155_FORK_BLOCK
              ? Number(process.env.V155_FORK_BLOCK)
              : undefined
          }
        : undefined,
      accounts: {
        count: 20,
        accountsBalance: "100000000000000000000000"
      }
    }
  },
  mocha: { timeout: 300000 }
};
