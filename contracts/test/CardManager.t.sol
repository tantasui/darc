// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AgentCardBase} from "./AgentCardBase.t.sol";
import {CardManager} from "../src/CardManager.sol";

/// @notice Issuance, policy, revocation, and the ERC-8004 identity wiring.
contract CardManagerTest is AgentCardBase {
    function test_issueCard_storesPolicyAndMintsIdentity() public view {
        CardManager.Card memory card = cardManager.getCard(cardId);
        assertEq(card.agentKey, agentKey);
        assertEq(card.owner, owner);
        assertEq(card.dailyCap, DAILY_CAP);
        assertEq(card.merchantRoot, _rootFor(address(merchantA)));
        assertFalse(card.revoked);
        assertEq(card.policyVersion, 1);

        // The identity NFT is custodied by CardManager, bound to the card lifecycle.
        assertEq(identity.ownerOf(agentId), address(cardManager));
        assertEq(cardManager.agentIdOfCard(cardId), agentId);
    }

    /// @dev The reverse index the ERC-8004 registry does not provide, and which the
    ///      Verifier page depends on.
    function test_reverseLookup_agentKeyToCard() public view {
        assertEq(cardManager.cardIdOfAgentKey(agentKey), cardId);
        assertEq(cardManager.cardIdOfAgentKey(address(0xBEEF)), bytes32(0));
    }

    function test_cardId_isOwnerAgentKeyPair() public view {
        assertEq(cardId, cardManager.cardIdFor(owner, agentKey));
        assertTrue(cardId != cardManager.cardIdFor(address(0xBEEF), agentKey));
    }

    function test_issueCard_revertsOnZeroAgentKey() public {
        vm.prank(owner);
        vm.expectRevert(CardManager.ZeroAgentKey.selector);
        cardManager.issueCard(address(0), DAILY_CAP, bytes32(0), _ttl(), "");
    }

    function test_issueCard_revertsOnPastExpiry() public {
        vm.prank(owner);
        vm.expectRevert(CardManager.InvalidExpiry.selector);
        cardManager.issueCard(address(0xA1), DAILY_CAP, bytes32(0), uint64(block.timestamp), "");
    }

    /// @dev An agent key is consumed permanently, so a revoked agent cannot be
    ///      resurrected by re-issuing to the same key.
    function test_issueCard_agentKeyCannotBeReused_evenAfterRevocation() public {
        vm.prank(owner);
        cardManager.revoke(cardId);

        vm.prank(owner);
        vm.expectRevert(CardManager.AgentKeyAlreadyUsed.selector);
        cardManager.issueCard(agentKey, DAILY_CAP, bytes32(0), _ttl(), "");
    }

    function test_issueCard_differentOwnersGetDistinctCards() public {
        address other = makeAddr("otherOwner");
        vm.prank(other);
        (bytes32 otherCard, uint256 otherAgent) =
            cardManager.issueCard(makeAddr("agent2"), 10e6, bytes32(0), _ttl(), "");
        assertTrue(otherCard != cardId);
        assertTrue(otherAgent != agentId);
    }

    // --- access control ---------------------------------------------------------

    function test_revoke_onlyOwner() public {
        vm.prank(makeAddr("attacker"));
        vm.expectRevert(CardManager.NotCardOwner.selector);
        cardManager.revoke(cardId);
    }

    function test_updatePolicy_onlyOwner() public {
        vm.prank(makeAddr("attacker"));
        vm.expectRevert(CardManager.NotCardOwner.selector);
        cardManager.updatePolicy(cardId, 1e6, bytes32(0), _ttl());
    }

    /// @dev No un-revoke, by design: a new card is a new issuance.
    function test_revoke_isTerminal() public {
        vm.startPrank(owner);
        cardManager.revoke(cardId);

        vm.expectRevert(CardManager.CardIsRevoked.selector);
        cardManager.revoke(cardId);

        vm.expectRevert(CardManager.CardIsRevoked.selector);
        cardManager.updatePolicy(cardId, 1e6, bytes32(0), _ttl());
        vm.stopPrank();
    }

    function test_updatePolicy_bumpsVersionEachTime() public {
        vm.startPrank(owner);
        cardManager.updatePolicy(cardId, 10e6, bytes32(0), _ttl());
        assertEq(cardManager.getCard(cardId).policyVersion, 2);
        cardManager.updatePolicy(cardId, 20e6, bytes32(0), _ttl());
        assertEq(cardManager.getCard(cardId).policyVersion, 3);
        vm.stopPrank();

        CardManager.Card memory card = cardManager.getCard(cardId);
        assertEq(card.dailyCap, 20e6);
    }

    function test_unknownCard_reverts() public {
        vm.prank(owner);
        vm.expectRevert(CardManager.CardNotFound.selector);
        cardManager.revoke(keccak256("nope"));
    }

    // --- ERC-8004 agentWallet binding -------------------------------------------

    /// @dev Proves the two-step binding works: the registry demands a signature from the
    ///      new wallet over a digest containing `agentId`, which only exists after
    ///      registration. Anyone may submit it; the agent's signature is the authority.
    function test_bindAgentWallet_pointsIdentityAtAgentKey() public {
        assertEq(identity.getAgentWallet(agentId), address(cardManager), "seeded to registrant");

        uint256 deadline = block.timestamp + 4 minutes;
        bytes32 digest = identity.walletSetDigest(agentId, agentKey, address(cardManager), deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, digest);

        // Submitted by an unrelated relayer, not the owner: no passkey prompt needed.
        vm.prank(relayer);
        cardManager.bindAgentWallet(cardId, deadline, abi.encodePacked(r, s, v));

        assertEq(identity.getAgentWallet(agentId), agentKey, "identity resolves to the agent key");
    }

    function test_bindAgentWallet_rejectsForeignSignature() public {
        uint256 deadline = block.timestamp + 4 minutes;
        bytes32 digest = identity.walletSetDigest(agentId, agentKey, address(cardManager), deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(strangerPk, digest);

        vm.expectRevert(bytes("invalid wallet sig"));
        cardManager.bindAgentWallet(cardId, deadline, abi.encodePacked(r, s, v));
    }

    function test_bindAgentWallet_rejectedAfterRevocation() public {
        vm.prank(owner);
        cardManager.revoke(cardId);

        vm.expectRevert(CardManager.CardIsRevoked.selector);
        cardManager.bindAgentWallet(cardId, block.timestamp + 1 minutes, hex"00");
    }
}
