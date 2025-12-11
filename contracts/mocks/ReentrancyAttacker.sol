// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

interface IPoidhTarget {
    function join() external payable;
    function withdraw(address account) external;
    function submitClaim(string calldata name, string calldata proofURI) external;
}

/**
 * @title ReentrancyAttacker
 * @notice Mock contract for testing reentrancy protection
 */
contract ReentrancyAttacker {
    IPoidhTarget public target;
    uint256 public attackCount;
    bool public attacking;

    function setTarget(address _target) external {
        target = IPoidhTarget(_target);
    }

    function join(address _target) external payable {
        IPoidhTarget(_target).join{value: msg.value}();
    }

    function submitClaim(address _target, string calldata name, string calldata proofURI) external {
        IPoidhTarget(_target).submitClaim(name, proofURI);
    }

    function attackWithdraw() external {
        attacking = true;
        attackCount = 0;
        target.withdraw(address(this));
        attacking = false;
    }

    receive() external payable {
        if (attacking && attackCount < 5) {
            attackCount++;
            // Try to re-enter
            try target.withdraw(address(this)) {} catch {}
        }
    }
}
