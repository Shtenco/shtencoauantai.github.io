const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");

const RPC = process.env.POLYGON_RPC_URL || "https://polygon.drpc.org";
const MULTICALL = "0xcA11bde05977b3631167028862bE2a173976CA11";
const V2_FACTORY = "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32";
const V3_FACTORY = "0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28";
const WPOL = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const USDT = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";
const END_BLOCK = Number(process.env.SCAN_END_BLOCK || 90790000);
const START_BLOCK = Number(process.env.SCAN_START_BLOCK || (END_BLOCK - 1_500_000));
const COARSE_STEP = Number(process.env.SCAN_COARSE_STEP || 10000);
const REFINE_RADIUS = Number(process.env.SCAN_REFINE_RADIUS || 12000);
const REFINE_STEP = Number(process.env.SCAN_REFINE_STEP || 500);
const FLASHES = [1, 2, 5, 10, 25, 50, 100, 200];
const PREMIUM_RATE = 0.0005;

const TOKENS = {
  WPOL: [WPOL, 18], USDT: [USDT, 6],
  USDC: ["0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", 6],
  DAI: ["0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", 18],
  WETH: ["0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", 18],
  WBTC: ["0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", 8],
  LINK: ["0x53E0bca35eC356BD5ddDFebBD1Fc0fD03FaBad39", 18],
  AAVE: ["0xD6DF932A45C0f255f85145f286eA0B292B21C90B", 18],
  CRV: ["0x172370d5Cd63279eFa6d502DAB29171933a610AF", 18],
  GHST: ["0x385Eeac5cB85A38A9a07A70c73e0A3271CfB54A7", 18],
  SUSHI: ["0x0b3F868E0BE5597D5DB7fEB59E1CADBb0fdDa50a", 18],
  UNI: ["0xb33EaAd8d922B1083446DC23f610c2567fB5180f", 18],
  BAL: ["0x9a71012B13CA4d3D0Cdc72A177DF3ef03b0E76A3", 18],
  GRT: ["0x5fe2B58c013d7601147DcdD68C143A77499f5531", 18]
};
for (const key of Object.keys(TOKENS)) TOKENS[key][0] = ethers.getAddress(TOKENS[key][0].toLowerCase());
const SYMBOL = Object.fromEntries(Object.entries(TOKENS).map(([s, [a]]) => [a.toLowerCase(), s]));
const provider = new ethers.JsonRpcProvider(RPC, 137, { staticNetwork: true });
const multi = new ethers.Interface([
  "function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns(tuple(bool success,bytes returnData)[] returnData)"
]);
const v2f = new ethers.Interface(["function getPair(address,address) view returns(address)"]);
const v3f = new ethers.Interface(["function poolByPair(address,address) view returns(address)"]);
const poolIf = new ethers.Interface([
  "function token0() view returns(address)",
  "function token1() view returns(address)",
  "function getReserves() view returns(uint112,uint112,uint32)",
  "function globalState() view returns(uint160,int24,uint16,uint16,uint8,uint8,bool)",
  "function liquidity() view returns(uint128)"
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function aggregate(calls, block) {
  const data = multi.encodeFunctionData("aggregate3", [calls]);
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const raw = await provider.call({ to: MULTICALL, data }, block);
      return multi.decodeFunctionResult("aggregate3", raw)[0];
    } catch (e) {
      if (attempt === 5) throw e;
      await sleep(500 * (attempt + 1));
    }
  }
}
function human(raw, decimals) { return Number(ethers.formatUnits(raw, decimals)); }
function cpOutHuman(amount, reserveIn, reserveOut) {
  if (!(amount > 0) || !(reserveIn > 0) || !(reserveOut > 0)) return 0;
  const x = amount * 0.997;
  return x * reserveOut / (reserveIn + x);
}

