// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Poidh} from "./Poidh.sol";

/**
 * @title PoidhFactory
 * @author heesho
 * @notice Factory contract for deploying Poidh bounty clones using EIP-1167.
 *         Maintains registry of all bounties and handles initial funding.
 *         Owner can update implementation and treasury addresses.
 */
contract PoidhFactory is Ownable {

    /*//////////////////////////////////////////////////////////////
                                STATE
    //////////////////////////////////////////////////////////////*/

    address public implementation;  // master Poidh logic contract
    address public treasury;        // protocol fee recipient

    address[] public allBounties;  // registry of all deployed bounties

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error PoidhFactory__ZeroAddress();

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event PoidhFactory__BountyCreated(
        address indexed bountyAddress,
        address indexed issuer,
        string metadataURI,
        bool joinable,
        uint256 index
    );

    event PoidhFactory__ImplementationUpdated(
        address indexed oldImplementation,
        address indexed newImplementation
    );

    event PoidhFactory__TreasuryUpdated(
        address indexed oldTreasury,
        address indexed newTreasury
    );

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @notice Deploys factory and master implementation
    /// @param _treasury Address receiving 2.5% protocol fees
    constructor(address _treasury) {
        implementation = address(new Poidh());
        treasury = _treasury;
    }

    /*//////////////////////////////////////////////////////////////
                          OWNER FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Updates the implementation contract for new bounties
    /// @dev Only affects newly created bounties, existing ones keep their implementation
    /// @param _implementation New implementation address
    function setImplementation(address _implementation) external onlyOwner {
        if (_implementation == address(0)) revert PoidhFactory__ZeroAddress();

        address oldImplementation = implementation;
        implementation = _implementation;

        emit PoidhFactory__ImplementationUpdated(oldImplementation, _implementation);
    }

    /// @notice Updates the treasury address for new bounties
    /// @dev Only affects newly created bounties, existing ones keep their treasury
    /// @param _treasury New treasury address (can be zero to disable fees)
    function setTreasury(address _treasury) external onlyOwner {
        address oldTreasury = treasury;
        treasury = _treasury;

        emit PoidhFactory__TreasuryUpdated(oldTreasury, _treasury);
    }

    /*//////////////////////////////////////////////////////////////
                          EXTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Deploys a new bounty
    /// @param metadataURI IPFS hash of bounty details
    /// @param joinable If true, others can join (open bounty). If false, solo bounty.
    /// @return clone Address of the new bounty
    function createBounty(string calldata metadataURI, bool joinable) external payable returns (address clone) {
        clone = Clones.clone(implementation);
        Poidh(clone).initialize{value: msg.value}(msg.sender, treasury, metadataURI, joinable);

        allBounties.push(clone);
        emit PoidhFactory__BountyCreated(clone, msg.sender, metadataURI, joinable, allBounties.length - 1);
    }

    /*//////////////////////////////////////////////////////////////
                            VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Returns total number of bounties created
    function getBountiesCount() external view returns (uint256) {
        return allBounties.length;
    }

    /// @notice Returns paginated list of bounty addresses
    /// @param limit Max number of bounties to return
    /// @param offset Starting index
    function getBounties(uint256 limit, uint256 offset) external view returns (address[] memory) {
        uint256 total = allBounties.length;
        if (offset >= total) return new address[](0);

        uint256 end = offset + limit;
        if (end > total) end = total;
        uint256 resultSize = end - offset;

        address[] memory result = new address[](resultSize);
        for (uint256 i = 0; i < resultSize; i++) {
            result[i] = allBounties[offset + i];
        }
        return result;
    }
}
