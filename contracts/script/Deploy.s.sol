// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {CardManager} from "../src/CardManager.sol";
import {SpendGate} from "../src/SpendGate.sol";
import {SpendRouter} from "../src/SpendRouter.sol";
import {ReputationReader} from "../src/ReputationReader.sol";
import {MockUSD} from "../src/mocks/MockUSD.sol";
import {MockMerchant} from "../src/mocks/MockMerchant.sol";
import {IReputationRegistry} from "../src/interfaces/IERC8004.sol";

/// @notice Deploys AgentCard against the canonical ERC-8004 registries.
/// @dev Run with:
///        forge script script/Deploy.s.sol --rpc-url $MONAD_TESTNET_RPC --broadcast --verify
///      Addresses are written to config/addresses.ts by scripts/write-config.ts, which
///      reads the broadcast artifact -- nothing is copied by hand.
contract Deploy is Script {
    // Verified live on chain 10143. NOT the addresses in Monad's guide (those are mainnet
    // and have no code here); see README "Whose registries are these?".
    /// @dev Real AUSD on Monad Testnet (6 decimals). Not ours, and not a mock.
    address constant AUSD_MONAD_TESTNET = 0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC;

    address constant DEFAULT_IDENTITY_REGISTRY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address constant DEFAULT_REPUTATION_REGISTRY = 0x8004B663056A597Dffe9eCcC1965A193B7388713;

    function run() external {
        address identityRegistry = vm.envOr("IDENTITY_REGISTRY", DEFAULT_IDENTITY_REGISTRY);
        address reputationRegistry = vm.envOr("REPUTATION_REGISTRY", DEFAULT_REPUTATION_REGISTRY);

        // Fail fast rather than deploying against an empty address: this is exactly the
        // trap Monad's own guide sets, so we refuse to walk into it.
        require(identityRegistry.code.length > 0, "identity registry has no code on this chain");
        require(reputationRegistry.code.length > 0, "reputation registry has no code on this chain");
        require(
            IReputationRegistry(reputationRegistry).getIdentityRegistry() == identityRegistry,
            "registries are not wired to each other"
        );

        // Prefer the real stablecoin. MockUSD is only a fallback for chains where AUSD is
        // not deployed (a local anvil run), so the demo settles in a real asset wherever it can.
        address paymentToken = vm.envOr("PAYMENT_TOKEN", AUSD_MONAD_TESTNET);

        vm.startBroadcast();

        if (paymentToken.code.length == 0) {
            paymentToken = address(new MockUSD());
            console.log("WARNING: AUSD not found on this chain; deployed MockUSD instead");
        }
        CardManager cardManager = new CardManager(identityRegistry);
        SpendGate gate = new SpendGate(address(cardManager), paymentToken);
        SpendRouter router = new SpendRouter(address(gate));
        // Three named merchants: two in a typical card's policy, one deliberately outside it,
        // so an out-of-scope refusal is demonstrable with real counterparties.
        MockMerchant merchantA =
            new MockMerchant("Lagos Cloud Hosting", address(router), address(cardManager), reputationRegistry);
        MockMerchant merchantB =
            new MockMerchant("Horizon Data API", address(router), address(cardManager), reputationRegistry);
        MockMerchant merchantC =
            new MockMerchant("Riverside Subscriptions", address(router), address(cardManager), reputationRegistry);
        ReputationReader reader =
            new ReputationReader(address(cardManager), reputationRegistry, identityRegistry);

        vm.stopBroadcast();

        console.log("chainId           ", block.chainid);
        console.log("identityRegistry  ", identityRegistry);
        console.log("reputationRegistry", reputationRegistry);
        console.log("paymentToken      ", paymentToken);
        console.log("cardManager       ", address(cardManager));
        console.log("spendGate         ", address(gate));
        console.log("spendRouter       ", address(router));
        console.log("merchantA         ", address(merchantA));
        console.log("merchantB         ", address(merchantB));
        console.log("merchantC         ", address(merchantC));
        console.log("reputationReader  ", address(reader));
    }
}
