#!/usr/bin/env python3
from pathlib import Path

path = Path("test/v15_7_aave_50_pool_qe_qt_polygon_fork.js")
text = path.read_text(encoding="utf-8")
needle = "};\nconst SYMBOL = Object.fromEntries"
replacement = (
    "};\n"
    "for (const key of Object.keys(TOKENS)) {\n"
    "  TOKENS[key][0] = ethers.getAddress(TOKENS[key][0].toLowerCase());\n"
    "}\n"
    "const SYMBOL = Object.fromEntries"
)
if replacement in text:
    print("V15.7 token addresses already normalized")
elif needle in text:
    path.write_text(text.replace(needle, replacement, 1), encoding="utf-8")
    print("V15.7 token addresses normalized")
else:
    raise SystemExit("V15.7 token normalization anchor not found")
