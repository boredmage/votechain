/**
 * Verifies the deployed contracts on Etherscan (Sepolia) using deployments/sepolia.json.
 *
 *   ETHERSCAN_API_KEY=... npx hardhat run hardhat/verify.js --network sepolia
 */
const hre = require("hardhat");
const { readDeployment } = require("./lib");

async function main() {
  const d = readDeployment(hre.network.name);
  const c = d.contracts;
  const [deployer] = await hre.ethers.getSigners();
  const admin = process.env.INEC_ADMIN || deployer.address;

  const targets = [
    ["ElectionManager", c.ElectionManager, [admin]],
    ["PartyAgentVerification", c.PartyAgentVerification, [c.ElectionManager]],
    ["ResultUpload", c.ResultUpload, [c.ElectionManager, c.PartyAgentVerification]],
    ["CollationEngine", c.CollationEngine, [c.ElectionManager, c.PartyAgentVerification, c.ResultUpload]],
    ["AuditDeclaration", c.AuditDeclaration, [c.ElectionManager, c.PartyAgentVerification, c.CollationEngine]],
  ];
  for (const [name, address, constructorArguments] of targets) {
    console.log(`verifying ${name} at ${address}`);
    try {
      await hre.run("verify:verify", { address, constructorArguments });
    } catch (err) {
      console.warn(`  ${name}: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
