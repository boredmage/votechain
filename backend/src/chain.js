/**
 * Read-only access to the deployed VoteChain contracts (the blockchain is the authoritative record;
 * PostgreSQL is only a display cache). The backend never holds a private key and never sends
 * transactions – every state change is signed by the stakeholder's own wallet in the portal.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ethers } from "ethers";
import { config, loadDeployment } from "./config.js";

export const LEVELS = ["PollingUnit", "Ward", "LGA", "State"];
export const LEVEL_LABEL = { PollingUnit: "Polling Unit", Ward: "Ward", LGA: "LGA", State: "State" };
export const FORMS = ["EC8A", "EC8B", "EC8C", "EC8D"];
export const PHASES = ["Registration", "Active", "Collation", "Declared"];
export const STATUSES = ["Open", "PendingSignatures", "Frozen", "Resolved", "Escalated", "Approved", "Declared"];
export const DISPUTE_STATUSES = ["Raised", "Resolved", "Accepted", "Escalated", "RuledDismissed", "RuledUpheld"];
export const RESOLUTION_TYPES = ["None", "ConfirmedOriginal", "FiguresCorrected"];
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
export const FIELDS = ["RegisteredVoters", "AccreditedVoters", "TotalVotesCast", "ValidVotes", "RejectedVotes", "CandidateVotes"];
export const CATEGORIES = [
  "None",
  "InecAdmin",
  "PresidingOfficer",
  "PartyAgent",
  "WardCollationOfficer",
  "LgaCollationOfficer",
  "StateReturningOfficer",
  "Auditor",
  "ResultPublisher",
];
export const STATE_UNIT_ID = 1;

export function levelIndex(level) {
  if (typeof level === "number") return level;
  const n = Number(level);
  if (!Number.isNaN(n)) return n;
  const idx = LEVELS.findIndex((l) => l.toLowerCase() === String(level).toLowerCase() || (level === "pu" && l === "PollingUnit"));
  if (idx === -1) throw Object.assign(new Error(`unknown level '${level}'`), { status: 400 });
  return idx;
}

export function loadAbis() {
  const names = ["ElectionManager", "ResultUpload", "PartyAgentVerification", "CollationEngine", "AuditDeclaration"];
  const abis = {};
  for (const n of names) abis[n] = JSON.parse(readFileSync(join(config.abiDir, `${n}.json`), "utf8"));
  return abis;
}

let cached = null;

export function getChain() {
  if (cached) return cached;
  const deployment = loadDeployment();
  const abis = loadAbis();
  const provider = new ethers.JsonRpcProvider(config.rpcUrl, undefined, { staticNetwork: true });
  const c = deployment.contracts;
  const contracts = {
    election: new ethers.Contract(c.ElectionManager, abis.ElectionManager, provider),
    upload: new ethers.Contract(c.ResultUpload, abis.ResultUpload, provider),
    verification: new ethers.Contract(c.PartyAgentVerification, abis.PartyAgentVerification, provider),
    collation: new ethers.Contract(c.CollationEngine, abis.CollationEngine, provider),
    audit: new ethers.Contract(c.AuditDeclaration, abis.AuditDeclaration, provider),
  };
  const interfaces = Object.fromEntries(Object.entries(abis).map(([k, v]) => [k, new ethers.Interface(v)]));
  cached = { deployment, abis, provider, contracts, interfaces, addresses: c };
  return cached;
}

// ---------------------------------------------------------------------------
// Serialisation helpers (BigInt -> string/number for JSON)
// ---------------------------------------------------------------------------
export function num(v) {
  return typeof v === "bigint" ? Number(v) : v;
}

export function figuresToJson(f) {
  return {
    registeredVoters: num(f.registeredVoters),
    accreditedVoters: num(f.accreditedVoters),
    totalVotesCast: num(f.totalVotesCast),
    validVotes: num(f.validVotes),
    rejectedVotes: num(f.rejectedVotes),
    candidateVotes: Array.from(f.candidateVotes).map(num),
  };
}

export function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
}

// ---------------------------------------------------------------------------
// Composite reads used by the API
// ---------------------------------------------------------------------------
export async function readElectionSummary() {
  const { contracts, deployment } = getChain();
  const { election, audit, verification } = contracts;
  const [info, lgaCount, wardCount, puCount, partyCount, candidates, declared, auditRecord, pending] = await Promise.all([
    election.getElectionInfo(),
    election.lgaCount(),
    election.wardCount(),
    election.pollingUnitCount(),
    election.partyCount(),
    election.getCandidates(),
    audit.isDeclared(),
    audit.getAudit(),
    verification.pendingEscalations(),
  ]);
  const parties = [];
  for (let i = 1; i <= num(partyCount); i++) {
    const p = await election.getParty(i);
    parties.push({ id: i, name: p.name, acronym: p.acronym, hasCandidate: p.hasCandidate, candidateIndex: num(p.candidateIndex) });
  }
  return {
    chainId: deployment.chainId,
    network: deployment.network,
    contracts: deployment.contracts,
    name: info.name,
    electionType: info.electionType,
    stateName: info.stateName,
    startTime: num(info.startTime),
    endTime: num(info.endTime),
    phase: PHASES[num(info.phase)],
    phaseIndex: num(info.phase),
    createdAt: num(info.createdAt),
    counts: { lgas: num(lgaCount), wards: num(wardCount), pollingUnits: num(puCount), parties: num(partyCount), candidates: candidates.length },
    parties,
    candidates: Array.from(candidates).map((c) => ({ index: num(c.index), partyId: num(c.partyId), name: c.name })),
    stateStatus: STATUSES[num(await verification.statusOf(3, STATE_UNIT_ID))],
    auditApproved: auditRecord.approved,
    declared,
    pendingEscalations: num(pending),
  };
}

export async function readGeography() {
  const { contracts } = getChain();
  const { election, verification } = contracts;
  const lgaCount = num(await election.lgaCount());
  const lgas = [];
  for (let l = 1; l <= lgaCount; l++) {
    const lga = await election.getLga(l);
    const wards = [];
    for (const wIdRaw of lga.wardIds) {
      const wId = num(wIdRaw);
      const ward = await election.getWard(wId);
      const pus = [];
      for (const puIdRaw of ward.pollingUnitIds) {
        const puId = num(puIdRaw);
        const pu = await election.getPollingUnit(puId);
        pus.push({
          id: puId,
          code: pu.code,
          name: pu.name,
          registeredVoters: num(pu.registeredVoters),
          cancelled: pu.cancelled,
          status: STATUSES[num(await verification.statusOf(0, puId))],
        });
      }
      wards.push({ id: wId, name: ward.name, lgaId: l, status: STATUSES[num(await verification.statusOf(1, wId))], pollingUnits: pus });
    }
    lgas.push({ id: l, name: lga.name, status: STATUSES[num(await verification.statusOf(2, l))], wards });
  }
  return { lgas, stateStatus: STATUSES[num(await verification.statusOf(3, STATE_UNIT_ID))] };
}

export async function readUnit(level, unitId) {
  const { contracts } = getChain();
  const { election, upload, verification, collation } = contracts;
  const lvl = levelIndex(level);
  const id = Number(unitId);
  if (!(await election.unitExists(lvl, id))) throw Object.assign(new Error(`unknown ${LEVELS[lvl]} ${id}`), { status: 404 });

  const [record, agents, progress, disputeIds] = await Promise.all([
    verification.getRecord(lvl, id),
    election.agentsOf(lvl, id),
    verification.signingProgress(lvl, id),
    verification.disputeIdsOf(lvl, id),
  ]);
  const round = num(record.round);
  const signatures = [];
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    const s = await verification.getSignature(lvl, id, round, a);
    const st = await election.stakeholderOf(a);
    signatures.push({
      agent: a,
      partyId: num(st.partyId),
      signed: progress.signed[i],
      objection: progress.objections[i],
      waived: progress.waived[i],
      objectionReason: s.objectionReason,
      timestamp: num(s.timestamp),
      blockNumber: num(s.blockNumber),
    });
  }
  const disputes = [];
  for (const d of disputeIds) disputes.push(await readDispute(num(d)));

  let meta = null;
  let figures = null;
  let formCid = null;
  if (lvl === 0) {
    const pu = await election.getPollingUnit(id);
    const r = await upload.getResult(id);
    meta = { code: pu.code, name: pu.name, wardId: num(pu.wardId), registeredVoters: num(pu.registeredVoters), cancelled: pu.cancelled, cancellationCid: pu.cancellationCid, presidingOfficer: await election.presidingOfficerOf(id) };
    if (r.exists) {
      figures = figuresToJson(r.figures);
      formCid = r.formCid;
      meta.submission = { round: num(r.round), officer: r.officer, submittedAt: num(r.submittedAt), blockNumber: num(r.blockNumber), figuresHash: r.figuresHash };
    }
  } else {
    const rec = await collation.getCollation(lvl, id);
    if (lvl === 1) {
      const w = await election.getWard(id);
      meta = { name: w.name, lgaId: num(w.lgaId), pollingUnitIds: Array.from(w.pollingUnitIds).map(num), officer: await election.wardOfficerOf(id) };
    } else if (lvl === 2) {
      const l = await election.getLga(id);
      meta = { name: l.name, wardIds: Array.from(l.wardIds).map(num), officer: await election.lgaOfficerOf(id) };
    } else {
      meta = { name: "State", officer: await election.stateReturningOfficer() };
    }
    let aggregate = null;
    try {
      const [agg, complete, blocking] = await collation.computeAggregate(lvl, id);
      aggregate = { figures: figuresToJson(agg), complete, blockingUnitId: num(blocking) };
    } catch {
      aggregate = null;
    }
    meta.aggregate = aggregate;
    meta.mismatchAttempts = num(rec.mismatchAttempts);
    if (rec.exists) {
      figures = figuresToJson(rec.figures);
      formCid = rec.formCid;
      meta.collation = { round: num(rec.round), officer: rec.officer, confirmedAt: num(rec.confirmedAt), blockNumber: num(rec.blockNumber), figuresHash: rec.figuresHash };
      const [consistent] = await collation.verifyConsistency(lvl, id);
      meta.consistent = consistent;
    }
  }

  return {
    level: LEVELS[lvl],
    levelIndex: lvl,
    form: FORMS[lvl],
    unitId: id,
    status: STATUSES[num(record.status)],
    round,
    figuresHash: record.figuresHash,
    signatureCount: num(record.signatureCount),
    requiredSignatures: agents.length,
    activeDisputeId: num(record.activeDisputeId),
    openedAt: num(record.openedAt),
    approvedAt: num(record.approvedAt),
    figures,
    formCid,
    signatures,
    disputes,
    ...meta,
  };
}

export async function readDispute(id) {
  const { contracts } = getChain();
  const d = await contracts.verification.getDispute(id);
  return {
    id: num(d.id),
    level: LEVELS[num(d.level)],
    levelIndex: num(d.level),
    unitId: num(d.unitId),
    round: num(d.round),
    agent: d.agent,
    partyId: num(d.partyId),
    disputedFiguresHash: d.disputedFiguresHash,
    reason: d.reason,
    evidenceCid: d.evidenceCid,
    raisedAt: num(d.raisedAt),
    status: DISPUTE_STATUSES[num(d.status)],
    requiresCorrection: d.requiresCorrection,
    resolution: {
      kind: RESOLUTION_TYPES[num(d.resolution.kind)],
      resolvedBy: d.resolution.resolvedBy,
      documentCid: d.resolution.documentCid,
      note: d.resolution.note,
      resolvedAt: num(d.resolution.resolvedAt),
      acceptedAt: num(d.resolution.acceptedAt),
      escalatedAt: num(d.resolution.escalatedAt),
    },
    ruling: { upheld: d.ruling.upheld, documentCid: d.ruling.documentCid, ruledAt: num(d.ruling.ruledAt) },
  };
}

export async function readStakeholder(address) {
  const { contracts } = getChain();
  const s = await contracts.election.stakeholderOf(address);
  return { address, category: CATEGORIES[num(s.category)], level: LEVELS[num(s.level)], levelIndex: num(s.level), unitId: num(s.unitId), partyId: num(s.partyId) };
}

export async function readAuditAndDeclaration() {
  const { contracts } = getChain();
  const { audit } = contracts;
  const [a, d, ready, escalated] = await Promise.all([audit.getAudit(), audit.getDeclaration(), audit.isReadyForAudit(), audit.escalatedDisputes()]);
  return {
    ready: ready[0],
    readyReason: ready[1],
    escalatedDisputeIds: Array.from(escalated).map(num),
    audit: { approved: a.approved, auditor: a.auditor, stateResultHash: a.stateResultHash, signature: a.signature, reportCid: a.reportCid, approvedAt: num(a.approvedAt), blockNumber: num(a.blockNumber) },
    declaration: d.declared
      ? { declared: true, publisher: d.publisher, declaredAt: num(d.declaredAt), blockNumber: num(d.blockNumber), stateResultHash: d.stateResultHash, winnerCandidateIndex: num(d.winnerCandidateIndex), winnerPartyId: num(d.winnerPartyId), winnerVotes: num(d.winnerVotes), tie: d.tie, figures: figuresToJson(d.figures) }
      : { declared: false },
  };
}

/** Full trace from the state result down to every polling unit (auditor & public verifier). */
export async function readChainTrace() {
  const { contracts } = getChain();
  const { collation } = contracts;
  const geo = await readGeography();
  const state = await readUnit(3, STATE_UNIT_ID);
  const lgas = [];
  for (const lga of geo.lgas) {
    const lgaUnit = await readUnit(2, lga.id);
    const wards = [];
    for (const ward of lga.wards) {
      const wardUnit = await readUnit(1, ward.id);
      const pus = [];
      for (const pu of ward.pollingUnits) pus.push(await readUnit(0, pu.id));
      wards.push({ ...wardUnit, pollingUnits: pus });
    }
    lgas.push({ ...lgaUnit, wards });
  }
  const consistency = { wards: {}, lgas: {}, state: null };
  for (const lga of lgas) {
    for (const w of lga.wards) consistency.wards[w.unitId] = w.collation ? (await collation.verifyConsistency(1, w.unitId))[0] : null;
    consistency.lgas[lga.unitId] = lga.collation ? (await collation.verifyConsistency(2, lga.unitId))[0] : null;
  }
  consistency.state = state.collation ? (await collation.verifyConsistency(3, STATE_UNIT_ID))[0] : null;
  return { state, lgas, consistency };
}
