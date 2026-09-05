// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NameEncoder} from "@ensdomains/ens-contracts/utils/NameEncoder.sol";
import {ScriptEnvFixture} from "./ScriptEnvFixture.sol";
import {DeployL1Resolver} from "../script/DeployL1Resolver.s.sol";
import {L1Resolver} from "../src/durin/L1Resolver.sol";
import {MockENS, MockAddrResolver, MockNameWrapper, MockPublicResolver} from "./mocks/L1Mocks.sol";

/**
 * Tests for the L1Resolver deploy script (#419).
 *
 * The script never sends a name-owner transaction — on mainnet the name owner is
 * the #420 custody Safe, not the deployer key this script runs with. So the
 * headline behaviour to prove is not "it deploys a contract", it's "it computes
 * the RIGHT calldata for someone else to send, and it refuses to compute anything
 * when an input doesn't add up." Every guard below (G1-G16, matching the script's
 * own comments) gets a test that proves it fires, and — per the mutation-check
 * discipline this suite is built to survive — proves it by making that SPECIFIC
 * require the one that trips, not some other guard shadowing it.
 *
 * Per `ScriptEnvFixture`, only `DEPLOYER_PRIVATE_KEY` and `SPONSOR_ADDRESS` (via
 * `_setSharedScriptEnv()`) ever touch the process environment here. Every other
 * input is injected directly into `TestableDeployL1Resolver`'s stored `Config`,
 * so per-test variation can never race another test file.
 */
