// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {TemporaryQETokenV11} from "../fork/SynergyAtomicQeQtCycleV11.sol";

interface IAavePoolV157 {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);
}

interface ISynergyDexRouterV157 {
    function swapExactTokensForTokens(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minimumAmountOut,
        address to,
        uint256 deadline
    ) external returns (uint256 amountOut);
}

interface ISynergyPairV157 {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 timestamp);
}

interface IQuickSwapV2FactoryV157 {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

interface IQuickSwapV3FactoryV157 {
    function poolByPair(address tokenA, address tokenB) external view returns (address pool);
}

interface IQuickSwapV2RouterV157 {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

interface IAlgebraSwapRouterV157 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 limitSqrtPrice;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

contract AaveFiftyPoolQeQtV157 {
    using SafeERC20 for IERC20;

    uint8 public constant VENUE_V2 = 2;
    uint8 public constant VENUE_V3 = 3;
    uint256 public constant BPS = 10_000;
    uint256 public constant INTERNAL_FEE_BPS = 30;
    uint256 public constant MAX_HOPS = 4;
    uint256 public constant MAX_SYNTHETIC_DUST = 2;

    struct Leg {
        uint8 venue;
        address pool;
        address tokenIn;
        address tokenOut;
        uint256 minOut;
    }

    struct Plan {
        bytes32 sourceId;
        uint256 nonce;
        uint256 deadline;
        uint256 flashAmountWpol;
        uint256 qeMint;
        uint256 minExtractedWpol;
        uint256 routeAmountWpol;
        Leg[] legs;
        uint256 maxPremiumWpol;
        uint256 minProfitWpol;
    }

    IAavePoolV157 public immutable aavePool;
    IERC20 public immutable wpol;
    TemporaryQETokenV11 public immutable synthetic;
    ISynergyDexRouterV157 public immutable internalRouter;
    ISynergyPairV157 public immutable internalPair;
    IQuickSwapV2RouterV157 public immutable v2Router;
    IAlgebraSwapRouterV157 public immutable v3Router;
    IQuickSwapV2FactoryV157 public immutable v2Factory;
    IQuickSwapV3FactoryV157 public immutable v3Factory;
    address public immutable operator;
    address public immutable treasury;

    bool private active;
    bytes32 private activePlanHash;
    mapping(uint256 => bool) public nonceUsed;
    mapping(bytes32 => bool) public sourceUsed;

    uint256 public temporaryOutstanding;
    uint256 public completedCycles;
    uint256 public cumulativeVerifiedProfitWpol;
    uint256 public lastFlashAmountWpol;
    uint256 public lastPremiumWpol;
    uint256 public lastQeMint;
    uint256 public lastExtractedWpol;
    uint256 public lastRouteOutputWpol;
    uint256 public lastBuybackWpol;
    uint256 public lastProfitWpol;
    uint256 public lastSyntheticDust;
    uint256 public lastKBefore;
    uint256 public lastKAfter;
    bytes32 public lastRouteHash;

    error Unauthorized();
    error InvalidPlan();
    error Expired();
    error Replay();
    error InvalidCallback();
    error ReceiverSubsidyDetected();
    error PremiumAboveCap();
    error RouteMismatch();
    error RouteLoss();
    error BuybackNotCovered();
    error TemporarySupplyNotClosed();
    error PoolNotRestored();
    error RepaymentShortfall();
    error ProfitBelowFloor();
    error SettlementResidue();

    event UnifiedCycleClosed(
        bytes32 indexed sourceId,
        uint256 indexed nonce,
        uint256 flashAmountWpol,
        uint256 premiumWpol,
        uint256 qeMint,
        uint256 extractedWpol,
        uint256 routeOutputWpol,
        uint256 buybackWpol,
        uint256 profitWpol,
        bytes32 routeHash
    );

    constructor(
        address aavePool_,
        address wpol_,
        address synthetic_,
        address internalRouter_,
        address internalPair_,
        address v2Router_,
        address v3Router_,
        address v2Factory_,
        address v3Factory_,
        address operator_,
        address treasury_
    ) {
        if (
            aavePool_ == address(0) || wpol_ == address(0) || synthetic_ == address(0)
                || internalRouter_ == address(0) || internalPair_ == address(0)
                || v2Router_ == address(0) || v3Router_ == address(0)
                || v2Factory_ == address(0) || v3Factory_ == address(0)
                || operator_ == address(0) || treasury_ == address(0)
        ) revert InvalidPlan();
        if (
            aavePool_.code.length == 0 || wpol_.code.length == 0 || synthetic_.code.length == 0
                || internalRouter_.code.length == 0 || internalPair_.code.length == 0
                || v2Router_.code.length == 0 || v3Router_.code.length == 0
                || v2Factory_.code.length == 0 || v3Factory_.code.length == 0
        ) revert InvalidPlan();

        aavePool = IAavePoolV157(aavePool_);
        wpol = IERC20(wpol_);
        synthetic = TemporaryQETokenV11(synthetic_);
        internalRouter = ISynergyDexRouterV157(internalRouter_);
        internalPair = ISynergyPairV157(internalPair_);
        v2Router = IQuickSwapV2RouterV157(v2Router_);
        v3Router = IAlgebraSwapRouterV157(v3Router_);
        v2Factory = IQuickSwapV2FactoryV157(v2Factory_);
        v3Factory = IQuickSwapV3FactoryV157(v3Factory_);
        operator = operator_;
        treasury = treasury_;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert Unauthorized();
        _;
    }

    function run(Plan calldata plan) external onlyOperator returns (uint256 cycle) {
        if (active) revert InvalidPlan();
        if (block.timestamp > plan.deadline) revert Expired();
        if (
            plan.sourceId == bytes32(0) || plan.flashAmountWpol == 0 || plan.qeMint == 0
                || plan.minExtractedWpol == 0 || plan.routeAmountWpol != plan.flashAmountWpol
                || plan.maxPremiumWpol == 0 || plan.minProfitWpol == 0
        ) revert InvalidPlan();
        if (nonceUsed[plan.nonce] || sourceUsed[plan.sourceId]) revert Replay();
        if (wpol.balanceOf(address(this)) != 0) revert ReceiverSubsidyDetected();
        _validateRoute(plan.legs);

        nonceUsed[plan.nonce] = true;
        sourceUsed[plan.sourceId] = true;
        activePlanHash = keccak256(abi.encode(plan));
        active = true;
        aavePool.flashLoanSimple(
            address(this), address(wpol), plan.flashAmountWpol, abi.encode(plan), 0
        );
        active = false;
        activePlanHash = bytes32(0);
        if (wpol.balanceOf(address(this)) != 0) revert SettlementResidue();
        cycle = completedCycles;
    }

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        if (
            msg.sender != address(aavePool) || !active || initiator != address(this)
                || asset != address(wpol)
        ) revert InvalidCallback();
        Plan memory plan = abi.decode(params, (Plan));
        if (
            keccak256(abi.encode(plan)) != activePlanHash || amount != plan.flashAmountWpol
                || plan.routeAmountWpol != amount
        ) revert InvalidCallback();
        if (block.timestamp > plan.deadline) revert Expired();
        if (wpol.balanceOf(address(this)) != amount) revert ReceiverSubsidyDetected();
        if (premium > plan.maxPremiumWpol) revert PremiumAboveCap();

        (uint256 syntheticBefore, uint256 liquidBefore) = _pairBalances();
        uint256 supplyBefore = synthetic.totalSupply();
        uint256 kBefore = syntheticBefore * liquidBefore;
        uint256 treasuryBefore = wpol.balanceOf(treasury);

        temporaryOutstanding = plan.qeMint;
        synthetic.mintTemporary(address(this), plan.qeMint);
        IERC20(address(synthetic)).forceApprove(address(internalRouter), plan.qeMint);
        uint256 extracted = internalRouter.swapExactTokensForTokens(
            address(synthetic), address(wpol), plan.qeMint, plan.minExtractedWpol,
            address(this), plan.deadline
        );

        uint256 routeOutput = _executeRoute(plan.routeAmountWpol, plan.legs, plan.deadline);
        if (routeOutput <= plan.routeAmountWpol) revert RouteLoss();

        (uint256 syntheticReserve, uint256 wpolReserve) = _pairReserves();
        uint256 buybackWpol = _getAmountIn(plan.qeMint, wpolReserve, syntheticReserve);
        wpol.forceApprove(address(internalRouter), buybackWpol);
        uint256 syntheticBought = internalRouter.swapExactTokensForTokens(
            address(wpol), address(synthetic), buybackWpol, plan.qeMint,
            address(this), plan.deadline
        );
        if (syntheticBought < plan.qeMint) revert BuybackNotCovered();

        synthetic.burnTemporary(plan.qeMint);
        temporaryOutstanding = 0;
        uint256 dust = synthetic.balanceOf(address(this));
        if (dust > MAX_SYNTHETIC_DUST) revert PoolNotRestored();
        if (dust > 0) IERC20(address(synthetic)).safeTransfer(treasury, dust);

        uint256 repayment = amount + premium;
        uint256 balance = wpol.balanceOf(address(this));
        if (balance < repayment) revert RepaymentShortfall();
        uint256 profit = balance - repayment;
        if (profit < plan.minProfitWpol) revert ProfitBelowFloor();

        (uint256 syntheticAfter, uint256 liquidAfter) = _pairBalances();
        uint256 kAfter = syntheticAfter * liquidAfter;
        if (synthetic.totalSupply() != supplyBefore || temporaryOutstanding != 0) {
            revert TemporarySupplyNotClosed();
        }
        if (
            syntheticAfter + dust < syntheticBefore || liquidAfter < liquidBefore
                || kAfter < kBefore
        ) revert PoolNotRestored();

        if (profit > 0) wpol.safeTransfer(treasury, profit);
        if (wpol.balanceOf(address(this)) != repayment) revert SettlementResidue();
        wpol.forceApprove(address(aavePool), repayment);

        completedCycles += 1;
        cumulativeVerifiedProfitWpol += profit;
        lastFlashAmountWpol = amount;
        lastPremiumWpol = premium;
        lastQeMint = plan.qeMint;
        lastExtractedWpol = extracted;
        lastRouteOutputWpol = routeOutput;
        lastBuybackWpol = buybackWpol;
        lastProfitWpol = profit;
        lastSyntheticDust = dust;
        lastKBefore = kBefore;
        lastKAfter = kAfter;
        lastRouteHash = keccak256(abi.encode(plan.legs));

        if (wpol.balanceOf(treasury) != treasuryBefore + profit) revert ProfitBelowFloor();
        emit UnifiedCycleClosed(
            plan.sourceId, plan.nonce, amount, premium, plan.qeMint, extracted,
            routeOutput, buybackWpol, profit, lastRouteHash
        );
        return true;
    }

