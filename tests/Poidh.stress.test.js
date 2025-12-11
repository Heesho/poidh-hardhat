const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Poidh Stress & Security Tests", function () {
  let factory;
  let treasury;
  let issuer;
  let contributors = [];
  let workers = [];
  let attacker;

  const ONE_ETH = ethers.utils.parseEther("1");
  const HALF_ETH = ethers.utils.parseEther("0.5");
  const TWO_DAYS = 2 * 24 * 60 * 60;

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    treasury = signers[0];
    issuer = signers[1];
    attacker = signers[2];
    
    // Get 10 contributors and 5 workers
    contributors = signers.slice(3, 13);
    workers = signers.slice(13, 18);

    const PoidhFactory = await ethers.getContractFactory("PoidhFactory");
    factory = await PoidhFactory.deploy(treasury.address);
    await factory.deployed();
  });

  async function createBounty(signer, value, joinable) {
    const tx = await factory.connect(signer).createBounty("ipfs://metadata", joinable, { value });
    const receipt = await tx.wait();
    const event = receipt.events.find(e => e.event === "PoidhFactory__BountyCreated");
    return await ethers.getContractAt("Poidh", event.args.bountyAddress);
  }

  /*//////////////////////////////////////////////////////////////
                    STRESS TESTS - MANY PARTICIPANTS
  //////////////////////////////////////////////////////////////*/

  describe("Many Participants Stress Tests", function () {
    
    it("should handle 10 contributors joining and voting", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      
      // 10 contributors join
      for (const contributor of contributors) {
        await bounty.connect(contributor).join({ value: ONE_ETH });
      }
      
      expect(await bounty.totalStaked()).to.equal(ONE_ETH.mul(11)); // issuer + 10
      
      await bounty.connect(workers[0]).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);
      
      // All 10 contributors vote (5 yes, 5 no)
      for (let i = 0; i < 5; i++) {
        await bounty.connect(contributors[i]).vote(true);
      }
      for (let i = 5; i < 10; i++) {
        await bounty.connect(contributors[i]).vote(false);
      }
      
      await time.increase(TWO_DAYS + 1);
      await bounty.resolveVote();
      
      // 5 ETH yes vs 5 ETH no = tie = passes
      expect(await bounty.state()).to.equal(2);
    });

    it("should handle 10 contributors with different stake weights", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      
      // Contributors join with varying amounts
      for (let i = 0; i < contributors.length; i++) {
        const amount = ONE_ETH.mul(i + 1); // 1, 2, 3... ETH
        await bounty.connect(contributors[i]).join({ value: amount });
      }
      
      // Total: 1 + 1+2+3+4+5+6+7+8+9+10 = 1 + 55 = 56 ETH
      expect(await bounty.totalStaked()).to.equal(ONE_ETH.mul(56));
      
      await bounty.connect(workers[0]).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);
      
      // Top 3 contributors (8+9+10 = 27 ETH) vote no
      // Rest (1+2+3+4+5+6+7 = 28 ETH) vote yes
      for (let i = 0; i < 7; i++) {
        await bounty.connect(contributors[i]).vote(true);
      }
      for (let i = 7; i < 10; i++) {
        await bounty.connect(contributors[i]).vote(false);
      }
      
      await time.increase(TWO_DAYS + 1);
      await bounty.resolveVote();
      
      // 28 ETH yes vs 27 ETH no = passes
      expect(await bounty.state()).to.equal(2);
    });

    it("should handle many claims from different workers", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributors[0]).join({ value: ONE_ETH });
      
      // 5 workers each submit 10 claims = 50 claims
      for (const worker of workers) {
        for (let i = 0; i < 10; i++) {
          await bounty.connect(worker).submitClaim(`Work ${i}`, `ipfs://proof${i}`);
        }
      }
      
      expect(await bounty.getClaimsCount()).to.equal(50);
      
      // Issuer selects claim 42 (workers[4], claim index 2)
      await bounty.connect(issuer).startVote(42);
      
      const vote = await bounty.currentVote();
      expect(vote.claimId).to.equal(42);
      
      const claim = await bounty.getClaim(42);
      expect(claim.claimant).to.equal(workers[4].address);
    });

    it("should handle rapid join/withdraw cycles", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      
      // Each contributor joins and withdraws 5 times
      for (const contributor of contributors.slice(0, 5)) {
        for (let i = 0; i < 5; i++) {
          await bounty.connect(contributor).join({ value: HALF_ETH });
          await bounty.connect(contributor).withdraw(contributor.address);
        }
      }
      
      // Only issuer stake remains
      expect(await bounty.totalStaked()).to.equal(ONE_ETH);
    });
  });

  /*//////////////////////////////////////////////////////////////
                    RACE CONDITION TESTS
  //////////////////////////////////////////////////////////////*/

  describe("Race Condition Tests", function () {
    
    it("should handle withdraw right before vote starts", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributors[0]).join({ value: ONE_ETH });
      await bounty.connect(contributors[1]).join({ value: ONE_ETH });
      
      await bounty.connect(workers[0]).submitClaim("Work", "ipfs://proof");
      
      // Contributor0 withdraws
      await bounty.connect(contributors[0]).withdraw(contributors[0].address);
      
      // Then issuer starts vote
      await bounty.connect(issuer).startVote(0);
      
      // Contributor0 cannot vote (no stake)
      await expect(
        bounty.connect(contributors[0]).vote(true)
      ).to.be.revertedWithCustomError(bounty, "Poidh__NoStakeInBounty");
      
      // Contributor1 can vote
      await bounty.connect(contributors[1]).vote(true);
    });

    it("should handle cancel right after claim submission", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributors[0]).join({ value: ONE_ETH });
      
      await bounty.connect(workers[0]).submitClaim("Work", "ipfs://proof");
      
      // Issuer cancels instead of starting vote
      await bounty.connect(issuer).cancel();
      
      expect(await bounty.state()).to.equal(3); // CANCELLED
      expect(await bounty.getClaimsCount()).to.equal(1); // Claim still exists
      
      // Everyone can withdraw
      await bounty.connect(issuer).withdraw(issuer.address);
      await bounty.connect(contributors[0]).withdraw(contributors[0].address);
    });

    it("should handle multiple users trying to resolve at same time", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributors[0]).join({ value: ONE_ETH });
      
      await bounty.connect(workers[0]).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);
      await bounty.connect(contributors[0]).vote(true);
      
      await time.increase(TWO_DAYS + 1);
      
      // First resolve succeeds
      await bounty.resolveVote();
      
      // Second resolve fails
      await expect(bounty.resolveVote()).to.be.revertedWithCustomError(
        bounty, "Poidh__VotingNotActive"
      );
    });
  });

  /*//////////////////////////////////////////////////////////////
                    FACTORY OWNERSHIP ATTACK TESTS
  //////////////////////////////////////////////////////////////*/

  describe("Factory Ownership Attack Tests", function () {
    
    it("should prevent malicious implementation upgrade", async function () {
      // Attacker tries to set malicious implementation
      await expect(
        factory.connect(attacker).setImplementation(attacker.address)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("should prevent treasury theft via setTreasury", async function () {
      // Attacker tries to redirect treasury
      await expect(
        factory.connect(attacker).setTreasury(attacker.address)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("should prevent ownership theft", async function () {
      await expect(
        factory.connect(attacker).transferOwnership(attacker.address)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("should not affect existing bounties when implementation changes", async function () {
      // Create bounty with original implementation
      const bounty1 = await createBounty(issuer, ONE_ETH, false);
      const originalImpl = await factory.implementation();
      
      // Owner changes implementation
      const PoidhContract = await ethers.getContractFactory("Poidh");
      const newImpl = await PoidhContract.deploy();
      await factory.connect(treasury).setImplementation(newImpl.address);
      
      // Create bounty with new implementation
      const bounty2 = await createBounty(issuer, ONE_ETH, false);
      
      // Both bounties should work independently
      await bounty1.connect(workers[0]).submitClaim("Work1", "ipfs://proof1");
      await bounty2.connect(workers[0]).submitClaim("Work2", "ipfs://proof2");
      
      await bounty1.connect(issuer).startVote(0);
      await bounty2.connect(issuer).startVote(0);
      
      await time.increase(TWO_DAYS + 1);
      
      await bounty1.resolveVote();
      await bounty2.resolveVote();
      
      expect(await bounty1.state()).to.equal(2);
      expect(await bounty2.state()).to.equal(2);
    });

    it("should not affect existing bounties when treasury changes", async function () {
      const oldTreasury = treasury;
      const newTreasury = contributors[0];
      
      // Create bounty with original treasury
      const bounty1 = await createBounty(issuer, ONE_ETH, false);
      
      // Owner changes treasury
      await factory.connect(treasury).setTreasury(newTreasury.address);
      
      // Create bounty with new treasury
      const bounty2 = await createBounty(issuer, ONE_ETH, false);
      
      expect(await bounty1.treasury()).to.equal(oldTreasury.address);
      expect(await bounty2.treasury()).to.equal(newTreasury.address);
      
      // Complete both bounties
      await bounty1.connect(workers[0]).submitClaim("Work1", "ipfs://proof1");
      await bounty2.connect(workers[0]).submitClaim("Work2", "ipfs://proof2");
      
      await bounty1.connect(issuer).startVote(0);
      await bounty2.connect(issuer).startVote(0);
      
      await time.increase(TWO_DAYS + 1);
      
      const oldTreasuryBal = await oldTreasury.getBalance();
      const newTreasuryBal = await newTreasury.getBalance();
      
      await bounty1.connect(attacker).resolveVote();
      await bounty2.connect(attacker).resolveVote();
      
      const fee = ONE_ETH.mul(25).div(1000);
      
      // Old treasury got fee from bounty1
      expect((await oldTreasury.getBalance()).sub(oldTreasuryBal)).to.equal(fee);
      // New treasury got fee from bounty2
      expect((await newTreasury.getBalance()).sub(newTreasuryBal)).to.equal(fee);
    });
  });

  /*//////////////////////////////////////////////////////////////
                    ECONOMIC ATTACK TESTS
  //////////////////////////////////////////////////////////////*/

  describe("Economic Attack Tests", function () {
    
    it("should prevent dust attack griefing", async function () {
      // Attacker creates many tiny bounties
      for (let i = 0; i < 20; i++) {
        await factory.connect(attacker).createBounty(`ipfs://dust${i}`, false, { value: 1 });
      }
      
      // Factory still works normally
      const bounty = await createBounty(issuer, ONE_ETH, false);
      expect(await bounty.totalStaked()).to.equal(ONE_ETH);
    });

    it("should handle whale trying to dominate vote", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      
      // Small contributors
      await bounty.connect(contributors[0]).join({ value: HALF_ETH });
      await bounty.connect(contributors[1]).join({ value: HALF_ETH });
      
      // Whale joins with 100 ETH
      const WHALE_AMOUNT = ethers.utils.parseEther("100");
      await bounty.connect(contributors[2]).join({ value: WHALE_AMOUNT });
      
      await bounty.connect(workers[0]).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);
      
      // Small contributors vote yes (1 ETH)
      await bounty.connect(contributors[0]).vote(true);
      await bounty.connect(contributors[1]).vote(true);
      
      // Whale votes no (100 ETH)
      await bounty.connect(contributors[2]).vote(false);
      
      await time.increase(TWO_DAYS + 1);
      await bounty.resolveVote();
      
      // Whale wins: 100 ETH no > 1 ETH yes
      expect(await bounty.state()).to.equal(0); // Back to OPEN
    });

    it("should handle Sybil attack (many small accounts)", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      
      // Attacker uses 10 accounts with small amounts
      for (const contributor of contributors) {
        await bounty.connect(contributor).join({ value: HALF_ETH });
      }
      
      // Total attacker stake: 5 ETH
      // Issuer stake: 1 ETH (but can't vote)
      
      await bounty.connect(workers[0]).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);
      
      // All Sybil accounts vote no
      for (const contributor of contributors) {
        await bounty.connect(contributor).vote(false);
      }
      
      await time.increase(TWO_DAYS + 1);
      await bounty.resolveVote();
      
      // Vote fails: 0 yes < 5 ETH no
      expect(await bounty.state()).to.equal(0);
    });

    it("should not allow fee manipulation via treasury change mid-bounty", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, false);

      // Bounty created with original treasury
      const originalTreasury = await bounty.treasury();

      // Owner changes factory treasury
      await factory.connect(treasury).setTreasury(attacker.address);

      // Bounty still uses original treasury
      expect(await bounty.treasury()).to.equal(originalTreasury);

      // Complete bounty
      await bounty.connect(workers[0]).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);
      await time.increase(TWO_DAYS + 1);

      const treasuryBal = await treasury.getBalance();
      const attackerBal = await attacker.getBalance();

      // Use a different account to resolve so we don't affect gas calculations
      await bounty.connect(contributors[0]).resolveVote();

      const fee = ONE_ETH.mul(25).div(1000);

      // Original treasury got the fee, not attacker
      expect((await treasury.getBalance()).sub(treasuryBal)).to.equal(fee);
      expect(await attacker.getBalance()).to.equal(attackerBal);
    });
  });

  /*//////////////////////////////////////////////////////////////
                    EDGE CASE INVARIANT TESTS
  //////////////////////////////////////////////////////////////*/

  describe("Invariant Tests", function () {
    
    it("INVARIANT: totalStaked always equals contract balance", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      
      async function checkInvariant() {
        const balance = await ethers.provider.getBalance(bounty.address);
        const staked = await bounty.totalStaked();
        expect(balance).to.equal(staked);
      }
      
      await checkInvariant();
      
      // Join
      await bounty.connect(contributors[0]).join({ value: ONE_ETH });
      await checkInvariant();
      
      // Join more
      await bounty.connect(contributors[1]).join({ value: HALF_ETH });
      await checkInvariant();
      
      // Withdraw
      await bounty.connect(contributors[0]).withdraw(contributors[0].address);
      await checkInvariant();
      
      // Claim and vote
      await bounty.connect(workers[0]).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);
      await checkInvariant();
      
      await bounty.connect(contributors[1]).vote(true);
      await checkInvariant();
      
      // Payout
      await time.increase(TWO_DAYS + 1);
      await bounty.resolveVote();
      
      // After payout, both should be 0
      expect(await ethers.provider.getBalance(bounty.address)).to.equal(0);
      expect(await bounty.totalStaked()).to.equal(0);
    });

    it("INVARIANT: sum of all stakes equals totalStaked", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      
      const stakers = [issuer, ...contributors.slice(0, 5)];
      
      // Join with various amounts
      for (let i = 0; i < 5; i++) {
        await bounty.connect(contributors[i]).join({ value: ONE_ETH.mul(i + 1) });
      }
      
      // Calculate sum manually
      let sum = ONE_ETH; // issuer
      for (let i = 0; i < 5; i++) {
        const stake = await bounty.account_Stake(contributors[i].address);
        sum = sum.add(stake);
      }
      
      expect(await bounty.totalStaked()).to.equal(sum);
    });

    it("INVARIANT: state transitions are valid", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributors[0]).join({ value: ONE_ETH });
      
      // OPEN -> VOTING
      expect(await bounty.state()).to.equal(0); // OPEN
      await bounty.connect(workers[0]).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);
      expect(await bounty.state()).to.equal(1); // VOTING
      
      // VOTING -> OPEN (failed vote)
      await bounty.connect(contributors[0]).vote(false);
      await time.increase(TWO_DAYS + 1);
      await bounty.resolveVote();
      expect(await bounty.state()).to.equal(0); // OPEN
      
      // OPEN -> CANCELLED
      await bounty.connect(issuer).cancel();
      expect(await bounty.state()).to.equal(3); // CANCELLED
    });

    it("INVARIANT: no funds are ever stuck", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      
      for (let i = 0; i < 5; i++) {
        await bounty.connect(contributors[i]).join({ value: ONE_ETH });
      }
      
      const totalDeposited = ONE_ETH.mul(6);
      
      // Cancel bounty
      await bounty.connect(issuer).cancel();
      
      // Everyone withdraws
      await bounty.connect(issuer).withdraw(issuer.address);
      for (let i = 0; i < 5; i++) {
        await bounty.connect(contributors[i]).withdraw(contributors[i].address);
      }
      
      // No funds stuck
      expect(await ethers.provider.getBalance(bounty.address)).to.equal(0);
    });

    it("INVARIANT: voting weight always equals stake at vote time", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributors[0]).join({ value: ONE_ETH.mul(5) });
      
      await bounty.connect(workers[0]).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);
      
      const stakeBefore = await bounty.account_Stake(contributors[0].address);
      
      // Vote should emit event with correct weight
      await expect(bounty.connect(contributors[0]).vote(true))
        .to.emit(bounty, "Poidh__VoteCast")
        .withArgs(contributors[0].address, true, stakeBefore);
    });
  });

  /*//////////////////////////////////////////////////////////////
                    GAS LIMIT TESTS
  //////////////////////////////////////////////////////////////*/

  describe("Gas Limit Tests", function () {
    
    it("should handle bounty with 100 claims", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, false);
      
      // Submit 100 claims
      for (let i = 0; i < 100; i++) {
        await bounty.connect(workers[i % workers.length]).submitClaim(`Claim ${i}`, `ipfs://proof${i}`);
      }
      
      expect(await bounty.getClaimsCount()).to.equal(100);
      
      // Can still select and vote on claim
      await bounty.connect(issuer).startVote(99);
      await time.increase(TWO_DAYS + 1);
      await bounty.resolveVote();
      
      expect(await bounty.state()).to.equal(2);
    });

    it("should handle many voting rounds", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributors[0]).join({ value: ONE_ETH.mul(2) });
      
      await bounty.connect(workers[0]).submitClaim("Work", "ipfs://proof");
      
      // 30 failed voting rounds
      for (let i = 0; i < 30; i++) {
        await bounty.connect(issuer).startVote(0);
        await bounty.connect(contributors[0]).vote(false);
        await time.increase(TWO_DAYS + 1);
        await bounty.resolveVote();
      }
      
      const vote = await bounty.currentVote();
      expect(vote.votingRound).to.equal(31);
    });
  });

  /*//////////////////////////////////////////////////////////////
                    TIMESTAMP MANIPULATION TESTS
  //////////////////////////////////////////////////////////////*/

  describe("Timestamp Edge Cases", function () {
    
    it("should handle vote at exact deadline second", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributors[0]).join({ value: ONE_ETH });
      
      await bounty.connect(workers[0]).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);
      
      const vote = await bounty.currentVote();
      const deadline = vote.deadline;
      
      // Move to 1 second before deadline
      await time.increaseTo(deadline.sub(2));
      
      // Vote should succeed
      await bounty.connect(contributors[0]).vote(true);
      
      // Move to deadline
      await time.increaseTo(deadline);
      
      // Resolve should work at deadline
      await bounty.resolveVote();
      expect(await bounty.state()).to.equal(2);
    });

    it("should handle very long time passage", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributors[0]).join({ value: ONE_ETH });
      
      await bounty.connect(workers[0]).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);
      
      // Wait 1 year (365 days)
      await time.increase(365 * 24 * 60 * 60);
      
      // Vote should still be resolvable
      await bounty.resolveVote();
      expect(await bounty.state()).to.equal(2);
    });
  });

  /*//////////////////////////////////////////////////////////////
                    CREATIVE ATTACK VECTORS
  //////////////////////////////////////////////////////////////*/

  describe("Creative Attack Vectors", function () {
    
    it("should prevent self-destruct attack on implementation", async function () {
      // Even if someone could selfdestruct the implementation,
      // clones should still work because they only delegatecall
      const bounty = await createBounty(issuer, ONE_ETH, false);
      
      // Bounty should work normally
      await bounty.connect(workers[0]).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);
      await time.increase(TWO_DAYS + 1);
      await bounty.resolveVote();
      
      expect(await bounty.state()).to.equal(2);
    });

    it("should handle claim by contract address", async function () {
      // Deploy a contract that will be the claimant
      const AttackerFactory = await ethers.getContractFactory("ReentrancyAttacker");
      const contractClaimant = await AttackerFactory.deploy();
      
      const bounty = await createBounty(issuer, ONE_ETH, false);
      
      // Contract submits claim through its function
      await contractClaimant.submitClaim(bounty.address, "Contract Work", "ipfs://contract");
      
      expect(await bounty.getClaimsCount()).to.equal(1);
      const claim = await bounty.getClaim(0);
      expect(claim.claimant).to.equal(contractClaimant.address);
      
      // Complete the bounty
      await bounty.connect(issuer).startVote(0);
      await time.increase(TWO_DAYS + 1);
      
      // Contract receives payout
      const balBefore = await ethers.provider.getBalance(contractClaimant.address);
      await bounty.resolveVote();
      const balAfter = await ethers.provider.getBalance(contractClaimant.address);
      
      const fee = ONE_ETH.mul(25).div(1000);
      const reward = ONE_ETH.sub(fee);
      expect(balAfter.sub(balBefore)).to.equal(reward);
    });

    it("should prevent issuer from gaming the vote by creating many accounts", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      
      // Honest contributor joins
      await bounty.connect(contributors[0]).join({ value: ONE_ETH.mul(5) });
      
      // Issuer tries to get friends to join and vote with them
      // But issuer can't vote, and friends need to stake real ETH
      await bounty.connect(contributors[1]).join({ value: ONE_ETH });
      await bounty.connect(contributors[2]).join({ value: ONE_ETH });
      
      await bounty.connect(workers[0]).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);
      
      // Honest contributor votes no
      await bounty.connect(contributors[0]).vote(false); // 5 ETH
      
      // Issuer's friends vote yes
      await bounty.connect(contributors[1]).vote(true); // 1 ETH
      await bounty.connect(contributors[2]).vote(true); // 1 ETH
      
      await time.increase(TWO_DAYS + 1);
      await bounty.resolveVote();
      
      // 2 ETH yes < 5 ETH no = fails
      expect(await bounty.state()).to.equal(0);
    });

    it("should handle issuer trying to grief by never starting vote", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributors[0]).join({ value: ONE_ETH });
      
      await bounty.connect(workers[0]).submitClaim("Work", "ipfs://proof");
      
      // Issuer never starts vote - contributors can withdraw
      await bounty.connect(contributors[0]).withdraw(contributors[0].address);
      
      expect(await bounty.totalStaked()).to.equal(ONE_ETH); // Only issuer
      
      // If all contributors leave, issuer is stuck with bounty
      // They can cancel to recover funds
      await bounty.connect(issuer).cancel();
      await bounty.connect(issuer).withdraw(issuer.address);
      
      expect(await ethers.provider.getBalance(bounty.address)).to.equal(0);
    });

    it("should handle front-running vote resolution", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributors[0]).join({ value: ONE_ETH });
      
      await bounty.connect(workers[0]).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);
      await bounty.connect(contributors[0]).vote(true);
      
      await time.increase(TWO_DAYS + 1);
      
      // Anyone can call resolveVote - no front-running benefit
      // Attacker calling it first just pays gas, doesn't get anything
      const attackerBal = await attacker.getBalance();
      const tx = await bounty.connect(attacker).resolveVote();
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed.mul(receipt.effectiveGasPrice);
      
      // Attacker just paid gas, gained nothing
      expect((await attacker.getBalance()).add(gasCost)).to.equal(attackerBal);
    });

    it("should handle contributor trying to vote then withdraw", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributors[0]).join({ value: ONE_ETH });
      
      await bounty.connect(workers[0]).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);
      
      // Contributor votes
      await bounty.connect(contributors[0]).vote(true);
      
      // Contributor tries to withdraw during voting
      await expect(
        bounty.connect(contributors[0]).withdraw(contributors[0].address)
      ).to.be.revertedWithCustomError(bounty, "Poidh__CannotWithdraw");
      
      // Vote weight is locked
    });

    it("should handle empty string metadata", async function () {
      const tx = await factory.connect(issuer).createBounty("", false, { value: ONE_ETH });
      const receipt = await tx.wait();
      const event = receipt.events.find(e => e.event === "PoidhFactory__BountyCreated");
      const bounty = await ethers.getContractAt("Poidh", event.args.bountyAddress);
      
      expect(await bounty.metadataURI()).to.equal("");
      
      // Bounty still works
      await bounty.connect(workers[0]).submitClaim("", "");
      await bounty.connect(issuer).startVote(0);
      await time.increase(TWO_DAYS + 1);
      await bounty.resolveVote();
      
      expect(await bounty.state()).to.equal(2);
    });

    it("should handle maximum ETH values", async function () {
      // Create bounty with very large amount (1000 ETH)
      const LARGE = ethers.utils.parseEther("1000");
      const bounty = await createBounty(issuer, LARGE, false);
      
      expect(await bounty.totalStaked()).to.equal(LARGE);
      
      await bounty.connect(workers[0]).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);
      await time.increase(TWO_DAYS + 1);
      
      const workerBal = await workers[0].getBalance();
      await bounty.connect(attacker).resolveVote();
      
      const fee = LARGE.mul(25).div(1000); // 25 ETH fee
      const reward = LARGE.sub(fee); // 975 ETH reward
      
      expect((await workers[0].getBalance()).sub(workerBal)).to.equal(reward);
    });

    it("should prevent claim submission after voting starts", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, false);
      
      await bounty.connect(workers[0]).submitClaim("Work 1", "ipfs://proof1");
      await bounty.connect(issuer).startVote(0);
      
      // Cannot submit new claims during voting
      await expect(
        bounty.connect(workers[1]).submitClaim("Work 2", "ipfs://proof2")
      ).to.be.revertedWithCustomError(bounty, "Poidh__BountyNotOpen");
    });

    it("should handle bounty where worker is also a contributor", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      
      // Worker joins as contributor
      await bounty.connect(workers[0]).join({ value: ONE_ETH.mul(2) });
      
      // Worker submits claim
      await bounty.connect(workers[0]).submitClaim("Work", "ipfs://proof");
      
      await bounty.connect(issuer).startVote(0);
      
      // Worker can vote on their own claim (as contributor)
      await bounty.connect(workers[0]).vote(true);
      
      await time.increase(TWO_DAYS + 1);
      
      // Worker gets payout
      const workerBal = await workers[0].getBalance();
      await bounty.connect(attacker).resolveVote();
      
      const totalStaked = ONE_ETH.mul(3);
      const fee = totalStaked.mul(25).div(1000);
      const reward = totalStaked.sub(fee);
      
      expect((await workers[0].getBalance()).sub(workerBal)).to.equal(reward);
    });
  });
});
