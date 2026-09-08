// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SpendRouter} from "../SpendRouter.sol";
import {CardManager} from "../CardManager.sol";
import {IReputationRegistry} from "../interfaces/IERC8004.sol";
import {SpendAuth} from "../lib/AgentCardTypes.sol";

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
    SpendRouter public immutable router;
    CardManager public immutable cardManager;
    IReputationRegistry public immutable reputation;

    string internal constant TAG_DOMAIN = "payment";
    string internal constant TAG_APPROVED = "approved";
    string internal constant TAG_DECLINED = "declined";

    /// @dev Feedback values are a plain 0/100 score at 0 decimals, so the registry's
    ///      `getSummary` average reads as a success percentage.
    int128 internal constant SCORE_APPROVED = 100;
    int128 internal constant SCORE_DECLINED = 0;

    event Charged(bytes32 indexed cardId, bool ok, bytes4 reasonSelector);

    constructor(address router_, address cardManager_, address reputation_) {
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
        reputation.giveFeedback(
            agentId,
            ok ? SCORE_APPROVED : SCORE_DECLINED,
            0,
            TAG_DOMAIN,
            ok ? TAG_APPROVED : TAG_DECLINED,
            "",
            "",
            bytes32(0)
        );

        emit Charged(auth.cardId, ok, reasonSelector);
    }
}
