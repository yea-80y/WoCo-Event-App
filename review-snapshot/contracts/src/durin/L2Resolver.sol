// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ***********************************************
// ▗▖  ▗▖ ▗▄▖ ▗▖  ▗▖▗▄▄▄▖ ▗▄▄▖▗▄▄▄▖▗▄▖ ▗▖  ▗▖▗▄▄▄▖
// ▐▛▚▖▐▌▐▌ ▐▌▐▛▚▞▜▌▐▌   ▐▌     █ ▐▌ ▐▌▐▛▚▖▐▌▐▌
// ▐▌ ▝▜▌▐▛▀▜▌▐▌  ▐▌▐▛▀▀▘ ▝▀▚▖  █ ▐▌ ▐▌▐▌ ▝▜▌▐▛▀▀▘
// ▐▌  ▐▌▐▌ ▐▌▐▌  ▐▌▐▙▄▄▖▗▄▄▞▘  █ ▝▚▄▞▘▐▌  ▐▌▐▙▄▄▖
// ***********************************************

import {ABIResolver} from "@ensdomains/ens-contracts/resolvers/profiles/ABIResolver.sol";
import {AddrResolver} from "@ensdomains/ens-contracts/resolvers/profiles/AddrResolver.sol";
import {ContentHashResolver} from "@ensdomains/ens-contracts/resolvers/profiles/ContentHashResolver.sol";
import {ExtendedResolver} from "@ensdomains/ens-contracts/resolvers/profiles/ExtendedResolver.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Multicallable} from "@ensdomains/ens-contracts/resolvers/Multicallable.sol";
import {TextResolver} from "@ensdomains/ens-contracts/resolvers/profiles/TextResolver.sol";

import {IUniversalSignatureValidator} from "./interfaces/IUniversalSignatureValidator.sol";
import {L2Registry} from "./L2Registry.sol";

