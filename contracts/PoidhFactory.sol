// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Poidh} from "./Poidh.sol";

/**
 * @title PoidhFactory
 * @author heesho
 * @notice Factory contract for deploying Poidh bounty clones using EIP-1167.
 *         Maintains registry of all bounties and handles initial funding.
 */
contract PoidhFactory {

    /*//////////////////////////////////////////////////////////////
                                IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    address public immutable implementation;  // master Poidh logic contract
    address public immutable treasury;        // protocol fee recipient

    /*//////////////////////////////////////////////////////////////
                                STATE
    //////////////////////////////////////////////////////////////*/

    address[] public allBounties;  // registry of all deployed bounties

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event PoidhFactory__SoloBountyCreated(
        address indexed bountyAddress,
        address indexed issuer,
        string metadataURI,
        uint256 index
    );

    event PoidhFactory__OpenBountyCreated(
        address indexed bountyAddress,
        address indexed issuer,
        string metadataURI,
        uint256 index
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
                          EXTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Deploys a solo bounty (not joinable by others)
    /// @param metadataURI IPFS hash of bounty details
    /// @return clone Address of the new bounty
    function createSoloBounty(string calldata metadataURI) external payable returns (address clone) {
        clone = Clones.clone(implementation);
        Poidh(clone).initialize{value: msg.value}(msg.sender, treasury, metadataURI, false);

        allBounties.push(clone);
        emit PoidhFactory__SoloBountyCreated(clone, msg.sender, metadataURI, allBounties.length - 1);
    }

    /// @notice Deploys an open bounty (others can join)
    /// @param metadataURI IPFS hash of bounty details
    /// @return clone Address of the new bounty
    function createOpenBounty(string calldata metadataURI) external payable returns (address clone) {
        clone = Clones.clone(implementation);
        Poidh(clone).initialize{value: msg.value}(msg.sender, treasury, metadataURI, true);

        allBounties.push(clone);
        emit PoidhFactory__OpenBountyCreated(clone, msg.sender, metadataURI, allBounties.length - 1);
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
