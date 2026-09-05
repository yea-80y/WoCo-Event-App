// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {WoCoRegistrar} from "../src/WoCoRegistrar.sol";
import {L2Registry} from "../src/durin/L2Registry.sol";
import {L2Resolver} from "../src/durin/L2Resolver.sol";
import {UniversalSigValidatorFixture as Validator} from "./fixtures/UniversalSigValidatorFixture.sol";

/**
 * Tests for `L2Resolver.setTextWithSignature` — a holder-signed text record that
 * someone else (the platform) may submit and pay for. Added while reviewing
 * WoCo-Contracts PR #8, which found the preimage ambiguous. The promise this
 * file freezes, because the registry is an unpatchable clone:
 *
 *   "A signature over a text record authorises THAT key with THAT value, and
 *    nothing else. Holding it does not let anyone write a different key."
 *
 * `setTextWithSignature` is the only one of the four signed setters that puts
 * two dynamic fields in the preimage. Under `abi.encodePacked` the boundary
 * between them vanished, so one signature covered a whole family of
 * (key, value) pairs formed by sliding the split. `abi.encode` length-prefixes
 * both strings and pins the split.
 *
 * Signature checks run against the REAL ERC-6492 validator bytecode (etched
 * from Arbitrum Sepolia, see the fixture), not a stand-in.
 */
