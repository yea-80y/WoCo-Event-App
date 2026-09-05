// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {WoCoRegistrar} from "../src/WoCoRegistrar.sol";
import {L2Registry} from "../src/durin/L2Registry.sol";
import {L2RegistryFactory} from "../src/durin/L2RegistryFactory.sol";
import {IL2Registry} from "../src/durin/interfaces/IL2Registry.sol";

contract WoCoRegistrarTest is Test {
    L2RegistryFactory factory;
    L2Registry registry;
    WoCoRegistrar registrar;

    address admin = makeAddr("admin");
    address sponsor = makeAddr("sponsor");
    address organiser = makeAddr("organiser");
    address stranger = makeAddr("stranger");

    uint256 platformSignerPk = 0xDEAD;
    address platformSigner;

    // A short Swarm bzz reference, ENS contenthash-encoded bytes (shape only).
    bytes constant SWARM_HASH = hex"e40101fa011b20d1de9994b4d039f6548d191eb26786769f580809256b4685ef316805265ea162";

    function setUp() public {
        platformSigner = vm.addr(platformSignerPk);

        L2Registry impl = new L2Registry();
        factory = new L2RegistryFactory(address(impl));

        vm.prank(admin);
        registry = L2Registry(factory.deployRegistry("woco.eth", "WoCo Names", "", admin));

        registrar = new WoCoRegistrar(address(registry), admin, platformSigner);

        vm.startPrank(admin);
        registry.addRegistrar(address(registrar));
        registrar.addSponsor(sponsor);
        registrar.setReserved("admin", true);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                              HELPERS
    //////////////////////////////////////////////////////////////*/

    function _emptyText() internal pure returns (string[] memory keys, string[] memory vals) {
        keys = new string[](0);
        vals = new string[](0);
    }

    /// Signs an EIP-712 permit for (label, owner, expiry) using the registrar's domain separator.
    function _signPermit(string memory label, address owner_, uint256 expiry)
        internal
        view
        returns (bytes memory sig)
    {
        bytes32 structHash = keccak256(abi.encode(
            registrar.PERMIT_TYPEHASH(),
            keccak256(bytes(label)),
            owner_,
            expiry
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", registrar.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(platformSignerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    /*//////////////////////////////////////////////////////////////
                          register() — sponsor path
    //////////////////////////////////////////////////////////////*/

    function test_register_mintsToOrganiserAndSetsContenthash() public {
        (string[] memory keys, string[] memory vals) = _emptyText();

        vm.prank(sponsor);
        bytes32 node = registrar.register("myband", organiser, SWARM_HASH, keys, vals);

        assertEq(registry.owner(node), organiser, "organiser owns the name");
        assertEq(registry.contenthash(node), SWARM_HASH, "Swarm pointer set");
        assertFalse(registrar.available("myband"), "no longer available");
    }

    function test_register_setsProfileTextRecords() public {
        string[] memory keys = new string[](2);
        string[] memory vals = new string[](2);
        keys[0] = "description";
        vals[0] = "Independent music venue";
        keys[1] = "avatar";
        vals[1] = "bzz://d1de9994b4d039f6548d191eb26786769f580809256b4685ef316805265ea162";

        vm.prank(sponsor);
        bytes32 node = registrar.register("craufurd-arms", organiser, SWARM_HASH, keys, vals);

        assertEq(registry.text(node, "description"), "Independent music venue");
        assertEq(registry.text(node, "avatar"), vals[1]);
    }

    function test_setContenthash_updatesOnRedeploy() public {
        (string[] memory keys, string[] memory vals) = _emptyText();
        vm.prank(sponsor);
        bytes32 node = registrar.register("myband", organiser, SWARM_HASH, keys, vals);

        bytes memory newHash = hex"e40101fa011b2000000000000000000000000000000000000000000000000000000000deadbeef";
        vm.prank(sponsor);
        registrar.setContenthash("myband", newHash);

        assertEq(registry.contenthash(node), newHash);
    }

    function test_register_revertsForNonSponsor() public {
        (string[] memory keys, string[] memory vals) = _emptyText();
        vm.expectRevert(abi.encodeWithSelector(WoCoRegistrar.NotAuthorisedSponsor.selector, stranger));
        vm.prank(stranger);
        registrar.register("myband", organiser, SWARM_HASH, keys, vals);
    }

    function test_register_revertsForReservedLabel() public {
        (string[] memory keys, string[] memory vals) = _emptyText();
        vm.expectRevert(abi.encodeWithSelector(WoCoRegistrar.LabelIsReserved.selector, "admin"));
        vm.prank(sponsor);
        registrar.register("admin", organiser, SWARM_HASH, keys, vals);
    }

    function test_register_revertsForArrayMismatch() public {
        string[] memory keys = new string[](1);
        string[] memory vals = new string[](0);
        keys[0] = "description";
        vm.expectRevert(WoCoRegistrar.ArrayLengthMismatch.selector);
        vm.prank(sponsor);
        registrar.register("myband", organiser, SWARM_HASH, keys, vals);
    }

    /*//////////////////////////////////////////////////////////////
                       registerWithPermit() — permit path
    //////////////////////////////////////////////////////////////*/

    function test_permit_happyPath() public {
        (string[] memory keys, string[] memory vals) = _emptyText();
        uint256 expiry = block.timestamp + 600;
        bytes memory sig = _signPermit("permitband", organiser, expiry);

        vm.prank(organiser); // organiser submits the tx themselves (or via paymaster)
        bytes32 node = registrar.registerWithPermit("permitband", organiser, SWARM_HASH, keys, vals, expiry, sig);

        assertEq(registry.owner(node), organiser);
        assertFalse(registrar.available("permitband"));
    }

    function test_permit_setsTextRecords() public {
        string[] memory keys = new string[](1);
        string[] memory vals = new string[](1);
        keys[0] = "description";
        vals[0] = "Permit venue";
        uint256 expiry = block.timestamp + 600;
        bytes memory sig = _signPermit("permitvenue", organiser, expiry);

        vm.prank(organiser);
        bytes32 node = registrar.registerWithPermit("permitvenue", organiser, SWARM_HASH, keys, vals, expiry, sig);

        assertEq(registry.text(node, "description"), "Permit venue");
    }

    function test_permit_revertsOnExpiry() public {
        (string[] memory keys, string[] memory vals) = _emptyText();
        uint256 expiry = block.timestamp - 1; // already expired
        bytes memory sig = _signPermit("expiredband", organiser, expiry);

        vm.expectRevert(WoCoRegistrar.PermitExpired.selector);
        registrar.registerWithPermit("expiredband", organiser, SWARM_HASH, keys, vals, expiry, sig);
    }

    function test_permit_revertsOnReplay() public {
        (string[] memory keys, string[] memory vals) = _emptyText();
        uint256 expiry = block.timestamp + 600;
        bytes memory sig = _signPermit("replayband", organiser, expiry);

        vm.prank(organiser);
        registrar.registerWithPermit("replayband", organiser, SWARM_HASH, keys, vals, expiry, sig);

        // Exact same (label, owner, expiry) — usedPermits check fires before _register.
        vm.expectRevert(WoCoRegistrar.PermitAlreadyUsed.selector);
        vm.prank(stranger);
        registrar.registerWithPermit("replayband", organiser, SWARM_HASH, keys, vals, expiry, sig);
    }

    function test_permit_revertsOnWrongSigner() public {
        (string[] memory keys, string[] memory vals) = _emptyText();
        uint256 expiry = block.timestamp + 600;

        // Sign with a rogue key — produces a valid sig but wrong signer address.
        uint256 rogueKey = 0xBEEF;
        bytes32 structHash = keccak256(abi.encode(
            registrar.PERMIT_TYPEHASH(), keccak256(bytes("rogueband")), organiser, expiry
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", registrar.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(rogueKey, digest);
        bytes memory badSig = abi.encodePacked(r, s, v);

        vm.expectRevert(WoCoRegistrar.PermitInvalid.selector);
        registrar.registerWithPermit("rogueband", organiser, SWARM_HASH, keys, vals, expiry, badSig);
    }

    function test_permit_revertsIfOwnerMismatch() public {
        (string[] memory keys, string[] memory vals) = _emptyText();
        uint256 expiry = block.timestamp + 600;
        // Permit signed for organiser, submitted claiming stranger as owner
        bytes memory sig = _signPermit("mismatchband", organiser, expiry);

        vm.expectRevert(WoCoRegistrar.PermitInvalid.selector);
        registrar.registerWithPermit("mismatchband", stranger, SWARM_HASH, keys, vals, expiry, sig);
    }

    function test_permit_revertsIfLabelMismatch() public {
        (string[] memory keys, string[] memory vals) = _emptyText();
        uint256 expiry = block.timestamp + 600;
        bytes memory sig = _signPermit("correctlabel", organiser, expiry);

        // Attempt with a different label using the same sig
        vm.expectRevert(WoCoRegistrar.PermitInvalid.selector);
        registrar.registerWithPermit("wronglabel", organiser, SWARM_HASH, keys, vals, expiry, sig);
    }

    function test_permit_revertsForReservedLabel() public {
        (string[] memory keys, string[] memory vals) = _emptyText();
        uint256 expiry = block.timestamp + 600;
        bytes memory sig = _signPermit("admin", organiser, expiry);

        vm.expectRevert(abi.encodeWithSelector(WoCoRegistrar.LabelIsReserved.selector, "admin"));
        registrar.registerWithPermit("admin", organiser, SWARM_HASH, keys, vals, expiry, sig);
    }

    /*//////////////////////////////////////////////////////////////
                           VALIDATION + ADMIN
    //////////////////////////////////////////////////////////////*/

    function test_validation_rejectsBadLabels() public view {
        assertFalse(registrar.available("ab"), "too short");
        assertFalse(registrar.available("-myband"), "leading hyphen");
        assertFalse(registrar.available("myband-"), "trailing hyphen");
        assertFalse(registrar.available("my--band"), "double hyphen");
        assertFalse(registrar.available("MyBand"), "uppercase");
        assertFalse(registrar.available("my_band"), "underscore");
        assertFalse(registrar.available("admin"), "reserved");
        assertTrue(registrar.available("my-band-3"), "valid label");
    }

    function test_available_falseAfterMint() public {
        (string[] memory keys, string[] memory vals) = _emptyText();
        assertTrue(registrar.available("myband"));
        vm.prank(sponsor);
        registrar.register("myband", organiser, SWARM_HASH, keys, vals);
        assertFalse(registrar.available("myband"));
    }

    function test_setPlatformSigner_onlyOwner() public {
        address newSigner = makeAddr("newSigner");
        vm.prank(admin);
        registrar.setPlatformSigner(newSigner);
        assertEq(registrar.platformSigner(), newSigner);

        vm.expectRevert();
        vm.prank(stranger);
        registrar.setPlatformSigner(newSigner);
    }
}
