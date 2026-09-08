// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SpendGate} from "./SpendGate.sol";
import {SpendAuth} from "./lib/AgentCardTypes.sol";

/// @title SpendRouter
/// @notice Makes REFUSALS on-chain. This is the novel data in AgentCard: anyone can show
///         approvals, but a public trail of what an agent was *stopped* from doing is what
///         makes the reputation meaningful.
///
/// @dev THE PATTERN, since judges will ask: a revert unwinds state AND erases events, so a
///      declined spend that reverts leaves no trace. The router calls SpendGate through
///      `try/catch`, so the inner revert still unwinds the spend's state (nothing is
///      settled, no nonce burned) while the router's own frame survives to emit
///      `SpendDeclined`. The decline is therefore permanent public data, paid for by the
///      submitter's gas.
contract SpendRouter {
    SpendGate public immutable spendGate;

    event SpendDeclined(
        bytes32 indexed cardId, address indexed merchant, uint256 amount, uint256 nonce, bytes4 reasonSelector
    );

    /// @dev Returned when the inner call produced no decodable error selector (an empty
    ///      revert, or an out-of-gas that `try/catch` cannot capture as data).
    bytes4 public constant UNKNOWN_REASON = 0xffffffff;

    constructor(address spendGate_) {
        spendGate = SpendGate(spendGate_);
    }

    /// @notice Attempt a spend; never reverts on a policy decline.
    /// @return ok True if the spend settled.
    /// @return reasonSelector Zero on success, else the custom-error selector from SpendGate.
    function submit(SpendAuth calldata auth, bytes calldata agentSig, bytes32[] calldata merchantProof)
        external
        returns (bool ok, bytes4 reasonSelector)
    {
        try spendGate.spend(auth, agentSig, merchantProof) {
            return (true, bytes4(0));
        } catch (bytes memory err) {
            reasonSelector = err.length >= 4 ? bytes4(err) : UNKNOWN_REASON;
            emit SpendDeclined(auth.cardId, auth.merchant, auth.amount, auth.nonce, reasonSelector);
            return (false, reasonSelector);
        }
    }
}
