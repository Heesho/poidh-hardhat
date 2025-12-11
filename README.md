# Poidh (Pics Or It Didn't Happen)

A decentralized bounty protocol on Base using the Factory-Clone pattern (EIP-1167).

## Overview

Poidh allows users to create bounties for tasks or requests. Workers submit claims with proof of completion, and the bounty issuer selects a winner. For open bounties with multiple funders, contributors vote to ratify the selection.

## Architecture

### Contracts

| Contract | Description |
|----------|-------------|
| `PoidhFactory` | Deploys bounty clones and maintains registry |
| `Poidh` | Bounty logic contract (clone template) |

### Design Decisions

- **EIP-1167 Clones**: Each bounty is a minimal proxy pointing to a single implementation contract. This reduces deployment cost to ~$0.01 per bounty on Base.
- **IPFS Metadata**: Heavy data (titles, descriptions, requirements, proof images) stored off-chain. Only IPFS hashes stored on-chain.
- **Pull Pattern for Refunds**: When cancelled, users claim their own refunds rather than auto-distribution. This avoids gas limit issues and failed transfer blocking.

## State Machine

```
                    ┌───────────────────────────┐
                    │ vote fails                │
                    │                           │
                    ▼         startVote         │
                ┌──────┐ ─────────────────► ┌─────────┐
                │ OPEN │                    │ VOTING  │
                └──────┘                    └─────────┘
                    │                           │
                    │ cancel                    │ vote passes
                    ▼                           ▼
              ┌───────────┐               ┌─────────┐
              │ CANCELLED │               │ CLOSED  │
              └───────────┘               └─────────┘
```

| State | Description |
|-------|-------------|
| `OPEN` | Bounty accepting funds (if joinable) and claims. Withdrawals allowed. |
| `VOTING` | Funds locked. Contributors voting on selected claim. |
| `CLOSED` | Vote passed. Funds paid out. Bounty complete. |
| `CANCELLED` | Issuer cancelled. Contributors can claim refunds. |

## Bounty Types

### Solo Bounty

Created with `createBounty(metadataURI, false)`. Only the issuer funds the bounty.

- `joinable = false` - others cannot add funds
- Issuer has full control over claim acceptance
- Fast path: issuer votes yes → instant resolution (no 2-day wait)

### Open Bounty

Created with `createBounty(metadataURI, true)`. Multiple users can contribute funds.

- `joinable = true` - anyone can call `join()` to add funds
- Contributors vote on claim acceptance (weighted by stake)
- 2-day voting period (or instant if all votes cast)

## Core Workflows

### 1. Creating a Bounty

**Solo Bounty:**
```solidity
factory.createBounty{value: 1 ether}("ipfs://QmMetadata...", false);
```

**Open Bounty:**
```solidity
factory.createBounty{value: 1 ether}("ipfs://QmMetadata...", true);
```

The `msg.value` becomes the issuer's initial stake.

### 2. Joining an Open Bounty

Contributors add funds to increase the bounty pool:

```solidity
bounty.join{value: 0.5 ether}();
```

- Only works for open bounties (`joinable = true`)
- Only while state is `OPEN`
- Contributor's stake tracked in `account_Stake[address]`

### 3. Submitting a Claim

Workers submit proof of completed work:

```solidity
bounty.submitClaim("PR #405 - Fix Header", "ipfs://QmProof...");
```

- Anyone can submit claims
- **Claims can only be submitted while bounty is in OPEN state**
- Claims stored on-chain with claimant address, name, and proof URI
- Multiple claims allowed per bounty

### 4. Starting a Vote

Issuer selects a claim to put to vote:

```solidity
bounty.startVote(claimId);
```

- Only issuer can call
- Only while state is `OPEN`
- Sets state to `VOTING`
- Starts 2-day voting period

### 5. Voting

Contributors vote on the selected claim:

```solidity
bounty.vote(true);  // yes
bounty.vote(false); // no
```

- **Issuer cannot vote** - the bounty issuer is excluded from voting to prevent conflict of interest
- Vote weight = contributor's stake (1 wei = 1 vote)
- Each address can only vote once per voting round
- Voting tracked per round (allows re-voting if vote fails and resets)

### 6. Resolving a Vote

Anyone can trigger resolution after deadline or when all votes are cast:

```solidity
bounty.resolveVote();
```

**Resolution conditions:**
- All votes cast (`yes + no == totalStaked`), OR
- Deadline reached (2 days after `startVote`)

