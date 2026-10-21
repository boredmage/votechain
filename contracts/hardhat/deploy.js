/**
 * Deploys the five VoteChain modules with the first configured signer as INEC admin and writes
 * deployments/<network>.json (same format as the Foundry Deploy.s.sol script).
 *
 *   npx hardhat run hardhat/deploy.js --network localhost
 *   npx hardhat run hardhat/deploy.js --network sepolia      (PRIVATE_KEY + SEPOLIA_RPC_URL in .env)
 */
const hre = require("hardhat");
const { ethers, network } = hre;
const { deploySystem, writeDeployment } = require("./lib");

async function main() {
  const [deployer] = await ethers.getSigners();
  const adminAddress = process.env.INEC_ADMIN || deployer.address;
  if (adminAddress.toLowerCase() !== deployer.address.toLowerCase()) {
    console.warn("INEC_ADMIN differs from the deployer; setModules must then be called by the admin. Using deployer.");
  }
  console.log(`Deploying VoteChain to ${network.name} from ${deployer.address}`);
  const startBlock = await ethers.provider.getBlockNumber();
  const { election, upload, verification, collation, audit } = await deploySystem(deployer);

  const contracts = {
    ElectionManager: await election.getAddress(),
    PartyAgentVerification: await verification.getAddress(),
    ResultUpload: await upload.getAddress(),
    CollationEngine: await collation.getAddress(),
    AuditDeclaration: await audit.getAddress(),
  };
  for (const [name, addr] of Object.entries(contracts)) console.log(`  ${name.padEnd(24)} ${addr}`);

  const { chainId } = await ethers.provider.getNetwork();
  const file = writeDeployment(network.name, chainId, contracts, startBlock);
  console.log(`wrote ${file}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
