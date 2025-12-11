const { ethers } = require("hardhat");
const hre = require("hardhat");

// Constants
const sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay));
const convert = (amount, decimals) => ethers.utils.parseUnits(amount, decimals);
const divDec = (amount, decimals = 18) => amount / 10 ** decimals;
const ADDRESS_ZERO = "0x0000000000000000000000000000000000000000";

// =============================================================================
// CONFIGURATION - UPDATE THESE FOR YOUR DEPLOYMENT
// =============================================================================

// Treasury address - receives 2.5% fee on bounty payouts
const TREASURY_ADDRESS = "0x7a8C895E7826F66e1094532cB435Da725dc3868f"; // TODO: Set your treasury address

// Deployed Contract Addresses (paste after deployment)
const POIDH = "0xEDcdb8Da975aD6fb1eeE821914C078b98F85b88D";
const POIDH_FACTORY = "0xe55E41a8803273Eed41661164857D28F968acDEc";

// Contract Variables
let poidhFactory;
let poidh;

async function getContracts() {
  if (POIDH_FACTORY) {
    poidhFactory = await ethers.getContractAt(
      "contracts/PoidhFactory.sol:PoidhFactory",
      POIDH_FACTORY
    );
    if (POIDH) {
      poidh = await ethers.getContractAt("contracts/Poidh.sol:Poidh", POIDH);
    }
  }

  console.log("Contracts Retrieved");
}

// =============================================================================
// DEPLOY FUNCTIONS
// =============================================================================

async function deployPoidhFactory() {
  console.log("Starting PoidhFactory Deployment");

  if (!TREASURY_ADDRESS) {
    throw new Error("TREASURY_ADDRESS must be set before deployment");
  }

  const poidhFactoryArtifact = await ethers.getContractFactory("PoidhFactory");
  const poidhFactoryContract = await poidhFactoryArtifact.deploy(
    TREASURY_ADDRESS,
    { gasPrice: ethers.gasPrice }
  );
  poidhFactory = await poidhFactoryContract.deployed();
  await sleep(5000);

  // Get the poidh implementation address
  const poidhAddress = await poidhFactory.implementation();
  poidh = await ethers.getContractAt("contracts/Poidh.sol:Poidh", poidhAddress);

  console.log("PoidhFactory Deployed at:", poidhFactory.address);
  console.log("Poidh Implementation at:", poidhAddress);
}

async function verifyPoidhFactory() {
  console.log("Starting PoidhFactory Verification");
  await hre.run("verify:verify", {
    address: poidhFactory.address,
    contract: "contracts/PoidhFactory.sol:PoidhFactory",
    constructorArguments: [TREASURY_ADDRESS],
  });
  console.log("PoidhFactory Verified");
}

async function verifyImplementation() {
  console.log("Starting Poidh Implementation Verification");
  const implAddress = await poidhFactory.implementation();
  await hre.run("verify:verify", {
    address: implAddress,
    contract: "contracts/Poidh.sol:Poidh",
    constructorArguments: [],
  });
  console.log("Poidh Implementation Verified");
}

// =============================================================================
// CONFIGURATION FUNCTIONS
// =============================================================================

async function setTreasury(newTreasury) {
  console.log("Setting Treasury to:", newTreasury);
  const tx = await poidhFactory.setTreasury(newTreasury);
  await tx.wait();
  console.log("Treasury updated to:", await poidhFactory.treasury());
}

async function setImplementation(newImplementation) {
  console.log("Setting Implementation to:", newImplementation);
  const tx = await poidhFactory.setImplementation(newImplementation);
  await tx.wait();
  console.log(
    "Implementation updated to:",
    await poidhFactory.implementation()
  );
}

async function transferOwnership(newOwner) {
  console.log("Transferring ownership to:", newOwner);
  const tx = await poidhFactory.transferOwnership(newOwner);
  await tx.wait();
  console.log("Ownership transferred to:", await poidhFactory.owner());
}

async function renounceOwnership() {
  console.log("Renouncing ownership...");
  const tx = await poidhFactory.renounceOwnership();
  await tx.wait();
  console.log("Ownership renounced. New owner:", await poidhFactory.owner());
}

// =============================================================================
// BOUNTY FUNCTIONS (for testing)
// =============================================================================

