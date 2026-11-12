/**
 * Read-only access to the deployed ClearCount contracts (the blockchain is the authoritative record;
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

// The geography read is the hottest one (every open portal polls it) and at state scale it spans
// 6,775 units. The names never change once the election is Active, so the structure is cached until
// the unit counts move; the statuses are re-read in parallel (ethers folds the calls into JSON-RPC
// batches) and shared between concurrent requests for a few seconds.
const GEOGRAPHY_TTL_MS = 5000;
const TRACE_TTL_MS = 20000;
let structureCache = null; // { key, lgas }
const shared = new Map(); // name -> { at, value, refreshing }

/**
 * One read per name, shared by every caller. A result older than `ttlMs` is still served while a
 * single refresh runs behind it, so a poll never waits on the chain after the first load (the whole
 * state is ~13,500 status calls).
 */
function sharedRead(name, ttlMs, read) {
  let entry = shared.get(name);
  if (!entry) shared.set(name, (entry = { at: 0, value: undefined, refreshing: null }));
  if (!entry.refreshing && Date.now() - entry.at >= ttlMs) {
    entry.refreshing = read()
      .then((value) => {
        entry.value = value;
        entry.at = Date.now();
        return value;
      })
      .finally(() => {
        entry.refreshing = null;
      });
    entry.refreshing.catch(() => {}); // surfaced to the callers awaiting it, below
  }
  return entry.value !== undefined ? Promise.resolve(entry.value) : entry.refreshing;
}

const range = (n) => Array.from({ length: n }, (_, i) => i + 1);

async function readStructure() {
  const { election } = getChain().contracts;
  const [lgaCount, wardCount, puCount] = (await Promise.all([election.lgaCount(), election.wardCount(), election.pollingUnitCount()])).map(num);
  const key = `${lgaCount}/${wardCount}/${puCount}`;
  if (structureCache?.key === key) return structureCache.lgas;
  const [lgaRows, wardRows, puRows] = await Promise.all([
    Promise.all(range(lgaCount).map((id) => election.getLga(id))),
    Promise.all(range(wardCount).map((id) => election.getWard(id))),
    Promise.all(range(puCount).map((id) => election.getPollingUnit(id))),
  ]);
  const lgas = lgaRows.map((lga, i) => ({
    id: i + 1,
    name: lga.name,
    wards: Array.from(lga.wardIds).map((wIdRaw) => {
      const wId = num(wIdRaw);
      const ward = wardRows[wId - 1];
      return {
        id: wId,
        name: ward.name,
        lgaId: i + 1,
        pollingUnits: Array.from(ward.pollingUnitIds).map((puIdRaw) => {
          const puId = num(puIdRaw);
          const pu = puRows[puId - 1];
          return { id: puId, code: pu.code, name: pu.name, registeredVoters: num(pu.registeredVoters) };
        }),
      };
    }),
  }));
  structureCache = { key, lgas };
  return lgas;
}

async function loadGeography() {
  const { election, verification } = getChain().contracts;
  const structure = await readStructure();
  const wards = structure.flatMap((l) => l.wards);
  const pus = wards.flatMap((w) => w.pollingUnits);
  const status = async (level, id) => STATUSES[num(await verification.statusOf(level, id))];
  const [lgaStatus, wardStatus, puStatus, puCancelled, stateStatus] = await Promise.all([
    Promise.all(structure.map((l) => status(2, l.id))),
    Promise.all(wards.map((w) => status(1, w.id))),
    Promise.all(pus.map((p) => status(0, p.id))),
    Promise.all(pus.map((p) => election.isPollingUnitCancelled(p.id))),
    status(3, STATE_UNIT_ID),
  ]);
  let w = 0;
  let p = 0;
  const lgas = structure.map((lga, l) => ({
    id: lga.id,
    name: lga.name,
    status: lgaStatus[l],
    wards: lga.wards.map((ward) => ({
      id: ward.id,
      name: ward.name,
      lgaId: ward.lgaId,
      status: wardStatus[w++],
      pollingUnits: ward.pollingUnits.map((pu) => ({ ...pu, cancelled: puCancelled[p], status: puStatus[p++] })),
    })),
  }));
  return { lgas, stateStatus };
}

export function readGeography() {
  return sharedRead("geography", GEOGRAPHY_TTL_MS, loadGeography);
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

/**
 * Full trace from the state result down to every polling unit (auditor & public verifier).
 * The state, LGAs and wards carry their complete unit record; a polling unit carries what the trace
 * shows of it (code, status, figures, dispute ids) — its full record is one /units/pu/:id away.
 */
export function readChainTrace() {
  return sharedRead("trace", TRACE_TTL_MS, loadChainTrace);
}

async function loadChainTrace() {
  const { upload, verification, collation } = getChain().contracts;
  const geo = await readGeography();
  const tracePu = async (pu) => {
    const [r, disputeIds] = await Promise.all([upload.getResult(pu.id), verification.disputeIdsOf(0, pu.id)]);
    return {
      unitId: pu.id,
      code: pu.code,
      name: pu.name,
      status: pu.status,
      cancelled: pu.cancelled,
      figures: r.exists ? figuresToJson(r.figures) : null,
      disputes: Array.from(disputeIds).map(num),
    };
  };
  const [state, lgas] = await Promise.all([
    readUnit(3, STATE_UNIT_ID),
    Promise.all(
      geo.lgas.map(async (lga) => {
        const [lgaUnit, wards] = await Promise.all([
          readUnit(2, lga.id),
          Promise.all(
            lga.wards.map(async (ward) => {
              const [wardUnit, pollingUnits] = await Promise.all([readUnit(1, ward.id), Promise.all(ward.pollingUnits.map(tracePu))]);
              return { ...wardUnit, pollingUnits };
            }),
          ),
        ]);
        return { ...lgaUnit, wards };
      }),
    ),
  ]);
  // readUnit already asked CollationEngine.verifyConsistency for every collated unit
  const verdict = (unit) => (unit.collation ? unit.consistent : null);
  const consistency = { wards: {}, lgas: {}, state: verdict(state) };
  for (const lga of lgas) {
    consistency.lgas[lga.unitId] = verdict(lga);
    for (const w of lga.wards) consistency.wards[w.unitId] = verdict(w);
  }
  return { state, lgas, consistency };
}
