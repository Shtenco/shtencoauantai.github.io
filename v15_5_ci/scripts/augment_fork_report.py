#!/usr/bin/env python3
"""Bind the fork result to compiler/RPC evidence and render a compact PNG."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import matplotlib.pyplot as plt

REPORT = Path("reports/v15_5_polygon_mainnet_addlp_fork.json")
RPC = Path("reports/v15_5_polygon_archive_rpc_preflight.json")
COMPILE = Path("reports/v15_5_solidity_compile_manifest.json")
PNG = Path("reports/v15_5_polygon_mainnet_addlp_fork.png")


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    report = load(REPORT)
    rpc = load(RPC)
    compile_report = load(COMPILE)

    checks = {
        "compilerArtifactPass": compile_report.get("verdict") == "PASS",
        "archiveRpcPass": rpc.get("verdict") == "PASS",
        "actualForkRevert": report.get("actualOutcome") == "ATOMIC_REVERT",
        "poolsRestoredExactly": report.get("poolsRestoredExactly") is True,
        "aaveLiquidityRestoredExactly": report.get("aaveLiquidityRestoredExactly") is True,
        "tokenSupplyRestoredExactly": report.get("experimentTokenSupplyRestoredExactly") is True,
        "zeroCountedRevenue": str(report.get("countedRevenueWpol")) == "0",
        "zeroReinvestment": str(report.get("reinvestedWpol")) == "0",
    }
    verdict = "PASS" if all(checks.values()) else "FAIL"
    report.update({
        "verdict": verdict,
        "validationMode": "FAIL_CLOSED_EXACT_SOURCE_COMPILE_PLUS_PINNED_ARCHIVE_FORK",
        "pinnedForkBlock": rpc.get("pinnedBlock"),
        "pinnedForkBlockHash": (rpc.get("selectedChecks") or {}).get("pinnedBlockHash"),
        "archiveRpcHost": rpc.get("selectedHost"),
        "sourceGitBlobSha": (compile_report.get("sourceBinding") or {}).get("actualGitBlobSha"),
        "sourceSha256": (compile_report.get("sourceBinding") or {}).get("sha256"),
        "solcVersion": (compile_report.get("compiler") or {}).get("solcVersion"),
        "mainBytecodeSha256": (compile_report.get("mainArtifact") or {}).get("bytecodeSha256"),
        "mainDeployedBytecodeSha256": (compile_report.get("mainArtifact") or {}).get("deployedBytecodeSha256"),
        "compilerManifestSha256": sha256(COMPILE),
        "rpcPreflightSha256": sha256(RPC),
        "checks": checks,
    })
    REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")

    labels = [
        "Compiler",
        "Archive RPC",
        "Atomic revert",
        "Pools restored",
        "Aave restored",
        "Supply restored",
        "Revenue zero",
        "Reinvest zero",
    ]
    values = [1 if value else 0 for value in checks.values()]
    fig, ax = plt.subplots(figsize=(11, 5.5))
    ax.barh(labels, values)
    ax.set_xlim(0, 1.05)
    ax.set_xticks([0, 1], ["FAIL", "PASS"])
    ax.set_title(f"SYNERGY V15.5 — Polygon archive-fork evidence: {verdict}")
    ax.text(
        0.02,
        -0.16,
        f"Block {report.get('pinnedForkBlock')} | solc {report.get('solcVersion')} | counted revenue 0 WPOL",
        transform=ax.transAxes,
    )
    fig.tight_layout()
    fig.savefig(PNG, dpi=160)
    plt.close(fig)

    report["pngSha256"] = sha256(PNG)
    report["jsonSha256BeforePngField"] = sha256(REPORT)
    REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    if verdict != "PASS":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
