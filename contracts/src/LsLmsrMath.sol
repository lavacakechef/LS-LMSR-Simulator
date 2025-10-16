// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Math helpers for LMSR / LS-proxy in 60.18 WAD (PRBMath v4.1.0)
import { UD60x18, ud } from "prb-math/UD60x18.sol";
import { exp, ln }      from "prb-math/ud60x18/Math.sol";

library LsLmsrMath {
    uint256 internal constant WAD = 1e18;
    /// @dev Max input for UD60x18 exp ~ 133.084258667509499441; keep a safety margin.
    uint256 internal constant MAX_EXP_INPUT_WAD = 133e18;

    /// -----------------------------------------------------------------------
    /// Internal helpers
    /// -----------------------------------------------------------------------

    /// @notice logSumExp(q / b): q[] and b are WAD; returns WAD
    function logSumExp(uint256[] memory qWad, uint256 bWad) internal pure returns (uint256 lseWad) {
        uint256 n = qWad.length;
        uint256 sumExpWad = 0;
        for (uint256 i = 0; i < n; i++) {
            // x = q_i / b
            uint256 x = (qWad[i] * WAD) / bWad;
            if (x > MAX_EXP_INPUT_WAD) revert ExpInputTooLarge();
            // exp(x) in WAD using v4 typed API
            uint256 ex = exp(ud(x)).unwrap();
            unchecked {
                sumExpWad += ex;
            }
        }
        // ln(sumExp)
        lseWad = ln(ud(sumExpWad)).unwrap();
    }

    /// @notice prices p_i = exp(q_i/b) / sum_j exp(q_j/b). Returns length n, WAD, sum ~ 1e18
    function prices(uint256[] memory qWad, uint256 bWad) internal pure returns (uint256[] memory pWad) {
        uint256 n = qWad.length;
        pWad = new uint256[](n);
        uint256[] memory expArr = new uint256[](n);
        uint256 sumExpWad = 0;
        for (uint256 i = 0; i < n; i++) {
            uint256 x = (qWad[i] * WAD) / bWad;
            if (x > MAX_EXP_INPUT_WAD) revert ExpInputTooLarge();
            uint256 ex = exp(ud(x)).unwrap();
            expArr[i] = ex;
            unchecked { sumExpWad += ex; }
        }
        for (uint256 i = 0; i < n; i++) {
            // p_i = exp_i / sumExp
            pWad[i] = (expArr[i] * WAD) / sumExpWad;
        }
    }

    /// @notice C(q) = b * logSumExp(q/b). Returns WAD.
    function costAbsolute(uint256[] memory qWad, uint256 bWad) internal pure returns (uint256 cWad) {
        uint256 lse = logSumExp(qWad, bWad);
        // b * lse / WAD
        cWad = (bWad * lse) / WAD;
    }

    /// @notice Cost difference at fixed b: C(q+Δ) - C(q)
    function costFixedB(
        uint256[] memory qWad,
        uint256[] memory deltaWad,
        uint256 bWad
    ) internal pure returns (int256 dCostWad) {
        uint256 n = qWad.length;
        uint256[] memory q2 = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            q2[i] = qWad[i] + deltaWad[i];
        }
        uint256 c1 = costAbsolute(qWad, bWad);
        uint256 c2 = costAbsolute(q2, bWad);
        dCostWad = int256(c2) - int256(c1);
    }

    /// @notice Affine schedule b(T) = b0 + alpha * T ; All WAD
    function bOfT(uint256 b0Wad, uint256 alphaWad, uint256 tWad) internal pure returns (uint256) {
        unchecked {
            return b0Wad + (alphaWad * tWad) / WAD;
        }
    }

    /// @notice Piecewise-constant-b integral approximation for LS-proxy.
    /// Splits Δ into `steps` equal chunks; returns cost and resulting qAfter[] & bAfter.
    /// If isBuy=false, requires q[outcome] >= dQWad (no negative q).
    function costLsProxyStepped(
        uint256[] memory qWad,
        uint8 outcome,
        bool isBuy,
        uint256 dQWad,
        uint16 steps,
        uint256 b0Wad,
        uint256 alphaWad
    )
        internal
        pure
        returns (int256 dCostWad, uint256[] memory qAfterWad, uint256 bAfterWad)
    {
        uint256 n = qWad.length;
        qAfterWad = new uint256[](n);
        for (uint256 i = 0; i < n; i++) qAfterWad[i] = qWad[i];

        if (!isBuy && dQWad > qAfterWad[outcome]) revert NotEnoughQToSell();

        // equal chunk; last step gets remainder
        uint256 chunk = dQWad / steps;
        uint256 rem = dQWad - chunk * steps;

        dCostWad = _executeSteps(qAfterWad, outcome, isBuy, chunk, rem, steps, b0Wad, alphaWad);

        // final b after
        bAfterWad = _computeFinalB(qAfterWad, b0Wad, alphaWad);
    }

    /// @notice Execute all trading steps and return accumulated cost
    function _executeSteps(
        uint256[] memory qAfterWad,
        uint8 outcome,
        bool isBuy,
        uint256 chunk,
        uint256 rem,
        uint16 steps,
        uint256 b0Wad,
        uint256 alphaWad
    ) private pure returns (int256 totalCost) {
        for (uint16 s = 0; s < steps; s++) {
            uint256 dq = (s == steps - 1) ? chunk + rem : chunk;
            totalCost += _executeSingleStep(qAfterWad, outcome, isBuy, dq, b0Wad, alphaWad);
        }
    }

    /// @notice Execute a single trading step at current q
    function _executeSingleStep(
        uint256[] memory qAfterWad,
        uint8 outcome,
        bool isBuy,
        uint256 dq,
        uint256 b0Wad,
        uint256 alphaWad
    ) private pure returns (int256 stepCost) {        
        // compute b from current T
        uint256 tNow = _sumArray(qAfterWad);
        uint256 bNow = bOfT(b0Wad, alphaWad, tNow);

        // cost before
        uint256 c1 = costAbsolute(qAfterWad, bNow);

        // apply trade to qAfter in-place
        if (isBuy) {
            qAfterWad[outcome] += dq;
        } else {
            if (dq > qAfterWad[outcome]) revert NotEnoughQToSell();
            qAfterWad[outcome] -= dq;
        }

        // cost after
        uint256 c2 = costAbsolute(qAfterWad, bNow);
        stepCost = int256(c2) - int256(c1);
    }

    /// @notice Sum all elements in array
    function _sumArray(uint256[] memory arr) private pure returns (uint256 sum) {
        for (uint256 i = 0; i < arr.length; i++) {
            sum += arr[i];
        }
    }

    /// @notice Compute final b after trade
    function _computeFinalB(
        uint256[] memory qAfterWad,
        uint256 b0Wad,
        uint256 alphaWad
    ) private pure returns (uint256) {
        uint256 tAfter = _sumArray(qAfterWad);
        return bOfT(b0Wad, alphaWad, tAfter);
    }

    /// -----------------------------------------------------------------------
    /// Custom errors (duplicated here so the lib can revert cleanly)
    /// -----------------------------------------------------------------------
    error ExpInputTooLarge();
    error NotEnoughQToSell();
}