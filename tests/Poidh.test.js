const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Poidh", function () {
  let factory;
  let treasury;
  let issuer;
  let contributor1;
  let contributor2;
  let worker;
  let attacker;

  const ONE_ETH = ethers.utils.parseEther("1");
  const HALF_ETH = ethers.utils.parseEther("0.5");
  const QUARTER_ETH = ethers.utils.parseEther("0.25");
  const TWO_DAYS = 2 * 24 * 60 * 60;

  beforeEach(async function () {
    [treasury, issuer, contributor1, contributor2, worker, attacker] = await ethers.getSigners();

    const PoidhFactory = await ethers.getContractFactory("PoidhFactory");
    factory = await PoidhFactory.deploy(treasury.address);
    await factory.deployed();
  });

  // Helper to create bounty and get contract instance
  async function createBounty(signer, value, joinable) {
    const tx = await factory.connect(signer).createBounty("ipfs://metadata", joinable, { value });
    const receipt = await tx.wait();
    const event = receipt.events.find(e => e.event === "PoidhFactory__BountyCreated");
    const bountyAddress = event.args.bountyAddress;
    return await ethers.getContractAt("Poidh", bountyAddress);
  }

  /*//////////////////////////////////////////////////////////////
                        SOLO BOUNTY HAPPY PATH
  //////////////////////////////////////////////////////////////*/

  describe("Solo Bounty Happy Path", function () {
    it("should create solo bounty with correct initial state", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, false);

      expect(await bounty.issuer()).to.equal(issuer.address);
      expect(await bounty.treasury()).to.equal(treasury.address);
      expect(await bounty.metadataURI()).to.equal("ipfs://metadata");
      expect(await bounty.state()).to.equal(0); // OPEN
      expect(await bounty.joinable()).to.equal(false);
      expect(await bounty.totalStaked()).to.equal(ONE_ETH);
      expect(await bounty.account_Stake(issuer.address)).to.equal(ONE_ETH);
    });

    it("should complete full solo bounty flow: create -> claim -> vote -> payout", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, false);

      // Worker submits claim
      await bounty.connect(worker).submitClaim("My Work", "ipfs://proof");
      expect(await bounty.getClaimsCount()).to.equal(1);

      // Issuer starts vote
      await bounty.connect(issuer).startVote(0);
      expect(await bounty.state()).to.equal(1); // VOTING

      // Issuer cannot vote (new rule)
      await expect(
        bounty.connect(issuer).vote(true)
      ).to.be.revertedWithCustomError(bounty, "Poidh__IssuerCannotVote");

      // Wait for deadline (solo bounty with no other voters)
      await time.increase(TWO_DAYS + 1);

      // Resolve after deadline (0 >= 0 passes)
      const workerBalanceBefore = await worker.getBalance();

      await bounty.resolveVote();

      expect(await bounty.state()).to.equal(2); // CLOSED

      // Check payouts (2.5% fee)
      const fee = ONE_ETH.mul(25).div(1000);
      const reward = ONE_ETH.sub(fee);

      const workerBalanceAfter = await worker.getBalance();

      // Worker receives 97.5% reward
      expect(workerBalanceAfter.sub(workerBalanceBefore)).to.equal(reward);

      // Contract should be empty
      expect(await ethers.provider.getBalance(bounty.address)).to.equal(0);
    });

    it("should not allow others to join solo bounty", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, false);

      await expect(
        bounty.connect(contributor1).join({ value: HALF_ETH })
      ).to.be.revertedWithCustomError(bounty, "Poidh__BountyNotJoinable");
    });
  });

  /*//////////////////////////////////////////////////////////////
                        OPEN BOUNTY HAPPY PATH
  //////////////////////////////////////////////////////////////*/

  describe("Open Bounty Happy Path", function () {
    it("should create open bounty and allow others to join", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);

      expect(await bounty.joinable()).to.equal(true);
      expect(await bounty.totalStaked()).to.equal(ONE_ETH);

      // Contributor joins
      await bounty.connect(contributor1).join({ value: HALF_ETH });
      expect(await bounty.totalStaked()).to.equal(ONE_ETH.add(HALF_ETH));
      expect(await bounty.account_Stake(contributor1.address)).to.equal(HALF_ETH);
    });

    it("should complete full open bounty flow with multiple contributors", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);

      // Contributors join
      await bounty.connect(contributor1).join({ value: ONE_ETH });
      await bounty.connect(contributor2).join({ value: ONE_ETH });

      const totalStaked = ONE_ETH.mul(3); // 3 ETH total

      // Worker submits claim
      await bounty.connect(worker).submitClaim("My Work", "ipfs://proof");

      // Issuer starts vote
      await bounty.connect(issuer).startVote(0);

      // Contributors vote yes (issuer cannot vote)
      await bounty.connect(contributor1).vote(true);
      await bounty.connect(contributor2).vote(true);

      // Cannot resolve yet - not all votes cast (issuer's stake still counts in totalStaked)
      // Wait for deadline
      await time.increase(TWO_DAYS + 1);

      // Resolve after deadline
      const workerBalanceBefore = await worker.getBalance();

      await bounty.resolveVote();

      expect(await bounty.state()).to.equal(2); // CLOSED

      // Check payout
      const fee = totalStaked.mul(25).div(1000);
      const reward = totalStaked.sub(fee);

      const workerBalanceAfter = await worker.getBalance();
      expect(workerBalanceAfter.sub(workerBalanceBefore)).to.equal(reward);
    });
  });

  /*//////////////////////////////////////////////////////////////
                          VOTING LOGIC TESTS
  //////////////////////////////////////////////////////////////*/

  describe("Voting Logic", function () {
    it("should pass vote when yes > no", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributor1).join({ value: HALF_ETH });
      await bounty.connect(contributor2).join({ value: QUARTER_ETH });

      await bounty.connect(worker).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);

      // contributor1 (0.5 ETH) votes yes, contributor2 (0.25 ETH) votes no
      await bounty.connect(contributor1).vote(true);
      await bounty.connect(contributor2).vote(false);

      // Wait for deadline (issuer can't vote so not all votes cast)
      await time.increase(TWO_DAYS + 1);

      await bounty.resolveVote();
      expect(await bounty.state()).to.equal(2); // CLOSED - passed (0.5 > 0.25)
    });

    it("should pass vote when yes == no (tie goes to claimant)", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributor1).join({ value: ONE_ETH });
      await bounty.connect(contributor2).join({ value: ONE_ETH });

      await bounty.connect(worker).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);

      // Equal votes from contributors
      await bounty.connect(contributor1).vote(true);
      await bounty.connect(contributor2).vote(false);

      // Wait for deadline
      await time.increase(TWO_DAYS + 1);

      await bounty.resolveVote();
      expect(await bounty.state()).to.equal(2); // CLOSED - tie passes
    });

    it("should fail vote when yes < no and reset to OPEN", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributor1).join({ value: ONE_ETH });
      await bounty.connect(contributor2).join({ value: ONE_ETH.mul(2) });

      await bounty.connect(worker).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);

      // contributor1 (1 ETH) votes yes, contributor2 (2 ETH) votes no
      await bounty.connect(contributor1).vote(true);
      await bounty.connect(contributor2).vote(false);

      // Wait for deadline
      await time.increase(TWO_DAYS + 1);

      await bounty.resolveVote();
      expect(await bounty.state()).to.equal(0); // OPEN - failed, reset
    });

    it("should allow new vote after failed vote", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributor1).join({ value: ONE_ETH });
      await bounty.connect(contributor2).join({ value: ONE_ETH.mul(2) });

      // First claim and failed vote
      await bounty.connect(worker).submitClaim("Work 1", "ipfs://proof1");
      await bounty.connect(issuer).startVote(0);
      await bounty.connect(contributor1).vote(true);
      await bounty.connect(contributor2).vote(false);
      await time.increase(TWO_DAYS + 1);
      await bounty.resolveVote();

      expect(await bounty.state()).to.equal(0); // OPEN

      // Second claim and successful vote (contributor2 changes mind)
      await bounty.connect(worker).submitClaim("Work 2", "ipfs://proof2");
      await bounty.connect(issuer).startVote(1);
      await bounty.connect(contributor1).vote(true);
      await bounty.connect(contributor2).vote(true);
      await time.increase(TWO_DAYS + 1);
      await bounty.resolveVote();

      expect(await bounty.state()).to.equal(2); // CLOSED
    });

    it("should resolve after deadline even with no votes", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributor1).join({ value: ONE_ETH });

      await bounty.connect(worker).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);

      // No one votes, wait for deadline
      await time.increase(TWO_DAYS + 1);

      // yes=0, no=0, 0 >= 0 is true, so it passes
      await bounty.resolveVote();
      expect(await bounty.state()).to.equal(2); // CLOSED - 0 >= 0 passes
    });

    it("should not resolve before deadline if not all non-issuer votes cast", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributor1).join({ value: ONE_ETH });
      await bounty.connect(contributor2).join({ value: ONE_ETH });

      await bounty.connect(worker).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);

      // Only contributor1 votes (issuer can't vote)
      await bounty.connect(contributor1).vote(true);

      // Cannot resolve - issuer stake is in totalStaked but can't vote, so allVotesCast is false
      await expect(bounty.resolveVote()).to.be.revertedWithCustomError(
        bounty,
        "Poidh__VotingNotEnded"
      );
    });
  });

  /*//////////////////////////////////////////////////////////////
                      CANCEL AND REFUND TESTS
  //////////////////////////////////////////////////////////////*/

  describe("Cancel and Refund", function () {
    it("should allow issuer to cancel solo bounty", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, false);

      await bounty.connect(issuer).cancel();
      expect(await bounty.state()).to.equal(3); // CANCELLED
    });

    it("should allow issuer to cancel open bounty", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributor1).join({ value: HALF_ETH });

      await bounty.connect(issuer).cancel();
      expect(await bounty.state()).to.equal(3); // CANCELLED
    });

    it("should not allow non-issuer to cancel", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);

      await expect(
        bounty.connect(contributor1).cancel()
      ).to.be.revertedWithCustomError(bounty, "Poidh__OnlyIssuer");
    });

    it("should not allow cancel during voting", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, false);
      await bounty.connect(worker).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);

      await expect(
        bounty.connect(issuer).cancel()
      ).to.be.revertedWithCustomError(bounty, "Poidh__BountyNotOpen");
    });

    it("should allow all contributors to withdraw after cancel", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributor1).join({ value: HALF_ETH });
      await bounty.connect(contributor2).join({ value: HALF_ETH });

      await bounty.connect(issuer).cancel();

      // All can withdraw (including issuer)
      const issuerBalanceBefore = await issuer.getBalance();
      const tx1 = await bounty.connect(issuer).withdraw(issuer.address);
      const receipt1 = await tx1.wait();
      const gas1 = receipt1.gasUsed.mul(receipt1.effectiveGasPrice);
      const issuerBalanceAfter = await issuer.getBalance();
      expect(issuerBalanceAfter.add(gas1).sub(issuerBalanceBefore)).to.equal(ONE_ETH);

      const c1BalanceBefore = await contributor1.getBalance();
      const tx2 = await bounty.connect(contributor1).withdraw(contributor1.address);
      const receipt2 = await tx2.wait();
      const gas2 = receipt2.gasUsed.mul(receipt2.effectiveGasPrice);
      const c1BalanceAfter = await contributor1.getBalance();
      expect(c1BalanceAfter.add(gas2).sub(c1BalanceBefore)).to.equal(HALF_ETH);

      const c2BalanceBefore = await contributor2.getBalance();
      const tx3 = await bounty.connect(contributor2).withdraw(contributor2.address);
      const receipt3 = await tx3.wait();
      const gas3 = receipt3.gasUsed.mul(receipt3.effectiveGasPrice);
      const c2BalanceAfter = await contributor2.getBalance();
      expect(c2BalanceAfter.add(gas3).sub(c2BalanceBefore)).to.equal(HALF_ETH);
    });

    it("should allow anyone to withdraw for any funder when cancelled", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributor1).join({ value: HALF_ETH });

      await bounty.connect(issuer).cancel();

      // Attacker can withdraw for issuer and contributor1 (automating refunds)
      const issuerBalanceBefore = await issuer.getBalance();
      await bounty.connect(attacker).withdraw(issuer.address);
      const issuerBalanceAfter = await issuer.getBalance();
      expect(issuerBalanceAfter.sub(issuerBalanceBefore)).to.equal(ONE_ETH);

      const c1BalanceBefore = await contributor1.getBalance();
      await bounty.connect(attacker).withdraw(contributor1.address);
      const c1BalanceAfter = await contributor1.getBalance();
      expect(c1BalanceAfter.sub(c1BalanceBefore)).to.equal(HALF_ETH);

      expect(await ethers.provider.getBalance(bounty.address)).to.equal(0);
    });

    it("should not allow double withdraw after cancel", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, false);
      await bounty.connect(issuer).cancel();
      await bounty.connect(issuer).withdraw(issuer.address);

      await expect(
        bounty.connect(issuer).withdraw(issuer.address)
      ).to.be.revertedWithCustomError(bounty, "Poidh__NoFundsToWithdraw");
    });
  });

  /*//////////////////////////////////////////////////////////////
                          WITHDRAW TESTS
  //////////////////////////////////////////////////////////////*/

  describe("Withdraw", function () {
    it("should allow contributor to withdraw from open bounty", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributor1).join({ value: HALF_ETH });

      const balanceBefore = await contributor1.getBalance();
      const tx = await bounty.connect(contributor1).withdraw(contributor1.address);
      const receipt = await tx.wait();
      const gas = receipt.gasUsed.mul(receipt.effectiveGasPrice);
      const balanceAfter = await contributor1.getBalance();

      expect(balanceAfter.add(gas).sub(balanceBefore)).to.equal(HALF_ETH);
      expect(await bounty.account_Stake(contributor1.address)).to.equal(0);
      expect(await bounty.totalStaked()).to.equal(ONE_ETH);
    });

    it("should not allow issuer to withdraw when OPEN", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);

      await expect(
        bounty.connect(issuer).withdraw(issuer.address)
      ).to.be.revertedWithCustomError(bounty, "Poidh__CannotWithdraw");
    });

    it("should not allow withdraw during voting", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributor1).join({ value: HALF_ETH });
      await bounty.connect(worker).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);

      await expect(
        bounty.connect(contributor1).withdraw(contributor1.address)
      ).to.be.revertedWithCustomError(bounty, "Poidh__CannotWithdraw");
    });

    it("should not allow withdraw with no stake", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);

      await expect(
        bounty.connect(contributor1).withdraw(contributor1.address)
      ).to.be.revertedWithCustomError(bounty, "Poidh__NoFundsToWithdraw");
    });

    it("should allow withdraw after failed vote", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributor1).join({ value: ONE_ETH.mul(2) });

      await bounty.connect(worker).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);
      await bounty.connect(contributor1).vote(false);
      await time.increase(TWO_DAYS + 1);
      await bounty.resolveVote();

      // Back to OPEN, contributor can withdraw
      await bounty.connect(contributor1).withdraw(contributor1.address);
      expect(await bounty.account_Stake(contributor1.address)).to.equal(0);
    });

    it("should ignore _account param when OPEN (uses msg.sender)", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributor1).join({ value: HALF_ETH });

      // Even if contributor1 passes issuer's address, they withdraw their own funds
      const c1BalanceBefore = await contributor1.getBalance();
      const tx = await bounty.connect(contributor1).withdraw(issuer.address);
      const receipt = await tx.wait();
      const gas = receipt.gasUsed.mul(receipt.effectiveGasPrice);
      const c1BalanceAfter = await contributor1.getBalance();

      // Contributor1 withdrew their own funds, not issuer's
      expect(c1BalanceAfter.add(gas).sub(c1BalanceBefore)).to.equal(HALF_ETH);
      expect(await bounty.account_Stake(contributor1.address)).to.equal(0);
      expect(await bounty.account_Stake(issuer.address)).to.equal(ONE_ETH); // Issuer still has funds
    });
  });

  /*//////////////////////////////////////////////////////////////
                        ACCESS CONTROL TESTS
  //////////////////////////////////////////////////////////////*/

  describe("Access Control", function () {
    it("should only allow issuer to start vote", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(worker).submitClaim("Work", "ipfs://proof");

      await expect(
        bounty.connect(contributor1).startVote(0)
      ).to.be.revertedWithCustomError(bounty, "Poidh__OnlyIssuer");
    });

    it("should not allow issuer to vote", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributor1).join({ value: ONE_ETH });
      await bounty.connect(worker).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);

      await expect(
        bounty.connect(issuer).vote(true)
      ).to.be.revertedWithCustomError(bounty, "Poidh__IssuerCannotVote");
    });

    it("should not allow voting without stake", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributor1).join({ value: ONE_ETH });
      await bounty.connect(worker).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);

      await expect(
        bounty.connect(attacker).vote(true)
      ).to.be.revertedWithCustomError(bounty, "Poidh__NoStakeInBounty");
    });

    it("should not allow double voting in same round", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributor1).join({ value: ONE_ETH });
      await bounty.connect(worker).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);
      await bounty.connect(contributor1).vote(true);

      await expect(
        bounty.connect(contributor1).vote(true)
      ).to.be.revertedWithCustomError(bounty, "Poidh__AlreadyVotedThisRound");
    });

    it("should not allow voting after deadline", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributor1).join({ value: ONE_ETH });
      await bounty.connect(worker).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);

      await time.increase(TWO_DAYS + 1);

      await expect(
        bounty.connect(contributor1).vote(true)
      ).to.be.revertedWithCustomError(bounty, "Poidh__VotingEnded");
    });

    it("should not allow starting vote with invalid claim id", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, false);

      await expect(
        bounty.connect(issuer).startVote(0)
      ).to.be.revertedWithCustomError(bounty, "Poidh__InvalidClaimId");
    });

    it("should not allow starting vote when not OPEN", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, false);
      await bounty.connect(worker).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);

      await expect(
        bounty.connect(issuer).startVote(0)
      ).to.be.revertedWithCustomError(bounty, "Poidh__BountyNotOpen");
    });
  });

  /*//////////////////////////////////////////////////////////////
                    EDGE CASES AND SECURITY TESTS
  //////////////////////////////////////////////////////////////*/

  describe("Edge Cases and Security", function () {
    it("should handle bounty with zero initial funding", async function () {
      const bounty = await createBounty(issuer, 0, true);

      expect(await bounty.totalStaked()).to.equal(0);
      expect(await bounty.account_Stake(issuer.address)).to.equal(0);

      // Contributors can still join
      await bounty.connect(contributor1).join({ value: ONE_ETH });
      expect(await bounty.totalStaked()).to.equal(ONE_ETH);
    });

    it("should handle multiple claims correctly", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, false);

      await bounty.connect(worker).submitClaim("Claim 1", "ipfs://proof1");
      await bounty.connect(contributor1).submitClaim("Claim 2", "ipfs://proof2");
      await bounty.connect(contributor2).submitClaim("Claim 3", "ipfs://proof3");

      expect(await bounty.getClaimsCount()).to.equal(3);

      const claim0 = await bounty.getClaim(0);
      const claim1 = await bounty.getClaim(1);
      const claim2 = await bounty.getClaim(2);

      expect(claim0.claimant).to.equal(worker.address);
      expect(claim1.claimant).to.equal(contributor1.address);
      expect(claim2.claimant).to.equal(contributor2.address);
    });

    it("should allow issuer to select any valid claim", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, false);

      await bounty.connect(worker).submitClaim("Claim 1", "ipfs://proof1");
      await bounty.connect(contributor1).submitClaim("Claim 2", "ipfs://proof2");

      // Select second claim
      await bounty.connect(issuer).startVote(1);

      // Wait for deadline (issuer can't vote)
      await time.increase(TWO_DAYS + 1);

      const contributor1BalanceBefore = await contributor1.getBalance();
      await bounty.resolveVote();
      const contributor1BalanceAfter = await contributor1.getBalance();

      // Contributor1 (claim 2) gets paid, not worker
      const fee = ONE_ETH.mul(25).div(1000);
      const reward = ONE_ETH.sub(fee);
      expect(contributor1BalanceAfter.sub(contributor1BalanceBefore)).to.equal(reward);
    });

    it("should not allow join with zero ETH", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);

      await expect(
        bounty.connect(contributor1).join({ value: 0 })
      ).to.be.revertedWithCustomError(bounty, "Poidh__NoEthSent");
    });

    it("should handle contributor joining multiple times", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);

      await bounty.connect(contributor1).join({ value: HALF_ETH });
      await bounty.connect(contributor1).join({ value: HALF_ETH });

      expect(await bounty.account_Stake(contributor1.address)).to.equal(ONE_ETH);
      expect(await bounty.totalStaked()).to.equal(ONE_ETH.mul(2));
    });
  });

  /*//////////////////////////////////////////////////////////////
                    FUNDS RECOVERY TESTS (NO BRICKED FUNDS)
  //////////////////////////////////////////////////////////////*/

  describe("Funds Recovery - No Bricked Funds", function () {
    it("should allow funds recovery via cancel in OPEN state", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributor1).join({ value: ONE_ETH });
      await bounty.connect(contributor2).join({ value: ONE_ETH });

      // Even with no claims, issuer can cancel
      await bounty.connect(issuer).cancel();

      // All funds recoverable
      await bounty.connect(issuer).withdraw(issuer.address);
      await bounty.connect(contributor1).withdraw(contributor1.address);
      await bounty.connect(contributor2).withdraw(contributor2.address);

      expect(await ethers.provider.getBalance(bounty.address)).to.equal(0);
    });

    it("should allow funds recovery after failed vote via cancel", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributor1).join({ value: ONE_ETH });
      await bounty.connect(contributor2).join({ value: ONE_ETH.mul(2) });

      await bounty.connect(worker).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);
      await bounty.connect(contributor1).vote(true);
      await bounty.connect(contributor2).vote(false);
      await time.increase(TWO_DAYS + 1);
      await bounty.resolveVote();

      // Vote failed, back to OPEN
      // Issuer decides to cancel
      await bounty.connect(issuer).cancel();

      await bounty.connect(issuer).withdraw(issuer.address);
      await bounty.connect(contributor1).withdraw(contributor1.address);
      await bounty.connect(contributor2).withdraw(contributor2.address);

      expect(await ethers.provider.getBalance(bounty.address)).to.equal(0);
    });

    it("should allow funds recovery after failed vote via withdraw", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributor1).join({ value: ONE_ETH });
      await bounty.connect(contributor2).join({ value: ONE_ETH.mul(2) });

      await bounty.connect(worker).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);
      await bounty.connect(contributor1).vote(true);
      await bounty.connect(contributor2).vote(false);
      await time.increase(TWO_DAYS + 1);
      await bounty.resolveVote();

      // Vote failed, back to OPEN
      // Contributors withdraw
      await bounty.connect(contributor1).withdraw(contributor1.address);
      await bounty.connect(contributor2).withdraw(contributor2.address);

      // Issuer must cancel to get funds
      await bounty.connect(issuer).cancel();
      await bounty.connect(issuer).withdraw(issuer.address);

      expect(await ethers.provider.getBalance(bounty.address)).to.equal(0);
    });

    it("should handle scenario where all contributors withdraw leaving only issuer", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributor1).join({ value: ONE_ETH });
      await bounty.connect(contributor2).join({ value: ONE_ETH });

      // All contributors withdraw
      await bounty.connect(contributor1).withdraw(contributor1.address);
      await bounty.connect(contributor2).withdraw(contributor2.address);

      expect(await bounty.totalStaked()).to.equal(ONE_ETH); // Only issuer left

      // Issuer can still complete bounty or cancel
      await bounty.connect(worker).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);

      // Wait for deadline (issuer can't vote)
      await time.increase(TWO_DAYS + 1);
      await bounty.resolveVote();

      expect(await bounty.state()).to.equal(2); // CLOSED
    });

    it("should handle multiple failed votes and eventual success", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributor1).join({ value: ONE_ETH });
      await bounty.connect(contributor2).join({ value: ONE_ETH.mul(2) });

      await bounty.connect(worker).submitClaim("Work 1", "ipfs://proof1");

      // First failed vote (contributor1: 1 ETH yes, contributor2: 2 ETH no)
      await bounty.connect(issuer).startVote(0);
      await bounty.connect(contributor1).vote(true);
      await bounty.connect(contributor2).vote(false);
      await time.increase(TWO_DAYS + 1);
      await bounty.resolveVote();
      expect(await bounty.state()).to.equal(0); // OPEN

      // Second failed vote
      await bounty.connect(issuer).startVote(0);
      await bounty.connect(contributor1).vote(true);
      await bounty.connect(contributor2).vote(false);
      await time.increase(TWO_DAYS + 1);
      await bounty.resolveVote();
      expect(await bounty.state()).to.equal(0); // OPEN

      // Contributor2 changes mind, third vote succeeds
      await bounty.connect(issuer).startVote(0);
      await bounty.connect(contributor1).vote(true);
      await bounty.connect(contributor2).vote(true);
      await time.increase(TWO_DAYS + 1);
      await bounty.resolveVote();
      expect(await bounty.state()).to.equal(2); // CLOSED

      // Funds paid out
      expect(await ethers.provider.getBalance(bounty.address)).to.equal(0);
    });

    it("should handle voting timeout correctly", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributor1).join({ value: ONE_ETH });

      await bounty.connect(worker).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);

      // Only contributor1 votes yes (issuer can't vote)
      await bounty.connect(contributor1).vote(true);

      // Wait for deadline
      await time.increase(TWO_DAYS + 1);

      // Resolve - yes (1 ETH) > no (0), passes
      await bounty.resolveVote();
      expect(await bounty.state()).to.equal(2); // CLOSED
    });

    it("should not brick funds if issuer disappears - contributors can wait for cancel alternative", async function () {
      const bounty = await createBounty(issuer, ONE_ETH, true);
      await bounty.connect(contributor1).join({ value: ONE_ETH });

      // Issuer disappears, never starts vote
      // Contributors can withdraw their stake
      await bounty.connect(contributor1).withdraw(contributor1.address);
      expect(await bounty.account_Stake(contributor1.address)).to.equal(0);

      // Issuer's funds remain, but that's their choice
      expect(await bounty.totalStaked()).to.equal(ONE_ETH);
    });
  });

  /*//////////////////////////////////////////////////////////////
                          FACTORY TESTS
  //////////////////////////////////////////////////////////////*/

  describe("Factory", function () {
    it("should track all bounties", async function () {
      await createBounty(issuer, ONE_ETH, false);
      await createBounty(issuer, ONE_ETH, true);
      await createBounty(contributor1, HALF_ETH, true);

      expect(await factory.getBountiesCount()).to.equal(3);
    });

    it("should return paginated bounties", async function () {
      const bounty1 = await createBounty(issuer, ONE_ETH, false);
      const bounty2 = await createBounty(issuer, ONE_ETH, true);
      const bounty3 = await createBounty(contributor1, HALF_ETH, true);

      const page1 = await factory.getBounties(2, 0);
      expect(page1.length).to.equal(2);
      expect(page1[0]).to.equal(bounty1.address);
      expect(page1[1]).to.equal(bounty2.address);

      const page2 = await factory.getBounties(2, 2);
      expect(page2.length).to.equal(1);
      expect(page2[0]).to.equal(bounty3.address);
    });

    it("should handle offset beyond array length", async function () {
      await createBounty(issuer, ONE_ETH, false);

      const result = await factory.getBounties(10, 100);
      expect(result.length).to.equal(0);
    });
  });

  /*//////////////////////////////////////////////////////////////
                      FACTORY OWNER TESTS
  //////////////////////////////////////////////////////////////*/

  describe("Factory Owner Functions", function () {
    it("should set deployer as owner", async function () {
      expect(await factory.owner()).to.equal(treasury.address);
    });

    it("should allow owner to set new implementation", async function () {
      const oldImpl = await factory.implementation();

      // Deploy new implementation
      const PoidhContract = await ethers.getContractFactory("Poidh");
      const newImpl = await PoidhContract.deploy();
      await newImpl.deployed();

      await expect(factory.connect(treasury).setImplementation(newImpl.address))
        .to.emit(factory, "PoidhFactory__ImplementationUpdated")
        .withArgs(oldImpl, newImpl.address);

      expect(await factory.implementation()).to.equal(newImpl.address);
    });

    it("should not allow non-owner to set implementation", async function () {
      const PoidhContract = await ethers.getContractFactory("Poidh");
      const newImpl = await PoidhContract.deploy();

      await expect(
        factory.connect(issuer).setImplementation(newImpl.address)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("should not allow setting implementation to zero address", async function () {
      await expect(
        factory.connect(treasury).setImplementation(ethers.constants.AddressZero)
      ).to.be.revertedWithCustomError(factory, "PoidhFactory__ZeroAddress");
    });

    it("should allow owner to set new treasury", async function () {
      const oldTreasury = await factory.treasury();

      await expect(factory.connect(treasury).setTreasury(issuer.address))
        .to.emit(factory, "PoidhFactory__TreasuryUpdated")
        .withArgs(oldTreasury, issuer.address);

      expect(await factory.treasury()).to.equal(issuer.address);
    });

    it("should allow setting treasury to zero address (disables fees)", async function () {
      await factory.connect(treasury).setTreasury(ethers.constants.AddressZero);
      expect(await factory.treasury()).to.equal(ethers.constants.AddressZero);
    });

    it("should not allow non-owner to set treasury", async function () {
      await expect(
        factory.connect(issuer).setTreasury(issuer.address)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("should use new implementation for new bounties", async function () {
      // Deploy new implementation
      const PoidhContract = await ethers.getContractFactory("Poidh");
      const newImpl = await PoidhContract.deploy();
      await newImpl.deployed();

      await factory.connect(treasury).setImplementation(newImpl.address);

      // Create bounty with new implementation
      const tx = await factory.connect(issuer).createBounty("ipfs://new", true, { value: ONE_ETH });
      const receipt = await tx.wait();
      const event = receipt.events.find(e => e.event === "PoidhFactory__BountyCreated");
      const bounty = await ethers.getContractAt("Poidh", event.args.bountyAddress);

      // Bounty should work normally
      expect(await bounty.issuer()).to.equal(issuer.address);
      expect(await bounty.totalStaked()).to.equal(ONE_ETH);
    });

    it("should use new treasury for new bounties", async function () {
      const newTreasury = contributor1;
      await factory.connect(treasury).setTreasury(newTreasury.address);

      // Create bounty with new treasury
      const tx = await factory.connect(issuer).createBounty("ipfs://new", false, { value: ONE_ETH });
      const receipt = await tx.wait();
      const event = receipt.events.find(e => e.event === "PoidhFactory__BountyCreated");
      const bounty = await ethers.getContractAt("Poidh", event.args.bountyAddress);

      expect(await bounty.treasury()).to.equal(newTreasury.address);

      // Complete bounty and verify new treasury receives fees
      await bounty.connect(worker).submitClaim("Work", "ipfs://proof");
      await bounty.connect(issuer).startVote(0);
      await time.increase(TWO_DAYS + 1);

      const treasuryBalBefore = await newTreasury.getBalance();
      await bounty.resolveVote();
      const treasuryBalAfter = await newTreasury.getBalance();

      const expectedFee = ONE_ETH.mul(25).div(1000);
      expect(treasuryBalAfter.sub(treasuryBalBefore)).to.equal(expectedFee);
    });

    it("should allow owner to transfer ownership", async function () {
      await factory.connect(treasury).transferOwnership(issuer.address);
      expect(await factory.owner()).to.equal(issuer.address);

      // New owner can now set implementation
      const PoidhContract = await ethers.getContractFactory("Poidh");
      const newImpl = await PoidhContract.deploy();
      await factory.connect(issuer).setImplementation(newImpl.address);
    });

    it("should allow owner to renounce ownership", async function () {
      await factory.connect(treasury).renounceOwnership();
      expect(await factory.owner()).to.equal(ethers.constants.AddressZero);

      // No one can set implementation anymore
      const PoidhContract = await ethers.getContractFactory("Poidh");
      const newImpl = await PoidhContract.deploy();
      await expect(
        factory.connect(treasury).setImplementation(newImpl.address)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });
  });
});
