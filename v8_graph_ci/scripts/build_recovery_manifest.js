"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = process.cwd();
const BINDINGS = [
  {
    path: "contracts/fork/SynergyAtomicQeQtCycleV11.sol",
    privatePath: "contracts/fork/SynergyAtomicQeQtCycleV11.sol",
    expectedGitBlobSha: "6c8303eae6bfae608532fbdfb50df72c044a1581"
  },
  {
    path: "contracts/supercycle/StatefulSupercycleV8.sol",
    privatePath: "contracts/supercycle/StatefulSupercycleV8.sol",
    expectedGitBlobSha: "390eb5f99f2b6665708b460df9ecdf379227f615"
  }
];

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}
function gitBlob(data) {
  return crypto.createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${data.length}\0`), data]))
    .digest("hex");
}
function artifact(contractFile, contractName) {
  const file = path.join(ROOT, "artifacts/contracts", contractFile, `${contractName}.json`);
  const raw = fs.readFileSync(file);
  const value = JSON.parse(raw.toString("utf8"));
  const bytecode = Buffer.from(value.bytecode.slice(2), "hex");
  const deployed = Buffer.from(value.deployedBytecode.slice(2), "hex");
  if (!bytecode.length || !deployed.length) throw new Error(`missing bytecode for ${contractName}`);
  return {
    path: path.relative(ROOT, file),
    artifactSha256: sha256(raw),
    bytecodeBytes: bytecode.length,
    bytecodeSha256: sha256(bytecode),
    deployedBytecodeBytes: deployed.length,
    deployedBytecodeSha256: sha256(deployed)
  };
}

const sourceBindings = BINDINGS.map((item) => {
  const data = fs.readFileSync(path.join(ROOT, item.path));
  const actualGitBlobSha = gitBlob(data);
  if (actualGitBlobSha !== item.expectedGitBlobSha) {
    throw new Error(`${item.path} blob mismatch ${actualGitBlobSha}`);
  }
  return {
    ...item,
    actualGitBlobSha,
    sha256: sha256(data),
    bytes: data.length
  };
});

const result = {
  scenario: "synergy_v8_v11_recovered_exact_source_compile",
  verdict: "PASS",
  privateRepository: "Shtenco/ai_financial_system",
  privateBranch: "audit/stateful-supercycle-v8",
  compiler: {
    solc: require("solc").version(),
    hardhat: require("hardhat/package.json").version,
    optimizerRuns: 500,
    viaIR: true,
    evmVersion: "cancun"
  },
  sourceBindings,
  artifacts: {
    v11Executor: artifact("fork/SynergyAtomicQeQtCycleV11.sol", "SynergyAtomicQeQtCycleV11"),
    v8Controller: artifact("supercycle/StatefulSupercycleV8.sol", "StatefulSupercycleV8")
  },
  internalDexCore: {
    sourcePrivateBlobSha: "2087110d8ea3b8b6509d2ac8e1ee3b94d22bba19",
    note: "CI contains only the ParticipantTaxRegistry and permissioned pair/factory/router execution subset extracted from SynergyV5Modules.sol."
  }
};
fs.mkdirSync(path.join(ROOT, "reports"), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, "reports/stateful_v8_recovery_compile_manifest.json"),
  JSON.stringify(result, null, 2)
);
console.log(JSON.stringify(result, null, 2));
