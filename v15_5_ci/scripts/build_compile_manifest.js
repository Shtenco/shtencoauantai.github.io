"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = process.cwd();
const SOURCE = path.join(ROOT, "contracts/v15_5/MainnetAtomicAddLpExperimentV155.sol");
const TEST = path.join(ROOT, "test/v15_5_mainnet_addlp_polygon_fork.js");
const REPORT = path.join(ROOT, "reports/v15_5_solidity_compile_manifest.json");
const EXPECTED_SOURCE_GIT_BLOB = "ad85d886f2797b030a89d2aa0b15f4a5c1446939";
const EXPECTED_TEST_GIT_BLOB = "f575fcb646af1c39ace6a0190f2e3886aaa37fa6";
const EXPECTED_SOLC_PREFIX = "0.8.26+commit.8a97fa7a";

function sha256Bytes(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function gitBlobSha(data) {
  const header = Buffer.from(`blob ${data.length}\0`);
  return crypto.createHash("sha1").update(Buffer.concat([header, data])).digest("hex");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function walk(dir, suffix = ".json") {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, suffix));
    else if (entry.isFile() && entry.name.endsWith(suffix)) out.push(full);
  }
  return out.sort();
}

function main() {
  const source = fs.readFileSync(SOURCE);
  const test = fs.readFileSync(TEST);
  const sourceGitBlobSha = gitBlobSha(source);
  const testGitBlobSha = gitBlobSha(test);
  if (sourceGitBlobSha !== EXPECTED_SOURCE_GIT_BLOB) {
    throw new Error(`source Git blob mismatch: ${sourceGitBlobSha}`);
  }
  if (testGitBlobSha !== EXPECTED_TEST_GIT_BLOB) {
    throw new Error(`test Git blob mismatch: ${testGitBlobSha}`);
  }

  const solcVersion = require("solc").version();
  if (!solcVersion.startsWith(EXPECTED_SOLC_PREFIX)) {
    throw new Error(`unexpected solc version ${solcVersion}`);
  }

  const contractDir = path.join(
    ROOT,
    "artifacts/contracts/v15_5/MainnetAtomicAddLpExperimentV155.sol"
  );
  const artifactFiles = walk(contractDir);
  if (!artifactFiles.length) throw new Error("no V15.5 Hardhat artifacts produced");

  const artifacts = artifactFiles.map((file) => {
    const raw = fs.readFileSync(file);
    const value = readJson(file);
    const bytecode = typeof value.bytecode === "string" ? value.bytecode : "";
    const deployedBytecode = typeof value.deployedBytecode === "string" ? value.deployedBytecode : "";
    return {
      path: path.relative(ROOT, file).replaceAll("\\", "/"),
      sha256: sha256Bytes(raw),
      contractName: value.contractName || null,
      sourceName: value.sourceName || null,
      abiSha256: value.abi ? sha256Bytes(Buffer.from(JSON.stringify(value.abi))) : null,
      bytecodeBytes: bytecode.startsWith("0x") ? (bytecode.length - 2) / 2 : 0,
      bytecodeSha256: bytecode ? sha256Bytes(Buffer.from(bytecode.slice(2), "hex")) : null,
      deployedBytecodeBytes: deployedBytecode.startsWith("0x") ? (deployedBytecode.length - 2) / 2 : 0,
      deployedBytecodeSha256: deployedBytecode
        ? sha256Bytes(Buffer.from(deployedBytecode.slice(2), "hex"))
        : null
    };
  });

  const mainArtifact = artifacts.find(
    (row) => row.contractName === "MainnetAtomicAddLpExperimentV155"
  );
  if (!mainArtifact || mainArtifact.bytecodeBytes === 0 || mainArtifact.deployedBytecodeBytes === 0) {
    throw new Error("main V15.5 bytecode missing");
  }

  const buildInfoFiles = walk(path.join(ROOT, "artifacts/build-info"));
  if (!buildInfoFiles.length) throw new Error("Hardhat build-info missing");
  const buildInfo = buildInfoFiles.map((file) => ({
    path: path.relative(ROOT, file).replaceAll("\\", "/"),
    sha256: sha256Bytes(fs.readFileSync(file)),
    bytes: fs.statSync(file).size
  }));

  const result = {
    scenario: "synergy_v15_5_exact_solidity_compiler_artifact",
    verdict: "PASS",
    evidenceClass: "ACTUAL_SOLC_0_8_26_HARDHAT_COMPILER_OUTPUT",
    sourceBinding: {
      privateRepository: "Shtenco/ai_financial_system",
      privateBranch: "audit/stateful-supercycle-v8",
      privatePath: "contracts/v15_5/MainnetAtomicAddLpExperimentV155.sol",
      expectedGitBlobSha: EXPECTED_SOURCE_GIT_BLOB,
      actualGitBlobSha: sourceGitBlobSha,
      sha256: sha256Bytes(source),
      bytes: source.length
    },
    testBinding: {
      privatePath: "test/v15_5_mainnet_addlp_polygon_fork.js",
      expectedGitBlobSha: EXPECTED_TEST_GIT_BLOB,
      actualGitBlobSha: testGitBlobSha,
      sha256: sha256Bytes(test),
      bytes: test.length
    },
    compiler: {
      solcVersion,
      hardhatVersion: require("hardhat/package.json").version,
      optimizerEnabled: true,
      optimizerRuns: 500,
      viaIR: true,
      evmVersion: "cancun"
    },
    mainArtifact,
    artifacts,
    buildInfo
  };

  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

main();
