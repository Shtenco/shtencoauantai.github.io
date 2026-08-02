import fs from "node:fs";
import path from "node:path";
import { Contract, Interface, JsonRpcProvider, getAddress, parseEther } from "ethers";

const output = process.argv[2] || "bundle/preflight.json";
const provider = new JsonRpcProvider(process.env.POLYGON_RPC_URL, 137, { staticNetwork: true });
const deployer = getAddress(process.env.DEPLOYER);
const routerAddress = getAddress(process.env.ROUTER);
const factoryAddress = getAddress(process.env.FACTORY);
const usdtAddress = getAddress(process.env.USDT);
const wpolAddress = getAddress(process.env.WPOL);
const swapPolIn = parseEther("30");

const network = await provider.getNetwork();
const block = await provider.getBlock("latest");
const [nonceLatest, noncePending, polBalance, feeData] = await Promise.all([
  provider.getTransactionCount(deployer, "latest"),
  provider.getTransactionCount(deployer, "pending"),
  provider.getBalance(deployer),
  provider.getFeeData(),
]);
const usdt = new Contract(usdtAddress, ["function balanceOf(address) view returns(uint256)"], provider);
const routerAbi = [
  "function factory() view returns(address)",
  "function WETH() view returns(address)",
  "function getAmountsOut(uint256,address[]) view returns(uint256[])",
  "function swapExactETHForTokens(uint256,address[],address,uint256) payable returns(uint256[])"
];
const router = new Contract(routerAddress, routerAbi, provider);
const [
  usdtBalance,
  routerFactory,
  routerWeth,
  swapQuote,
  routerCode,
  factoryCode,
  usdtCode,
  wpolCode,
] = await Promise.all([
  usdt.balanceOf(deployer),
  router.factory(),
  router.WETH(),
  router.getAmountsOut(swapPolIn, [wpolAddress, usdtAddress]),
  provider.getCode(routerAddress),
  provider.getCode(factoryAddress),
  provider.getCode(usdtAddress),
  provider.getCode(wpolAddress),
]);
const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
if (!block || !gasPrice) throw new Error("Missing live block or gas price");
const deadline = block.timestamp + 3600;
const minUsdtOut = swapQuote[1] * 97n / 100n;
const iface = new Interface(routerAbi);
const swapData = iface.encodeFunctionData("swapExactETHForTokens", [
  minUsdtOut,
  [wpolAddress, usdtAddress],
  deployer,
  deadline,
]);
const swapGasEstimate = await provider.estimateGas({
  from: deployer,
  to: routerAddress,
  value: swapPolIn,
  data: swapData,
});

const result = {
  chainId: Number(network.chainId),
  blockNumber: block.number,
  blockTimestamp: block.timestamp,
  blockGasLimit: block.gasLimit.toString(),
  baseFeePerGasWei: (block.baseFeePerGas ?? 0n).toString(),
  gasPriceWei: gasPrice.toString(),
  deployer,
  nonceLatest: nonceLatest.toString(),
  noncePending: noncePending.toString(),
  polBalanceWei: polBalance.toString(),
  usdt: usdtAddress,
  usdtBalanceRaw: usdtBalance.toString(),
  router: routerAddress,
  factory: factoryAddress,
  wpol: wpolAddress,
  routerFactory: getAddress(routerFactory),
  routerWeth: getAddress(routerWeth),
  routerCodeBytes: (routerCode.length - 2) / 2,
  factoryCodeBytes: (factoryCode.length - 2) / 2,
  usdtCodeBytes: (usdtCode.length - 2) / 2,
  wpolCodeBytes: (wpolCode.length - 2) / 2,
  fundingSwap: {
    polInWei: swapPolIn.toString(),
    expectedUsdtRaw: swapQuote[1].toString(),
    minUsdtOutRaw: minUsdtOut.toString(),
    deadline,
    gasEstimate: swapGasEstimate.toString(),
    data: swapData,
  },
};
if (result.chainId !== 137) throw new Error("Wrong chain");
if (result.routerFactory !== factoryAddress || result.routerWeth !== wpolAddress) {
  throw new Error("QuickSwap binding mismatch");
}
if (swapQuote[1] < 2_100_000n) throw new Error("30 POL quote is insufficient to fund 2 USDT bootstrap");
if (
  Math.min(
    result.routerCodeBytes,
    result.factoryCodeBytes,
    result.usdtCodeBytes,
    result.wpolCodeBytes
  ) <= 0
) {
  throw new Error("Missing contract code");
}
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
