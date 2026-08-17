// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IERC20QS {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IQuickSwapFactoryV2 {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

interface IQuickSwapPairV2 is IERC20QS {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function sync() external;
}

interface IQuickSwapRouter02V2 {
    function factory() external view returns (address);
    function WETH() external view returns (address);

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

    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    function swapTokensForExactETH(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts);

    function getAmountsIn(uint256 amountOut, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts);
}

library SafeTokenQS {
    function safeTransfer(IERC20QS token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = address(token).call(
            abi.encodeWithSelector(token.transfer.selector, to, amount)
        );
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "TRANSFER_FAILED");
    }

    function safeTransferFrom(IERC20QS token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = address(token).call(
            abi.encodeWithSelector(token.transferFrom.selector, from, to, amount)
        );
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "TRANSFER_FROM_FAILED");
    }

    function forceApprove(IERC20QS token, address spender, uint256 amount) internal {
        (bool ok, bytes memory data) = address(token).call(
            abi.encodeWithSelector(token.approve.selector, spender, amount)
        );
        if (ok && (data.length == 0 || abi.decode(data, (bool)))) return;
        (ok, data) = address(token).call(abi.encodeWithSelector(token.approve.selector, spender, 0));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "APPROVE_ZERO_FAILED");
        (ok, data) = address(token).call(
            abi.encodeWithSelector(token.approve.selector, spender, amount)
        );
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "APPROVE_FAILED");
    }
}

contract RebaseSynaV2 {
    string public constant name = "SYNERGY";
    string public constant symbol = "SYNA";
    uint8 public constant decimals = 18;
    uint256 public constant ONE = 1e18;

    address public immutable owner;
    address public controller;
    uint256 public index = ONE;
    uint256 public totalShares;

    mapping(address => uint256) private _shares;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);
    event ControllerSet(address indexed controller);
    event GlobalRebaseDown(uint256 burnBps, uint256 oldIndex, uint256 newIndex);

    modifier onlyOwner() {
        require(msg.sender == owner, "OWNER");
        _;
    }

    modifier onlyController() {
        require(msg.sender == controller, "CONTROLLER");
        _;
    }

    constructor(address owner_) {
        require(owner_ != address(0), "ZERO_OWNER");
        owner = owner_;
    }

    function setController(address controller_) external onlyOwner {
        require(controller_ != address(0) && controller == address(0), "BAD_CONTROLLER");
        controller = controller_;
        emit ControllerSet(controller_);
    }

    function totalSupply() public view returns (uint256) {
        return totalShares * index / ONE;
    }

    function balanceOf(address account) public view returns (uint256) {
        return _shares[account] * index / ONE;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "ALLOWANCE");
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function mint(address to, uint256 amount) external onlyController returns (uint256 minted) {
        require(to != address(0) && amount > 0, "BAD_MINT");
        uint256 shares = amount * ONE / index;
        require(shares > 0, "MINT_DUST");
        _shares[to] += shares;
        totalShares += shares;
        minted = shares * index / ONE;
        emit Transfer(address(0), to, minted);
    }

    function burn(address from, uint256 amount) external onlyController returns (uint256 burned) {
        require(from != address(0) && amount > 0, "BAD_BURN");
        uint256 shares = amount * ONE / index;
        if (shares * index / ONE < amount) shares += 1;
        require(_shares[from] >= shares, "BURN_BALANCE");
        _shares[from] -= shares;
        totalShares -= shares;
        burned = shares * index / ONE;
        emit Transfer(from, address(0), burned);
    }

    function globalRebaseDown(uint256 burnBps) external onlyController {
        require(burnBps > 0 && burnBps <= 800, "BAD_REBASE");
        uint256 oldIndex = index;
        index = oldIndex * (10_000 - burnBps) / 10_000;
        require(index > 0, "ZERO_INDEX");
        emit GlobalRebaseDown(burnBps, oldIndex, index);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "ZERO_TO");
        uint256 shares = (amount * ONE + index - 1) / index;
        require(_shares[from] >= shares, "BALANCE");
        _shares[from] -= shares;
        _shares[to] += shares;
        emit Transfer(from, to, shares * index / ONE);
    }
}

