// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {NameEncoder} from "@ensdomains/ens-contracts/utils/NameEncoder.sol";
import {L1Resolver, IResolverService} from "../src/durin/L1Resolver.sol";
import {MockENS, MockAddrResolver, MockNameWrapper, MockPublicResolver, RevertingResolver} from "./mocks/L1Mocks.sol";

/**
 * Tests for `L1Resolver.fallbackResolver` — the apex passthrough added for
 * WoCo-Event-App #419.
 *
 * The problem it solves is not subtle and is not hypothetical. `resolve()` takes
 * the LAST TWO labels of any name as the parent, with no special case for the
 * parent itself. So the moment `woco.eth`'s resolver is pointed at this contract,
 * a query for `woco.eth` — the WoCo app's own contenthash, served to every
 * visitor by eth.limo — is forwarded to the CCIP-Read gateway like a subname,
 * and the app goes dark. Mirroring that record into the L2 registry was the
 * alternative, and it would have put the app's address behind a hot signer, an
 * L2 RPC and an API server.
 *
 * Two properties carry the whole design, and each has its own test:
 *
 *   1. UNSET, this contract answers exactly as upstream Durin does. Pinned by
 *      comparing the OffchainLookup revert data byte for byte against an
 *      expectation this file builds independently, for a 2LD and for a subname.
 *   2. SET, only the name ITSELF is diverted. Subnames — the entire point of the
 *      registry — must still go offchain, byte-identically.
 */
