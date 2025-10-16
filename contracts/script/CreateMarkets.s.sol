// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {ILsLmsr} from "../src/interfaces/ILsLmsr.sol";
import {console2} from "forge-std/console2.sol";

/// @notice Creates two example markets (LMSR and LS-proxy) on an existing AMM.
contract CreateMarkets is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address ammAddr = vm.envAddress("AMM_ADDRESS"); // set in env
        vm.startBroadcast(pk);

        ILsLmsr amm = ILsLmsr(ammAddr);

        // Market A: LMSR (alpha ignored)
        // N=3, b0=5.0, alpha=0
        uint256 b0 = 5e18;
        uint256 alpha0 = 0;
        uint256 mLmsr = amm.createMarket(ILsLmsr.Mechanism.LMSR, 3, b0, alpha0);

        // Market B: LS-proxy (b(T)=b0 + alpha*T)
        // N=3, b0=5.0, alpha=0.10
        uint256 alpha = 0.1e18;
        uint256 mLs = amm.createMarket(ILsLmsr.Mechanism.LS_PROXY, 3, b0, alpha);

        vm.stopBroadcast();

        console2.log("Created LMSR marketId:", mLmsr);
        console2.log("Created LS-proxy marketId:", mLs);
    }
}
