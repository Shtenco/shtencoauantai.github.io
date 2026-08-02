"use strict";

const fs = require("fs");
const path = require("path");
const {
  Wallet,
  Interface,
  ContractFactory,
  getCreateAddress,
  keccak256,
  randomBytes,
  getAddress,
} = require("ethers");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseEnv(file) {
  const out = {};
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    out[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return out;
}

function bigintField(value, name) {
  if (value === undefined || value === null || value === "") fail(`Missing ${name}`);
  return BigInt(value);
}

async function main() {
  const [command, envFile, preflightFile, artifactFile, outputFile] = process.argv.slice(2);
  if (!command || !envFile || !preflightFile || !outputFile) {
    fail("Usage: node synergy-local-signer.cjs <approve|deploy> <env> <preflight.json> [artifact.json] <output.json>");
  }
  const env = parseEnv(envFile);
  const privateKey = env.OWNER_PRIVATE_KEY;
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(privateKey || "")) fail("OWNER_PRIVATE_KEY invalid");
  const wallet = new Wallet(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`);
  const expected = getAddress(env.DEPLOYER_ADDRESS || wallet.address);
  if (wallet.address !== expected) fail("Private key does not match DEPLOYER_ADDRESS");

  const preflight = JSON.parse(fs.readFileSync(preflightFile, "utf8"));
  if (Number(preflight.chainId) !== 137) fail("Preflight chainId is not 137");
  if (getAddress(preflight.deployer) !== wallet.address) fail("Preflight deployer mismatch");

  const common = {
    type: 2,
    chainId: 137,
    nonce: Number(preflight.txNonce),
    value: 0n,
    maxFeePerGas: bigintField(preflight.maxFeePerGasWei, "maxFeePerGasWei"),
    maxPriorityFeePerGas: bigintField(preflight.maxPriorityFeePerGasWei, "maxPriorityFeePerGasWei"),
  };

  let tx;
  let metadata;
  if (command === "approve") {
    if (preflight.stage !== "APPROVE") fail(`Preflight stage is ${preflight.stage}, not APPROVE`);
    const spender = getAddress(preflight.predictedBootstrapAddress);
    const usdt = getAddress(preflight.usdt);
    const iface = new Interface(["function approve(address spender,uint256 amount) returns(bool)"]);
    tx = {
      ...common,
      to: usdt,
      gasLimit: bigintField(preflight.gasLimit, "gasLimit"),
      data: iface.encodeFunctionData("approve", [spender, 2_000_000n]),
    };
    metadata = { stage: "APPROVE", spender, amountUsdt: "2.000000" };
  } else if (command === "deploy") {
    if (!artifactFile) fail("Artifact path required for deploy");
    if (preflight.stage !== "DEPLOY") fail(`Preflight stage is ${preflight.stage}, not DEPLOY`);
    const artifact = JSON.parse(fs.readFileSync(artifactFile, "utf8"));
    const salt = keccak256(randomBytes(32));
    const factory = new ContractFactory(artifact.abi, artifact.bytecode, wallet);
    const deployTx = await factory.getDeployTransaction(wallet.address, salt);
    const predicted = getCreateAddress({ from: wallet.address, nonce: Number(preflight.txNonce) });
    if (getAddress(preflight.predictedBootstrapAddress) !== predicted) fail("Predicted deployment address mismatch");
    tx = {
      ...common,
      gasLimit: bigintField(preflight.gasLimit, "gasLimit"),
      data: deployTx.data,
    };
    metadata = { stage: "DEPLOY", predictedBootstrapAddress: predicted, secretSaltHash: keccak256(salt) };
  } else {
    fail("Command must be approve or deploy");
  }

  const rawTransaction = await wallet.signTransaction(tx);
  const report = {
    ...metadata,
    signer: wallet.address,
    chainId: 137,
    nonce: tx.nonce,
    gasLimit: tx.gasLimit.toString(),
    maxFeePerGasWei: tx.maxFeePerGas.toString(),
    maxPriorityFeePerGasWei: tx.maxPriorityFeePerGas.toString(),
    transactionHash: keccak256(rawTransaction),
    rawTransaction,
    privateKeyPrinted: false,
  };
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...report, rawTransaction: "[written to file]" }, null, 2));
}

main().catch((error) => fail(error.stack || error.message || String(error)));
