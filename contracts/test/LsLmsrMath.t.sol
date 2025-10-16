// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LsLmsrMath} from "../src/LsLmsrMath.sol";

contract LsLmsrMathTest is Test {
    using LsLmsrMath for uint256[];

    uint256 constant WAD = 1e18;

    function _approxEq(uint256 a, uint256 b, uint256 tol) internal pure returns (bool) {
        if (a > b) return a - b <= tol;
        return b - a <= tol;
    }

    function test_PricesSumToOne_LMSR() public pure {
        uint256[] memory q = new uint256[](3);
        q[0] = 0;
        q[1] = 0;
        q[2] = 0;
        uint256 b = 3e18;

        uint256[] memory p = LsLmsrMath.prices(q, b);
        uint256 s = p[0] + p[1] + p[2];
        assertTrue(_approxEq(s, WAD, 1e9), "sum(p)!=1");
        for (uint256 i = 0; i < 3; i++) {
            assertTrue(p[i] <= WAD, "p>1");
        }
    }

    function test_CostFixedB_NoOpIsZero() public pure {
        uint256[] memory q = new uint256[](3);
        q[0] = 1e18;
        q[1] = 2e18;
        uint256[] memory d = new uint256[](3);
        d[0] = 0;
        d[1] = 0;
        uint256 b = 5e18;

        int256 dc = LsLmsrMath.costFixedB(q, d, b);
        assertEq(dc, 0);
    }

    function test_LSProxy_bOfT() public pure {
        uint256 b0 = 5e18;
        uint256 alpha = 0.1e18; // per unit T
        uint256 T = 20e18;
        uint256 b = LsLmsrMath.bOfT(b0, alpha, T); // 5 + 0.1*20 = 7
        assertEq(b, 7e18);
    }

    function test_LSProxy_CostStepsConverges() public pure {
        // Buy 5 units in outcome 0; compare steps=1 vs steps=32
        uint256[] memory q = new uint256[](3);
        q[0] = 0;
        q[1] = 0;
        q[2] = 0;
        uint256 b0 = 5e18;
        uint256 alpha = 0.1e18;
        (int256 c1,,) = LsLmsrMath.costLsProxyStepped(q, 0, true, 1e18, 1, b0, alpha);
        (int256 c32,,) = LsLmsrMath.costLsProxyStepped(q, 0, true, 1e18, 32, b0, alpha);
        // step-32 should be very close to step-1 for small alpha & small trade; tolerate 0.3%
        uint256 diff = uint256(c1 > c32 ? c1 - c32 : c32 - c1);
        assertTrue(diff * 1000 <= uint256(c32) * 3, "LS step approx too far"); // <=0.3%
    }
}
