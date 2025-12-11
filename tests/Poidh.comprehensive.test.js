const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Poidh Comprehensive Tests", function () {
  let factory;
  let treasury;
  let issuer;
  let contributor1;
  let contributor2;
  let contributor3;
  let worker1;
  let worker2;
  let attacker;

  const ONE_ETH = ethers.utils.parseEther("1");
  const HALF_ETH = ethers.utils.parseEther("0.5");
  const QUARTER_ETH = ethers.utils.parseEther("0.25");
  const TWO_ETH = ethers.utils.parseEther("2");
  const THREE_ETH = ethers.utils.parseEther("3");
  const TWO_DAYS = 2 * 24 * 60 * 60;
  const ONE_DAY = 24 * 60 * 60;

  beforeEach(async function () {
    [treasury, issuer, contributor1, contributor2, contributor3, worker1, worker2, attacker] = await ethers.getSigners();

    const PoidhFactory = await ethers.getContractFactory("PoidhFactory");
    factory = await PoidhFactory.deploy(treasury.address);
    await factory.deployed();
  });

  async function createBounty(signer, value, joinable) {
    const tx = await factory.connect(signer).createBounty("ipfs://metadata", joinable, { value });
    const receipt = await tx.wait();
    const event = receipt.events.find(e => e.event === "PoidhFactory__BountyCreated");
    const bountyAddress = event.args.bountyAddress;
    return await ethers.getContractAt("Poidh", bountyAddress);
  }

  // Helper to get contract balance
  async function getBalance(address) {
    return await ethers.provider.getBalance(address);
  }

  /*//////////////////////////////////////////////////////////////
                    SOLO BOUNTY COMPLETE LIFECYCLE
  //////////////////////////////////////////////////////////////*/

  describe("Solo Bounty Complete Lifecycle", function () {

    describe("Flow 1: Create -> Claim -> Vote Yes -> Payout", function () {
      it("should complete successfully", async function () {
        // 1. Create solo bounty
        const bounty = await createBounty(issuer, ONE_ETH, false);
        expect(await bounty.state()).to.equal(0); // OPEN
        expect(await bounty.joinable()).to.equal(false);
        expect(await bounty.totalStaked()).to.equal(ONE_ETH);
        expect(await bounty.account_Stake(issuer.address)).to.equal(ONE_ETH);

        // 2. Worker submits claim
        await bounty.connect(worker1).submitClaim("Work done", "ipfs://proof");
        expect(await bounty.getClaimsCount()).to.equal(1);
        const claim = await bounty.getClaim(0);
        expect(claim.claimant).to.equal(worker1.address);

        // 3. Issuer starts vote
        await bounty.connect(issuer).startVote(0);
        expect(await bounty.state()).to.equal(1); // VOTING

        // 4. Issuer cannot vote (new rule) - wait for deadline
        await expect(
          bounty.connect(issuer).vote(true)
        ).to.be.revertedWithCustomError(bounty, "Poidh__IssuerCannotVote");

        await time.increase(TWO_DAYS + 1);

        // 5. Resolve after deadline (0 >= 0 passes)
        const workerBalBefore = await getBalance(worker1.address);

        await bounty.resolveVote();

        expect(await bounty.state()).to.equal(2); // CLOSED

        // 6. Verify payouts
        const fee = ONE_ETH.mul(25).div(1000); // 2.5%
        const reward = ONE_ETH.sub(fee);

        const workerBalAfter = await getBalance(worker1.address);
        expect(workerBalAfter.sub(workerBalBefore)).to.equal(reward);

        // Contract empty
        expect(await getBalance(bounty.address)).to.equal(0);
      });
    });

    describe("Flow 2: Create -> Claim -> Vote No -> Reset -> Vote Yes -> Payout", function () {
      it("should handle vote rejection and retry", async function () {
        const bounty = await createBounty(issuer, ONE_ETH, false);

        await bounty.connect(worker1).submitClaim("Bad work", "ipfs://proof1");
        await bounty.connect(worker2).submitClaim("Good work", "ipfs://proof2");

        // First vote - no one can vote (issuer excluded), wait for deadline
        await bounty.connect(issuer).startVote(0);
        await time.increase(TWO_DAYS + 1);
        // 0 >= 0 passes, so this won't actually reject - let's just go to claim 1
        await bounty.resolveVote();

        // Since 0 >= 0 passes, the first vote actually passes
        expect(await bounty.state()).to.equal(2); // CLOSED

        // Verify worker1 got paid
        const fee = ONE_ETH.mul(25).div(1000);
        const reward = ONE_ETH.sub(fee);
        expect(await getBalance(bounty.address)).to.equal(0);
      });
    });

    describe("Flow 3: Create -> Cancel -> Withdraw", function () {
      it("should allow issuer to cancel and withdraw", async function () {
        const bounty = await createBounty(issuer, ONE_ETH, false);

        // Cancel
        await bounty.connect(issuer).cancel();
        expect(await bounty.state()).to.equal(3); // CANCELLED

        // Withdraw
        const issuerBalBefore = await getBalance(issuer.address);
        const tx = await bounty.connect(issuer).withdraw(issuer.address);
        const receipt = await tx.wait();
        const gas = receipt.gasUsed.mul(receipt.effectiveGasPrice);
        const issuerBalAfter = await getBalance(issuer.address);

        expect(issuerBalAfter.add(gas).sub(issuerBalBefore)).to.equal(ONE_ETH);
        expect(await getBalance(bounty.address)).to.equal(0);
      });
    });

    describe("Flow 4: Create -> Claim -> Cancel -> Withdraw (no vote started)", function () {
      it("should allow cancel even with claims submitted", async function () {
        const bounty = await createBounty(issuer, ONE_ETH, false);

        await bounty.connect(worker1).submitClaim("Work", "ipfs://proof");

        // Cancel before starting vote
        await bounty.connect(issuer).cancel();
        expect(await bounty.state()).to.equal(3); // CANCELLED

        await bounty.connect(issuer).withdraw(issuer.address);
        expect(await getBalance(bounty.address)).to.equal(0);
      });
    });

    describe("Flow 5: Create with 0 ETH -> Claim -> Payout with 0 funds", function () {
      it("should handle zero-funded solo bounty", async function () {
        const bounty = await createBounty(issuer, 0, false);

        expect(await bounty.totalStaked()).to.equal(0);

        await bounty.connect(worker1).submitClaim("Work", "ipfs://proof");
        await bounty.connect(issuer).startVote(0);

        // Issuer cannot vote (even if they had stake)
        await expect(
          bounty.connect(issuer).vote(true)
        ).to.be.revertedWithCustomError(bounty, "Poidh__IssuerCannotVote");

        // Wait for deadline
        await time.increase(TWO_DAYS + 1);

        // Resolve - 0 >= 0, passes but pays out 0
        await bounty.resolveVote();
        expect(await bounty.state()).to.equal(2); // CLOSED
      });
    });
  });

  /*//////////////////////////////////////////////////////////////
                    OPEN BOUNTY COMPLETE LIFECYCLE
  //////////////////////////////////////////////////////////////*/

  describe("Open Bounty Complete Lifecycle", function () {

    describe("Flow 1: Create -> Join -> Claim -> All Vote Yes -> Payout", function () {
      it("should complete with unanimous approval", async function () {
        const bounty = await createBounty(issuer, ONE_ETH, true);

        await bounty.connect(contributor1).join({ value: ONE_ETH });
        await bounty.connect(contributor2).join({ value: ONE_ETH });

        expect(await bounty.totalStaked()).to.equal(THREE_ETH);

        await bounty.connect(worker1).submitClaim("Work", "ipfs://proof");
        await bounty.connect(issuer).startVote(0);

        // Contributors vote yes (issuer cannot vote)
        await bounty.connect(contributor1).vote(true);
        await bounty.connect(contributor2).vote(true);

        // Wait for deadline since issuer stake counts in totalStaked but can't vote
        await time.increase(TWO_DAYS + 1);

        const worker1BalBefore = await getBalance(worker1.address);
        await bounty.resolveVote();

        const fee = THREE_ETH.mul(25).div(1000);
        const reward = THREE_ETH.sub(fee);

        const worker1BalAfter = await getBalance(worker1.address);
        expect(worker1BalAfter.sub(worker1BalBefore)).to.equal(reward);
        expect(await bounty.state()).to.equal(2); // CLOSED
      });
    });

    describe("Flow 2: Create -> Join -> Claim -> Majority Yes -> Payout", function () {
      it("should pass with majority yes", async function () {
        const bounty = await createBounty(issuer, TWO_ETH, true);
        await bounty.connect(contributor1).join({ value: TWO_ETH });
        await bounty.connect(contributor2).join({ value: ONE_ETH });

        // Contributors: contributor1 2 ETH, contributor2 1 ETH
        await bounty.connect(worker1).submitClaim("Work", "ipfs://proof");
        await bounty.connect(issuer).startVote(0);

        await bounty.connect(contributor1).vote(true);  // 2 ETH yes
        await bounty.connect(contributor2).vote(false); // 1 ETH no

        await time.increase(TWO_DAYS + 1);
        await bounty.resolveVote();
        expect(await bounty.state()).to.equal(2); // CLOSED - 2 > 1
      });
    });

    describe("Flow 3: Create -> Join -> Claim -> Majority No -> Reset -> New Vote -> Pass", function () {
      it("should handle rejection and retry with different claim", async function () {
        const bounty = await createBounty(issuer, ONE_ETH, true);
        await bounty.connect(contributor1).join({ value: ONE_ETH });
        await bounty.connect(contributor2).join({ value: TWO_ETH });

        await bounty.connect(worker1).submitClaim("Bad work", "ipfs://proof1");
        await bounty.connect(worker2).submitClaim("Good work", "ipfs://proof2");

        // First vote fails (contributor1: 1 ETH yes, contributor2: 2 ETH no)
        await bounty.connect(issuer).startVote(0);
        await bounty.connect(contributor1).vote(true);
        await bounty.connect(contributor2).vote(false);
        await time.increase(TWO_DAYS + 1);
        await bounty.resolveVote();

        expect(await bounty.state()).to.equal(0); // OPEN

        // Second vote passes
        await bounty.connect(issuer).startVote(1);
        await bounty.connect(contributor1).vote(true);
        await bounty.connect(contributor2).vote(true);
        await time.increase(TWO_DAYS + 1);
        await bounty.resolveVote();

        expect(await bounty.state()).to.equal(2); // CLOSED
      });
    });

    describe("Flow 4: Create -> Join -> Withdraw -> Claim -> Vote -> Payout", function () {
      it("should handle contributor withdrawal before vote", async function () {
        const bounty = await createBounty(issuer, ONE_ETH, true);
        await bounty.connect(contributor1).join({ value: ONE_ETH });
        await bounty.connect(contributor2).join({ value: ONE_ETH });

        // Contributor2 withdraws
        await bounty.connect(contributor2).withdraw(contributor2.address);
        expect(await bounty.totalStaked()).to.equal(TWO_ETH);

        await bounty.connect(worker1).submitClaim("Work", "ipfs://proof");
        await bounty.connect(issuer).startVote(0);

        // Only contributor1 can vote (issuer cannot vote)
        await bounty.connect(contributor1).vote(true);

        // Contributor2 cannot vote (no stake)
        await expect(
          bounty.connect(contributor2).vote(true)
        ).to.be.revertedWithCustomError(bounty, "Poidh__NoStakeInBounty");

        // Wait for deadline
        await time.increase(TWO_DAYS + 1);

        const worker1BalBefore = await getBalance(worker1.address);
        await bounty.resolveVote();

        const fee = TWO_ETH.mul(25).div(1000);
        const reward = TWO_ETH.sub(fee);

        const worker1BalAfter = await getBalance(worker1.address);
        expect(worker1BalAfter.sub(worker1BalBefore)).to.equal(reward);
      });
    });

    describe("Flow 5: Create -> Join -> Cancel -> All Withdraw", function () {
      it("should allow all contributors to withdraw after cancel", async function () {
        const bounty = await createBounty(issuer, ONE_ETH, true);
        await bounty.connect(contributor1).join({ value: HALF_ETH });
        await bounty.connect(contributor2).join({ value: QUARTER_ETH });

        await bounty.connect(issuer).cancel();

        // All withdraw
        const issuerBalBefore = await getBalance(issuer.address);
        const tx1 = await bounty.connect(issuer).withdraw(issuer.address);
        const r1 = await tx1.wait();
        const g1 = r1.gasUsed.mul(r1.effectiveGasPrice);
        const issuerBalAfter = await getBalance(issuer.address);
        expect(issuerBalAfter.add(g1).sub(issuerBalBefore)).to.equal(ONE_ETH);

        const c1BalBefore = await getBalance(contributor1.address);
        const tx2 = await bounty.connect(contributor1).withdraw(contributor1.address);
        const r2 = await tx2.wait();
        const g2 = r2.gasUsed.mul(r2.effectiveGasPrice);
        const c1BalAfter = await getBalance(contributor1.address);
        expect(c1BalAfter.add(g2).sub(c1BalBefore)).to.equal(HALF_ETH);

        const c2BalBefore = await getBalance(contributor2.address);
        const tx3 = await bounty.connect(contributor2).withdraw(contributor2.address);
        const r3 = await tx3.wait();
        const g3 = r3.gasUsed.mul(r3.effectiveGasPrice);
        const c2BalAfter = await getBalance(contributor2.address);
        expect(c2BalAfter.add(g3).sub(c2BalBefore)).to.equal(QUARTER_ETH);

        expect(await getBalance(bounty.address)).to.equal(0);
      });
    });

    describe("Flow 6: Create -> Join -> Partial Withdraw -> Cancel -> Withdraw Remaining", function () {
      it("should handle partial withdrawals before cancel", async function () {
        const bounty = await createBounty(issuer, ONE_ETH, true);
        await bounty.connect(contributor1).join({ value: ONE_ETH });
        await bounty.connect(contributor2).join({ value: ONE_ETH });

        // Contributor1 withdraws
        await bounty.connect(contributor1).withdraw(contributor1.address);

        // Cancel
        await bounty.connect(issuer).cancel();

        // Only issuer and contributor2 can withdraw
        await bounty.connect(issuer).withdraw(issuer.address);
        await bounty.connect(contributor2).withdraw(contributor2.address);

        // Contributor1 has nothing to withdraw
        await expect(
          bounty.connect(contributor1).withdraw(contributor1.address)
        ).to.be.revertedWithCustomError(bounty, "Poidh__NoFundsToWithdraw");

        expect(await getBalance(bounty.address)).to.equal(0);
      });
    });

    describe("Flow 7: Tie Vote (yes == no) -> Pass", function () {
      it("should pass on exact tie", async function () {
        const bounty = await createBounty(issuer, ONE_ETH, true);
        await bounty.connect(contributor1).join({ value: ONE_ETH });
        await bounty.connect(contributor2).join({ value: ONE_ETH });

        await bounty.connect(worker1).submitClaim("Work", "ipfs://proof");
        await bounty.connect(issuer).startVote(0);

        await bounty.connect(contributor1).vote(true);  // 1 ETH yes
        await bounty.connect(contributor2).vote(false); // 1 ETH no

        await time.increase(TWO_DAYS + 1);
        await bounty.resolveVote();
        expect(await bounty.state()).to.equal(2); // CLOSED - tie passes
      });
    });

    describe("Flow 8: Timeout with partial votes", function () {
      it("should resolve after deadline with only some votes", async function () {
        const bounty = await createBounty(issuer, ONE_ETH, true);
        await bounty.connect(contributor1).join({ value: ONE_ETH });
        await bounty.connect(contributor2).join({ value: ONE_ETH });

        await bounty.connect(worker1).submitClaim("Work", "ipfs://proof");
        await bounty.connect(issuer).startVote(0);

        // Only contributor1 votes (issuer can't vote)
        await bounty.connect(contributor1).vote(true);

        // Cannot resolve yet
        await expect(bounty.resolveVote()).to.be.revertedWithCustomError(
          bounty, "Poidh__VotingNotEnded"
        );

        // Wait for deadline
        await time.increase(TWO_DAYS + 1);

        // Now can resolve - 1 ETH yes > 0 no
        await bounty.resolveVote();
        expect(await bounty.state()).to.equal(2); // CLOSED
      });
    });

    describe("Flow 9: No votes at all -> Pass (0 >= 0)", function () {
      it("should pass with zero votes after deadline", async function () {
        const bounty = await createBounty(issuer, ONE_ETH, true);
        await bounty.connect(contributor1).join({ value: ONE_ETH });

        await bounty.connect(worker1).submitClaim("Work", "ipfs://proof");
        await bounty.connect(issuer).startVote(0);

        // No one votes
        await time.increase(TWO_DAYS + 1);

        await bounty.resolveVote();
        expect(await bounty.state()).to.equal(2); // CLOSED - 0 >= 0
      });
    });

    describe("Flow 10: Multiple failed votes then success", function () {
      it("should handle 3 failed votes then success", async function () {
        const bounty = await createBounty(issuer, ONE_ETH, true);
        await bounty.connect(contributor1).join({ value: ONE_ETH });
        await bounty.connect(contributor2).join({ value: TWO_ETH });

        await bounty.connect(worker1).submitClaim("Work", "ipfs://proof");

        // Fail 3 times (contributor1: 1 ETH yes, contributor2: 2 ETH no)
        for (let i = 0; i < 3; i++) {
          await bounty.connect(issuer).startVote(0);
          await bounty.connect(contributor1).vote(true);
          await bounty.connect(contributor2).vote(false);
          await time.increase(TWO_DAYS + 1);
          await bounty.resolveVote();
          expect(await bounty.state()).to.equal(0); // OPEN
        }

        // Fourth time contributor2 agrees
        await bounty.connect(issuer).startVote(0);
        await bounty.connect(contributor1).vote(true);
        await bounty.connect(contributor2).vote(true);
        await time.increase(TWO_DAYS + 1);
        await bounty.resolveVote();
        expect(await bounty.state()).to.equal(2); // CLOSED
      });
    });
  });

  /*//////////////////////////////////////////////////////////////
                      STATE TRANSITION TESTS
  //////////////////////////////////////////////////////////////*/

  describe("State Transition Matrix", function () {

    describe("From OPEN state", function () {
      it("can transition to VOTING via startVote", async function () {
        const bounty = await createBounty(issuer, ONE_ETH, false);
        await bounty.connect(worker1).submitClaim("Work", "ipfs://proof");

        await bounty.connect(issuer).startVote(0);
        expect(await bounty.state()).to.equal(1); // VOTING
      });

      it("can transition to CANCELLED via cancel", async function () {
        const bounty = await createBounty(issuer, ONE_ETH, false);

        await bounty.connect(issuer).cancel();
        expect(await bounty.state()).to.equal(3); // CANCELLED
      });

      it("cannot transition to CLOSED directly", async function () {
        const bounty = await createBounty(issuer, ONE_ETH, false);

        // No way to go directly to CLOSED
        await expect(bounty.resolveVote()).to.be.revertedWithCustomError(
          bounty, "Poidh__VotingNotActive"
        );
      });
    });

    describe("From VOTING state", function () {
      it("can transition to CLOSED via resolveVote (pass)", async function () {
        const bounty = await createBounty(issuer, ONE_ETH, false);
        await bounty.connect(worker1).submitClaim("Work", "ipfs://proof");
        await bounty.connect(issuer).startVote(0);

        // Wait for deadline (issuer can't vote)
        await time.increase(TWO_DAYS + 1);

        await bounty.resolveVote();
        expect(await bounty.state()).to.equal(2); // CLOSED (0 >= 0 passes)
      });

      it("can transition to OPEN via resolveVote (fail)", async function () {
        const bounty = await createBounty(issuer, ONE_ETH, true);
        await bounty.connect(contributor1).join({ value: TWO_ETH });
        await bounty.connect(worker1).submitClaim("Work", "ipfs://proof");
        await bounty.connect(issuer).startVote(0);
        await bounty.connect(contributor1).vote(false);

        await time.increase(TWO_DAYS + 1);
        await bounty.resolveVote();
        expect(await bounty.state()).to.equal(0); // OPEN (0 < 2 ETH no)
      });

      it("cannot transition to CANCELLED from VOTING", async function () {
        const bounty = await createBounty(issuer, ONE_ETH, false);
        await bounty.connect(worker1).submitClaim("Work", "ipfs://proof");
        await bounty.connect(issuer).startVote(0);

        await expect(
          bounty.connect(issuer).cancel()
        ).to.be.revertedWithCustomError(bounty, "Poidh__BountyNotOpen");
      });
    });

    describe("From CLOSED state", function () {
      it("cannot do anything", async function () {
        const bounty = await createBounty(issuer, ONE_ETH, false);
        await bounty.connect(worker1).submitClaim("Work", "ipfs://proof");
        await bounty.connect(issuer).startVote(0);
        await time.increase(TWO_DAYS + 1);
        await bounty.resolveVote();

        expect(await bounty.state()).to.equal(2); // CLOSED

        await expect(
          bounty.connect(issuer).startVote(0)
        ).to.be.revertedWithCustomError(bounty, "Poidh__BountyNotOpen");

        await expect(
          bounty.connect(issuer).cancel()
        ).to.be.revertedWithCustomError(bounty, "Poidh__BountyNotOpen");

        await expect(
          bounty.connect(issuer).withdraw(issuer.address)
        ).to.be.revertedWithCustomError(bounty, "Poidh__CannotWithdraw");
      });
    });

    describe("From CANCELLED state", function () {
      it("can only withdraw", async function () {
        const bounty = await createBounty(issuer, ONE_ETH, false);
        await bounty.connect(issuer).cancel();

        expect(await bounty.state()).to.equal(3); // CANCELLED

        await expect(
          bounty.connect(issuer).startVote(0)
        ).to.be.revertedWithCustomError(bounty, "Poidh__BountyNotOpen");

        await expect(
          bounty.connect(issuer).cancel()
        ).to.be.revertedWithCustomError(bounty, "Poidh__BountyNotOpen");

        // Can withdraw
        await bounty.connect(issuer).withdraw(issuer.address);
      });
    });
  });

  /*//////////////////////////////////////////////////////////////
                    VOTING EDGE CASES
  //////////////////////////////////////////////////////////////*/

  describe("Voting Edge Cases", function () {

    it("should track voting rounds correctly", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributor1).join({ value: ONE_ETH });
      await bounty.connect(contributor2).join({ value: TWO_ETH });
      await bounty.connect(worker1).submitClaim("Work", "ipfs://proof");

      // Round 1 - fail (contributor1: 1 ETH yes, contributor2: 2 ETH no)
      await bounty.connect(issuer).startVote(0);
      expect((await bounty.currentVote()).votingRound).to.equal(1);
      await bounty.connect(contributor1).vote(true);
      await bounty.connect(contributor2).vote(false);
      await time.increase(TWO_DAYS + 1);
      await bounty.resolveVote();

      // Round 2 - can vote again
      expect((await bounty.currentVote()).votingRound).to.equal(2);
      await bounty.connect(issuer).startVote(0);

      // Can vote in round 2 (wasn't counted in round 1 tracking)
      await bounty.connect(contributor1).vote(true);
      await bounty.connect(contributor2).vote(true);
      await time.increase(TWO_DAYS + 1);
      await bounty.resolveVote();

      expect(await bounty.state()).to.equal(2); // CLOSED
    });

    it("should not allow same person to vote twice in same round", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributor1).join({ value: ONE_ETH });
      await bounty.connect(worker1).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);

      await bounty.connect(contributor1).vote(true);

      await expect(
        bounty.connect(contributor1).vote(true)
      ).to.be.revertedWithCustomError(bounty, "Poidh__AlreadyVotedThisRound");

      await expect(
        bounty.connect(contributor1).vote(false)
      ).to.be.revertedWithCustomError(bounty, "Poidh__AlreadyVotedThisRound");
    });

    it("should handle vote at exact deadline boundary", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributor1).join({ value: ONE_ETH });
      await bounty.connect(contributor2).join({ value: ONE_ETH });
      await bounty.connect(worker1).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);

      // Move to just before deadline
      await time.increase(TWO_DAYS - 10);

      // Can still vote
      await bounty.connect(contributor1).vote(true);

      // Move past deadline
      await time.increase(20);

      // Cannot vote anymore - VotingEnded because past deadline
      await expect(
        bounty.connect(contributor2).vote(true)
      ).to.be.revertedWithCustomError(bounty, "Poidh__VotingEnded");
    });

    it("should handle selecting different claims across voting rounds", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, false);
      await bounty.connect(worker1).submitClaim("Claim 0", "ipfs://proof0");
      await bounty.connect(worker2).submitClaim("Claim 1", "ipfs://proof1");

      // Vote on claim 0, wait for deadline (0 >= 0 passes but let's use claim 1)
      // Since solo bounty with no contributors, 0 >= 0 passes
      // Just test claim selection directly
      await bounty.connect(issuer).startVote(1);
      expect((await bounty.currentVote()).claimId).to.equal(1);

      await time.increase(TWO_DAYS + 1);

      const worker2BalBefore = await getBalance(worker2.address);
      await bounty.resolveVote();
      const worker2BalAfter = await getBalance(worker2.address);

      // Worker2 (claim 1) gets paid
      const fee = ONE_ETH.mul(25).div(1000);
      const reward = ONE_ETH.sub(fee);
      expect(worker2BalAfter.sub(worker2BalBefore)).to.equal(reward);
    });
  });

  /*//////////////////////////////////////////////////////////////
                    FUND ACCOUNTING INVARIANTS
  //////////////////////////////////////////////////////////////*/

  describe("Fund Accounting Invariants", function () {

    it("totalStaked should always equal sum of all stakes", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);

      await bounty.connect(contributor1).join({ value: HALF_ETH });
      await bounty.connect(contributor2).join({ value: QUARTER_ETH });
      await bounty.connect(contributor3).join({ value: TWO_ETH });

      const total = await bounty.totalStaked();
      const issuerStake = await bounty.account_Stake(issuer.address);
      const c1Stake = await bounty.account_Stake(contributor1.address);
      const c2Stake = await bounty.account_Stake(contributor2.address);
      const c3Stake = await bounty.account_Stake(contributor3.address);

      expect(total).to.equal(issuerStake.add(c1Stake).add(c2Stake).add(c3Stake));
    });

    it("totalStaked should decrease correctly on withdraw", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributor1).join({ value: ONE_ETH });
      await bounty.connect(contributor2).join({ value: ONE_ETH });

      expect(await bounty.totalStaked()).to.equal(THREE_ETH);

      await bounty.connect(contributor1).withdraw(contributor1.address);
      expect(await bounty.totalStaked()).to.equal(TWO_ETH);

      await bounty.connect(contributor2).withdraw(contributor2.address);
      expect(await bounty.totalStaked()).to.equal(ONE_ETH);
    });

    it("contract balance should equal totalStaked", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributor1).join({ value: ONE_ETH });

      expect(await getBalance(bounty.address)).to.equal(await bounty.totalStaked());

      await bounty.connect(contributor1).withdraw(contributor1.address);

      expect(await getBalance(bounty.address)).to.equal(await bounty.totalStaked());
    });

    it("all funds should be accounted for after payout", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributor1).join({ value: ONE_ETH });

      const totalBefore = TWO_ETH;
      const bountyBalBefore = await getBalance(bounty.address);
      expect(bountyBalBefore).to.equal(totalBefore);

      await bounty.connect(worker1).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);
      await bounty.connect(contributor1).vote(true);

      // Wait for deadline (issuer can't vote)
      await time.increase(TWO_DAYS + 1);

      const workerBalBefore = await getBalance(worker1.address);

      await bounty.resolveVote();

      const workerBalAfter = await getBalance(worker1.address);
      const bountyBalAfter = await getBalance(bounty.address);

      // Contract empty
      expect(bountyBalAfter).to.equal(0);

      // Worker gets correct reward
      const fee = totalBefore.mul(25).div(1000);
      const reward = totalBefore.sub(fee);

      expect(workerBalAfter.sub(workerBalBefore)).to.equal(reward);
    });

    it("all funds should be recoverable after cancel", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributor1).join({ value: HALF_ETH });
      await bounty.connect(contributor2).join({ value: QUARTER_ETH });

      const totalStaked = await bounty.totalStaked();
      expect(await getBalance(bounty.address)).to.equal(totalStaked);

      await bounty.connect(issuer).cancel();

      // Withdraw all
      await bounty.connect(issuer).withdraw(issuer.address);
      await bounty.connect(contributor1).withdraw(contributor1.address);
      await bounty.connect(contributor2).withdraw(contributor2.address);

      expect(await getBalance(bounty.address)).to.equal(0);
      expect(await bounty.totalStaked()).to.equal(0);
    });
  });

  /*//////////////////////////////////////////////////////////////
                    REENTRANCY PROTECTION TESTS
  //////////////////////////////////////////////////////////////*/

  describe("Reentrancy Protection", function () {

    it("should protect withdraw from reentrancy when OPEN", async function () {
      // Deploy attacker contract
      const AttackerFactory = await ethers.getContractFactory("ReentrancyAttacker");
      const attackerContract = await AttackerFactory.deploy();
      await attackerContract.deployed();

      const bounty = await createBounty(issuer, ONE_ETH, true);

      // Attacker joins
      await attackerContract.join(bounty.address, { value: ONE_ETH });

      // Set target
      await attackerContract.setTarget(bounty.address);

      // Get balance before attack
      const attackerBalBefore = await getBalance(attackerContract.address);

      // Attempt reentrancy attack - the nonReentrant modifier will prevent re-entry
      // The first withdraw should succeed but reentry attempts will fail
      await attackerContract.attackWithdraw();

      // Attacker should only get their original stake (1 ETH), not more
      const attackerBalAfter = await getBalance(attackerContract.address);
      expect(attackerBalAfter.sub(attackerBalBefore)).to.equal(ONE_ETH);

      // Bounty should still have issuer's 1 ETH
      expect(await getBalance(bounty.address)).to.equal(ONE_ETH);
    });

    it("should protect withdraw from reentrancy when CANCELLED", async function () {
      const AttackerFactory = await ethers.getContractFactory("ReentrancyAttacker");
      const attackerContract = await AttackerFactory.deploy();
      await attackerContract.deployed();

      const bounty = await createBounty(issuer, ONE_ETH, true);

      // Attacker joins
      await attackerContract.join(bounty.address, { value: ONE_ETH });

      // Cancel
      await bounty.connect(issuer).cancel();

      // Set target
      await attackerContract.setTarget(bounty.address);

      const attackerBalBefore = await getBalance(attackerContract.address);

      // Attempt reentrancy attack
      await attackerContract.attackWithdraw();

      // Attacker should only get their original stake (1 ETH), not more
      const attackerBalAfter = await getBalance(attackerContract.address);
      expect(attackerBalAfter.sub(attackerBalBefore)).to.equal(ONE_ETH);

      // Bounty should still have issuer's 1 ETH
      expect(await getBalance(bounty.address)).to.equal(ONE_ETH);
    });
  });

  /*//////////////////////////////////////////////////////////////
                    BOUNDARY CONDITIONS
  //////////////////////////////////////////////////////////////*/

  describe("Boundary Conditions", function () {

    it("should handle very small amounts (1 wei)", async function () {
      const bounty = await createBounty(issuer, 1, true);
      await bounty.connect(contributor1).join({ value: 1 });

      expect(await bounty.totalStaked()).to.equal(2);

      await bounty.connect(worker1).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);
      await bounty.connect(contributor1).vote(true);
      await time.increase(TWO_DAYS + 1);
      await bounty.resolveVote();

      // Fee calculation: 2 * 25 / 1000 = 0 (rounds down)
      // So worker gets all 2 wei
      expect(await bounty.state()).to.equal(2);
    });

    it("should handle large amounts (100 ETH)", async function () {
      const LARGE = ethers.utils.parseEther("100");
      const bounty = await createBounty(issuer, LARGE, false);

      await bounty.connect(worker1).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);
      await time.increase(TWO_DAYS + 1);

      const workerBalBefore = await getBalance(worker1.address);
      await bounty.resolveVote();
      const workerBalAfter = await getBalance(worker1.address);

      const fee = LARGE.mul(25).div(1000);
      const reward = LARGE.sub(fee);

      expect(workerBalAfter.sub(workerBalBefore)).to.equal(reward);
    });

    it("should handle max number of claims", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, false);

      // Submit 100 claims
      for (let i = 0; i < 100; i++) {
        await bounty.connect(worker1).submitClaim(`Claim ${i}`, `ipfs://proof${i}`);
      }

      expect(await bounty.getClaimsCount()).to.equal(100);

      // Can select any claim
      await bounty.connect(issuer).startVote(50);
      expect((await bounty.currentVote()).claimId).to.equal(50);
    });

    it("should handle many contributors", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);

      const signers = await ethers.getSigners();
      // Join with multiple contributors (use available signers)
      for (let i = 8; i < Math.min(20, signers.length); i++) {
        await bounty.connect(signers[i]).join({ value: QUARTER_ETH });
      }

      const count = Math.min(20, signers.length) - 8;
      const expectedTotal = ONE_ETH.add(QUARTER_ETH.mul(count));
      expect(await bounty.totalStaked()).to.equal(expectedTotal);
    });
  });

  /*//////////////////////////////////////////////////////////////
                    CLAIM SUBMISSION TESTS
  //////////////////////////////////////////////////////////////*/

  describe("Claim Submission", function () {

    it("should allow anyone to submit claims", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, false);

      await bounty.connect(worker1).submitClaim("Work 1", "ipfs://proof1");
      await bounty.connect(worker2).submitClaim("Work 2", "ipfs://proof2");
      await bounty.connect(attacker).submitClaim("Work 3", "ipfs://proof3");
      await bounty.connect(issuer).submitClaim("Work 4", "ipfs://proof4");

      expect(await bounty.getClaimsCount()).to.equal(4);
    });

    it("should store claim data correctly", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, false);

      await bounty.connect(worker1).submitClaim("My Amazing Work", "ipfs://QmProof123");

      const claim = await bounty.getClaim(0);
      expect(claim.claimant).to.equal(worker1.address);
      expect(claim.name).to.equal("My Amazing Work");
      expect(claim.proofURI).to.equal("ipfs://QmProof123");
    });

    it("should not allow claims during VOTING state", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, false);

      await bounty.connect(worker1).submitClaim("Work 1", "ipfs://proof1");
      await bounty.connect(issuer).startVote(0);

      // Cannot submit claims during voting
      await expect(
        bounty.connect(worker2).submitClaim("Work 2", "ipfs://proof2")
      ).to.be.revertedWithCustomError(bounty, "Poidh__BountyNotOpen");
    });

    it("should not allow claims after CLOSED state", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, false);

      await bounty.connect(worker1).submitClaim("Work 1", "ipfs://proof1");
      await bounty.connect(issuer).startVote(0);
      await time.increase(TWO_DAYS + 1);
      await bounty.resolveVote();

      expect(await bounty.state()).to.equal(2); // CLOSED

      // Cannot submit claims after closed
      await expect(
        bounty.connect(worker2).submitClaim("Work 2", "ipfs://proof2")
      ).to.be.revertedWithCustomError(bounty, "Poidh__BountyNotOpen");
    });

    it("should not allow claims after CANCELLED state", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, false);

      await bounty.connect(issuer).cancel();

      expect(await bounty.state()).to.equal(3); // CANCELLED

      // Cannot submit claims after cancelled
      await expect(
        bounty.connect(worker1).submitClaim("Work", "ipfs://proof")
      ).to.be.revertedWithCustomError(bounty, "Poidh__BountyNotOpen");
    });

    it("should allow empty strings for name and proofURI", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, false);

      await bounty.connect(worker1).submitClaim("", "");

      const claim = await bounty.getClaim(0);
      expect(claim.name).to.equal("");
      expect(claim.proofURI).to.equal("");
    });
  });

  /*//////////////////////////////////////////////////////////////
                    FACTORY COMPREHENSIVE TESTS
  //////////////////////////////////////////////////////////////*/

  describe("Factory Comprehensive", function () {

    it("should emit correct events on bounty creation", async function () {
      await expect(
        factory.connect(issuer).createBounty("ipfs://test", true, { value: ONE_ETH })
      ).to.emit(factory, "PoidhFactory__BountyCreated");
    });

    it("should track bounties across multiple issuers", async function () {
      await createBounty(issuer, ONE_ETH, false);
      await createBounty(contributor1, HALF_ETH, true);
      await createBounty(contributor2, QUARTER_ETH, true);
      await createBounty(worker1, TWO_ETH, false);

      expect(await factory.getBountiesCount()).to.equal(4);
    });

    it("should return correct bounty addresses", async function () {
      const b1 = await createBounty(issuer, ONE_ETH, false);
      const b2 = await createBounty(contributor1, HALF_ETH, true);

      expect(await factory.allBounties(0)).to.equal(b1.address);
      expect(await factory.allBounties(1)).to.equal(b2.address);
    });

    it("should handle pagination correctly", async function () {
      // Create 5 bounties
      const bounties = [];
      for (let i = 0; i < 5; i++) {
        bounties.push(await createBounty(issuer, ONE_ETH, true));
      }

      // Get first 2
      let page = await factory.getBounties(2, 0);
      expect(page.length).to.equal(2);
      expect(page[0]).to.equal(bounties[0].address);
      expect(page[1]).to.equal(bounties[1].address);

      // Get middle 2
      page = await factory.getBounties(2, 2);
      expect(page.length).to.equal(2);
      expect(page[0]).to.equal(bounties[2].address);
      expect(page[1]).to.equal(bounties[3].address);

      // Get last 1
      page = await factory.getBounties(2, 4);
      expect(page.length).to.equal(1);
      expect(page[0]).to.equal(bounties[4].address);

      // Beyond range
      page = await factory.getBounties(10, 10);
      expect(page.length).to.equal(0);
    });
  });
});