async function createBounty(metadataURI, joinable, valueInEth) {
  console.log("Creating Bounty...");
  console.log("  Metadata:", metadataURI);
  console.log("  Joinable:", joinable);
  console.log("  Value:", valueInEth, "ETH");

  const value = ethers.utils.parseEther(valueInEth);
  const tx = await poidhFactory.createBounty(metadataURI, joinable, { value });
  const receipt = await tx.wait();

  const event = receipt.events?.find(
    (e) => e.event === "PoidhFactory__BountyCreated"
  );
  const bountyAddress = event?.args?.bountyAddress;

  console.log("Bounty Created at:", bountyAddress);
  return bountyAddress;
}

// =============================================================================
// PRINT FUNCTIONS
// =============================================================================

async function printDeployment() {
  console.log("\n==================== POIDH DEPLOYMENT ====================\n");

  console.log("--- Configuration ---");
  console.log("Treasury:         ", TREASURY_ADDRESS || "NOT SET");

  console.log("\n--- Deployed Contracts ---");
  if (poidhFactory) {
    console.log("PoidhFactory:     ", poidhFactory.address);
    console.log("Implementation:   ", await poidhFactory.implementation());
    console.log("Treasury:         ", await poidhFactory.treasury());
    console.log("Owner:            ", await poidhFactory.owner());
    console.log(
      "Bounties Count:   ",
      (await poidhFactory.getBountiesCount()).toString()
    );
  } else {
    console.log("PoidhFactory:     ", POIDH_FACTORY || "NOT DEPLOYED");
  }

  console.log("\n--- Contract Settings ---");
  if (poidh) {
    console.log(
      "Treasury Fee:     ",
      (await poidh.TREASURY_FEE()).toString(),
      "/ 1000 (2.5%)"
    );
    console.log(
      "Voting Period:    ",
      (await poidh.VOTING_PERIOD()).toString(),
      "seconds (2 days)"
    );
  }

  console.log(
    "\n===========================================================\n"
  );
}

async function printFactoryState() {
  console.log("\n--- Factory State ---");
  console.log("Implementation:   ", await poidhFactory.implementation());
  console.log("Treasury:         ", await poidhFactory.treasury());
  console.log("Owner:            ", await poidhFactory.owner());
  console.log(
    "Bounties Count:   ",
    (await poidhFactory.getBountiesCount()).toString()
  );

  const count = await poidhFactory.getBountiesCount();
  if (count.gt(0)) {
    console.log("\n--- Recent Bounties ---");
    const limit = Math.min(count.toNumber(), 5);
    const bounties = await poidhFactory.getBounties(limit, 0);
    for (let i = 0; i < bounties.length; i++) {
      console.log(`  [${i}]:`, bounties[i]);
    }
  }
  console.log("");
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  const [wallet] = await ethers.getSigners();
  console.log("Using wallet:", wallet.address);
  console.log(
    "Account balance:",
    ethers.utils.formatEther(await wallet.getBalance()),
    "ETH"
  );
  console.log("");

  await getContracts();

  //===================================================================
  // 1. Deploy PoidhFactory (includes Poidh implementation)
  //===================================================================

  console.log("Starting Deployment...");
  // await deployPoidhFactory();
  await printDeployment();

  //===================================================================
  // 2. Verify Contracts on Etherscan/Basescan
  //===================================================================

  // console.log("Starting Verification...");
  // await verifyPoidhFactory();
  // await verifyImplementation();
  // console.log("Verification Complete");

  //===================================================================
  // 3. Configuration (optional)
  //===================================================================

  // Update treasury address (only owner)
  // await setTreasury("0xNEW_TREASURY_ADDRESS");

  // Deploy and set new implementation (only owner)
  // const NewPoidh = await ethers.getContractFactory("Poidh");
  // const newImpl = await NewPoidh.deploy();
  // await newImpl.deployed();
  // await setImplementation(newImpl.address);

  //===================================================================
  // 4. Transfer Ownership (optional)
  //===================================================================

  // Transfer to multisig or DAO
  // await transferOwnership("0xMULTISIG_ADDRESS");

  // Or renounce ownership (irreversible!)
  // await renounceOwnership();

  //===================================================================
  // 5. Test Bounty Creation (optional)
  //===================================================================

  // Create a test bounty
  // await createBounty("ipfs://QmTestMetadata", true, "0.01");

  //===================================================================
  // Print Current State
  //===================================================================

  // await printDeployment();
  // await printFactoryState();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
