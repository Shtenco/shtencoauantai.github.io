#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
from pathlib import Path

REPORT = Path("reports/stateful_v8_recovery_polygon_fork.json")
OUT = Path("reports/stateful_v8_recovery_verdict.json")

if not REPORT.exists():
    raise SystemExit("FAIL: recovered V8 fork report missing")

data = json.loads(REPORT.read_text(encoding="utf-8"))
checks = {
    "forkPass": data.get("verdict") == "PASS",
    "tenInternalPools": data.get("internalPools") == 10,
    "tenExternalPools": data.get("externalPools") == 10,
    "threeSuccessfulCycles": data.get("successfulCycles", 0) >= 3,
    "independentExternalFlow": float(data.get("independentExternalShockUsdt", 0)) > 0,
    "positiveConsolidatedUsdt": float(data.get("consolidatedUsdtGain", 0)) > 0,
    "profitAfterGasPositive": data.get("profitAfterGasPositive") is True,
    "supplyRestored": data.get("syntheticSupplyRestored") is True,
    "temporarySupplyClosed": data.get("temporarySupplyClosed") is True,
    "otherProtocolAssetsPreserved": data.get("otherProtocolAssetsPreserved") is True,
    "cycleRowsComplete": len(data.get("cycles", [])) == data.get("successfulCycles"),
}
for row in data.get("cycles", []):
    checks[f"cycle{row['cycle']}ExternalCoversBuyback"] = row["externalUsdt"] > row["buybackUsdt"]
    checks[f"cycle{row['cycle']}ProfitCoversGas"] = row["treasuryProfitUsdt"] > row["gasUsdt"]
    checks[f"cycle{row['cycle']}KNonDecreasing"] = int(row["kAfter"]) >= int(row["kBefore"])

verdict = "PASS" if all(checks.values()) else "FAIL"
result = {
    "verdict": verdict,
    "validationMode": "FAIL_CLOSED_RECOVERED_V8_V11_POSITIVE_FORK",
    "checks": checks,
    "reportSha256": hashlib.sha256(REPORT.read_bytes()).hexdigest(),
    "fork": data,
}
OUT.write_text(json.dumps(result, indent=2), encoding="utf-8")
print(json.dumps(result, indent=2))
if verdict != "PASS":
    raise SystemExit(1)
