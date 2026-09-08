// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {CardManager} from "./CardManager.sol";
import {SpendAuth, AgentCardTypes} from "./lib/AgentCardTypes.sol";

/// @title SpendGate
/// @notice The enforcement point. Verifies the full trust chain on every spend:
///         owner authorized this policy -> policy covers this agent key and is unrevoked
///         -> agent key signed this exact spend -> spend fits the limits -> nonce is fresh.
///
/// @dev FUNDS TRUST BOUNDARY (state it plainly): the owner ERC-20-approves this contract,
///      so SpendGate can move the owner's tokens. It can only ever do so through a
///      complete, valid verification below, and revocation severs it permanently. The
///      approval should be BOUNDED, not infinite: an infinite approval means a bug in
///      this contract drains the owner regardless of any card policy, because the
///      approval sits upstream of the policy engine.
contract SpendGate is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    CardManager public immutable cardManager;

    /// @dev A single pinned payment token. See AgentCardTypes: a USD-denominated cap
    ///      cannot bound an arbitrary token without an oracle, so we do not pretend to.
    address public immutable paymentToken;

    /// @notice Replay protection: a set of consumed nonces, not a high-water mark.
    /// @dev Chosen over the spec's "strictly increasing" counter. Under a relayer, auths
    ///      can land out of order; a monotonic counter would permanently kill a lower
    ///      nonce that merely arrived late, through no fault of the agent. A used-set is
    ///      order-independent, matches the `NonceUsed` error name, and costs one slot per
    ///      spend at demo scale. Bitmaps were rejected as premature (see README).
    mapping(bytes32 cardId => mapping(uint256 nonce => bool)) public nonceUsed;

    mapping(bytes32 cardId => uint64 dayBucket) public dayBucketOf;
    mapping(bytes32 cardId => uint256 spent) public spentInBucket;

    event SpendApproved(
        bytes32 indexed cardId, address indexed merchant, uint256 amount, uint256 nonce, uint256 spentToday
    );

    // Verification errors, in check order. The taxonomy IS the audit trail: SpendRouter
    // surfaces these selectors on-chain as decline reasons.
    error CardNotFound();
    error CardRevoked();
    error CardExpired();
    error DeadlineExpired();
    error TokenNotAllowed();
    error PolicyVersionStale();
    error BadAgentSignature();
    error NonceUsed();
    error MerchantNotAllowed();
    error DailyCapExceeded();

    constructor(address cardManager_, address paymentToken_) EIP712("AgentCard", "1") {
        cardManager = CardManager(cardManager_);
        paymentToken = paymentToken_;
    }

    function hashSpendAuth(SpendAuth calldata auth) public view returns (bytes32) {
        return _hashTypedDataV4(AgentCardTypes.hashSpendAuth(auth));
    }

    /// @notice Verify and settle a spend.
    /// @dev Callable by anyone. The agent's signature is the authorization and funds can
    ///      only ever move to `auth.merchant`, so a relayer submitting is harmless -- and
    ///      it is what lets the agent hold no gas and never touch a balance.
    ///
    ///      ORDER NOTE: every failure below reverts, so all state is unwound regardless of
    ///      order -- ordering determines the REPORTED reason and gas, not safety. Cheap
    ///      checks therefore precede `ecrecover`: the spec placed the deadline check after
    ///      signature recovery, which only wastes ~3k gas on an auth already known stale.
    function spend(SpendAuth calldata auth, bytes calldata agentSig, bytes32[] calldata merchantProof)
        external
        nonReentrant
    {
        CardManager.Card memory card = cardManager.getCard(auth.cardId);

        // 1. Card status
        if (card.agentKey == address(0)) revert CardNotFound();
        if (card.revoked) revert CardRevoked();
        if (card.validUntil <= block.timestamp) revert CardExpired();

        // 2. Freshness (cheap, so it runs before signature recovery)
        if (auth.deadline < block.timestamp) revert DeadlineExpired();
        if (auth.token != paymentToken) revert TokenNotAllowed();
        if (auth.policyVersion != card.policyVersion) revert PolicyVersionStale();

        // 3. Agent authenticity
        address signer = ECDSA.recover(hashSpendAuth(auth), agentSig);
        if (signer != card.agentKey) revert BadAgentSignature();

        // 4. Replay
        if (nonceUsed[auth.cardId][auth.nonce]) revert NonceUsed();

        // 5. Merchant scoping. root == 0 means "any merchant" -- an explicit, documented
        //    wildcard, not an accident of an uninitialized field.
        if (card.merchantRoot != bytes32(0)) {
            bytes32 leaf = AgentCardTypes.merchantLeaf(auth.merchant);
            if (!MerkleProof.verifyCalldata(merchantProof, card.merchantRoot, leaf)) {
                revert MerchantNotAllowed();
            }
        }

        // 6. Rolling daily cap, UTC day buckets.
        //    EDGE BEHAVIOUR (accepted, not overlooked): buckets are calendar days, not a
        //    trailing 24h window, so a card can spend a full cap at 23:59 and another at
        //    00:01. A true rolling window needs per-spend history; the cap is a blast
        //    radius limit, not an accounting ledger.
        uint64 today = uint64(block.timestamp / 1 days);
        uint256 spent = dayBucketOf[auth.cardId] == today ? spentInBucket[auth.cardId] : 0;
        uint256 newSpent = spent + auth.amount;
        if (newSpent > card.dailyCap) revert DailyCapExceeded();

        // Effects before interaction.
        nonceUsed[auth.cardId][auth.nonce] = true;
        if (dayBucketOf[auth.cardId] != today) dayBucketOf[auth.cardId] = today;
        spentInBucket[auth.cardId] = newSpent;

        emit SpendApproved(auth.cardId, auth.merchant, auth.amount, auth.nonce, newSpent);

        IERC20(paymentToken).safeTransferFrom(card.owner, auth.merchant, auth.amount);
    }

    /// @notice Remaining allowance for the current UTC day.
    function remainingToday(bytes32 cardId) external view returns (uint256) {
        CardManager.Card memory card = cardManager.getCard(cardId);
        if (card.agentKey == address(0) || card.revoked) return 0;
        uint64 today = uint64(block.timestamp / 1 days);
        uint256 spent = dayBucketOf[cardId] == today ? spentInBucket[cardId] : 0;
        return spent >= card.dailyCap ? 0 : card.dailyCap - spent;
    }
}
