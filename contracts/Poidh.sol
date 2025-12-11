// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title Poidh (Pics Or It Didn't Happen)
 * @author heesho
 * @notice Bounty logic contract for the Poidh protocol. Handles crowdfunded bounties
 *         with optimistic, community-ratified voting. Contributors vote to ratify
 *         the issuer's selected winning claim. Uses EIP-1167 clone pattern.
 */
contract Poidh is Initializable, ReentrancyGuard {

    /*//////////////////////////////////////////////////////////////
                                TYPES
    //////////////////////////////////////////////////////////////*/

    enum State { OPEN, VOTING, CLOSED, CANCELLED }

    struct Claim {
        address claimant;
        string name;      // short name/title for UI display
        string proofURI;  // IPFS hash pointing to full work/proof
    }

    struct VoteConfig {
        uint256 claimId;
        uint256 yes;
        uint256 no;
        uint256 deadline;
        uint256 votingRound;
    }

    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    uint256 public constant TREASURY_FEE = 25;       // 2.5% (25/1000)
    uint256 public constant VOTING_PERIOD = 2 days;

    /*//////////////////////////////////////////////////////////////
                                STATE
    //////////////////////////////////////////////////////////////*/

    address public issuer;
    address public treasury;
    string public metadataURI;  // IPFS hash containing title, description, requirements
    State public state;
    bool public joinable;  // true = open bounty (others can join), false = solo bounty

    mapping(address => uint256) public account_Stake;  // account => ETH stake
    uint256 public totalStaked;

    Claim[] public claims;
    VoteConfig public currentVote;

    mapping(address => mapping(uint256 => bool)) public account_Round_HasVoted;  // account => round => voted

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error Poidh__BountyNotOpen();
    error Poidh__BountyNotCancelled();
    error Poidh__BountyNotJoinable();
    error Poidh__NoEthSent();
    error Poidh__LockedDuringVoting();
    error Poidh__NoFundsToWithdraw();
    error Poidh__TransferFailed();
    error Poidh__OnlyIssuer();
    error Poidh__IssuerCannotWithdraw();
    error Poidh__InvalidClaimId();
    error Poidh__VotingNotActive();
    error Poidh__VotingEnded();
    error Poidh__VotingNotEnded();
    error Poidh__AlreadyVotedThisRound();
    error Poidh__NoStakeInBounty();
    error Poidh__DeadlineNotReached();

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event Poidh__Joined(address indexed user, uint256 amount);
    event Poidh__Withdrawn(address indexed user, uint256 amount);
    event Poidh__ClaimSubmitted(uint256 indexed claimId, address indexed claimant, string name, string proofURI);
    event Poidh__VoteStarted(uint256 indexed claimId, uint256 deadline, uint256 round);
    event Poidh__VoteCast(address indexed voter, bool support, uint256 weight);
    event Poidh__BountyPaid(address indexed winner, uint256 reward, uint256 fee);
    event Poidh__VoteFailed(uint256 indexed claimId, uint256 round);
    event Poidh__Cancelled();
    event Poidh__RefundClaimed(address indexed user, uint256 amount);

    /*//////////////////////////////////////////////////////////////
                              INITIALIZER
    //////////////////////////////////////////////////////////////*/

    /// @notice Initializes the bounty clone (replaces constructor for proxies)
    /// @param _issuer Address that created the bounty and can start votes
    /// @param _treasury Address receiving protocol fees
    /// @param _metadataURI IPFS hash of bounty details (title, description, requirements)
    /// @param _joinable If true, others can join (open bounty). If false, solo bounty.
    function initialize(
        address _issuer,
        address _treasury,
        string calldata _metadataURI,
        bool _joinable
    ) external payable initializer {
        issuer = _issuer;
        treasury = _treasury;
        metadataURI = _metadataURI;
        state = State.OPEN;
        joinable = _joinable;
        currentVote.votingRound = 1;

        // Fund issuer's stake if ETH sent during initialization
        if (msg.value > 0) {
            account_Stake[_issuer] = msg.value;
            totalStaked = msg.value;
            emit Poidh__Joined(_issuer, msg.value);
        }
    }

    /*//////////////////////////////////////////////////////////////
                          EXTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Add ETH to the bounty pool (only for joinable/open bounties)
    function join() external payable nonReentrant {
        if (state != State.OPEN) revert Poidh__BountyNotOpen();
        if (!joinable) revert Poidh__BountyNotJoinable();
        if (msg.value == 0) revert Poidh__NoEthSent();

        account_Stake[msg.sender] += msg.value;
        totalStaked += msg.value;

        emit Poidh__Joined(msg.sender, msg.value);
    }

    /// @notice Withdraw your stake from the bounty (only when OPEN, issuer cannot withdraw)
    function withdraw() external nonReentrant {
        if (state != State.OPEN) revert Poidh__LockedDuringVoting();
        if (msg.sender == issuer) revert Poidh__IssuerCannotWithdraw();

        uint256 amount = account_Stake[msg.sender];
        if (amount == 0) revert Poidh__NoFundsToWithdraw();

        account_Stake[msg.sender] = 0;
        totalStaked -= amount;

        (bool success, ) = payable(msg.sender).call{value: amount}("");
        if (!success) revert Poidh__TransferFailed();

        emit Poidh__Withdrawn(msg.sender, amount);
    }

    /// @notice Issuer cancels the bounty (only when OPEN)
    function cancel() external {
        if (msg.sender != issuer) revert Poidh__OnlyIssuer();
        if (state != State.OPEN) revert Poidh__BountyNotOpen();

        state = State.CANCELLED;
        emit Poidh__Cancelled();
    }

    /// @notice Claim refund after bounty is cancelled
    function claimRefund() external nonReentrant {
        if (state != State.CANCELLED) revert Poidh__BountyNotCancelled();

        uint256 amount = account_Stake[msg.sender];
        if (amount == 0) revert Poidh__NoFundsToWithdraw();

        account_Stake[msg.sender] = 0;
        totalStaked -= amount;

        (bool success, ) = payable(msg.sender).call{value: amount}("");
        if (!success) revert Poidh__TransferFailed();

        emit Poidh__RefundClaimed(msg.sender, amount);
    }

    /// @notice Submit work/proof for the bounty
    /// @param _name Short title for the claim (e.g., "PR #123")
    /// @param _proofURI IPFS hash containing detailed proof
    function submitClaim(string calldata _name, string calldata _proofURI) external {
        claims.push(Claim({
            claimant: msg.sender,
            name: _name,
            proofURI: _proofURI
        }));
        emit Poidh__ClaimSubmitted(claims.length - 1, msg.sender, _name, _proofURI);
    }

    /// @notice Issuer selects a claim to initiate community vote
    /// @param _claimId Index of the claim to vote on
    function startVote(uint256 _claimId) external {
        if (msg.sender != issuer) revert Poidh__OnlyIssuer();
        if (state != State.OPEN) revert Poidh__BountyNotOpen();
        if (_claimId >= claims.length) revert Poidh__InvalidClaimId();

        state = State.VOTING;

        currentVote.claimId = _claimId;
        currentVote.yes = 0;
        currentVote.no = 0;
        currentVote.deadline = block.timestamp + VOTING_PERIOD;

        emit Poidh__VoteStarted(_claimId, currentVote.deadline, currentVote.votingRound);
    }

    /// @notice Cast vote on the current claim (weight = stake)
    /// @param support true = Yes, false = No
    function vote(bool support) external {
        if (state != State.VOTING) revert Poidh__VotingNotActive();
        if (block.timestamp >= currentVote.deadline) revert Poidh__VotingEnded();

        uint256 round = currentVote.votingRound;
        if (account_Round_HasVoted[msg.sender][round]) revert Poidh__AlreadyVotedThisRound();

        uint256 weight = account_Stake[msg.sender];
        if (weight == 0) revert Poidh__NoStakeInBounty();

        account_Round_HasVoted[msg.sender][round] = true;

        if (support) {
            currentVote.yes += weight;
        } else {
            currentVote.no += weight;
        }

        emit Poidh__VoteCast(msg.sender, support, weight);
    }

    /// @notice Resolve the vote after deadline or when all votes are cast (anyone can call)
    function resolveVote() external nonReentrant {
        if (state != State.VOTING) revert Poidh__VotingNotActive();

        bool allVotesCast = (currentVote.yes + currentVote.no) == totalStaked;
        bool deadlineReached = block.timestamp >= currentVote.deadline;

        if (!allVotesCast && !deadlineReached) revert Poidh__VotingNotEnded();

        if (currentVote.yes >= currentVote.no) {
            _payout();
        } else {
            state = State.OPEN;
            emit Poidh__VoteFailed(currentVote.claimId, currentVote.votingRound);
            currentVote.votingRound++;
            currentVote.yes = 0;
            currentVote.no = 0;
        }
    }

    /*//////////////////////////////////////////////////////////////
                          INTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function _payout() internal {
        state = State.CLOSED;
        Claim memory winningClaim = claims[currentVote.claimId];

        uint256 amount = totalStaked;
        uint256 fee = (amount * TREASURY_FEE) / 1000;
        uint256 reward = amount - fee;

        totalStaked = 0;

        (bool tSuccess, ) = treasury.call{value: fee}("");
        if (!tSuccess) revert Poidh__TransferFailed();

        (bool wSuccess, ) = winningClaim.claimant.call{value: reward}("");
        if (!wSuccess) revert Poidh__TransferFailed();

        emit Poidh__BountyPaid(winningClaim.claimant, reward, fee);
    }

    /*//////////////////////////////////////////////////////////////
                            VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Returns total number of claims
    function getClaimsCount() external view returns (uint256) {
        return claims.length;
    }

    /// @notice Returns claim details by index
    function getClaim(uint256 _claimId) external view returns (address claimant, string memory name, string memory proofURI) {
        Claim memory claim = claims[_claimId];
        return (claim.claimant, claim.name, claim.proofURI);
    }
}
