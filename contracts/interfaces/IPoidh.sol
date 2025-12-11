// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

interface IPoidh {
    enum State { OPEN, VOTING, CLOSED, CANCELLED }

    function TREASURY_FEE() external view returns (uint256);
    function VOTING_PERIOD() external view returns (uint256);

    function issuer() external view returns (address);
    function treasury() external view returns (address);
    function metadataURI() external view returns (string memory);
    function state() external view returns (State);

    function account_Stake(address account) external view returns (uint256);
    function totalStaked() external view returns (uint256);

    function claims(uint256 index) external view returns (address claimant, string memory name, string memory proofURI);
    function getClaimsCount() external view returns (uint256);
    function getClaim(uint256 claimId) external view returns (address claimant, string memory name, string memory proofURI);

    function account_Round_HasVoted(address account, uint256 round) external view returns (bool);
    function joinable() external view returns (bool);

    function initialize(address issuer, address treasury, string calldata metadataURI, bool joinable) external payable;
    function join() external payable;
    function withdraw(address account) external;
    function cancel() external;
    function submitClaim(string calldata name, string calldata proofURI) external;
    function startVote(uint256 claimId) external;
    function vote(bool support) external;
    function resolveVote() external;
}
