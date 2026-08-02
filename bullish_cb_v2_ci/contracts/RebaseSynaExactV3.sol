// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

contract RebaseSynaExactV3 {
    string public constant name = "Synergy Coin";
    string public constant symbol = "SYNA";
    uint8 public constant decimals = 18;
    uint256 public constant INITIAL_GONS_PER_FRAGMENT = 1e18;

    address public immutable owner;
    address public controller;
    uint256 public gonsPerFragment = INITIAL_GONS_PER_FRAGMENT;
    uint256 public totalGons;

    mapping(address => uint256) private _gonBalances;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);
    event ControllerSet(address indexed controller);
    event GlobalRebaseDown(
        uint256 burnBps,
        uint256 oldGonsPerFragment,
        uint256 newGonsPerFragment,
        uint256 oldSupply,
        uint256 newSupply
    );

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
        return totalGons / gonsPerFragment;
    }

    function balanceOf(address account) public view returns (uint256) {
        return _gonBalances[account] / gonsPerFragment;
    }

    function gonBalanceOf(address account) external view returns (uint256) {
        return _gonBalances[account];
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
        uint256 gons = amount * gonsPerFragment;
        require(gons / gonsPerFragment == amount, "MINT_OVERFLOW");
        _gonBalances[to] += gons;
        totalGons += gons;
        minted = amount;
        emit Transfer(address(0), to, amount);
    }

    function burn(address from, uint256 amount) external onlyController returns (uint256 burned) {
        require(from != address(0) && amount > 0, "BAD_BURN");
        uint256 gons = amount * gonsPerFragment;
        require(gons / gonsPerFragment == amount, "BURN_OVERFLOW");
        require(_gonBalances[from] >= gons, "BURN_BALANCE");
        _gonBalances[from] -= gons;
        totalGons -= gons;
        burned = amount;
        emit Transfer(from, address(0), amount);
    }

    function globalRebaseDown(uint256 burnBps) external onlyController {
        require(burnBps > 0 && burnBps <= 800, "BAD_REBASE");
        uint256 oldSupply = totalSupply();
        require(oldSupply > 0, "ZERO_SUPPLY");
        uint256 oldScale = gonsPerFragment;
        uint256 denominator = 10_000 - burnBps;
        uint256 newScale = (oldScale * 10_000 + denominator - 1) / denominator;
        require(newScale > oldScale, "NO_REBASE");
        gonsPerFragment = newScale;
        uint256 newSupply = totalSupply();
        require(newSupply < oldSupply && newSupply > 0, "BAD_SUPPLY");
        emit GlobalRebaseDown(burnBps, oldScale, newScale, oldSupply, newSupply);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "ZERO_TO");
        uint256 gons = amount * gonsPerFragment;
        require(gons / gonsPerFragment == amount, "TRANSFER_OVERFLOW");
        require(_gonBalances[from] >= gons, "BALANCE");
        _gonBalances[from] -= gons;
        _gonBalances[to] += gons;
        emit Transfer(from, to, amount);
    }
}
