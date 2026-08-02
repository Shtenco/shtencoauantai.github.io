const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");
require("@nomicfoundation/hardhat-ethers");

subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD).setAction(async ({ solcVersion }) => ({
  compilerPath: require.resolve("solc/soljson.js"),
  isSolcJs: true,
  version: solcVersion,
  longVersion: require("solc").version(),
}));

module.exports = {
  solidity: {
    version: "0.8.26",
    settings: {
      optimizer: { enabled: true, runs: 1 },
      viaIR: true,
      evmVersion: "paris",
      metadata: { bytecodeHash: "none" }
    }
  },
  networks: {
    polygon: {
      chainId: 137,
      url: process.env.LOCAL_FORK_URL || "http://127.0.0.1:8545"
    }
  },
  mocha: { timeout: 600000 }
};
