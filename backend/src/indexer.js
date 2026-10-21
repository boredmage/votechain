/**
 * Event indexer: replays every VoteChain contract event into the PostgreSQL display cache and
 * derives the notification queue that tells each stakeholder what awaits their action.
 * The chain remains authoritative – the cache can be dropped and rebuilt at any time.
 */
import { config } from "./config.js";
import { getChain, LEVELS, STATUSES, DISPUTE_STATUSES, RESOLUTION_TYPES, FIELDS, CATEGORIES, PHASES, STATE_UNIT_ID, num } from "./chain.js";
import { query, hasDb } from "./db.js";

const LEVEL_LABEL = ["Polling unit", "Ward", "LGA", "State"];
const FORM = ["EC8A", "EC8B", "EC8C", "EC8D"];

export class Indexer {
  constructor() {
    this.running = false;
    this.lastBlock = null;
    this.lastError = null;
    this.blockTimes = new Map();
    this.timer = null;
  }

  async start() {
    if (!hasDb()) {
      console.log("[indexer] DATABASE_URL not set – running in chain-only mode (no cache, no notifications)");
      return;
    }
    const { deployment } = getChain();
    const row = await query("SELECT value FROM indexer_state WHERE key = 'last_block'");
    this.lastBlock = row.rowCount ? Number(row.rows[0].value) : Math.max(0, (deployment.deployBlock ?? 0) - 1);
    this.running = true;
    console.log(`[indexer] starting from block ${this.lastBlock + 1}`);
    const loop = async () => {
      if (!this.running) return;
      try {
        await this.tick();
        this.lastError = null;
      } catch (err) {
        this.lastError = err.message;
        console.error("[indexer]", err.message);
      }
      this.timer = setTimeout(loop, config.indexerPollMs);
    };
    loop();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  status() {
    return { running: this.running, lastBlock: this.lastBlock, lastError: this.lastError };
  }

  async tick() {
    const { provider, addresses, interfaces } = getChain();
    const head = await provider.getBlockNumber();
    if (head <= this.lastBlock) return;
    const byAddress = new Map(
      Object.entries(addresses).map(([name, addr]) => [addr.toLowerCase(), { name, iface: interfaces[name] }]),
    );
    let from = this.lastBlock + 1;
    while (from <= head) {
      const to = Math.min(head, from + config.indexerBatchBlocks - 1);
      const logs = await provider.getLogs({ address: Object.values(addresses), fromBlock: from, toBlock: to });
      for (const log of logs) {
        const meta = byAddress.get(log.address.toLowerCase());
        if (!meta) continue;
        let parsed;
        try {
          parsed = meta.iface.parseLog({ topics: [...log.topics], data: log.data });
        } catch {
          continue;
        }
        if (!parsed) continue;
        const blockTime = await this.blockTime(log.blockNumber);
        await this.handle(meta.name, parsed, log, blockTime);
      }
      await query(
        "INSERT INTO indexer_state (key, value, updated_at) VALUES ('last_block', $1, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        [String(to)],
      );
      this.lastBlock = to;
      from = to + 1;
    }
  }

  async blockTime(blockNumber) {
    if (this.blockTimes.has(blockNumber)) return this.blockTimes.get(blockNumber);
    const { provider } = getChain();
    const block = await provider.getBlock(blockNumber);
    const t = new Date(Number(block.timestamp) * 1000);
    this.blockTimes.set(blockNumber, t);
    if (this.blockTimes.size > 5000) this.blockTimes.clear();
    return t;
  }

  async handle(contract, parsed, log, blockTime) {
    const a = parsed.args;
    const name = parsed.name;
    const argsJson = {};
    parsed.fragment.inputs.forEach((input, i) => {
      const v = a[i];
      argsJson[input.name] = typeof v === "bigint" ? v.toString() : v;
    });
    const level = a.level !== undefined ? num(a.level) : null;
    const unitId = a.unitId !== undefined ? num(a.unitId) : a.puId !== undefined ? num(a.puId) : null;
    const actor = a.agent ?? a.officer ?? a.account ?? a.resolvedBy ?? a.auditor ?? a.publisher ?? null;

    const inserted = await query(
      `INSERT INTO chain_events (block_number, block_time, tx_hash, log_index, contract, name, level, unit_id, actor, args)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (tx_hash, log_index) DO NOTHING RETURNING id`,
      [log.blockNumber, blockTime, log.transactionHash, log.index, contract, name, level, unitId, actor, JSON.stringify(argsJson)],
    );
    if (!inserted.rowCount) return; // already processed

    const ctx = { a, log, blockTime, level, unitId, tx: log.transactionHash, block: log.blockNumber };
    const handler = this[`on${name}`];
    if (handler) await handler.call(this, ctx);
  }

  // ------------------------------------------------------------------
  // ElectionManager
  // ------------------------------------------------------------------
  async onLgaAdded({ a }) {
    await query("INSERT INTO lgas (id, name) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name", [num(a.lgaId), a.name]);
    await this.ensureUnit(2, num(a.lgaId));
  }

  async onWardAdded({ a }) {
    await query("INSERT INTO wards (id, lga_id, name) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name", [num(a.wardId), num(a.lgaId), a.name]);
    await this.ensureUnit(1, num(a.wardId));
  }

  async onPollingUnitAdded({ a }) {
    await query(
      "INSERT INTO polling_units (id, ward_id, code, name, registered_voters) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name",
      [num(a.puId), num(a.wardId), a.code, a.name, num(a.registeredVoters)],
    );
    await this.ensureUnit(0, num(a.puId));
  }

  async onPollingUnitCancelled({ a, tx }) {
    const puId = num(a.puId);
    await query("UPDATE polling_units SET cancelled = true, cancellation_cid = $2 WHERE id = $1", [puId, a.reasonCid]);
    const pu = await this.pollingUnit(puId);
    const recipients = [...(await this.agentsAt(0, puId)), ...(await this.officersFor(1, pu?.ward_id))];
    await this.notify(recipients, "PollingUnitCancelled", 0, puId, `Polling unit ${pu?.code ?? puId} was cancelled by INEC.`, { reasonCid: a.reasonCid }, tx);
  }

  async onPartyAdded({ a }) {
    await query("INSERT INTO parties (id, name, acronym) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, acronym = EXCLUDED.acronym", [num(a.partyId), a.name, a.acronym]);
  }

  async onCandidateAdded({ a }) {
    await query("INSERT INTO candidates (idx, party_id, name) VALUES ($1,$2,$3) ON CONFLICT (idx) DO UPDATE SET name = EXCLUDED.name", [num(a.candidateIndex), num(a.partyId), a.name]);
  }

  async onStakeholderRegistered({ a, block }) {
    await query(
      `INSERT INTO stakeholders (address, category, level, unit_id, party_id, registered_block, revoked)
       VALUES ($1,$2,$3,$4,$5,$6,false)
       ON CONFLICT (address) DO UPDATE SET category = EXCLUDED.category, level = EXCLUDED.level, unit_id = EXCLUDED.unit_id, party_id = EXCLUDED.party_id, registered_block = EXCLUDED.registered_block, revoked = false`,
      [a.account.toLowerCase(), CATEGORIES[num(a.category)], num(a.level), num(a.unitId), num(a.partyId), block],
    );
  }

  async onStakeholderRevoked({ a }) {
    await query("UPDATE stakeholders SET revoked = true WHERE address = $1", [a.account.toLowerCase()]);
  }

  async onPhaseChanged({ a, tx }) {
    const to = PHASES[num(a.to)];
    await query("INSERT INTO indexer_state (key, value, updated_at) VALUES ('phase', $1, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()", [to]);
    const recipients = await this.byCategory(["InecAdmin", "StateReturningOfficer", "Auditor", "ResultPublisher"]);
    await this.notify(recipients, "PhaseChanged", 3, STATE_UNIT_ID, `Election phase is now ${to}.`, { from: PHASES[num(a.from)], to }, tx);
  }

  // ------------------------------------------------------------------
  // ResultUpload
  // ------------------------------------------------------------------
  async onResultSubmitted({ a, tx, block, blockTime }) {
    await this.recordResult(0, num(a.puId), num(a.round), a.figuresHash, a.formCid, a.officer, block, blockTime, tx);
    const pu = await this.pollingUnit(num(a.puId));
    await this.notify(await this.agentsAt(0, num(a.puId)), "ResultSubmitted", 0, num(a.puId), `EC8A figures for polling unit ${pu?.code ?? a.puId} were uploaded and await your review and signature.`, { round: num(a.round), figuresHash: a.figuresHash, formCid: a.formCid }, tx);
  }

  async onResultResubmitted({ a, tx, block, blockTime }) {
    await this.recordResult(0, num(a.puId), num(a.round), a.figuresHash, a.formCid, a.officer, block, blockTime, tx);
  }

  // ------------------------------------------------------------------
  // PartyAgentVerification
  // ------------------------------------------------------------------
  async onStatusChanged({ a, block, blockTime }) {
    await query(
      `INSERT INTO unit_status (level, unit_id, status, updated_block, updated_at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (level, unit_id) DO UPDATE SET status = EXCLUDED.status, updated_block = EXCLUDED.updated_block, updated_at = EXCLUDED.updated_at`,
      [num(a.level), num(a.unitId), STATUSES[num(a.to)], block, blockTime],
    );
  }

  async onSignatureRoundOpened({ a, block, blockTime }) {
    await query(
      `INSERT INTO unit_status (level, unit_id, round, figures_hash, updated_block, updated_at) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (level, unit_id) DO UPDATE SET round = EXCLUDED.round, figures_hash = EXCLUDED.figures_hash, updated_block = EXCLUDED.updated_block, updated_at = EXCLUDED.updated_at`,
      [num(a.level), num(a.unitId), num(a.round), a.figuresHash, block, blockTime],
    );
  }

  async onResultSigned({ a, tx, block, blockTime }) {
    await query(
      `INSERT INTO signatures (level, unit_id, round, agent, party_id, objection, figures_hash, block_number, block_time, tx_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (level, unit_id, round, agent) DO UPDATE SET objection = EXCLUDED.objection, figures_hash = EXCLUDED.figures_hash, block_number = EXCLUDED.block_number, block_time = EXCLUDED.block_time, tx_hash = EXCLUDED.tx_hash`,
      [num(a.level), num(a.unitId), num(a.round), a.agent.toLowerCase(), num(a.partyId), a.objection, a.figuresHash, block, blockTime, tx],
    );
  }

  async onObjectionRecorded({ a }) {
    await query("UPDATE signatures SET objection = true, objection_reason = $5 WHERE level = $1 AND unit_id = $2 AND round = $3 AND agent = $4", [num(a.level), num(a.unitId), num(a.round), a.agent.toLowerCase(), a.reason]);
  }

  async onSignatureWaived({ a, tx, block, blockTime }) {
    await query(
      `INSERT INTO signatures (level, unit_id, round, agent, waived, block_number, block_time, tx_hash) VALUES ($1,$2,$3,$4,true,$5,$6,$7)
       ON CONFLICT (level, unit_id, round, agent) DO UPDATE SET waived = true`,
      [num(a.level), num(a.unitId), num(a.round), a.agent.toLowerCase(), block, blockTime, tx],
    );
    await this.notify([a.agent], "SignatureWaived", num(a.level), num(a.unitId), `The auditor dismissed your dispute #${num(a.disputeId)}; your signature slot for the current round was waived and collation continues.`, { disputeId: num(a.disputeId) }, tx);
  }

  async onResultApproved({ a, tx }) {
    const level = num(a.level);
    const unitId = num(a.unitId);
    const label = await this.unitLabel(level, unitId);
    if (level === 0) {
      const pu = await this.pollingUnit(unitId);
      await this.notify(await this.officersFor(1, pu?.ward_id), "LowerLevelApproved", 1, pu?.ward_id, `${label} result approved by all party agents. Check whether ${await this.unitLabel(1, pu?.ward_id)} is ready for EC8B collation.`, { approvedLevel: level, approvedUnitId: unitId }, tx);
    } else if (level === 1) {
      const w = await this.ward(unitId);
      await this.notify(await this.officersFor(2, w?.lga_id), "LowerLevelApproved", 2, w?.lga_id, `${label} collation approved. Check whether ${await this.unitLabel(2, w?.lga_id)} is ready for EC8C collation.`, { approvedLevel: level, approvedUnitId: unitId }, tx);
    } else if (level === 2) {
      await this.notify(await this.officersFor(3, STATE_UNIT_ID), "LowerLevelApproved", 3, STATE_UNIT_ID, `${label} collation approved. Check whether the state is ready for EC8D collation.`, { approvedLevel: level, approvedUnitId: unitId }, tx);
    } else {
      await this.notify(await this.byCategory(["Auditor", "ResultPublisher", "InecAdmin"]), "StateApproved", 3, STATE_UNIT_ID, "The state collation has been signed by all state party agents. The independent auditor may now verify the full chain and sign.", {}, tx);
    }
  }

  async onDisputeRaised({ a, tx, blockTime }) {
    const level = num(a.level);
    const unitId = num(a.unitId);
    await query(
      `INSERT INTO disputes (id, level, unit_id, round, agent, party_id, reason, evidence_cid, status, raised_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Raised',$9) ON CONFLICT (id) DO NOTHING`,
      [num(a.disputeId), level, unitId, num(a.round), a.agent.toLowerCase(), num(a.partyId), a.reason, a.evidenceCid, blockTime],
    );
    const label = await this.unitLabel(level, unitId);
    const others = (await this.agentsAt(level, unitId)).filter((x) => x.toLowerCase() !== a.agent.toLowerCase());
    await this.notify(await this.officersFor(level, unitId), "DisputeRaised", level, unitId, `Dispute #${num(a.disputeId)} raised on ${label}: "${a.reason}". The result is frozen until you resolve it.`, { disputeId: num(a.disputeId) }, tx);
    await this.notify([...others, ...(await this.byCategory(["InecAdmin"]))], "DisputeRaised", level, unitId, `Dispute #${num(a.disputeId)} raised on ${label}; the result is frozen pending resolution.`, { disputeId: num(a.disputeId) }, tx);
  }

  async onDisputeResolved({ a, tx, blockTime }) {
    const id = num(a.disputeId);
    await query("UPDATE disputes SET status = 'Resolved', resolution_kind = $2, resolved_by = $3, resolution_cid = $4, resolved_at = $5 WHERE id = $1", [id, RESOLUTION_TYPES[num(a.kind)], a.resolvedBy.toLowerCase(), a.documentCid, blockTime]);
    const d = await this.dispute(id);
    if (d) {
      const kind = RESOLUTION_TYPES[num(a.kind)] === "FiguresCorrected" ? "corrected the figures" : "confirmed the original figures";
      await this.notify([d.agent], "DisputeResolved", d.level, d.unit_id, `The officer ${kind} for your dispute #${id} on ${await this.unitLabel(d.level, d.unit_id)}. Review the resolution and accept it or escalate to the auditor.`, { disputeId: id }, tx);
    }
  }

  async onResolutionAccepted({ a, tx, blockTime }) {
    const id = num(a.disputeId);
    await query("UPDATE disputes SET status = 'Accepted', accepted_at = $2 WHERE id = $1", [id, blockTime]);
    const d = await this.dispute(id);
    if (d) {
      const label = await this.unitLabel(d.level, d.unit_id);
      await this.notify([...(await this.agentsAt(d.level, d.unit_id)), ...(await this.officersFor(d.level, d.unit_id))], "SigningReopened", d.level, d.unit_id, `Dispute #${id} on ${label} was accepted; a new signing round is open and every agent must sign again.`, { disputeId: id }, tx);
    }
  }

  async onDisputeEscalated({ a, tx, blockTime }) {
    const id = num(a.disputeId);
    await query("UPDATE disputes SET status = 'Escalated', escalated_at = $2 WHERE id = $1", [id, blockTime]);
    const d = await this.dispute(id);
    if (d) {
      await this.notify([...(await this.byCategory(["Auditor"])), ...(await this.officersFor(d.level, d.unit_id))], "DisputeEscalated", d.level, d.unit_id, `Dispute #${id} on ${await this.unitLabel(d.level, d.unit_id)} was escalated to the independent auditor.`, { disputeId: id }, tx);
    }
  }

  async onEscalationRuled({ a, tx, blockTime }) {
    const id = num(a.disputeId);
    await query("UPDATE disputes SET status = $2, ruling_upheld = $3, ruling_cid = $4, ruled_at = $5 WHERE id = $1", [id, a.upheld ? "RuledUpheld" : "RuledDismissed", a.upheld, a.documentCid, blockTime]);
    const d = await this.dispute(id);
    if (d) {
      const label = await this.unitLabel(d.level, d.unit_id);
      const msg = a.upheld
        ? `The auditor UPHELD dispute #${id} on ${label}. The officer must submit corrected figures before signing can resume.`
        : `The auditor dismissed dispute #${id} on ${label}. Signing continues.`;
      await this.notify([d.agent, ...(await this.officersFor(d.level, d.unit_id)), ...(await this.agentsAt(d.level, d.unit_id))], "EscalationRuled", d.level, d.unit_id, msg, { disputeId: id, upheld: a.upheld }, tx);
    }
  }

  // ------------------------------------------------------------------
  // CollationEngine
  // ------------------------------------------------------------------
  async onCollationConfirmed({ a, tx, block, blockTime }) {
    const level = num(a.level);
    const unitId = num(a.unitId);
    await this.recordResult(level, unitId, num(a.round), a.figuresHash, a.formCid, a.officer, block, blockTime, tx);
    await this.notify(await this.agentsAt(level, unitId), "CollationConfirmed", level, unitId, `${FORM[level]} collation for ${await this.unitLabel(level, unitId)} was confirmed by the collation officer and awaits your signature.`, { round: num(a.round), figuresHash: a.figuresHash }, tx);
  }

  async onMismatchAlert({ a, tx, block, blockTime }) {
    const level = num(a.level);
    const unitId = num(a.unitId);
    await query(
      `INSERT INTO mismatch_alerts (level, unit_id, officer, field, candidate_index, declared, computed, attempt, block_number, block_time, tx_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
      [level, unitId, a.officer.toLowerCase(), FIELDS[num(a.field)], num(a.candidateIndex), a.declared.toString(), a.computed.toString(), num(a.attempt), block, blockTime, tx],
    );
    const label = await this.unitLabel(level, unitId);
    const field = FIELDS[num(a.field)] === "CandidateVotes" ? `candidate #${num(a.candidateIndex)} votes` : FIELDS[num(a.field)];
    await this.notify(
      [...(await this.agentsAt(level, unitId)), ...(await this.byCategory(["Auditor", "InecAdmin"]))],
      "MismatchAlert",
      level,
      unitId,
      `MISMATCH ALERT on ${label}: the collation officer declared ${a.declared} for ${field} but the approved lower-level results sum to ${a.computed} (attempt ${num(a.attempt)}). Collation is blocked.`,
      { field, declared: a.declared.toString(), computed: a.computed.toString(), attempt: num(a.attempt), officer: a.officer },
      tx,
    );
  }

  // ------------------------------------------------------------------
  // AuditDeclaration
  // ------------------------------------------------------------------
  async onAuditApproved({ a, tx, blockTime }) {
    await query(
      `INSERT INTO audit_record (id, auditor, state_result_hash, report_cid, approved_at, tx_hash) VALUES (1,$1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET auditor = EXCLUDED.auditor, state_result_hash = EXCLUDED.state_result_hash, report_cid = EXCLUDED.report_cid, approved_at = EXCLUDED.approved_at, tx_hash = EXCLUDED.tx_hash`,
      [a.auditor.toLowerCase(), a.stateResultHash, a.reportCid, blockTime, tx],
    );
    await this.notify(await this.byCategory(["ResultPublisher", "InecAdmin", "StateReturningOfficer"]), "AuditApproved", 3, STATE_UNIT_ID, "The independent auditor verified the full collation chain and signed. The result publisher may now declare the result.", { reportCid: a.reportCid }, tx);
  }

  async onResultDeclared({ a, tx, blockTime }) {
    await query(
      `INSERT INTO declaration (id, publisher, state_result_hash, winner_candidate_index, winner_party_id, winner_votes, tie, declared_at, tx_hash) VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET publisher = EXCLUDED.publisher, declared_at = EXCLUDED.declared_at, tx_hash = EXCLUDED.tx_hash`,
      [a.publisher.toLowerCase(), a.stateResultHash, num(a.winnerCandidateIndex), num(a.winnerPartyId), a.winnerVotes.toString(), a.tie, blockTime, tx],
    );
    await this.notify(await this.byCategory(["InecAdmin", "StateReturningOfficer", "Auditor", "ResultPublisher"]), "ResultDeclared", 3, STATE_UNIT_ID, "The final state result has been declared on-chain.", { tie: a.tie, winnerCandidateIndex: num(a.winnerCandidateIndex) }, tx);
  }

  // ------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------
  async ensureUnit(level, unitId) {
    await query("INSERT INTO unit_status (level, unit_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [level, unitId]);
  }

  async recordResult(level, unitId, round, figuresHash, formCid, officer, block, blockTime, tx) {
    await query(
      `INSERT INTO results (level, unit_id, round, figures_hash, form_cid, officer, block_number, block_time, tx_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (level, unit_id, round) DO UPDATE SET figures_hash = EXCLUDED.figures_hash, form_cid = EXCLUDED.form_cid, officer = EXCLUDED.officer, block_number = EXCLUDED.block_number, block_time = EXCLUDED.block_time, tx_hash = EXCLUDED.tx_hash`,
      [level, unitId, round, figuresHash, formCid, officer.toLowerCase(), block, blockTime, tx],
    );
  }

  async pollingUnit(id) {
    if (id == null) return null;
    const r = await query("SELECT * FROM polling_units WHERE id = $1", [id]);
    return r.rows[0] ?? null;
  }

  async ward(id) {
    if (id == null) return null;
    const r = await query("SELECT * FROM wards WHERE id = $1", [id]);
    return r.rows[0] ?? null;
  }

  async dispute(id) {
    const r = await query("SELECT * FROM disputes WHERE id = $1", [id]);
    return r.rows[0] ?? null;
  }

  async unitLabel(level, unitId) {
    if (unitId == null) return LEVEL_LABEL[level];
    if (level === 0) {
      const pu = await this.pollingUnit(unitId);
      return pu ? `polling unit ${pu.code} (${pu.name})` : `polling unit #${unitId}`;
    }
    if (level === 1) {
      const w = await this.ward(unitId);
      return w ? `ward ${w.name}` : `ward #${unitId}`;
    }
    if (level === 2) {
      const r = await query("SELECT name FROM lgas WHERE id = $1", [unitId]);
      return r.rows[0] ? `${r.rows[0].name} LGA` : `LGA #${unitId}`;
    }
    return "the state collation";
  }

  async agentsAt(level, unitId) {
    if (unitId == null) return [];
    const r = await query("SELECT address FROM stakeholders WHERE category = 'PartyAgent' AND level = $1 AND unit_id = $2 AND NOT revoked", [level, unitId]);
    return r.rows.map((x) => x.address);
  }

  async officersFor(level, unitId) {
    if (unitId == null) return [];
    const category = ["PresidingOfficer", "WardCollationOfficer", "LgaCollationOfficer", "StateReturningOfficer"][level];
    const r = await query("SELECT address FROM stakeholders WHERE category = $1 AND level = $2 AND unit_id = $3 AND NOT revoked", [category, level, unitId]);
    return r.rows.map((x) => x.address);
  }

  async byCategory(categories) {
    const r = await query("SELECT address FROM stakeholders WHERE category = ANY($1) AND NOT revoked", [categories]);
    return r.rows.map((x) => x.address);
  }

  async notify(recipients, kind, level, unitId, message, payload, tx) {
    const unique = [...new Set(recipients.filter(Boolean).map((r) => r.toLowerCase()))];
    for (const recipient of unique) {
      await query(
        `INSERT INTO notifications (recipient, kind, level, unit_id, message, payload, tx_hash) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (recipient, kind, tx_hash, level, unit_id) DO NOTHING`,
        [recipient, kind, level, unitId ?? null, message, JSON.stringify(payload ?? {}), tx],
      );
    }
  }
}

export const indexer = new Indexer();