    function quoteBuyback(uint256 syntheticAmount) external view returns (uint256) {
        (uint256 syntheticReserve, uint256 wpolReserve) = _pairReserves();
        return _getAmountIn(syntheticAmount, wpolReserve, syntheticReserve);
    }

    function _executeRoute(uint256 amountIn, Leg[] memory legs, uint256 deadline)
        private returns (uint256 amountOut)
    {
        amountOut = amountIn;
        for (uint256 i = 0; i < legs.length; ++i) {
            Leg memory leg = legs[i];
            IERC20(leg.tokenIn).forceApprove(
                leg.venue == VENUE_V2 ? address(v2Router) : address(v3Router), amountOut
            );
            if (leg.venue == VENUE_V2) {
                address[] memory path = new address[](2);
                path[0] = leg.tokenIn;
                path[1] = leg.tokenOut;
                uint256[] memory amounts = v2Router.swapExactTokensForTokens(
                    amountOut, leg.minOut, path, address(this), deadline
                );
                amountOut = amounts[amounts.length - 1];
            } else {
                amountOut = v3Router.exactInputSingle(
                    IAlgebraSwapRouterV157.ExactInputSingleParams({
                        tokenIn: leg.tokenIn,
                        tokenOut: leg.tokenOut,
                        recipient: address(this),
                        deadline: deadline,
                        amountIn: amountOut,
                        amountOutMinimum: leg.minOut,
                        limitSqrtPrice: 0
                    })
                );
            }
        }
    }

