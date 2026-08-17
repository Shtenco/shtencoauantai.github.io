#!/usr/bin/env python3
import json
from pathlib import Path

src = Path("reports/v15_7_real_aave_50_pool_qe_qt.json")
out = Path("reports/v15_7_verdict.json")
if not src.exists():
    raise SystemExit("missing V15.7 report")
d = json.loads(src.read_text())
checks = {
    "fork_pass": d.get("verdict") == "PASS",
    "fifty_real_pools": d.get("externalPoolsDiscoveredAndSelected") == 50,
    "dynamic_route": 2 <= d.get("selectedRouteHops", 0) <= 4,
    "cycles_enumerated": d.get("graphCyclesEnumerated", 0) > 0,
    "real_aave": d.get("realAavePool") == "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    "hundred_wpol": d.get("flashPrincipalWpol") == 100,
    "premium_paid": d.get("actualAavePremiumWpol", 0) > 0,
    "profit_positive": d.get("realizedProfitWpol", 0) > 0,
    "profit_after_gas": d.get("netAfterMeasuredGasWpol", 0) > 0,
    "qe_qt_closed": d.get("temporarySupplyClosed") and d.get("syntheticSupplyRestored"),
    "k_preserved": d.get("internalKNonDecreasing"),
    "no_receiver_subsidy": d.get("receiverHadZeroPrefunding"),
    "full_principal_routed": d.get("fullFlashPrincipalRouted"),
}
verdict = "PASS" if all(checks.values()) else "FAIL"
result = {"verdict": verdict, "validationMode": "FAIL_CLOSED_REAL_AAVE_50_POOL_QE_QT", "checks": checks, "report": d}
out.write_text(json.dumps(result, indent=2))
print(json.dumps(result, indent=2))
if verdict != "PASS":
    raise SystemExit(1)