**Outcomes:**
- `yes >= no` → Claim accepted, funds paid out, state → `CLOSED`
- `yes < no` → Vote failed, state → `OPEN`, voting round increments

### 7. Withdrawing

The `withdraw(address _account)` function has two modes depending on state:

**While OPEN:**
```solidity
bounty.withdraw(msg.sender);  // _account param ignored, uses msg.sender
```

- Only non-issuers can withdraw their own stake
- Issuer cannot withdraw (must cancel instead)
- Returns full stake to the caller

**While CANCELLED:**
```solidity
bounty.withdraw(anyAddress);  // Anyone can trigger withdrawal for any funder
```

- Anyone can call to refund any funder (enables automated batch refunds)
- Funds are sent to the specified `_account`, not the caller
- Useful for automating refund distribution after cancellation

### 8. Cancelling a Bounty

Issuer can cancel and allow refunds:

```solidity
bounty.cancel();
```

- Only issuer can call
- Only while state is `OPEN`
- Sets state to `CANCELLED`
- After cancellation, anyone can call `withdraw(address)` to refund any funder

## Voting Logic

### Vote Weight

Voting power is proportional to ETH contributed:
- 1 wei staked = 1 vote
- Larger contributors have more influence

### Voting Rounds

If a vote fails, the bounty returns to `OPEN` state and the voting round increments. This allows:
- Issuer to select a different claim
- Contributors to vote again in the new round
- Previous votes don't carry over

### Pass/Fail Threshold

- `yes >= no` → **PASS** (tie goes to claimant)
- `yes < no` → **FAIL**

### Early Resolution

No need to wait 2 days if all eligible voters have voted. Note that since the issuer cannot vote, early resolution requires all non-issuer contributors to vote.

**Note:** For solo bounties (no other contributors), the vote will pass after the 2-day deadline since 0 >= 0 is true.

## Fees

| Fee | Amount | Recipient |
|-----|--------|-----------|
| Treasury Fee | 2.5% | Protocol treasury |
| Winner Reward | 97.5% | Claim winner |

Fees deducted from total pool at payout. If treasury address is set to zero, the full amount goes to the winner (no fee collected).

## Factory Administration

The `PoidhFactory` contract is `Ownable`, allowing the owner to:

### Set Implementation
```solidity
factory.setImplementation(newImplementationAddress);
```
- Updates the implementation contract used for new bounties
- Existing bounties are unaffected (they keep their original implementation)
- Cannot be set to zero address

### Set Treasury
```solidity
factory.setTreasury(newTreasuryAddress);
```
- Updates the treasury address for new bounties
- Existing bounties are unaffected (they keep their original treasury)
- Can be set to zero address to disable fees for new bounties

### Ownership Transfer
```solidity
factory.transferOwnership(newOwner);
factory.renounceOwnership(); // Permanently removes owner
```

## Data Schemas (IPFS)

### Bounty Metadata (`metadataURI`)

```json
{
  "title": "Fix the landing page CSS",
  "description": "The header is broken on mobile. Needs to be fixed...",
  "requirements": [
    "Must pass CI/CD",
    "Must look good on iPhone 14"
  ],
  "tags": ["frontend", "css", "bug"],
  "contacts": "@issuer_handle"
}
```

### Claim Proof (`proofURI`)

```json
{
  "title": "PR #405 - Fix Header",
  "description": "I adjusted the flexbox settings in the header component.",
  "deliverables": [
    "https://github.com/project/repo/pull/405",
    "https://imgur.com/screenshot.png"
  ],
  "author": "@worker_handle"
}
```

## Contract Reference

### PoidhFactory

#### State Variables

| Variable | Type | Description |
|----------|------|-------------|
| `implementation` | `address` | Master Poidh logic contract |
| `treasury` | `address` | Protocol fee recipient |
| `owner` | `address` | Factory owner (can update implementation/treasury) |
| `allBounties` | `address[]` | Registry of all bounties |

#### Functions

| Function | Description |
|----------|-------------|
| `createBounty(metadataURI, joinable)` | Deploy bounty (joinable=false for solo, true for open) |
| `getBountiesCount()` | Total bounties created |
| `getBounties(limit, offset)` | Paginated bounty list |
| `setImplementation(address)` | Update implementation (owner only) |
| `setTreasury(address)` | Update treasury (owner only) |
| `transferOwnership(address)` | Transfer ownership (owner only) |
| `renounceOwnership()` | Renounce ownership permanently (owner only) |

#### Events

