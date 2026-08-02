// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BullishQuickSwapCentralBankV2} from "./BullishQuickSwapRefillV2.sol";

contract BullishQuickSwapScaled150 is BullishQuickSwapCentralBankV2 {
    uint256 public constant SCALED_BUY_USDT = 150_000;
    uint256 public constant SCALED_SELL_NOTIONAL_USDT = 60_000;
    uint256 public constant DEAL_SCALE_BPS = 15_000;

    event ScaledCycleExecuted(
        uint256 indexed nonce,
        uint256 dealScaleBps,
        uint256 buyUsdt,
        uint256 sellNotionalUsdt,
        uint256 priceX18,
        uint256 supply,
        uint256 tvlUsdt,
        uint256 robotBalanceUsdt,
        uint256 treasuryBalanceUsdt,
        uint256 systemMetricUsdt
    );

    constructor(
        address owner_,
        address router_,
        address usdt_,
        address wpol_,
        address syna_
    ) BullishQuickSwapCentralBankV2(owner_, router_, usdt_, wpol_, syna_) {}

    function executeScaledCycle(
        uint256 expectedNonce,
        uint256 deadline,
        uint256 minSystemMetricUsdt
    ) external onlyOperator whenNotPaused lock {
        require(initialized && block.timestamp <= deadline, "DEADLINE");
        require(expectedNonce == nonce, "NONCE");
        nonce = expectedNonce + 1;

        _ensureRobotCapital(robotTargetUsdt, deadline);
        require(robotUsdt >= MIN_CYCLE_USDT, "ROBOT_CAPITAL");

        _buy(SCALED_BUY_USDT, deadline);
        _buy(SCALED_BUY_USDT, deadline);
        for (uint256 i = 0; i < 5; ++i) {
            _sellNotional(SCALED_SELL_NOTIONAL_USDT, deadline);
        }

        _assertLedger();
        uint256 metric = systemMetricUsdt();
        require(metric >= minSystemMetricUsdt, "METRIC_FLOOR");
        emit ScaledCycleExecuted(
            expectedNonce,
            DEAL_SCALE_BPS,
            SCALED_BUY_USDT,
            SCALED_SELL_NOTIONAL_USDT,
            spotPriceX18(),
            syna.totalSupply(),
            poolTvlUsdt(),
            robotBalanceUsdt(),
            treasuryUsdt,
            metric
        );
    }
}
