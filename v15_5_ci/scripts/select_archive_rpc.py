#!/usr/bin/env python3
"""Select and prove a public Polygon endpoint can serve pinned historical state."""
from __future__ import annotations

import json
import os
from pathlib import Path
import time
from urllib.parse import urlparse
from urllib.request import Request, urlopen

PINNED_BLOCK = int(os.getenv("V155_FORK_BLOCK", "90000000"))
PINNED_HEX = hex(PINNED_BLOCK)
WPOL = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"
AAVE_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD"
DEFAULTS = [
    "https://polygon.drpc.org",
    "https://polygon.publicnode.com",
    "https://polygon-public.nodies.app",
]
REPORT = Path("reports/v15_5_polygon_archive_rpc_preflight.json")


def rpc(url: str, method: str, params: list[object], attempts: int = 4) -> object:
    payload = json.dumps({"jsonrpc": "2.0", "id": 155, "method": method, "params": params}).encode()
    last: Exception | None = None
    for attempt in range(attempts):
        try:
            request = Request(url, data=payload, headers={"content-type": "application/json", "user-agent": "synergy-v15.5-evidence"})
            with urlopen(request, timeout=45) as response:
                value = json.loads(response.read().decode())
            if value.get("error"):
                raise RuntimeError(value["error"])
            return value.get("result")
        except Exception as error:  # noqa: BLE001
            last = error
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"{method} failed: {last}")


def endpoint_candidates() -> list[str]:
    raw = os.getenv("V155_RPC_CANDIDATES", "").strip()
    if not raw:
        return DEFAULTS
    return [part.strip() for part in raw.split(",") if part.strip()]


def main() -> None:
    attempts: list[dict[str, object]] = []
    selected: str | None = None
    selected_checks: dict[str, object] | None = None

    for url in endpoint_candidates():
        host = urlparse(url).netloc
        row: dict[str, object] = {"host": host, "status": "FAIL"}
        try:
            chain_id = rpc(url, "eth_chainId", [])
            latest_hex = rpc(url, "eth_blockNumber", [])
            pinned_block = rpc(url, "eth_getBlockByNumber", [PINNED_HEX, False])
            wpol_code = rpc(url, "eth_getCode", [WPOL, PINNED_HEX])
            aave_code = rpc(url, "eth_getCode", [AAVE_POOL, PINNED_HEX])
            wpol_balance = rpc(url, "eth_getBalance", [WPOL, PINNED_HEX])
            latest = int(str(latest_hex), 16)
            checks = {
                "chainId137": chain_id == "0x89",
                "latestAtOrAfterPinned": latest >= PINNED_BLOCK,
                "pinnedBlockPresent": isinstance(pinned_block, dict) and int(pinned_block.get("number", "0x0"), 16) == PINNED_BLOCK,
                "historicalWpolCodePresent": isinstance(wpol_code, str) and wpol_code not in ("0x", "0x0", ""),
                "historicalAaveCodePresent": isinstance(aave_code, str) and aave_code not in ("0x", "0x0", ""),
                "historicalStateCallReturned": isinstance(wpol_balance, str) and wpol_balance.startswith("0x"),
            }
            row.update({
                "status": "PASS" if all(checks.values()) else "FAIL",
                "chainId": chain_id,
                "latestBlock": latest,
                "pinnedBlock": PINNED_BLOCK,
                "pinnedBlockHash": pinned_block.get("hash") if isinstance(pinned_block, dict) else None,
                "checks": checks,
            })
            if all(checks.values()):
                selected = url
                selected_checks = row
                attempts.append(row)
                break
        except Exception as error:  # noqa: BLE001
            row["error"] = str(error)
        attempts.append(row)

    result = {
        "scenario": "synergy_v15_5_polygon_archive_rpc_preflight",
        "verdict": "PASS" if selected else "FAIL",
        "evidenceClass": "PUBLIC_POLYGON_PINNED_HISTORICAL_STATE_PREFLIGHT",
        "pinnedBlock": PINNED_BLOCK,
        "selectedHost": urlparse(selected).netloc if selected else None,
        "selectedChecks": selected_checks,
        "attempts": attempts,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=2))
    if not selected:
        raise SystemExit("no archive-capable Polygon endpoint passed")

    github_env = os.getenv("GITHUB_ENV")
    if github_env:
        with open(github_env, "a", encoding="utf-8") as handle:
            handle.write(f"POLYGON_RPC_URL={selected}\n")
            handle.write(f"V155_FORK_BLOCK={PINNED_BLOCK}\n")


if __name__ == "__main__":
    main()
