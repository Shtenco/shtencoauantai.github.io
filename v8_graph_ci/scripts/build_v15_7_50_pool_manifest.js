const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");

const RPC = process.env.POLYGON_RPC_URL || "https://polygon.drpc.org";
const BLOCK = Number(process.env.FORK_BLOCK_NUMBER || 90790000);
const MULTICALL = "0xcA11bde05977b3631167028862bE2a173976CA11";
const V2_FACTORY = "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32";
const V3_FACTORY = "0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28";
const WPOL = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const USDT = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";

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
const pair = new ethers.Interface([
  "function token0() view returns(address)",
  "function token1() view returns(address)",
  "function getReserves() view returns(uint112,uint112,uint32)",
  "function globalState() view returns(uint160,int24,uint16,uint16,uint8,uint8,bool)",
  "function liquidity() view returns(uint128)"
]);

async function aggregate(calls) {
  const data = multi.encodeFunctionData("aggregate3", [calls]);
  const raw = await provider.call({ to: MULTICALL, data }, BLOCK);
  return multi.decodeFunctionResult("aggregate3", raw)[0];
}

function number(raw, decimals) { return Number(ethers.formatUnits(raw, decimals)); }

(async () => {
  const symbols = Object.keys(TOKENS);
  const discovery = [];
  const descriptors = [];
  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      const a = TOKENS[symbols[i]][0], b = TOKENS[symbols[j]][0];
      discovery.push({ target: V2_FACTORY, allowFailure: true, callData: v2f.encodeFunctionData("getPair", [a, b]) });
      descriptors.push({ kind: 2, a, b });
      discovery.push({ target: V3_FACTORY, allowFailure: true, callData: v3f.encodeFunctionData("poolByPair", [a, b]) });
      descriptors.push({ kind: 3, a, b });
    }
  }
  const discovered = await aggregate(discovery);
  const candidates = [];
  for (let i = 0; i < discovered.length; i++) {
    if (!discovered[i].success) continue;
    const iface = descriptors[i].kind === 2 ? v2f : v3f;
    const fn = descriptors[i].kind === 2 ? "getPair" : "poolByPair";
    const address = iface.decodeFunctionResult(fn, discovered[i].returnData)[0];
    if (address !== ethers.ZeroAddress) candidates.push({ ...descriptors[i], address: ethers.getAddress(address) });
  }

  const metadataCalls = [];
  for (const p of candidates) {
    metadataCalls.push({ target: p.address, allowFailure: true, callData: pair.encodeFunctionData("token0") });
    metadataCalls.push({ target: p.address, allowFailure: true, callData: pair.encodeFunctionData("token1") });
    if (p.kind === 2) metadataCalls.push({ target: p.address, allowFailure: true, callData: pair.encodeFunctionData("getReserves") });
    else {
      metadataCalls.push({ target: p.address, allowFailure: true, callData: pair.encodeFunctionData("globalState") });
      metadataCalls.push({ target: p.address, allowFailure: true, callData: pair.encodeFunctionData("liquidity") });
    }
  }
  const metadata = await aggregate(metadataCalls);
  let offset = 0;
  const pools = [];
  for (const p of candidates) {
    const n = p.kind === 2 ? 3 : 4;
    const rows = metadata.slice(offset, offset + n); offset += n;
    if (rows.some((r) => !r.success)) continue;
    try {
      const token0 = pair.decodeFunctionResult("token0", rows[0].returnData)[0];
      const token1 = pair.decodeFunctionResult("token1", rows[1].returnData)[0];
      const s0 = SYMBOL[token0.toLowerCase()], s1 = SYMBOL[token1.toLowerCase()];
      if (!s0 || !s1) continue;
      const d0 = TOKENS[s0][1], d1 = TOKENS[s1][1];
      let rate01, rate10, reserve0, reserve1, fee;
      if (p.kind === 2) {
        const r = pair.decodeFunctionResult("getReserves", rows[2].returnData);
        reserve0 = r[0]; reserve1 = r[1]; fee = 3000;
        if (reserve0 === 0n || reserve1 === 0n) continue;
        const spot = number(reserve1, d1) / number(reserve0, d0);
        rate01 = spot * 0.997; rate10 = (1 / spot) * 0.997;
      } else {
        const g = pair.decodeFunctionResult("globalState", rows[2].returnData);
        const liq = pair.decodeFunctionResult("liquidity", rows[3].returnData)[0];
        if (liq === 0n) continue;
        fee = Number(g[2]);
        const sqrt = Number(g[0]) / 2 ** 96;
        const spot = sqrt * sqrt * 10 ** (d0 - d1);
        rate01 = spot * (1 - fee / 1_000_000);
        rate10 = (1 / spot) * (1 - fee / 1_000_000);
        reserve0 = 0n; reserve1 = 0n;
      }
      pools.push({
        kind: p.kind,
        pool: p.address,
        token0, token1, symbol0: s0, symbol1: s1, d0, d1,
        rate01, rate10, fee,
        reserve0: reserve0.toString(), reserve1: reserve1.toString()
      });
    } catch (_) {}
  }

  const routeV2 = v2f.decodeFunctionResult("getPair", (await aggregate([{ target: V2_FACTORY, allowFailure: false, callData: v2f.encodeFunctionData("getPair", [WPOL, USDT]) }]))[0].returnData)[0].toLowerCase();
  const routeV3 = v3f.decodeFunctionResult("poolByPair", (await aggregate([{ target: V3_FACTORY, allowFailure: false, callData: v3f.encodeFunctionData("poolByPair", [WPOL, USDT]) }]))[0].returnData)[0].toLowerCase();
  const unique = [...new Map(pools.map((p) => [`${p.kind}:${p.pool.toLowerCase()}`, p])).values()];
  unique.sort((a, b) => {
    const ar = a.pool.toLowerCase() === routeV2 || a.pool.toLowerCase() === routeV3 ? 0 : 1;
    const br = b.pool.toLowerCase() === routeV2 || b.pool.toLowerCase() === routeV3 ? 0 : 1;
    return ar - br || a.pool.localeCompare(b.pool) || a.kind - b.kind;
  });
  if (unique.length < 50) throw new Error(`only ${unique.length} usable pools`);
  const selectedPools = unique.slice(0, 50);
  if (!selectedPools.some((p) => p.kind === 2 && p.pool.toLowerCase() === routeV2)) throw new Error("V2 route pool missing");
  if (!selectedPools.some((p) => p.kind === 3 && p.pool.toLowerCase() === routeV3)) throw new Error("V3 route pool missing");

  const block = await provider.getBlock(BLOCK);
  const manifest = {
    scenario: "v15_7_historical_multicall_50_pool_manifest",
    chainId: 137,
    blockNumber: BLOCK,
    blockHash: block.hash,
    candidatePools: unique.length,
    selectedExternalPools: 50,
    selectedPools
  };
  fs.mkdirSync(path.join(process.cwd(), "reports"), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), "reports", "v15_7_50_pool_manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ verdict: "PASS", block: BLOCK, candidates: unique.length, selected: 50 }));
})().catch((e) => { console.error(e); process.exit(1); });
