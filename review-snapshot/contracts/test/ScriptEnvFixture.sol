// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

/// @title ScriptEnvFixture
/// @notice The environment values shared by every test that runs a deploy script.
///
/// @dev READ THIS BEFORE ADDING A `vm.setEnv` TO A SCRIPT TEST.
///
///      `vm.setEnv` writes the environment of the whole forge process, and
///      Foundry runs test functions — and test FILES — in parallel. Two tests
///      writing DIFFERENT values to the same key therefore race: a script reads
///      whichever write landed last, which may belong to a test in another file
///      entirely. It fails intermittently, and it passes when you run the file
///      on its own, which is the worst possible failure mode to debug.
///
///      This is not hypothetical. `DeploySubEnsRegistry.t.sol` and
///      `RedeployRegistrar.t.sol` each set `DEPLOYER_PRIVATE_KEY` to a different
///      key; both files passed alone and four tests failed in the full suite,
///      because the redeploy script resolved a deployer that was not its
///      registry's admin.
///
///      So: keys that more than one file sets are defined ONCE, here, and any
///      test needing a DIFFERENT value must not use the environment at all —
///      vary it through the script's `_config()` / `_deployRegistryClone` seam,
///      which exists for exactly this reason.
abstract contract ScriptEnvFixture is Test {
    /// @dev Same key for every script test. Its address is the deployer, and in
    ///      redeploy tests also the registry's initial admin.
    uint256 internal constant SCRIPT_DEPLOYER_PK = 0xA11CE;

    /// @dev A literal, not `makeAddr`, so the value cannot drift with a label.
    address internal constant SCRIPT_SPONSOR = address(uint160(0x50000001));

    function _setSharedScriptEnv() internal {
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(bytes32(SCRIPT_DEPLOYER_PK)));
        vm.setEnv("SPONSOR_ADDRESS", vm.toString(SCRIPT_SPONSOR));
    }
}
