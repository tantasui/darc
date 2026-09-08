// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AgentCardBase} from "./AgentCardBase.t.sol";
import {SpendGate} from "../src/SpendGate.sol";
import {ReputationReader} from "../src/ReputationReader.sol";
import {SpendAuth} from "../src/lib/AgentCardTypes.sol";

/// @notice The 90-second demo, executed as a test. If the pitch changes, this fails.
contract DemoScriptTest is AgentCardBase {
    function test_theNinetySecondDemo() public {
        // 1. Owner issued a card: $50/day, merchants {A}. (Done in setUp, under one
        //    passkey prompt in the real app.)
        assertEq(cardManager.getCard(cardId).dailyCap, 50e6);
        assertEq(gate.remainingToday(cardId), 50e6);

        // 2. Agent buys $20 at merchant A -> approved.
        (bool ok1, bytes4 r1) = _charge(merchantA, _auth(address(merchantA), 20e6, 1), _noProof());
        assertTrue(ok1, "step 2: in-policy purchase approved");
        assertEq(r1, bytes4(0));
        assertEq(usd.balanceOf(address(merchantA)), 20e6);
        assertEq(gate.remainingToday(cardId), 30e6, "allowance now $30");

        // 3. Agent tries $200 -> declined, DailyCapExceeded, publicly.
        (bool ok2, bytes4 r2) = _charge(merchantA, _auth(address(merchantA), 200e6, 2), _noProof());
        assertFalse(ok2);
        assertEq(r2, SpendGate.DailyCapExceeded.selector, "step 3: over-cap refused");

        // 4. Agent tries merchant B -> declined, MerchantNotAllowed.
        (bool ok3, bytes4 r3) = _charge(merchantB, _auth(address(merchantB), 5e6, 3), _noProof());
        assertFalse(ok3);
        assertEq(r3, SpendGate.MerchantNotAllowed.selector, "step 4: out-of-scope merchant refused");

        // 5. Verifier page: a third party reads the agent's record.
        ReputationReader.AgentReport memory before = reader.reportForAgentKey(agentKey);
        assertEq(before.approvedCount, 1, "1 approved");
        assertEq(before.declinedCount, 2, "2 declined");
        assertFalse(before.revoked);
        assertTrue(reader.isTrusted(agentKey));

        // 6. Owner revokes (one passkey prompt) -> the next attempt dies instantly.
        vm.prank(owner);
        cardManager.revoke(cardId);

        (bool ok4, bytes4 r4) = _charge(merchantA, _auth(address(merchantA), 1e6, 4), _noProof());
        assertFalse(ok4);
        assertEq(r4, SpendGate.CardRevoked.selector, "step 6: revocation is instant");

        ReputationReader.AgentReport memory finalReport = reader.reportForAgentKey(agentKey);
        assertTrue(finalReport.revoked);
        assertFalse(reader.isTrusted(agentKey));

        // Throughout: the agent never held funds and never paid gas.
        assertEq(usd.balanceOf(agentKey), 0);
        assertEq(agentKey.balance, 0);
    }

    /// @dev Fuzz the invariant that matters most: no sequence of agent-signed spends can
    ///      ever move more than the daily cap out of the owner's account in one day.
    function testFuzz_capIsNeverExceededInADay(uint128 a, uint128 b, uint128 c) public {
        uint256[3] memory amounts = [uint256(a) % 100e6, uint256(b) % 100e6, uint256(c) % 100e6];
        uint256 ownerBefore = usd.balanceOf(owner);

        for (uint256 i; i < 3; i++) {
            if (amounts[i] == 0) continue;
            _charge(merchantA, _auth(address(merchantA), amounts[i], i + 1), _noProof());
        }

        assertLe(ownerBefore - usd.balanceOf(owner), DAILY_CAP, "cap is a hard ceiling");
    }

    /// @dev No signature the agent did not produce can ever move funds.
    function testFuzz_onlyTheAgentKeyCanAuthorize(uint256 wrongPk) public {
        wrongPk = bound(wrongPk, 1, 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364140);
        vm.assume(vm.addr(wrongPk) != agentKey);

        SpendAuth memory auth = _auth(address(merchantA), 10e6, 1);
        bytes memory sig = _sign(auth, wrongPk);

        vm.expectRevert(SpendGate.BadAgentSignature.selector);
        gate.spend(auth, sig, _noProof());
    }
}
