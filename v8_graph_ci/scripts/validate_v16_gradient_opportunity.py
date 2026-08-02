#!/usr/bin/env python3
import json
from pathlib import Path

report_path = Path("reports/v16_gradient_opportunity_market.json")
verdict_path = Path("reports/v16_gradient_opportunity_verdict.json")

if not report_path.exists():
    raise SystemExit("FAIL: V16 report missing")

data = json.loads(report_path.read_text(encoding="utf-8"))

errors = []
if data.get("verdict") != "STRUCTURAL_FORK_PASS":
    errors.append("wrong verdict")
if data.get("artificialExternalPriceShock") is not False:
    errors.append("external price shock was used")
if data.get("fixtureCustomerIntent") is not True:
    errors.append("customer intent fixture not disclosed")
if data.get("liveDemandProven") is not False:
    errors.append("live demand was overstated")
if data.get("externalGraph", {}).get("selectedPools") != 50:
    errors.append("50-pool manifest missing")
if not 2 <= data.get("externalGraph", {}).get("executedHops", 0) <= 4:
    errors.append("executed route is not 2-4 hops")
if data.get("internalTopology", {}).get("pools") != 10:
    errors.append("ten-pool internal topology missing")
if data.get("aave", {}).get("receiverPreFundedWpol") is not False:
    errors.append("Aave receiver was pre-funded")
if data.get("aave", {}).get("repaid") is not True:
    errors.append("Aave repayment not proven")
if data.get("managedGradient", {}).get("temporarySupplyClosed") is not True:
    errors.append("temporary QE supply not closed")
if data.get("managedGradient", {}).get("totalSupplyRestored") is not True:
    errors.append("total supply not restored")

metrics = data.get("economics", {})
for key in (
    "solverRevenueUsdt",
    "solverNetAfterExecutionGasUsdt",
    "consolidatedNavDeltaUsdt",
    "consolidatedNavAfterMeasuredGasUsdt",
    "onchainConservativeProtocolNetUsdt",
):
    if float(metrics.get(key, 0)) <= 0:
        errors.append(f"non-positive {key}")

if float(metrics.get("measuredInternalValueLossUsdt", -1)) < 0:
    errors.append("negative internal value loss accounting")
if metrics.get("internalValueLossAccounted") is not True:
    errors.append("internal value loss was not accounted")

baseline = data.get("zeroMarginBaseline", {})
if baseline.get("rejectedFailClosed") is not True:
    errors.append("zero-margin gradient did not fail closed")
if float(data.get("customer", {}).get("explicitMarginUsdt", 0)) <= 0:
    errors.append("customer service margin was not positive")

required_gates = (
    "zeroMarginRejectedFailClosed",
    "customerPaidOpportunityAccepted",
    "internalValueLossAccounted",
    "tenPoolTopologyValidated",
    "realAavePrincipal",
    "selectedFiftyPoolGraphRoute",
    "midasRiskVetoConsumed",
    "solverAuctionConsumed",
    "solverPositiveAfterGas",
    "protocolPositiveAfterMeasuredGas",
    "temporaryQeQtClosed",
)
for gate in required_gates:
    if data.get("gates", {}).get(gate) is not True:
        errors.append(f"gate failed: {gate}")

verdict = {
    "verdict": "PASS" if not errors else "FAIL",
    "classification": data.get("verdict"),
    "errors": errors,
    "strictBoundary": data.get("strictBoundary"),
    "summary": {
        "customerUsdtPaid": data.get("customer", {}).get("usdtPaid"),
        "customerWpolReceived": data.get("customer", {}).get("wpolReceived"),
        "internalValueLossUsdt": metrics.get("measuredInternalValueLossUsdt"),
        "solverNetAfterGasUsdt": metrics.get("solverNetAfterExecutionGasUsdt"),
        "protocolNavAfterGasUsdt": metrics.get("consolidatedNavAfterMeasuredGasUsdt"),
    },
}
verdict_path.write_text(json.dumps(verdict, indent=2, ensure_ascii=False), encoding="utf-8")
print(json.dumps(verdict, indent=2, ensure_ascii=False))
if errors:
    raise SystemExit(1)
