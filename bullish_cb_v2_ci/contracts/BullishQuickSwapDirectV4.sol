// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {RebaseSynaExactV3} from "./RebaseSynaExactV3.sol";

interface IERC20V4 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IQSFactoryV4 {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
    function createPair(address tokenA, address tokenB) external returns (address pair);
}

interface IQSPairV4 is IERC20V4 {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 timestamp);
    function mint(address to) external returns (uint256 liquidity);
    function burn(address to) external returns (uint256 amount0, uint256 amount1);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
    function sync() external;
}

interface IQSRouterGasV4 {
    function factory() external view returns (address);
    function WETH() external view returns (address);
    function swapTokensForExactETH(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
    function getAmountsIn(uint256 amountOut, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts);
}

library SafeTransferV4 {
    error TokenCallFailed();

    function transfer(IERC20V4 token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = address(token).call(
            abi.encodeWithSelector(token.transfer.selector, to, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenCallFailed();
    }

    function transferFrom(IERC20V4 token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = address(token).call(
            abi.encodeWithSelector(token.transferFrom.selector, from, to, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenCallFailed();
    }

    function approve(IERC20V4 token, address spender, uint256 amount) internal {
        (bool ok, bytes memory data) = address(token).call(
            abi.encodeWithSelector(token.approve.selector, spender, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) {
            (ok, data) = address(token).call(abi.encodeWithSelector(token.approve.selector, spender, 0));
            if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenCallFailed();
            (ok, data) = address(token).call(
                abi.encodeWithSelector(token.approve.selector, spender, amount)
            );
            if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenCallFailed();
        }
    }
}

contract BullishQuickSwapDirectV4 {
    using SafeTransferV4 for IERC20V4;

    error OwnerOnly();
    error OperatorOnly();
    error InvalidConfig();
    error Deadline();
    error Nonce();
    error Paused();
    error Locked();
    error InsufficientCapital();
    error MetricFloor();
    error Ledger();
    error Price();
    error Quote();
    error GasRefill();

    uint256 public constant FEE_BPS = 30;
    uint256 public constant TRIGGER_BPS = 100;
    uint256 public constant MAX_BURN_BPS = 800;
    uint256 public constant MAX_MINT_BPS = 400;
    uint256 public constant SMA_WINDOW = 20;
    uint256 public constant COOLDOWN_TRADES = 8;
    uint256 public constant BUY_USDT = 100_000;
    uint256 public constant SELL_NOTIONAL_USDT = 40_000;
    uint256 public constant MIN_CYCLE_USDT = 200_000;
    uint256 public constant PRICE_SCALE = 1e30;
    uint256 public constant MAX_LP_REFILL_BPS = 1_000;
    uint256 public constant MAX_EXACT_GAS_REFILL_POL = 2 ether;

    address public immutable owner;
    address public keeper;
    IERC20V4 public immutable usdt;
    address public immutable wpol;
    RebaseSynaExactV3 public immutable syna;
    IQSRouterGasV4 public immutable router;
    IQSFactoryV4 public immutable factory;
    IQSPairV4 public pair;
    bool public tokenIs0;

    uint256 public robotUsdt;
    uint256 public treasuryUsdt;
    uint256 public nonce;
    uint256 public cooldown;
    uint256 public priceSum;
    uint256 public priceCursor;
    uint256[20] public prices;

    uint256 public robotTargetUsdt = 300_000;
    uint256 public treasuryGasFloorUsdt = 20_000;
    uint256 public maxLpRefillBps = 500;
    uint256 public gasRefillCooldownBlocks = 100;
    uint256 public lastGasRefillBlock;
    uint256 public cumulativeGasRefillUsdt;

    bool public initialized;
    bool public isPaused;
    uint256 private unlocked = 1;

    event Cycle(uint256 indexed nonce, uint256 price, uint256 tvl, uint256 robot, uint256 treasury);
    event RobotRefill(uint8 indexed source, uint256 usdtAdded, uint256 tokenSpent, uint256 lpBurned);
    event GasRefill(address indexed keeper, uint256 exactPol, uint256 usdtSpent);
    event Stabilize(uint8 indexed action, uint256 bps, uint256 tokenAmount, uint256 usdtAmount);
    event Pause(bool paused);

    modifier onlyOwner() {
        if (msg.sender != owner) revert OwnerOnly();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != owner && msg.sender != keeper) revert OperatorOnly();
        _;
    }

    modifier lock() {
        if (unlocked != 1) revert Locked();
        unlocked = 0;
        _;
        unlocked = 1;
    }

    modifier active() {
        if (isPaused) revert Paused();
        _;
    }

    constructor(address owner_, address router_, address usdt_, address wpol_, address syna_) {
        if (
            owner_ == address(0) || router_ == address(0) || usdt_ == address(0)
                || wpol_ == address(0) || syna_ == address(0)
        ) revert InvalidConfig();
        owner = owner_;
        keeper = owner_;
        router = IQSRouterGasV4(router_);
        if (router.WETH() != wpol_) revert InvalidConfig();
        address f = router.factory();
        if (f == address(0)) revert InvalidConfig();
        factory = IQSFactoryV4(f);
        usdt = IERC20V4(usdt_);
        wpol = wpol_;
        syna = RebaseSynaExactV3(syna_);
        IERC20V4(usdt_).approve(router_, type(uint256).max);
    }

    function setKeeper(address value) external onlyOwner {
        if (value == address(0)) revert InvalidConfig();
        keeper = value;
    }

    function setRefillConfig(uint256 target, uint256 gasFloor, uint256 lpRefillBps, uint256 gasCooldown)
        external
        onlyOwner
    {
        if (
            target < MIN_CYCLE_USDT || lpRefillBps == 0 || lpRefillBps > MAX_LP_REFILL_BPS
                || gasCooldown < 10
        ) revert InvalidConfig();
        robotTargetUsdt = target;
        treasuryGasFloorUsdt = gasFloor;
        maxLpRefillBps = lpRefillBps;
        gasRefillCooldownBlocks = gasCooldown;
    }

    function pause() external onlyOperator {
        isPaused = true;
        emit Pause(true);
    }

    function unpause() external onlyOwner {
        isPaused = false;
        emit Pause(false);
    }

    function initialize(
        uint256 totalSupply,
        uint256 poolToken,
        uint256 poolUsdt,
        uint256 workingUsdt,
        uint256 deadline
    ) external onlyOwner lock {
        if (
            initialized || block.timestamp > deadline || totalSupply <= poolToken || poolToken == 0
                || poolUsdt == 0 || workingUsdt < MIN_CYCLE_USDT
        ) revert InvalidConfig();

        usdt.transferFrom(owner, address(this), poolUsdt + workingUsdt);
        syna.mint(address(this), poolToken);
        syna.mint(owner, totalSupply - poolToken);

        address p = factory.getPair(address(syna), address(usdt));
        if (p == address(0)) p = factory.createPair(address(syna), address(usdt));
        pair = IQSPairV4(p);
        tokenIs0 = pair.token0() == address(syna);
        if (!tokenIs0 && pair.token1() != address(syna)) revert InvalidConfig();

        IERC20V4(address(syna)).transfer(p, poolToken);
        usdt.transfer(p, poolUsdt);
        if (pair.mint(address(this)) == 0) revert InvalidConfig();

        robotUsdt = workingUsdt;
        treasuryUsdt = 0;
        uint256 p0 = spotPriceX18();
        for (uint256 i; i < SMA_WINDOW; ++i) prices[i] = p0;
        priceSum = p0 * SMA_WINDOW;
        initialized = true;
        _assertLedger();
    }

    function reserves() public view returns (uint256 tokenReserve, uint256 usdtReserve) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        if (tokenIs0) {
            tokenReserve = uint256(r0);
            usdtReserve = uint256(r1);
        } else {
            tokenReserve = uint256(r1);
            usdtReserve = uint256(r0);
        }
        if (tokenReserve == 0 || usdtReserve == 0) revert Price();
    }

    function spotPriceX18() public view returns (uint256) {
        (uint256 rt, uint256 ru) = reserves();
        uint256 value = ru * PRICE_SCALE / rt;
        if (value == 0) revert Price();
        return value;
    }

    function poolTvlUsdt() public view returns (uint256) {
        (uint256 rt, uint256 ru) = reserves();
        return ru + rt * spotPriceX18() / PRICE_SCALE;
    }

    function robotBalanceUsdt() public view returns (uint256) {
        return robotUsdt + syna.balanceOf(address(this)) * spotPriceX18() / PRICE_SCALE;
    }

    function systemMetricUsdt() public view returns (uint256) {
        return poolTvlUsdt() + robotBalanceUsdt() + treasuryUsdt;
    }

    function executeCycle(uint256 expectedNonce, uint256 deadline, uint256 minMetric)
        external
        onlyOperator
        active
        lock
    {
        if (!initialized || block.timestamp > deadline) revert Deadline();
        if (expectedNonce != nonce) revert Nonce();
        nonce = expectedNonce + 1;
        _ensureRobotCapital(robotTargetUsdt, deadline);
        if (robotUsdt < MIN_CYCLE_USDT) revert InsufficientCapital();

        _buy(BUY_USDT, deadline);
        _buy(BUY_USDT, deadline);
        for (uint256 i; i < 5; ++i) _sell(SELL_NOTIONAL_USDT, deadline);

        _assertLedger();
        uint256 metric = systemMetricUsdt();
        if (metric < minMetric) revert MetricFloor();
        emit Cycle(expectedNonce, spotPriceX18(), poolTvlUsdt(), robotBalanceUsdt(), treasuryUsdt);
    }

    function refillRobotCapital(uint256 target, uint256 deadline)
        external
        onlyOperator
        active
        lock
    {
        if (block.timestamp > deadline || target < MIN_CYCLE_USDT) revert InvalidConfig();
        _ensureRobotCapital(target, deadline);
        _assertLedger();
    }

    function refillKeeperGas(uint256 exactPol, uint256 maxUsdtIn, uint256 deadline)
        external
        onlyOperator
        lock
        returns (uint256 spent)
    {
        if (
            block.timestamp > deadline || exactPol == 0 || exactPol > MAX_EXACT_GAS_REFILL_POL
                || block.number < lastGasRefillBlock + gasRefillCooldownBlocks || maxUsdtIn == 0
                || maxUsdtIn > treasuryUsdt
        ) revert GasRefill();
        address[] memory path = new address[](2);
        path[0] = address(usdt);
        path[1] = wpol;
        uint256[] memory amounts = router.swapTokensForExactETH(exactPol, maxUsdtIn, path, keeper, deadline);
        spent = amounts[0];
        if (spent > treasuryUsdt || spent > maxUsdtIn) revert GasRefill();
        treasuryUsdt -= spent;
        cumulativeGasRefillUsdt += spent;
        lastGasRefillBlock = block.number;
        _assertLedger();
        emit GasRefill(keeper, exactPol, spent);
    }

    function _buy(uint256 amountUsdt, uint256 deadline) internal {
        if (block.timestamp > deadline || robotUsdt < amountUsdt) revert InsufficientCapital();
        uint256 fee = amountUsdt * FEE_BPS / 10_000;
        uint256 net = amountUsdt - fee;
        (uint256 rt, uint256 ru) = reserves();
        uint256 out = _amountOut(net, ru, rt);
        if (out == 0) revert Quote();
        robotUsdt -= amountUsdt;
        treasuryUsdt += fee;
        usdt.transfer(address(pair), net);
        _pairSwapTokenOut(out, address(this));
        _stabilize(deadline);
    }

    function _sell(uint256 targetUsdt, uint256 deadline) internal {
        if (block.timestamp > deadline) revert Deadline();
        uint256 tokenIn = targetUsdt * PRICE_SCALE / spotPriceX18();
        uint256 available = syna.balanceOf(address(this));
        if (tokenIn > available) tokenIn = available;
        if (tokenIn == 0) revert InsufficientCapital();
        (uint256 rt, uint256 ru) = reserves();
        uint256 gross = _amountOut(tokenIn, rt, ru);
        if (gross == 0) revert Quote();
        IERC20V4(address(syna)).transfer(address(pair), tokenIn);
        _pairSwapUsdtOut(gross, address(this));
        uint256 fee = gross * FEE_BPS / 10_000;
        robotUsdt += gross - fee;
        treasuryUsdt += fee;
        _stabilize(deadline);
    }

    function _stabilize(uint256 deadline) internal {
        uint256 reference = priceSum / SMA_WINDOW;
        uint256 current = spotPriceX18();
        if (cooldown != 0) {
            unchecked { --cooldown; }
        } else if (current * 10_000 <= reference * (10_000 - TRIGGER_BPS)) {
            uint256 bps = (reference - current) * 20_000 / reference;
            if (bps > MAX_BURN_BPS) bps = MAX_BURN_BPS;
            syna.globalRebaseDown(bps);
            pair.sync();
            cooldown = COOLDOWN_TRADES;
            emit Stabilize(1, bps, 0, 0);
        } else if (current * 10_000 >= reference * (10_000 + TRIGGER_BPS)) {
            uint256 bps = (current - reference) * 10_000 / reference;
            if (bps > MAX_MINT_BPS) bps = MAX_MINT_BPS;
            uint256 spendable = treasuryUsdt > treasuryGasFloorUsdt ? treasuryUsdt - treasuryGasFloorUsdt : 0;
            if (spendable != 0) {
                (uint256 rt, uint256 ru) = reserves();
                uint256 desiredToken = syna.totalSupply() * bps / 10_000;
                uint256 desiredUsdt = desiredToken * ru / rt;
                uint256 addUsdt = desiredUsdt < spendable ? desiredUsdt : spendable;
                uint256 addToken = addUsdt * rt / ru;
                if (addToken != 0 && addUsdt != 0) {
                    syna.mint(address(this), addToken);
                    IERC20V4(address(syna)).transfer(address(pair), addToken);
                    usdt.transfer(address(pair), addUsdt);
                    pair.mint(address(this));
                    treasuryUsdt -= addUsdt;
                    emit Stabilize(2, bps, addToken, addUsdt);
                }
            }
            cooldown = COOLDOWN_TRADES;
        }
        uint256 next = spotPriceX18();
        priceSum = priceSum - prices[priceCursor] + next;
        prices[priceCursor] = next;
        priceCursor = (priceCursor + 1) % SMA_WINDOW;
    }

    function _ensureRobotCapital(uint256 target, uint256 deadline) internal {
        if (robotUsdt >= target) return;
        uint256 deficit = target - robotUsdt;
        uint256 movable = treasuryUsdt > treasuryGasFloorUsdt ? treasuryUsdt - treasuryGasFloorUsdt : 0;
        uint256 fromTreasury = deficit < movable ? deficit : movable;
        if (fromTreasury != 0) {
            treasuryUsdt -= fromTreasury;
            robotUsdt += fromTreasury;
            deficit -= fromTreasury;
            emit RobotRefill(1, fromTreasury, 0, 0);
        }
        if (deficit == 0) return;
        if (!_sellTokenForExactUsdt(deficit, deadline)) {
            _removeLp(deficit);
            if (robotUsdt < target) {
                deficit = target - robotUsdt;
                _sellTokenForExactUsdt(deficit, deadline);
            }
        }
        if (robotUsdt < MIN_CYCLE_USDT) revert InsufficientCapital();
    }

    function _sellTokenForExactUsdt(uint256 exactUsdt, uint256 deadline) internal returns (bool) {
        if (block.timestamp > deadline) revert Deadline();
        if (exactUsdt == 0) return true;
        (uint256 rt, uint256 ru) = reserves();
        if (exactUsdt >= ru) return false;
        uint256 tokenIn = _amountIn(exactUsdt, rt, ru);
        if (syna.balanceOf(address(this)) < tokenIn) return false;
        IERC20V4(address(syna)).transfer(address(pair), tokenIn);
        _pairSwapUsdtOut(exactUsdt, address(this));
        robotUsdt += exactUsdt;
        emit RobotRefill(2, exactUsdt, tokenIn, 0);
        return true;
    }

    function _removeLp(uint256 desiredUsdt) internal {
        uint256 lpBalance = pair.balanceOf(address(this));
        uint256 lpSupply = pair.totalSupply();
        (, uint256 ru) = reserves();
        uint256 liquidity = (desiredUsdt * lpSupply + ru - 1) / ru;
        uint256 maxLiquidity = lpBalance * maxLpRefillBps / 10_000;
        if (liquidity > maxLiquidity) liquidity = maxLiquidity;
        if (liquidity == 0) revert InsufficientCapital();
        IERC20V4(address(pair)).transfer(address(pair), liquidity);
        (uint256 a0, uint256 a1) = pair.burn(address(this));
        uint256 tokenAmount = tokenIs0 ? a0 : a1;
        uint256 usdtAmount = tokenIs0 ? a1 : a0;
        robotUsdt += usdtAmount;
        emit RobotRefill(3, usdtAmount, tokenAmount, liquidity);
    }

    function _pairSwapTokenOut(uint256 amount, address to) internal {
        if (tokenIs0) pair.swap(amount, 0, to, "");
        else pair.swap(0, amount, to, "");
    }

    function _pairSwapUsdtOut(uint256 amount, address to) internal {
        if (tokenIs0) pair.swap(0, amount, to, "");
        else pair.swap(amount, 0, to, "");
    }

    function _amountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) internal pure returns (uint256) {
        uint256 weighted = amountIn * 997;
        return weighted * reserveOut / (reserveIn * 1000 + weighted);
    }

    function _amountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut) internal pure returns (uint256) {
        if (amountOut == 0 || amountOut >= reserveOut) revert Quote();
        return reserveIn * amountOut * 1000 / ((reserveOut - amountOut) * 997) + 1;
    }

    function _assertLedger() internal view {
        if (robotUsdt + treasuryUsdt != usdt.balanceOf(address(this))) revert Ledger();
        if (spotPriceX18() == 0) revert Price();
    }
}
