import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  ContractFactory,
  Interface,
  Wallet,
  getCreateAddress,
  getAddress,
  keccak256,
} from "ethers";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseEnv(filePath) {
  const out = {};
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    out[line.slice(0, index).trim()] = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return out;
}

const [envPath, artifactPath, preflightPath, outputPath] = process.argv.slice(2);
if (!envPath || !artifactPath || !preflightPath || !outputPath) {
  fail("Usage: signer <env> <artifact.json> <preflight.json> <output.json>");
}

const env = parseEnv(envPath);
const key = env.OWNER_PRIVATE_KEY?.startsWith("0x")
  ? env.OWNER_PRIVATE_KEY
  : `0x${env.OWNER_PRIVATE_KEY || ""}`;
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) fail("Invalid OWNER_PRIVATE_KEY");

const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
const preflight = JSON.parse(fs.readFileSync(preflightPath, "utf8"));
const wallet = new Wallet(key);
const deployer = getAddress(preflight.deployer);
if (wallet.address !== deployer) fail("Private key does not match preflight deployer");
if (Number(preflight.chainId) !== 137) fail("Preflight chainId is not Polygon 137");
if (BigInt(preflight.noncePending) !== BigInt(preflight.nonceLatest)) {
  fail("Pending nonce differs from latest nonce; clear pending transactions first");
}
if (BigInt(preflight.usdtBalanceRaw) < 2_000_000n) fail("Wallet has less than 2 USDT");

const nonce = BigInt(preflight.noncePending);
const approveNonce = nonce;
const deployNonce = nonce + 1n;
const bootstrapAddress = getCreateAddress({ from: deployer, nonce: deployNonce });
const gasPrice = (BigInt(preflight.gasPriceWei) * 125n + 99n) / 100n;
const blockGasLimit = BigInt(preflight.blockGasLimit);
const approveGasLimit = 150_000n;
const deployGasLimit = blockGasLimit > 27_000_000n ? 26_000_000n : blockGasLimit - 1_000_000n;
if (deployGasLimit < 12_000_000n) fail("Polygon block gas limit is too low for safe bootstrap attempt");

const maxCost = (approveGasLimit + deployGasLimit) * gasPrice;
if (BigInt(preflight.polBalanceWei) < maxCost) {
  fail(`Insufficient POL for maximum gas exposure: need ${maxCost}, have ${preflight.polBalanceWei}`);
}

const usdt = getAddress(preflight.usdt);
const approveInterface = new Interface(["function approve(address spender,uint256 amount) returns(bool)"]);
const approveData = approveInterface.encodeFunctionData("approve", [bootstrapAddress, 2_000_000n]);
const secretSalt = `0x${crypto.randomBytes(32).toString("hex")}`;
const factory = new ContractFactory(artifact.abi, artifact.bytecode);
const deployRequest = await factory.getDeployTransaction(deployer, secretSalt);

const approveTx = {
  type: 0,
  chainId: 137,
  nonce: approveNonce,
  gasPrice,
  gasLimit: approveGasLimit,
  to: usdt,
  value: 0,
  data: approveData,
};
const deployTx = {
  type: 0,
  chainId: 137,
  nonce: deployNonce,
  gasPrice,
  gasLimit: deployGasLimit,
  value: 0,
  data: deployRequest.data,
};

const rawApprove = await wallet.signTransaction(approveTx);
const rawDeploy = await wallet.signTransaction(deployTx);
const result = {
  schema: "synergy-local-signed-bootstrap-v1",
  chainId: 137,
  deployer,
  nonceLatest: preflight.nonceLatest,
  noncePending: preflight.noncePending,
  bootstrapAddress,
  usdt,
  approvedUsdtRaw: "2000000",
  gasPriceWei: gasPrice.toString(),
  approveGasLimit: approveGasLimit.toString(),
  deployGasLimit: deployGasLimit.toString(),
  maximumGasExposureWei: maxCost.toString(),
  secretSaltHash: keccak256(secretSalt),
  approveTxHash: keccak256(rawApprove),
  deployTxHash: keccak256(rawDeploy),
  rawApprove,
  rawDeploy,
  privateKeyIncluded: false,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({
  deployer,
  bootstrapAddress,
  approveTxHash: result.approveTxHash,
  deployTxHash: result.deployTxHash,
  gasPriceWei: result.gasPriceWei,
  maximumGasExposureWei: result.maximumGasExposureWei,
}, null, 2));