async function discoverFifty(block) {
  const symbols = Object.keys(TOKENS);
  const calls = [], desc = [];
  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      const a = TOKENS[symbols[i]][0], b = TOKENS[symbols[j]][0];
      calls.push({ target: V2_FACTORY, allowFailure: true, callData: v2f.encodeFunctionData("getPair", [a, b]) });
      desc.push({ kind: 2, a, b });
      calls.push({ target: V3_FACTORY, allowFailure: true, callData: v3f.encodeFunctionData("poolByPair", [a, b]) });
      desc.push({ kind: 3, a, b });
    }
  }
  const rows = await aggregate(calls, block);
  const found = [];
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i].success) continue;
    const iface = desc[i].kind === 2 ? v2f : v3f;
    const fn = desc[i].kind === 2 ? "getPair" : "poolByPair";
    const address = iface.decodeFunctionResult(fn, rows[i].returnData)[0];
    if (address !== ethers.ZeroAddress) found.push({ ...desc[i], pool: ethers.getAddress(address) });
  }
  const unique = [...new Map(found.map((p) => [`${p.kind}:${p.pool.toLowerCase()}`, p])).values()];
  const route2row = await aggregate([{ target: V2_FACTORY, allowFailure: false, callData: v2f.encodeFunctionData("getPair", [WPOL, USDT]) }], block);
  const route3row = await aggregate([{ target: V3_FACTORY, allowFailure: false, callData: v3f.encodeFunctionData("poolByPair", [WPOL, USDT]) }], block);
  const route2 = v2f.decodeFunctionResult("getPair", route2row[0].returnData)[0].toLowerCase();
  const route3 = v3f.decodeFunctionResult("poolByPair", route3row[0].returnData)[0].toLowerCase();
  unique.sort((a, b) => {
    const ar = a.pool.toLowerCase() === route2 || a.pool.toLowerCase() === route3 ? 0 : 1;
    const br = b.pool.toLowerCase() === route2 || b.pool.toLowerCase() === route3 ? 0 : 1;
    return ar - br || a.pool.localeCompare(b.pool) || a.kind - b.kind;
  });
  if (unique.length < 50) throw new Error(`only ${unique.length} pools at discovery block`);
  return unique.slice(0, 50);
}

async function hydrate(selected, block) {
  const calls = [];
  for (const p of selected) {
    calls.push({ target: p.pool, allowFailure: true, callData: poolIf.encodeFunctionData("token0") });
    calls.push({ target: p.pool, allowFailure: true, callData: poolIf.encodeFunctionData("token1") });
    if (p.kind === 2) calls.push({ target: p.pool, allowFailure: true, callData: poolIf.encodeFunctionData("getReserves") });
    else {
      calls.push({ target: p.pool, allowFailure: true, callData: poolIf.encodeFunctionData("globalState") });
      calls.push({ target: p.pool, allowFailure: true, callData: poolIf.encodeFunctionData("liquidity") });
    }
  }
  const rows = await aggregate(calls, block);
  let offset = 0;
  const out = [];
  for (const p of selected) {
    const n = p.kind === 2 ? 3 : 4;
    const r = rows.slice(offset, offset + n); offset += n;
    if (r.some((x) => !x.success)) continue;
    try {
      const token0 = poolIf.decodeFunctionResult("token0", r[0].returnData)[0];
      const token1 = poolIf.decodeFunctionResult("token1", r[1].returnData)[0];
      const s0 = SYMBOL[token0.toLowerCase()], s1 = SYMBOL[token1.toLowerCase()];
      if (!s0 || !s1) continue;
      const d0 = TOKENS[s0][1], d1 = TOKENS[s1][1];
      if (p.kind === 2) {
        const rr = poolIf.decodeFunctionResult("getReserves", r[2].returnData);
        const reserve0 = human(rr[0], d0), reserve1 = human(rr[1], d1);
        if (!(reserve0 > 0 && reserve1 > 0)) continue;
        out.push({ ...p, token0, token1, s0, s1, d0, d1, reserve0, reserve1, fee: 3000 });
      } else {
        const g = poolIf.decodeFunctionResult("globalState", r[2].returnData);
        const liq = poolIf.decodeFunctionResult("liquidity", r[3].returnData)[0];
        if (liq === 0n) continue;
        const sqrt = Number(g[0]) / 2 ** 96;
        const spot01 = sqrt * sqrt * 10 ** (d0 - d1);
        out.push({ ...p, token0, token1, s0, s1, d0, d1, spot01, fee: Number(g[2]) });
      }
    } catch (_) {}
  }
  return out;
}

function edges(pools) {
  const all = [];
  for (const p of pools) {
    if (p.kind === 2) {
      all.push({ pool: p, from: p.token0, to: p.token1, quote: (x) => cpOutHuman(x, p.reserve0, p.reserve1) });
      all.push({ pool: p, from: p.token1, to: p.token0, quote: (x) => cpOutHuman(x, p.reserve1, p.reserve0) });
    } else {
      const f = 1 - p.fee / 1_000_000;
      all.push({ pool: p, from: p.token0, to: p.token1, quote: (x) => x * p.spot01 * f });
      all.push({ pool: p, from: p.token1, to: p.token0, quote: (x) => x / p.spot01 * f });
    }
  }
  return all;
}

