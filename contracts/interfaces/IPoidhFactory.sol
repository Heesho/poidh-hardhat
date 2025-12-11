// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

interface IPoidhFactory {
    function implementation() external view returns (address);
    function treasury() external view returns (address);

    function allBounties(uint256 index) external view returns (address);
    function getBountiesCount() external view returns (uint256);
    function getBounties(uint256 limit, uint256 offset) external view returns (address[] memory);

    function createSoloBounty(string calldata metadataURI) external payable returns (address clone);
    function createOpenBounty(string calldata metadataURI) external payable returns (address clone);
}
