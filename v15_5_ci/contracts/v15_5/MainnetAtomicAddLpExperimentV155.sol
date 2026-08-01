// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IAavePoolV155 {
    function flashLoanSimple(address receiverAddress, address asset, uint256 amount, bytes calldata params, uint16 referralCode) external;
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);
}

interface IFlashLoanSimpleReceiverV155 {
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params) external returns (bool);
}

interface IWrappedPolV155 is IERC20 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

interface IQuickSwapV2FactoryV155 {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
    function createPair(address tokenA, address tokenB) external returns (address pair);
}

interface IQuickSwapV2RouterV155 {
    function factory() external view returns (address);
    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity);
    function removeLiquidity(
        address tokenA,
        address tokenB,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB);
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

interface IQuickSwapV2PairV155 is IERC20 {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
}

contract SynergyExperimentTokenV155 is ERC20 {
    address public immutable controller;
    error Unauthorized();

    constructor(string memory name_, string memory symbol_, address controller_) ERC20(name_, symbol_) {
        controller = controller_;
    }

    function controllerMint(address recipient, uint256 amount) external {
        if (msg.sender != controller) revert Unauthorized();
        _mint(recipient, amount);
    }

    function controllerBurn(address account, uint256 amount) external {
        if (msg.sender != controller) revert Unauthorized();
        _burn(account, amount);
    }
}

