// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AgentCardBase} from "./AgentCardBase.t.sol";
import {CardManager} from "../src/CardManager.sol";
import {SpendGate} from "../src/SpendGate.sol";
import {SpendAuth} from "../src/lib/AgentCardTypes.sol";
import {MockMerchant} from "../src/mocks/MockMerchant.sol";

/// @notice The enforcement point: one test per link in the trust chain, and one per
///         decline reason. The error taxonomy is the audit trail, so each error is
///         asserted by selector, not just "it reverted".
contract SpendGateTest is AgentCardBase {
    // --- full chain, happy path -------------------------------------------------

    function test_fullChain_approvedSpend_settlesAndRecords() public {
        uint256 ownerBefore = usd.balanceOf(owner);
        SpendAuth memory auth = _auth(address(merchantA), 20e6, 1);

        vm.expectEmit(true, true, false, true, address(gate));
        emit SpendGate.SpendApproved(cardId, address(merchantA), 20e6, 1, 20e6);

        (bool ok, bytes4 reason) = _charge(merchantA, auth, _noProof());

        assertTrue(ok, "spend should settle");
        assertEq(reason, bytes4(0));
        assertEq(usd.balanceOf(address(merchantA)), 20e6, "merchant paid");
        assertEq(usd.balanceOf(owner), ownerBefore - 20e6, "owner debited");
        assertTrue(gate.nonceUsed(cardId, 1), "nonce consumed");
        assertEq(gate.remainingToday(cardId), 30e6, "allowance reduced");
    }

    /// @dev The agent signs but never transacts: it holds no gas and no balance.
    function test_agentNeverPaysGasAndHoldsNoFunds() public {
        _charge(merchantA, _auth(address(merchantA), 10e6, 1), _noProof());
        assertEq(agentKey.balance, 0, "agent holds no native token");
        assertEq(usd.balanceOf(agentKey), 0, "agent holds no funds");
    }

    // --- decline reasons, in verification order ---------------------------------

    function test_decline_cardNotFound() public {
        SpendAuth memory auth = _auth(address(merchantA), 10e6, 1);
        auth.cardId = keccak256("no-such-card");
        _expectRevert(auth, SpendGate.CardNotFound.selector);
    }

    function test_decline_cardRevoked() public {
        vm.prank(owner);
        cardManager.revoke(cardId);
        _expectRevert(_auth(address(merchantA), 10e6, 1), SpendGate.CardRevoked.selector);
    }

    function test_decline_cardExpired() public {
        vm.warp(block.timestamp + CARD_TTL + 1);
        _expectRevert(_auth(address(merchantA), 10e6, 1), SpendGate.CardExpired.selector);
    }

    function test_decline_deadlineExpired() public {
        SpendAuth memory auth = _auth(address(merchantA), 10e6, 1);
        bytes memory sig = _sign(auth, agentPk);
        // The auth goes stale in transit: this is what makes an intercepted auth useless.
        vm.warp(auth.deadline + 1);
        vm.expectRevert(SpendGate.DeadlineExpired.selector);
        gate.spend(auth, sig, _noProof());
    }

    function test_decline_tokenNotAllowed() public {
        SpendAuth memory auth = _auth(address(merchantA), 10e6, 1);
        auth.token = address(0xDEAD);
        _expectRevert(auth, SpendGate.TokenNotAllowed.selector);
    }

    /// @dev updatePolicy bumps the version, so every auth signed under the old policy dies.
    function test_decline_policyVersionStale_afterUpdatePolicy() public {
        SpendAuth memory auth = _auth(address(merchantA), 10e6, 1);
        bytes memory sig = _sign(auth, agentPk);

        vm.prank(owner);
        cardManager.updatePolicy(cardId, DAILY_CAP, _rootFor(address(merchantA)), _ttl());

        vm.expectRevert(SpendGate.PolicyVersionStale.selector);
        gate.spend(auth, sig, _noProof());
    }

    function test_decline_badAgentSignature_wrongSigner() public {
        SpendAuth memory auth = _auth(address(merchantA), 10e6, 1);
        bytes memory sig = _sign(auth, strangerPk);
        vm.expectRevert(SpendGate.BadAgentSignature.selector);
        gate.spend(auth, sig, _noProof());
    }

    /// @dev Tampering with any signed field invalidates the signature.
    function test_decline_badAgentSignature_tamperedAmount() public {
        SpendAuth memory auth = _auth(address(merchantA), 10e6, 1);
        bytes memory sig = _sign(auth, agentPk);
        auth.amount = 40e6;
        vm.expectRevert(SpendGate.BadAgentSignature.selector);
        gate.spend(auth, sig, _noProof());
    }

    function test_decline_nonceReplay() public {
        SpendAuth memory auth = _auth(address(merchantA), 10e6, 1);
        bytes memory sig = _sign(auth, agentPk);
        gate.spend(auth, sig, _noProof());

        vm.expectRevert(SpendGate.NonceUsed.selector);
        gate.spend(auth, sig, _noProof());
    }

    /// @dev The used-set is order-independent: a lower nonce arriving late still works.
    ///      A monotonic counter would have killed it. This is why we rejected monotonic.
    function test_nonces_outOfOrderStillSettle() public {
        SpendAuth memory second = _auth(address(merchantA), 10e6, 2);
        SpendAuth memory first = _auth(address(merchantA), 10e6, 1);

        gate.spend(second, _sign(second, agentPk), _noProof());
        gate.spend(first, _sign(first, agentPk), _noProof());

        assertTrue(gate.nonceUsed(cardId, 1) && gate.nonceUsed(cardId, 2));
        assertEq(usd.balanceOf(address(merchantA)), 20e6);
    }

    function test_decline_merchantNotAllowed() public {
        SpendAuth memory auth = _auth(address(merchantB), 10e6, 1);
        _expectRevert(auth, SpendGate.MerchantNotAllowed.selector);
    }

    function test_decline_merchantNotAllowed_forgedProof() public {
        SpendAuth memory auth = _auth(address(merchantB), 10e6, 1);
        bytes memory sig = _sign(auth, agentPk);
        vm.expectRevert(SpendGate.MerchantNotAllowed.selector);
        gate.spend(auth, sig, _proofFor(address(merchantA)));
    }

    function test_decline_dailyCapExceeded_singleSpend() public {
        _expectRevert(_auth(address(merchantA), 200e6, 1), SpendGate.DailyCapExceeded.selector);
    }

    function test_decline_dailyCapExceeded_cumulative() public {
        SpendAuth memory a = _auth(address(merchantA), 30e6, 1);
        gate.spend(a, _sign(a, agentPk), _noProof());

        // 30 + 25 > 50: the second spend is refused even though each alone fits.
        _expectRevert(_auth(address(merchantA), 25e6, 2), SpendGate.DailyCapExceeded.selector);
    }

    function test_capBoundary_exactlyAtCapIsAllowed() public {
        SpendAuth memory auth = _auth(address(merchantA), DAILY_CAP, 1);
        gate.spend(auth, _sign(auth, agentPk), _noProof());
        assertEq(gate.remainingToday(cardId), 0);
    }

    // --- merchant scoping variants ----------------------------------------------

    function test_merkle_multiMerchantTree_bothAllowed() public {
        vm.prank(owner);
        cardManager.updatePolicy(cardId, DAILY_CAP, _rootFor(address(merchantA), address(merchantB)), _ttl());

        SpendAuth memory a = _auth(address(merchantA), 10e6, 1);
        gate.spend(a, _sign(a, agentPk), _proofFor(address(merchantB)));

        SpendAuth memory b = _auth(address(merchantB), 10e6, 2);
        gate.spend(b, _sign(b, agentPk), _proofFor(address(merchantA)));

        assertEq(usd.balanceOf(address(merchantA)), 10e6);
        assertEq(usd.balanceOf(address(merchantB)), 10e6);
    }

    /// @dev root == 0 is the documented "any merchant" wildcard.
    function test_merkle_zeroRootMeansAnyMerchant() public {
        vm.prank(owner);
        cardManager.updatePolicy(cardId, DAILY_CAP, bytes32(0), _ttl());

        SpendAuth memory auth = _auth(address(merchantB), 10e6, 1);
        gate.spend(auth, _sign(auth, agentPk), _noProof());
        assertEq(usd.balanceOf(address(merchantB)), 10e6);
    }

    // --- daily cap rollover ------------------------------------------------------

    function test_dayRollover_capResetsInNextUtcDay() public {
        SpendAuth memory a = _auth(address(merchantA), DAILY_CAP, 1);
        gate.spend(a, _sign(a, agentPk), _noProof());
        assertEq(gate.remainingToday(cardId), 0, "cap exhausted");

        vm.warp((block.timestamp / 1 days + 1) * 1 days + 1);
        assertEq(gate.remainingToday(cardId), DAILY_CAP, "fresh bucket");

        SpendAuth memory b = _auth(address(merchantA), DAILY_CAP, 2);
        gate.spend(b, _sign(b, agentPk), _noProof());
        assertEq(usd.balanceOf(address(merchantA)), 2 * DAILY_CAP);
    }

    /// @dev Documents the accepted edge: calendar buckets, not a trailing 24h window, so
    ///      a full cap at 23:59 and another at 00:01 is BY DESIGN.
    function test_dayRollover_twoFullCapsAcrossMidnightIsExpected() public {
        uint256 midnight = (block.timestamp / 1 days + 1) * 1 days;
        vm.warp(midnight - 60);
        SpendAuth memory a = _auth(address(merchantA), DAILY_CAP, 1);
        gate.spend(a, _sign(a, agentPk), _noProof());

        vm.warp(midnight + 60);
        SpendAuth memory b = _auth(address(merchantA), DAILY_CAP, 2);
        gate.spend(b, _sign(b, agentPk), _noProof());

        assertEq(usd.balanceOf(address(merchantA)), 2 * DAILY_CAP, "two caps in two minutes, by design");
    }

    function test_remainingToday_isZeroForRevokedCard() public {
        vm.prank(owner);
        cardManager.revoke(cardId);
        assertEq(gate.remainingToday(cardId), 0);
    }

    // --- revocation severs the approval path ------------------------------------

    /// @dev Revocation is what makes the owner's ERC-20 approval to SpendGate safe: the
    ///      approval persists, but no path to it survives.
    function test_revocation_isInstantAndTotal() public {
        SpendAuth memory a = _auth(address(merchantA), 10e6, 1);
        gate.spend(a, _sign(a, agentPk), _noProof());

        vm.prank(owner);
        cardManager.revoke(cardId);

        assertGt(usd.allowance(owner, address(gate)), 0, "approval still stands");
        _expectRevert(_auth(address(merchantA), 1e6, 2), SpendGate.CardRevoked.selector);
    }

    function _expectRevert(SpendAuth memory auth, bytes4 expected) internal {
        bytes memory sig = _sign(auth, agentPk);
        vm.expectRevert(expected);
        gate.spend(auth, sig, _noProof());
    }
}
