require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });

/**
 * Hardhat configuration (Section 3.10). The Solidity sources are shared with the Foundry
 * project (src/); Foundry tests live in test/, Hardhat's Mocha + Chai tests in test-hardhat/.
 *
 *   npx hardhat compile
 *   npx hardhat test
 *   npx hardhat node                      # local chain with 70 pre-funded demo accounts
 *   npx hardhat run hardhat/deploy.js --network localhost
 *   npx hardhat run hardhat/seed-demo.js --network localhost
 *   npx hardhat run hardhat/deploy.js --network sepolia
 */
const TEST_MNEMONIC = "test test test test test test test test test test test junk";

const sepoliaAccounts = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];

module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
    },
  },
  paths: {
    sources: "./src",
    tests: "./test-hardhat",
    cache: "./cache-hardhat",
    artifacts: "./artifacts",
  },
  networks: {
    hardhat: {
      chainId: 31337,
      accounts: { mnemonic: TEST_MNEMONIC, count: 70 },
      allowUnlimitedContractSize: false,
    },
    localhost: {
      url: process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545",
      accounts: { mnemonic: TEST_MNEMONIC, count: 70 },
    },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "https://rpc.sepolia.org",
      accounts: sepoliaAccounts,
      chainId: 11155111,
    },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || "",
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
  },
  mocha: { timeout: 180000 },
};
