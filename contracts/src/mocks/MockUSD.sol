// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Demo settlement token: 6 decimals, like real USD stablecoins.
contract MockUSD is ERC20 {
    uint256 public constant FAUCET_AMOUNT = 1_000e6;

    constructor() ERC20("Mock USD", "mUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function faucet() external {
        _mint(msg.sender, FAUCET_AMOUNT);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