contract BullishQuickSwapCentralBankV2 {
    using SafeTokenQS for IERC20QS;

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
    uint256 public constant MAX_SLIPPAGE_BPS_LIMIT = 300;
    uint256 public constant MAX_LP_REFILL_BPS_LIMIT = 1_000;
    uint256 public constant MAX_EXACT_GAS_REFILL_POL = 2 ether;

    address public immutable owner;
    IERC20QS public immutable usdt;
    address public immutable wpol;
    RebaseSynaV2 public immutable syna;
    IQuickSwapRouter02V2 public immutable router;
    IQuickSwapFactoryV2 public immutable factory;

    IQuickSwapPairV2 public pair;
    address public keeper;

    uint256 public robotUsdt;
    uint256 public treasuryUsdt;
    uint256 public nonce;
    uint256 public cooldown;
    uint256 public priceSum;
    uint256 public priceCursor;
    uint256[20] public prices;

    uint256 public robotTargetUsdt = 300_000;
    uint256 public treasuryGasFloorUsdt = 20_000;
    uint256 public maxSlippageBps = 100;
    uint256 public maxLpRefillBps = 500;
    uint256 public gasRefillCooldownBlocks = 100;
    uint256 public lastGasRefillBlock;
    uint256 public cumulativeGasRefillUsdt;

    bool public initialized;
    bool public paused;
    uint256 private unlocked = 1;

    event KeeperSet(address indexed keeper);
    event Paused(address indexed caller, string reason);
    event Unpaused(address indexed caller);
    event CentralBankAction(string action, uint256 fractionBps, uint256 tokenAmount, uint256 usdtAmount);
    event RobotRefill(string source, uint256 usdtAdded, uint256 tokenSpent, uint256 liquidityRemoved);
    event KeeperGasRefill(address indexed keeper, uint256 exactPolOut, uint256 usdtSpent);
    event CycleExecuted(
        uint256 indexed nonce,
        uint256 priceX18,
        uint256 supply,
        uint256 tvlUsdt,
        uint256 robotBalanceUsdt,
        uint256 treasuryBalanceUsdt,
        uint256 systemMetricUsdt
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "OWNER");
        _;
    }

    modifier onlyOperator() {
        require(msg.sender == owner || msg.sender == keeper, "OPERATOR");
        _;
    }

    modifier lock() {
        require(unlocked == 1, "LOCKED");
        unlocked = 0;
        _;
        unlocked = 1;
    }

    modifier whenNotPaused() {
        require(!paused, "PAUSED");
        _;
    }

    constructor(address owner_, address router_, address usdt_, address wpol_, address syna_) {
        require(
            owner_ != address(0) && router_ != address(0) && usdt_ != address(0)
                && wpol_ != address(0) && syna_ != address(0),
            "ZERO"
        );
        owner = owner_;
        keeper = owner_;
        router = IQuickSwapRouter02V2(router_);
        usdt = IERC20QS(usdt_);
        wpol = wpol_;
        syna = RebaseSynaV2(syna_);
        require(router.WETH() == wpol_, "BAD_WPOL");
        address factory_ = router.factory();
        require(factory_ != address(0), "BAD_FACTORY");
        factory = IQuickSwapFactoryV2(factory_);
        usdt.forceApprove(router_, type(uint256).max);
        IERC20QS(syna_).forceApprove(router_, type(uint256).max);
    }

    function setKeeper(address keeper_) external onlyOwner {
        require(keeper_ != address(0), "ZERO_KEEPER");
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    function setRefillConfig(
        uint256 robotTargetUsdt_,
        uint256 treasuryGasFloorUsdt_,
        uint256 maxSlippageBps_,
        uint256 maxLpRefillBps_,
        uint256 gasRefillCooldownBlocks_
    ) external onlyOwner {
        require(robotTargetUsdt_ >= MIN_CYCLE_USDT, "TARGET_TOO_LOW");
        require(maxSlippageBps_ <= MAX_SLIPPAGE_BPS_LIMIT, "SLIPPAGE");
        require(maxLpRefillBps_ > 0 && maxLpRefillBps_ <= MAX_LP_REFILL_BPS_LIMIT, "LP_REFILL");
        require(gasRefillCooldownBlocks_ >= 10, "GAS_COOLDOWN");
        robotTargetUsdt = robotTargetUsdt_;
        treasuryGasFloorUsdt = treasuryGasFloorUsdt_;
        maxSlippageBps = maxSlippageBps_;
        maxLpRefillBps = maxLpRefillBps_;
        gasRefillCooldownBlocks = gasRefillCooldownBlocks_;
    }

    function pause(string calldata reason) external onlyOperator {
        paused = true;
        emit Paused(msg.sender, reason);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function initialize(
        uint256 totalSupply,
        uint256 poolToken,
        uint256 poolUsdt,
        uint256 workingUsdt,
        uint256 deadline
    ) external onlyOwner lock {
        require(!initialized && block.timestamp <= deadline, "INITIALIZED_OR_DEADLINE");
        require(totalSupply > poolToken && poolToken > 0 && poolUsdt > 0 && workingUsdt >= MIN_CYCLE_USDT, "BAD_INIT");

        usdt.safeTransferFrom(owner, address(this), poolUsdt + workingUsdt);
        uint256 mintedForPool = syna.mint(address(this), poolToken);
        syna.mint(owner, totalSupply - poolToken);

        (uint256 usedToken, uint256 usedUsdt,) = router.addLiquidity(
            address(syna),
            address(usdt),
            mintedForPool,
            poolUsdt,
            mintedForPool * (10_000 - maxSlippageBps) / 10_000,
            poolUsdt * (10_000 - maxSlippageBps) / 10_000,
            address(this),
            deadline
        );
        require(usedToken > 0 && usedUsdt > 0, "NO_LIQUIDITY");

        address pair_ = factory.getPair(address(syna), address(usdt));
        require(pair_ != address(0), "NO_PAIR");
        pair = IQuickSwapPairV2(pair_);
        IERC20QS(pair_).forceApprove(address(router), type(uint256).max);

        uint256 tokenRemainder = mintedForPool - usedToken;
        if (tokenRemainder > 0) syna.burn(address(this), tokenRemainder);

        robotUsdt = usdt.balanceOf(address(this));
        treasuryUsdt = 0;
        require(robotUsdt >= workingUsdt, "WORKING_CAPITAL_SHORT");

        uint256 p = spotPriceX18();
        for (uint256 i = 0; i < SMA_WINDOW; ++i) prices[i] = p;
        priceSum = p * SMA_WINDOW;
        initialized = true;
        _assertLedger();
    }

    function pairReserves() public view returns (uint256 tokenReserve, uint256 usdtReserve) {
        require(address(pair) != address(0), "NO_PAIR");
        (uint112 r0, uint112 r1,) = pair.getReserves();
        address token0 = pair.token0();
        if (token0 == address(syna)) {
            tokenReserve = uint256(r0);
            usdtReserve = uint256(r1);
        } else {
            require(token0 == address(usdt), "BAD_PAIR");
            tokenReserve = uint256(r1);
            usdtReserve = uint256(r0);
        }
        require(tokenReserve > 0 && usdtReserve > 0, "ZERO_RESERVE");
    }

    function spotPriceX18() public view returns (uint256) {
        (uint256 tokenReserve, uint256 usdtReserve) = pairReserves();
        uint256 price = usdtReserve * PRICE_SCALE / tokenReserve;
        require(price > 0, "ZERO_PRICE");
        return price;
    }

    function poolTvlUsdt() public view returns (uint256) {
        (uint256 tokenReserve, uint256 usdtReserve) = pairReserves();
        uint256 tokenSide = tokenReserve * spotPriceX18() / PRICE_SCALE;
        return usdtReserve + tokenSide;
    }

    function robotBalanceUsdt() public view returns (uint256) {
        uint256 tokenValue = syna.balanceOf(address(this)) * spotPriceX18() / PRICE_SCALE;
        return robotUsdt + tokenValue;
    }

    function systemMetricUsdt() public view returns (uint256) {
        return poolTvlUsdt() + robotBalanceUsdt() + treasuryUsdt;
    }

    function executeCycle(uint256 expectedNonce, uint256 deadline, uint256 minSystemMetricUsdt)
        external
        onlyOperator
        whenNotPaused
        lock
    {
        require(initialized && block.timestamp <= deadline, "DEADLINE");
        require(expectedNonce == nonce, "NONCE");
        nonce = expectedNonce + 1;

        _ensureRobotCapital(robotTargetUsdt, deadline);
        require(robotUsdt >= MIN_CYCLE_USDT, "ROBOT_CAPITAL");

        _buy(BUY_USDT, deadline);
        _buy(BUY_USDT, deadline);
        for (uint256 i = 0; i < 5; ++i) _sellNotional(SELL_NOTIONAL_USDT, deadline);

        _assertLedger();
        uint256 metric = systemMetricUsdt();
        require(metric >= minSystemMetricUsdt, "METRIC_FLOOR");
        emit CycleExecuted(
            expectedNonce,
            spotPriceX18(),
            syna.totalSupply(),
            poolTvlUsdt(),
            robotBalanceUsdt(),
            treasuryUsdt,
            metric
        );
    }

    function refillRobotCapital(uint256 targetUsdt, uint256 deadline)
        external
        onlyOperator
        whenNotPaused
        lock
    {
        require(block.timestamp <= deadline && targetUsdt >= MIN_CYCLE_USDT, "BAD_REFILL");
        _ensureRobotCapital(targetUsdt, deadline);
        _assertLedger();
    }

    function refillKeeperGas(uint256 exactPolOut, uint256 maxUsdtIn, uint256 deadline)
        external
        onlyOperator
        lock
        returns (uint256 usdtSpent)
    {
        require(block.timestamp <= deadline, "DEADLINE");
        require(exactPolOut > 0 && exactPolOut <= MAX_EXACT_GAS_REFILL_POL, "POL_AMOUNT");
        require(block.number >= lastGasRefillBlock + gasRefillCooldownBlocks, "GAS_COOLDOWN");
        require(maxUsdtIn > 0 && treasuryUsdt >= maxUsdtIn, "TREASURY_GAS");

        address[] memory path = new address[](2);
        path[0] = address(usdt);
        path[1] = wpol;
        uint256[] memory amounts = router.swapTokensForExactETH(
            exactPolOut,
            maxUsdtIn,
            path,
            payable(keeper),
            deadline
        );
        usdtSpent = amounts[0];
        require(usdtSpent <= maxUsdtIn && usdtSpent <= treasuryUsdt, "GAS_SPEND");
        treasuryUsdt -= usdtSpent;
        cumulativeGasRefillUsdt += usdtSpent;
        lastGasRefillBlock = block.number;
        _assertLedger();
        emit KeeperGasRefill(keeper, exactPolOut, usdtSpent);
    }

    function _buy(uint256 amountUsdt, uint256 deadline) internal {
        require(robotUsdt >= amountUsdt, "ROBOT_USDT");
        uint256 fee = amountUsdt * FEE_BPS / 10_000;
        uint256 net = amountUsdt - fee;
        address[] memory path = new address[](2);
        path[0] = address(usdt);
        path[1] = address(syna);
        uint256[] memory quote = router.getAmountsOut(net, path);
        uint256 minOut = quote[1] * (10_000 - maxSlippageBps) / 10_000;
        require(minOut > 0, "BUY_QUOTE");

        robotUsdt -= amountUsdt;
        treasuryUsdt += fee;
        router.swapExactTokensForTokens(net, minOut, path, address(this), deadline);
        _stabilize(deadline);
    }

    function _sellNotional(uint256 targetUsdt, uint256 deadline) internal {
        uint256 p = spotPriceX18();
        uint256 tokenIn = targetUsdt * PRICE_SCALE / p;
        uint256 available = syna.balanceOf(address(this));
        if (tokenIn > available) tokenIn = available;
        require(tokenIn > 0, "ROBOT_SYNA");

        address[] memory path = new address[](2);
        path[0] = address(syna);
        path[1] = address(usdt);
        uint256[] memory quote = router.getAmountsOut(tokenIn, path);
        uint256 minOut = quote[1] * (10_000 - maxSlippageBps) / 10_000;
        require(minOut > 0, "SELL_QUOTE");
        uint256[] memory amounts = router.swapExactTokensForTokens(tokenIn, minOut, path, address(this), deadline);
        uint256 gross = amounts[1];
        uint256 fee = gross * FEE_BPS / 10_000;
        robotUsdt += gross - fee;
        treasuryUsdt += fee;
        _stabilize(deadline);
    }

    function _stabilize(uint256 deadline) internal {
        uint256 referencePrice = priceSum / SMA_WINDOW;
        uint256 current = spotPriceX18();
        if (cooldown > 0) {
            cooldown -= 1;
        } else if (current * 10_000 <= referencePrice * (10_000 - TRIGGER_BPS)) {
            uint256 declineBps = (referencePrice - current) * 10_000 / referencePrice;
            uint256 burnBps = declineBps * 2;
            if (burnBps > MAX_BURN_BPS) burnBps = MAX_BURN_BPS;
            syna.globalRebaseDown(burnBps);
            pair.sync();
            cooldown = COOLDOWN_TRADES;
            emit CentralBankAction("GLOBAL_REBASE_DOWN", burnBps, 0, 0);
        } else if (current * 10_000 >= referencePrice * (10_000 + TRIGGER_BPS)) {
            uint256 riseBps = (current - referencePrice) * 10_000 / referencePrice;
            uint256 mintBps = riseBps > MAX_MINT_BPS ? MAX_MINT_BPS : riseBps;
            uint256 requestedToken = syna.totalSupply() * mintBps / 10_000;
            (uint256 tokenReserve, uint256 usdtReserve) = pairReserves();
            uint256 requestedUsdt = requestedToken * usdtReserve / tokenReserve;
            uint256 spendableTreasury = treasuryUsdt > treasuryGasFloorUsdt ? treasuryUsdt - treasuryGasFloorUsdt : 0;
            uint256 pairedUsdt = requestedUsdt > spendableTreasury ? spendableTreasury : requestedUsdt;
            if (pairedUsdt > 0) {
                uint256 tokenAmount = pairedUsdt * tokenReserve / usdtReserve;
                uint256 minted = syna.mint(address(this), tokenAmount);
                (uint256 usedToken, uint256 usedUsdt,) = router.addLiquidity(
                    address(syna),
                    address(usdt),
                    minted,
                    pairedUsdt,
                    minted * (10_000 - maxSlippageBps) / 10_000,
                    pairedUsdt * (10_000 - maxSlippageBps) / 10_000,
                    address(this),
                    deadline
                );
                require(usedUsdt <= treasuryUsdt, "TREASURY_LP");
                treasuryUsdt -= usedUsdt;
                uint256 leftover = minted - usedToken;
                if (leftover > 0) syna.burn(address(this), leftover);
                emit CentralBankAction("MINT_ADD_LP", mintBps, usedToken, usedUsdt);
            } else {
                emit CentralBankAction("MINT_BLOCKED", mintBps, 0, 0);
            }
            cooldown = COOLDOWN_TRADES;
        }

        uint256 updated = spotPriceX18();
        priceSum = priceSum - prices[priceCursor] + updated;
        prices[priceCursor] = updated;
        priceCursor = (priceCursor + 1) % SMA_WINDOW;
    }

    function _ensureRobotCapital(uint256 targetUsdt, uint256 deadline) internal {
        if (robotUsdt >= targetUsdt) return;
        uint256 deficit = targetUsdt - robotUsdt;

        uint256 treasuryMovable = treasuryUsdt > treasuryGasFloorUsdt ? treasuryUsdt - treasuryGasFloorUsdt : 0;
        uint256 fromTreasury = deficit > treasuryMovable ? treasuryMovable : deficit;
        if (fromTreasury > 0) {
            treasuryUsdt -= fromTreasury;
            robotUsdt += fromTreasury;
            deficit -= fromTreasury;
            emit RobotRefill("TREASURY", fromTreasury, 0, 0);
        }
        if (deficit == 0) return;

        if (!_sellRobotTokenForExactUsdt(deficit, deadline)) {
            _removeBoundedLiquidityForRobot(deficit, deadline);
            if (robotUsdt < targetUsdt) {
                deficit = targetUsdt - robotUsdt;
                _sellRobotTokenForExactUsdt(deficit, deadline);
            }
        }
        require(robotUsdt >= MIN_CYCLE_USDT, "REFILL_INSUFFICIENT");
    }

    function _sellRobotTokenForExactUsdt(uint256 exactUsdtOut, uint256 deadline) internal returns (bool completed) {
        if (exactUsdtOut == 0) return true;
        address[] memory path = new address[](2);
        path[0] = address(syna);
        path[1] = address(usdt);
        uint256[] memory quote = router.getAmountsIn(exactUsdtOut, path);
        uint256 maxTokenIn = quote[0] * (10_000 + maxSlippageBps) / 10_000 + 1;
        if (syna.balanceOf(address(this)) < maxTokenIn) return false;
        uint256[] memory amounts = router.swapTokensForExactTokens(
            exactUsdtOut,
            maxTokenIn,
            path,
            address(this),
            deadline
        );
        robotUsdt += exactUsdtOut;
        emit RobotRefill("ROBOT_SYNA", exactUsdtOut, amounts[0], 0);
        return true;
    }

    function _removeBoundedLiquidityForRobot(uint256 desiredUsdt, uint256 deadline) internal {
        uint256 lpBalance = pair.balanceOf(address(this));
        require(lpBalance > 0, "NO_LP_REFILL");
        (, uint256 usdtReserve) = pairReserves();
        uint256 lpSupply = pair.totalSupply();
        uint256 liquidity = (desiredUsdt * lpSupply + usdtReserve - 1) / usdtReserve;
        liquidity = liquidity * (10_000 + maxSlippageBps) / 10_000 + 1;
        uint256 maxLiquidity = lpBalance * maxLpRefillBps / 10_000;
        if (liquidity > maxLiquidity) liquidity = maxLiquidity;
        require(liquidity > 0, "LP_REFILL_DUST");

        (uint256 tokenReserve, uint256 reserveUsdt) = pairReserves();
        uint256 expectedToken = tokenReserve * liquidity / lpSupply;
        uint256 expectedUsdt = reserveUsdt * liquidity / lpSupply;
        (uint256 amountToken, uint256 amountUsdt) = router.removeLiquidity(
            address(syna),
            address(usdt),
            liquidity,
            expectedToken * (10_000 - maxSlippageBps) / 10_000,
            expectedUsdt * (10_000 - maxSlippageBps) / 10_000,
            address(this),
            deadline
        );
        robotUsdt += amountUsdt;
        emit RobotRefill("LP_UNWIND", amountUsdt, 0, liquidity);
        require(amountToken > 0 && amountUsdt > 0, "LP_REFILL_ZERO");
    }

    function _assertLedger() internal view {
        require(robotUsdt + treasuryUsdt == usdt.balanceOf(address(this)), "USDT_LEDGER");
        require(spotPriceX18() > 0, "ZERO_PRICE");
    }
}
