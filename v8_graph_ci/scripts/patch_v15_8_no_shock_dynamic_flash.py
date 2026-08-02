#!/usr/bin/env python3
from pathlib import Path

path = Path("test/v15_7_aave_50_pool_qe_qt_polygon_fork.js")
text = path.read_text(encoding="utf-8")

text = text.replace(
    'const FLASH = ethers.parseEther("100");',
    'const FLASH_CANDIDATES = ["1", "2", "5", "10", "25", "50", "100", "200"].map(ethers.parseEther);',
    1,
)

text = text.replace(
    'async function selectBest(pools, v2r, v3q) {',
    'async function selectBest(pools, v2r, v3q, amountIn) {',
    1,
)
text = text.replace(
    'const q = await exactQuote(c.route, FLASH, v2r, v3q);',
    'const q = await exactQuote(c.route, amountIn, v2r, v3q);',
    1,
)

start = text.find('    const routeV2 = await v2f.getPair(WPOL, USDT);')
end_marker = '    const best = await selectBest(pools, v2r, v3q);'
end = text.find(end_marker, start)
if start < 0 or end < 0:
    raise SystemExit("shock block anchors missing")
replacement = '''    // V15.8: no impersonation, no reserve transfer and no pre-cycle price shock.
    // Search the exact 50-pool graph across several real Aave principal sizes.
    let best = null;
    let flashAmount = 0n;
    let bestExternalEdge = -(1n << 255n);
    for (const amount of FLASH_CANDIDATES) {
      const candidate = await selectBest(pools, v2r, v3q, amount);
      const premium = amount * premiumBps / 10000n;
      const externalEdge = candidate.output - amount - premium;
      console.log(`V158_NATURAL_CANDIDATE principal=${ethers.formatEther(amount)} output=${ethers.formatEther(candidate.output)} edgeAfterPremium=${ethers.formatEther(externalEdge)}`);
      if (externalEdge > bestExternalEdge) {
        bestExternalEdge = externalEdge;
        best = candidate;
        flashAmount = amount;
      }
    }
    assert.ok(best, "no executable route from the validated 50-pool graph");
    assert.ok(bestExternalEdge > E("0.35"), `no natural edge above gas floor: ${ethers.formatEther(bestExternalEdge)}`);
'''
text = text[:start] + replacement + text[end + len(end_marker):]

replacements = {
    'best.output > FLASH': 'best.output > flashAmount',
    'const expectedPremium = FLASH * premiumBps / 10000n;': 'const expectedPremium = flashAmount * premiumBps / 10000n;',
    'const theoretical = best.output - FLASH + extracted - buyback - expectedPremium;': 'const theoretical = best.output - flashAmount + extracted - buyback - expectedPremium;',
    'sourceId: id("v15.7-real-aave-50-pool-cycle")': 'sourceId: id("v15.8-natural-real-aave-50-pool-cycle")',
    'flashAmountWpol: FLASH': 'flashAmountWpol: flashAmount',
    'routeAmountWpol: FLASH': 'routeAmountWpol: flashAmount',
    'await receiver.lastFlashAmountWpol(), FLASH': 'await receiver.lastFlashAmountWpol(), flashAmount',
    'scenario: "v15_7_real_aave_50_pool_dynamic_qe_qt"': 'scenario: "v15_8_natural_real_aave_50_pool_dynamic_qe_qt"',
    'independentShockUsdt: rawNumber(shockAmount, 6),': 'independentShockUsdt: 0,',
    'Number(ethers.formatEther(FLASH))': 'Number(ethers.formatEther(flashAmount))',
    'describe("V15.7 real Aave + selected 50-pool graph + QE/QT"': 'describe("V15.8 natural real Aave + selected 50-pool graph + QE/QT"',
    'borrows 100 real WPOL, executes the selected route and closes QE/QT profitably': 'borrows real WPOL with no artificial shock and closes the selected 50-pool route profitably',
    'V157_SELECTED_ROUTE': 'V158_SELECTED_ROUTE',
    'V157_RESULT': 'V158_RESULT',
}
for old, new in replacements.items():
    if old not in text:
        raise SystemExit(f"missing replacement anchor: {old}")
    text = text.replace(old, new)

# Prove the absence of the old mutation surface in the resulting source.
for forbidden in [
    'anvil_impersonateAccount',
    'impersonatedTransfer(',
    'shockAmount',
    'usdtShocker',
    'swapExactTokensForTokens(shock',
]:
    if forbidden in text:
        raise SystemExit(f"forbidden artificial-shock surface remains: {forbidden}")

path.write_text(text, encoding="utf-8")
print("V15.8 no-shock dynamic flash patch applied")
