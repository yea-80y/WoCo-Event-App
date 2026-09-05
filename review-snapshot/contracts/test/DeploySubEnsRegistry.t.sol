// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ScriptEnvFixture} from "./ScriptEnvFixture.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {DeploySubEnsRegistry} from "../script/DeploySubEnsRegistry.s.sol";
import {L2Registry} from "../src/durin/L2Registry.sol";
import {L2Resolver} from "../src/durin/L2Resolver.sol";
import {IL2Registry} from "../src/durin/interfaces/IL2Registry.sol";
import {WoCoRegistrar} from "../src/WoCoRegistrar.sol";

/**
 * Tests for the sub-ENS deploy script's clone tripwire (WoCo-Event-App #440).
 *
 * #440 is not a contract bug — every WoCo addition to `L2Registry` worked, and
 * its tests passed, against a locally constructed registry. The bug was that the
 * script deployed a DIFFERENT registry: `L2RegistryFactory.deployRegistry` clones
 * an implementation fixed at the factory's construction, which is NameStone's.
 * Nothing in the suite compared the deployed bytecode to ours, so the gap was
 * invisible for as long as nobody read the factory.
 *
 * These tests therefore do the thing that was missing: they run the script and
 * assert facts about what it actually put on chain, and they prove each clause of
 * the tripwire fires on its own by substituting a deployment it must reject.
 */
