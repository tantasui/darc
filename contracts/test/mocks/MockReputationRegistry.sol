// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IIdentityAuth {
    function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool);
}

/// @notice Faithful local stand-in for ReputationRegistryUpgradeable v2.0.0.
/// @dev Reproduces the two behaviours the AgentCard design hinges on:
///      (1) the "Self-feedback not allowed" guard, which is why merchants author the
///          trail rather than CardManager;
///      (2) `getSummary` tag filtering with empty-string-as-wildcard, and its revert on
///          an empty client list.
contract MockReputationRegistry {
    struct Feedback {
        int128 value;
        uint8 valueDecimals;
        bool isRevoked;
        string tag1;
        string tag2;
    }

    int128 private constant MAX_ABS_VALUE = 1e38;

    address private immutable _identityRegistry;

    mapping(uint256 => mapping(address => mapping(uint64 => Feedback))) private _feedback;
    mapping(uint256 => mapping(address => uint64)) private _lastIndex;
    mapping(uint256 => address[]) private _clients;
    mapping(uint256 => mapping(address => bool)) private _clientExists;

    event NewFeedback(
        uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value
    );

    constructor(address identityRegistry_) {
        _identityRegistry = identityRegistry_;
    }

    function getIdentityRegistry() external view returns (address) {
        return _identityRegistry;
    }

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata,
        string calldata,
        bytes32
    ) external {
        require(valueDecimals <= 18, "too many decimals");
        require(value >= -MAX_ABS_VALUE && value <= MAX_ABS_VALUE, "value too large");
        require(
            !IIdentityAuth(_identityRegistry).isAuthorizedOrOwner(msg.sender, agentId),
            "Self-feedback not allowed"
        );

        uint64 currentIndex = ++_lastIndex[agentId][msg.sender];
        _feedback[agentId][msg.sender][currentIndex] =
            Feedback({value: value, valueDecimals: valueDecimals, isRevoked: false, tag1: tag1, tag2: tag2});

        if (!_clientExists[agentId][msg.sender]) {
            _clients[agentId].push(msg.sender);
            _clientExists[agentId][msg.sender] = true;
        }
        emit NewFeedback(agentId, msg.sender, currentIndex, value);
    }

    function getClients(uint256 agentId) external view returns (address[] memory) {
        return _clients[agentId];
    }

    function getSummary(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2
    ) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals) {
        require(clientAddresses.length > 0, "clientAddresses required");
        int256 sum;
        (count, sum) = _tally(agentId, clientAddresses, keccak256(bytes(tag1)), keccak256(bytes(tag2)));
        if (count == 0) return (0, 0, 0);
        summaryValue = int128(sum / int256(uint256(count)) / int256(10 ** 18));
        summaryValueDecimals = 0;
    }

    /// @dev Split out of `getSummary` purely to keep the stack shallow.
    function _tally(uint256 agentId, address[] calldata clients, bytes32 tag1Hash, bytes32 tag2Hash)
        private
        view
        returns (uint64 count, int256 sum)
    {
        bytes32 emptyHash = keccak256(bytes(""));
        for (uint256 i; i < clients.length; i++) {
            uint64 lastIdx = _lastIndex[agentId][clients[i]];
            for (uint64 j = 1; j <= lastIdx; j++) {
                Feedback storage fb = _feedback[agentId][clients[i]][j];
                if (fb.isRevoked) continue;
                if (emptyHash != tag1Hash && tag1Hash != keccak256(bytes(fb.tag1))) continue;
                if (emptyHash != tag2Hash && tag2Hash != keccak256(bytes(fb.tag2))) continue;
                sum += int256(fb.value) * int256(10 ** uint256(18 - fb.valueDecimals));
                count++;
            }
        }
    }
}
