// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal view of the canonical ERC-8004 Identity Registry.
/// @dev Mirrors IdentityRegistryUpgradeable v2.0.0, deployed on Monad Testnet at
///      0x8004A818BFB912233c491871b3d84c89A494BD9e. Only the members AgentCard uses
///      are declared here; the live contract is also an ERC-721.
interface IIdentityRegistry {
    struct MetadataEntry {
        string metadataKey;
        bytes metadataValue;
    }

    /// @dev Mints the agent identity NFT to msg.sender and sets metadata
    ///      "agentWallet" = msg.sender. The caller therefore OWNS the identity.
    function register(string memory agentURI) external returns (uint256 agentId);

    /// @dev Rebinds "agentWallet". Requires msg.sender to own/control the NFT AND an
    ///      EIP-712 signature produced by `newWallet` itself. Registry domain is
    ///      ("ERC8004IdentityRegistry", "1"); deadline must be <= now + 5 minutes.
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature)
        external;

    function getAgentWallet(uint256 agentId) external view returns (address);

    /// @dev True for the NFT owner, an approved operator, or the per-token approvee.
    ///      The Reputation Registry uses this to BLOCK self-feedback.
    function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool);

    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @notice Minimal view of the canonical ERC-8004 Reputation Registry.
/// @dev Mirrors ReputationRegistryUpgradeable v2.0.0, deployed on Monad Testnet at
///      0x8004B663056A597Dffe9eCcC1965A193B7388713.
interface IReputationRegistry {
    /// @dev Permissionless EXCEPT that msg.sender must NOT be authorized-or-owner of
    ///      `agentId` ("Self-feedback not allowed"). This is why merchants, not
    ///      AgentCard's own contracts, author the reputation trail.
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;

    /// @dev Empty tag == wildcard. Reverts with "clientAddresses required" if the list is empty.
    function getSummary(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2
    ) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);

    function getClients(uint256 agentId) external view returns (address[] memory);

    function getIdentityRegistry() external view returns (address);
}
