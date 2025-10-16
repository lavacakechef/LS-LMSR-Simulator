// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ILsLmsr } from "./interfaces/ILsLmsr.sol";
import { LsLmsrMath } from "./LsLmsrMath.sol";
import { IERC20 } from "./interfaces/IERC20.sol";

contract LsLmsrAMM is ILsLmsr {
    using LsLmsrMath for uint256[];
    using LsLmsrMath for uint256;

    IERC20 public immutable _collateralToken;

    uint256 public constant MAX_STEPS = 64;
    uint256 public constant WAD = 1e18;

    // Market meta by id
    Market[] internal _markets;                 // marketId = index
    // Outcome quantities per market (q_i)
    mapping(uint256 => uint256[]) internal _q;  // marketId => q[ n ]
    // User balances per outcome
    mapping(uint256 => mapping(address => mapping(uint8 => uint256))) internal _shares;

    constructor(address collateral_) {
        _collateralToken = IERC20(collateral_);
    }

    // -------------------------- Market lifecycle -----------------------------

    function createMarket(
        Mechanism mech,
        uint8 n,
        uint256 b0Wad,
        uint256 alphaWad
    ) external override returns (uint256 marketId) {
        if (n < 2 || n > 5) revert InvalidN();
        if (mech != Mechanism.LMSR && mech != Mechanism.LS_PROXY) revert InvalidMechanism();
        if (b0Wad == 0) revert InvalidMechanism();

        marketId = _markets.length;

        Market memory m = Market({
            mech: mech,
            n: n,
            b0Wad: b0Wad,
            alphaWad: alphaWad,
            collateral: 0,
            closed: false
        });
        _markets.push(m);

        uint256[] memory qInit = new uint256[](n);
        _q[marketId] = qInit;

        emit MarketCreated(marketId, mech, n, b0Wad, alphaWad);
    }

    function closeMarket(uint256 marketId) external override {
        Market storage m = _markets[marketId];
        m.closed = true;
        emit MarketClosed(marketId);
    }

    // ------------------------------- Views -----------------------------------

    function state(uint256 marketId)
        external
        view
        override
        returns (Market memory meta, uint256[] memory qWad, uint256 tWad, uint256 bEffWad, uint256[] memory pWad)
    {
        meta = _markets[marketId];
        qWad = _q[marketId];
        uint8 n = meta.n;
        for (uint8 i = 0; i < n; i++) tWad += qWad[i];

        bEffWad = (meta.mech == Mechanism.LMSR)
            ? meta.b0Wad
            : LsLmsrMath.bOfT(meta.b0Wad, meta.alphaWad, tWad);

        pWad = LsLmsrMath.prices(qWad, bEffWad);
    }

    function prices(uint256 marketId) external view override returns (uint256[] memory pWad) {
        Market storage m = _markets[marketId];
        uint256[] storage q = _q[marketId];
        uint256 t;
        for (uint8 i = 0; i < m.n; i++) t += q[i];
        uint256 bEff = (m.mech == Mechanism.LMSR) ? m.b0Wad : LsLmsrMath.bOfT(m.b0Wad, m.alphaWad, t);
        pWad = LsLmsrMath.prices(q, bEff);
    }

    // ------------------------------- Quotes -----------------------------------

    function quoteBuy(
        uint256 marketId,
        uint8 outcome,
        uint256 dQWad,
        uint16 steps
    ) public view override returns (uint256 costWad, uint256[] memory pAfterWad) {
        Market storage m = _markets[marketId];
        if (outcome >= m.n) revert InvalidOutcome();
        if (steps == 0 || steps > MAX_STEPS) revert StepsOutOfRange();

        uint256[] memory q = _q[marketId];
        int256 dCost;

        if (m.mech == Mechanism.LMSR) {
            // at fixed b = b0
            uint256[] memory delta = new uint256[](m.n);
            delta[outcome] = dQWad;
            dCost = LsLmsrMath.costFixedB(q, delta, m.b0Wad);
            uint256[] memory qAfter = _qAfterSingle(q, outcome, dQWad, true);
            pAfterWad = LsLmsrMath.prices(qAfter, m.b0Wad);
        } else {
            // LS-proxy stepped integral
            (dCost, , ) = LsLmsrMath.costLsProxyStepped(
                q, outcome, true, dQWad, steps, m.b0Wad, m.alphaWad
            );
            ( , uint256[] memory qAfter, uint256 bAfter) =
                _simulateAfter(q, outcome, true, dQWad, steps, m.b0Wad, m.alphaWad);
            pAfterWad = LsLmsrMath.prices(qAfter, bAfter);
        }

        // trader pays => positive
        if (dCost < 0) {
            costWad = 0; // should not happen for buys
        } else {
            costWad = uint256(dCost);
        }
    }

    function quoteSell(
        uint256 marketId,
        uint8 outcome,
        uint256 dQWad,
        uint16 steps
    ) public view override returns (int256 payoutWad, uint256[] memory pAfterWad) {
        Market storage m = _markets[marketId];
        if (outcome >= m.n) revert InvalidOutcome();
        if (steps == 0 || steps > MAX_STEPS) revert StepsOutOfRange();

        uint256[] memory q = _q[marketId];

        if (m.mech == Mechanism.LMSR) {
            // payout = - ( C(q - Δ) - C(q) ) at fixed b
            uint256[] memory qAfter = _qAfterSingle(q, outcome, dQWad, false);
            // ensure not negative (no shorting)
            if (qAfter[outcome] > q[outcome]) revert NegativeQ();
            int256 dCost = int256(LsLmsrMath.costAbsolute(qAfter, m.b0Wad)) - int256(LsLmsrMath.costAbsolute(q, m.b0Wad));
            payoutWad = -dCost;
            pAfterWad = LsLmsrMath.prices(qAfter, m.b0Wad);
        } else {
            (int256 dCost, uint256[] memory qAfter, uint256 bAfter) = LsLmsrMath.costLsProxyStepped(
                q, outcome, false, dQWad, steps, m.b0Wad, m.alphaWad
            );
            payoutWad = -dCost; // trader receives
            pAfterWad = LsLmsrMath.prices(qAfter, bAfter);
        }
    }

    // ------------------------------- Actions ----------------------------------

    function buy(
        uint256 marketId,
        uint8 outcome,
        uint256 dQWad,
        uint16 steps,
        uint256 maxCostWad
    ) external override {
        Market storage m = _markets[marketId];
        if (m.closed) revert MarketClosedErr();
        if (outcome >= m.n) revert InvalidOutcome();
        if (steps == 0 || steps > MAX_STEPS) revert StepsOutOfRange();
        
        (uint256 cost, ) = quoteBuy(marketId, outcome, dQWad, steps);
        if (cost > maxCostWad) revert SlippageExceeded();

        require(_collateralToken.transferFrom(msg.sender, address(this), cost), "transferFrom");
        _applyTrade(marketId, outcome, true, dQWad, steps);
        
        m.collateral += cost;
        _shares[marketId][msg.sender][outcome] += dQWad;

        emit Trade(marketId, msg.sender, outcome, true, dQWad, cost, _t(marketId), _bEff(marketId));
    }

    function sell(
        uint256 marketId,
        uint8 outcome,
        uint256 dQWad,
        uint16 steps,
        uint256 minPayoutWad
    ) external override {
        Market storage m = _markets[marketId];
        if (m.closed) revert MarketClosedErr();
        if (outcome >= m.n) revert InvalidOutcome();
        if (steps == 0 || steps > MAX_STEPS) revert StepsOutOfRange();
        if (_shares[marketId][msg.sender][outcome] < dQWad) revert SellExceedsHoldings();

        (int256 payout, ) = quoteSell(marketId, outcome, dQWad, steps);
        if (payout < 0 || uint256(payout) < minPayoutWad) revert SlippageExceeded();

        _applyTrade(marketId, outcome, false, dQWad, steps);

        m.collateral -= uint256(payout);
        require(_collateralToken.transfer(msg.sender, uint256(payout)), "transfer");
        _shares[marketId][msg.sender][outcome] -= dQWad;

        emit Trade(marketId, msg.sender, outcome, false, dQWad, uint256(payout), _t(marketId), _bEff(marketId));
    }

    // ----------------------------- Internals ----------------------------------

    function _applyTrade(
        uint256 marketId,
        uint8 outcome,
        bool isBuy,
        uint256 dQWad,
        uint16 steps
    ) internal {
        Market storage m = _markets[marketId];

        uint256[] storage q = _q[marketId];

        if (m.mech == Mechanism.LMSR) {
            if (isBuy) q[outcome] += dQWad;
            else {
                if (dQWad > q[outcome]) revert NegativeQ();
                q[outcome] -= dQWad;
            }
            return;
        }

        // LS-proxy: simulate stepped updates and commit final q
        (, uint256[] memory qAfter, ) = LsLmsrMath.costLsProxyStepped(
            q, outcome, isBuy, dQWad, steps, m.b0Wad, m.alphaWad
        );
        _q[marketId] = qAfter;
    }

    function _qAfterSingle(uint256[] memory q, uint8 i, uint256 dQ, bool isBuy)
        internal pure returns (uint256[] memory r)
    {
        r = new uint256[](q.length);
        for (uint256 k = 0; k < q.length; k++) r[k] = q[k];
        r[i] = isBuy ? r[i] + dQ : (r[i] - dQ);
    }

    function _simulateAfter(
        uint256[] memory q,
        uint8 outcome,
        bool isBuy,
        uint256 dQ,
        uint16 steps,
        uint256 b0,
        uint256 alpha
    ) internal pure returns (uint256 tAfter, uint256[] memory qAfter, uint256 bAfter)
    {
        ( , qAfter, bAfter) = LsLmsrMath.costLsProxyStepped(q, outcome, isBuy, dQ, steps, b0, alpha);
        for (uint8 k = 0; k < qAfter.length; k++) tAfter += qAfter[k];
    }

    function _t(uint256 marketId) internal view returns (uint256 s) {
        uint8 n = _markets[marketId].n;
        uint256[] storage q = _q[marketId];
        for (uint8 i = 0; i < n; i++) s += q[i];
    }

    function _bEff(uint256 marketId) internal view returns (uint256) {
        Market storage m = _markets[marketId];
        uint256 t = _t(marketId);
        return (m.mech == Mechanism.LMSR) ? m.b0Wad : LsLmsrMath.bOfT(m.b0Wad, m.alphaWad, t);
    }

    // Expose userShares getter
    function userShares(uint256 marketId, address user, uint8 outcome) external view override returns (uint256) {
        return _shares[marketId][user][outcome];
    }

    function collateralToken() external view override returns (address) {
        return address(_collateralToken);
    }
}
