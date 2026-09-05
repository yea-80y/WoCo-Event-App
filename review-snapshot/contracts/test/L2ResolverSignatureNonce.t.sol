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
 * Tests for the per-name nonce and the chain id in the four holder-signed
 * record setters (WoCo-Contracts #10). The promise this file freezes, because
 * the registry is an unpatchable EIP-1167 clone:
 *
 *   "A signature authorises ONE write, on THIS chain. Once it has landed it is
 *    dead — the calldata that carried it is public, and resubmitting it does
 *    nothing."
 *
 * Before this, a signature stayed live until its `expiration`: anyone reading
 * the chain could replay it and re-apply a record the holder had since changed,
 * and a signature made on testnet was submittable against the same clone address
 * on mainnet. The counter is per NODE and never resets, so a previous holder's
 * unspent signature cannot line up against a name after it changes hands — the
 * across-owners test at the bottom is what holds that.
 *
 * Signature checks run against the REAL ERC-6492 validator bytecode (etched from
 * Arbitrum Sepolia, see the fixture), not a stand-in.
 */
contract L2ResolverSignatureNonceTest is Test {
    using MessageHashUtils for bytes32;

    L2Registry registry;
    WoCoRegistrar registrar;

    address admin = makeAddr("admin");
    address sponsor = makeAddr("sponsor");
    /// The platform's hot wallet in production: it pays, it never authorises.
    address relayer = makeAddr("relayer");

    uint256 constant HOLDER_KEY = 0xA11CE;
    uint256 constant SECOND_HOLDER_KEY = 0xB0B;
    address holder = vm.addr(HOLDER_KEY);
    address secondHolder = vm.addr(SECOND_HOLDER_KEY);

    uint256 constant NOW = 1_800_000_000;
    uint256 constant EXPIRY = NOW + 15 minutes;

    /// A chain the signature was NOT made for. Arbitrum One, so the number is a
    /// real one the platform could plausibly be deployed to next.
    uint256 constant OTHER_CHAIN_ID = 42161;

    /// Coin type BTC — deliberately one `_register` does not write, so "empty"
    /// in an assertion below means the call really wrote nothing.
    uint256 constant COIN_BTC = 0;
    /// The one coin type `setAddr` treats specially: it emits the legacy
    /// `AddrChanged` alongside `AddressChanged`.
    uint256 constant COIN_ETH = 60;
    uint256 constant ABI_JSON = 1;

    bytes constant SWARM_HASH =
        hex"e40101fa011b20d1de9994b4d039f6548d191eb26786769f580809256b4685ef316805265ea162";
    bytes constant OTHER_HASH =
        hex"e40101fa011b201111111111111111111111111111111111111111111111111111111111111111";

    bytes constant BTC_A = hex"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    bytes constant BTC_B = hex"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    bytes constant ABI_A = hex"5b7b2261223a317d5d";
    bytes constant ABI_B = hex"5b7b2262223a327d5d";

    /// Redeclared locally so `vm.expectEmit` can name them; the definitions live
    /// in IAddressResolver / IAddrResolver upstream.
    event AddressChanged(bytes32 indexed node, uint256 coinType, bytes newAddress);
    event AddrChanged(bytes32 indexed node, address a);

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

    function _register(string memory label, address owner_) internal returns (bytes32 node) {
        vm.prank(sponsor);
        registrar.register(label, owner_, SWARM_HASH, new string[](0), new string[](0));
        node = registry.makeNode(registry.baseNode(), label);
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _unauthorized(bytes32 node) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(L2Resolver.Unauthorized.selector, node);
    }

    /*//////////////////////////////////////////////////////////////
                        THE FOUR PREIMAGES
    //////////////////////////////////////////////////////////////*/

    /// Each helper takes the nonce EXPLICITLY rather than reading the registry,
    /// so a test can sign for a counter value that is not the current one — which
    /// is the whole point of the ordering tests.

    function _addrDigest(bytes32 node, uint256 coinType, bytes memory a, uint256 nonce, uint256 expiration)
        internal
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(address(registry), block.chainid, node, coinType, a, nonce, expiration))
            .toEthSignedMessageHash();
    }

    function _textDigest(bytes32 node, string memory key, string memory value, uint256 nonce, uint256 expiration)
        internal
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(address(registry), block.chainid, node, key, value, nonce, expiration))
            .toEthSignedMessageHash();
    }

    function _contenthashDigest(bytes32 node, bytes memory hash, uint256 nonce, uint256 expiration)
        internal
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(address(registry), block.chainid, node, hash, nonce, expiration))
            .toEthSignedMessageHash();
    }

    function _abiDigest(bytes32 node, uint256 contentType, bytes memory data, uint256 nonce, uint256 expiration)
        internal
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(address(registry), block.chainid, node, contentType, data, nonce, expiration))
            .toEthSignedMessageHash();
    }

    /*//////////////////////////////////////////////////////////////
                                  ADDR
    //////////////////////////////////////////////////////////////*/

    /// The relayer submits these, as it does for the other three setters: #13
    /// made this one write storage directly instead of calling the inherited
    /// `setAddr`, whose `authorised(node)` tested the SUBMITTER and so refused a
    /// relayer whatever the holder had signed.

    function test_SetAddrWithSignature_WritesAtNonceZeroAndSpendsIt() public {
        bytes32 node = _register("venue", holder);
        assertEq(registry.nonces(node), 0, "a fresh name starts at zero");

        bytes memory sig = _sign(HOLDER_KEY, _addrDigest(node, COIN_BTC, BTC_A, 0, EXPIRY));
        vm.prank(relayer);
        registry.setAddrWithSignature(node, COIN_BTC, BTC_A, EXPIRY, holder, sig);

        assertEq(registry.addr(node, COIN_BTC), BTC_A);
        assertEq(registry.nonces(node), 1, "the write spent the nonce");
    }

    /// THE FINDING. The signature is public in the calldata of the transaction
    /// that carried it, so anyone can try it again.
    function test_SetAddrWithSignature_AUsedSignatureIsDead() public {
        bytes32 node = _register("venue", holder);
        bytes memory sig = _sign(HOLDER_KEY, _addrDigest(node, COIN_BTC, BTC_A, 0, EXPIRY));

        vm.prank(relayer);
        registry.setAddrWithSignature(node, COIN_BTC, BTC_A, EXPIRY, holder, sig);

        vm.prank(relayer);
        vm.expectRevert(_unauthorized(node));
        registry.setAddrWithSignature(node, COIN_BTC, BTC_A, EXPIRY, holder, sig);

        // The case that made it worth fixing: the holder moves on, and the stale
        // signature must not be able to drag the record back.
        vm.prank(holder);
        registry.setAddr(node, COIN_BTC, BTC_B);

        vm.prank(relayer);
        vm.expectRevert(_unauthorized(node));
        registry.setAddrWithSignature(node, COIN_BTC, BTC_A, EXPIRY, holder, sig);

        assertEq(registry.addr(node, COIN_BTC), BTC_B, "the holder's own write stands");
        assertEq(registry.nonces(node), 1, "a refused replay spends nothing");
    }

    function test_SetAddrWithSignature_NoncesAreConsumedInOrder() public {
        bytes32 node = _register("venue", holder);
        bytes memory sig0 = _sign(HOLDER_KEY, _addrDigest(node, COIN_BTC, BTC_A, 0, EXPIRY));
        bytes memory sig1 = _sign(HOLDER_KEY, _addrDigest(node, COIN_BTC, BTC_B, 1, EXPIRY));

        vm.prank(relayer);
        vm.expectRevert(_unauthorized(node));
        registry.setAddrWithSignature(node, COIN_BTC, BTC_B, EXPIRY, holder, sig1);
        assertEq(registry.addr(node, COIN_BTC), "", "nothing written ahead of its turn");

        vm.prank(relayer);
        registry.setAddrWithSignature(node, COIN_BTC, BTC_A, EXPIRY, holder, sig0);

        vm.prank(relayer);
        registry.setAddrWithSignature(node, COIN_BTC, BTC_B, EXPIRY, holder, sig1);

        assertEq(registry.addr(node, COIN_BTC), BTC_B);
        assertEq(registry.nonces(node), 2);
    }

    /// Refused on the wrong chain — and then, as the control that makes that
    /// mean something, ACCEPTED back on the right one. Without the second half
    /// this test would pass for any reason at all that made the signature
    /// invalid, including the chain id having been dropped from the preimage
    /// altogether, which is the very thing it is here to notice.
    function test_SetAddrWithSignature_AnotherChainIdIsRefused() public {
        uint256 homeChain = block.chainid;
        bytes32 node = _register("venue", holder);
        bytes memory sig = _sign(HOLDER_KEY, _addrDigest(node, COIN_BTC, BTC_A, 0, EXPIRY));

        vm.chainId(OTHER_CHAIN_ID);
        vm.prank(relayer);
        vm.expectRevert(_unauthorized(node));
        registry.setAddrWithSignature(node, COIN_BTC, BTC_A, EXPIRY, holder, sig);
        assertEq(registry.addr(node, COIN_BTC), "", "nothing written on the wrong chain");
        assertEq(registry.nonces(node), 0, "and nothing spent");

        vm.chainId(homeChain);
        vm.prank(relayer);
        registry.setAddrWithSignature(node, COIN_BTC, BTC_A, EXPIRY, holder, sig);
        assertEq(registry.addr(node, COIN_BTC), BTC_A, "the same signature, on the chain it names");
        assertEq(registry.nonces(node), 1);
    }

    /// The digest a client must rebuild, spelled out. Frozen with the registry:
    /// a different formula here is a different contract.
    function test_SetAddrWithSignature_DigestFormulaIsPinned() public {
        bytes32 node = _register("venue", holder);
        bytes32 expected = keccak256(
            abi.encode(address(registry), block.chainid, node, COIN_BTC, BTC_A, uint256(0), EXPIRY)
        ).toEthSignedMessageHash();

        bytes memory sig = _sign(HOLDER_KEY, expected);
        vm.prank(relayer);
        registry.setAddrWithSignature(node, COIN_BTC, BTC_A, EXPIRY, holder, sig);
        assertEq(registry.addr(node, COIN_BTC), BTC_A);
    }

    /// THE #13 FINDING. A signed setter exists so that someone ELSE can pay for
    /// the write; this one used to refuse exactly that, because the inherited
    /// `setAddr` it called authorises `msg.sender`. Pinned on the ETH coin type,
    /// which is the only one that emits a second event — so this also holds the
    /// pair, and their order, against the hand-written storage write replacing
    /// the inherited call.
    function test_SetAddrWithSignature_ARelayerMaySubmitWhatTheHolderSigned() public {
        bytes32 node = _register("venue", holder);
        address target = makeAddr("target");
        bytes memory a = abi.encodePacked(target);

        bytes memory sig = _sign(HOLDER_KEY, _addrDigest(node, COIN_ETH, a, 0, EXPIRY));

        vm.expectEmit(true, true, true, true, address(registry));
        emit AddressChanged(node, COIN_ETH, a);
        vm.expectEmit(true, true, true, true, address(registry));
        emit AddrChanged(node, target);

        vm.prank(relayer);
        registry.setAddrWithSignature(node, COIN_ETH, a, EXPIRY, holder, sig);

        assertEq(registry.addr(node), target, "the legacy ETH-only reader sees it");
        assertEq(registry.addr(node, COIN_ETH), a, "and so does the multicoin one");
        assertEq(registry.nonces(node), 1, "the relayer's write spent the nonce");
    }

    /// The control on the one above. #13 removed a check on the SUBMITTER, not
    /// the check on the SIGNER: a stranger who signs for their own key is still
    /// refused, because the signature is what authorises the write.
    function test_SetAddrWithSignature_AStrangerSubmitterIsStillRefusedWithoutTheHoldersSignature() public {
        bytes32 node = _register("venue", holder);
        (address stranger, uint256 strangerKey) = makeAddrAndKey("stranger");

        bytes memory sig = _sign(strangerKey, _addrDigest(node, COIN_BTC, BTC_A, 0, EXPIRY));

        vm.prank(stranger);
        vm.expectRevert(_unauthorized(node));
        registry.setAddrWithSignature(node, COIN_BTC, BTC_A, EXPIRY, stranger, sig);

        assertEq(registry.addr(node, COIN_BTC), "", "nothing written");
        assertEq(registry.nonces(node), 0, "and nothing spent");
    }

    /*//////////////////////////////////////////////////////////////
                                  TEXT
    //////////////////////////////////////////////////////////////*/

    function test_SetTextWithSignature_WritesAtNonceZeroAndSpendsIt() public {
        bytes32 node = _register("venue", holder);
        assertEq(registry.nonces(node), 0);

        bytes memory sig = _sign(HOLDER_KEY, _textDigest(node, "url", "https://a", 0, EXPIRY));
        vm.prank(relayer);
        registry.setTextWithSignature(node, "url", "https://a", EXPIRY, holder, sig);

        assertEq(registry.text(node, "url"), "https://a");
        assertEq(registry.nonces(node), 1);
    }

    function test_SetTextWithSignature_AUsedSignatureIsDead() public {
        bytes32 node = _register("venue", holder);
        bytes memory sig = _sign(HOLDER_KEY, _textDigest(node, "url", "https://a", 0, EXPIRY));

        vm.prank(relayer);
        registry.setTextWithSignature(node, "url", "https://a", EXPIRY, holder, sig);

        vm.prank(relayer);
        vm.expectRevert(_unauthorized(node));
        registry.setTextWithSignature(node, "url", "https://a", EXPIRY, holder, sig);

        vm.prank(holder);
        registry.setText(node, "url", "https://b");

        vm.prank(relayer);
        vm.expectRevert(_unauthorized(node));
        registry.setTextWithSignature(node, "url", "https://a", EXPIRY, holder, sig);

        assertEq(registry.text(node, "url"), "https://b");
        assertEq(registry.nonces(node), 1);
    }

    function test_SetTextWithSignature_NoncesAreConsumedInOrder() public {
        bytes32 node = _register("venue", holder);
        bytes memory sig0 = _sign(HOLDER_KEY, _textDigest(node, "url", "https://a", 0, EXPIRY));
        bytes memory sig1 = _sign(HOLDER_KEY, _textDigest(node, "url", "https://b", 1, EXPIRY));

        vm.prank(relayer);
        vm.expectRevert(_unauthorized(node));
        registry.setTextWithSignature(node, "url", "https://b", EXPIRY, holder, sig1);
        assertEq(registry.text(node, "url"), "");

        vm.prank(relayer);
        registry.setTextWithSignature(node, "url", "https://a", EXPIRY, holder, sig0);

        vm.prank(relayer);
        registry.setTextWithSignature(node, "url", "https://b", EXPIRY, holder, sig1);

        assertEq(registry.text(node, "url"), "https://b");
        assertEq(registry.nonces(node), 2);
    }

    /// Refused on the wrong chain — and then, as the control that makes that
    /// mean something, ACCEPTED back on the right one. Without the second half
    /// this test would pass for any reason at all that made the signature
    /// invalid, including the chain id having been dropped from the preimage
    /// altogether, which is the very thing it is here to notice.
    function test_SetTextWithSignature_AnotherChainIdIsRefused() public {
        uint256 homeChain = block.chainid;
        bytes32 node = _register("venue", holder);
        bytes memory sig = _sign(HOLDER_KEY, _textDigest(node, "url", "https://a", 0, EXPIRY));

        vm.chainId(OTHER_CHAIN_ID);
        vm.prank(relayer);
        vm.expectRevert(_unauthorized(node));
        registry.setTextWithSignature(node, "url", "https://a", EXPIRY, holder, sig);
        assertEq(registry.text(node, "url"), "", "nothing written on the wrong chain");
        assertEq(registry.nonces(node), 0, "and nothing spent");

        vm.chainId(homeChain);
        vm.prank(relayer);
        registry.setTextWithSignature(node, "url", "https://a", EXPIRY, holder, sig);
        assertEq(registry.text(node, "url"), "https://a", "the same signature, on the chain it names");
        assertEq(registry.nonces(node), 1);
    }

    function test_SetTextWithSignature_DigestFormulaIsPinned() public {
        bytes32 node = _register("venue", holder);
        bytes32 expected = keccak256(
            abi.encode(address(registry), block.chainid, node, "url", "https://a", uint256(0), EXPIRY)
        ).toEthSignedMessageHash();

        bytes memory sig = _sign(HOLDER_KEY, expected);
        vm.prank(relayer);
        registry.setTextWithSignature(node, "url", "https://a", EXPIRY, holder, sig);
        assertEq(registry.text(node, "url"), "https://a");
    }

    /*//////////////////////////////////////////////////////////////
                              CONTENTHASH
    //////////////////////////////////////////////////////////////*/

    function test_SetContenthashWithSignature_WritesAtNonceZeroAndSpendsIt() public {
        bytes32 node = _register("venue", holder);
        assertEq(registry.nonces(node), 0);

        bytes memory sig = _sign(HOLDER_KEY, _contenthashDigest(node, OTHER_HASH, 0, EXPIRY));
        vm.prank(relayer);
        registry.setContenthashWithSignature(node, OTHER_HASH, EXPIRY, holder, sig);

        assertEq(registry.contenthash(node), OTHER_HASH);
        assertEq(registry.nonces(node), 1);
    }

    function test_SetContenthashWithSignature_AUsedSignatureIsDead() public {
        bytes32 node = _register("venue", holder);
        bytes memory sig = _sign(HOLDER_KEY, _contenthashDigest(node, OTHER_HASH, 0, EXPIRY));

        vm.prank(relayer);
        registry.setContenthashWithSignature(node, OTHER_HASH, EXPIRY, holder, sig);

        vm.prank(relayer);
        vm.expectRevert(_unauthorized(node));
        registry.setContenthashWithSignature(node, OTHER_HASH, EXPIRY, holder, sig);

        // A site redeploy: the holder repoints the name themselves. The stale
        // signature must not be able to serve the old site again.
        vm.prank(holder);
        registry.setContenthash(node, SWARM_HASH);

        vm.prank(relayer);
        vm.expectRevert(_unauthorized(node));
        registry.setContenthashWithSignature(node, OTHER_HASH, EXPIRY, holder, sig);

        assertEq(registry.contenthash(node), SWARM_HASH);
        assertEq(registry.nonces(node), 1);
    }

    function test_SetContenthashWithSignature_NoncesAreConsumedInOrder() public {
        bytes32 node = _register("venue", holder);
        bytes memory sig0 = _sign(HOLDER_KEY, _contenthashDigest(node, OTHER_HASH, 0, EXPIRY));
        bytes memory sig1 = _sign(HOLDER_KEY, _contenthashDigest(node, SWARM_HASH, 1, EXPIRY));

        vm.prank(relayer);
        vm.expectRevert(_unauthorized(node));
        registry.setContenthashWithSignature(node, SWARM_HASH, EXPIRY, holder, sig1);
        assertEq(registry.contenthash(node), SWARM_HASH, "still what `register` wrote");

        vm.prank(relayer);
        registry.setContenthashWithSignature(node, OTHER_HASH, EXPIRY, holder, sig0);
        assertEq(registry.contenthash(node), OTHER_HASH);

        vm.prank(relayer);
        registry.setContenthashWithSignature(node, SWARM_HASH, EXPIRY, holder, sig1);

        assertEq(registry.contenthash(node), SWARM_HASH);
        assertEq(registry.nonces(node), 2);
    }

    /// Refused on the wrong chain — and then, as the control that makes that
    /// mean something, ACCEPTED back on the right one. Without the second half
    /// this test would pass for any reason at all that made the signature
    /// invalid, including the chain id having been dropped from the preimage
    /// altogether, which is the very thing it is here to notice.
    function test_SetContenthashWithSignature_AnotherChainIdIsRefused() public {
        uint256 homeChain = block.chainid;
        bytes32 node = _register("venue", holder);
        bytes memory sig = _sign(HOLDER_KEY, _contenthashDigest(node, OTHER_HASH, 0, EXPIRY));

        vm.chainId(OTHER_CHAIN_ID);
        vm.prank(relayer);
        vm.expectRevert(_unauthorized(node));
        registry.setContenthashWithSignature(node, OTHER_HASH, EXPIRY, holder, sig);
        assertEq(registry.contenthash(node), SWARM_HASH, "still what `register` wrote");
        assertEq(registry.nonces(node), 0, "and nothing spent");

        vm.chainId(homeChain);
        vm.prank(relayer);
        registry.setContenthashWithSignature(node, OTHER_HASH, EXPIRY, holder, sig);
        assertEq(registry.contenthash(node), OTHER_HASH, "the same signature, on the chain it names");
        assertEq(registry.nonces(node), 1);
    }

    function test_SetContenthashWithSignature_DigestFormulaIsPinned() public {
        bytes32 node = _register("venue", holder);
        bytes32 expected = keccak256(
            abi.encode(address(registry), block.chainid, node, OTHER_HASH, uint256(0), EXPIRY)
        ).toEthSignedMessageHash();

        bytes memory sig = _sign(HOLDER_KEY, expected);
        vm.prank(relayer);
        registry.setContenthashWithSignature(node, OTHER_HASH, EXPIRY, holder, sig);
        assertEq(registry.contenthash(node), OTHER_HASH);
    }

    /*//////////////////////////////////////////////////////////////
                                   ABI
    //////////////////////////////////////////////////////////////*/

    function _readAbi(bytes32 node) internal view returns (bytes memory data) {
        (, data) = registry.ABI(node, ABI_JSON);
    }

    function test_SetABIWithSignature_WritesAtNonceZeroAndSpendsIt() public {
        bytes32 node = _register("venue", holder);
        assertEq(registry.nonces(node), 0);

        bytes memory sig = _sign(HOLDER_KEY, _abiDigest(node, ABI_JSON, ABI_A, 0, EXPIRY));
        vm.prank(relayer);
        registry.setABIWithSignature(node, ABI_JSON, ABI_A, EXPIRY, holder, sig);

        assertEq(_readAbi(node), ABI_A);
        assertEq(registry.nonces(node), 1);
    }

    function test_SetABIWithSignature_AUsedSignatureIsDead() public {
        bytes32 node = _register("venue", holder);
        bytes memory sig = _sign(HOLDER_KEY, _abiDigest(node, ABI_JSON, ABI_A, 0, EXPIRY));

        vm.prank(relayer);
        registry.setABIWithSignature(node, ABI_JSON, ABI_A, EXPIRY, holder, sig);

        vm.prank(relayer);
        vm.expectRevert(_unauthorized(node));
        registry.setABIWithSignature(node, ABI_JSON, ABI_A, EXPIRY, holder, sig);

        vm.prank(holder);
        registry.setABI(node, ABI_JSON, ABI_B);

        vm.prank(relayer);
        vm.expectRevert(_unauthorized(node));
        registry.setABIWithSignature(node, ABI_JSON, ABI_A, EXPIRY, holder, sig);

        assertEq(_readAbi(node), ABI_B);
        assertEq(registry.nonces(node), 1);
    }

    function test_SetABIWithSignature_NoncesAreConsumedInOrder() public {
        bytes32 node = _register("venue", holder);
        bytes memory sig0 = _sign(HOLDER_KEY, _abiDigest(node, ABI_JSON, ABI_A, 0, EXPIRY));
        bytes memory sig1 = _sign(HOLDER_KEY, _abiDigest(node, ABI_JSON, ABI_B, 1, EXPIRY));

        vm.prank(relayer);
        vm.expectRevert(_unauthorized(node));
        registry.setABIWithSignature(node, ABI_JSON, ABI_B, EXPIRY, holder, sig1);
        assertEq(_readAbi(node), "");

        vm.prank(relayer);
        registry.setABIWithSignature(node, ABI_JSON, ABI_A, EXPIRY, holder, sig0);

        vm.prank(relayer);
        registry.setABIWithSignature(node, ABI_JSON, ABI_B, EXPIRY, holder, sig1);

        assertEq(_readAbi(node), ABI_B);
        assertEq(registry.nonces(node), 2);
    }

    /// Refused on the wrong chain — and then, as the control that makes that
    /// mean something, ACCEPTED back on the right one. Without the second half
    /// this test would pass for any reason at all that made the signature
    /// invalid, including the chain id having been dropped from the preimage
    /// altogether, which is the very thing it is here to notice.
    function test_SetABIWithSignature_AnotherChainIdIsRefused() public {
        uint256 homeChain = block.chainid;
        bytes32 node = _register("venue", holder);
        bytes memory sig = _sign(HOLDER_KEY, _abiDigest(node, ABI_JSON, ABI_A, 0, EXPIRY));

        vm.chainId(OTHER_CHAIN_ID);
        vm.prank(relayer);
        vm.expectRevert(_unauthorized(node));
        registry.setABIWithSignature(node, ABI_JSON, ABI_A, EXPIRY, holder, sig);
        assertEq(_readAbi(node), "", "nothing written on the wrong chain");
        assertEq(registry.nonces(node), 0, "and nothing spent");

        vm.chainId(homeChain);
        vm.prank(relayer);
        registry.setABIWithSignature(node, ABI_JSON, ABI_A, EXPIRY, holder, sig);
        assertEq(_readAbi(node), ABI_A, "the same signature, on the chain it names");
        assertEq(registry.nonces(node), 1);
    }

    function test_SetABIWithSignature_DigestFormulaIsPinned() public {
        bytes32 node = _register("venue", holder);
        bytes32 expected = keccak256(
            abi.encode(address(registry), block.chainid, node, ABI_JSON, ABI_A, uint256(0), EXPIRY)
        ).toEthSignedMessageHash();

        bytes memory sig = _sign(HOLDER_KEY, expected);
        vm.prank(relayer);
        registry.setABIWithSignature(node, ABI_JSON, ABI_A, EXPIRY, holder, sig);
        assertEq(_readAbi(node), ABI_A);
    }

    /*//////////////////////////////////////////////////////////////
                     THE COUNTER OUTLIVES THE HOLDER
    //////////////////////////////////////////////////////////////*/

    /// Why the counter is per NAME and never reset. A name can be given back and
    /// the same label minted to someone else; if `release` or the re-mint put the
    /// counter back to zero, the FIRST holder's unspent nonce-0 signature would
    /// be live again against a name they no longer hold, and could write a record
    /// on the new holder's name. The counter carrying over is what closes that.
    function test_Nonce_IsMonotonicAcrossOwners() public {
        bytes32 node = _register("venue", holder);

        bytes memory sigA = _sign(HOLDER_KEY, _textDigest(node, "url", "https://a", 0, EXPIRY));
        vm.prank(relayer);
        registry.setTextWithSignature(node, "url", "https://a", EXPIRY, holder, sigA);
        assertEq(registry.nonces(node), 1);

        vm.prank(holder);
        registry.release(node);
        assertEq(registry.owner(node), address(0), "released");
        assertEq(registry.nonces(node), 1, "release does not reset the counter");

        vm.prank(sponsor);
        registrar.register("venue", secondHolder, SWARM_HASH, new string[](0), new string[](0));
        assertEq(registry.owner(node), secondHolder, "same node, new holder");
        assertEq(registry.nonces(node), 1, "nor does the re-mint");

        // The new holder's signature has to carry the counter it inherited.
        bytes memory sigBStale = _sign(SECOND_HOLDER_KEY, _textDigest(node, "url", "https://b", 0, EXPIRY));
        vm.prank(relayer);
        vm.expectRevert(_unauthorized(node));
        registry.setTextWithSignature(node, "url", "https://b", EXPIRY, secondHolder, sigBStale);

        bytes memory sigB = _sign(SECOND_HOLDER_KEY, _textDigest(node, "url", "https://b", 1, EXPIRY));
        vm.prank(relayer);
        registry.setTextWithSignature(node, "url", "https://b", EXPIRY, secondHolder, sigB);

        assertEq(registry.text(node, "url"), "https://b");
        assertEq(registry.nonces(node), 2);
    }

}
