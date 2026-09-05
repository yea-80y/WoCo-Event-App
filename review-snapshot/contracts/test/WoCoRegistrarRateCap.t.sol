// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {WoCoRegistrar} from "../src/WoCoRegistrar.sol";
import {L2Registry} from "../src/durin/L2Registry.sol";

/**
 * Tests for the per-recipient mint rate cap in `WoCoRegistrar` — the
 * REPLACEABLE half of WoCo-Event-App #464.
 *
 * The property that matters most is the one that is easy to get backwards:
 * the cap is keyed on the address that RECEIVES the name, not on whoever
 * sends the transaction. Every mint is submitted by someone other than the
 * organiser — the sponsor key, or a Kernel/paymaster — so a sender-keyed cap
 * would throttle the platform, not the account.
 */
contract WoCoRegistrarRateCapTest is Test {
    L2Registry registry;
    WoCoRegistrar registrar;

    address admin = makeAddr("admin");
    address sponsor = makeAddr("sponsor");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    uint256 platformSignerPk = 0xDEAD;
    address platformSigner;

    uint32 constant DEFAULT_MAX = 30;
    uint64 constant DEFAULT_WINDOW = 30 days;
    uint256 constant T0 = 1_800_000_000;

    bytes constant SWARM_HASH =
        hex"e40101fa011b20d1de9994b4d039f6548d191eb26786769f580809256b4685ef316805265ea162";

    event MintRateCapSet(uint32 maxMintsPerWindow, uint64 mintWindowSeconds);

    function setUp() public {
        platformSigner = vm.addr(platformSignerPk);

        registry = L2Registry(Clones.clone(address(new L2Registry())));
        registry.initialize("woco.eth", "WoCo Names", "", admin);

        registrar = new WoCoRegistrar(address(registry), admin, platformSigner);

        vm.startPrank(admin);
        registry.addRegistrar(address(registrar));
        registrar.addSponsor(sponsor);
        vm.stopPrank();

        vm.warp(T0);
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _label(uint256 i) internal pure returns (string memory) {
        return string.concat("name-", vm.toString(i));
    }

    function _mint(string memory label, address to) internal returns (bytes32) {
        string[] memory keys = new string[](0);
        string[] memory vals = new string[](0);
        vm.prank(sponsor);
        return registrar.register(label, to, SWARM_HASH, keys, vals);
    }

    function _mintN(address to, uint256 n, uint256 seed) internal {
        for (uint256 i; i < n; ++i) {
            _mint(_label(seed + i), to);
        }
    }

    function _signPermit(string memory label, address owner_, uint256 expiry) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(registrar.PERMIT_TYPEHASH(), keccak256(bytes(label)), owner_, expiry));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", registrar.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(platformSignerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _mintWithPermit(string memory label, address to) internal returns (bytes32) {
        (uint256 expiry, bytes memory sig) = _permit(label, to);
        string[] memory keys = new string[](0);
        string[] memory vals = new string[](0);
        vm.prank(to); // the organiser submits their own permit
        return registrar.registerWithPermit(label, to, SWARM_HASH, keys, vals, expiry, sig);
    }

    /// @dev Builds the permit up front. `vm.expectRevert` binds to the NEXT
    ///      external call, and `PERMIT_TTL()` / `DOMAIN_SEPARATOR()` are
    ///      external calls — so a test expecting the MINT to revert must have
    ///      the permit in hand before the cheatcode.
    function _permit(string memory label, address to) internal view returns (uint256 expiry, bytes memory sig) {
        expiry = block.timestamp + registrar.PERMIT_TTL();
        sig = _signPermit(label, to, expiry);
    }

    /*//////////////////////////////////////////////////////////////
                              THE CAP BINDS
    //////////////////////////////////////////////////////////////*/

    function test_Defaults() public view {
        assertEq(registrar.maxMintsPerWindow(), DEFAULT_MAX);
        assertEq(registrar.mintWindowSeconds(), DEFAULT_WINDOW);
    }

    function test_Cap_AllowsExactlyTheCapWithinAWindow() public {
        _mintN(alice, DEFAULT_MAX, 0);

        (uint64 start, uint32 count) = registrar.mintWindow(alice);
        assertEq(count, DEFAULT_MAX);
        assertEq(start, uint64(T0), "window anchored at the first mint");

        vm.expectRevert(
            abi.encodeWithSelector(WoCoRegistrar.MintRateCapExceeded.selector, alice, uint64(T0) + DEFAULT_WINDOW)
        );
        _mint("one-too-many", alice);

        // And the refused label was not consumed — it is still free.
        assertTrue(registrar.available("one-too-many"));
    }

    /// The permit path is the one an organiser's own wallet uses. It must be
    /// capped identically — a cap on the sponsor path alone would be a cap on
    /// email-only organisers and nobody else.
    function test_Cap_BindsThePermitPathToo() public {
        _mintN(alice, DEFAULT_MAX - 1, 0);
        _mintWithPermit("via-permit", alice); // the 30th

        (uint256 expiry, bytes memory sig) = _permit("via-permit-two", alice);
        string[] memory keys = new string[](0);
        string[] memory vals = new string[](0);
        vm.expectRevert(
            abi.encodeWithSelector(WoCoRegistrar.MintRateCapExceeded.selector, alice, uint64(T0) + DEFAULT_WINDOW)
        );
        vm.prank(alice);
        registrar.registerWithPermit("via-permit-two", alice, SWARM_HASH, keys, vals, expiry, sig);
    }

    /// Both paths share ONE window per recipient: a mint through either counts.
    function test_Cap_BothPathsShareOneWindow() public {
        _mintN(alice, 15, 0);
        for (uint256 i; i < 15; ++i) {
            _mintWithPermit(_label(100 + i), alice);
        }
        (, uint32 count) = registrar.mintWindow(alice);
        assertEq(count, 30, "paths are counted separately");

        vm.expectRevert();
        _mint("thirty-first", alice);
    }

    /*//////////////////////////////////////////////////////////////
                    KEYED ON THE RECIPIENT, NOT THE SENDER
    //////////////////////////////////////////////////////////////*/

    /// The sponsor mints for many organisers from one key. Filling one
    /// organiser's window must leave every other organiser's untouched —
    /// otherwise the cap is on the platform.
    function test_Cap_IsPerRecipientNotPerSender() public {
        _mintN(alice, DEFAULT_MAX, 0);

        // Same sender (the sponsor), different recipient: unaffected.
        _mint("bobs-first", bob);
        (, uint32 bobCount) = registrar.mintWindow(bob);
        assertEq(bobCount, 1);

        // The sponsor itself never accumulates a window.
        (uint64 sponsorStart, uint32 sponsorCount) = registrar.mintWindow(sponsor);
        assertEq(sponsorStart, 0);
        assertEq(sponsorCount, 0);
    }

    /// The mirror image: a recipient cannot dodge their cap by having a
    /// different sender submit — the permit path submitted by the organiser
    /// and the sponsor path submitted by the platform land on the same window.
    function test_Cap_CannotBeDodgedByChangingTheSender() public {
        _mintN(alice, DEFAULT_MAX, 0); // all via the sponsor

        (uint256 expiry, bytes memory sig) = _permit("from-my-own-wallet", alice);
        string[] memory keys = new string[](0);
        string[] memory vals = new string[](0);
        vm.expectRevert(
            abi.encodeWithSelector(WoCoRegistrar.MintRateCapExceeded.selector, alice, uint64(T0) + DEFAULT_WINDOW)
        );
        vm.prank(alice); // submitted by alice herself
        registrar.registerWithPermit("from-my-own-wallet", alice, SWARM_HASH, keys, vals, expiry, sig);
    }

    /*//////////////////////////////////////////////////////////////
                             THE WINDOW ROLLS
    //////////////////////////////////////////////////////////////*/

    function test_Cap_ResetsWhenTheWindowElapses() public {
        _mintN(alice, DEFAULT_MAX, 0);

        vm.warp(T0 + DEFAULT_WINDOW - 1);
        vm.expectRevert();
        _mint("still-inside", alice);

        vm.warp(T0 + DEFAULT_WINDOW);
        _mint("fresh-window", alice);

        (uint64 start, uint32 count) = registrar.mintWindow(alice);
        assertEq(start, uint64(T0 + DEFAULT_WINDOW), "new window not anchored at this mint");
        assertEq(count, 1, "count not reset");
    }

    /// A window is anchored at the recipient's FIRST mint in it, not at a
    /// global epoch — so an organiser who mints once and comes back in six
    /// weeks starts a fresh window rather than inheriting a stale one.
    function test_Cap_WindowIsAnchoredAtTheFirstMintInIt() public {
        _mint("first", alice);
        vm.warp(T0 + 45 days);
        _mint("second", alice);

        (uint64 start, uint32 count) = registrar.mintWindow(alice);
        assertEq(start, uint64(T0 + 45 days));
        assertEq(count, 1);
    }

    /*//////////////////////////////////////////////////////////////
                              mintAllowance
    //////////////////////////////////////////////////////////////*/

    function test_Allowance_ReportsRemainingAndReset() public {
        (uint32 remaining, uint64 resetsAt) = registrar.mintAllowance(alice);
        assertEq(remaining, DEFAULT_MAX, "fresh recipient has the full cap");
        assertEq(resetsAt, uint64(T0) + DEFAULT_WINDOW);

        _mintN(alice, 12, 0);
        (remaining, resetsAt) = registrar.mintAllowance(alice);
        assertEq(remaining, DEFAULT_MAX - 12);
        assertEq(resetsAt, uint64(T0) + DEFAULT_WINDOW);

        _mintN(alice, DEFAULT_MAX - 12, 100);
        (remaining,) = registrar.mintAllowance(alice);
        assertEq(remaining, 0, "full window should report zero");

        vm.warp(T0 + DEFAULT_WINDOW);
        (remaining, resetsAt) = registrar.mintAllowance(alice);
        assertEq(remaining, DEFAULT_MAX, "elapsed window should report the full cap");
        assertEq(resetsAt, uint64(T0 + DEFAULT_WINDOW) + DEFAULT_WINDOW);
    }

    /// `available()` is about the label; it must not start answering for the
    /// recipient. A capped organiser looking at a free label sees it as free
    /// and learns about their allowance from `mintAllowance`.
    function test_Allowance_DoesNotLeakIntoAvailable() public {
        _mintN(alice, DEFAULT_MAX, 0);
        assertTrue(registrar.available("still-a-free-label"));
    }

    /*//////////////////////////////////////////////////////////////
                                 TUNING
    //////////////////////////////////////////////////////////////*/

    function test_Tune_OwnerCanRetune() public {
        vm.expectEmit(false, false, false, true, address(registrar));
        emit MintRateCapSet(3, 1 days);
        vm.prank(admin);
        registrar.setMintRateCap(3, 1 days);

        _mintN(alice, 3, 0);
        vm.expectRevert(abi.encodeWithSelector(WoCoRegistrar.MintRateCapExceeded.selector, alice, uint64(T0 + 1 days)));
        _mint("fourth", alice);

        vm.warp(T0 + 1 days);
        _mint("fourth", alice);
    }

    /// Lowering the cap below a recipient's current count must not underflow
    /// or grant anything: they are simply over the line until their window
    /// rolls.
    function test_Tune_LoweringBelowCurrentCountJustBlocks() public {
        _mintN(alice, 10, 0);
        vm.prank(admin);
        registrar.setMintRateCap(5, DEFAULT_WINDOW);

        (uint32 remaining,) = registrar.mintAllowance(alice);
        assertEq(remaining, 0);
        vm.expectRevert();
        _mint("over-the-new-line", alice);
    }

    function test_Tune_OnlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        registrar.setMintRateCap(1, 1);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, sponsor));
        vm.prank(sponsor);
        registrar.setMintRateCap(1, 1);
    }

    /// Zero is a pause or a no-op dressed as a number. Refused so a fat-fingered
    /// tuning cannot silently disable the cap or all minting.
    function test_Tune_RefusesZero() public {
        vm.startPrank(admin);
        vm.expectRevert(WoCoRegistrar.InvalidMintRateCap.selector);
        registrar.setMintRateCap(0, DEFAULT_WINDOW);
        vm.expectRevert(WoCoRegistrar.InvalidMintRateCap.selector);
        registrar.setMintRateCap(DEFAULT_MAX, 0);
        vm.stopPrank();

        assertEq(registrar.maxMintsPerWindow(), DEFAULT_MAX, "cap changed despite the revert");
        assertEq(registrar.mintWindowSeconds(), DEFAULT_WINDOW);
    }

    /*//////////////////////////////////////////////////////////////
                     INTERACTION WITH release (#464)
    //////////////////////////////////////////////////////////////*/

    /// Releasing does not refund the allowance. A mint is a mint; a churn loop
    /// of release + re-mint is exactly the pattern this exists to bound.
    function test_Cap_ReleaseDoesNotRefundTheAllowance() public {
        for (uint256 i; i < DEFAULT_MAX; ++i) {
            bytes32 node = _mint("churn", alice);
            vm.prank(alice);
            registry.release(node);
        }

        vm.expectRevert();
        _mint("churn", alice);
    }
}