contract L1ResolverFallbackTest is Test {
    /// The ENS registry address the vendored constructor hardcodes.
    address constant ENS_ADDRESS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    /// namehash("namewrapper.eth"), read by the constructor.
    bytes32 constant WRAPPER_NODE = 0xdee478ba2734e34d81c6adc77a32d75b29007895efa2fe60921f1c315e1ec7d9;

    string constant GATEWAY_URL = "https://events-api.woco-net.com/api/ens-gateway/v1/{sender}/{data}";
    uint64 constant ARBITRUM_ONE = 42161;

    MockENS ens;
    MockNameWrapper nameWrapper;
    MockPublicResolver publicResolver;
    L1Resolver resolver;

    address l2RegistryAddress = makeAddr("l2Registry");
    address nameOwner = makeAddr("nameOwner");
    address stranger = makeAddr("stranger");
    address resolverOwner = makeAddr("resolverOwner");
    address gatewaySigner = makeAddr("gatewaySigner");

    bytes32 wocoNode;
    bytes wocoName;

    /// The live apex record: `e40101fa011b20` + the frontend feed manifest ref.
    bytes constant APEX_CONTENTHASH =
        hex"e40101fa011b20d66c6ff7650a468c2fd98439c8f04547b5b8a4b933d349ff16db1d0b00c23adc";

    event FallbackResolverSet(bytes32 node, address fallbackResolver);

    function setUp() public {
        // The constructor reads the ENS registry at a fixed address, then
        // resolves namewrapper.eth through it. Etch a mock there, populate its
        // storage through its own setters, and only then deploy.
        vm.etch(ENS_ADDRESS, address(new MockENS()).code);
        ens = MockENS(ENS_ADDRESS);

        nameWrapper = new MockNameWrapper();
        ens.setResolver(WRAPPER_NODE, address(new MockAddrResolver(address(nameWrapper))));

        resolver = new L1Resolver(GATEWAY_URL, gatewaySigner, resolverOwner);

        (wocoName, wocoNode) = NameEncoder.dnsEncodeName("woco.eth");
        ens.setOwner(wocoNode, nameOwner);

        vm.prank(nameOwner);
        resolver.setL2Registry(wocoNode, ARBITRUM_ONE, l2RegistryAddress);

        publicResolver = new MockPublicResolver();
        publicResolver.setContenthash(wocoNode, APEX_CONTENTHASH);
    }

    /*//////////////////////////////////////////////////////////////
              1. UNSET => UPSTREAM BEHAVIOUR, TO THE BYTE
    //////////////////////////////////////////////////////////////*/

    /// The apex, with no fallback set, goes offchain — which is precisely the
    /// upstream behaviour that takes the app down, and precisely why the opt-in
    /// exists rather than a hardcoded apex case.
    function test_Unset_ApexProducesTheUpstreamOffchainLookup() public {
        (bytes memory name,) = NameEncoder.dnsEncodeName("woco.eth");
        bytes memory data = abi.encodeWithSelector(bytes4(keccak256("contenthash(bytes32)")), wocoNode);

        vm.expectRevert(_expectedOffchainLookup(name, data));
        resolver.resolve(name, data);
    }

    function test_Unset_SubnameProducesTheUpstreamOffchainLookup() public {
        (bytes memory name, bytes32 node) = NameEncoder.dnsEncodeName("venue.woco.eth");
        bytes memory data = abi.encodeWithSelector(bytes4(keccak256("addr(bytes32)")), node);

        vm.expectRevert(_expectedOffchainLookup(name, data));
        resolver.resolve(name, data);
    }

    function test_Unset_DeepSubnameProducesTheUpstreamOffchainLookup() public {
        (bytes memory name, bytes32 node) = NameEncoder.dnsEncodeName("shop.venue.woco.eth");
        bytes memory data = abi.encodeWithSelector(bytes4(keccak256("addr(bytes32)")), node);

        vm.expectRevert(_expectedOffchainLookup(name, data));
        resolver.resolve(name, data);
    }

    /*//////////////////////////////////////////////////////////////
              2. SET => ONLY THE NAME ITSELF IS DIVERTED
    //////////////////////////////////////////////////////////////*/

    function test_Set_ApexAnswersFromL1WithoutTouchingTheGateway() public {
        _setFallback(address(publicResolver));

        bytes memory data = abi.encodeWithSelector(bytes4(keccak256("contenthash(bytes32)")), wocoNode);
        bytes memory result = resolver.resolve(wocoName, data);

        assertEq(abi.decode(result, (bytes)), APEX_CONTENTHASH, "apex did not answer from L1");
    }

    /// The property everything else rests on. A fallback that also caught
    /// subnames would silently disable the entire sub-ENS registry, and it would
    /// do so while the apex kept working — i.e. it would look fine.
    function test_Set_SubnamesStillGoOffchainUnchanged() public {
        _setFallback(address(publicResolver));

        (bytes memory name, bytes32 node) = NameEncoder.dnsEncodeName("venue.woco.eth");
        bytes memory data = abi.encodeWithSelector(bytes4(keccak256("addr(bytes32)")), node);

        vm.expectRevert(_expectedOffchainLookup(name, data));
        resolver.resolve(name, data);
    }

    function test_Set_DeepSubnamesStillGoOffchainUnchanged() public {
        _setFallback(address(publicResolver));

        (bytes memory name, bytes32 node) = NameEncoder.dnsEncodeName("shop.venue.woco.eth");
        bytes memory data = abi.encodeWithSelector(bytes4(keccak256("addr(bytes32)")), node);

        vm.expectRevert(_expectedOffchainLookup(name, data));
        resolver.resolve(name, data);
    }

    /// The fallback is keyed per name. One parent opting in must not answer for
    /// another parent that has not.
    function test_Set_IsScopedToItsOwnName() public {
        (, bytes32 otherNode) = NameEncoder.dnsEncodeName("other.eth");
        ens.setOwner(otherNode, nameOwner);
        vm.prank(nameOwner);
        resolver.setFallbackResolver(otherNode, address(publicResolver));

        bytes memory data = abi.encodeWithSelector(bytes4(keccak256("contenthash(bytes32)")), wocoNode);

        vm.expectRevert(_expectedOffchainLookup(wocoName, data));
        resolver.resolve(wocoName, data);
    }

    /// Any record type passes through, not just contenthash — the Public
    /// Resolver keeps its storage across a `setResolver`, so whatever is there
    /// must keep answering.
    function test_Set_PassesThroughOtherRecordTypes() public {
        publicResolver.setText(wocoNode, "url", "https://woco-net.com");
        _setFallback(address(publicResolver));

        bytes memory data =
            abi.encodeWithSelector(bytes4(keccak256("text(bytes32,string)")), wocoNode, "url");
        bytes memory result = resolver.resolve(wocoName, data);

        assertEq(abi.decode(result, (string)), "https://woco-net.com");
    }

    /// Unsetting is the rollback path, and it must restore upstream behaviour
    /// exactly rather than leave a half-diverted resolver behind.
    function test_Set_CanBeUnsetAndUpstreamBehaviourReturns() public {
        _setFallback(address(publicResolver));
        _setFallback(address(0));

        bytes memory data = abi.encodeWithSelector(bytes4(keccak256("contenthash(bytes32)")), wocoNode);

        vm.expectRevert(_expectedOffchainLookup(wocoName, data));
        resolver.resolve(wocoName, data);
    }

    /// A failing fallback must surface as a failure. Swallowing it into empty
    /// bytes would report "this name has no contenthash", which for the apex is
    /// the app vanishing with no error anywhere.
    function test_Set_FallbackRevertIsBubbledNotSwallowed() public {
        RevertingResolver bad = new RevertingResolver();
        _setFallback(address(bad));

        bytes memory data = abi.encodeWithSelector(bytes4(keccak256("contenthash(bytes32)")), wocoNode);

        vm.expectRevert(RevertingResolver.Nope.selector);
        resolver.resolve(wocoName, data);
    }

    /// An address with no code returns success and empty data to a staticcall,
    /// so a typo'd cutover would have the apex answer "no record" — the app
    /// vanishing with no error anywhere. The setter refuses it instead.
    function test_SetFallbackResolver_RefusesAnAddressWithNoCode() public {
        address nothing = makeAddr("nothing-deployed-here");

        vm.expectRevert(abi.encodeWithSelector(L1Resolver.FallbackResolverHasNoCode.selector, nothing));
        vm.prank(nameOwner);
        resolver.setFallbackResolver(wocoNode, nothing);

        assertEq(resolver.fallbackResolver(wocoNode), address(0), "a codeless fallback was stored");
    }

    /*//////////////////////////////////////////////////////////////
                            AUTHORISATION
    //////////////////////////////////////////////////////////////*/

    /// Whoever controls the ENS name decides where it answers from — not this
    /// contract's `owner()`, who holds only the gateway URL and signer.
    function test_SetFallbackResolver_RevertsForANonOwner() public {
        vm.expectRevert(L1Resolver.Unauthorized.selector);
        vm.prank(stranger);
        resolver.setFallbackResolver(wocoNode, address(publicResolver));
    }

    function test_SetFallbackResolver_RevertsForThisContractsOwner() public {
        vm.expectRevert(L1Resolver.Unauthorized.selector);
        vm.prank(resolverOwner);
        resolver.setFallbackResolver(wocoNode, address(publicResolver));
    }

    /// `woco.eth` is wrapped, so `ens.owner` is the NameWrapper and the real
    /// owner is behind `ownerOf`. The cutover is signed by that key.
    function test_SetFallbackResolver_UnwrapsThroughTheNameWrapper() public {
        address wrappedOwner = makeAddr("custodySafe");
        ens.setOwner(wocoNode, address(nameWrapper));
        nameWrapper.setOwner(uint256(wocoNode), wrappedOwner);

        vm.prank(wrappedOwner);
        resolver.setFallbackResolver(wocoNode, address(publicResolver));
        assertEq(resolver.fallbackResolver(wocoNode), address(publicResolver));

        // And the registry owner underneath the wrapper is not the wrapper itself.
        vm.expectRevert(L1Resolver.Unauthorized.selector);
        vm.prank(address(nameWrapper));
        resolver.setFallbackResolver(wocoNode, address(0));
    }

    function test_SetFallbackResolver_EmitsTheChange() public {
        vm.expectEmit(false, false, false, true, address(resolver));
        emit FallbackResolverSet(wocoNode, address(publicResolver));

        vm.prank(nameOwner);
        resolver.setFallbackResolver(wocoNode, address(publicResolver));
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _setFallback(address r) internal {
        vm.prank(nameOwner);
        resolver.setFallbackResolver(wocoNode, r);
    }

    /// @dev Rebuilds upstream's OffchainLookup payload from first principles, so
    ///      the comparison is against the spec rather than against whatever the
    ///      contract happens to emit.
    function _expectedOffchainLookup(bytes memory name, bytes memory data)
        internal
        view
        returns (bytes memory)
    {
        bytes memory callData = abi.encodeWithSelector(
            IResolverService.stuffedResolveCall.selector, name, data, ARBITRUM_ONE, l2RegistryAddress
        );
        string[] memory urls = new string[](1);
        urls[0] = GATEWAY_URL;

        return abi.encodeWithSelector(
            L1Resolver.OffchainLookup.selector,
            address(resolver),
            urls,
            callData,
            L1Resolver.resolveWithProof.selector,
            callData
        );
    }
}
