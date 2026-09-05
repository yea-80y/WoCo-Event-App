// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {WoCoRegistrar} from "../src/WoCoRegistrar.sol";
import {IL2Registry} from "../src/durin/interfaces/IL2Registry.sol";

/// @title RedeployRegistrar
/// @notice Deploys a NEW WoCoRegistrar against an EXISTING L2Registry, seeds the
///         sponsor and reserved names, hands ownership to `REGISTRAR_ADMIN`, and
///         wires it into the registry if — and only if — the deployer is still
///         the registry admin.
///         Use this when the registrar logic changes but the registry is live.
///
/// @dev Run against Arbitrum Sepolia:
///        forge script script/RedeployRegistrar.s.sol --rpc-url arb_sepolia --broadcast --verify
///
///      Required env:
///        DEPLOYER_PRIVATE_KEY  — deployer EOA. Owns the new registrar only for
///                                the length of this script.
///        SPONSOR_ADDRESS       — platform gas-sponsor wallet authorised to mint.
///        L2_REGISTRY_ADDRESS   — existing L2Registry to wire the new registrar into.
///        REGISTRAR_ADMIN       — the address that ENDS UP owning the registrar.
///                                REQUIRED, no default.
///      Optional:
///        PLATFORM_SIGNER_ADDRESS — defaults to SPONSOR_ADDRESS.
///        ALLOW_EOA_ADMIN         — testnet escape hatch; see the guard below.
///        EXPECT_MANUAL_WIRING    — acknowledge that the registry admin must call
///                                  `addRegistrar` separately; see step 4.
///
/// WHY THIS CHANGED (WoCo-Event-App #440, WoCo-Contracts#1)
///
/// This script left the new registrar owned by the deployer EOA, permanently.
/// `DeploySubEnsRegistry` was fixed to rotate both admin roles onto a multisig;
/// this one was not, so every redeploy quietly re-created the state that fix
/// exists to prevent — and a redeploy is the routine operation, not the deploy.
/// Registrar ownership is `addSponsor` / `setReserved` / `setPlatformSigner`:
/// whoever holds it decides who may mint and under what name policy.
///
/// The second, quieter half of the same problem: this script assumed the
/// deployer was the registry admin, because it used to be. After the rotation it
/// is the multisig, so `addRegistrar` from the deployer key now REVERTS — and a
/// script that reverts halfway leaves a registrar deployed, owned by nobody
/// useful, and not wired in. So the wiring is conditional, and the summary at the
/// end states plainly whether the registrar is live or is waiting on a multisig
/// transaction, rather than printing success either way.
///
/// ⚠️ `transferOwnership` is SINGLE-STEP and irreversible — `WoCoRegistrar` is
/// plain `Ownable`, not `Ownable2Step`. An address you do not control freezes
/// the registrar's policy for good. Verify `REGISTRAR_ADMIN` on a block explorer
/// before broadcasting.
contract RedeployRegistrar is Script {
    /// @notice Everything this script reads from its environment, in one place.
    struct Config {
        uint256 deployerPk;
        address sponsor;
        address registryAddress;
        address platformSigner;
        address registrarAdmin;
        bool allowEoaAdmin;
        bool expectManualWiring;
    }

    /// @dev `virtual` ONLY so that tests can vary the inputs. They cannot do it
    ///      through the environment: `vm.setEnv` writes the whole forge
    ///      process's environment and Foundry runs test functions in parallel,
    ///      so per-test environments race, visibly and intermittently. The
    ///      guards themselves stay in `run()` and are never overridden.
    ///      Production always runs this body.
    function _config() internal view virtual returns (Config memory c) {
        c.deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        c.sponsor = vm.envAddress("SPONSOR_ADDRESS");
        c.registryAddress = vm.envAddress("L2_REGISTRY_ADDRESS");
        c.platformSigner = vm.envOr("PLATFORM_SIGNER_ADDRESS", c.sponsor);
        // Required, not defaulted to the deployer. Defaulting it is the whole bug.
        c.registrarAdmin = vm.envAddress("REGISTRAR_ADMIN");
        c.allowEoaAdmin = vm.envOr("ALLOW_EOA_ADMIN", false);
        c.expectManualWiring = vm.envOr("EXPECT_MANUAL_WIRING", false);
    }

    function run() external returns (address registrarAddress) {
        Config memory c = _config();
        uint256 deployerPk = c.deployerPk;
        address deployer = vm.addr(deployerPk);
        address sponsor = c.sponsor;
        address registryAddress = c.registryAddress;
        address platformSigner = c.platformSigner;
        address registrarAdmin = c.registrarAdmin;

        require(registrarAdmin != address(0), "REGISTRAR_ADMIN must not be the zero address");

        // A multisig is a contract; a bare key is not. Coarse and deliberately
        // so — it cannot check signers or a threshold, only that the redeploy is
        // not ending on one key. Testnet sets ALLOW_EOA_ADMIN=true.
        require(
            c.allowEoaAdmin || registrarAdmin.code.length > 0,
            "REGISTRAR_ADMIN has no code - expected a multisig; set ALLOW_EOA_ADMIN=true for testnet"
        );

        IL2Registry registry = IL2Registry(registryAddress);
        // Read before broadcasting: whether we can wire the registrar in decides
        // what this script is allowed to claim at the end.
        bool deployerIsRegistryAdmin = registry.owner() == deployer;

        vm.startBroadcast(deployerPk);

        // 1. Deploy the new registrar. The deployer owns it only for steps 2-3.
        WoCoRegistrar registrar = new WoCoRegistrar(registryAddress, deployer, platformSigner);
        registrarAddress = address(registrar);

        // 2. Authorise the platform gas-sponsor wallet to call register() directly.
        registrar.addSponsor(sponsor);

        // 3. Reserve platform / impersonation-risk labels.
        string[8] memory reservedLabels =
            ["woco", "admin", "support", "help", "www", "api", "app", "mail"];
        for (uint256 i; i < reservedLabels.length; ++i) {
            registrar.setReserved(reservedLabels[i], true);
        }

        // 4. Wire into the registry — only the registry admin can. On a correctly
        //    deployed registry that is the multisig, not this key, so the call is
        //    skipped rather than attempted-and-reverted, and the requirement is
        //    surfaced as calldata to execute.
        if (deployerIsRegistryAdmin) {
            registry.addRegistrar(registrarAddress);
        }

        // 5. Hand the registrar over. LAST, because steps 2-3 are `onlyOwner`.
        registrar.transferOwnership(registrarAdmin);

        vm.stopBroadcast();

        // 6. Prove it landed. A redeploy that reports success while the deployer
        //    still owns the registrar has no other external signal.
        require(registrar.owner() == registrarAdmin, "registrar ownership rotation did not land");

        // 7. A registrar that is not in `registrars` cannot mint anything. Fail
        //    unless the operator has said, in the environment, that they know a
        //    multisig transaction is outstanding — a console warning is not a
        //    safeguard, because forge script output scrolls past.
        require(
            registry.registrars(registrarAddress) || c.expectManualWiring,
            "registrar is NOT wired into the registry: the registry admin must call addRegistrar; set EXPECT_MANUAL_WIRING=true to acknowledge"
        );

        console.log("L2Registry (existing):", registryAddress);
        console.log("WoCoRegistrar (new):  ", registrarAddress);
        console.log("Registrar owner:      ", registrarAdmin);
        console.log("Authorised sponsor:   ", sponsor);
        console.log("Platform signer:      ", platformSigner);
        console.log("Domain separator:     ");
        console.logBytes32(registrar.DOMAIN_SEPARATOR());

        if (deployerIsRegistryAdmin) {
            console.log("Wired into the registry: YES");
        } else {
            console.log("Wired into the registry: NO - registry admin is", registry.owner());
            console.log("ACTION REQUIRED. That address must send, to the registry:");
            console.logBytes(abi.encodeCall(IL2Registry.addRegistrar, (registrarAddress)));
            console.log("And, once the new registrar is live, retire the old one with:");
            console.log("  removeRegistrar(<previous registrar address>)");
        }
    }
}
