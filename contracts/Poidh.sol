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

    enum State {
        OPEN,       // accepting funds and claims, withdrawals allowed
        VOTING,     // funds locked, contributors voting on claim
        CLOSED,     // vote passed, funds paid out
        CANCELLED   // issuer cancelled, contributors can claim refunds
    }

    struct Claim {
        address claimant;   // address that submitted the claim
        string name;        // short name/title for UI display
        string proofURI;    // IPFS hash pointing to full work/proof
    }

    struct VoteConfig {
        uint256 claimId;      // index of claim being voted on
        uint256 yes;          // total weight of yes votes
        uint256 no;           // total weight of no votes
        uint256 deadline;     // timestamp when voting ends
        uint256 votingRound;  // increments on failed vote, resets hasVoted
    }

    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    uint256 public constant TREASURY_FEE = 25;       // 2.5% fee (25/1000)
    uint256 public constant VOTING_PERIOD = 2 days;  // duration of voting period

    /*//////////////////////////////////////////////////////////////
                                STATE
    //////////////////////////////////////////////////////////////*/

    address public issuer;      // bounty creator, can start votes and cancel
    address public treasury;    // protocol fee recipient
    string public metadataURI;  // IPFS hash of bounty details (title, description, etc)
    State public state;         // current bounty state
    bool public joinable;       // true = open bounty, false = solo bounty

    mapping(address => uint256) public account_Stake;  // contributor => ETH staked
    uint256 public totalStaked;                        // total ETH in bounty pool

    Claim[] public claims;          // all submitted claims
    VoteConfig public currentVote;  // active voting configuration

    mapping(address => mapping(uint256 => bool)) public account_Round_HasVoted;  // contributor => round => has voted

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error Poidh__BountyNotOpen();
    error Poidh__BountyNotJoinable();
    error Poidh__NoEthSent();
    error Poidh__CannotWithdraw();
    error Poidh__NoFundsToWithdraw();
    error Poidh__TransferFailed();
    error Poidh__OnlyIssuer();
    error Poidh__InvalidClaimId();
    error Poidh__VotingNotActive();
    error Poidh__VotingEnded();
    error Poidh__VotingNotEnded();
    error Poidh__AlreadyVotedThisRound();
    error Poidh__NoStakeInBounty();
    error Poidh__IssuerCannotVote();

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

    /// @notice Withdraw stake from the bounty
    /// @dev OPEN: only non-issuer can withdraw their own stake
    /// @dev CANCELLED: anyone can withdraw for any funder (enables automated refunds)
    /// @param _account Address to withdraw funds for (only used when CANCELLED)
    function withdraw(address _account) external nonReentrant {
        address account;

        if (state == State.CANCELLED) {
            // Anyone can trigger withdrawal for any funder
            account = _account;
        } else if (state == State.OPEN) {
            // Only the funder themselves can withdraw, issuer cannot
            if (msg.sender == issuer) revert Poidh__CannotWithdraw();
            account = msg.sender;
        } else {
            revert Poidh__CannotWithdraw();
        }

        uint256 amount = account_Stake[account];
        if (amount == 0) revert Poidh__NoFundsToWithdraw();

        account_Stake[account] = 0;
        totalStaked -= amount;

        (bool success, ) = payable(account).call{value: amount}("");
        if (!success) revert Poidh__TransferFailed();

        emit Poidh__Withdrawn(account, amount);
    }

    /// @notice Issuer cancels the bounty (only when OPEN)
    function cancel() external {
        if (msg.sender != issuer) revert Poidh__OnlyIssuer();
        if (state != State.OPEN) revert Poidh__BountyNotOpen();

        state = State.CANCELLED;
        emit Poidh__Cancelled();
    }

    /// @notice Submit work/proof for the bounty
    /// @param _name Short title for the claim (e.g., "PR #123")
    /// @param _proofURI IPFS hash containing detailed proof
    function submitClaim(string calldata _name, string calldata _proofURI) external {
        if (state != State.OPEN) revert Poidh__BountyNotOpen();
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
    /// @dev Issuer cannot vote to prevent conflict of interest
    /// @param support true = Yes, false = No
    function vote(bool support) external {
        if (state != State.VOTING) revert Poidh__VotingNotActive();
        if (msg.sender == issuer) revert Poidh__IssuerCannotVote();
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
        uint256 fee;
        uint256 reward;

        if (treasury != address(0)) {
            fee = (amount * TREASURY_FEE) / 1000;
            reward = amount - fee;
        } else {
            fee = 0;
            reward = amount;
        }

        totalStaked = 0;

        if (fee > 0) {
            (bool tSuccess, ) = treasury.call{value: fee}("");
            if (!tSuccess) revert Poidh__TransferFailed();
        }

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
