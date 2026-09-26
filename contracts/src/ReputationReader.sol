// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CardManager} from "./CardManager.sol";
import {IReputationRegistry, IIdentityRegistry} from "./interfaces/IERC8004.sol";

/// @title ReputationReader
/// @notice What a third party calls to decide whether to trust an agent. This is the
///         proof that the trail is queryable infrastructure rather than private logs.
/// @dev Composes the registry's own `getClients` + `getSummary` rather than
///      reimplementing counting: the canonical registry stays the source of truth, and we
///      only add the reverse lookup (agent key -> identity) that it does not provide.
contract ReputationReader {
    CardManager public immutable cardManager;
    IReputationRegistry public immutable reputation;
    IIdentityRegistry public immutable identityRegistry;

    /// @dev tag1 now holds the reason, so counts filter on tag2 only (empty tag1 = wildcard).
    string internal constant TAG_ANY = "";
    string internal constant TAG_APPROVED = "approved";
    string internal constant TAG_DECLINED = "declined";

    struct AgentReport {
        bool found;
        uint256 agentId;
        bytes32 cardId;
        address owner;
        uint64 approvedCount;
        uint64 declinedCount;
        bool revoked;
        bool expired;
        uint64 activeSince;
        uint64 clientCount;
    }

    constructor(address cardManager_, address reputation_, address identityRegistry_) {
        cardManager = CardManager(cardManager_);
        reputation = IReputationRegistry(reputation_);
        identityRegistry = IIdentityRegistry(identityRegistry_);
    }

    /// @notice Full trust report for an agent address.
    function reportForAgentKey(address agentKey) public view returns (AgentReport memory report) {
        bytes32 cardId = cardManager.cardIdOfAgentKey(agentKey);
        if (cardId == bytes32(0)) return report;

        CardManager.Card memory card = cardManager.getCard(cardId);
        report.found = true;
        report.cardId = cardId;
        report.agentId = cardManager.agentIdOfCard(cardId);
        report.owner = card.owner;
        report.revoked = card.revoked;
        report.expired = card.validUntil <= block.timestamp;
        report.activeSince = card.issuedAt;

        address[] memory clients = reputation.getClients(report.agentId);
        report.clientCount = uint64(clients.length);
        // `getSummary` reverts on an empty client list, so a never-rated agent short-circuits.
        if (clients.length == 0) return report;

        (report.approvedCount,,) = reputation.getSummary(report.agentId, clients, TAG_ANY, TAG_APPROVED);
        (report.declinedCount,,) = reputation.getSummary(report.agentId, clients, TAG_ANY, TAG_DECLINED);
    }

    /// @notice Convenience: is this agent currently safe to transact with?
    function isTrusted(address agentKey) external view returns (bool) {
        AgentReport memory report = reportForAgentKey(agentKey);
        return report.found && !report.revoked && !report.expired;
    }
}
