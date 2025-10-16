// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {ILsLmsr} from "../src/interfaces/ILsLmsr.sol";
import {LsLmsrAMM} from "../src/LsLmsrAMM.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {LsLmsrMath} from "../src/LsLmsrMath.sol";

contract LsLmsr_FlowTest is Test {
    using LsLmsrMath for uint256[];

    uint256 constant WAD = 1e18;

    MockERC20 token;
    LsLmsrAMM amm;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        token = new MockERC20("Mock Dollar", "mUSD");
        amm = new LsLmsrAMM(address(token));

        // fund users
        token.mint(alice, 1_000_000e18);
        token.mint(bob, 1_000_000e18);
    }

    function _approve(address user, uint256 amount) internal {
        vm.startPrank(user);
        token.approve(address(amm), amount);
        vm.stopPrank();
    }

    function _createLMSR() internal returns (uint256) {
        return amm.createMarket(ILsLmsr.Mechanism.LMSR, 3, 5e18, 0);
    }

    function _createLS() internal returns (uint256) {
        return amm.createMarket(ILsLmsr.Mechanism.LS_PROXY, 3, 5e18, 0.1e18);
    }

    // --------- LMSR PROPERTIES ---------

    function test_LMSR_PricesSumTo1_AndMonotone() public {
        uint256 m = _createLMSR();
        (,,,, uint256[] memory p0) = amm.state(m);
        uint256 s0 = p0[0] + p0[1] + p0[2];
        assertApproxEqRel(s0, WAD, 1e15);

        // Alice buys 5 on outcome0
        _approve(alice, type(uint256).max);
        vm.startPrank(alice);
        (uint256 cost,) = amm.quoteBuy(m, 0, 5e18, 1);
        amm.buy(m, 0, 5e18, 1, cost);
        vm.stopPrank();

        (,,,, uint256[] memory p1) = amm.state(m);
        assertGt(p1[0], p0[0], "p0 should increase after buying outcome 0");
        uint256 s1 = p1[0] + p1[1] + p1[2];
        assertApproxEqRel(s1, WAD, 1e15);
    }

    function test_LMSR_RoundTripBuySellNearZero() public {
        uint256 m = _createLMSR();
        _approve(alice, type(uint256).max);

        vm.startPrank(alice);
        (uint256 cost,) = amm.quoteBuy(m, 1, 8e18, 1);
        amm.buy(m, 1, 8e18, 1, cost);

        (int256 payout,) = amm.quoteSell(m, 1, 8e18, 1);
        amm.sell(m, 1, 8e18, 1, uint256(payout));
        vm.stopPrank();

        // allow tiny rounding drift (<= 1e12 wei)
        uint256 bal = token.balanceOf(alice);
        assertTrue(bal >= 1_000_000e18 - 1e12 && bal <= 1_000_000e18 + 1e12, "roundtrip drift too large");
    }

    // --------- LS-PROXY PROPERTIES ---------

    function test_LSProxy_AlphaZeroMatchesLMSR() public {
        // LS with alpha=0 should equal LMSR responses
        uint256 mA = amm.createMarket(ILsLmsr.Mechanism.LS_PROXY, 3, 5e18, 0);
        uint256 mB = _createLMSR();

        (,,,, uint256[] memory pA) = amm.state(mA);
        (,,,, uint256[] memory pB) = amm.state(mB);
        for (uint256 i = 0; i < 3; i++) {
            assertApproxEqRel(pA[i], pB[i], 1e15);
        }

        _approve(alice, type(uint256).max);
        vm.startPrank(alice);
        (uint256 cA,) = amm.quoteBuy(mA, 0, 3e18, 1);
        (uint256 cB,) = amm.quoteBuy(mB, 0, 3e18, 1);
        assertApproxEqRel(cA, cB, 1e15);
        vm.stopPrank();
    }

    function test_LSProxy_LaterTradesMovePriceLess() public {
        uint256 m = _createLS();
        _approve(alice, type(uint256).max);

        // First buy Δ=2 on outcome 0 at low T
        vm.startPrank(alice);
        (uint256 c1,) = amm.quoteBuy(m, 0, 2e18, 16); // use steps=16 in quote to approximate
        amm.buy(m, 0, 2e18, 16, c1);
        vm.stopPrank();
        (,,,, uint256[] memory pAfter1) = amm.state(m);
        uint256 p0_after1 = pAfter1[0];

        // Second buy Δ=2 on outcome 0 at higher T
        vm.startPrank(alice);
        (uint256 c2,) = amm.quoteBuy(m, 0, 2e18, 16);
        amm.buy(m, 0, 2e18, 16, c2);
        vm.stopPrank();
        (,,,, uint256[] memory pAfter2) = amm.state(m);
        uint256 p0_after2 = pAfter2[0];

        // Compute the two jumps: Δp1 (first) vs Δp2 (second); expect Δp2 < Δp1
        // Need the pre-states: re-create a fresh market to get baseline p before first trade (all equal)
        uint256 fresh = _createLS();
        (,,,, uint256[] memory p0) = amm.state(fresh); // baseline equal probs
        uint256 dp1 = p0_after1 - p0[0];
        uint256 dp2 = p0_after2 - p0_after1;
        assertGt(dp1, dp2, "later trade should move price less (LS effect)");
    }

    function test_LSProxy_QuoteExecuteParity() public {
        uint256 m = _createLS();
        _approve(bob, type(uint256).max);

        vm.startPrank(bob);
        (uint256 qCost,) = amm.quoteBuy(m, 2, 7e18, 8);
        amm.buy(m, 2, 7e18, 8, qCost);
        vm.stopPrank();

        // No direct cost getter; check AMM collateral moved by that amount
        (ILsLmsr.Market memory meta,,,,) = amm.state(m);
        assertEq(meta.collateral, qCost, "collateral should equal paid cost");
    }

    function test_RevertSellWithoutShares() public {
        uint256 m = _createLMSR();
        vm.expectRevert(ILsLmsr.SellExceedsHoldings.selector);
        vm.prank(alice);
        amm.sell(m, 0, 1e18, 1, 0);
    }

    function test_SlippageProtection() public {
        uint256 m = _createLMSR();
        _approve(alice, type(uint256).max);
        vm.startPrank(alice);
        (uint256 cost,) = amm.quoteBuy(m, 0, 5e18, 1);

        vm.expectRevert(ILsLmsr.SlippageExceeded.selector);
        amm.buy(m, 0, 5e18, 1, cost - 1); // Set maxCost too low
    }

    function test_ClosedMarketReverts() public {
        uint256 m = _createLMSR();
        amm.closeMarket(m);

        vm.expectRevert(ILsLmsr.MarketClosedErr.selector);
        amm.buy(m, 0, 1e18, 1, type(uint256).max);
    }

    function testFuzz_PriceSumRemains1(uint256 trades) public {
        trades = bound(trades, 1, 50);
        uint256 m = _createLMSR();
        _approve(alice, type(uint256).max);

        vm.startPrank(alice);
        for (uint256 i = 0; i < trades; i++) {
            uint8 outcome = uint8(i % 3);
            (uint256 cost,) = amm.quoteBuy(m, outcome, 0.1e18, 1);
            amm.buy(m, outcome, 0.1e18, 1, cost);

            (,,,, uint256[] memory p) = amm.state(m);
            uint256 sum = p[0] + p[1] + p[2];
            assertApproxEqRel(sum, WAD, 1e15, "prices don't sum to 1");
        }
    }
}
