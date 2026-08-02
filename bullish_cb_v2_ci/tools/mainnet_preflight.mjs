import fs from "node:fs";
import { Contract, JsonRpcProvider, getAddress } from "ethers";

const output = process.argv[2] || "bundle/preflight.json";
const provider = new JsonRpcProvider(process.env.POLYGON_RPC_URL, 137, { staticNetwork: true });
const deployer = getAddress(process.env.DEPLOYER);
const routerAddress = getAddress(process.env.ROUTER);
const factoryAddress = getAddress(process.env.FACTORY);
const usdtAddress = getAddress(process.env.USDT);
const wpolAddress = getAddress(process.env.WPOL);

const network = await provider.getNetwork();
const block = await provider.getBlock("latest");
const [nonceLatest, noncePending, polBalance, feeData] = await Promise.all([
  provider.getTransactionCount(deployer, "latest"),
  provider.getTransactionCount(deployer, "pending"),
  provider.getBalance(deployer),
  provider.getFeeData(),
]);
const usdt = new Contract(usdtAddress, ["function balanceOf(address) view returns(uint256)"], provider);
const router = new Contract(
  routerAddress,
  ["function factory() view returns(address)", "function WETH() view returns(address)"],
  provider
);
const [usdtBalance, routerFactory, routerWeth, routerCode, factoryCode, usdtCode, wpolCode] =
  await Promise.all([
    usdt.balanceOf(deployer),
    router.factory(),
    router.WETH(),
    provider.getCode(routerAddress),
    provider.getCode(factoryAddress),
    provider.getCode(usdtAddress),
    provider.getCode(wpolAddress),
  ]);
const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
if (!block || !gasPrice) throw new Error("Missing live block or gas price");

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
};
if (result.chainId !== 137) throw new Error("Wrong chain");
if (result.routerFactory !== factoryAddress || result.routerWeth !== wpolAddress) {
  throw new Error("QuickSwap binding mismatch");
}
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
fs.mkdirSync(new URL(".", `file://${process.cwd()}/${output}`).pathname, { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