    function _validateRoute(Leg[] calldata legs) private view {
        if (legs.length < 2 || legs.length > MAX_HOPS) revert RouteMismatch();
        if (legs[0].tokenIn != address(wpol) || legs[legs.length - 1].tokenOut != address(wpol)) {
            revert RouteMismatch();
        }
        for (uint256 i = 0; i < legs.length; ++i) {
            Leg calldata leg = legs[i];
            if (
                leg.pool == address(0) || leg.tokenIn == address(0) || leg.tokenOut == address(0)
                    || leg.tokenIn == leg.tokenOut || leg.minOut == 0
            ) revert RouteMismatch();
            if (i > 0 && legs[i - 1].tokenOut != leg.tokenIn) revert RouteMismatch();
            address expected;
            if (leg.venue == VENUE_V2) {
                expected = v2Factory.getPair(leg.tokenIn, leg.tokenOut);
            } else if (leg.venue == VENUE_V3) {
                expected = v3Factory.poolByPair(leg.tokenIn, leg.tokenOut);
            } else {
                revert RouteMismatch();
            }
            if (expected == address(0) || expected != leg.pool || expected.code.length == 0) {
                revert RouteMismatch();
            }
            for (uint256 j = 0; j < i; ++j) {
                if (legs[j].pool == leg.pool) revert RouteMismatch();
            }
        }
    }

    function _getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut)
        private pure returns (uint256)
    {
        if (amountOut == 0 || reserveIn == 0 || amountOut >= reserveOut) revert InvalidPlan();
        return reserveIn * amountOut * BPS /
            ((reserveOut - amountOut) * (BPS - INTERNAL_FEE_BPS)) + 1;
    }

    function _pairReserves() private view returns (uint256 syntheticReserve, uint256 liquidReserve) {
        (uint112 r0, uint112 r1,) = internalPair.getReserves();
        if (internalPair.token0() == address(synthetic)) return (uint256(r0), uint256(r1));
        if (internalPair.token1() != address(synthetic)) revert InvalidPlan();
        return (uint256(r1), uint256(r0));
    }

    function _pairBalances() private view returns (uint256 syntheticBalance, uint256 liquidBalance) {
        syntheticBalance = synthetic.balanceOf(address(internalPair));
        liquidBalance = wpol.balanceOf(address(internalPair));
    }
}
