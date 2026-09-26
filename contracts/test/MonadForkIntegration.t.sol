// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

import {CardManager} from "../src/CardManager.sol";
import {SpendGate} from "../src/SpendGate.sol";
import {SpendRouter} from "../src/SpendRouter.sol";
import {ReputationReader} from "../src/ReputationReader.sol";
import {MockUSD} from "../src/mocks/MockUSD.sol";
import {MockMerchant} from "../src/mocks/MockMerchant.sol";
import {SpendAuth} from "../src/lib/AgentCardTypes.sol";
import {IIdentityRegistry, IReputationRegistry} from "../src/interfaces/IERC8004.sol";

/// @notice Runs the whole flow against the REAL ERC-8004 registries on Monad Testnet.
///
/// @dev Unit tests use faithful mocks; this proves the mocks are not flattering us. In
///      particular it proves the load-bearing claim of the design: the canonical registry
///      lets a MERCHANT rate an agent whose identity CardManager owns, and blocks
///      CardManager from rating it.
///
///      Addresses below are verified live. NOTE: Monad's ERC-8004 guide publishes
///      0x8004A169.../0x8004BAa1..., which are the MAINNET singletons and have no code on
///      chain 10143. These are the testnet deployments.
contract MonadForkIntegrationTest is Test {
    address internal constant IDENTITY_REGISTRY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address internal constant REPUTATION_REGISTRY = 0x8004B663056A597Dffe9eCcC1965A193B7388713;
    uint256 internal constant MONAD_TESTNET_CHAIN_ID = 10143;

    CardManager internal cardManager;
    SpendGate internal gate;
    SpendRouter internal router;
    MockUSD internal usd;
    MockMerchant internal merchantA;
    ReputationReader internal reader;

    uint256 internal ownerPk = 0xA11CE;
    uint256 internal agentPk = 0xA6E27;
    address internal owner;
    address internal agentKey;

    bytes32 internal cardId;
    uint256 internal agentId;

    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_TESTNET_RPC", string("https://testnet-rpc.monad.xyz"));
        try vm.createSelectFork(rpc) {
            forked = true;
        } catch {
            return; // No network in this environment; the test skips itself.
        }

        owner = vm.addr(ownerPk);
        agentKey = vm.addr(agentPk);

        usd = new MockUSD();
        cardManager = new CardManager(IDENTITY_REGISTRY);
        gate = new SpendGate(address(cardManager), address(usd));
        router = new SpendRouter(address(gate));
        merchantA = new MockMerchant(address(router), address(cardManager), REPUTATION_REGISTRY);
        reader = new ReputationReader(address(cardManager), REPUTATION_REGISTRY, IDENTITY_REGISTRY);

        usd.mint(owner, 1_000e6);
        vm.prank(owner);
        usd.approve(address(gate), 500e6);
    }

    modifier onlyForked() {
        if (!forked) {
            vm.skip(true);
            return;
        }
        _;
    }

    function test_registriesAreLiveAndWired() public onlyForked {
        assertEq(block.chainid, MONAD_TESTNET_CHAIN_ID, "forked the wrong chain");
        assertGt(IDENTITY_REGISTRY.code.length, 0, "identity registry has code");
        assertGt(REPUTATION_REGISTRY.code.length, 0, "reputation registry has code");
        assertEq(
            IReputationRegistry(REPUTATION_REGISTRY).getIdentityRegistry(),
            IDENTITY_REGISTRY,
            "reputation registry points at the identity registry"
        );
    }

    /// @dev The addresses in Monad's own guide are mainnet; they are empty here. Encoded
    ///      as a test so a future doc-following change cannot silently reintroduce them.
    function test_guideAddressesAreNotDeployedOnTestnet() public onlyForked {
        assertEq(address(0x8004A169FB4a3325136EB29fA0ceB6D2e539a432).code.length, 0);
        assertEq(address(0x8004BAa17C55a88189AE136b182e5fdA19dE9b63).code.length, 0);
    }

    function test_issueCard_registersOnTheRealIdentityRegistry() public onlyForked {
        _issue();

        assertEq(IIdentityRegistry(IDENTITY_REGISTRY).ownerOf(agentId), address(cardManager));
        assertEq(cardManager.cardIdOfAgentKey(agentKey), cardId);
        // register() seeds agentWallet to the registrant until bindAgentWallet runs.
        assertEq(IIdentityRegistry(IDENTITY_REGISTRY).getAgentWallet(agentId), address(cardManager));
    }

    function test_bindAgentWallet_againstRealRegistry() public onlyForked {
        _issue();

        uint256 deadline = block.timestamp + 4 minutes;
        bytes32 typeHash =
            keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)");
        bytes32 structHash =
            keccak256(abi.encode(typeHash, agentId, agentKey, address(cardManager), deadline));
        bytes32 digest = _domainDigest(structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, digest);

        cardManager.bindAgentWallet(cardId, deadline, abi.encodePacked(r, s, v));
        assertEq(IIdentityRegistry(IDENTITY_REGISTRY).getAgentWallet(agentId), agentKey);
    }

    /// @dev THE decisive test. The canonical registry must accept merchant-authored
    ///      feedback and reject issuer-authored feedback.
    function test_merchantCanRateAgent_butIssuerCannot() public onlyForked {
        _issue();

        // Issuer is structurally barred.
        vm.prank(address(cardManager));
        vm.expectRevert(bytes("Self-feedback not allowed"));
        IReputationRegistry(REPUTATION_REGISTRY)
            .giveFeedback(agentId, 100, 0, "approved", "approved", "", "", bytes32(0));

        // Merchant, the counterparty, is not.
        SpendAuth memory auth = _auth(20e6, 1);
        (bool ok,) = merchantA.charge(auth, _sign(auth), new bytes32[](0));
        assertTrue(ok, "in-policy spend settles");

        address[] memory clients = IReputationRegistry(REPUTATION_REGISTRY).getClients(agentId);
        assertEq(clients.length, 1);
        assertEq(clients[0], address(merchantA), "the merchant is the feedback author");

        (uint64 approved,,) =
            IReputationRegistry(REPUTATION_REGISTRY).getSummary(agentId, clients, "", "approved");
        assertEq(approved, 1, "approval recorded on the canonical registry");
    }

    /// @dev End-to-end trail on real infrastructure: one approval, one refusal, then revoked.
    function test_fullTrail_onCanonicalRegistries() public onlyForked {
        _issue();

        SpendAuth memory good = _auth(20e6, 1);
        merchantA.charge(good, _sign(good), new bytes32[](0));

        SpendAuth memory tooBig = _auth(200e6, 2);
        (bool ok, bytes4 reason) = merchantA.charge(tooBig, _sign(tooBig), new bytes32[](0));
        assertFalse(ok);
        assertEq(reason, SpendGate.DailyCapExceeded.selector);

        ReputationReader.AgentReport memory report = reader.reportForAgentKey(agentKey);
        assertEq(report.approvedCount, 1);
        assertEq(report.declinedCount, 1);
        assertTrue(reader.isTrusted(agentKey));

        vm.prank(owner);
        cardManager.revoke(cardId);
        assertFalse(reader.isTrusted(agentKey));
    }

    // --- helpers ----------------------------------------------------------------

    function _issue() internal {
        vm.prank(owner);
        (cardId, agentId) = cardManager.issueCard(
            agentKey, 50e6, bytes32(0), uint64(block.timestamp + 30 days), "ipfs://agentcard-demo"
        );
    }

    function _auth(uint256 amount, uint256 nonce) internal view returns (SpendAuth memory) {
        return SpendAuth({
            cardId: cardId,
            merchant: address(merchantA),
            token: address(usd),
            amount: amount,
            nonce: nonce,
            deadline: block.timestamp + 5 minutes,
            policyVersion: cardManager.getCard(cardId).policyVersion
        });
    }

    function _sign(SpendAuth memory auth) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, gate.hashSpendAuth(auth));
        return abi.encodePacked(r, s, v);
    }

    /// @dev EIP-712 digest under the identity registry's own domain.
    function _domainDigest(bytes32 structHash) internal view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("ERC8004IdentityRegistry")),
                keccak256(bytes("1")),
                block.chainid,
                IDENTITY_REGISTRY
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }
}
