// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ***********************************************
// ▗▖  ▗▖ ▗▄▖ ▗▖  ▗▖▗▄▄▄▖ ▗▄▄▖▗▄▄▄▖▗▄▖ ▗▖  ▗▖▗▄▄▄▖
// ▐▛▚▖▐▌▐▌ ▐▌▐▛▚▞▜▌▐▌   ▐▌     █ ▐▌ ▐▌▐▛▚▖▐▌▐▌
// ▐▌ ▝▜▌▐▛▀▜▌▐▌  ▐▌▐▛▀▀▘ ▝▀▚▖  █ ▐▌ ▐▌▐▌ ▝▜▌▐▛▀▀▘
// ▐▌  ▐▌▐▌ ▐▌▐▌  ▐▌▐▙▄▄▖▗▄▄▞▘  █ ▝▚▄▞▘▐▌  ▐▌▐▙▄▄▖
// ***********************************************

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {IL2Resolver} from "./IL2Resolver.sol";

/// @author NameStone
interface IL2Registry is IL2Resolver, IERC721 {
    // State variables
    function baseNode() external view returns (bytes32);
    function names(bytes32 node) external view returns (bytes memory name);
    function registrars(address registrar) external view returns (bool);

    // Public functions
    function initialize(
        string calldata tokenName,
        string calldata tokenSymbol,
        string calldata baseURI,
        address admin
    ) external;
    function createSubnode(
        bytes32 node,
        string calldata label,
        address owner,
        bytes[] calldata data
    ) external returns (bytes32);
    function owner() external view returns (address);
    function owner(bytes32 node) external view returns (address);
    function namehash(string calldata name) external pure returns (bytes32);
    function decodeName(
        bytes calldata name
    ) external pure returns (string memory);
    function makeNode(
        bytes32 parentNode,
        string calldata label
    ) external pure returns (bytes32);

    // Admin functions
    function addRegistrar(address registrar) external;
    function removeRegistrar(address registrar) external;
    function setBaseURI(string calldata baseURI) external;

    // WoCo additions (WoCo-Event-App #464). Exposed here so a REGISTRAR can
    // read release history when deciding mint policy — the registry itself
    // never reads it.
    function release(bytes32 node) external;
    function releaseWithSignature(
        bytes32 node,
        uint256 expiration,
        address signer,
        bytes calldata signature
    ) external;
    function releaseDigest(bytes32 node, uint256 expiration) external view returns (bytes32);
    function lastRelease(
        bytes32 node
    ) external view returns (address previousOwner, uint64 releasedAt);
}
