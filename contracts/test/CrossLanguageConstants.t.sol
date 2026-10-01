// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SpendGate} from "../src/SpendGate.sol";
import {AgentCardTypes} from "../src/lib/AgentCardTypes.sol";

/// @notice Pins the constants that the TypeScript layer recomputes independently.
/// @dev The agent signs in TS (viem `signTypedData`) and the gate verifies in Solidity;
///      the merchant Merkle leaf is built in TS and proved in Solidity; decline selectors
///      are decoded in TS from Solidity errors. A mismatch in any of them would compile,
///      test green in each language alone, and fail only during a live demo. These
///      literals are the shared contract, so drift breaks CI instead.
contract CrossLanguageConstantsTest is Test {
    /// @dev Mirrors the `types` object in scripts/demo.ts.
    function test_spendAuthTypehash_isPinned() public pure {
        assertEq(
            AgentCardTypes.SPEND_AUTH_TYPEHASH,
            0x2f99f8d6f78e35ee768987a4961964415f5f9c0bf7d43d9b7c4832e23874ed89,
            "SpendAuth typehash changed -- update the EIP-712 types in scripts/demo.ts and the app"
        );
    }

    /// @dev Mirrors `merchantLeaf()` in scripts/demo.ts. A mismatch makes every scoped
    ///      spend fail with MerchantNotAllowed and looks like a policy bug.
    function test_merchantLeaf_isPinned() public pure {
        assertEq(
            AgentCardTypes.merchantLeaf(0x00000000000000000000000000000000000000A1),
            0xd7297f74554f60b569bd6b30021b4a14a22b05de10b2f8793aa2f1b95e101289,
            "merchant leaf encoding changed -- update merchantLeaf() in scripts/demo.ts"
        );
    }

    /// @dev Mirrors cardIdFor() in lib/cards.ts, which the app uses to DISCOVER an owner's cards
    ///      without a backend: it derives each agent address from the passkey and reads the card
    ///      straight back. If this encoding drifted, discovery would silently find nothing.
    function test_cardId_isPinned() public pure {
        assertEq(
            AgentCardTypes.cardIdFor(
                0x79a4FEef1710163C3B69D10142F686D08194D793, 0x5989E938Fd81a6822bAEA528Ab6Db727D39DE2f2
            ),
            0x45c37b070448f20dab095b18442e2f40debaba5b2e44a5d3ee8ccc0eaed56880,
            "cardId encoding changed -- update cardIdFor() in lib/cards.ts or discovery breaks"
        );
    }

    /// @dev Mirrors the REASONS table in scripts/demo.ts, which turns a raw selector back
    ///      into a human-readable decline reason.
    function test_declineSelectors_arePinned() public pure {
        assertEq(SpendGate.CardNotFound.selector, bytes4(0x47920110), "CardNotFound");
        assertEq(SpendGate.CardRevoked.selector, bytes4(0x4b576fdb), "CardRevoked");
        assertEq(SpendGate.CardExpired.selector, bytes4(0xa21660f0), "CardExpired");
        assertEq(SpendGate.DeadlineExpired.selector, bytes4(0x1ab7da6b), "DeadlineExpired");
        assertEq(SpendGate.TokenNotAllowed.selector, bytes4(0xa29c4986), "TokenNotAllowed");
        assertEq(SpendGate.PolicyVersionStale.selector, bytes4(0xa25b2472), "PolicyVersionStale");
        assertEq(SpendGate.BadAgentSignature.selector, bytes4(0x8ab00260), "BadAgentSignature");
        assertEq(SpendGate.NonceUsed.selector, bytes4(0x1f6d5aef), "NonceUsed");
        assertEq(SpendGate.MerchantNotAllowed.selector, bytes4(0x84d9e4ff), "MerchantNotAllowed");
        assertEq(SpendGate.DailyCapExceeded.selector, bytes4(0xcc70389d), "DailyCapExceeded");
    }
}
