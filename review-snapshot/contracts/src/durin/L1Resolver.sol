// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ***********************************************
// ▗▖  ▗▖ ▗▄▖ ▗▖  ▗▖▗▄▄▄▖ ▗▄▄▖▗▄▄▄▖▗▄▖ ▗▖  ▗▖▗▄▄▄▖
// ▐▛▚▖▐▌▐▌ ▐▌▐▛▚▞▜▌▐▌   ▐▌     █ ▐▌ ▐▌▐▛▚▖▐▌▐▌
// ▐▌ ▝▜▌▐▛▀▜▌▐▌  ▐▌▐▛▀▀▘ ▝▀▚▖  █ ▐▌ ▐▌▐▌ ▝▜▌▐▛▀▀▘
// ▐▌  ▐▌▐▌ ▐▌▐▌  ▐▌▐▙▄▄▖▗▄▄▞▘  █ ▝▚▄▞▘▐▌  ▐▌▐▙▄▄▖
// ***********************************************

import {ENS} from "@ensdomains/ens-contracts/registry/ENS.sol";
import {IExtendedResolver} from "@ensdomains/ens-contracts/resolvers/profiles/IExtendedResolver.sol";
import {NameEncoder} from "@ensdomains/ens-contracts/utils/NameEncoder.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {strings} from "@arachnid/string-utils/strings.sol";

import {ENSDNSUtils} from "./lib/ENSDNSUtils.sol";
import {SignatureVerifier} from "./lib/SignatureVerifier.sol";

interface IResolverService {
    function stuffedResolveCall(
        bytes calldata name,
        bytes calldata data,
        uint64 targetChainId,
        address targetRegistryAddress
    )
        external
        view
        returns (bytes memory result, uint64 expires, bytes memory sig);
}

interface IResolver {
    function addr(bytes32 node) external view returns (address);
}

interface INameWrapper {
    function ownerOf(uint256 id) external view returns (address owner);
}

