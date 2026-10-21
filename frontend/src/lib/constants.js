export const LEVELS = ["PollingUnit", "Ward", "LGA", "State"];
export const LEVEL_LABEL = { PollingUnit: "Polling Unit", Ward: "Ward", LGA: "LGA", State: "State" };
export const LEVEL_INDEX = { PollingUnit: 0, Ward: 1, LGA: 2, State: 3 };
export const FORMS = ["EC8A", "EC8B", "EC8C", "EC8D"];
export const PHASES = ["Registration", "Active", "Collation", "Declared"];
export const STATUSES = ["Open", "PendingSignatures", "Frozen", "Resolved", "Escalated", "Approved", "Declared"];
export const STATUS_LABEL = {
  Open: "Awaiting figures",
  PendingSignatures: "Pending signatures",
  Frozen: "Frozen (dispute)",
  Resolved: "Resolved – awaiting agent",
  Escalated: "Escalated to auditor",
  Approved: "Approved",
  Declared: "Declared",
};
export const CATEGORY_LABEL = {
  None: "Public observer",
  InecAdmin: "INEC Administrator",
  PresidingOfficer: "Presiding Officer",
  PartyAgent: "Party Agent",
  WardCollationOfficer: "Ward Collation Officer",
  LgaCollationOfficer: "LGA Collation Officer",
  StateReturningOfficer: "State Returning Officer",
  Auditor: "Independent State Auditor",
  ResultPublisher: "State Result Publisher",
};
export const RULES = [
  "None",
  "CastExceedsAccredited",
  "CastExceedsRegistered",
  "ValidPlusRejectedMismatch",
  "CandidateSumMismatch",
  "AccreditedExceedsRegistered",
  "CollationMismatch",
  "RegisterMismatch",
];
export const RULE_TEXT = {
  CastExceedsAccredited: "Total votes cast must not exceed accredited voters",
  CastExceedsRegistered: "Total votes cast must not exceed registered voters",
  ValidPlusRejectedMismatch: "Valid votes + rejected votes must equal total votes cast",
  CandidateSumMismatch: "Sum of candidate votes must equal valid votes",
  AccreditedExceedsRegistered: "Accredited voters must not exceed registered voters",
  CollationMismatch: "Collated total must equal the sum of the approved lower-level results",
  RegisterMismatch: "Registered voters must match INEC's polling-unit register",
};
export const FIELDS = ["RegisteredVoters", "AccreditedVoters", "TotalVotesCast", "ValidVotes", "RejectedVotes", "CandidateVotes"];
export const FIELD_LABEL = {
  RegisteredVoters: "Registered voters",
  AccreditedVoters: "Accredited voters",
  TotalVotesCast: "Total votes cast",
  ValidVotes: "Valid votes",
  RejectedVotes: "Rejected votes",
  CandidateVotes: "Candidate votes",
};
export const STATE_UNIT_ID = 1;
export const DEMO_CID_PLACEHOLDER = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
