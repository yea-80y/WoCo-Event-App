// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {WoCoRegistrar} from "../src/WoCoRegistrar.sol";
import {L2Registry} from "../src/durin/L2Registry.sol";
import {L2Resolver} from "../src/durin/L2Resolver.sol";
import {IL2Registry} from "../src/durin/interfaces/IL2Registry.sol";

/// @title DeploySubEnsRegistry
/// @notice Creates WoCo's sub-ENS registry on an L2 from OUR OWN registry
///         implementation, deploys WoCoRegistrar, wires it in, seeds sponsor +
///         reserved names, and hands both admin roles to `REGISTRY_ADMIN`
///         before it returns.
///
/// @dev Run against Arbitrum Sepolia first:
///        forge script script/DeploySubEnsRegistry.s.sol --rpc-url arb_sepolia --broadcast
///
///      Required env:
///        DEPLOYER_PRIVATE_KEY — deployer EOA. Holds both admin roles only for the
///                               length of this script; see the rotation step below.
///        SPONSOR_ADDRESS      — platform gas-sponsor wallet authorised to mint.
///        REGISTRY_ADMIN       — the address that ENDS UP holding `baseNode` and
///                               owning WoCoRegistrar. REQUIRED, no default.
///      Optional env:
///        PLATFORM_SIGNER_ADDRESS — signer for registerWithPermit (defaults to sponsor).
///        PARENT_NAME             — defaults to "woco.eth".
///        ALLOW_EOA_ADMIN         — testnet escape hatch; see the guard below.
///
/// WHY THIS DEPLOYS ITS OWN IMPLEMENTATION (WoCo-Event-App #440)
///
/// This script used to create the registry through Durin's canonical
/// `L2RegistryFactory`, which does `Clones.clone(registryImplementation)` against
/// an implementation address fixed at the factory's own construction — NameStone's.
/// Every WoCo addition to `L2Registry.sol` (`adminTransfer` and the #422 guards)
/// therefore existed only in this repo: the bytecode that would have run on chain
/// was pristine upstream Durin. The tests passed because they construct
/// `L2Registry` locally; nothing asserted that the DEPLOYED registry was built
/// from our source.
///
/// So the shape is kept (an EIP-1167 clone — every existing test and all the
/// storage-layout reasoning still hold) and only the implementation changes hands:
/// deploy `L2Registry` from this repo, clone THAT, initialise it. Direct
/// construction is not an option — the vendored constructor calls
/// `_disableInitializers()`.
///
/// The tripwire below is the point of the change, not the clone. It asserts, on
/// chain, at deploy time, that the registry about to be handed to the multisig
/// runs OUR code. Reinstating the factory call trips it three separate ways —
/// see `_assertRegistryRunsOurImplementation`.
///
/// WHY THE ROTATION IS IN THE SCRIPT AND NOT A RUNBOOK STEP
///
/// Registry admin is not a role flag — it is ownership of the `baseNode` ERC-721
/// (`L2Registry.owner()` returns `owner(baseNode)`, and `initialize` mints that
/// token to whoever is handed as `admin`). Whoever holds it can call
/// `addRegistrar(itself)` and then write records — `setAddr` included — for ANY
/// name in the registry, because `onlyOwnerOrRegistrar` scopes to registrar
/// MEMBERSHIP, not to a node. It can also `adminTransfer` any name to itself.
///
/// The registry is an EIP-1167 clone and cannot be upgraded, and the #422
/// decision to ship `adminTransfer` with NO TIMELOCK rests entirely on that
/// power sitting behind a multisig rather than one key. A deploy that ends with
/// the deployer EOA still holding `baseNode` therefore does not merely leave a
/// chore outstanding — it invalidates the premise the contract was reviewed on,
/// silently, and an earlier version of this script did exactly that.
///
/// ⚠️ BOTH TRANSFERS BELOW ARE SINGLE-STEP AND IRREVERSIBLE. `baseNode` sent to
/// an address that cannot transact is the whole registry lost with no recovery
/// path; `WoCoRegistrar` is plain `Ownable` (not `Ownable2Step`), so the same
/// mistake there permanently freezes `addSponsor` / `setReserved` /
/// `setPlatformSigner`. Verify `REGISTRY_ADMIN` on a block explorer before
/// broadcasting. The guard below rejects an EOA, which catches a typo'd or
/// forgotten value, but it CANNOT catch a well-formed address you do not control.
contract DeploySubEnsRegistry is Script {
    /// @notice The implementation NameStone's canonical `L2RegistryFactory`
    ///         clones (read from the factory on Arb Sepolia, 2026-09-02). Named
    ///         here so that a deploy which somehow ends up pointing at upstream
    ///         Durin fails by NAME rather than by a bytecode mismatch nobody
    ///         reads. Never a deploy target.
    address constant NAMESTONE_REGISTRY_IMPLEMENTATION = 0xdeB09eB3111cB75d538216e8B8fC30047d75fb34;

    /// @dev EIP-1167 minimal-proxy runtime: PREFIX ‖ 20-byte impl ‖ SUFFIX.
    bytes10 constant CLONE_PREFIX = 0x363d3d373d3d3d363d73;
    bytes15 constant CLONE_SUFFIX = 0x5af43d82803e903d91602b57fd5bf3;
    uint256 constant CLONE_RUNTIME_LENGTH = 45;

    /// @dev A node that is registered nowhere: not the zero node the
    ///      uninitialised implementation calls `baseNode`, and not a namehash
    ///      anything could mint. Used only to make WoCo's functions answer.
    bytes32 constant PROBE_NODE = keccak256("woco/deploy/tripwire-probe");

    /// @return registryAddress The initialised registry clone now owned by `REGISTRY_ADMIN`.
    /// @return registrarAddress The `WoCoRegistrar` wired into it.
    function run() external returns (address registryAddress, address registrarAddress) {
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPk);
        address sponsor = vm.envAddress("SPONSOR_ADDRESS");
        // Platform signer: address whose off-chain signature authorises registerWithPermit.
        // For buildathon: same address as sponsor. Post-buildathon: use a separate cold key.
        address platformSigner = vm.envOr("PLATFORM_SIGNER_ADDRESS", sponsor);
        string memory parentName = vm.envOr("PARENT_NAME", string("woco.eth"));

        // Required, not defaulted. Defaulting this to `deployer` is precisely the
        // outcome the header describes, and a console warning is not a safeguard
        // because forge script output scrolls past.
        address registryAdmin = vm.envAddress("REGISTRY_ADMIN");
        require(registryAdmin != address(0), "REGISTRY_ADMIN must not be the zero address");

        // A multisig is a contract; the deployer EOA is not. This is a coarse
        // check and deliberately so — it cannot verify signers or a threshold,
        // only that the deploy is not ending on a bare key. Testnet iteration
        // sets ALLOW_EOA_ADMIN=true and accepts that the #422 premise does not
        // hold there.
        bool allowEoaAdmin = vm.envOr("ALLOW_EOA_ADMIN", false);
        require(
            allowEoaAdmin || registryAdmin.code.length > 0,
            "REGISTRY_ADMIN has no code - expected a multisig; set ALLOW_EOA_ADMIN=true for testnet"
        );

        vm.startBroadcast(deployerPk);

        // 1. Create our registry from OUR implementation. The deployer takes
        //    admin only because steps 3-5 are `onlyOwner` and the multisig would
        //    otherwise have to sign each of them; step 6 hands it straight on.
        (address registryAddr, address implAddr) = _deployRegistryClone(parentName, deployer);
        registryAddress = registryAddr;

        // 1b. Prove it before anything else touches it. Placed here, and inside
        //     the broadcast, so that a failure aborts the script before forge
        //     submits ANY transaction — a wrong registry is never created.
        _assertRegistryRunsOurImplementation(registryAddr, implAddr);

        IL2Registry registry = IL2Registry(registryAddr);

        // 2. Deploy our minting-policy layer.
        WoCoRegistrar registrar = new WoCoRegistrar(registryAddr, deployer, platformSigner);
        registrarAddress = address(registrar);

        // 3. Grant the registrar record-setting + minting authority on the registry.
        registry.addRegistrar(address(registrar));

        // 4. Authorise the platform gas-sponsor wallet to mint.
        registrar.addSponsor(sponsor);

        // 5. Reserve platform / impersonation-risk labels.
        string[8] memory reservedLabels =
            ["woco", "admin", "support", "help", "www", "api", "app", "mail"];
        for (uint256 i; i < reservedLabels.length; ++i) {
            registrar.setReserved(reservedLabels[i], true);
        }

        // 6. Hand both admin roles over. LAST, because everything above needs them.
        //
        //    `transferFrom`, not `safeTransferFrom`: the safe variant calls
        //    `onERC721Received` on the recipient, which a Safe answers only
        //    through its fallback handler. A multisig deployed without one would
        //    revert here and strand the whole deploy mid-broadcast, with the
        //    registry live and the deployer still holding it — the exact state
        //    this step exists to prevent. The recipient is asserted to be a
        //    contract above and verified by the operator; a Safe can move any
        //    ERC-721 it holds regardless of how it received it.
        bytes32 baseNode = registry.baseNode();
        registry.transferFrom(deployer, registryAdmin, uint256(baseNode));
        registrar.transferOwnership(registryAdmin);

        vm.stopBroadcast();

        // 7. Prove the rotation landed. A deploy that reports success while the
        //    deployer still holds either role is the failure mode with no
        //    external signal — nothing else on chain looks different.
        require(registry.owner() == registryAdmin, "registry admin rotation did not land");
        require(registrar.owner() == registryAdmin, "registrar ownership rotation did not land");

        console.log("Parent name:      ", parentName);
        console.log("L2Registry impl:  ", implAddr);
        console.log("L2Registry (clone):", registryAddr);
        console.log("WoCoRegistrar:    ", address(registrar));
        console.log("Registry admin:   ", registryAdmin);
        console.log("Registrar owner:  ", registryAdmin);
        console.log("Deployer (no roles retained):", deployer);
        console.log("Authorised sponsor:", sponsor);
        console.log("Platform signer:  ", platformSigner);
    }

    /*//////////////////////////////////////////////////////////////
                          REGISTRY CREATION
    //////////////////////////////////////////////////////////////*/

    /// @notice Deploys our `L2Registry` implementation, clones it, initialises the clone.
    /// @dev `virtual` ONLY so that tests can substitute a deployment the tripwire
    ///      must reject (an upstream-shaped registry, a clone of something else).
    ///      Production always runs this body.
    /// @return registryAddr The initialised EIP-1167 clone.
    /// @return implAddr     The implementation it delegates to.
    function _deployRegistryClone(string memory parentName, address admin)
        internal
        virtual
        returns (address registryAddr, address implAddr)
    {
        implAddr = address(new L2Registry());
        registryAddr = Clones.clone(implAddr);
        IL2Registry(registryAddr).initialize(parentName, "WoCo Names", "", admin);
    }

    /*//////////////////////////////////////////////////////////////
                              THE TRIPWIRE
    //////////////////////////////////////////////////////////////*/

    /// @notice Refuses to continue unless the registry about to go live executes
    ///         the `L2Registry` source in THIS repo.
    ///
    /// @dev Three independent checks, because one is not enough to survive a
    ///      careless edit:
    ///
    ///        (1) SHAPE + TARGET — `registryAddr` is a canonical EIP-1167 clone
    ///            whose embedded implementation is exactly `implAddr`. Reinstating
    ///            `IL2RegistryFactory(...).deployRegistry(...)` while leaving the
    ///            `new L2Registry()` line in place fails here: the factory clones
    ///            an implementation of its own choosing. Deleting that line
    ///            instead does not compile.
    ///
    ///        (2) NOT UPSTREAM — the implementation is not NameStone's known
    ///            address. Redundant with (1) by construction; kept because it
    ///            names the failure the operator actually cares about.
    ///
    ///        (3) OUR CODE — the implementation ANSWERS as ours does. Each WoCo
    ///            addition is called on the implementation with arguments that
    ///            make our source revert with one of our own custom errors, and
    ///            the revert data is matched against that error's selector. A
    ///            contract without the function reverts with empty data; one
    ///            that merely mentions the selector somewhere in its bytecode
    ///            — a constant, an unrelated PUSH — does the same. This is the
    ///            check that survives address substitution: (1) and (2) both
    ///            compare addresses, and an address proves nothing about the
    ///            code behind it.
    ///
    ///            An earlier version scanned the runtime bytecode for the
    ///            selector's four bytes. That is a positive signal only that
    ///            those bytes occur SOMEWHERE — inside a PUSH32 constant as
    ///            readily as in the dispatcher — and it is defeated by any
    ///            contract that names the selector. Behaviour is not.
    ///
    ///            If a WoCo addition is ever removed from `L2Registry`, its
    ///            probe must be re-pointed at whatever replaces it; deleting the
    ///            probe is not the fix. If the error vocabulary changes, the
    ///            expected selectors change with it.
    function _assertRegistryRunsOurImplementation(address registryAddr, address implAddr) internal view {
        address embedded = _cloneImplementationOf(registryAddr);
        require(embedded == implAddr, "registry is not a clone of the implementation this script deployed");
        require(
            implAddr != NAMESTONE_REGISTRY_IMPLEMENTATION,
            "registry implementation is NameStone's - the factory path is back"
        );
        // #422. On the uninitialised implementation `owner()` is the zero
        // address, so `onlyOwner` refuses us before the body runs.
        require(
            _revertsWith(
                implAddr,
                abi.encodeCall(L2Registry.adminTransfer, (PROBE_NODE, address(1))),
                L2Resolver.Unauthorized.selector
            ),
            "registry implementation does not run WoCo's adminTransfer - it is not our bytecode"
        );
        // #464. PROBE_NODE is not the base node and is owned by nobody, so our
        // source refuses it as unregistered whichever guard it checks first.
        require(
            _revertsWith(
                implAddr,
                abi.encodeCall(L2Registry.release, (PROBE_NODE)),
                L2Registry.ReleaseUnregistered.selector
            ),
            "registry implementation does not run WoCo's release - it is not our bytecode"
        );
        // #464, the signature rail. Same unregistered probe node; `expiration`
        // is max so the expiry modifier passes and the body's own guard is what
        // answers. No signature is examined before that guard, so the validator
        // (absent on a fork, real on chain) is never reached.
        require(
            _revertsWith(
                implAddr,
                abi.encodeCall(
                    L2Registry.releaseWithSignature, (PROBE_NODE, type(uint256).max, address(1), bytes(""))
                ),
                L2Registry.ReleaseUnregistered.selector
            ),
            "registry implementation does not run WoCo's releaseWithSignature - it is not our bytecode"
        );
    }

    /// @dev Extracts the implementation address from an EIP-1167 minimal proxy,
    ///      reverting if `clone` is not one. The prefix/suffix are checked as
    ///      well as the length, so a 45-byte contract that merely happens to be
    ///      the right size cannot pass.
    function _cloneImplementationOf(address clone) internal view returns (address impl) {
        bytes memory code = clone.code;
        require(code.length == CLONE_RUNTIME_LENGTH, "registry is not an EIP-1167 clone");

        bytes10 prefix;
        bytes15 suffix;
        assembly {
            // `code` is length-prefixed; its bytes start at code+0x20.
            prefix := mload(add(code, 0x20))
            impl := shr(96, mload(add(code, 0x2a))) // 0x20 + 10
            suffix := mload(add(code, 0x3e)) // 0x20 + 30
        }
        require(prefix == CLONE_PREFIX && suffix == CLONE_SUFFIX, "registry is not an EIP-1167 clone");
    }

    /// @dev True if a STATICCALL of `callData` on `target` reverts with data
    ///      whose first four bytes are `expectedError`. A static call so that
    ///      nothing here can be a transaction, and so that a probe which
    ///      somehow got past a guard would fail on its first state write
    ///      rather than succeed.
    function _revertsWith(address target, bytes memory callData, bytes4 expectedError)
        internal
        view
        returns (bool)
    {
        (bool ok, bytes memory ret) = target.staticcall(callData);
        if (ok) return false;
        // Truncating to the first four bytes IS the comparison: a custom
        // error's selector, with whatever arguments follow it ignored. A
        // shorter or empty revert zero-pads and so never matches.
        // forge-lint: disable-next-line(unsafe-typecast)
        return bytes4(ret) == expectedError;
    }
}
