// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ScriptEnvFixture} from "./ScriptEnvFixture.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {RedeployRegistrar} from "../script/RedeployRegistrar.s.sol";
import {L2Registry} from "../src/durin/L2Registry.sol";
import {IL2Registry} from "../src/durin/interfaces/IL2Registry.sol";
import {WoCoRegistrar} from "../src/WoCoRegistrar.sol";

/**
 * Tests for the registrar redeploy script.
 *
 * Redeploying the registrar is the ROUTINE operation — the registry is frozen,
 * so every policy change ships this way. It was also the script that still left
 * the new registrar owned by the deployer EOA forever, quietly re-creating the
 * state WoCo-Contracts#1 fixed in the initial deploy. Registrar ownership is
 * `addSponsor` / `setReserved` / `setPlatformSigner`: who may mint, and under
 * what name policy.
 *
 * The second half of the same problem only appears AFTER that fix: once the
 * registry admin is a multisig, the deployer key can no longer call
 * `addRegistrar`, so the script has to stop assuming it can — and must not
 * report success for a registrar that cannot mint.
 */
contract RedeployRegistrarTest is ScriptEnvFixture {
    L2Registry registry;
    MockSafe safe;
    address deployer;
    address sponsor = SCRIPT_SPONSOR;

    function setUp() public {
        deployer = vm.addr(SCRIPT_DEPLOYER_PK);
        safe = new MockSafe();

        L2Registry impl = new L2Registry();
        registry = L2Registry(Clones.clone(address(impl)));
        registry.initialize("woco.eth", "WoCo Names", "", deployer);

        // Shared keys come from ScriptEnvFixture - read its header before adding
        // any `vm.setEnv` here. Anything that must VARY per test varies through a
        // `_config()` override instead, never through the environment.
        _setSharedScriptEnv();
        vm.setEnv("L2_REGISTRY_ADDRESS", vm.toString(address(registry)));
        vm.setEnv("REGISTRAR_ADMIN", vm.toString(address(safe)));
    }

    /*//////////////////////////////////////////////////////////////
                    THE DEPLOYER KEEPS NOTHING
    //////////////////////////////////////////////////////////////*/

    /// The bug this script had: it ended with the deployer EOA owning the
    /// registrar, permanently, on every redeploy. Read through the real
    /// environment, so the env wiring is exercised at least once.
    function test_Redeploy_EndsWithTheMultisigOwningTheRegistrar() public {
        RedeployRegistrar script = new RedeployRegistrar();
        address registrarAddress = script.run();

        assertEq(WoCoRegistrar(registrarAddress).owner(), address(safe), "registrar still owned by the deployer");
        assertTrue(registry.registrars(registrarAddress), "registrar was not wired in");
    }

    /// Setup happens while the deployer still owns the registrar; the handover is
    /// last. If it were first, none of this could be written.
    function test_Redeploy_SeedsSponsorAndReservedLabelsBeforeHandingOver() public {
        address registrarAddress = new RedeployRegistrar().run();
        WoCoRegistrar registrar = WoCoRegistrar(registrarAddress);

        assertTrue(registrar.authorisedSponsors(sponsor), "sponsor not authorised");
        assertFalse(registrar.available("admin"), "reserved label is mintable");
        assertFalse(registrar.available("woco"), "reserved label is mintable");
        assertTrue(registrar.available("myvenue"), "an ordinary label should be free");
    }

    /// The point of a redeploy: the new registrar can actually mint.
    function test_Redeploy_NewRegistrarCanMint() public {
        WoCoRegistrar registrar = WoCoRegistrar(new RedeployRegistrar().run());

        string[] memory keys = new string[](0);
        string[] memory vals = new string[](0);
        address organiser = makeAddr("organiser");

        vm.prank(sponsor);
        bytes32 node = registrar.register("myvenue", organiser, hex"e301", keys, vals);

        assertEq(registry.owner(node), organiser);
    }

    function test_Redeploy_RefusesTheZeroAddressAdmin() public {
        WithAdmin script = new WithAdmin(address(0), true, false);
        vm.expectRevert("REGISTRAR_ADMIN must not be the zero address");
        script.run();
    }

    /// The EOA guard, ported from the initial-deploy script. A bare key holding
    /// registrar policy is the state this whole change exists to prevent.
    function test_Redeploy_RefusesABareKeyAdmin() public {
        WithAdmin script = new WithAdmin(makeAddr("bare-key"), false, false);
        vm.expectRevert(
            "REGISTRAR_ADMIN has no code - expected a multisig; set ALLOW_EOA_ADMIN=true for testnet"
        );
        script.run();
    }

    function test_Redeploy_AllowsABareKeyAdminOnlyWithTheTestnetEscapeHatch() public {
        address eoa = makeAddr("bare-key");
        address registrarAddress = new WithAdmin(eoa, true, false).run();

        assertEq(WoCoRegistrar(registrarAddress).owner(), eoa);
    }

    /*//////////////////////////////////////////////////////////////
              WIRING, ONCE THE REGISTRY ADMIN IS A MULTISIG
    //////////////////////////////////////////////////////////////*/

    /// After the initial deploy hands `baseNode` to the multisig, the deployer
    /// key cannot call `addRegistrar`. Attempting it anyway aborts the script
    /// with `Unauthorized` and leaves nothing deployed — so the call is skipped
    /// and the requirement reported instead.
    function test_Redeploy_DoesNotAttemptWiringItCannotDo() public {
        _giveRegistryToTheMultisig();

        address registrarAddress = new AcknowledgingManualWiring().run();

        assertEq(WoCoRegistrar(registrarAddress).owner(), address(safe), "handover did not happen");
        assertFalse(registry.registrars(registrarAddress), "wiring should be outstanding");
    }

    /// And the outstanding multisig transaction really does finish the job.
    function test_Redeploy_MultisigCanCompleteTheWiring() public {
        _giveRegistryToTheMultisig();
        address registrarAddress = new AcknowledgingManualWiring().run();

        vm.prank(address(safe));
        registry.addRegistrar(registrarAddress);

        assertTrue(registry.registrars(registrarAddress));
    }

    /// A registrar that is not in `registrars` cannot mint anything. The script
    /// must not print success over that — the operator has to say, in the
    /// configuration, that they know a multisig transaction is outstanding.
    function test_Redeploy_RefusesToReportSuccessOverAnUnwiredRegistrar() public {
        _giveRegistryToTheMultisig();

        RedeployRegistrar script = new RedeployRegistrar();
        vm.expectRevert(
            "registrar is NOT wired into the registry: the registry admin must call addRegistrar; set EXPECT_MANUAL_WIRING=true to acknowledge"
        );
        script.run();
    }

    /// The acknowledgement is not a blanket "skip the check": with the deployer
    /// still admin, the wiring must genuinely have happened either way.
    function test_Redeploy_AcknowledgementDoesNotSkipRealWiring() public {
        address registrarAddress = new AcknowledgingManualWiring().run();
        assertTrue(registry.registrars(registrarAddress), "wiring was skipped when it was possible");
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _giveRegistryToTheMultisig() internal {
        // Read baseNode BEFORE the prank - it is an external call, and it would
        // otherwise consume the prank instead of the transfer.
        uint256 baseNode = uint256(registry.baseNode());

        vm.prank(deployer);
        registry.transferFrom(deployer, address(safe), baseNode);
        assertEq(registry.owner(), address(safe), "precondition: multisig is registry admin");
    }
}

/*//////////////////////////////////////////////////////////////
                    CONFIGURATION VARIANTS
//////////////////////////////////////////////////////////////*/

/// @dev Overrides only the inputs; every guard in `run()` is the real one.
contract WithAdmin is RedeployRegistrar {
    address internal immutable admin;
    bool internal immutable allowEoa;
    bool internal immutable manualWiring;

    constructor(address admin_, bool allowEoa_, bool manualWiring_) {
        admin = admin_;
        allowEoa = allowEoa_;
        manualWiring = manualWiring_;
    }

    function _config() internal view override returns (Config memory c) {
        c = super._config();
        c.registrarAdmin = admin;
        c.allowEoaAdmin = allowEoa;
        c.expectManualWiring = manualWiring;
    }
}

contract AcknowledgingManualWiring is RedeployRegistrar {
    function _config() internal view override returns (Config memory c) {
        c = super._config();
        c.expectManualWiring = true;
    }
}

/// @dev A contract, because `REGISTRAR_ADMIN` must not be a bare key.
contract MockSafe {}
