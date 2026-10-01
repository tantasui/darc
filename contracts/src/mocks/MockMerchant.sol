// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SpendRouter} from "../SpendRouter.sol";
import {CardManager} from "../CardManager.sol";
import {IReputationRegistry} from "../interfaces/IERC8004.sol";
import {SpendAuth} from "../lib/AgentCardTypes.sol";
import {DeclineReasons} from "../lib/DeclineReasons.sol";

/// @title MockMerchant
/// @notice The "shop" in the demo, and the AUTHOR of the ERC-8004 reputation trail.
///
/// @dev WHY THE MERCHANT AND NOT OUR OWN CONTRACTS: the canonical Reputation Registry
///      rejects feedback from anyone who is `isAuthorizedOrOwner` of the agent
///      ("Self-feedback not allowed"). CardManager mints and holds the agent identity, so
///      it is structurally barred from rating its own agents -- and rightly: issuer-authored
///      reputation is worthless. The merchant is the counterparty, which is exactly
///      ERC-8004's client-feedback model. It is also the merchant who submits and pays gas,
///      so the agent never holds funds or gas.
contract MockMerchant {
    /// @notice Human-readable merchant identity, so the UI shows a real counterparty rather
    ///         than an opaque address. Set once at deployment.
    string public name;

    SpendRouter public immutable router;
    CardManager public immutable cardManager;
    IReputationRegistry public immutable reputation;

    string internal constant TAG_APPROVED = "approved";
    string internal constant TAG_DECLINED = "declined";

    /// @dev Feedback values are a plain 0/100 score at 0 decimals, so the registry's
    ///      `getSummary` average reads as a success percentage.
    int128 internal constant SCORE_APPROVED = 100;
    int128 internal constant SCORE_DECLINED = 0;

    event Charged(bytes32 indexed cardId, bool ok, bytes4 reasonSelector);

    constructor(string memory name_, address router_, address cardManager_, address reputation_) {
        name = name_;
        router = SpendRouter(router_);
        cardManager = CardManager(cardManager_);
        reputation = IReputationRegistry(reputation_);
    }

    /// @notice Attempt to charge a card, then attest to the outcome on ERC-8004.
    function charge(SpendAuth calldata auth, bytes calldata agentSig, bytes32[] calldata merchantProof)
        external
        returns (bool ok, bytes4 reasonSelector)
    {
        (ok, reasonSelector) = router.submit(auth, agentSig, merchantProof);

        uint256 agentId = cardManager.agentIdOfCard(auth.cardId);
        // tag1 carries the OUTCOME REASON and tag2 the verdict. Both are stored by the
        // registry, so a verifier reads the full trail -- refusals and their causes -- with
        // one call, instead of scanning events the public RPC will not serve.
        reputation.giveFeedback(
            agentId,
            ok ? SCORE_APPROVED : SCORE_DECLINED,
            0,
            ok ? DeclineReasons.APPROVED : DeclineReasons.tagFor(reasonSelector),
            ok ? TAG_APPROVED : TAG_DECLINED,
            "",
            "",
            bytes32(0)
        );

        emit Charged(auth.cardId, ok, reasonSelector);
    }
}
