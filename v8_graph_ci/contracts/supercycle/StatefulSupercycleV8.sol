// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IERC20V8Balance {
    function balanceOf(address account) external view returns (uint256);
}

interface IAtomicQeQtExecutorV8 {
    struct Plan {
        bytes32 sourceId;
        uint256 nonce;
        uint256 deadline;
        uint256 qeMint;
        uint256 minExtractedUsdt;
        uint256 minWpolFromV3;
        uint256 minUsdtFromV2;
        uint256 minTreasuryProfit;
    }

    function execute(Plan calldata plan) external returns (uint256 profit);
    function cumulativeVerifiedProfit() external view returns (uint256);
    function temporaryOutstanding() external view returns (uint256);
}

/// @notice V8 stateful acceptance layer around the atomic QE/QT executor.
/// The contract does not invent graph profit: it only accepts a cycle when the
/// real settlement-token balance of the protocol treasury increases and the
/// underlying executor has atomically restored the touched internal LP,
/// temporary supply and constant-product invariant.
contract StatefulSupercycleV8 {
    uint256 public constant INTERNAL_EDGE_COUNT = 10;
    uint256 public constant EXTERNAL_EDGE_COUNT = 10;

    address public admin;
    mapping(address => bool) public keeper;

    IAtomicQeQtExecutorV8 public immutable executor;
    IERC20V8Balance public immutable settlementAsset;
    address public immutable treasury;

    address[INTERNAL_EDGE_COUNT] public internalPools;
    address[EXTERNAL_EDGE_COUNT] public externalPools;
    bool public topologyConfigured;
    bytes32 public topologyHash;

    uint256 public minimumProfitPerCycle;
    uint256 public completedCycles;
    uint256 public cumulativeConsolidatedProfit;
    mapping(bytes32 => bool) public cycleIdUsed;

    error Unauthorized();
    error InvalidConfiguration();
    error TopologyAlreadyConfigured();
    error DuplicatePool();
    error MissingCode();
    error Replay();
    error NoConsolidatedProfit();
    error ExecutorAccountingMismatch();
    error TemporarySupplyOpen();

    event KeeperSet(address indexed account, bool enabled);
    event MinimumProfitSet(uint256 amount);
    event TopologyConfigured(bytes32 indexed topologyHash);
    event StatefulCycleAccepted(
        bytes32 indexed cycleId,
        uint256 indexed cycle,
        uint256 treasuryDelta,
        uint256 executorProfit,
        uint256 cumulativeProfit
    );

    constructor(
        address executor_,
        address settlementAsset_,
        address treasury_,
        uint256 minimumProfitPerCycle_
    ) {
        if (executor_ == address(0) || settlementAsset_ == address(0) || treasury_ == address(0)) {
            revert InvalidConfiguration();
        }
        if (executor_.code.length == 0 || settlementAsset_.code.length == 0) revert MissingCode();
        admin = msg.sender;
        keeper[msg.sender] = true;
        executor = IAtomicQeQtExecutorV8(executor_);
        settlementAsset = IERC20V8Balance(settlementAsset_);
        treasury = treasury_;
        minimumProfitPerCycle = minimumProfitPerCycle_;
        emit KeeperSet(msg.sender, true);
        emit MinimumProfitSet(minimumProfitPerCycle_);
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert Unauthorized();
        _;
    }

    modifier onlyKeeper() {
        if (!keeper[msg.sender]) revert Unauthorized();
        _;
    }

    function setKeeper(address account, bool enabled) external onlyAdmin {
        if (account == address(0)) revert InvalidConfiguration();
        keeper[account] = enabled;
        emit KeeperSet(account, enabled);
    }

    function setMinimumProfitPerCycle(uint256 amount) external onlyAdmin {
        minimumProfitPerCycle = amount;
        emit MinimumProfitSet(amount);
    }

    function configureTopology(
        address[INTERNAL_EDGE_COUNT] calldata internalPools_,
        address[EXTERNAL_EDGE_COUNT] calldata externalPools_
    ) external onlyAdmin {
        if (topologyConfigured) revert TopologyAlreadyConfigured();

        for (uint256 i = 0; i < INTERNAL_EDGE_COUNT; ++i) {
            address pool = internalPools_[i];
            if (pool == address(0) || pool.code.length == 0) revert MissingCode();
            for (uint256 j = 0; j < i; ++j) {
                if (pool == internalPools_[j]) revert DuplicatePool();
            }
            internalPools[i] = pool;
        }

        for (uint256 i = 0; i < EXTERNAL_EDGE_COUNT; ++i) {
            address pool = externalPools_[i];
            if (pool == address(0) || pool.code.length == 0) revert MissingCode();
            for (uint256 j = 0; j < i; ++j) {
                if (pool == externalPools_[j]) revert DuplicatePool();
            }
            for (uint256 j = 0; j < INTERNAL_EDGE_COUNT; ++j) {
                if (pool == internalPools_[j]) revert DuplicatePool();
            }
            externalPools[i] = pool;
        }

        topologyHash = keccak256(abi.encode(internalPools_, externalPools_));
        topologyConfigured = true;
        emit TopologyConfigured(topologyHash);
    }

    function executeCycle(
        IAtomicQeQtExecutorV8.Plan calldata plan,
        bytes32 cycleId
    ) external onlyKeeper returns (uint256 profit) {
        if (!topologyConfigured || cycleId == bytes32(0)) revert InvalidConfiguration();
        if (cycleIdUsed[cycleId]) revert Replay();

        uint256 treasuryBefore = settlementAsset.balanceOf(treasury);
        uint256 executorCumulativeBefore = executor.cumulativeVerifiedProfit();

        cycleIdUsed[cycleId] = true;
        profit = executor.execute(plan);

        uint256 treasuryAfter = settlementAsset.balanceOf(treasury);
        if (treasuryAfter <= treasuryBefore) revert NoConsolidatedProfit();
        uint256 treasuryDelta = treasuryAfter - treasuryBefore;
        if (treasuryDelta != profit || profit < minimumProfitPerCycle) {
            revert ExecutorAccountingMismatch();
        }
        if (executor.cumulativeVerifiedProfit() != executorCumulativeBefore + profit) {
            revert ExecutorAccountingMismatch();
        }
        if (executor.temporaryOutstanding() != 0) revert TemporarySupplyOpen();

        completedCycles += 1;
        cumulativeConsolidatedProfit += profit;
        emit StatefulCycleAccepted(
            cycleId,
            completedCycles,
            treasuryDelta,
            profit,
            cumulativeConsolidatedProfit
        );
    }
}
