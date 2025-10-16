// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {LsLmsrAMM} from "../src/LsLmsrAMM.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {console2} from "forge-std/console2.sol";

/// @notice Deploys MockERC20 + LsLmsrAMM. Set PRIVATE_KEY & RPC in env.
contract DeployLsLmsr is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);

        // 1) Collateral token
        MockERC20 collateral = new MockERC20("Mock Dollar", "mUSD");

        // 2) AMM
        LsLmsrAMM amm = new LsLmsrAMM(address(collateral));

        vm.stopBroadcast();

        console2.log("MockERC20:", address(collateral));
        console2.log("LsLmsrAMM:", address(amm));
    }
}
