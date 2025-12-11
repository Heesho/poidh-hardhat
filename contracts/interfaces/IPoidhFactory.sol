// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

interface IPoidhFactory {
    // State
    function implementation() external view returns (address);
    function treasury() external view returns (address);
    function owner() external view returns (address);

    // Registry
    function allBounties(uint256 index) external view returns (address);
    function getBountiesCount() external view returns (uint256);
    function getBounties(uint256 limit, uint256 offset) external view returns (address[] memory);

    // Owner functions
    function setImplementation(address _implementation) external;
    function setTreasury(address _treasury) external;
    function transferOwnership(address newOwner) external;
    function renounceOwnership() external;

    // Bounty creation
    function createBounty(string calldata metadataURI, bool joinable) external payable returns (address clone);

    // Events
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
}
