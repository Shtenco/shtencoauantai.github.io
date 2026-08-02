// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20QS, IQuickSwapRouter02V2, IQuickSwapFactoryV2, SafeTokenQS} from "./BullishQuickSwapRefillV2.sol";
import {RebaseSynaExactV3} from "./RebaseSynaExactV3.sol";
import {BullishQuickSwapShieldedV5} from "./BullishQuickSwapShieldedV5.sol";

contract SynergyQuickSwapBootstrapV5 {
    using SafeTokenQS for IERC20QS;

    address public constant QUICKSWAP_V2_ROUTER = 0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff;
    address public constant QUICKSWAP_V2_FACTORY = 0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32;
    address public constant POLYGON_USDT = 0xc2132D05D31c914a87C6611C10748AEb04B58e8F;
    address public constant POLYGON_WPOL = 0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270;
    uint256 public constant INITIAL_TOTAL_SUPPLY = 1_000_000 ether;
    uint256 public constant INITIAL_POOL_SYNA = 500_000 ether;
    uint256 public constant INITIAL_POOL_USDT = 1_000_000;
    uint256 public constant INITIAL_ROBOT_USDT = 1_000_000;
    uint256 public constant INITIAL_REQUIRED_USDT = 2_000_000;

    address public admin;
    address public pendingAdmin;
    bool public bootstrapped;
    RebaseSynaExactV3 public token;
    BullishQuickSwapShieldedV5 public controller;
    address public pair;

    event SynergyBootstrapped(address indexed token, address indexed controller, address indexed pair, string name, string symbol, uint256 poolUsdt, uint256 robotUsdt);
    event AdminTransferStarted(address indexed currentAdmin, address indexed pendingAdmin);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    modifier onlyAdmin() { require(msg.sender == admin, "ADMIN"); _; }
    modifier afterBootstrap() { require(bootstrapped, "NOT_BOOTSTRAPPED"); _; }

    constructor(address admin_) {
        require(block.chainid == 137, "POLYGON_ONLY");
        require(admin_ != address(0), "ZERO_ADMIN");
        admin = admin_;
        IQuickSwapRouter02V2 router = IQuickSwapRouter02V2(QUICKSWAP_V2_ROUTER);
        require(router.factory() == QUICKSWAP_V2_FACTORY, "BAD_QUICKSWAP_FACTORY");
        require(router.WETH() == POLYGON_WPOL, "BAD_WPOL");
        require(QUICKSWAP_V2_ROUTER.code.length > 0, "NO_ROUTER_CODE");
        require(POLYGON_USDT.code.length > 0, "NO_USDT_CODE");
        require(POLYGON_WPOL.code.length > 0, "NO_WPOL_CODE");
    }

    function bootstrap(uint256 deadline) external onlyAdmin {
        require(!bootstrapped, "ALREADY_BOOTSTRAPPED");
        require(block.timestamp <= deadline && deadline <= block.timestamp + 120 seconds, "DEADLINE");
        IERC20QS usdt = IERC20QS(POLYGON_USDT);
        usdt.safeTransferFrom(admin, address(this), INITIAL_REQUIRED_USDT);
        RebaseSynaExactV3 newToken = new RebaseSynaExactV3(address(this));
        require(IQuickSwapFactoryV2(QUICKSWAP_V2_FACTORY).getPair(address(newToken), POLYGON_USDT) == address(0), "PAIR_PREEXISTS");
        BullishQuickSwapShieldedV5 newController = new BullishQuickSwapShieldedV5(address(this), QUICKSWAP_V2_ROUTER, POLYGON_USDT, POLYGON_WPOL, address(newToken), admin);
        newToken.setController(address(newController));
        usdt.forceApprove(address(newController), INITIAL_REQUIRED_USDT);
        newController.initialize(INITIAL_TOTAL_SUPPLY, INITIAL_POOL_SYNA, INITIAL_POOL_USDT, INITIAL_ROBOT_USDT, deadline);
        address newPair = address(newController.pair());
        require(newPair != address(0) && newPair.code.length > 0, "PAIR_NOT_CREATED");
        require(IQuickSwapFactoryV2(QUICKSWAP_V2_FACTORY).getPair(address(newToken), POLYGON_USDT) == newPair, "PAIR_FACTORY_MISMATCH");
        require(usdt.balanceOf(address(this)) == 0, "BOOTSTRAP_USDT_REMAINDER");
        token = newToken;
        controller = newController;
        pair = newPair;
        bootstrapped = true;
        emit SynergyBootstrapped(address(newToken), address(newController), newPair, newToken.name(), newToken.symbol(), INITIAL_POOL_USDT, INITIAL_ROBOT_USDT);
    }

    function startAdminTransfer(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0) && newAdmin != admin, "BAD_ADMIN");
        pendingAdmin = newAdmin;
        emit AdminTransferStarted(admin, newAdmin);
    }

    function acceptAdmin() external {
        require(msg.sender == pendingAdmin, "PENDING_ADMIN");
        address previous = admin;
        admin = pendingAdmin;
        pendingAdmin = address(0);
        emit AdminTransferred(previous, admin);
    }

    function executeProtectedCycle(uint256 expectedNonce, bytes32 expectedStateHash, bytes32 expectedParentHash, uint256 deadline, uint256 maxGasPriceWei, uint256 minMetric) external onlyAdmin afterBootstrap {
        controller.executeProtectedCycle(expectedNonce, expectedStateHash, expectedParentHash, deadline, maxGasPriceWei, minMetric);
    }

    function refillRobotCapitalProtected(uint256 targetUsdt, bytes32 expectedStateHash, bytes32 expectedParentHash, uint256 deadline, uint256 maxGasPriceWei) external onlyAdmin afterBootstrap {
        controller.refillRobotCapitalProtected(targetUsdt, expectedStateHash, expectedParentHash, deadline, maxGasPriceWei);
    }

    function refillKeeperGasProtected(uint256 exactPolOut, uint256 maxUsdtIn, bytes32 routeHash, bytes32 parentHash, uint256 deadline, uint256 maxGasPriceWei) external onlyAdmin afterBootstrap returns (uint256) {
        return controller.refillKeeperGasProtected(exactPolOut, maxUsdtIn, routeHash, parentHash, deadline, maxGasPriceWei);
    }

    function setSecurityConfig(uint256 inputBps, uint256 outputBps, uint256 gasCeiling) external onlyAdmin afterBootstrap {
        controller.setSecurityConfig(inputBps, outputBps, gasCeiling);
    }

    function setRefillConfig(uint256 robotTarget, uint256 gasFloor, uint256 slippageBps, uint256 lpRefillBps, uint256 cooldownBlocks) external onlyAdmin afterBootstrap {
        controller.setRefillConfig(robotTarget, gasFloor, slippageBps, lpRefillBps, cooldownBlocks);
    }

    function pause(string calldata reason) external onlyAdmin afterBootstrap { controller.pause(reason); }
    function unpause() external onlyAdmin afterBootstrap { controller.unpause(); }
}
