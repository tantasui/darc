// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AgentCardBase} from "./AgentCardBase.t.sol";
import {SpendGate} from "../src/SpendGate.sol";
import {SpendRouter} from "../src/SpendRouter.sol";
import {ReputationReader} from "../src/ReputationReader.sol";
import {SpendAuth} from "../src/lib/AgentCardTypes.sol";

/// @notice The novel claim: refusals are public on-chain data, and the trail is
///         queryable by a third party who trusts none of our contracts.
contract ReputationTrailTest is AgentCardBase {
    // --- declines survive the revert --------------------------------------------

    /// @dev A revert erases events, so a declined spend would normally leave no trace.
    ///      The router's try/catch keeps its own frame alive to record the refusal.
    function test_decline_isEmittedOnChainWithReason() public {
        SpendAuth memory auth = _auth(address(merchantA), 200e6, 1);
        bytes memory sig = _sign(auth, agentPk);

        vm.expectEmit(true, true, false, true, address(router));
        emit SpendRouter.SpendDeclined(
            cardId, address(merchantA), 200e6, 1, SpendGate.DailyCapExceeded.selector
        );

        vm.prank(relayer);
        (bool ok, bytes4 reason) = router.submit(auth, sig, _noProof());

        assertFalse(ok);
        assertEq(reason, SpendGate.DailyCapExceeded.selector);
    }

    /// @dev Every decline reason must round-trip as a distinct on-chain selector.
    function test_declineReasons_areDistinguishableOnChain() public {
        SpendAuth memory over = _auth(address(merchantA), 200e6, 1);
        (, bytes4 capReason) = _charge(merchantA, over, _noProof());
        assertEq(capReason, SpendGate.DailyCapExceeded.selector);

        SpendAuth memory wrongMerchant = _auth(address(merchantB), 10e6, 2);
        (, bytes4 merchantReason) = _charge(merchantB, wrongMerchant, _noProof());
        assertEq(merchantReason, SpendGate.MerchantNotAllowed.selector);

        vm.prank(owner);
        cardManager.revoke(cardId);
        SpendAuth memory afterRevoke = _auth(address(merchantA), 1e6, 3);
        (, bytes4 revokedReason) = _charge(merchantA, afterRevoke, _noProof());
        assertEq(revokedReason, SpendGate.CardRevoked.selector);

        assertTrue(capReason != merchantReason && merchantReason != revokedReason);
    }

    /// @dev A decline must settle nothing: the inner revert still unwinds fully.
    function test_decline_leavesNoStateBehind() public {
        SpendAuth memory auth = _auth(address(merchantA), 200e6, 7);
        uint256 ownerBefore = usd.balanceOf(owner);

        _charge(merchantA, auth, _noProof());

        assertEq(usd.balanceOf(owner), ownerBefore, "no funds moved");
        assertEq(usd.balanceOf(address(merchantA)), 0, "merchant unpaid");
        assertFalse(gate.nonceUsed(cardId, 7), "nonce NOT burned by a decline");
        assertEq(gate.remainingToday(cardId), DAILY_CAP, "allowance untouched");
    }

    /// @dev A nonce refused on a decline stays usable, so a policy failure does not
    ///      permanently strand the agent's nonce sequence.
    function test_decline_thenSameNonceCanSucceed() public {
        _charge(merchantA, _auth(address(merchantA), 200e6, 5), _noProof());
        (bool ok,) = _charge(merchantA, _auth(address(merchantA), 10e6, 5), _noProof());
        assertTrue(ok, "nonce still spendable after an earlier decline");
    }

    // --- ERC-8004 reputation authorship -----------------------------------------

    /// @dev The constraint that shaped the design: whoever owns the agent identity is
    ///      barred from rating it. CardManager custodies the NFT, so it can never
    ///      self-attest. Issuer-authored reputation is structurally impossible.
    function test_issuerCannotRateItsOwnAgent() public {
        vm.prank(address(cardManager));
        vm.expectRevert(bytes("Self-feedback not allowed"));
        reputation.giveFeedback(agentId, 100, 0, "approved", "approved", "", "", bytes32(0));
    }

    function test_merchantAttestsApprovalsAndDeclines() public {
        _charge(merchantA, _auth(address(merchantA), 20e6, 1), _noProof());
        _charge(merchantA, _auth(address(merchantA), 200e6, 2), _noProof());
        _charge(merchantB, _auth(address(merchantB), 5e6, 3), _noProof());

        address[] memory clients = reputation.getClients(agentId);
        assertEq(clients.length, 2, "both merchants recorded as clients");

        (uint64 approved,,) = reputation.getSummary(agentId, clients, "", "approved");
        (uint64 declined,,) = reputation.getSummary(agentId, clients, "", "declined");
        assertEq(approved, 1);
        assertEq(declined, 2);
    }

    /// @dev The reason must be READABLE BY eth_call, not only from events: public Monad RPCs
    ///      cap eth_getLogs at 100 blocks, so a verifier cannot scan history for it.
    function test_declineReasonIsStoredInTheAttestation() public {
        _charge(merchantA, _auth(address(merchantA), 200e6, 1), _noProof());
        _charge(merchantB, _auth(address(merchantB), 5e6, 2), _noProof());

        address[] memory a = new address[](1);
        a[0] = address(merchantA);
        (uint64 capCount,,) = reputation.getSummary(agentId, a, "DailyCapExceeded", "declined");
        assertEq(capCount, 1, "over-cap refusal is tagged with its reason");

        address[] memory b = new address[](1);
        b[0] = address(merchantB);
        (uint64 scopeCount,,) = reputation.getSummary(agentId, b, "MerchantNotAllowed", "declined");
        assertEq(scopeCount, 1, "out-of-scope refusal is tagged with its reason");

        // Reasons are distinct, so a verifier can tell the two refusals apart.
        (uint64 wrongTag,,) = reputation.getSummary(agentId, a, "MerchantNotAllowed", "declined");
        assertEq(wrongTag, 0, "reasons must not be interchangeable");
    }

    // --- third-party queryability ------------------------------------------------

    /// @dev This is the exact call the Verifier page makes: an address in, a verdict out.
    function test_reader_producesFullTrustReport() public {
        _charge(merchantA, _auth(address(merchantA), 20e6, 1), _noProof());
        _charge(merchantA, _auth(address(merchantA), 200e6, 2), _noProof());
        _charge(merchantB, _auth(address(merchantB), 5e6, 3), _noProof());

        ReputationReader.AgentReport memory r = reader.reportForAgentKey(agentKey);
        assertTrue(r.found);
        assertEq(r.agentId, agentId);
        assertEq(r.owner, owner);
        assertEq(r.approvedCount, 1);
        assertEq(r.declinedCount, 2);
        assertFalse(r.revoked);
        assertFalse(r.expired);
        assertEq(r.clientCount, 2);
        assertTrue(reader.isTrusted(agentKey));
    }

    function test_reader_reflectsRevocationImmediately() public {
        _charge(merchantA, _auth(address(merchantA), 20e6, 1), _noProof());
        assertTrue(reader.isTrusted(agentKey));

        vm.prank(owner);
        cardManager.revoke(cardId);

        ReputationReader.AgentReport memory r = reader.reportForAgentKey(agentKey);
        assertTrue(r.revoked);
        assertFalse(reader.isTrusted(agentKey), "revoked agents are untrusted instantly");
    }

    function test_reader_reflectsExpiry() public {
        vm.warp(block.timestamp + CARD_TTL + 1);
        ReputationReader.AgentReport memory r = reader.reportForAgentKey(agentKey);
        assertTrue(r.expired);
        assertFalse(reader.isTrusted(agentKey));
    }

    /// @dev An unknown agent must not revert the page; it returns an empty report.
    function test_reader_unknownAgentReturnsEmptyReport() public {
        ReputationReader.AgentReport memory r = reader.reportForAgentKey(makeAddr("ghost"));
        assertFalse(r.found);
        assertEq(r.approvedCount, 0);
        assertFalse(reader.isTrusted(makeAddr("ghost")));
    }

    /// @dev `getSummary` reverts on an empty client list; a never-used agent must
    ///      short-circuit before hitting it.
    function test_reader_neverRatedAgentDoesNotRevert() public view {
        ReputationReader.AgentReport memory r = reader.reportForAgentKey(agentKey);
        assertTrue(r.found);
        assertEq(r.clientCount, 0);
        assertEq(r.approvedCount, 0);
        assertEq(r.declinedCount, 0);
    }
}
