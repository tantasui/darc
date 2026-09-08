// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";

import {CardManager} from "../src/CardManager.sol";
import {SpendGate} from "../src/SpendGate.sol";
import {SpendRouter} from "../src/SpendRouter.sol";
import {ReputationReader} from "../src/ReputationReader.sol";
import {MockUSD} from "../src/mocks/MockUSD.sol";
import {MockMerchant} from "../src/mocks/MockMerchant.sol";
import {SpendAuth} from "../src/lib/AgentCardTypes.sol";

/// @notice Post-deploy smoke test: the 90-second demo, run against the ADDRESSES WE JUST
///         DEPLOYED, on a fork of live Monad Testnet.
///
/// @dev This is the step that catches a deploy that succeeded but wired something wrong --
///      a gate pointing at the wrong CardManager, a merchant pointing at the wrong router,
///      a registry mismatch. `DemoScript.t.sol` proves the code is right; this proves the
///      DEPLOYMENT is right. Skips itself unless the deployed addresses are provided.
///
/// Usage after deploying:
///   CARD_MANAGER=0x.. SPEND_GATE=0x.. SPEND_ROUTER=0x.. MOCK_USD=0x.. \
///   MERCHANT_A=0x.. MERCHANT_B=0x.. REPUTATION_READER=0x.. \
///   forge test --match-path test/DeployedSmoke.t.sol -vv
contract DeployedSmokeTest is Test {
    CardManager internal cardManager;
    SpendGate internal gate;
    SpendRouter internal router;
    MockUSD internal usd;
    MockMerchant internal merchantA;
    MockMerchant internal merchantB;
    ReputationReader internal reader;

    uint256 internal ownerPk = 0xA11CE;
    uint256 internal agentPk = 0xA6E27;
    address internal owner;
    address internal agentKey;

    bool internal ready;

    function setUp() public {
        address cardManagerAddr = vm.envOr("CARD_MANAGER", address(0));
        if (cardManagerAddr == address(0)) return;

        string memory rpc = vm.envOr("MONAD_TESTNET_RPC", string("https://testnet-rpc.monad.xyz"));
        try vm.createSelectFork(rpc) {}
        catch {
            return;
        }

        cardManager = CardManager(cardManagerAddr);
        gate = SpendGate(vm.envAddress("SPEND_GATE"));
        router = SpendRouter(vm.envAddress("SPEND_ROUTER"));
        usd = MockUSD(vm.envAddress("MOCK_USD"));
        merchantA = MockMerchant(vm.envAddress("MERCHANT_A"));
        merchantB = MockMerchant(vm.envAddress("MERCHANT_B"));
        reader = ReputationReader(vm.envAddress("REPUTATION_READER"));

        owner = vm.addr(ownerPk);
        agentKey = vm.addr(agentPk);
        ready = true;
    }

    modifier onlyDeployed() {
        if (!ready) {
            vm.skip(true);
            return;
        }
        _;
    }

    /// @dev Wiring assertions first: a mis-wired deployment fails here with a clear reason
    ///      rather than as a confusing revert deep in the demo flow.
    function test_deploymentIsWiredCorrectly() public onlyDeployed {
        assertEq(block.chainid, 10143, "wrong chain");
        assertGt(address(cardManager).code.length, 0, "CardManager not deployed");

        assertEq(address(gate.cardManager()), address(cardManager), "gate -> cardManager");
        assertEq(gate.paymentToken(), address(usd), "gate -> paymentToken");
        assertEq(address(router.spendGate()), address(gate), "router -> gate");

        assertEq(address(merchantA.router()), address(router), "merchantA -> router");
        assertEq(address(merchantB.router()), address(router), "merchantB -> router");
        assertEq(address(merchantA.cardManager()), address(cardManager), "merchantA -> cardManager");

        assertEq(address(reader.cardManager()), address(cardManager), "reader -> cardManager");
        assertEq(
            address(merchantA.reputation()),
            address(reader.reputation()),
            "merchant and reader disagree on registry"
        );

        // The registries must be the canonical ones with code, not the mainnet addresses.
        assertGt(address(reader.identityRegistry()).code.length, 0, "identity registry empty");
        assertGt(address(reader.reputation()).code.length, 0, "reputation registry empty");
        assertEq(usd.decimals(), 6, "payment token must be 6-decimal");
    }

    /// @dev The full demo against the real deployment.
    function test_demoFlow_againstDeployedContracts() public onlyDeployed {
        usd.mint(owner, 1_000e6);
        vm.prank(owner);
        usd.approve(address(gate), 500e6);

        vm.prank(owner);
        (bytes32 cardId, uint256 agentId) = cardManager.issueCard(
            agentKey,
            50e6,
            _leafRoot(address(merchantA)),
            uint64(block.timestamp + 30 days),
            "ipfs://agentcard-demo"
        );
        console.log("issued cardId / agentId:", vm.toString(cardId), agentId);

        // 2. In-policy purchase -> approved.
        (bool ok1,) = _charge(merchantA, cardId, address(merchantA), 20e6, 1);
        assertTrue(ok1, "in-policy purchase must settle");
        assertEq(gate.remainingToday(cardId), 30e6);

        // 3. Over cap -> declined.
        (bool ok2, bytes4 r2) = _charge(merchantA, cardId, address(merchantA), 200e6, 2);
        assertFalse(ok2);
        assertEq(r2, SpendGate.DailyCapExceeded.selector);

        // 4. Wrong merchant -> declined.
        (bool ok3, bytes4 r3) = _charge(merchantB, cardId, address(merchantB), 5e6, 3);
        assertFalse(ok3);
        assertEq(r3, SpendGate.MerchantNotAllowed.selector);

        // 5. Third-party verifier reads the trail off the canonical registry.
        ReputationReader.AgentReport memory report = reader.reportForAgentKey(agentKey);
        assertEq(report.agentId, agentId);
        assertEq(report.approvedCount, 1, "1 approved");
        assertEq(report.declinedCount, 2, "2 declined");
        assertTrue(reader.isTrusted(agentKey));

        // 6. Revoke -> next attempt dies instantly.
        vm.prank(owner);
        cardManager.revoke(cardId);
        (bool ok4, bytes4 r4) = _charge(merchantA, cardId, address(merchantA), 1e6, 4);
        assertFalse(ok4);
        assertEq(r4, SpendGate.CardRevoked.selector);
        assertFalse(reader.isTrusted(agentKey));
    }

    function _leafRoot(address merchant) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(merchant))));
    }

    function _charge(MockMerchant merchant, bytes32 cardId, address to, uint256 amount, uint256 nonce)
        internal
        returns (bool ok, bytes4 reason)
    {
        SpendAuth memory auth = SpendAuth({
            cardId: cardId,
            merchant: to,
            token: address(usd),
            amount: amount,
            nonce: nonce,
            deadline: block.timestamp + 5 minutes,
            policyVersion: cardManager.getCard(cardId).policyVersion
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, gate.hashSpendAuth(auth));
        return merchant.charge(auth, abi.encodePacked(r, s, v), new bytes32[](0));
    }
}
