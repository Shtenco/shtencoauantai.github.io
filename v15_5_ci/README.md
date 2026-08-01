# V15.5 isolated compiler and Polygon archive-fork evidence

This directory is an isolated CI-only evidence workspace for `Shtenco/ai_financial_system` PR #8.

It does not modify the published website or the `main` branch. The exact V15.5 Solidity source is compiled with `solc 0.8.26`, then executed on a pinned Polygon archive fork against the deployed Aave V3 Pool, WPOL, QuickSwap V2 Router and Factory.

Expected scientific result: the internal-only ADDLP/swap/unwind cycle reverts atomically because it cannot create external WPOL surplus sufficient to pay Aave premium and the strict edge floor.