contract DeploySubEnsRegistryTest is ScriptEnvFixture {
    DeploySubEnsRegistry script;
    MockSafe safe;

    function setUp() public {
        script = new DeploySubEnsRegistry();
        safe = new MockSafe();
        _setEnv();
    }

    /// @dev Shared keys come from ScriptEnvFixture — read its header before
    ///      adding any `vm.setEnv` here. Everything that needs to VARY per test
    ///      varies through a `_deployRegistryClone` override instead, never
    ///      through the environment. See the handover note on the two
    ///      `REGISTRY_ADMIN` guards that are consequently still untested.
    function _setEnv() internal {
        _setSharedScriptEnv();
        vm.setEnv("REGISTRY_ADMIN", vm.toString(address(safe)));
        vm.setEnv("PARENT_NAME", "woco.eth");
    }

    /*//////////////////////////////////////////////////////////////
                  THE DEPLOY PRODUCES *OUR* REGISTRY
    //////////////////////////////////////////////////////////////*/

    /// The headline #440 assertion: the registry that goes live is a clone of an
    /// implementation this script deployed, not of anything NameStone deployed.
    function test_Deploy_RegistryIsACloneOfOurOwnImplementation() public {
        (address registryAddr,) = script.run();

        assertEq(registryAddr.code.length, 45, "registry is not an EIP-1167 clone");

        address impl = _embeddedImplementation(registryAddr);
        assertTrue(impl.code.length > 0, "implementation has no code");
        assertTrue(
            impl != 0xdeB09eB3111cB75d538216e8B8fC30047d75fb34,
            "registry still points at NameStone's implementation"
        );
    }

    /// The capability #440 exists to protect: #422's `adminTransfer` must be
    /// callable on the DEPLOYED registry, which was never true through the
    /// factory. Exercised end to end rather than asserted about bytecode.
    function test_Deploy_AdminTransferIsReachableOnTheDeployedRegistry() public {
        (address registryAddr, address registrarAddr) = script.run();
        L2Registry registry = L2Registry(registryAddr);
        WoCoRegistrar registrar = WoCoRegistrar(registrarAddr);

        address organiser = makeAddr("organiser");
        address claimant = makeAddr("claimant");

        string[] memory keys = new string[](0);
        string[] memory vals = new string[](0);
        vm.prank(SCRIPT_SPONSOR);
        bytes32 node = registrar.register("venue", organiser, hex"e301", keys, vals);

        vm.prank(address(safe));
        registry.adminTransfer(node, claimant);

        assertEq(registry.owner(node), claimant, "adminTransfer is not reachable on the deployed registry");
    }

    /// Both admin roles end on the multisig, not the deployer key. Re-pinned here
    /// because the deploy path changed underneath the rotation that WoCo-Contracts#1 added.
    function test_Deploy_RotatesBothAdminRolesToTheMultisig() public {
        (address registryAddr, address registrarAddr) = script.run();

        assertEq(L2Registry(registryAddr).owner(), address(safe), "registry admin did not rotate");
        assertEq(WoCoRegistrar(registrarAddr).owner(), address(safe), "registrar owner did not rotate");
    }

    /*//////////////////////////////////////////////////////////////
                        EACH TRIPWIRE CLAUSE FIRES
    //////////////////////////////////////////////////////////////*/

    /// Clause 1. The literal #440 regression: a registry cloned from an
    /// implementation other than the one this script deployed. Reinstating the
    /// factory call while leaving `new L2Registry()` in place lands exactly here.
    function test_Tripwire_RejectsACloneOfSomethingElse() public {
        ClonesSomethingElse bad = new ClonesSomethingElse();
        vm.expectRevert("registry is not a clone of the implementation this script deployed");
        bad.run();
    }

    /// Clause 2. NameStone's implementation address, named. The code behind it is
    /// genuinely ours here, so clauses 1 and 3 both pass — this test fails the
    /// moment clause 2 is deleted.
    function test_Tripwire_RejectsNameStonesImplementationAddress() public {
        ClonesNameStonesAddress bad = new ClonesNameStonesAddress();
        vm.expectRevert("registry implementation is NameStone's - the factory path is back");
        bad.run();
    }

    /// Clause 3. An implementation at an address of its own, correctly cloned,
    /// that simply is not our source — upstream Durin's shape. Clauses 1 and 2
    /// pass; only the behaviour check catches it. This is the clause that
    /// survives someone shuffling addresses to satisfy the other two.
    function test_Tripwire_RejectsAnUpstreamShapedImplementation() public {
        ClonesUpstreamShape bad = new ClonesUpstreamShape();
        vm.expectRevert("registry implementation does not run WoCo's adminTransfer - it is not our bytecode");
        bad.run();
    }

    /// Clause 3, the case the previous bytecode scan got wrong: a contract whose
    /// runtime code CONTAINS the `adminTransfer` selector — as a constant — but
    /// has no such function. Asserted both ways: the old scan would have passed
    /// it, and the behavioural probe does not.
    function test_Tripwire_RejectsAnImplementationThatMerelyMentionsTheSelector() public {
        address impostor = address(new MentionsTheSelector());
        assertTrue(
            _codeContainsSelector(impostor, L2Registry.adminTransfer.selector),
            "precondition: the selector bytes are present, so a byte scan would accept this"
        );

        ClonesTheSelectorMentioner bad = new ClonesTheSelectorMentioner();
        vm.expectRevert("registry implementation does not run WoCo's adminTransfer - it is not our bytecode");
        bad.run();
    }

    /// Clause 3 is a REVERT match, not a return match. A contract that answers
    /// every call successfully with the expected error's bytes as return data
    /// is not our code either — and a probe that only inspected the bytes would
    /// have accepted it.
    function test_Tripwire_RejectsAnImplementationThatAnswersWithoutReverting() public {
        ClonesTheEchoer bad = new ClonesTheEchoer();
        vm.expectRevert("registry implementation does not run WoCo's adminTransfer - it is not our bytecode");
        bad.run();
    }

    /// Clause 3 matches the ERROR, not merely a revert. A contract that has both
    /// functions and reverts from each with some other custom error is not our
    /// code, and a probe that only checked "did it revert with data" would
    /// have accepted it.
    function test_Tripwire_RejectsAnImplementationThatRevertsWithTheWrongError() public {
        ClonesTheWrongErrors bad = new ClonesTheWrongErrors();
        vm.expectRevert("registry implementation does not run WoCo's adminTransfer - it is not our bytecode");
        bad.run();
    }

    /// Clause 3 covers BOTH WoCo additions. An implementation built from a
    /// branch that has #422 but not #464 — `adminTransfer` present, `release`
    /// absent — is rejected by the second probe. This is the regression a
    /// mainnet deploy from a stale branch would be.
    function test_Tripwire_RejectsAnImplementationWithoutRelease() public {
        ClonesAdminTransferOnly bad = new ClonesAdminTransferOnly();
        vm.expectRevert("registry implementation does not run WoCo's release - it is not our bytecode");
        bad.run();
    }

    /// Clause 3 covers the signature rail too. An implementation from the
    /// branch that had `release` but not `releaseWithSignature` — the registry
    /// deployed on 2026-09-02 is exactly this shape — is rejected by the third
    /// probe. Without it, a mainnet deploy from that commit would pass.
    function test_Tripwire_RejectsAnImplementationWithoutReleaseWithSignature() public {
        ClonesReleaseOnly bad = new ClonesReleaseOnly();
        vm.expectRevert("registry implementation does not run WoCo's releaseWithSignature - it is not our bytecode");
        bad.run();
    }

    /// Shape, length: a proxy carrying trailing immutable args is not the clone
    /// we reasoned about, and its extra bytes are unexamined.
    function test_Tripwire_RejectsACloneWithTrailingBytes() public {
        DeploysOversizedProxy bad = new DeploysOversizedProxy();
        vm.expectRevert("registry is not an EIP-1167 clone");
        bad.run();
    }

    /// Shape, prefix: 45 bytes of something else entirely. Without the prefix
    /// check, `_cloneImplementationOf` would read 20 arbitrary bytes out of an
    /// arbitrary contract and call them an implementation address.
    function test_Tripwire_RejectsAProxyWithTheWrongPrefix() public {
        bytes memory runtime = bytes.concat(
            hex"00112233445566778899", // not 363d3d373d3d3d363d73
            bytes20(makeAddr("impl")),
            hex"5af43d82803e903d91602b57fd5bf3" // ...but a correct suffix
        );
        DeploysEtchedProxy bad = new DeploysEtchedProxy(runtime);
        vm.expectRevert("registry is not an EIP-1167 clone");
        bad.run();
    }

    /// Shape, suffix: the delegatecall-and-return tail is what makes a minimal
    /// proxy a proxy. Rival 45-byte clone dialects share the prefix and differ
    /// here, and one of those is not the contract this deploy was reasoned about.
    function test_Tripwire_RejectsAProxyWithTheWrongSuffix() public {
        bytes memory runtime = bytes.concat(
            hex"363d3d373d3d3d363d73", // a correct prefix...
            bytes20(makeAddr("impl")),
            hex"00112233445566778899aabbccddee" // ...and a tail that does something else
        );
        DeploysEtchedProxy bad = new DeploysEtchedProxy(runtime);
        vm.expectRevert("registry is not an EIP-1167 clone");
        bad.run();
    }

    /// Not a proxy at all — the registry deployed directly rather than cloned.
    function test_Tripwire_RejectsANonProxyRegistry() public {
        DeploysDirectly bad = new DeploysDirectly();
        vm.expectRevert("registry is not an EIP-1167 clone");
        bad.run();
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _embeddedImplementation(address clone) internal view returns (address impl) {
        bytes memory code = clone.code;
        assembly {
            impl := shr(96, mload(add(code, 0x2a)))
        }
    }

    /// @dev The scan the tripwire used to run, kept here only to demonstrate
    ///      what it accepts.
    function _codeContainsSelector(address target, bytes4 selector) internal view returns (bool) {
        bytes memory code = target.code;
        if (code.length < 4) return false;
        for (uint256 i; i <= code.length - 4; ++i) {
            if (
                code[i] == selector[0] && code[i + 1] == selector[1] && code[i + 2] == selector[2]
                    && code[i + 3] == selector[3]
            ) return true;
        }
        return false;
    }
}

/*//////////////////////////////////////////////////////////////
        SUBSTITUTE DEPLOYMENTS THE TRIPWIRE MUST REJECT

    Each overrides only `_deployRegistryClone`; everything else in the
    script, the tripwire included, runs unchanged.
//////////////////////////////////////////////////////////////*/

contract ClonesSomethingElse is DeploySubEnsRegistry {
    function _deployRegistryClone(string memory parentName, address admin)
        internal
        override
        returns (address registryAddr, address implAddr)
    {
        implAddr = address(new L2Registry()); // reported...
        registryAddr = Clones.clone(address(new L2Registry())); // ...but not the one cloned
        IL2Registry(registryAddr).initialize(parentName, "WoCo Names", "", admin);
    }
}

contract ClonesNameStonesAddress is DeploySubEnsRegistry {
    function _deployRegistryClone(string memory parentName, address admin)
        internal
        override
        returns (address registryAddr, address implAddr)
    {
        implAddr = NAMESTONE_REGISTRY_IMPLEMENTATION;
        // Our real bytecode, at their address: clauses 1 and 3 are satisfied.
        vm.etch(implAddr, address(new L2Registry()).code);
        registryAddr = Clones.clone(implAddr);
        IL2Registry(registryAddr).initialize(parentName, "WoCo Names", "", admin);
    }
}

contract ClonesUpstreamShape is DeploySubEnsRegistry {
    function _deployRegistryClone(string memory parentName, address admin)
        internal
        override
        returns (address registryAddr, address implAddr)
    {
        implAddr = address(new UpstreamShapedRegistry());
        registryAddr = Clones.clone(implAddr);
        UpstreamShapedRegistry(registryAddr).initialize(parentName, "WoCo Names", "", admin);
    }
}

contract ClonesTheSelectorMentioner is DeploySubEnsRegistry {
    function _deployRegistryClone(string memory parentName, address admin)
        internal
        override
        returns (address registryAddr, address implAddr)
    {
        implAddr = address(new MentionsTheSelector());
        registryAddr = Clones.clone(implAddr);
        MentionsTheSelector(registryAddr).initialize(parentName, "WoCo Names", "", admin);
    }
}

contract ClonesTheEchoer is DeploySubEnsRegistry {
    function _deployRegistryClone(string memory parentName, address admin)
        internal
        override
        returns (address registryAddr, address implAddr)
    {
        implAddr = address(new EchoesTheExpectedError());
        registryAddr = Clones.clone(implAddr);
        EchoesTheExpectedError(registryAddr).initialize(parentName, "WoCo Names", "", admin);
    }
}

contract ClonesTheWrongErrors is DeploySubEnsRegistry {
    function _deployRegistryClone(string memory parentName, address admin)
        internal
        override
        returns (address registryAddr, address implAddr)
    {
        implAddr = address(new WrongErrorRegistry());
        registryAddr = Clones.clone(implAddr);
        WrongErrorRegistry(registryAddr).initialize(parentName, "WoCo Names", "", admin);
    }
}

contract ClonesAdminTransferOnly is DeploySubEnsRegistry {
    function _deployRegistryClone(string memory parentName, address admin)
        internal
        override
        returns (address registryAddr, address implAddr)
    {
        implAddr = address(new AdminTransferOnlyRegistry());
        registryAddr = Clones.clone(implAddr);
        AdminTransferOnlyRegistry(registryAddr).initialize(parentName, "WoCo Names", "", admin);
    }
}

contract DeploysOversizedProxy is DeploySubEnsRegistry {
    function _deployRegistryClone(string memory, address)
        internal
        override
        returns (address registryAddr, address implAddr)
    {
        implAddr = address(new L2Registry());
        registryAddr = Clones.clone(implAddr);
        // A minimal proxy carrying appended immutable args.
        vm.etch(registryAddr, bytes.concat(registryAddr.code, hex"deadbeef"));
    }
}

/// @dev Puts arbitrary runtime bytecode where the registry should be, so the
///      prefix and suffix halves of the shape check can be exercised separately.
contract DeploysEtchedProxy is DeploySubEnsRegistry {
    bytes internal runtime;

    constructor(bytes memory runtime_) {
        runtime = runtime_;
    }

    function _deployRegistryClone(string memory, address)
        internal
        override
        returns (address registryAddr, address implAddr)
    {
        implAddr = address(new L2Registry());
        registryAddr = address(uint160(uint256(keccak256(runtime))));
        vm.etch(registryAddr, runtime);
    }
}

contract DeploysDirectly is DeploySubEnsRegistry {
    function _deployRegistryClone(string memory parentName, address admin)
        internal
        override
        returns (address registryAddr, address implAddr)
    {
        implAddr = address(new L2Registry());
        UpstreamShapedRegistry direct = new UpstreamShapedRegistry();
        direct.initialize(parentName, "WoCo Names", "", admin);
        registryAddr = address(direct);
    }
}

/// @dev Stands in for upstream Durin: initialises like a registry, has no
///      `adminTransfer`. Deliberately tiny — what matters is the absence.
contract UpstreamShapedRegistry {
    address public admin;

    function initialize(string calldata, string memory, string memory, address admin_) external {
        admin = admin_;
    }
}

/// @dev Upstream's shape plus the four bytes of `adminTransfer`'s selector as a
///      public constant, so they appear verbatim in the runtime bytecode. No
///      such function exists. A right-aligned `uint32`, not a `bytes4`: solc's
///      constant optimiser re-encodes a left-aligned four-byte value without
///      its literal bytes, which is its own argument against scanning for them.
contract MentionsTheSelector is UpstreamShapedRegistry {
    uint32 public constant LOOKS_LIKE_ADMIN_TRANSFER = uint32(L2Registry.adminTransfer.selector);
}

/// @dev Initialises like a registry; every other call SUCCEEDS and returns the
///      `Unauthorized(bytes32)` selector as data. Never reverts.
contract EchoesTheExpectedError is UpstreamShapedRegistry {
    fallback() external {
        bytes4 sel = L2Resolver.Unauthorized.selector;
        assembly {
            mstore(0, sel)
            return(0, 32)
        }
    }
}

/// @dev Has both WoCo entry points, and reverts from each with an error that
///      is not ours.
contract WrongErrorRegistry is UpstreamShapedRegistry {
    error NotOurs(bytes32 node);

    function adminTransfer(bytes32 node, address) external pure {
        revert NotOurs(node);
    }

    function release(bytes32 node) external pure {
        revert NotOurs(node);
    }
}

/// @dev A registry from a branch with #422 but without #464: `adminTransfer`
///      answers exactly as ours does, `release` does not exist.
contract AdminTransferOnlyRegistry is UpstreamShapedRegistry {
    error Unauthorized(bytes32 node);

    function adminTransfer(bytes32, address) external view {
        if (admin != msg.sender) revert Unauthorized(bytes32(0));
    }
}

contract ClonesReleaseOnly is DeploySubEnsRegistry {
    function _deployRegistryClone(string memory parentName, address admin)
        internal
        override
        returns (address registryAddr, address implAddr)
    {
        implAddr = address(new ReleaseOnlyRegistry());
        registryAddr = Clones.clone(implAddr);
        ReleaseOnlyRegistry(registryAddr).initialize(parentName, "WoCo Names", "", admin);
    }
}

/// @dev A registry with #422 and the first half of #464 — `adminTransfer` and
///      `release` answer exactly as ours do — but no `releaseWithSignature`.
contract ReleaseOnlyRegistry is UpstreamShapedRegistry {
    error Unauthorized(bytes32 node);
    error ReleaseUnregistered(bytes32 node);

    function adminTransfer(bytes32, address) external view {
        if (admin != msg.sender) revert Unauthorized(bytes32(0));
    }

    function release(bytes32 node) external pure {
        revert ReleaseUnregistered(node);
    }
}

/// @dev A contract, because `REGISTRY_ADMIN` must not be a bare key.
contract MockSafe {}