function bestAt(pools) {
  const all = edges(pools);
  const adj = new Map();
  for (const e of all) {
    const k = e.from.toLowerCase();
    if (!adj.has(k)) adj.set(k, []);
    adj.get(k).push(e);
  }
  let best = { net: -Infinity, output: 0, input: 0, route: [] };
  function dfs(token, amount, route, usedTokens, usedPools, input) {
    if (route.length >= 2 && token.toLowerCase() === WPOL.toLowerCase()) {
      const net = amount - input - input * PREMIUM_RATE;
      if (Number.isFinite(net) && net > best.net) best = { net, output: amount, input, route: [...route] };
      return;
    }
    if (route.length >= 4) return;
    for (const e of adj.get(token.toLowerCase()) || []) {
      const pk = `${e.pool.kind}:${e.pool.pool.toLowerCase()}`;
      if (usedPools.has(pk)) continue;
      const end = e.to.toLowerCase() === WPOL.toLowerCase();
      if (!end && usedTokens.has(e.to.toLowerCase())) continue;
      const y = e.quote(amount);
      if (!(y > 0) || !Number.isFinite(y)) continue;
      dfs(e.to, y, [...route, e], new Set([...usedTokens, e.to.toLowerCase()]), new Set([...usedPools, pk]), input);
    }
  }
  for (const input of FLASHES) dfs(WPOL, input, [], new Set([WPOL.toLowerCase()]), new Set(), input);
  return best;
}

async function scanBlocks(selected, blocks) {
  const results = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    try {
      const pools = await hydrate(selected, block);
      const best = bestAt(pools);
      results.push({
        block,
        usablePools: pools.length,
        approximateEdgeAfterPremiumWpol: best.net,
        principalWpol: best.input,
        approximateOutputWpol: best.output,
        route: best.route.map((e) => ({ venue: e.pool.kind, pool: e.pool.pool, tokenIn: e.from, tokenOut: e.to }))
      });
      if ((i + 1) % 20 === 0) console.error(`scanned ${i + 1}/${blocks.length}; best=${Math.max(...results.map((x) => x.approximateEdgeAfterPremiumWpol))}`);
    } catch (e) {
      results.push({ block, error: String(e.message || e), approximateEdgeAfterPremiumWpol: -Infinity });
    }
    await sleep(180);
  }
  return results;
}

(async () => {
  const selected = await discoverFifty(END_BLOCK);
  const coarse = [];
  for (let b = START_BLOCK; b <= END_BLOCK; b += COARSE_STEP) coarse.push(b);
  if (coarse[coarse.length - 1] !== END_BLOCK) coarse.push(END_BLOCK);
  const coarseResults = await scanBlocks(selected, coarse);
  const coarseTop = [...coarseResults].filter((x) => Number.isFinite(x.approximateEdgeAfterPremiumWpol)).sort((a, b) => b.approximateEdgeAfterPremiumWpol - a.approximateEdgeAfterPremiumWpol).slice(0, 5);
  const refineSet = new Set();
  for (const top of coarseTop) {
    for (let b = Math.max(START_BLOCK, top.block - REFINE_RADIUS); b <= Math.min(END_BLOCK, top.block + REFINE_RADIUS); b += REFINE_STEP) refineSet.add(b);
  }
  const refineResults = await scanBlocks(selected, [...refineSet].sort((a, b) => a - b));
  const all = [...coarseResults, ...refineResults];
  const best = [...all].filter((x) => Number.isFinite(x.approximateEdgeAfterPremiumWpol)).sort((a, b) => b.approximateEdgeAfterPremiumWpol - a.approximateEdgeAfterPremiumWpol)[0];
  if (!best) throw new Error("no historical block could be evaluated");
  const report = {
    scenario: "v15_8_unmodified_polygon_natural_edge_scan",
    chainId: 137,
    startBlock: START_BLOCK,
    endBlock: END_BLOCK,
    coarseStep: COARSE_STEP,
    refineStep: REFINE_STEP,
    selectedPoolCount: selected.length,
    blocksEvaluated: all.filter((x) => !x.error).length,
    best,
    top20: [...all].filter((x) => Number.isFinite(x.approximateEdgeAfterPremiumWpol)).sort((a, b) => b.approximateEdgeAfterPremiumWpol - a.approximateEdgeAfterPremiumWpol).slice(0, 20)
  };
  fs.mkdirSync(path.join(process.cwd(), "reports"), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), "reports", "v15_8_natural_block_scan.json"), JSON.stringify(report, null, 2));
  console.log(`SELECTED_BLOCK=${best.block}`);
  console.log(`SELECTED_APPROX_EDGE=${best.approximateEdgeAfterPremiumWpol}`);
})().catch((e) => { console.error(e); process.exit(1); });