contract DeployL1ResolverTest is ScriptEnvFixture {
    /// The canonical ENS registry address `L1Resolver`'s constructor hardcodes.
    address constant ENS_ADDRESS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    /// namehash("namewrapper.eth"), read by the constructor.
    bytes32 constant WRAPPER_NODE = 0xdee478ba2734e34d81c6adc77a32d75b29007895efa2fe60921f1c315e1ec7d9;

    string constant GATEWAY_URL = "https://events-api.woco-net.com/api/ens-gateway/v1/{sender}/{data}";

    /// The live apex record, same fixture as L1ResolverFallback.t.sol.
    bytes constant APEX_CONTENTHASH =
        hex"e40101fa011b20d66c6ff7650a468c2fd98439c8f04547b5b8a4b933d349ff16db1d0b00c23adc";

    /// Matches deployments/421614-subens.json, the REAL record checked into this
    /// repo — used as-is for the G9 happy path so no fixture file has to be forged
    /// for it.
    uint64 constant L2_CHAIN_ID = 421614;
    address constant L2_REGISTRY_ADDRESS = 0xC38e08CB5a21B083F63149ea7597Ea8D05017cf8;
    string constant DEPLOYMENT_RECORD = "deployments/421614-subens.json";

    MockENS ens;
    MockNameWrapper wrapper;
    MockPublicResolver publicResolver;
    MockSafe safe;

    address nameOwner = makeAddr("nameOwner");
    address gatewaySigner = makeAddr("gatewaySigner");

    bytes32 node;
    bytes dnsName;

    function setUp() public {
        // Shared keys only - see ScriptEnvFixture's header before adding
        // anything else here. Everything this script reads beyond
        // DEPLOYER_PRIVATE_KEY/SPONSOR_ADDRESS is injected through
        // TestableDeployL1Resolver's Config, never through vm.setEnv.
        _setSharedScriptEnv();

        // The constructor reads the ENS registry at a fixed address, then
        // resolves namewrapper.eth through it. Etch a mock there, populate its
        // storage through its own setters, and only then deploy anything.
        vm.etch(ENS_ADDRESS, address(new MockENS()).code);
        ens = MockENS(ENS_ADDRESS);

        wrapper = new MockNameWrapper();
        ens.setResolver(WRAPPER_NODE, address(new MockAddrResolver(address(wrapper))));

        (dnsName, node) = NameEncoder.dnsEncodeName("woco.eth");

        publicResolver = new MockPublicResolver();
        publicResolver.setContenthash(node, APEX_CONTENTHASH);
        ens.setResolver(node, address(publicResolver));

        safe = new MockSafe();

        // Wrapped by default - most tests exercise the wrapped path; the
        // unwrapped path gets its own test that overrides this.
        ens.setOwner(node, address(wrapper));
        wrapper.setOwner(uint256(node), nameOwner);
    }

    /// @dev Every field explicit, matching the script's `Config` one-for-one, so
    ///      a reader can see at a glance which fields a given test overrides.
    function _newScript() internal returns (TestableDeployL1Resolver) {
        return new TestableDeployL1Resolver(
            SCRIPT_DEPLOYER_PK, SCRIPT_SPONSOR, gatewaySigner, address(safe), L2_REGISTRY_ADDRESS, address(publicResolver), nameOwner
        );
    }

    /*//////////////////////////////////////////////////////////////
                        HAPPY PATHS - DEPLOY MODE
    //////////////////////////////////////////////////////////////*/

    function test_Deploy_WrappedName_PlanExecutesEndToEnd() public {
        TestableDeployL1Resolver script = _newScript();
        DeployL1Resolver.Plan memory plan = script.run();

        L1Resolver resolver = L1Resolver(plan.resolver);
        assertEq(resolver.url(), GATEWAY_URL, "url");
        assertEq(resolver.signer(), gatewaySigner, "signer");
        assertEq(resolver.owner(), address(safe), "owner");

        assertEq(plan.node, node, "node");
        assertTrue(plan.wrapped, "wrapped");
        assertEq(plan.swapTarget, address(wrapper), "swap target should be the wrapper when wrapped");
        assertEq(plan.nameOwner, nameOwner, "nameOwner");

        // Execute the two name-owner calls exactly as the Safe would.
        vm.startPrank(nameOwner);
        (bool ok1,) = plan.resolver.call(plan.setL2RegistryCall);
        assertTrue(ok1, "setL2Registry call failed");
        (bool ok2,) = plan.resolver.call(plan.setFallbackResolverCall);
        assertTrue(ok2, "setFallbackResolver call failed");
        vm.stopPrank();

        (uint64 chainId, address registryAddr) = resolver.l2Registry(node);
        assertEq(chainId, L2_CHAIN_ID, "l2Registry chainId");
        assertEq(registryAddr, L2_REGISTRY_ADDRESS, "l2Registry address");
        assertEq(resolver.fallbackResolver(node), address(publicResolver), "fallbackResolver");

        bytes memory data = abi.encodeWithSignature("contenthash(bytes32)", node);
        bytes memory result = resolver.resolve(dnsName, data);
        assertEq(abi.decode(result, (bytes)), APEX_CONTENTHASH, "apex did not answer from L1 after wiring");

        // Execute the swap.
        vm.prank(nameOwner);
        (bool ok3,) = plan.swapTarget.call(plan.swapCall);
        assertTrue(ok3, "swap call failed");
        assertEq(ens.resolver(node), plan.resolver, "resolver did not take over after the swap");

        // Execute the prepared rollback.
        vm.prank(nameOwner);
        (bool ok4,) = plan.swapTarget.call(plan.rollbackCall);
        assertTrue(ok4, "rollback call failed");
        assertEq(ens.resolver(node), address(publicResolver), "rollback did not restore the original resolver");
    }

    function test_Deploy_UnwrappedName_SwapTargetsTheRegistry() public {
        // Unwrapped: the name is owned directly, not through the NameWrapper.
        ens.setOwner(node, nameOwner);

        TestableDeployL1Resolver script = _newScript();
        DeployL1Resolver.Plan memory plan = script.run();

        assertFalse(plan.wrapped, "should not be wrapped");
        assertEq(plan.swapTarget, ENS_ADDRESS, "swap target should be the registry when unwrapped");

        vm.prank(nameOwner);
        (bool ok,) = plan.swapTarget.call(plan.swapCall);
        assertTrue(ok, "swap call failed");
        assertEq(ens.resolver(node), plan.resolver);
    }

    function test_Deploy_LeavesNoRecordBehind() public {
        TestableDeployL1Resolver script = _newScript();
        script.run();
        assertFalse(vm.exists("deployments/31337-l1resolver.json"), "a deployment record was written unrequested");
    }

    /// The only test allowed to write a deployment record - reads into locals
    /// and removes the file BEFORE asserting, so a failed assertion still
    /// leaves the repo clean.
    function test_Deploy_WritesRecordWhenRequested() public {
        TestableDeployL1Resolver script = _newScript();
        script.setWriteDeploymentRecord(true);
        DeployL1Resolver.Plan memory plan = script.run();

        string memory path = "deployments/31337-l1resolver.json";
        bool exists = vm.exists(path);
        address recordedResolver;
        if (exists) {
            string memory json = vm.readFile(path);
            recordedResolver = vm.parseJsonAddress(json, ".resolver");
            vm.removeFile(path);
        }

        assertTrue(exists, "deployment record was not written");
        assertEq(recordedResolver, plan.resolver, "recorded resolver did not match the plan");
    }

    /*//////////////////////////////////////////////////////////////
                            PLAN-ONLY MODE
    //////////////////////////////////////////////////////////////*/

    function test_PlanOnly_ReusesAnExistingResolver() public {
        TestableDeployL1Resolver first = _newScript();
        DeployL1Resolver.Plan memory firstPlan = first.run();

        TestableDeployL1Resolver second = _newScript();
        second.setExistingResolver(firstPlan.resolver);
        DeployL1Resolver.Plan memory secondPlan = second.run();

        assertEq(secondPlan.resolver, firstPlan.resolver, "plan-only mode deployed a new resolver");

        vm.startPrank(nameOwner);
        (bool ok1,) = secondPlan.resolver.call(secondPlan.setL2RegistryCall);
        assertTrue(ok1, "setL2Registry call failed");
        (bool ok2,) = secondPlan.resolver.call(secondPlan.setFallbackResolverCall);
        assertTrue(ok2, "setFallbackResolver call failed");
        vm.stopPrank();

        (uint64 chainId, address registryAddr) = L1Resolver(secondPlan.resolver).l2Registry(node);
        assertEq(chainId, L2_CHAIN_ID);
        assertEq(registryAddr, L2_REGISTRY_ADDRESS);
    }

    function test_Refuses_ExistingResolverHasNoCode() public {
        // G15
        TestableDeployL1Resolver script = _newScript();
        script.setExistingResolver(makeAddr("nothing-deployed-here"));
        vm.expectRevert(bytes("EXISTING_RESOLVER has no code"));
        script.run();
    }

    function test_Refuses_ExistingResolverSignerMismatch() public {
        // G16, signer clause
        TestableDeployL1Resolver first = _newScript();
        DeployL1Resolver.Plan memory firstPlan = first.run();

        TestableDeployL1Resolver second = _newScript();
        second.setExistingResolver(firstPlan.resolver);
        second.setGatewaySigner(makeAddr("different-signer"));
        vm.expectRevert(
            bytes(
                "EXISTING_RESOLVER.signer() does not match GATEWAY_SIGNER_ADDRESS - this is not the resolver the operator described"
            )
        );
        second.run();
    }

    function test_Refuses_ExistingResolverOwnerMismatch() public {
        // G16, owner clause
        TestableDeployL1Resolver first = _newScript();
        DeployL1Resolver.Plan memory firstPlan = first.run();

        TestableDeployL1Resolver second = _newScript();
        second.setExistingResolver(firstPlan.resolver);
        second.setResolverOwner(makeAddr("different-owner"));
        second.setAllowEoaAdmin(true); // else G2 would fire first, on an unrelated guard
        vm.expectRevert(
            bytes(
                "EXISTING_RESOLVER.owner() does not match RESOLVER_OWNER - this is not the resolver the operator described"
            )
        );
        second.run();
    }

    function test_Refuses_ExistingResolverUrlMismatch() public {
        // G16, url clause
        TestableDeployL1Resolver first = _newScript();
        DeployL1Resolver.Plan memory firstPlan = first.run();

        TestableDeployL1Resolver second = _newScript();
        second.setExistingResolver(firstPlan.resolver);
        second.setGatewayUrl("https://events-api.woco-net.com/api/ens-gateway/v1/other/{sender}/{data}");
        vm.expectRevert(
            bytes("EXISTING_RESOLVER.url() does not match GATEWAY_URL - this is not the resolver the operator described")
        );
        second.run();
    }

    /*//////////////////////////////////////////////////////////////
                    G1-G5 - RESOLVER OWNER / GATEWAY SIGNER
    //////////////////////////////////////////////////////////////*/

    function test_Refuses_ZeroResolverOwner() public {
        TestableDeployL1Resolver script = _newScript();
        script.setResolverOwner(address(0));
        vm.expectRevert(bytes("RESOLVER_OWNER must not be the zero address"));
        script.run();
    }

    function test_Refuses_EoaResolverOwner() public {
        TestableDeployL1Resolver script = _newScript();
        script.setResolverOwner(makeAddr("bare-key-owner"));
        vm.expectRevert(
            bytes(
                "RESOLVER_OWNER has no code - expected a multisig; the owner holds setURL/setSigner, i.e. who may forge every subname; set ALLOW_EOA_ADMIN=true for testnet"
            )
        );
        script.run();
    }

    function test_Deploy_AllowsEoaResolverOwnerWithTheTestnetEscapeHatch() public {
        address eoa = makeAddr("bare-key-owner");
        TestableDeployL1Resolver script = _newScript();
        script.setResolverOwner(eoa);
        script.setAllowEoaAdmin(true);
        DeployL1Resolver.Plan memory plan = script.run();
        assertEq(L1Resolver(plan.resolver).owner(), eoa);
    }

    function test_Refuses_ZeroGatewaySigner() public {
        TestableDeployL1Resolver script = _newScript();
        script.setGatewaySigner(address(0));
        vm.expectRevert(bytes("GATEWAY_SIGNER_ADDRESS must not be the zero address"));
        script.run();
    }

    function test_Refuses_GatewaySignerEqualsSponsor() public {
        TestableDeployL1Resolver script = _newScript();
        script.setGatewaySigner(SCRIPT_SPONSOR);
        vm.expectRevert(
            bytes("GATEWAY_SIGNER_ADDRESS must not equal SPONSOR_ADDRESS - the gateway key must be a new hot key, never the sponsor's")
        );
        script.run();
    }

    function test_Refuses_GatewaySignerEqualsDeployer() public {
        TestableDeployL1Resolver script = _newScript();
        script.setGatewaySigner(vm.addr(SCRIPT_DEPLOYER_PK));
        vm.expectRevert(
            bytes(
                "GATEWAY_SIGNER_ADDRESS must not equal the deployer - the deployer key lives in contracts/.env, it is not the gateway's key"
            )
        );
        script.run();
    }

    /*//////////////////////////////////////////////////////////////
                        G6 - GATEWAY_URL TEMPLATE
    //////////////////////////////////////////////////////////////*/

    function test_Refuses_GatewayUrlMissingSenderPlaceholder() public {
        TestableDeployL1Resolver script = _newScript();
        script.setGatewayUrl("https://events-api.woco-net.com/api/ens-gateway/v1/{data}");
        vm.expectRevert(bytes("GATEWAY_URL must contain the literal substring {sender}"));
        script.run();
    }

    function test_Refuses_GatewayUrlMissingDataPlaceholder() public {
        TestableDeployL1Resolver script = _newScript();
        script.setGatewayUrl("https://events-api.woco-net.com/api/ens-gateway/v1/{sender}");
        vm.expectRevert(
            bytes(
                "GATEWAY_URL must contain the literal substring {data} - without it clients POST and the gateway route is GET-only, so every lookup fails"
            )
        );
        script.run();
    }

    /*//////////////////////////////////////////////////////////////
                    G7-G8 - L2 INPUTS / ENS SANITY
    //////////////////////////////////////////////////////////////*/

    function test_Refuses_ZeroL2ChainId() public {
        TestableDeployL1Resolver script = _newScript();
        script.setL2ChainId(0);
        vm.expectRevert(bytes("L2_CHAIN_ID must not be zero"));
        script.run();
    }

    function test_Refuses_ZeroL2RegistryAddress() public {
        TestableDeployL1Resolver script = _newScript();
        script.setL2RegistryAddress(address(0));
        vm.expectRevert(bytes("L2_REGISTRY_ADDRESS must not be the zero address"));
        script.run();
    }

    function test_Refuses_EnsHasNoCode() public {
        vm.etch(ENS_ADDRESS, "");
        TestableDeployL1Resolver script = _newScript();
        vm.expectRevert(bytes("the canonical ENS registry has no code on this chain - are you pointed at an L2 by mistake?"));
        script.run();
    }

    /*//////////////////////////////////////////////////////////////
                    G9 - L2 DEPLOYMENT RECORD CROSS-CHECK
    //////////////////////////////////////////////////////////////*/

    function test_Refuses_DeploymentRecordChainIdMismatch() public {
        TestableDeployL1Resolver script = _newScript();
        script.setL2ChainId(1);
        vm.expectRevert(bytes("L2_DEPLOYMENT_RECORD chainId does not match L2_CHAIN_ID"));
        script.run();
    }

    function test_Refuses_DeploymentRecordRegistryMismatch() public {
        TestableDeployL1Resolver script = _newScript();
        script.setL2RegistryAddress(makeAddr("different-registry"));
        vm.expectRevert(bytes("L2_DEPLOYMENT_RECORD l2Registry does not match L2_REGISTRY_ADDRESS"));
        script.run();
    }

    function test_Refuses_DeploymentRecordBaseNodeMismatch() public {
        // A different parent hashes to a different node than the record's
        // baseNode (namehash("woco.eth")), while chainId/registry still match.
        TestableDeployL1Resolver script = _newScript();
        script.setParentName("other.eth");
        vm.expectRevert(
            bytes(
                "L2_DEPLOYMENT_RECORD baseNode does not match namehash(PARENT_NAME) - the L2 registry was built for a different parent, every subname would silently resolve to nothing"
            )
        );
        script.run();
    }

    /// A genuine record can never have baseNode right and parentName wrong at
    /// the same time - baseNode IS namehash(parentName), deterministically. So
    /// this builds a synthetic fixture: chainId/l2Registry/baseNode all agree
    /// with the script's inputs, but the parentName field is a different
    /// string, as a hand-corrupted record would be. That isolates the
    /// parentName clause from the baseNode clause it would otherwise always
    /// fail alongside.
    function test_Refuses_DeploymentRecordParentNameMismatch() public {
        string memory path = "deployments/31337-l1resolver-g9-fixture.json";
        string memory obj = "g9-fixture";
        vm.serializeUint(obj, "chainId", uint256(L2_CHAIN_ID));
        vm.serializeAddress(obj, "l2Registry", L2_REGISTRY_ADDRESS);
        vm.serializeBytes32(obj, "baseNode", node);
        string memory json = vm.serializeString(obj, "parentName", "not-woco.eth");
        vm.writeJson(json, path);

        TestableDeployL1Resolver script = _newScript();
        script.setL2DeploymentRecord(path);

        vm.expectRevert(bytes("L2_DEPLOYMENT_RECORD parentName does not match PARENT_NAME"));
        script.run();

        vm.removeFile(path);
    }

    /*//////////////////////////////////////////////////////////////
                    G10 - PARENT_NAME MUST BE REGISTERED
    //////////////////////////////////////////////////////////////*/

    function test_Refuses_UnregisteredName() public {
        ens.setOwner(node, address(0));
        TestableDeployL1Resolver script = _newScript();
        vm.expectRevert(bytes("PARENT_NAME is not registered - ens.owner(node) is the zero address"));
        script.run();
    }

    /*//////////////////////////////////////////////////////////////
                        G11-G12 - FALLBACK_RESOLVER
    //////////////////////////////////////////////////////////////*/

    function test_Refuses_ZeroFallbackResolver() public {
        TestableDeployL1Resolver script = _newScript();
        script.setFallbackResolver(address(0));
        vm.expectRevert(bytes("FALLBACK_RESOLVER must not be the zero address"));
        script.run();
    }

    function test_Refuses_CodelessFallbackResolver() public {
        TestableDeployL1Resolver script = _newScript();
        script.setFallbackResolver(makeAddr("codeless-fallback"));
        vm.expectRevert(bytes("FALLBACK_RESOLVER has no code"));
        script.run();
    }

    function test_Refuses_FallbackResolverMismatchWithCurrentResolver() public {
        MockPublicResolver otherResolver = new MockPublicResolver();
        TestableDeployL1Resolver script = _newScript();
        script.setFallbackResolver(address(otherResolver));
        vm.expectRevert(
            bytes("FALLBACK_RESOLVER does not match the name's CURRENT resolver - set ALLOW_FALLBACK_MISMATCH=true to override")
        );
        script.run();
    }

    function test_Deploy_AllowsFallbackResolverMismatchWithTheEscapeHatch() public {
        MockPublicResolver otherResolver = new MockPublicResolver();
        TestableDeployL1Resolver script = _newScript();
        script.setFallbackResolver(address(otherResolver));
        script.setAllowFallbackMismatch(true);
        DeployL1Resolver.Plan memory plan = script.run();

        assertEq(
            plan.setFallbackResolverCall,
            abi.encodeCall(L1Resolver.setFallbackResolver, (node, address(otherResolver))),
            "plan did not target the mismatched fallback"
        );
    }

    /*//////////////////////////////////////////////////////////////
                    G13-G14 - NAME WRAPPER / #420 CUSTODY
    //////////////////////////////////////////////////////////////*/

    function test_Refuses_ResolverWithNoNameWrapper() public {
        // Break namewrapper.eth's resolver so the constructor reads a zero
        // wrapper address - a STATICCALL to a zero-address `addr()` would not
        // revert, it would just return the wrong thing, exactly like the
        // real-world misconfiguration this guard exists to catch.
        ens.setResolver(WRAPPER_NODE, address(new MockAddrResolver(address(0))));

        TestableDeployL1Resolver script = _newScript();
        vm.expectRevert(bytes("the deployed/reused resolver's nameWrapper is the zero address"));
        script.run();
    }

    /// G17. Plan-only mode, rerun after the swap has already happened, with
    /// the fallback-mismatch override on (the only way past G12 in that state):
    /// the "rollback" would point the name at the resolver it already uses.
    function test_Refuses_PlanWhoseRollbackWouldBeANoOp() public {
        TestableDeployL1Resolver first = _newScript();
        DeployL1Resolver.Plan memory firstPlan = first.run();
        vm.prank(nameOwner);
        (bool ok,) = firstPlan.swapTarget.call(firstPlan.swapCall);
        assertTrue(ok, "swap call failed");

        TestableDeployL1Resolver second = _newScript();
        second.setExistingResolver(firstPlan.resolver);
        second.setAllowFallbackMismatch(true);
        vm.expectRevert(
            bytes(
                "PARENT_NAME already points at this resolver - the printed rollback would be a no-op; take the rollback target from the record of the run that preceded the swap"
            )
        );
        second.run();
    }

    function test_Refuses_NameOwnerMismatch_TheCustodyGuard() public {
        TestableDeployL1Resolver script = _newScript();
        script.setExpectNameOwner(makeAddr("wrong-expected-owner"));
        vm.expectRevert(
            bytes(
                "#420 custody: PARENT_NAME's effective owner does not match EXPECT_NAME_OWNER - the printed transactions are for this signer, and on mainnet it must be the Safe, not the hot key"
            )
        );
        script.run();
    }
}