/// @title Durin Resolver
/// @author NameStone
/// @notice Resolver to store standard ENS records
/// @dev This contract is inherited by L2Registry, making registry methods available via `address(this)`
contract L2Resolver is
    Multicallable,
    ABIResolver,
    AddrResolver,
    ContentHashResolver,
    TextResolver,
    ExtendedResolver
{
    using MessageHashUtils for bytes32;

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @dev ERC-6492: Signature Validation for Predeploy Contracts.
    ///      WoCo modification (WoCo-Event-App #464): `private` → `internal` so the
    ///      inheriting `L2Registry` can run `releaseWithSignature` through the
    ///      same validator these setters use. No other change to this file.
    IUniversalSignatureValidator internal immutable universalSignatureValidator =
        IUniversalSignatureValidator(
            0x164af34fAF9879394370C7f09064127C043A35E9
        );

    /*//////////////////////////////////////////////////////////////
                            STATE VARIABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice How many signed record writes a name has already consumed. Part
    ///         of the message every `*WithSignature` setter verifies, and bumped
    ///         by each of them.
    ///
    /// @dev WoCo addition (WoCo-Contracts #10). WHY IT EXISTS: without it a
    ///      signature stayed valid until its `expiration`, and the calldata that
    ///      carried it is public — so anyone could resubmit a used signature and
    ///      re-apply the record the holder had since changed. Folding this
    ///      counter into the preimage is what makes a used signature dead: the
    ///      message the holder signed names the counter value it was signed at,
    ///      and that value is gone the moment the signature lands.
    ///
    ///      WHY PER NAME rather than per signer: the history being protected
    ///      belongs to the NAME. A name changes hands — sold, released and
    ///      re-minted, reassigned by `adminTransfer` — and its records travel
    ///      with it, so the replay window that matters is "against this node",
    ///      not "by this key". A per-signer counter would leave a previous
    ///      holder's unspent signatures live against the name after it moved.
    ///
    ///      WHY IT IS NEVER RESET — not by `release`, not by a re-mint of the
    ///      same label, not by `clearRecords`: monotonic is the whole guarantee.
    ///      If any of those put it back to zero, a signature from a previous
    ///      holder's era would line up with a later counter value and become
    ///      live again against a name they no longer hold. Only ever `++`.
    mapping(bytes32 node => uint256) public nonces;

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error Unauthorized(bytes32 node);
    error SignatureExpired();

    /*//////////////////////////////////////////////////////////////
                               MODIFIERS
    //////////////////////////////////////////////////////////////*/

    modifier unexpiredSignature(uint256 expiration) {
        if (block.timestamp > expiration) {
            revert SignatureExpired();
        }
        _;
    }

    /*//////////////////////////////////////////////////////////////
                            PUBLIC FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @dev THE PREIMAGE ALL FOUR SIGNED SETTERS SHARE, stated once here rather
    ///      than four times below (WoCo, WoCo-Contracts #10):
    ///
    ///        keccak256(abi.encode(
    ///            address(this), block.chainid, node,
    ///            <this setter's record fields, in its parameter order>,
    ///            nonces[node], expiration
    ///        )).toEthSignedMessageHash()
    ///
    ///      `block.chainid`: a CREATE address is a function of the deployer and
    ///      its nonce only, so the same deployer can land a clone at the same
    ///      address on two chains — `address(this)` alone does not say WHICH
    ///      chain, and a signature made on testnet would otherwise be
    ///      submittable on mainnet.
    ///      `nonces[node]`: see the mapping above; it is what kills a used
    ///      signature. `abi.encode` rather than `abi.encodePacked` for all four:
    ///      packing gives dynamic fields no boundary (the text setter's finding,
    ///      documented at that setter), and one uniform formula is one thing for
    ///      every client to implement rather than four near-misses.
    ///
    ///      All four read the counter into a local `nonce` before hashing, which
    ///      is the same value in the same position — two of them are otherwise
    ///      one stack slot too deep for the legacy codegen pipeline, and having
    ///      the four differ in shape would invite the reader to look for a
    ///      difference in meaning.
    ///
    ///      This contract is deployed as an unpatchable EIP-1167 clone, so this
    ///      formula is frozen from the mainnet deploy onward. The pinned-digest
    ///      tests in test/L2ResolverSignatureNonce.t.sol are the reference.
    function setAddrWithSignature(
        bytes32 node,
        uint256 coinType,
        bytes memory a,
        uint256 expiration,
        address signer,
        bytes calldata signature
    ) public unexpiredSignature(expiration) {
        uint256 nonce = nonces[node];
        bytes32 sigHash = keccak256(
            abi.encode(
                address(this),
                block.chainid,
                node,
                coinType,
                a,
                nonce,
                expiration
            )
        ).toEthSignedMessageHash();

        if (
            !isAuthorisedForAddress(signer, node) ||
            !universalSignatureValidator.isValidSig(signer, sigHash, signature)
        ) {
            revert Unauthorized(node);
        }

        // Spend the nonce the signature named. No separate "nonce used" error:
        // a stale or wrong-nonce signature simply hashes to a different message,
        // fails `isValidSig` above, and comes out as `Unauthorized(node)`.
        unchecked {
            nonces[node]++;
        }

        // Manually update storage since `setAddr()` on the inherited contract
        // carries `authorised(node)`, which checks `msg.sender` — the relayer —
        // and not the signer; #13. Mirrors `AddrResolver.setAddr` exactly,
        // event order included, so a relayed write is indistinguishable from a
        // direct one to any indexer.
        emit AddressChanged(node, coinType, a);
        // 60 is `COIN_TYPE_ETH`, which is `private` in `AddrResolver` and so
        // cannot be named from here.
        if (coinType == 60) {
            emit AddrChanged(node, bytesToAddress(a));
        }
        versionable_addresses[recordVersions[node]][node][coinType] = a;
    }

    function setTextWithSignature(
        bytes32 node,
        string memory key,
        string memory value,
        uint256 expiration,
        address signer,
        bytes calldata signature
    ) public unexpiredSignature(expiration) {
        // WoCo modification (found reviewing PR #8): this setter is the sharpest
        // case for `abi.encode`, because it is the only one of the four that puts
        // TWO dynamic fields in the preimage, and `abi.encodePacked` records no
        // boundary between them — a signature over ("url", "https://a") is
        // byte-for-byte a signature over ("ur", "lhttps://a"), so a holder's
        // signature for one key could be replayed to write any key formed by
        // sliding that split. `abi.encode` length-prefixes each string, which pins
        // the split the holder actually signed. All four setters encode this way
        // now (#10); see the formula above `setAddrWithSignature`.
        uint256 nonce = nonces[node];
        bytes32 sigHash = keccak256(
            abi.encode(
                address(this),
                block.chainid,
                node,
                key,
                value,
                nonce,
                expiration
            )
        ).toEthSignedMessageHash();

        if (
            !isAuthorisedForAddress(signer, node) ||
            !universalSignatureValidator.isValidSig(signer, sigHash, signature)
        ) {
            revert Unauthorized(node);
        }

        // Spend the nonce the signature named; a stale one now reverts
        // `Unauthorized(node)` from the check above.
        unchecked {
            nonces[node]++;
        }

        // Manually update storage since `setText()` on the inherited contract cannot be called internally
        versionable_texts[recordVersions[node]][node][key] = value;
        emit TextChanged(node, key, key, value);
    }

    function setContenthashWithSignature(
        bytes32 node,
        bytes memory hash,
        uint256 expiration,
        address signer,
        bytes calldata signature
    ) public unexpiredSignature(expiration) {
        uint256 nonce = nonces[node];
        bytes32 sigHash = keccak256(
            abi.encode(
                address(this),
                block.chainid,
                node,
                hash,
                nonce,
                expiration
            )
        ).toEthSignedMessageHash();

        if (
            !isAuthorisedForAddress(signer, node) ||
            !universalSignatureValidator.isValidSig(signer, sigHash, signature)
        ) {
            revert Unauthorized(node);
        }

        // Spend the nonce the signature named; a stale one now reverts
        // `Unauthorized(node)` from the check above.
        unchecked {
            nonces[node]++;
        }

        // Manually update storage since `setContenthash()` on the inherited contract cannot be called internally
        versionable_hashes[recordVersions[node]][node] = hash;
        emit ContenthashChanged(node, hash);
    }

    function setABIWithSignature(
        bytes32 node,
        uint256 contentType,
        bytes memory data,
        uint256 expiration,
        address signer,
        bytes calldata signature
    ) public unexpiredSignature(expiration) {
        uint256 nonce = nonces[node];
        bytes32 sigHash = keccak256(
            abi.encode(
                address(this),
                block.chainid,
                node,
                contentType,
                data,
                nonce,
                expiration
            )
        ).toEthSignedMessageHash();

        if (
            !isAuthorisedForAddress(signer, node) ||
            !universalSignatureValidator.isValidSig(signer, sigHash, signature)
        ) {
            revert Unauthorized(node);
        }

        // Spend the nonce the signature named; a stale one now reverts
        // `Unauthorized(node)` from the check above.
        unchecked {
            nonces[node]++;
        }

        // Content types must be powers of 2
        require(((contentType - 1) & contentType) == 0);

        // Manually update storage since `setABI()` on the inherited contract cannot be called internally
        versionable_abis[recordVersions[node]][node][contentType] = data;
        emit ABIChanged(node, contentType);
    }

    /*//////////////////////////////////////////////////////////////
                           INTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function _registry() internal view returns (L2Registry) {
        return L2Registry(address(this));
    }

    function isAuthorisedForAddress(
        address addr,
        bytes32 node
    ) internal view returns (bool) {
        L2Registry registry = _registry();

        if (registry.registrars(addr)) {
            return true;
        }

        uint256 tokenId = uint256(node);
        address owner = registry.ownerOf(tokenId);

        if ((owner != addr) && (registry.getApproved(tokenId) != addr)) {
            revert Unauthorized(node);
        }

        return true;
    }

    /*//////////////////////////////////////////////////////////////
                           REQUIRED OVERRIDES
    //////////////////////////////////////////////////////////////*/

    /// @dev Reverts instead of returning false so the modifier that uses this function has better error messages
    function isAuthorised(bytes32 node) internal view override returns (bool) {
        return isAuthorisedForAddress(msg.sender, node);
    }

    function supportsInterface(
        bytes4 interfaceId
    )
        public
        view
        virtual
        override(
            Multicallable,
            ABIResolver,
            AddrResolver,
            ContentHashResolver,
            TextResolver
        )
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
