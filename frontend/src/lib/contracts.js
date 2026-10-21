import { ethers } from "ethers";
import ElectionManagerAbi from "../abi/ElectionManager.json";
import ResultUploadAbi from "../abi/ResultUpload.json";
import PartyAgentVerificationAbi from "../abi/PartyAgentVerification.json";
import CollationEngineAbi from "../abi/CollationEngine.json";
import AuditDeclarationAbi from "../abi/AuditDeclaration.json";

export const ABIS = {
  ElectionManager: ElectionManagerAbi,
  ResultUpload: ResultUploadAbi,
  PartyAgentVerification: PartyAgentVerificationAbi,
  CollationEngine: CollationEngineAbi,
  AuditDeclaration: AuditDeclarationAbi,
};

export const INTERFACES = Object.fromEntries(Object.entries(ABIS).map(([k, v]) => [k, new ethers.Interface(v)]));

/**
 * Builds contract instances bound to a runner (signer for writes, provider for reads).
 * `addresses` comes from the backend /api/config (i.e. contracts/deployments/<network>.json).
 */
export function buildContracts(addresses, runner) {
  return {
    election: new ethers.Contract(addresses.ElectionManager, ABIS.ElectionManager, runner),
    upload: new ethers.Contract(addresses.ResultUpload, ABIS.ResultUpload, runner),
    verification: new ethers.Contract(addresses.PartyAgentVerification, ABIS.PartyAgentVerification, runner),
    collation: new ethers.Contract(addresses.CollationEngine, ABIS.CollationEngine, runner),
    audit: new ethers.Contract(addresses.AuditDeclaration, ABIS.AuditDeclaration, runner),
  };
}

const FRIENDLY = {
  ValidationFailed: (a) => `Validation failed: rule ${a.rule} (expected ${a.expected}, got ${a.actual})`,
  NotPresidingOfficer: () => "Only the presiding officer registered for this polling unit can upload its result.",
  NotAgentForUnit: () => "Your wallet is not registered as a party agent for this unit.",
  NotOfficerForUnit: () => "Only the officer responsible for this unit can do that.",
  NotCollationOfficer: () => "Only the collation officer registered for this unit can confirm its collation.",
  NotDisputingAgent: () => "Only the agent who raised the dispute can accept or escalate its resolution.",
  NotAuditor: () => "Only the registered independent auditor can rule on escalations.",
  NotResultPublisher: () => "Only the state result publisher can declare the result.",
  NotAuditorSignature: () => "The signature was not produced by the registered auditor's wallet.",
  StaleFiguresHash: () => "The figures changed since you loaded them. Reload and review the new figures before signing.",
  AlreadySigned: () => "You have already signed this round.",
  CannotDisputeAfterSigning: () => "You cannot dispute figures you have already signed.",
  InvalidStatus: (a) => `This action is not allowed while the result is in status ${a.current}.`,
  WrongPhase: (a) => `Election phase does not allow this action (current phase ${a.current}).`,
  LowerLevelNotApproved: (a) => `Unit ${a.unitId} at the level below is not approved yet (status ${a.status}).`,
  CorrectionRequired: () => "The auditor upheld the dispute: only corrected figures can resolve it.",
  PendingEscalations: (a) => `${a.count} escalated dispute(s) must be ruled on before the audit can be signed.`,
  StateResultNotApproved: () => "The state collation has not been approved by all state party agents yet.",
  AuditNotApproved: () => "The independent auditor has not signed the audit approval yet.",
  AlreadyDeclared: () => "The result has already been declared.",
  AlreadyAudited: () => "The audit approval has already been recorded.",
  EmptyReason: () => "A written reason is required.",
  EmptyFormCid: () => "Upload the scanned form first (its IPFS CID is required).",
  PollingUnitCancelled: () => "This polling unit was cancelled by INEC.",
  AlreadyAssigned: (a) => `Address already holds a stakeholder role (category ${a.existing}).`,
  AlreadyTaken: () => "That role slot is already filled for this unit.",
  NotReadyToActivate: (a) => `Cannot activate: ${a.reason} incomplete.`,
  AccessControlUnauthorizedAccount: () => "Your wallet does not have the INEC admin role.",
  NotOperational: (a) => `Signing and disputes are closed in phase ${a.phase}.`,
  UseRegistrationFunctions: () => "Roles are only granted through the registration functions.",
  PollingUnitHasResult: () => "This polling unit already has uploaded figures, so it can no longer be cancelled.",
  AlreadyCancelled: () => "This polling unit has already been cancelled.",
  ArrayLengthMismatch: () => "Each polling unit needs a code, a name and a registered-voter figure.",
  DuplicateCandidate: () => "This party already has a candidate.",
  InvalidDisputeStatus: () => "The dispute is not in a state that allows this action.",
  InvalidTimeWindow: () => "The election end time must be after the start time.",
  NoActiveDispute: () => "There is no open dispute on this unit.",
  NotAssigned: () => "That wallet holds no stakeholder role.",
  NotAuthorised: () => "Your wallet is not authorised to do this.",
  StateResultChanged: () => "The state result changed after the auditor signed; the audit must be signed again.",
  UnknownDispute: () => "That dispute does not exist.",
  UnknownParty: () => "That party does not exist.",
  UnknownUnit: () => "That unit does not exist.",
  WrongDispute: () => "That dispute belongs to a different unit or round.",
  ZeroAddress: () => "Enter a wallet address (the zero address is not allowed).",
};

/** Turns an ethers error (custom error revert, user rejection, RPC failure) into a readable message. */
export function decodeError(err) {
  const data = err?.data ?? err?.info?.error?.data ?? err?.error?.data;
  if (err?.code === "ACTION_REJECTED" || err?.code === 4001) return "Transaction rejected in the wallet.";
  if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
    for (const [name, iface] of Object.entries(INTERFACES)) {
      try {
        const parsed = iface.parseError(data);
        if (parsed) {
          const args = {};
          parsed.fragment.inputs.forEach((inp, i) => (args[inp.name] = typeof parsed.args[i] === "bigint" ? parsed.args[i].toString() : parsed.args[i]));
          const friendly = FRIENDLY[parsed.name];
          const detail = `${parsed.name}(${Object.values(args).join(", ")})`;
          return friendly ? `${friendly(args)} [${detail}]` : `${name}.${detail}`;
        }
      } catch {
        /* try next interface */
      }
    }
  }
  if (err?.reason) return err.reason;
  if (err?.shortMessage) return err.shortMessage;
  return err?.message ?? String(err);
}