/// @notice Polygon-mainnet scientific micro-experiment. It creates two isolated
/// protocol-owned QuickSwap V2 pools and attempts one Aave V3 closed flash cycle:
/// ADDLP, reversible gradients, REMOVE-LP, reserve restoration and strict repayment.
/// Internal mint/burn/LP movement is never recognized as external revenue.
contract MainnetAtomicAddLpExperimentV155 is IFlashLoanSimpleReceiverV155 {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    uint256 public constant REINVESTMENT_BPS = 8_000;
    uint256 public constant EDGE_SCALE_PPT = 1_000_000_000_000;
    uint256 public constant MIN_NET_EDGE_PPT = 268_514_800; // 2.685148 bps
    uint256 public constant MAX_NATIVE_SEED_POL = 2 ether;
    uint256 public constant MAX_CYCLE_GAS_RISK_WEI = 95 ether / 10;

    IAavePoolV155 public immutable aavePool;
    IWrappedPolV155 public immutable wpol;
    IQuickSwapV2RouterV155 public immutable router;
    IQuickSwapV2FactoryV155 public immutable factory;
    SynergyExperimentTokenV155 public immutable tokenA;
    SynergyExperimentTokenV155 public immutable tokenB;
    IQuickSwapV2PairV155 public immutable pairA;
    IQuickSwapV2PairV155 public immutable pairB;
    address public immutable operator;
    address public immutable reinvestmentVault;
    address public immutable retainedTreasury;

    bool public seeded;
    bool public paused;
    bool private active;
    bytes32 private activePlanHash;
    uint256 public completedCycles;
    uint256 public cumulativeNetProfitWpol;
    uint256 public cumulativeReinvestedWpol;
    uint256 public cumulativeRetainedWpol;

    struct Plan {
        uint256 flashAmountWpol;
        uint256 lpWpolA;
        uint256 lpTokenA;
        uint256 lpWpolB;
        uint256 lpTokenB;
        uint256 gradientWpolA;
        uint256 gradientTokenB;
        uint256 minTokenAOut;
        uint256 minWpolBackFromA;
        uint256 minWpolOutFromB;
        uint256 minTokenBBack;
        uint256 minAddWpolA;
        uint256 minAddTokenA;
        uint256 minAddWpolB;
        uint256 minAddTokenB;
        uint256 minRemoveWpolA;
        uint256 minRemoveTokenA;
        uint256 minRemoveWpolB;
        uint256 minRemoveTokenB;
        uint256 maxPremiumWpol;
        uint256 minNetProfitWpol;
        uint256 deadline;
    }

    struct PairSnapshot {
        uint256 wpolReserve;
        uint256 experimentTokenReserve;
        uint256 ownedLp;
    }

    PairSnapshot private activePairA;
    PairSnapshot private activePairB;

    error Unauthorized();
    error InvalidConfiguration();
    error WrongChain();
    error MissingCode();
    error AlreadySeeded();
    error NotSeeded();
    error Paused();
    error ActiveCycle();
    error Expired();
    error GasRiskExceeded();
    error InvalidCallback();
    error ReceiverSubsidyDetected();
    error PremiumAboveCap();
    error PairDamage();
    error LpPositionMismatch();
    error RepaymentShortfall();
    error NetEdgeBelowFloor();
    error SettlementResidue();
    error NativeTransferFailed();

    event PoolsSeeded(uint256 nativePolWrapped, uint256 wpolPerPool, uint256 tokenPerPool, uint256 lpA, uint256 lpB);
    event AtomicExperimentClosed(
        uint256 indexed cycle,
        uint256 flashPrincipalWpol,
        uint256 aavePremiumWpol,
        uint256 netProfitWpol,
        uint256 realizedNetEdgePpt,
        uint256 reinvestedWpol,
        uint256 retainedWpol
    );
    event PausedSet(bool paused);
    event SeedLiquidityRecovered(uint256 wpolRecovered, uint256 nativePolSent);

    modifier onlyOperator() {
        if (msg.sender != operator) revert Unauthorized();
        _;
    }

    modifier whenIdle() {
        if (active) revert ActiveCycle();
        _;
    }

    constructor(
        address aavePool_,
        address wpol_,
        address quickSwapRouter_,
        address quickSwapFactory_,
        address operator_,
        address reinvestmentVault_,
        address retainedTreasury_
    ) {
        if (block.chainid != 137 && block.chainid != 31337) revert WrongChain();
        if (
            aavePool_ == address(0) || wpol_ == address(0) || quickSwapRouter_ == address(0)
                || quickSwapFactory_ == address(0) || operator_ == address(0)
                || reinvestmentVault_ == address(0) || retainedTreasury_ == address(0)
        ) revert InvalidConfiguration();
        if (
            aavePool_.code.length == 0 || wpol_.code.length == 0
                || quickSwapRouter_.code.length == 0 || quickSwapFactory_.code.length == 0
        ) revert MissingCode();

        aavePool = IAavePoolV155(aavePool_);
        wpol = IWrappedPolV155(wpol_);
        router = IQuickSwapV2RouterV155(quickSwapRouter_);
        factory = IQuickSwapV2FactoryV155(quickSwapFactory_);
        operator = operator_;
        reinvestmentVault = reinvestmentVault_;
        retainedTreasury = retainedTreasury_;
        if (router.factory() != quickSwapFactory_) revert InvalidConfiguration();

        tokenA = new SynergyExperimentTokenV155("SYNERGY EXPERIMENT A - NO VALUE", "xSYNA-V155", address(this));
        tokenB = new SynergyExperimentTokenV155("SYNERGY EXPERIMENT B - NO VALUE", "xSYNR-V155", address(this));
        address pairA_ = factory.getPair(wpol_, address(tokenA));
        if (pairA_ == address(0)) pairA_ = factory.createPair(wpol_, address(tokenA));
        address pairB_ = factory.getPair(wpol_, address(tokenB));
        if (pairB_ == address(0)) pairB_ = factory.createPair(wpol_, address(tokenB));
        if (pairA_ == address(0) || pairB_ == address(0) || pairA_ == pairB_) revert InvalidConfiguration();
        pairA = IQuickSwapV2PairV155(pairA_);
        pairB = IQuickSwapV2PairV155(pairB_);

        IERC20(wpol_).forceApprove(quickSwapRouter_, type(uint256).max);
        IERC20(address(tokenA)).forceApprove(quickSwapRouter_, type(uint256).max);
        IERC20(address(tokenB)).forceApprove(quickSwapRouter_, type(uint256).max);
        IERC20(pairA_).forceApprove(quickSwapRouter_, type(uint256).max);
        IERC20(pairB_).forceApprove(quickSwapRouter_, type(uint256).max);
    }

    receive() external payable {
        if (msg.sender != address(wpol)) revert Unauthorized();
    }

    function setPaused(bool paused_) external onlyOperator whenIdle {
        paused = paused_;
        emit PausedSet(paused_);
    }

    function seedPools(uint256 wpolPerPool, uint256 tokenPerPool, uint256 minLpA, uint256 minLpB, uint256 deadline)
        external payable onlyOperator whenIdle
    {
        if (paused) revert Paused();
        if (seeded) revert AlreadySeeded();
        if (block.timestamp > deadline) revert Expired();
        if (
            wpolPerPool == 0 || tokenPerPool == 0 || msg.value != wpolPerPool * 2
                || msg.value > MAX_NATIVE_SEED_POL
        ) revert InvalidConfiguration();

        wpol.deposit{value: msg.value}();
        tokenA.controllerMint(address(this), tokenPerPool);
        tokenB.controllerMint(address(this), tokenPerPool);
        (, , uint256 lpA) = router.addLiquidity(
            address(wpol), address(tokenA), wpolPerPool, tokenPerPool,
            wpolPerPool, tokenPerPool, address(this), deadline
        );
        (, , uint256 lpB) = router.addLiquidity(
            address(wpol), address(tokenB), wpolPerPool, tokenPerPool,
            wpolPerPool, tokenPerPool, address(this), deadline
        );
        if (lpA < minLpA || lpB < minLpB) revert InvalidConfiguration();
        _burnExperimentTokenDust();
        _sweepWpolDust();
        if (wpol.balanceOf(address(this)) != 0) revert SettlementResidue();
        seeded = true;
        emit PoolsSeeded(msg.value, wpolPerPool, tokenPerPool, lpA, lpB);
    }

    function runAtomicCycle(Plan calldata plan) external onlyOperator whenIdle returns (uint256 completedCycle) {
        if (paused) revert Paused();
        if (!seeded) revert NotSeeded();
        if (block.timestamp > plan.deadline) revert Expired();
        if (plan.flashAmountWpol == 0 || plan.maxPremiumWpol == 0) revert InvalidConfiguration();
        if (wpol.balanceOf(address(this)) != 0) revert ReceiverSubsidyDetected();
        if (gasleft() * tx.gasprice > MAX_CYCLE_GAS_RISK_WEI) revert GasRiskExceeded();
        if (plan.lpWpolA + plan.lpWpolB + plan.gradientWpolA > plan.flashAmountWpol) {
            revert InvalidConfiguration();
        }

        activePairA = _snapshot(pairA, address(tokenA));
        activePairB = _snapshot(pairB, address(tokenB));
        activePlanHash = keccak256(abi.encode(plan));
        active = true;
        aavePool.flashLoanSimple(address(this), address(wpol), plan.flashAmountWpol, abi.encode(plan), 0);
        active = false;
        activePlanHash = bytes32(0);
        delete activePairA;
        delete activePairB;
        if (wpol.balanceOf(address(this)) != 0) revert SettlementResidue();
        completedCycle = completedCycles;
    }

    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external returns (bool)
    {
        if (
            msg.sender != address(aavePool) || !active || initiator != address(this) || asset != address(wpol)
        ) revert InvalidCallback();
        Plan memory plan = abi.decode(params, (Plan));
        if (keccak256(abi.encode(plan)) != activePlanHash || amount != plan.flashAmountWpol) revert InvalidCallback();
        if (block.timestamp > plan.deadline) revert Expired();
        if (wpol.balanceOf(address(this)) != amount) revert ReceiverSubsidyDetected();
        if (premium > plan.maxPremiumWpol) revert PremiumAboveCap();

        tokenA.controllerMint(address(this), plan.lpTokenA);
        tokenB.controllerMint(address(this), plan.lpTokenB + plan.gradientTokenB);
        (, , uint256 liquidityA) = router.addLiquidity(
            address(wpol), address(tokenA), plan.lpWpolA, plan.lpTokenA,
            plan.minAddWpolA, plan.minAddTokenA, address(this), plan.deadline
        );
        (, , uint256 liquidityB) = router.addLiquidity(
            address(wpol), address(tokenB), plan.lpWpolB, plan.lpTokenB,
            plan.minAddWpolB, plan.minAddTokenB, address(this), plan.deadline
        );

        if (plan.gradientWpolA > 0) {
            address[] memory forwardA = new address[](2);
            forwardA[0] = address(wpol);
            forwardA[1] = address(tokenA);
            uint256[] memory outA = router.swapExactTokensForTokens(
                plan.gradientWpolA, plan.minTokenAOut, forwardA, address(this), plan.deadline
            );
            address[] memory reverseA = new address[](2);
            reverseA[0] = address(tokenA);
            reverseA[1] = address(wpol);
            router.swapExactTokensForTokens(
                outA[1], plan.minWpolBackFromA, reverseA, address(this), plan.deadline
            );
        }

        if (plan.gradientTokenB > 0) {
            address[] memory forwardB = new address[](2);
            forwardB[0] = address(tokenB);
            forwardB[1] = address(wpol);
            uint256[] memory outB = router.swapExactTokensForTokens(
                plan.gradientTokenB, plan.minWpolOutFromB, forwardB, address(this), plan.deadline
            );
            address[] memory reverseB = new address[](2);
            reverseB[0] = address(wpol);
            reverseB[1] = address(tokenB);
            router.swapExactTokensForTokens(
                outB[1], plan.minTokenBBack, reverseB, address(this), plan.deadline
            );
        }

        router.removeLiquidity(
            address(wpol), address(tokenA), liquidityA,
            plan.minRemoveWpolA, plan.minRemoveTokenA, address(this), plan.deadline
        );
        router.removeLiquidity(
            address(wpol), address(tokenB), liquidityB,
            plan.minRemoveWpolB, plan.minRemoveTokenB, address(this), plan.deadline
        );
        _burnExperimentTokenDust();
        _assertPairRestored(pairA, address(tokenA), activePairA);
        _assertPairRestored(pairB, address(tokenB), activePairB);

        uint256 repayment = amount + premium;
        uint256 balance = wpol.balanceOf(address(this));
        if (balance < repayment) revert RepaymentShortfall();
        uint256 netProfit = balance - repayment;
        uint256 realizedNetEdgePpt = netProfit * EDGE_SCALE_PPT / amount;
        if (netProfit < plan.minNetProfitWpol || realizedNetEdgePpt < MIN_NET_EDGE_PPT) {
            revert NetEdgeBelowFloor();
        }

        uint256 reinvested = netProfit * REINVESTMENT_BPS / BPS;
        uint256 retained = netProfit - reinvested;
        if (reinvested > 0) IERC20(address(wpol)).safeTransfer(reinvestmentVault, reinvested);
        if (retained > 0) IERC20(address(wpol)).safeTransfer(retainedTreasury, retained);
        if (wpol.balanceOf(address(this)) != repayment) revert SettlementResidue();
        IERC20(address(wpol)).forceApprove(address(aavePool), repayment);

        completedCycles += 1;
        cumulativeNetProfitWpol += netProfit;
        cumulativeReinvestedWpol += reinvested;
        cumulativeRetainedWpol += retained;
        emit AtomicExperimentClosed(
            completedCycles, amount, premium, netProfit, realizedNetEdgePpt, reinvested, retained
        );
        return true;
    }

    function recoverSeedLiquidity(
        uint256 minWpolA,
        uint256 minTokenA,
        uint256 minWpolB,
        uint256 minTokenB,
        uint256 deadline,
        bool unwrapToNative
    ) external onlyOperator whenIdle {
        if (!seeded) revert NotSeeded();
        if (block.timestamp > deadline) revert Expired();
        paused = true;
        uint256 lpA = pairA.balanceOf(address(this));
        uint256 lpB = pairB.balanceOf(address(this));
        if (lpA > 0) {
            router.removeLiquidity(
                address(wpol), address(tokenA), lpA, minWpolA, minTokenA, address(this), deadline
            );
        }
        if (lpB > 0) {
            router.removeLiquidity(
                address(wpol), address(tokenB), lpB, minWpolB, minTokenB, address(this), deadline
            );
        }
        _burnExperimentTokenDust();
        uint256 recovered = wpol.balanceOf(address(this));
        if (unwrapToNative && recovered > 0) {
            wpol.withdraw(recovered);
            (bool sent,) = operator.call{value: recovered}("");
            if (!sent) revert NativeTransferFailed();
        } else if (recovered > 0) {
            IERC20(address(wpol)).safeTransfer(operator, recovered);
        }
        seeded = false;
        emit SeedLiquidityRecovered(recovered, unwrapToNative ? recovered : 0);
    }

    function currentPairStates() external view returns (PairSnapshot memory stateA, PairSnapshot memory stateB) {
        stateA = _snapshot(pairA, address(tokenA));
        stateB = _snapshot(pairB, address(tokenB));
    }

    function _snapshot(IQuickSwapV2PairV155 pair, address experimentToken)
        private view returns (PairSnapshot memory state)
    {
        (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
        if (pair.token0() == address(wpol) && pair.token1() == experimentToken) {
            state.wpolReserve = uint256(reserve0);
            state.experimentTokenReserve = uint256(reserve1);
        } else if (pair.token1() == address(wpol) && pair.token0() == experimentToken) {
            state.wpolReserve = uint256(reserve1);
            state.experimentTokenReserve = uint256(reserve0);
        } else {
            revert InvalidConfiguration();
        }
        state.ownedLp = pair.balanceOf(address(this));
    }

    function _assertPairRestored(
        IQuickSwapV2PairV155 pair,
        address experimentToken,
        PairSnapshot memory beforeState
    ) private view {
        PairSnapshot memory afterState = _snapshot(pair, experimentToken);
        if (
            afterState.wpolReserve < beforeState.wpolReserve
                || afterState.experimentTokenReserve < beforeState.experimentTokenReserve
        ) revert PairDamage();
        if (afterState.ownedLp != beforeState.ownedLp) revert LpPositionMismatch();
    }

    function _burnExperimentTokenDust() private {
        uint256 balanceA = tokenA.balanceOf(address(this));
        uint256 balanceB = tokenB.balanceOf(address(this));
        if (balanceA > 0) tokenA.controllerBurn(address(this), balanceA);
        if (balanceB > 0) tokenB.controllerBurn(address(this), balanceB);
    }

    function _sweepWpolDust() private {
        uint256 dust = wpol.balanceOf(address(this));
        if (dust > 0) IERC20(address(wpol)).safeTransfer(retainedTreasury, dust);
    }
}
