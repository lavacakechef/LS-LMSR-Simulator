// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Core interface exposed to the frontend & tests.
interface ILsLmsr {
    /// -----------------------------------------------------------------------
    /// Types
    /// -----------------------------------------------------------------------
    enum Mechanism {
        LMSR,       // b = b0 (alpha ignored)
        LS_PROXY    // b(T) = b0 + alpha * T
    }

    struct Market {
        Mechanism mech;
        uint8 n;                // outcomes: 2..5
        uint256 b0Wad;          // 60.18 fixed point
        uint256 alphaWad;       // 60.18 fixed point
        uint256 collateral;     // total collateral held by AMM
        bool closed;
    }

    /// -----------------------------------------------------------------------
    /// Events
    /// -----------------------------------------------------------------------
    event MarketCreated(
        uint256 indexed marketId,
        Mechanism mech,
        uint8 n,
        uint256 b0Wad,
        uint256 alphaWad
    );

    /// @dev costWad is the amount the trader paid (buy) or received (sell) in WAD.
    event Trade(
        uint256 indexed marketId,
        address indexed trader,
        uint8 outcome,
        bool isBuy,
        uint256 dQWad,
        uint256 costWad,
        uint256 tAfterWad,
        uint256 bAfterWad
    );

    event MarketClosed(uint256 indexed marketId);

    /// -----------------------------------------------------------------------
    /// Errors
    /// -----------------------------------------------------------------------
    error InvalidOutcome();
    error InvalidN();
    error InvalidMechanism();
    error MarketClosedErr();
    error SellExceedsHoldings();
    error SlippageExceeded();
    error StepsOutOfRange();
    error NotImplemented();
    error ExpInputTooLarge();
    error NegativeQ();
    error NotEnoughQToSell();

    /// -----------------------------------------------------------------------
    /// Market lifecycle
    /// -----------------------------------------------------------------------
    function createMarket(
        Mechanism mech,
        uint8 n,
        uint256 b0Wad,
        uint256 alphaWad
    ) external returns (uint256 marketId);

    function closeMarket(uint256 marketId) external;

    /// -----------------------------------------------------------------------
    /// Views
    /// -----------------------------------------------------------------------
    function state(uint256 marketId)
        external
        view
        returns (
            Market memory meta,
            uint256[] memory qWad,   // length n
            uint256 tWad,            // sum(q)
            uint256 bEffWad,         // b or b(T)
            uint256[] memory pWad    // prices length n (sum≈1e18 for our two modes)
        );

    function prices(uint256 marketId) external view returns (uint256[] memory pWad);

    function quoteBuy(
        uint256 marketId,
        uint8 outcome,
        uint256 dQWad,
        uint16 steps
    ) external view returns (uint256 costWad, uint256[] memory pAfterWad);

    function quoteSell(
        uint256 marketId,
        uint8 outcome,
        uint256 dQWad,
        uint16 steps
    ) external view returns (int256 payoutWad, uint256[] memory pAfterWad);

    /// -----------------------------------------------------------------------
    /// Actions
    /// -----------------------------------------------------------------------
    function buy(
        uint256 marketId,
        uint8 outcome,
        uint256 dQWad,
        uint16 steps,
        uint256 maxCostWad
    ) external;

    function sell(
        uint256 marketId,
        uint8 outcome,
        uint256 dQWad,
        uint16 steps,
        uint256 minPayoutWad
    ) external;

    /// -----------------------------------------------------------------------
    /// User balances & collateral token
    /// -----------------------------------------------------------------------
    function collateralToken() external view returns (address);

    function userShares(uint256 marketId, address user, uint8 outcome) external view returns (uint256);
}
