// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice The single authorization an agent key ever signs.
/// @dev DESIGN NOTE (deviation from the original spec, deliberate):
///      the spec listed `{cardId, merchant, token, amountUSD, nonce, deadline}` but ALSO
///      required that bumping `policyVersion` kill stale authorizations. Those two
///      statements are incompatible: if the signed payload does not commit to the policy
///      version, an auth signed under the old policy stays valid forever and
///      `policyVersion` is inert. We therefore fold `policyVersion` into the struct so the
///      agent's signature is bound to the exact policy generation it was issued under.
///
///      `amount` is denominated in the payment token's units (MockUSD, 6 decimals). The
///      spec's `amountUSD` name is dropped because SpendGate pins `token` to a single
///      configured payment token: without an oracle, a USD-denominated cap cannot bound an
///      arbitrary token. `token` is retained so the signature commits to it.
struct SpendAuth {
    bytes32 cardId;
    address merchant;
    address token;
    uint256 amount;
    uint256 nonce;
    uint256 deadline;
    uint64 policyVersion;
}

library AgentCardTypes {
    bytes32 internal constant SPEND_AUTH_TYPEHASH = keccak256(
        "SpendAuth(bytes32 cardId,address merchant,address token,uint256 amount,uint256 nonce,uint256 deadline,uint64 policyVersion)"
    );

    function hashSpendAuth(SpendAuth memory auth) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                SPEND_AUTH_TYPEHASH,
                auth.cardId,
                auth.merchant,
                auth.token,
                auth.amount,
                auth.nonce,
                auth.deadline,
                auth.policyVersion
            )
        );
    }

    /// @notice Card identity is the (owner, agentKey) pair.
    function cardIdFor(address owner, address agentKey) internal pure returns (bytes32) {
        return keccak256(abi.encode(owner, agentKey));
    }

    /// @notice Merkle leaf for merchant scoping, double-hashed to prevent
    ///         second-preimage attacks against internal nodes.
    function merchantLeaf(address merchant) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(merchant))));
    }
}