/*//////////////////////////////////////////////////////////////
                        CONFIGURATION VARIANT
//////////////////////////////////////////////////////////////*/

/// @dev Stores the whole `Config` in storage (test-set via these setters)
/// rather than reading the environment for anything beyond the two shared
/// keys handled by `ScriptEnvFixture` - see that file's header for why.
/// `_config()` is `view`, which is exactly why the override has to read
/// from storage the test populated beforehand rather than compute anything.
contract TestableDeployL1Resolver is DeployL1Resolver {
    Config internal cfg;

    constructor(
        uint256 deployerPk_,
        address sponsor_,
        address gatewaySigner_,
        address resolverOwner_,
        address l2RegistryAddress_,
        address fallbackResolver_,
        address expectNameOwner_
    ) {
        cfg.deployerPk = deployerPk_;
        cfg.sponsor = sponsor_;
        cfg.gatewaySigner = gatewaySigner_;
        cfg.resolverOwner = resolverOwner_;
        cfg.l2ChainId = 421614;
        cfg.l2RegistryAddress = l2RegistryAddress_;
        cfg.fallbackResolver = fallbackResolver_;
        cfg.expectNameOwner = expectNameOwner_;
        cfg.parentName = "woco.eth";
        cfg.gatewayUrl = "https://events-api.woco-net.com/api/ens-gateway/v1/{sender}/{data}";
        cfg.l2DeploymentRecord = "deployments/421614-subens.json";
        cfg.allowEoaAdmin = false;
        cfg.allowFallbackMismatch = false;
        cfg.writeDeploymentRecord = false;
        cfg.existingResolver = address(0);
    }

    function _config() internal view override returns (Config memory) {
        return cfg;
    }

    function setDeployerPk(uint256 v) external {
        cfg.deployerPk = v;
    }

    function setSponsor(address v) external {
        cfg.sponsor = v;
    }

    function setGatewaySigner(address v) external {
        cfg.gatewaySigner = v;
    }

    function setResolverOwner(address v) external {
        cfg.resolverOwner = v;
    }

    function setL2ChainId(uint64 v) external {
        cfg.l2ChainId = v;
    }

    function setL2RegistryAddress(address v) external {
        cfg.l2RegistryAddress = v;
    }

    function setFallbackResolver(address v) external {
        cfg.fallbackResolver = v;
    }

    function setExpectNameOwner(address v) external {
        cfg.expectNameOwner = v;
    }

    function setParentName(string memory v) external {
        cfg.parentName = v;
    }

    function setGatewayUrl(string memory v) external {
        cfg.gatewayUrl = v;
    }

    function setL2DeploymentRecord(string memory v) external {
        cfg.l2DeploymentRecord = v;
    }

    function setAllowEoaAdmin(bool v) external {
        cfg.allowEoaAdmin = v;
    }

    function setAllowFallbackMismatch(bool v) external {
        cfg.allowFallbackMismatch = v;
    }

    function setWriteDeploymentRecord(bool v) external {
        cfg.writeDeploymentRecord = v;
    }

    function setExistingResolver(address v) external {
        cfg.existingResolver = v;
    }
}

/// @dev A contract, because `RESOLVER_OWNER` must not be a bare key (G2).
contract MockSafe {}
