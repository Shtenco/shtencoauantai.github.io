"use strict";

const fs = require("node:fs");
const path = require("node:path");

const file = path.join(process.cwd(), "test/stateful_v8_recovery_polygon_fork.js");
const before = "      const tx = await supercycle.connect(keeper).executeCycle(plan, id(`cycle-${cycle}`), { gasPrice: GAS_PRICE });";
const after = [
  "      await supercycle.connect(keeper).executeCycle.staticCall(plan, id(`cycle-${cycle}`), { gasPrice: GAS_PRICE, gasLimit: 16_000_000 });",
  "      const tx = await supercycle.connect(keeper).executeCycle(plan, id(`cycle-${cycle}`), { gasPrice: GAS_PRICE, gasLimit: 16_000_000 });"
].join("\n");
let value = fs.readFileSync(file, "utf8");
if (value.includes(after)) {
  console.log("recovery test already prepared");
  process.exit(0);
}
if (!value.includes(before)) throw new Error("recovery transaction line not found");
value = value.replace(before, after);
fs.writeFileSync(file, value);
console.log("added static preflight and explicit 16M gas limit");
