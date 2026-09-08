// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import {IIdentityRegistry} from "./interfaces/IERC8004.sol";
import {AgentCardTypes} from "./lib/AgentCardTypes.sol";

/// @title CardManager
/// @notice Issuance, policy and revocation for AgentCards. This contract is the
///         on-chain home of the user's authorization: there is no off-chain
///         certificate chain (see README "considered and rejected").
///
/// @dev TRUST BOUNDARY: `msg.sender` here is the owner's Mera-derived EOA. Mera does
///      NOT perform on-chain P256/WebAuthn verification -- it derives a plain secp256k1
///      EOA from the passkey's PRF output. So on-chain this is an ordinary EOA check;
///      the passkey gates access to that key OFF-chain, in the browser. Nothing in this
///      contract is "smart account gated".
contract CardManager is IERC721Receiver {
    struct Card {
        address agentKey;
        address owner;
        uint256 dailyCap;
        bytes32 merchantRoot;
        uint64 validUntil;
        uint64 issuedAt;
        bool revoked;
        uint64 policyVersion;
    }

    IIdentityRegistry public immutable identityRegistry;

    mapping(bytes32 cardId => Card) private _cards;

    /// @notice Reverse index the ERC-8004 registry does not provide.
    /// @dev The registry only maps agentId -> wallet (`getAgentWallet`). The Verifier
    ///      flow needs wallet -> identity, so we maintain it ourselves.
    mapping(address agentKey => bytes32 cardId) public cardIdOfAgentKey;

    mapping(bytes32 cardId => uint256 agentId) public agentIdOfCard;

    event CardIssued(
        bytes32 indexed cardId,
        address indexed owner,
        address indexed agentKey,
        uint256 agentId,
        uint256 dailyCap,
        bytes32 merchantRoot,
        uint64 validUntil
    );
    event PolicyUpdated(
        bytes32 indexed cardId,
        uint256 dailyCap,
        bytes32 merchantRoot,
        uint64 validUntil,
        uint64 policyVersion
    );
    event CardRevoked(
        bytes32 indexed cardId, address indexed owner, address indexed agentKey, uint256 agentId
    );
    event AgentWalletBound(bytes32 indexed cardId, uint256 indexed agentId, address indexed agentKey);

    error ZeroAgentKey();
    error AgentKeyAlreadyUsed();
    error CardAlreadyExists();
    error CardNotFound();
    error NotCardOwner();
    error CardIsRevoked();
    error InvalidExpiry();

    constructor(address identityRegistry_) {
        identityRegistry = IIdentityRegistry(identityRegistry_);
    }

    /// @notice Issue a card: mint the agent's ERC-8004 identity and store its policy.
    /// @dev The identity NFT is minted to THIS contract (the registry mints to
    ///      msg.sender). That is deliberate and has a consequence worth stating: the
    ///      Reputation Registry blocks feedback from anyone `isAuthorizedOrOwner` of the
    ///      agent, so CardManager can never rate its own agents. Merchants author the
    ///      trail instead. Custodying the NFT keeps identity bound to card lifecycle.
    function issueCard(
        address agentKey,
        uint256 dailyCap,
        bytes32 merchantRoot,
        uint64 validUntil,
        string calldata agentURI
    ) external returns (bytes32 cardId, uint256 agentId) {
        if (agentKey == address(0)) revert ZeroAgentKey();
        if (validUntil <= block.timestamp) revert InvalidExpiry();
        // One card per agent key, ever. A revoked key is burned permanently: re-issuing
        // to it would let a revoked agent be silently resurrected.
        if (cardIdOfAgentKey[agentKey] != bytes32(0)) revert AgentKeyAlreadyUsed();

        cardId = AgentCardTypes.cardIdFor(msg.sender, agentKey);
        if (_cards[cardId].agentKey != address(0)) revert CardAlreadyExists();

        agentId = identityRegistry.register(agentURI);

        _cards[cardId] = Card({
            agentKey: agentKey,
            owner: msg.sender,
            dailyCap: dailyCap,
            merchantRoot: merchantRoot,
            validUntil: validUntil,
            issuedAt: uint64(block.timestamp),
            revoked: false,
            policyVersion: 1
        });
        cardIdOfAgentKey[agentKey] = cardId;
        agentIdOfCard[cardId] = agentId;

        emit CardIssued(cardId, msg.sender, agentKey, agentId, dailyCap, merchantRoot, validUntil);
    }

    /// @notice Point the ERC-8004 `agentWallet` metadata at the real agent key.
    /// @dev Permissionless to SUBMIT, because the authorization is the agent key's own
    ///      EIP-712 signature, which the registry verifies. It cannot be a step inside
    ///      `issueCard`: the signature must commit to `agentId`, and `agentId` is only
    ///      known after `register()` runs. Making it separate avoids a second passkey
    ///      prompt -- the agent signs, any relayer submits.
    function bindAgentWallet(bytes32 cardId, uint256 deadline, bytes calldata agentSignature) external {
        Card storage card = _cards[cardId];
        if (card.agentKey == address(0)) revert CardNotFound();
        if (card.revoked) revert CardIsRevoked();

        uint256 agentId = agentIdOfCard[cardId];
        identityRegistry.setAgentWallet(agentId, card.agentKey, deadline, agentSignature);
        emit AgentWalletBound(cardId, agentId, card.agentKey);
    }

    /// @notice Update limits. Bumps `policyVersion`, which invalidates every SpendAuth
    ///         the agent signed under the previous policy (the version is in the signed
    ///         payload).
    function updatePolicy(bytes32 cardId, uint256 dailyCap, bytes32 merchantRoot, uint64 validUntil)
        external
    {
        Card storage card = _cards[cardId];
        if (card.agentKey == address(0)) revert CardNotFound();
        if (card.owner != msg.sender) revert NotCardOwner();
        if (card.revoked) revert CardIsRevoked();
        if (validUntil <= block.timestamp) revert InvalidExpiry();

        card.dailyCap = dailyCap;
        card.merchantRoot = merchantRoot;
        card.validUntil = validUntil;
        card.policyVersion += 1;

        emit PolicyUpdated(cardId, dailyCap, merchantRoot, validUntil, card.policyVersion);
    }

    /// @notice Instant and total. There is no un-revoke: a new card is a new issuance.
    function revoke(bytes32 cardId) external {
        Card storage card = _cards[cardId];
        if (card.agentKey == address(0)) revert CardNotFound();
        if (card.owner != msg.sender) revert NotCardOwner();
        if (card.revoked) revert CardIsRevoked();

        card.revoked = true;
        emit CardRevoked(cardId, card.owner, card.agentKey, agentIdOfCard[cardId]);
    }

    /// @notice Required to custody agent identity NFTs.
    /// @dev The Identity Registry mints with `_safeMint`, which calls back into a
    ///      contract recipient. Without this hook every `issueCard` would revert with
    ///      ERC721InvalidReceiver -- on Monad exactly as in the tests.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    function getCard(bytes32 cardId) external view returns (Card memory) {
        return _cards[cardId];
    }

    function cardIdFor(address owner, address agentKey) external pure returns (bytes32) {
        return AgentCardTypes.cardIdFor(owner, agentKey);
    }
}
