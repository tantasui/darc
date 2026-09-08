// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Hashes} from "@openzeppelin/contracts/utils/cryptography/Hashes.sol";

import {CardManager} from "../src/CardManager.sol";
import {SpendGate} from "../src/SpendGate.sol";
import {SpendRouter} from "../src/SpendRouter.sol";
import {ReputationReader} from "../src/ReputationReader.sol";
import {MockUSD} from "../src/mocks/MockUSD.sol";
import {MockMerchant} from "../src/mocks/MockMerchant.sol";
import {SpendAuth, AgentCardTypes} from "../src/lib/AgentCardTypes.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";
import {MockReputationRegistry} from "./mocks/MockReputationRegistry.sol";

/// @notice Shared fixture: a full AgentCard deployment with one issued card.
abstract contract AgentCardBase is Test {
    MockIdentityRegistry internal identity;
    MockReputationRegistry internal reputation;
    MockUSD internal usd;
    CardManager internal cardManager;
    SpendGate internal gate;
    SpendRouter internal router;
    MockMerchant internal merchantA;
    MockMerchant internal merchantB;
    ReputationReader internal reader;

    uint256 internal ownerPk = 0xA11CE;
    uint256 internal agentPk = 0xA6E27;
    uint256 internal strangerPk = 0xBAD;
    address internal owner;
    address internal agentKey;
    address internal relayer = makeAddr("relayer");

    bytes32 internal cardId;
    uint256 internal agentId;

    uint256 internal constant DAILY_CAP = 50e6; // $50 at 6 decimals
    uint64 internal constant CARD_TTL = 30 days;

    function setUp() public virtual {
        // A realistic, mid-day starting timestamp so day-bucket tests are unambiguous.
        vm.warp(1_760_000_000);

        owner = vm.addr(ownerPk);
        agentKey = vm.addr(agentPk);

        identity = new MockIdentityRegistry();
        reputation = new MockReputationRegistry(address(identity));
        usd = new MockUSD();
        cardManager = new CardManager(address(identity));
        gate = new SpendGate(address(cardManager), address(usd));
        router = new SpendRouter(address(gate));
        merchantA = new MockMerchant(address(router), address(cardManager), address(reputation));
        merchantB = new MockMerchant(address(router), address(cardManager), address(reputation));
        reader = new ReputationReader(address(cardManager), address(reputation), address(identity));

        // Owner is funded and grants a BOUNDED approval to SpendGate.
        usd.mint(owner, 10_000e6);
        vm.prank(owner);
        usd.approve(address(gate), 1_000e6);

        vm.prank(owner);
        (cardId, agentId) = cardManager.issueCard(
            agentKey, DAILY_CAP, _rootFor(address(merchantA)), _ttl(), "ipfs://agent-card"
        );
    }

    function _ttl() internal view returns (uint64) {
        return uint64(block.timestamp + CARD_TTL);
    }

    function _leaf(address merchant) internal pure returns (bytes32) {
        return AgentCardTypes.merchantLeaf(merchant);
    }

    /// @dev Single-merchant tree: the root IS the leaf and the proof is empty.
    function _rootFor(address merchant) internal pure returns (bytes32) {
        return _leaf(merchant);
    }

    /// @dev Two-leaf tree using OpenZeppelin's commutative (sorted-pair) hashing.
    function _rootFor(address m0, address m1) internal pure returns (bytes32) {
        return Hashes.commutativeKeccak256(_leaf(m0), _leaf(m1));
    }

    function _proofFor(address sibling) internal pure returns (bytes32[] memory proof) {
        proof = new bytes32[](1);
        proof[0] = _leaf(sibling);
    }

    function _noProof() internal pure returns (bytes32[] memory) {
        return new bytes32[](0);
    }

    function _auth(address merchant, uint256 amount, uint256 nonce) internal view returns (SpendAuth memory) {
        return SpendAuth({
            cardId: cardId,
            merchant: merchant,
            token: address(usd),
            amount: amount,
            nonce: nonce,
            deadline: block.timestamp + 5 minutes,
            policyVersion: cardManager.getCard(cardId).policyVersion
        });
    }

    function _sign(SpendAuth memory auth, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, gate.hashSpendAuth(auth));
        return abi.encodePacked(r, s, v);
    }

    /// @notice Agent signs, relayer submits through the merchant. The agent pays no gas.
    function _charge(MockMerchant merchant, SpendAuth memory auth, bytes32[] memory proof)
        internal
        returns (bool ok, bytes4 reason)
    {
        bytes memory sig = _sign(auth, agentPk);
        vm.prank(relayer);
        return merchant.charge(auth, sig, proof);
    }
}