contract L2ResolverTextSignatureTest is Test {
    using MessageHashUtils for bytes32;

    L2Registry registry;
    WoCoRegistrar registrar;

    address admin = makeAddr("admin");
    address sponsor = makeAddr("sponsor");
    /// The platform's hot wallet in production: it pays, it never authorises.
    address relayer = makeAddr("relayer");

    uint256 constant HOLDER_KEY = 0xA11CE;
    uint256 constant STRANGER_KEY = 0xB0B;
    address holder = vm.addr(HOLDER_KEY);
    address stranger = vm.addr(STRANGER_KEY);

    uint256 constant NOW = 1_800_000_000;
    uint256 constant EXPIRY = NOW + 15 minutes;

    bytes constant SWARM_HASH =
        hex"e40101fa011b20d1de9994b4d039f6548d191eb26786769f580809256b4685ef316805265ea162";

    event TextChanged(bytes32 indexed node, string indexed indexedKey, string key, string value);

    function setUp() public {
        vm.etch(Validator.ADDR, Validator.CODE);

        registry = L2Registry(Clones.clone(address(new L2Registry())));
        registry.initialize("woco.eth", "WoCo Names", "", admin);
        registrar = new WoCoRegistrar(address(registry), admin, makeAddr("signer"));

        vm.startPrank(admin);
        registry.addRegistrar(address(registrar));
        registrar.addSponsor(sponsor);
        vm.stopPrank();

        vm.warp(NOW);
    }

    /// Registers with NO text records, so every `text()` read below starts empty.
    function _register(string memory label, address owner_) internal returns (bytes32 node) {
        vm.prank(sponsor);
        registrar.register(label, owner_, SWARM_HASH, new string[](0), new string[](0));
        node = registry.makeNode(registry.baseNode(), label);
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    /// The preimage the contract builds today. Reads the node's nonce AT SIGNING
    /// TIME, exactly as a client must (#10) — a signature is made against the
    /// counter value standing when it is made, and is dead once that value moves.
    function _textDigest(bytes32 node, string memory key, string memory value, uint256 expiration)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                address(registry), block.chainid, node, key, value, registry.nonces(node), expiration
            )
        ).toEthSignedMessageHash();
    }

    /// The preimage the contract built BEFORE this fix.
    function _oldPackedTextDigest(bytes32 node, string memory key, string memory value, uint256 expiration)
        internal
        view
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(address(registry), node, key, value, expiration)).toEthSignedMessageHash();
    }

    /*//////////////////////////////////////////////////////////////
                              THE RAIL WORKS
    //////////////////////////////////////////////////////////////*/

    function test_SetTextWithSignature_AStrangerMaySubmitWhatTheHolderSigned() public {
        bytes32 node = _register("venue", holder);
        bytes memory sig = _sign(HOLDER_KEY, _textDigest(node, "url", "https://a", EXPIRY));

        vm.expectEmit(true, true, true, true, address(registry));
        emit TextChanged(node, "url", "url", "https://a");

        vm.prank(relayer);
        registry.setTextWithSignature(node, "url", "https://a", EXPIRY, holder, sig);

        assertEq(registry.text(node, "url"), "https://a");
    }

    /*//////////////////////////////////////////////////////////////
        THE FINDING: THE KEY/VALUE BOUNDARY MUST BE PART OF THE SIGNATURE
    //////////////////////////////////////////////////////////////*/

    /// THE FINDING, exactly as it would have been exploited. The signature is
    /// the one a holder actually held against the pre-fix contract: over the
    /// PACKED preimage of the honest pair ("url", "https://a"). Sliding the
    /// key/value split leaves those packed bytes untouched — asserted below —
    /// so the old contract would have accepted this call and written a key the
    /// holder never signed. Signing the packed preimage is what makes this test
    /// bite: sign the new preimage instead and the old contract rejects it for
    /// an unrelated reason, and the test stops detecting the defect.
    function test_SetTextWithSignature_APreFixSignatureCannotBeSlidToAnotherKey() public {
        bytes32 node = _register("venue", holder);
        bytes memory sig = _sign(HOLDER_KEY, _oldPackedTextDigest(node, "url", "https://a", EXPIRY));

        assertEq(
            _oldPackedTextDigest(node, "ur", "lhttps://a", EXPIRY),
            _oldPackedTextDigest(node, "url", "https://a", EXPIRY),
            "precondition: the packed preimage cannot tell the two splits apart"
        );
        assertEq(
            _oldPackedTextDigest(node, "u", "rlhttps://a", EXPIRY),
            _oldPackedTextDigest(node, "url", "https://a", EXPIRY),
            "precondition: nor this one"
        );

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(L2Resolver.Unauthorized.selector, node));
        registry.setTextWithSignature(node, "ur", "lhttps://a", EXPIRY, holder, sig);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(L2Resolver.Unauthorized.selector, node));
        registry.setTextWithSignature(node, "u", "rlhttps://a", EXPIRY, holder, sig);

        assertEq(registry.text(node, "ur"), "", "no record written under the shifted key");
        assertEq(registry.text(node, "u"), "", "nor under the doubly-shifted key");
        assertEq(registry.text(node, "url"), "", "and the signed key is untouched too");
    }

    /// The empty-key end of the same family: ("", "urlhttps://a") packs to the
    /// same bytes as ("url", "https://a") — the widest possible slide.
    function test_SetTextWithSignature_APreFixSignatureCannotBeSlidToTheEmptyKey() public {
        bytes32 node = _register("venue", holder);
        bytes memory sig = _sign(HOLDER_KEY, _oldPackedTextDigest(node, "url", "https://a", EXPIRY));

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(L2Resolver.Unauthorized.selector, node));
        registry.setTextWithSignature(node, "", "urlhttps://a", EXPIRY, holder, sig);

        assertEq(registry.text(node, ""), "");
    }

    /// The standing property, independent of what the old encoding was: a
    /// signature authorises the key it names and no other. (Unlike the two
    /// tests above this one also passes on the broken contract — the broken
    /// contract refuses this signature for its own reasons — so it documents
    /// the rule rather than guarding the fix.)
    function test_SetTextWithSignature_ASignatureDoesNotAuthoriseAnotherKey() public {
        bytes32 node = _register("venue", holder);
        bytes memory sig = _sign(HOLDER_KEY, _textDigest(node, "url", "https://a", EXPIRY));

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(L2Resolver.Unauthorized.selector, node));
        registry.setTextWithSignature(node, "ur", "lhttps://a", EXPIRY, holder, sig);

        assertEq(registry.text(node, "ur"), "");
    }

    /// Proves the contract's encoding actually moved: a signature over the OLD
    /// packed preimage, correct in every other respect, is now refused.
    function test_SetTextWithSignature_TheOldPackedEncodingIsRefused() public {
        bytes32 node = _register("venue", holder);
        bytes memory sig = _sign(HOLDER_KEY, _oldPackedTextDigest(node, "url", "https://a", EXPIRY));

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(L2Resolver.Unauthorized.selector, node));
        registry.setTextWithSignature(node, "url", "https://a", EXPIRY, holder, sig);

        assertEq(registry.text(node, "url"), "");
    }

    /// The digest a client must rebuild. Frozen with the registry: a different
    /// formula here is a different contract. Spelled literally — chain id and
    /// the node's nonce (0 for a freshly registered name) included, per #10.
    function test_SetTextWithSignature_DigestFormulaIsPinned() public {
        bytes32 node = _register("venue", holder);
        string memory key = "url";
        string memory value = "https://a";
        bytes32 expected = keccak256(
            abi.encode(address(registry), block.chainid, node, key, value, uint256(0), EXPIRY)
        ).toEthSignedMessageHash();

        bytes memory sig = _sign(HOLDER_KEY, expected);
        vm.prank(relayer);
        registry.setTextWithSignature(node, key, value, EXPIRY, holder, sig);
        assertEq(registry.text(node, key), value);
    }

    /*//////////////////////////////////////////////////////////////
                 ONLY WHO COULD HAVE WRITTEN IT THEMSELVES
    //////////////////////////////////////////////////////////////*/

    function test_SetTextWithSignature_RevertForAStrangerSigner() public {
        bytes32 node = _register("venue", holder);
        // Well-formed and genuinely the stranger's — just not the holder's.
        bytes memory sig = _sign(STRANGER_KEY, _textDigest(node, "url", "https://evil", EXPIRY));

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(L2Resolver.Unauthorized.selector, node));
        registry.setTextWithSignature(node, "url", "https://evil", EXPIRY, stranger, sig);

        assertEq(registry.text(node, "url"), "");
    }

    function test_SetTextWithSignature_RevertWhenTheSignatureIsNotTheSigners() public {
        bytes32 node = _register("venue", holder);
        // Names the holder, signed by another.
        bytes memory sig = _sign(STRANGER_KEY, _textDigest(node, "url", "https://evil", EXPIRY));

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(L2Resolver.Unauthorized.selector, node));
        registry.setTextWithSignature(node, "url", "https://evil", EXPIRY, holder, sig);

        assertEq(registry.text(node, "url"), "");
    }

    /*//////////////////////////////////////////////////////////////
                                 DEADLINE
    //////////////////////////////////////////////////////////////*/

    function test_SetTextWithSignature_RevertWhenExpired() public {
        bytes32 node = _register("venue", holder);
        bytes memory sig = _sign(HOLDER_KEY, _textDigest(node, "url", "https://a", EXPIRY));
        vm.warp(EXPIRY + 1);

        vm.prank(relayer);
        vm.expectRevert(L2Resolver.SignatureExpired.selector);
        registry.setTextWithSignature(node, "url", "https://a", EXPIRY, holder, sig);

        assertEq(registry.text(node, "url"), "");
    }

    function test_SetTextWithSignature_ValidUntilTheLastSecond() public {
        bytes32 node = _register("venue", holder);
        bytes memory sig = _sign(HOLDER_KEY, _textDigest(node, "url", "https://a", EXPIRY));
        vm.warp(EXPIRY);

        vm.prank(relayer);
        registry.setTextWithSignature(node, "url", "https://a", EXPIRY, holder, sig);

        assertEq(registry.text(node, "url"), "https://a");
    }
}
