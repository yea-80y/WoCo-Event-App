// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IL2Registry} from "./durin/interfaces/IL2Registry.sol";

/// @title WoCoRegistrar
/// @author WoCo
/// @notice Platform-sponsored registrar that mints organiser sub-ENS names
///         (`label.woco.eth`) on a Durin L2Registry on Arbitrum and writes the
///         organiser's Swarm site pointer + profile records in the same flow.
/// @dev Two minting paths:
///      1. `register()` — sponsor submits tx directly (email-only organisers with no wallet).
///      2. `registerWithPermit()` — server signs an off-chain EIP-712 permit; caller
///         (organiser's ZeroDev Kernel or any wallet) submits the tx and pays gas (or paymaster
///         covers it). Fully trustless: the platform signer vouches for the label grant, the
///         chain enforces it. EIP-712 domain separation prevents cross-chain / cross-contract
///         replay of testnet permits on mainnet.
///      The registrar is granted record-setting authority by being added to the registry's
///      `registrars` set (`addRegistrar`), so the platform can update the Swarm pointer for
///      email-only organisers on each redeploy without the organiser signing.
contract WoCoRegistrar is Ownable {
    /// @notice The Durin L2Registry this registrar mints into.
    IL2Registry public immutable registry;

    /// @notice ENSIP-11 coinType for the chain this registrar is deployed on.
    uint256 public immutable coinType;

    /// @notice EIP-712 domain separator — binds permits to this chain + this contract.
    /// @dev Computed once in the constructor; immutable. Prevents replay of a testnet
    ///      permit on mainnet even if the same platformSigner key is reused.
    bytes32 public immutable DOMAIN_SEPARATOR;

    // keccak256("RegisterPermit(string label,address owner,uint256 expiry)")
    bytes32 public constant PERMIT_TYPEHASH =
        0xa899c01319c2d96c76d865f0fa8e4533f1bf4f65cd5814a1564eff695487a2df;

    /// @notice Address whose EIP-712 signature authorises a registerWithPermit call.
    /// @dev For buildathon: same address as the sponsor wallet (one key). Post-buildathon:
    ///      split into cold platform-signer (no ETH) + hot sponsor (holds ETH for sponsored txs).
    address public platformSigner;

    /// @notice Platform wallets permitted to call register() directly (sponsored mint path).
    mapping(address sponsor => bool authorised) public authorisedSponsors;

    /// @notice Consumed permit hashes — prevents replay of a used permit within this contract.
    mapping(bytes32 permitHash => bool used) public usedPermits;

    /// @notice Reserved labels (keyed by labelhash) that can never be minted.
    mapping(bytes32 labelhash => bool reserved) public reserved;

    /// @notice Per-recipient mint accounting for the rate cap. One slot.
    struct MintWindow {
        uint64 start;
        uint32 count;
    }

    /// @notice How many names each RECIPIENT has been minted in its current
    ///         window, and when that window began.
    ///
    /// @dev Keyed on the address that RECEIVES the name, never on
    ///      `msg.sender`. Both mint paths are submitted by someone other than
    ///      the organiser — the sponsor key for `register`, the organiser's
    ///      Kernel or a paymaster for `registerWithPermit` — so a cap keyed on
    ///      the sender would cap the sponsor, i.e. the whole platform, at one
    ///      organiser's allowance.
    ///
    ///      WHAT THIS BOUNDS, stated honestly (WoCo-Event-App #464): a server
    ///      bug that mints for the same account in a loop, and an account that
    ///      churns names through the product. It does NOT bound an attacker
    ///      holding the permit key or the sponsor key, who chooses the
    ///      recipient and can use a fresh one per mint; bounding that needs a
    ///      cap on the registrar as a whole, which is a separate decision with
    ///      a launch-day sizing question attached. This contract is replaceable
    ///      (`addRegistrar` / `removeRegistrar`), so that can follow.
    ///
    ///      Fixed window, anchored at the recipient's first mint in it. At the
    ///      boundary a recipient can therefore mint up to twice the cap across a
    ///      few seconds; accepted for a backstop, in exchange for one slot per
    ///      recipient and no loops.
    mapping(address recipient => MintWindow) public mintWindow;

    /// @notice Names one recipient may be minted per window. Owner-tunable.
    /// @dev Default 30 per 30 days. Sized so no legitimate organiser meets it —
    ///      a profile name, a name per site and a name per event is the intended
    ///      use — and erring HIGH deliberately: the owner is a multisig after
    ///      deploy, so a cap set too low fails a real organiser at the worst
    ///      moment and needs a multisig round to fix, while a cap set high
    ///      costs nothing until abuse that this cap does not bound anyway.
    uint32 public maxMintsPerWindow;

    /// @notice Length of the window in seconds. Owner-tunable.
    uint64 public mintWindowSeconds;

    uint256 public constant MIN_LABEL_LENGTH = 3;
    uint256 public constant MAX_LABEL_LENGTH = 63;

    /// @notice Off-chain server MUST set expiry = block.timestamp + PERMIT_TTL when signing.
    ///         On-chain enforcement is via the expiry field inside the signed digest; this
    ///         constant is the canonical value for the server to reference.
    uint256 public constant PERMIT_TTL = 15 minutes;

    event SponsorAdded(address indexed sponsor);
    event SponsorRemoved(address indexed sponsor);
    event PlatformSignerUpdated(address indexed newSigner);
    event LabelReservedSet(string label, bool reserved);
    event NameRegistered(string indexed label, address indexed owner, bytes contenthash);
    event ContenthashUpdated(string indexed label, bytes contenthash);
    event MintRateCapSet(uint32 maxMintsPerWindow, uint64 mintWindowSeconds);

    error NotAuthorisedSponsor(address caller);
    error LabelIsReserved(string label);
    error InvalidLabel(string label);
    error EmptyContenthash();
    error ArrayLengthMismatch();
    error PermitExpired();
    error PermitAlreadyUsed();
    error PermitInvalid();
    error MintRateCapExceeded(address recipient, uint64 windowResetsAt);
    error InvalidMintRateCap();

    modifier onlySponsor() {
        if (!authorisedSponsors[msg.sender]) revert NotAuthorisedSponsor(msg.sender);
        _;
    }

    constructor(address _registry, address _owner, address _platformSigner) Ownable(_owner) {
        registry = IL2Registry(_registry);
        coinType = (0x80000000 | block.chainid);
        platformSigner = _platformSigner;
        DOMAIN_SEPARATOR = _buildDomainSeparator();

        maxMintsPerWindow = 30;
        mintWindowSeconds = 30 days;
        emit MintRateCapSet(30, 30 days);
    }

    /*//////////////////////////////////////////////////////////////
                                MINTING
    //////////////////////////////////////////////////////////////*/

    /// @notice Sponsor-submitted mint. Used for email-only organisers who have no wallet.
    function register(
        string calldata label,
        address owner_,
        bytes calldata contenthash,
        string[] calldata textKeys,
        string[] calldata textValues
    ) external onlySponsor returns (bytes32 node) {
        return _register(label, owner_, contenthash, textKeys, textValues);
    }

    /// @notice Permit-gated mint. The organiser (or their paymaster) submits this tx;
    ///         the server only signs an off-chain EIP-712 permit — no on-chain platform tx needed.
    /// @param label        The subname label (validated on-chain).
    /// @param owner_       The address that will own the subname NFT (the organiser).
    /// @param contenthash  Swarm site pointer (ENS contenthash bytes); skipped if empty.
    /// @param textKeys     Profile text-record keys.
    /// @param textValues   Matching text-record values.
    /// @param expiry       Unix timestamp after which this permit is void. Server sets this to
    ///                     block.timestamp + PERMIT_TTL at signing time.
    /// @param sig          EIP-712 signature by platformSigner over the RegisterPermit struct.
    function registerWithPermit(
        string calldata label,
        address owner_,
        bytes calldata contenthash,
        string[] calldata textKeys,
        string[] calldata textValues,
        uint256 expiry,
        bytes calldata sig
    ) external returns (bytes32 node) {
        if (block.timestamp > expiry) revert PermitExpired();

        // EIP-712 structured hash: binds label + owner + expiry.
        // DOMAIN_SEPARATOR binds chain ID + this contract address — prevents testnet→mainnet replay.
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, keccak256(bytes(label)), owner_, expiry));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));

        if (usedPermits[digest]) revert PermitAlreadyUsed();
        if (ECDSA.recover(digest, sig) != platformSigner) revert PermitInvalid();

        usedPermits[digest] = true;
        return _register(label, owner_, contenthash, textKeys, textValues);
    }

    /// @notice Updates a name's Swarm site pointer (called on each site redeploy).
    ///
    /// @dev This is the ONLY post-mint record write the platform retains
    ///      (owner decision, 2026-08-29, WoCo-Event-App #422). `setText` was
    ///      removed in the same pass: it was never called by the server, so it
    ///      was standing authority over holders' profile records purchased with
    ///      no operational benefit at all.
    ///
    ///      RESIDUAL, STATED PLAINLY SO IT IS NOT REDISCOVERED: this function
    ///      takes an ARBITRARY label. Because the registrar sits in the
    ///      registry's `registrars` set, and `onlyOwnerOrRegistrar` scopes to
    ///      registrar MEMBERSHIP rather than to the node, an authorised sponsor
    ///      can repoint ANY name's contenthash, including one it did not mint.
    ///      That is retained deliberately — automated site redeploy needs it and
    ///      the organiser is not present to sign — but it is real standing
    ///      authority sitting on the hot key `WOCO_SPONSOR_PRIVATE_KEY`.
    ///
    ///      What bounds it: the server refuses to call this unless the
    ///      authenticated caller owns the label (routes/sub-ens.ts:290-296 and
    ///      routes/sites.ts:1060-1061 both check `getLabelOwner` against the
    ///      verified parentAddress). That check is application code, not a
    ///      contract guarantee.
    ///
    ///      WHY THE RESIDUAL IS ACCEPTED RATHER THAN CLOSED NOW, stated
    ///      accurately: a per-redeploy holder signature would defeat automated
    ///      redeploy, but that is not the only shape available — a REVERSIBLE
    ///      per-node "platform-managed" toggle (default on at mint, holder may
    ///      opt out and back in) would bound this at the cost of one signature
    ///      per opt-out, not per redeploy. It is deferred, not ruled out.
    ///
    ///      What makes deferring it safe: unlike the registry, THIS contract is
    ///      not frozen. The registry reaches it through `registrars`, so a
    ///      registrar v2 can narrow this post-launch via `addRegistrar` /
    ///      `removeRegistrar` without touching the EIP-1167 clone. Note also
    ///      that no registrar-level scheme can bind the registry OWNER, which
    ///      can add any address to `registrars` — see `adminTransfer`'s notes.
    ///
    ///      The blast radius is where a name POINTS, never what it owns or where
    ///      its funds go: address records are written once inside `_register`
    ///      and there is no post-mint `setAddr` on this contract.
    function setContenthash(string calldata label, bytes calldata contenthash) external onlySponsor {
        if (contenthash.length == 0) revert EmptyContenthash();
        bytes32 node = registry.makeNode(registry.baseNode(), label);
        registry.setContenthash(node, contenthash);
        emit ContenthashUpdated(label, contenthash);
    }

    /*//////////////////////////////////////////////////////////////
                              AVAILABILITY
    //////////////////////////////////////////////////////////////*/

    /// @notice True if `label` is valid, not reserved, and unminted.
    /// @dev Says nothing about the recipient's allowance — that is a property
    ///      of who is receiving, not of the label. See `mintAllowance`.
    function available(string calldata label) external view returns (bool) {
        if (!_validLabel(label)) return false;
        if (reserved[keccak256(bytes(label))]) return false;
        bytes32 node = registry.makeNode(registry.baseNode(), label);
        return registry.owner(node) == address(0);
    }

    /// @notice How many more names `recipient` may be minted right now, and
    ///         when their window resets. For the server and UI to say "you can
    ///         register N more until <date>" instead of surfacing a failed tx.
    function mintAllowance(address recipient) external view returns (uint32 remaining, uint64 windowResetsAt) {
        MintWindow memory w = mintWindow[recipient];
        uint64 nowTs = uint64(block.timestamp);
        if (w.start == 0 || nowTs >= w.start + mintWindowSeconds) {
            return (maxMintsPerWindow, nowTs + mintWindowSeconds);
        }
        remaining = w.count >= maxMintsPerWindow ? 0 : maxMintsPerWindow - w.count;
        windowResetsAt = w.start + mintWindowSeconds;
    }

    /*//////////////////////////////////////////////////////////////
                                 ADMIN
    //////////////////////////////////////////////////////////////*/

    function addSponsor(address sponsor) external onlyOwner {
        authorisedSponsors[sponsor] = true;
        emit SponsorAdded(sponsor);
    }

    function removeSponsor(address sponsor) external onlyOwner {
        authorisedSponsors[sponsor] = false;
        emit SponsorRemoved(sponsor);
    }

    function setPlatformSigner(address signer) external onlyOwner {
        platformSigner = signer;
        emit PlatformSignerUpdated(signer);
    }

    function setReserved(string calldata label, bool isReserved) external onlyOwner {
        reserved[keccak256(bytes(label))] = isReserved;
        emit LabelReservedSet(label, isReserved);
    }

    /// @notice Retune the per-recipient mint cap. Takes effect for every
    ///         recipient's NEXT mint; windows already open keep their start.
    /// @dev Zero is refused for both: a zero cap would be a mint pause dressed
    ///      as a tuning, and a zero window would make the cap vanish. Pausing
    ///      already exists — `removeSponsor` and `setPlatformSigner(0)` close
    ///      both mint paths (`ECDSA.recover` never returns the zero address).
    function setMintRateCap(uint32 max, uint64 windowSeconds) external onlyOwner {
        if (max == 0 || windowSeconds == 0) revert InvalidMintRateCap();
        maxMintsPerWindow = max;
        mintWindowSeconds = windowSeconds;
        emit MintRateCapSet(max, windowSeconds);
    }

    /*//////////////////////////////////////////////////////////////
                             INTERNAL
    //////////////////////////////////////////////////////////////*/

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("WoCoRegistrar"),
            keccak256("1"),
            block.chainid,
            address(this)
        ));
    }

    function _register(
        string calldata label,
        address owner_,
        bytes calldata contenthash,
        string[] calldata textKeys,
        string[] calldata textValues
    ) internal returns (bytes32 node) {
        if (!_validLabel(label)) revert InvalidLabel(label);
        if (reserved[keccak256(bytes(label))]) revert LabelIsReserved(label);
        if (textKeys.length != textValues.length) revert ArrayLengthMismatch();
        _consumeMintAllowance(owner_);

        node = registry.createSubnode(registry.baseNode(), label, owner_, new bytes[](0));

        // Forward address records: chain ENSIP-11 coinType + ETH (coinType 60).
        // The sub-ENS name doubles as a USDC receive-alias for the organiser.
        bytes memory addr = abi.encodePacked(owner_);
        registry.setAddr(node, coinType, addr);
        registry.setAddr(node, 60, addr);

        if (contenthash.length > 0) {
            registry.setContenthash(node, contenthash);
        }
        for (uint256 i; i < textKeys.length; ++i) {
            registry.setText(node, textKeys[i], textValues[i]);
        }

        emit NameRegistered(label, owner_, contenthash);
    }

    /// @dev Charges one mint to `recipient`'s window, opening a fresh window if
    ///      none is open or the current one has elapsed. Reverts with the reset
    ///      time when the window is full, so a caller can report it.
    function _consumeMintAllowance(address recipient) internal {
        MintWindow memory w = mintWindow[recipient];
        uint64 nowTs = uint64(block.timestamp);
        if (w.start == 0 || nowTs >= w.start + mintWindowSeconds) {
            w.start = nowTs;
            w.count = 0;
        }
        if (w.count >= maxMintsPerWindow) {
            revert MintRateCapExceeded(recipient, w.start + mintWindowSeconds);
        }
        w.count += 1;
        mintWindow[recipient] = w;
    }

    /// @dev Allowed: 3-63 chars, lowercase a-z / 0-9 / hyphen, no leading/trailing/double hyphen.
    function _validLabel(string calldata label) internal pure returns (bool) {
        bytes memory b = bytes(label);
        uint256 len = b.length;
        if (len < MIN_LABEL_LENGTH || len > MAX_LABEL_LENGTH) return false;
        for (uint256 i; i < len; ++i) {
            bytes1 c = b[i];
            bool isLower = (c >= 0x61 && c <= 0x7a);
            bool isDigit = (c >= 0x30 && c <= 0x39);
            bool isHyphen = (c == 0x2d);
            if (!(isLower || isDigit || isHyphen)) return false;
            if (isHyphen) {
                if (i == 0 || i == len - 1) return false;
                if (b[i - 1] == 0x2d) return false;
            }
        }
        return true;
    }
}
