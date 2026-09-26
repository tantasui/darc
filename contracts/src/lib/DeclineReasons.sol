// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SpendGate} from "../SpendGate.sol";

/// @notice Maps SpendGate's custom-error selectors to short human-readable tags.
/// @dev WHY ON-CHAIN: the refusal reason has to be readable by a plain `eth_call`, because
///      public Monad RPCs cap `eth_getLogs` at a 100-block range. A verifier that had to
///      scan events since deployment would need thousands of requests, or a paid archive
///      node. Writing the reason into the ERC-8004 attestation's `tag1` instead makes the
///      whole trail queryable with one call and no indexer.
///
///      Only `tag1`/`tag2` are STORED by the Reputation Registry; `endpoint` and
///      `feedbackURI` are emitted in the event but not kept, so they cannot carry this.
library DeclineReasons {
    string internal constant APPROVED = "approved";

    function tagFor(bytes4 selector) internal pure returns (string memory) {
        if (selector == SpendGate.DailyCapExceeded.selector) return "DailyCapExceeded";
        if (selector == SpendGate.MerchantNotAllowed.selector) return "MerchantNotAllowed";
        if (selector == SpendGate.CardRevoked.selector) return "CardRevoked";
        if (selector == SpendGate.CardExpired.selector) return "CardExpired";
        if (selector == SpendGate.CardNotFound.selector) return "CardNotFound";
        if (selector == SpendGate.DeadlineExpired.selector) return "DeadlineExpired";
        if (selector == SpendGate.TokenNotAllowed.selector) return "TokenNotAllowed";
        if (selector == SpendGate.PolicyVersionStale.selector) return "PolicyVersionStale";
        if (selector == SpendGate.BadAgentSignature.selector) return "BadAgentSignature";
        if (selector == SpendGate.NonceUsed.selector) return "NonceUsed";
        return "Unknown";
    }
}