| Event | Description |
|-------|-------------|
| `PoidhFactory__BountyCreated` | New bounty deployed |
| `PoidhFactory__ImplementationUpdated` | Implementation changed |
| `PoidhFactory__TreasuryUpdated` | Treasury changed |

#### Errors

| Error | Cause |
|-------|-------|
| `PoidhFactory__ZeroAddress` | Setting implementation to zero address |

### Poidh

#### State Variables

| Variable | Type | Description |
|----------|------|-------------|
| `issuer` | `address` | Bounty creator |
| `treasury` | `address` | Fee recipient |
| `metadataURI` | `string` | IPFS hash of bounty details |
| `state` | `State` | Current bounty state |
| `joinable` | `bool` | Whether others can join |
| `totalStaked` | `uint256` | Total ETH in bounty |
| `account_Stake` | `mapping` | ETH stake per address |
| `claims` | `Claim[]` | Submitted claims |
| `currentVote` | `VoteConfig` | Active vote configuration |
| `account_Round_HasVoted` | `mapping` | Vote tracking per round |

#### Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `TREASURY_FEE` | 25 | 2.5% (25/1000) |
| `VOTING_PERIOD` | 2 days | Vote duration |

#### Functions

| Function | Description |
|----------|-------------|
| `initialize(...)` | Initialize clone (called by factory) |
| `join()` | Add ETH to bounty (open bounties only) |
| `withdraw(account)` | Withdraw stake (OPEN: self only, CANCELLED: anyone for anyone) |
| `cancel()` | Cancel bounty (issuer only, while OPEN) |
| `submitClaim(name, proofURI)` | Submit work proof (OPEN state only) |
| `startVote(claimId)` | Start vote on claim (issuer only) |
| `vote(support)` | Cast vote (true=yes, false=no, issuer excluded) |
| `resolveVote()` | Resolve vote after deadline/all votes |
| `getClaimsCount()` | Number of claims |
| `getClaim(claimId)` | Get claim details |

#### Events

| Event | Description |
|-------|-------------|
| `Poidh__Joined` | User added funds |
| `Poidh__Withdrawn` | User withdrew funds (or was refunded) |
| `Poidh__ClaimSubmitted` | New claim submitted |
| `Poidh__VoteStarted` | Voting began |
| `Poidh__VoteCast` | Vote recorded |
| `Poidh__BountyPaid` | Bounty paid out |
| `Poidh__VoteFailed` | Vote did not pass |
| `Poidh__Cancelled` | Bounty cancelled |

#### Errors

| Error | Cause |
|-------|-------|
| `Poidh__BountyNotOpen` | Action requires OPEN state |
| `Poidh__BountyNotJoinable` | Joining solo bounty |
| `Poidh__NoEthSent` | Zero value transaction |
| `Poidh__CannotWithdraw` | Withdraw blocked (issuer in OPEN, or wrong state) |
| `Poidh__NoFundsToWithdraw` | No stake to withdraw |
| `Poidh__TransferFailed` | ETH transfer failed |
| `Poidh__OnlyIssuer` | Non-issuer calling issuer function |
| `Poidh__InvalidClaimId` | Claim does not exist |
| `Poidh__VotingNotActive` | Action requires VOTING state |
| `Poidh__VotingEnded` | Voting past deadline |
| `Poidh__VotingNotEnded` | Resolving before deadline/all votes |
| `Poidh__AlreadyVotedThisRound` | Double voting attempt |
| `Poidh__NoStakeInBounty` | Voting without stake |
| `Poidh__IssuerCannotVote` | Issuer attempting to vote |

## Development

### Install

```bash
yarn install
```

### Compile

```bash
yarn hardhat compile
```

### Test

```bash
yarn hardhat test
```

### Coverage

```bash
yarn hardhat coverage
```

## Deployment

1. Set environment variables in `.env`:
   ```
   PRIVATE_KEY=your_private_key
   RPC_URL=https://mainnet.base.org
   SCAN_API_KEY=your_basescan_api_key
   ```

2. Deploy factory with treasury address:
   ```bash
   yarn hardhat run scripts/deploy.js --network mainnet
   ```

## Security Considerations

- **Reentrancy**: All external calls use `nonReentrant` modifier
- **Pull over Push**: Refunds claimed individually, not auto-distributed
- **Checks-Effects-Interactions**: State updated before external calls
- **No Loops on User Data**: Avoids gas limit issues with many participants
- **Issuer Power**: Issuer can cancel at any time (while OPEN) - contributors should be aware

## License

MIT
# poidh-hardhat
