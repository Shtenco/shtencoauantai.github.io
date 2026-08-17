// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface ISynergyDexRouterV11 {
    function swapExactTokensForTokens(address tokenIn,address tokenOut,uint256 amountIn,uint256 minimumAmountOut,address to,uint256 deadline) external returns (uint256 amountOut);
}
interface ISynergyPairV11 {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112,uint112,uint32);
}
interface IQuickSwapV2RouterV11 {
    function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] calldata path,address to,uint256 deadline) external returns (uint256[] memory amounts);
}
interface IAlgebraSwapRouterV11 {
    struct ExactInputSingleParams {address tokenIn;address tokenOut;address recipient;uint256 deadline;uint256 amountIn;uint256 amountOutMinimum;uint160 limitSqrtPrice;}
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

contract TemporaryQETokenV11 is ERC20 {
    address public admin;
    address public controller;
    error Unauthorized(); error InvalidAddress();
    constructor() ERC20("SYNERGY Temporary QE", "SYNA-QE") {admin=msg.sender;}
    function decimals() public pure override returns(uint8){return 6;}
    function setController(address nextController) external {if(msg.sender!=admin) revert Unauthorized();if(nextController==address(0)) revert InvalidAddress();controller=nextController;}
    function mintBootstrap(address to,uint256 amount) external {if(msg.sender!=admin) revert Unauthorized();_mint(to,amount);}
    function mintTemporary(address to,uint256 amount) external {if(msg.sender!=controller) revert Unauthorized();_mint(to,amount);}
    function burnTemporary(uint256 amount) external {if(msg.sender!=controller) revert Unauthorized();_burn(msg.sender,amount);}
}

contract SynergyAtomicQeQtCycleV11 {
    using SafeERC20 for IERC20;
    uint256 public constant BPS=10_000;
    uint256 public constant INTERNAL_FEE_BPS=30;
    uint256 public constant MAX_SYNTHETIC_DUST=2;
    TemporaryQETokenV11 public immutable synthetic;
    IERC20 public immutable usdt;
    IERC20 public immutable wpol;
    ISynergyDexRouterV11 public immutable internalRouter;
    ISynergyPairV11 public immutable internalPair;
    IAlgebraSwapRouterV11 public immutable algebraRouter;
    IQuickSwapV2RouterV11 public immutable quickswapV2Router;
    address public immutable treasury;
    address public admin;
    mapping(address=>bool) public keeper;
    mapping(uint256=>bool) public nonceUsed;
    mapping(bytes32=>bool) public sourceUsed;
    uint256 public temporaryOutstanding;
    uint256 public cumulativeVerifiedProfit;
    uint256 public cumulativeLpLiquidGain;
    uint256 public lastExtractedUsdt;
    uint256 public lastExternalUsdt;
    uint256 public lastBuybackUsdt;
    uint256 public lastTreasuryProfit;
    uint256 public lastLpLiquidGain;
    uint256 public lastSyntheticDust;
    uint256 public lastKBefore;
    uint256 public lastKAfter;
    error Unauthorized(); error InvalidPlan(); error Expired(); error Replay(); error ExternalRouteLoss(); error BuybackNotCovered(); error TemporarySupplyNotClosed(); error PoolSyntheticNotRestored(); error PoolLiquidNotRestored(); error PoolInvariantDecreased();
    event KeeperSet(address indexed account,bool enabled);
    event AtomicCycleClosed(bytes32 indexed sourceId,uint256 indexed nonce,uint256 qeMint,uint256 extractedUsdt,uint256 externalUsdt,uint256 buybackUsdt,uint256 treasuryProfit,uint256 lpLiquidGain,uint256 syntheticDust,uint256 kBefore,uint256 kAfter);
    struct Plan {bytes32 sourceId;uint256 nonce;uint256 deadline;uint256 qeMint;uint256 minExtractedUsdt;uint256 minWpolFromV3;uint256 minUsdtFromV2;uint256 minTreasuryProfit;}
    constructor(address synthetic_,address usdt_,address wpol_,address internalRouter_,address internalPair_,address algebraRouter_,address quickswapV2Router_,address treasury_){
        if(synthetic_==address(0)||usdt_==address(0)||wpol_==address(0)||internalRouter_==address(0)||internalPair_==address(0)||algebraRouter_==address(0)||quickswapV2Router_==address(0)||treasury_==address(0)) revert InvalidPlan();
        synthetic=TemporaryQETokenV11(synthetic_);usdt=IERC20(usdt_);wpol=IERC20(wpol_);internalRouter=ISynergyDexRouterV11(internalRouter_);internalPair=ISynergyPairV11(internalPair_);algebraRouter=IAlgebraSwapRouterV11(algebraRouter_);quickswapV2Router=IQuickSwapV2RouterV11(quickswapV2Router_);treasury=treasury_;admin=msg.sender;
    }
    function setKeeper(address account,bool enabled) external {if(msg.sender!=admin) revert Unauthorized();keeper[account]=enabled;emit KeeperSet(account,enabled);}
    function execute(Plan calldata plan) external returns(uint256 profit){
        if(!keeper[msg.sender]) revert Unauthorized();
        if(plan.sourceId==bytes32(0)||plan.qeMint==0||plan.minExtractedUsdt==0||plan.minWpolFromV3==0||plan.minUsdtFromV2==0||plan.minTreasuryProfit==0) revert InvalidPlan();
        if(block.timestamp>plan.deadline) revert Expired();
        if(nonceUsed[plan.nonce]||sourceUsed[plan.sourceId]) revert Replay();
        (uint256 syntheticBefore,uint256 liquidBefore)=_pairBalances();uint256 supplyBefore=synthetic.totalSupply();uint256 kBefore=syntheticBefore*liquidBefore;uint256 treasuryBefore=usdt.balanceOf(treasury);
        nonceUsed[plan.nonce]=true;sourceUsed[plan.sourceId]=true;
        temporaryOutstanding=plan.qeMint;synthetic.mintTemporary(address(this),plan.qeMint);IERC20(address(synthetic)).forceApprove(address(internalRouter),plan.qeMint);
        uint256 extracted=internalRouter.swapExactTokensForTokens(address(synthetic),address(usdt),plan.qeMint,plan.minExtractedUsdt,address(this),plan.deadline);
        usdt.forceApprove(address(algebraRouter),extracted);
        uint256 wpolOut=algebraRouter.exactInputSingle(IAlgebraSwapRouterV11.ExactInputSingleParams({tokenIn:address(usdt),tokenOut:address(wpol),recipient:address(this),deadline:plan.deadline,amountIn:extracted,amountOutMinimum:plan.minWpolFromV3,limitSqrtPrice:0}));
        wpol.forceApprove(address(quickswapV2Router),wpolOut);address[] memory path=new address[](2);path[0]=address(wpol);path[1]=address(usdt);
        uint256[] memory amounts=quickswapV2Router.swapExactTokensForTokens(wpolOut,plan.minUsdtFromV2,path,address(this),plan.deadline);uint256 externalUsdt=amounts[amounts.length-1];if(externalUsdt<=extracted) revert ExternalRouteLoss();
        (uint256 syntheticReserve,uint256 usdtReserve)=_pairReserves();uint256 buybackUsdt=_getAmountIn(plan.qeMint,usdtReserve,syntheticReserve);if(externalUsdt<buybackUsdt+plan.minTreasuryProfit) revert BuybackNotCovered();
        usdt.forceApprove(address(internalRouter),buybackUsdt);uint256 syntheticBought=internalRouter.swapExactTokensForTokens(address(usdt),address(synthetic),buybackUsdt,plan.qeMint,address(this),plan.deadline);if(syntheticBought<plan.qeMint) revert BuybackNotCovered();
        synthetic.burnTemporary(plan.qeMint);temporaryOutstanding=0;uint256 dust=synthetic.balanceOf(address(this));if(dust>MAX_SYNTHETIC_DUST) revert PoolSyntheticNotRestored();if(dust>0) IERC20(address(synthetic)).safeTransfer(treasury,dust);
        uint256 availableProfit=usdt.balanceOf(address(this));if(availableProfit<plan.minTreasuryProfit) revert BuybackNotCovered();usdt.safeTransfer(treasury,availableProfit);
        (uint256 syntheticAfter,uint256 liquidAfter)=_pairBalances();uint256 kAfter=syntheticAfter*liquidAfter;
        if(synthetic.totalSupply()!=supplyBefore||temporaryOutstanding!=0) revert TemporarySupplyNotClosed();if(syntheticAfter+dust<syntheticBefore) revert PoolSyntheticNotRestored();if(liquidAfter<liquidBefore) revert PoolLiquidNotRestored();if(kAfter<kBefore) revert PoolInvariantDecreased();if(usdt.balanceOf(treasury)<=treasuryBefore) revert ExternalRouteLoss();
        profit=usdt.balanceOf(treasury)-treasuryBefore;uint256 lpGain=liquidAfter-liquidBefore;cumulativeVerifiedProfit+=profit;cumulativeLpLiquidGain+=lpGain;lastExtractedUsdt=extracted;lastExternalUsdt=externalUsdt;lastBuybackUsdt=buybackUsdt;lastTreasuryProfit=profit;lastLpLiquidGain=lpGain;lastSyntheticDust=dust;lastKBefore=kBefore;lastKAfter=kAfter;
        emit AtomicCycleClosed(plan.sourceId,plan.nonce,plan.qeMint,extracted,externalUsdt,buybackUsdt,profit,lpGain,dust,kBefore,kAfter);
    }
    function quoteBuyback(uint256 syntheticAmount) external view returns(uint256){(uint256 syntheticReserve,uint256 usdtReserve)=_pairReserves();return _getAmountIn(syntheticAmount,usdtReserve,syntheticReserve);}
    function _getAmountIn(uint256 amountOut,uint256 reserveIn,uint256 reserveOut) private pure returns(uint256){if(amountOut==0||reserveIn==0||amountOut>=reserveOut) revert InvalidPlan();return reserveIn*amountOut*BPS/((reserveOut-amountOut)*(BPS-INTERNAL_FEE_BPS))+1;}
    function _pairReserves() private view returns(uint256 syntheticReserve,uint256 liquidReserve){(uint112 r0,uint112 r1,)=internalPair.getReserves();if(internalPair.token0()==address(synthetic)) return(uint256(r0),uint256(r1));return(uint256(r1),uint256(r0));}
    function _pairBalances() private view returns(uint256 syntheticBalance,uint256 liquidBalance){syntheticBalance=synthetic.balanceOf(address(internalPair));liquidBalance=usdt.balanceOf(address(internalPair));}
}