/// @author NameStone
/// @notice ENS resolver that directs all queries to a CCIP Read gateway.
/// @dev Callers must implement EIP-3668 and ENSIP-10.
///
/// ┌──────────────────────────────────────────────────────────────────────────┐
/// │ VENDORED + MODIFIED BY WOCO — this is NOT pristine upstream Durin.        │
/// │                                                                          │
/// │ WoCo addition (WoCo-Event-App #419), opt-in and inert until used:         │
/// │   · `fallbackResolver` + `setFallbackResolver` + event                    │
/// │   · error `FallbackResolverHasNoCode`                                     │
/// │   · the apex branch in `resolve()`                                        │
/// │                                                                          │
/// │ With no fallback set, `resolve()` behaves exactly as upstream does —      │
/// │ pinned by test/L1ResolverFallback.t.sol, which compares the OffchainLookup│
/// │ revert data byte for byte against an independently built expectation.     │
/// │                                                                          │
/// │ Unlike the registry this contract is REPLACEABLE: pointing a name         │
/// │ elsewhere is one `setResolver` by the name owner and touches no name on   │
/// │ L2. That is what makes the Unruggable-proofs upgrade a post-launch item.  │
/// └──────────────────────────────────────────────────────────────────────────┘
contract L1Resolver is IExtendedResolver, Ownable {
    /*//////////////////////////////////////////////////////////////
                                STRUCTS
    //////////////////////////////////////////////////////////////*/

    struct L2Registry {
        uint64 chainId;
        address registryAddress;
    }

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    ENS public constant ens = ENS(0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e);

    /*//////////////////////////////////////////////////////////////
                            STATE VARIABLES
    //////////////////////////////////////////////////////////////*/

    string public url;
    address public signer;
    INameWrapper public immutable nameWrapper;

    mapping(bytes32 node => L2Registry l2Registry) public l2Registry;

    /// @notice Per-name opt-in L1 resolver consulted for the name ITSELF, never
    ///         for anything beneath it (WoCo addition, #419).
    /// @dev Unset (the default) is upstream behaviour exactly: every query,
    ///      including one for the name itself, becomes an OffchainLookup.
    mapping(bytes32 node => address resolver) public fallbackResolver;

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event L2RegistrySet(
        bytes32 node,
        uint64 targetChainId,
        address targetRegistryAddress
    );
    event GatewayChanged(string url);
    event SignerChanged(address signer);
    event FallbackResolverSet(bytes32 node, address fallbackResolver);

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error Unauthorized();
    error InvalidSignature();
    error UnsupportedName();
    error FallbackResolverHasNoCode(address resolver);
    error OffchainLookup(
        address sender,
        string[] urls,
        bytes callData,
        bytes4 callbackFunction,
        bytes extraData
    );

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(
        string memory _url,
        address _signer,
        address _owner
    ) Ownable(_owner) {
        url = _url;
        emit GatewayChanged(_url);
        signer = _signer;
        emit SignerChanged(_signer);

        // Get the NameWrapper address from namewrapper.eth
        // This allows us to have the same deploy bytecode on mainnet and sepolia
        bytes32 _wrapperNode = 0xdee478ba2734e34d81c6adc77a32d75b29007895efa2fe60921f1c315e1ec7d9;
        address _wrapperResolver = ens.resolver(_wrapperNode);
        address _wrapperAddr = IResolver(_wrapperResolver).addr(_wrapperNode);
        nameWrapper = INameWrapper(_wrapperAddr);
    }

    /*//////////////////////////////////////////////////////////////
                            PUBLIC FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Specify the L2 registry for a given name. Should only be used with 2LDs, e.g. "nick.eth".
    function setL2Registry(
        bytes32 node,
        uint64 targetChainId,
        address targetRegistryAddress
    ) external {
        _requireNameOwner(node);

        l2Registry[node] = L2Registry(targetChainId, targetRegistryAddress);
        emit L2RegistrySet(node, targetChainId, targetRegistryAddress);
    }

    /// @notice Point queries for `node` ITSELF at an ordinary L1 resolver,
    ///         instead of sending them offchain. Set `r` to the zero address to
    ///         undo it. Should only be used with 2LDs, e.g. "nick.eth".
    ///
    /// @dev WoCo addition (#419). It exists for one problem: `resolve()` takes
    ///      the last two labels of any name as the parent, so once a 2LD points
    ///      here, a query for the 2LD itself is forwarded offchain like a
    ///      subname would be — and `woco.eth`'s own contenthash, which is the
    ///      WoCo app, stops resolving. Mirroring that record into L2 was the
    ///      alternative, and it would have made the app's address depend on a
    ///      hot signer, an L2 RPC and an API server: a trust AND availability
    ///      regression from a static L1 record.
    ///
    ///      Pointed at the ENS Public Resolver, the apex keeps answering from
    ///      the L1 storage that already holds every record — `setResolver` on
    ///      the ENS registry changes a pointer, it does not move records — so
    ///      there is nothing to migrate and nothing to keep in sync.
    ///
    ///      SCOPE, deliberately narrow: `resolve()` consults this ONLY when the
    ///      queried name is the parent itself. Subnames are unaffected, which is
    ///      the property the whole design rests on and is pinned by its own test.
    ///
    ///      Authorisation is the ENS name owner, exactly as `setL2Registry` —
    ///      NOT this contract's `owner()`. Whoever controls the name decides
    ///      where the name answers from.
    ///
    ///      A non-zero `r` with no code is refused. A STATICCALL to an empty
    ///      address succeeds with empty return data, so a mistyped cutover
    ///      would have the apex answer "no record" — the app vanishing with no
    ///      error anywhere, which is precisely the failure `_resolveOnFallback`
    ///      refuses to produce by swallowing a revert. Checked at set time, on
    ///      the cold path, so `resolve()` gains no code.
    function setFallbackResolver(bytes32 node, address r) external {
        _requireNameOwner(node);
        if (r != address(0) && r.code.length == 0) {
            revert FallbackResolverHasNoCode(r);
        }

        fallbackResolver[node] = r;
        emit FallbackResolverSet(node, r);
    }

    /// @notice Resolves a name, as specified by ENSIP 10.
    /// @param name The DNS-encoded name to resolve.
    /// @param data The ABI encoded data for the underlying resolution function (Eg, addr(bytes32), text(bytes32,string), etc).
    /// @return The return data, ABI encoded identically to the underlying function.
    function resolve(
        bytes calldata name,
        bytes calldata data
    ) external view override returns (bytes memory) {
        string memory decodedName = ENSDNSUtils.dnsDecode(name); // 'sub.name.eth'
        strings.slice memory s = strings.toSlice(decodedName);
        strings.slice memory delim = strings.toSlice(".");
        string[] memory parts = new string[](strings.count(s, delim) + 1);

        // Populate the parts array into ['sub', 'name', 'eth']
        for (uint i = 0; i < parts.length; i++) {
            parts[i] = strings.toString(strings.split(s, delim));
        }

        // get the 2LD + TLD (final 2 parts), regardless of how many labels the name has
        string memory parentName = string.concat(
            parts[parts.length - 2],
            ".",
            parts[parts.length - 1]
        );

        // Encode the parent name
        (, bytes32 parentNode) = NameEncoder.dnsEncodeName(parentName);

        // The queried name IS the parent (`parts` is ['woco','eth'], not
        // ['sub','woco','eth']). If its owner has opted in, answer from L1 and
        // never reach the gateway — see `setFallbackResolver`.
        if (parts.length == 2) {
            address l1Fallback = fallbackResolver[parentNode];
            if (l1Fallback != address(0)) {
                return _resolveOnFallback(l1Fallback, data);
            }
        }

        L2Registry memory targetL2Registry = l2Registry[parentNode];

        return
            stuffedResolveCall(
                name,
                data,
                targetL2Registry.chainId,
                targetL2Registry.registryAddress
            );
    }

    /// @notice Callback used by CCIP read compatible clients to parse and verify the response.
    function resolveWithProof(
        bytes calldata response,
        bytes calldata extraData
    ) external view returns (bytes memory) {
        (address _signer, bytes memory result) = SignatureVerifier.verify(
            extraData,
            response
        );

        if (_signer != signer) {
            revert InvalidSignature();
        }

        return result;
    }

    function supportsInterface(bytes4 interfaceID) public pure returns (bool) {
        return
            interfaceID == type(IExtendedResolver).interfaceId ||
            interfaceID == 0x01ffc9a7; // ERC-165 interface
    }

    /*//////////////////////////////////////////////////////////////
                            ADMIN FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Sets the URL for the resolver service.
    function setURL(string calldata _url) external onlyOwner {
        url = _url;
        emit GatewayChanged(_url);
    }

    /// @notice Sets the signers for the resolver service.
    function setSigner(address _signer) external onlyOwner {
        signer = _signer;
        emit SignerChanged(_signer);
    }

    /*//////////////////////////////////////////////////////////////
                           INTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @dev Reverts unless `msg.sender` owns `node` in the ENS registry,
    ///      unwrapping through the NameWrapper when it holds the name.
    function _requireNameOwner(bytes32 node) internal view {
        address owner = ens.owner(node);

        if (owner == address(nameWrapper)) {
            owner = nameWrapper.ownerOf(uint256(node));
        }

        if (owner != msg.sender) {
            revert Unauthorized();
        }
    }

    /// @dev Forwards the ENSIP-10 inner call to an ordinary L1 resolver and
    ///      returns its answer as `resolve()`'s return data.
    ///
    ///      A failure is bubbled, never swallowed. Returning empty bytes on
    ///      revert would turn "this resolver could not answer" into a confident
    ///      "there is no record", which for a contenthash query is the app
    ///      silently disappearing rather than visibly erroring.
    ///
    ///      RESIDUAL, stated so it is not rediscovered: the inner `data` is
    ///      passed through unexamined, so a caller that hand-builds a query can
    ///      have this contract read a record for a node OTHER than the name it
    ///      asked about. It grants no access — the fallback is a public resolver
    ///      anyone may call directly for the same answer — and honest clients
    ///      (the Universal Resolver, ethers, viem, eth.limo) build `data` from
    ///      the name they are resolving. The gateway performs the equivalent
    ///      node check on the offchain path, where a signature makes it matter.
    function _resolveOnFallback(
        address l1Fallback,
        bytes calldata data
    ) internal view returns (bytes memory) {
        (bool ok, bytes memory result) = l1Fallback.staticcall(data);
        if (!ok) {
            assembly {
                revert(add(result, 0x20), mload(result))
            }
        }
        return result;
    }

    /// @dev Add target registry info to the CCIP Read error.
    function stuffedResolveCall(
        bytes calldata name,
        bytes calldata data,
        uint64 targetChainId,
        address targetRegistryAddress
    ) internal view returns (bytes memory) {
        bytes memory callData = abi.encodeWithSelector(
            IResolverService.stuffedResolveCall.selector,
            name,
            data,
            targetChainId,
            targetRegistryAddress
        );

        string[] memory urls = new string[](1);
        urls[0] = url;

        revert OffchainLookup(
            address(this), // sender
            urls, // urls
            callData, // callData
            L1Resolver.resolveWithProof.selector, // callbackFunction
            callData // extraData
        );
    }
}
