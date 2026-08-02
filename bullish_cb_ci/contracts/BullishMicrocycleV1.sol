// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IERC20Micro {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

contract RebaseSynaV1 {
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

    function globalRebaseDown(uint256 burnBps) external onlyController {
        require(burnBps > 0 && burnBps <= 800, "BAD_BURN");
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

contract SecureSynaUsdtPoolV1 {
    IERC20Micro public immutable usdt;
    RebaseSynaV1 public immutable syna;
    address public immutable controller;

    uint256 private unlocked = 1;

    modifier onlyController() {
        require(msg.sender == controller, "CONTROLLER");
        _;
    }

    modifier lock() {
        require(unlocked == 1, "LOCKED");
        unlocked = 0;
        _;
        unlocked = 1;
    }

    constructor(address usdt_, address syna_, address controller_) {
        require(usdt_ != address(0) && syna_ != address(0) && controller_ != address(0), "ZERO");
        usdt = IERC20Micro(usdt_);
        syna = RebaseSynaV1(syna_);
        controller = controller_;
    }

    function reserves() public view returns (uint256 tokenReserve, uint256 usdtReserve) {
        tokenReserve = syna.balanceOf(address(this));
        usdtReserve = usdt.balanceOf(address(this));
        require(tokenReserve > 0 && usdtReserve > 0, "ZERO_RESERVE");
    }

    function priceX18() public view returns (uint256) {
        (uint256 tokenReserve, uint256 usdtReserve) = reserves();
        uint256 price = usdtReserve * 1e30 / tokenReserve;
        require(price > 0, "ZERO_PRICE");
        return price;
    }

    function buyWithNetUsdt(uint256 netUsdt, uint256 minTokenOut)
        external
        onlyController
        lock
        returns (uint256 tokenOut)
    {
        require(netUsdt > 0, "ZERO_INPUT");
        (uint256 tokenReserve, uint256 usdtReserve) = reserves();
        uint256 k = tokenReserve * usdtReserve;
        uint256 newUsdt = usdtReserve + netUsdt;
        tokenOut = tokenReserve - k / newUsdt;
        require(tokenOut > 0 && tokenOut >= minTokenOut, "BAD_BUY_OUT");
        require(usdt.transferFrom(controller, address(this), netUsdt), "USDT_IN");
        require(syna.transfer(controller, tokenOut), "SYNA_OUT");
        require(priceX18() > 0, "POST_ZERO_PRICE");
    }

    function sellTokenGross(uint256 tokenIn, uint256 minGrossUsdt)
        external
        onlyController
        lock
        returns (uint256 grossUsdt)
    {
        require(tokenIn > 0, "ZERO_INPUT");
        (uint256 tokenReserve, uint256 usdtReserve) = reserves();
        uint256 k = tokenReserve * usdtReserve;
        uint256 newToken = tokenReserve + tokenIn;
        grossUsdt = usdtReserve - k / newToken;
        require(grossUsdt > 0 && grossUsdt >= minGrossUsdt && grossUsdt < usdtReserve, "BAD_SELL_OUT");
        require(syna.transferFrom(controller, address(this), tokenIn), "SYNA_IN");
        require(usdt.transfer(controller, grossUsdt), "USDT_OUT");
        require(priceX18() > 0, "POST_ZERO_PRICE");
    }

    function addLiquidity(uint256 tokenAmount, uint256 usdtAmount) external onlyController lock {
        require(tokenAmount > 0 && usdtAmount > 0, "ZERO_LP");
        uint256 priceBefore = priceX18();
        require(syna.transferFrom(controller, address(this), tokenAmount), "SYNA_LP");
        require(usdt.transferFrom(controller, address(this), usdtAmount), "USDT_LP");
        uint256 priceAfter = priceX18();
        uint256 deviation = priceAfter > priceBefore
            ? (priceAfter - priceBefore) * 10_000 / priceBefore
            : (priceBefore - priceAfter) * 10_000 / priceBefore;
        require(deviation <= 2, "LP_PRICE_SHIFT");
    }
}

contract BullishCentralBankV1 {
    uint256 public constant FEE_BPS = 30;
    uint256 public constant TRIGGER_BPS = 100;
    uint256 public constant MAX_BURN_BPS = 800;
    uint256 public constant MAX_MINT_BPS = 400;
    uint256 public constant SMA_WINDOW = 20;
    uint256 public constant COOLDOWN_TRADES = 8;
    uint256 public constant BUY_USDT = 100_000;
    uint256 public constant SELL_NOTIONAL_USDT = 40_000;

    address public immutable owner;
    IERC20Micro public immutable usdt;
    RebaseSynaV1 public immutable syna;
    SecureSynaUsdtPoolV1 public pool;

    uint256 public robotUsdt;
    uint256 public treasuryUsdt;
    uint256 public nonce;
    uint256 public cooldown;
    uint256 public priceSum;
    uint256 public priceCursor;
    uint256[20] public prices;
    bool public initialized;

    event CentralBankAction(string action, uint256 fractionBps, uint256 tokenAmount, uint256 usdtAmount);
    event CycleExecuted(uint256 indexed nonce, uint256 price, uint256 supply, uint256 hardNavUsdt);

    modifier onlyOwner() {
        require(msg.sender == owner, "OWNER");
        _;
    }

    constructor(address owner_, address usdt_, address syna_) {
        require(owner_ != address(0) && usdt_ != address(0) && syna_ != address(0), "ZERO");
        owner = owner_;
        usdt = IERC20Micro(usdt_);
        syna = RebaseSynaV1(syna_);
    }

    function setPool(address pool_) external onlyOwner {
        require(address(pool) == address(0) && pool_ != address(0), "POOL_SET");
        pool = SecureSynaUsdtPoolV1(pool_);
        require(usdt.approve(pool_, type(uint256).max), "USDT_APPROVE");
        require(syna.approve(pool_, type(uint256).max), "SYNA_APPROVE");
    }

    function initialize(uint256 totalSupply, uint256 poolToken, uint256 poolUsdt, uint256 workingUsdt)
        external
        onlyOwner
    {
        require(!initialized && address(pool) != address(0), "INITIALIZED");
        require(totalSupply > poolToken && poolToken > 0 && poolUsdt > 0 && workingUsdt > 0, "BAD_INIT");
        require(usdt.transferFrom(owner, address(pool), poolUsdt), "POOL_USDT");
        require(usdt.transferFrom(owner, address(this), workingUsdt), "WORK_USDT");
        syna.mint(address(pool), poolToken);
        syna.mint(owner, totalSupply - poolToken);
        robotUsdt = workingUsdt;
        uint256 p = pool.priceX18();
        for (uint256 i = 0; i < SMA_WINDOW; ++i) {
            prices[i] = p;
        }
        priceSum = p * SMA_WINDOW;
        initialized = true;
        _assertLedger();
    }

    function hardNavUsdt() public view returns (uint256) {
        return usdt.balanceOf(address(pool)) + usdt.balanceOf(address(this));
    }

    function executeCycle(uint256 expectedNonce, uint256 deadline, uint256 minHardNavUsdt)
        external
        onlyOwner
    {
        require(initialized && block.timestamp <= deadline, "DEADLINE");
        require(expectedNonce == nonce, "NONCE");
        nonce = expectedNonce + 1;
        _buy(BUY_USDT);
        _buy(BUY_USDT);
        for (uint256 i = 0; i < 5; ++i) {
            _sell(SELL_NOTIONAL_USDT);
        }
        _assertLedger();
        require(hardNavUsdt() + 10 >= minHardNavUsdt, "HARD_NAV_LOSS");
        emit CycleExecuted(expectedNonce, pool.priceX18(), syna.totalSupply(), hardNavUsdt());
    }

    function _buy(uint256 amountUsdt) internal {
        require(robotUsdt >= amountUsdt, "ROBOT_USDT");
        uint256 fee = amountUsdt * FEE_BPS / 10_000;
        uint256 net = amountUsdt - fee;
        robotUsdt -= amountUsdt;
        treasuryUsdt += fee;
        pool.buyWithNetUsdt(net, 1);
        _stabilize();
    }

    function _sell(uint256 targetUsdt) internal {
        uint256 p = pool.priceX18();
        require(p > 0, "ZERO_PRICE");
        uint256 tokenIn = targetUsdt * 1e30 / p;
        uint256 available = syna.balanceOf(address(this));
        if (tokenIn > available) tokenIn = available;
        require(tokenIn > 0, "ROBOT_SYNA");
        uint256 gross = pool.sellTokenGross(tokenIn, 1);
        uint256 fee = gross * FEE_BPS / 10_000;
        robotUsdt += gross - fee;
        treasuryUsdt += fee;
        _stabilize();
    }

    function _stabilize() internal {
        uint256 reference = priceSum / SMA_WINDOW;
        uint256 current = pool.priceX18();
        if (cooldown > 0) {
            cooldown -= 1;
        } else if (current * 10_000 <= reference * (10_000 - TRIGGER_BPS)) {
            uint256 declineBps = (reference - current) * 10_000 / reference;
            uint256 burnBps = declineBps * 2;
            if (burnBps > MAX_BURN_BPS) burnBps = MAX_BURN_BPS;
            syna.globalRebaseDown(burnBps);
            cooldown = COOLDOWN_TRADES;
            emit CentralBankAction("GLOBAL_REBASE_DOWN", burnBps, 0, 0);
        } else if (current * 10_000 >= reference * (10_000 + TRIGGER_BPS)) {
            uint256 riseBps = (current - reference) * 10_000 / reference;
            uint256 mintBps = riseBps;
            if (mintBps > MAX_MINT_BPS) mintBps = MAX_MINT_BPS;
            uint256 requestedToken = syna.totalSupply() * mintBps / 10_000;
            (uint256 tokenReserve, uint256 usdtReserve) = pool.reserves();
            uint256 requestedUsdt = requestedToken * usdtReserve / tokenReserve;
            uint256 pairedUsdt = requestedUsdt > treasuryUsdt ? treasuryUsdt : requestedUsdt;
            if (pairedUsdt > 0) {
                uint256 tokenAmount = pairedUsdt * tokenReserve / usdtReserve;
                uint256 minted = syna.mint(address(this), tokenAmount);
                treasuryUsdt -= pairedUsdt;
                pool.addLiquidity(minted, pairedUsdt);
                emit CentralBankAction("MINT_ADD_LP", mintBps, minted, pairedUsdt);
            } else {
                emit CentralBankAction("MINT_BLOCKED", mintBps, 0, 0);
            }
            cooldown = COOLDOWN_TRADES;
        }
        uint256 updated = pool.priceX18();
        priceSum = priceSum - prices[priceCursor] + updated;
        prices[priceCursor] = updated;
        priceCursor = (priceCursor + 1) % SMA_WINDOW;
    }

    function _assertLedger() internal view {
        require(robotUsdt + treasuryUsdt == usdt.balanceOf(address(this)), "USDT_LEDGER");
        require(pool.priceX18() > 0, "ZERO_PRICE");
    }
}
