// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Faithful local stand-in for IdentityRegistryUpgradeable v2.0.0.
/// @dev Replicates the behaviours AgentCard depends on, verbatim from the canonical
///      source: `register` mints to msg.sender and seeds agentWallet = msg.sender;
///      `setAgentWallet` demands NFT authority AND an EIP-712 signature from the new
///      wallet under domain ("ERC8004IdentityRegistry","1") with a <=5 minute deadline.
///      Tests must fail here for the same reasons they would on Monad.
contract MockIdentityRegistry is ERC721, EIP712 {
    bytes32 private constant AGENT_WALLET_SET_TYPEHASH =
        keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)");
    uint256 private constant MAX_DEADLINE_DELAY = 5 minutes;

    uint256 private _lastId;
    mapping(uint256 => mapping(string => bytes)) private _metadata;
    mapping(uint256 => string) private _agentURI;

    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);

    constructor() ERC721("AgentIdentity", "AGENT") EIP712("ERC8004IdentityRegistry", "1") {}

    function register(string memory agentURI) external returns (uint256 agentId) {
        agentId = _lastId++;
        _metadata[agentId]["agentWallet"] = abi.encodePacked(msg.sender);
        _safeMint(msg.sender, agentId);
        _agentURI[agentId] = agentURI;
        emit Registered(agentId, agentURI, msg.sender);
    }

    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature)
        external
    {
        address owner = ownerOf(agentId);
        require(
            msg.sender == owner || isApprovedForAll(owner, msg.sender) || msg.sender == getApproved(agentId),
            "Not authorized"
        );
        require(newWallet != address(0), "bad wallet");
        require(block.timestamp <= deadline, "expired");
        require(deadline <= block.timestamp + MAX_DEADLINE_DELAY, "deadline too far");

        bytes32 structHash =
            keccak256(abi.encode(AGENT_WALLET_SET_TYPEHASH, agentId, newWallet, owner, deadline));
        bytes32 digest = _hashTypedDataV4(structHash);
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        require(err == ECDSA.RecoverError.NoError && recovered == newWallet, "invalid wallet sig");

        _metadata[agentId]["agentWallet"] = abi.encodePacked(newWallet);
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        return address(bytes20(_metadata[agentId]["agentWallet"]));
    }

    function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool) {
        address owner = _ownerOf(agentId);
        if (owner == address(0)) return false;
        return spender == owner || isApprovedForAll(owner, spender) || getApproved(agentId) == spender;
    }

    /// @dev Exposed so tests can build the exact digest the agent key must sign.
    function walletSetDigest(uint256 agentId, address newWallet, address owner, uint256 deadline)
        external
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(abi.encode(AGENT_WALLET_SET_TYPEHASH, agentId, newWallet, owner, deadline))
        );
    }
}
