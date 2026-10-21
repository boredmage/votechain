/**
 * Shared helpers for the Hardhat scripts and Mocha tests (ethers v6).
 */
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("hardhat");

const TEST_MNEMONIC = "test test test test test test test test test test test junk";
const DEPLOYMENTS_DIR = path.join(__dirname, "..", "deployments");

const Level = { PollingUnit: 0, Ward: 1, LGA: 2, State: 3 };
const Phase = { Registration: 0, Active: 1, Collation: 2, Declared: 3 };
const ResultStatus = {
  Open: 0,
  PendingSignatures: 1,
  Frozen: 2,
  Resolved: 3,
  Escalated: 4,
  Approved: 5,
  Declared: 6,
};
const Rule = {
  None: 0,
  CastExceedsAccredited: 1,
  CastExceedsRegistered: 2,
  ValidPlusRejectedMismatch: 3,
  CandidateSumMismatch: 4,
  AccreditedExceedsRegistered: 5,
  CollationMismatch: 6,
  RegisterMismatch: 7,
};
const STATE_UNIT_ID = 1n;
const DEMO_CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

/** Deploys the five modules and wires them. */
async function deploySystem(admin) {
  const EM = await ethers.getContractFactory("ElectionManager");
  const election = await EM.deploy(admin.address);
  await election.waitForDeployment();

  const PAV = await ethers.getContractFactory("PartyAgentVerification");
  const verification = await PAV.deploy(await election.getAddress());
  await verification.waitForDeployment();

  const RU = await ethers.getContractFactory("ResultUpload");
  const upload = await RU.deploy(await election.getAddress(), await verification.getAddress());
  await upload.waitForDeployment();

  const CE = await ethers.getContractFactory("CollationEngine");
  const collation = await CE.deploy(
    await election.getAddress(),
    await verification.getAddress(),
    await upload.getAddress(),
  );
  await collation.waitForDeployment();

  const AD = await ethers.getContractFactory("AuditDeclaration");
  const audit = await AD.deploy(
    await election.getAddress(),
    await verification.getAddress(),
    await collation.getAddress(),
  );
  await audit.waitForDeployment();

  await (
    await election
      .connect(admin)
      .setModules(
        await upload.getAddress(),
        await verification.getAddress(),
        await collation.getAddress(),
        await audit.getAddress(),
      )
  ).wait();

  return { election, upload, verification, collation, audit };
}

function figures(reg, acc, cast, valid, rej, candidateVotes) {
  return {
    registeredVoters: BigInt(reg),
    accreditedVoters: BigInt(acc),
    totalVotesCast: BigInt(cast),
    validVotes: BigInt(valid),
    rejectedVotes: BigInt(rej),
    candidateVotes: candidateVotes.map(BigInt),
  };
}

/** Same hash as VoteChainTypes.figuresHash(level, unitId, figures, formCid). */
function figuresHash(level, unitId, f, formCid) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return ethers.keccak256(
    coder.encode(
      ["uint8", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256[]", "string"],
      [
        level,
        unitId,
        f.registeredVoters,
        f.accreditedVoters,
        f.totalVotesCast,
        f.validVotes,
        f.rejectedVotes,
        f.candidateVotes,
        formCid,
      ],
    ),
  );
}

/** Converts the tuple returned by a view into a plain figures object. */
function toFigures(tuple) {
  return {
    registeredVoters: BigInt(tuple.registeredVoters ?? tuple[0]),
    accreditedVoters: BigInt(tuple.accreditedVoters ?? tuple[1]),
    totalVotesCast: BigInt(tuple.totalVotesCast ?? tuple[2]),
    validVotes: BigInt(tuple.validVotes ?? tuple[3]),
    rejectedVotes: BigInt(tuple.rejectedVotes ?? tuple[4]),
    candidateVotes: Array.from(tuple.candidateVotes ?? tuple[5]).map(BigInt),
  };
}

/** Deterministic, internally consistent polling-unit figures (3 candidates). */
function demoFigures(puId, registered = 1000) {
  const id = Number(puId);
  const a = 180 + ((id * 37) % 90);
  const b = 150 + ((id * 53) % 80);
  const c = 40 + ((id * 19) % 50);
  const valid = a + b + c;
  const rej = 3 + (id % 5);
  const cast = valid + rej;
  const acc = cast + 12 + (id % 7);
  return figures(registered, acc, cast, valid, rej, [a, b, c]);
}

function writeDeployment(networkName, chainId, contracts, deployBlock) {
  fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  const file = path.join(DEPLOYMENTS_DIR, `${networkName}.json`);
  const json = {
    chainId: Number(chainId),
    network: networkName,
    deployBlock,
    deployedAt: Math.floor(Date.now() / 1000),
    contracts,
  };
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
  return file;
}

function readDeployment(networkName) {
  const file = path.join(DEPLOYMENTS_DIR, `${networkName}.json`);
  if (!fs.existsSync(file)) throw new Error(`No deployment file ${file}. Run the deploy script first.`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function attachSystem(networkName) {
  const d = readDeployment(networkName);
  const c = d.contracts;
  return {
    deployment: d,
    election: await ethers.getContractAt("ElectionManager", c.ElectionManager),
    upload: await ethers.getContractAt("ResultUpload", c.ResultUpload),
    verification: await ethers.getContractAt("PartyAgentVerification", c.PartyAgentVerification),
    collation: await ethers.getContractAt("CollationEngine", c.CollationEngine),
    audit: await ethers.getContractAt("AuditDeclaration", c.AuditDeclaration),
  };
}

/** Wallet for mnemonic index i (matches Hardhat/Anvil account ordering). */
function walletAt(index, provider) {
  const w = ethers.HDNodeWallet.fromPhrase(TEST_MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`);
  return provider ? w.connect(provider) : w;
}

/** Auditor's EIP-191 signature over the audit digest. */
async function signAudit(auditorSigner, audit) {
  const digest = await audit.auditDigest();
  return auditorSigner.signMessage(ethers.getBytes(digest));
}

module.exports = {
  TEST_MNEMONIC,
  DEMO_CID,
  STATE_UNIT_ID,
  Level,
  Phase,
  ResultStatus,
  Rule,
  deploySystem,
  attachSystem,
  figures,
  figuresHash,
  toFigures,
  demoFigures,
  writeDeployment,
  readDeployment,
  walletAt,
  signAudit,
};
