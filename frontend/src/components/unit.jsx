import { useMemo, useState } from "react";
import { Button, Label, ProgressBar, Table, TextArea, TextField } from "@heroui/react";
import { useApp } from "../hooks/useApp.jsx";
import { LEVEL_INDEX, LEVEL_LABEL, STATE_UNIT_ID } from "../lib/constants.js";
import { figuresHash } from "../lib/figures.js";
import { fmtTime, shortAddr, shortHash } from "../lib/format.js";
import { StatusBadge, Badge, Alert, Empty, Address, FiguresTable, FormPreview, IpfsUpload, KeyValues, Panel, HashValue, ConfirmButton } from "./common.jsx";

const ZERO_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";

export function unitTitle(unit) {
  if (!unit) return "";
  if (unit.level === "PollingUnit") return `${unit.code} — ${unit.name}`;
  if (unit.level === "State") return "Oyo State collation";
  return unit.level === "LGA" ? `${unit.name} LGA` : unit.name;
}

/** Labelled multi-line text input. */
export function NoteField({ label, value, onChange, placeholder, isRequired = false, rows = 3 }) {
  return (
    <TextField className="w-full" value={value} onChange={onChange} isRequired={isRequired}>
      <Label className="text-sm font-medium">{label}</Label>
      <TextArea variant="secondary" rows={rows} placeholder={placeholder} className="w-full" />
    </TextField>
  );
}

/** Header block: identity, status, round, hash integrity check. */
export function UnitHeader({ unit }) {
  const { election } = useApp();
  const localHash = useMemo(() => {
    if (!unit?.figures || !unit.formCid) return null;
    try {
      return figuresHash(unit.levelIndex, unit.unitId, unit.figures, unit.formCid);
    } catch {
      return null;
    }
  }, [unit]);
  const hashOk = localHash && unit?.figuresHash && localHash.toLowerCase() === unit.figuresHash.toLowerCase();
  return (
    <Panel
      data-testid="unit-header"
      title={
        <>
          <span className="text-lg">{unitTitle(unit)}</span>
          <Badge kind="info">{unit.form}</Badge>
        </>
      }
      description={
        <span className="flex flex-wrap gap-x-4 gap-y-1">
          <span>
            {LEVEL_LABEL[unit.level]} #{unit.unitId}
          </span>
          <span>Round {unit.round}</span>
          <span>
            Signatures {unit.signatureCount}/{unit.requiredSignatures}
          </span>
        </span>
      }
      actions={<StatusBadge status={unit.status} size="md" />}
    >
      <div className="flex flex-col gap-3">
        {unit.mismatchAttempts || unit.cancelled ? (
          <div className="flex flex-wrap gap-2">
            {unit.mismatchAttempts ? <Badge kind="danger">{unit.mismatchAttempts} mismatch alert(s) recorded</Badge> : null}
            {unit.cancelled ? <Badge kind="warn">Cancelled by INEC</Badge> : null}
          </div>
        ) : null}
        {unit.figuresHash && unit.figuresHash !== ZERO_HASH ? (
          <div className="flex flex-col gap-1.5 text-sm">
            <span className="text-xs font-medium uppercase tracking-wider text-muted">Figures hash</span>
            <HashValue value={unit.figuresHash} />
            {localHash ? (
              hashOk ? (
                <span>
                  <Badge kind="ok">Integrity check passed — hash recomputed in your browser</Badge>
                </span>
              ) : (
                <span>
                  <Badge kind="danger">Hash mismatch — reload the page</Badge>
                </span>
              )
            ) : null}
          </div>
        ) : null}
        {election?.phase === "Declared" ? <Alert kind="ok">The election result has been declared. All records are final.</Alert> : null}
      </div>
    </Panel>
  );
}

export function UnitFigures({ unit, compare = null, compareLabel }) {
  const { election } = useApp();
  return (
    <Panel title={`${unit.form} figures on-chain`}>
      <FiguresTable
        label={`${unit.form} figures`}
        figures={unit.figures}
        candidates={election?.candidates.map((c) => ({ ...c, acronym: election.parties.find((p) => p.id === c.partyId)?.acronym }))}
        compare={compare}
        compareLabel={compareLabel}
      />
      {unit.submission ? (
        <p className="mt-3 text-sm text-muted">
          Submitted by <Address value={unit.submission.officer} /> on {fmtTime(unit.submission.submittedAt)} (block {unit.submission.blockNumber}).
        </p>
      ) : null}
      {unit.collation ? (
        <p className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted">
          <span>
            Confirmed by <Address value={unit.collation.officer} /> on {fmtTime(unit.collation.confirmedAt)} (block {unit.collation.blockNumber}).
          </span>
          {unit.consistent === true ? <Badge kind="ok">Recomputed sum matches</Badge> : null}
          {unit.consistent === false ? <Badge kind="danger">Recomputed sum differs</Badge> : null}
        </p>
      ) : null}
    </Panel>
  );
}

export function UnitForm({ unit }) {
  return (
    <Panel title={`Scanned ${unit.form} form`}>
      <FormPreview cid={unit.formCid} label={unit.form} />
    </Panel>
  );
}

function SignatureStatus({ s }) {
  if (s.signed && s.objection) return <Badge kind="warn">Signed with objection</Badge>;
  if (s.signed) return <Badge kind="ok">Signed</Badge>;
  if (s.waived) return <Badge kind="info">Waived by auditor ruling</Badge>;
  return <Badge>Awaiting</Badge>;
}

/** Party-agent signature progress for the current round. */
export function SignaturesPanel({ unit }) {
  const { election } = useApp();
  const party = (id) => election?.parties.find((p) => p.id === id);
  const pct = unit.requiredSignatures ? Math.round((100 * unit.signatureCount) / unit.requiredSignatures) : 0;
  return (
    <Panel title="Party-agent signatures" description={`Round ${unit.round} — every contesting party must sign before the result moves up.`}>
      <ProgressBar value={pct} aria-label="Signatures collected" className="mb-4 w-full" color={pct === 100 ? "success" : "accent"}>
        <div className="flex w-full justify-between text-xs text-muted">
          <span>
            {unit.signatureCount} of {unit.requiredSignatures} signatures
          </span>
          <ProgressBar.Output />
        </div>
        <ProgressBar.Track>
          <ProgressBar.Fill />
        </ProgressBar.Track>
      </ProgressBar>
      {unit.signatures.length === 0 ? (
        <Empty>No party agents registered for this unit — it cannot be approved.</Empty>
      ) : (
        <Table variant="secondary">
          <Table.ScrollContainer>
            <Table.Content aria-label="Party-agent signatures" className="min-w-[420px]">
              <Table.Header>
                <Table.Column isRowHeader>Party</Table.Column>
                <Table.Column>Agent</Table.Column>
                <Table.Column>Status</Table.Column>
                <Table.Column>When</Table.Column>
              </Table.Header>
              <Table.Body>
                {unit.signatures.map((s) => (
                  <Table.Row key={s.agent} id={s.agent}>
                    <Table.Cell>
                      <span className="font-semibold">{party(s.partyId)?.acronym ?? s.partyId}</span>
                      <div className="text-xs text-muted">{party(s.partyId)?.name}</div>
                    </Table.Cell>
                    <Table.Cell>
                      <Address value={s.agent} />
                    </Table.Cell>
                    <Table.Cell>
                      <SignatureStatus s={s} />
                      {s.objectionReason ? <div className="mt-1 text-xs text-muted">“{s.objectionReason}”</div> : null}
                    </Table.Cell>
                    <Table.Cell className="whitespace-nowrap text-xs text-muted">{s.timestamp ? fmtTime(s.timestamp) : "—"}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      )}
    </Panel>
  );
}

const DISPUTE_KIND = { Raised: "danger", RuledUpheld: "danger", Escalated: "info", Accepted: "ok", RuledDismissed: "ok" };

/** Dispute history with the actions each role may take. */
export function DisputesPanel({ unit }) {
  const { role, wallet, sendTx, election, busy } = useApp();
  const [docCid, setDocCid] = useState("");
  const [note, setNote] = useState("");
  const [rulingCid, setRulingCid] = useState("");
  const isOfficer =
    role &&
    ((role.category === "PresidingOfficer" && unit.level === "PollingUnit") ||
      (role.category === "WardCollationOfficer" && unit.level === "Ward") ||
      (role.category === "LgaCollationOfficer" && unit.level === "LGA") ||
      (role.category === "StateReturningOfficer" && unit.level === "State")) &&
    role.unitId === unit.unitId;
  const isAuditor = role?.category === "Auditor";
  const party = (id) => election?.parties.find((p) => p.id === id)?.acronym ?? id;

  if (!unit.disputes?.length) return null;
  return (
    <Panel title="Disputes" description="Full dispute history for this unit. Nothing here can be edited or deleted.">
      <div className="flex flex-col gap-4">
        {unit.disputes
          .slice()
          .reverse()
          .map((d) => {
            const mine = wallet && d.agent.toLowerCase() === wallet.address.toLowerCase();
            const active = d.id === unit.activeDisputeId;
            return (
              <section key={d.id} className="rounded-sm border border-border bg-default/30 p-4" aria-label={`Dispute ${d.id}`}>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <strong className="font-semibold">
                    Dispute #{d.id} <span className="text-sm font-normal text-muted">round {d.round}</span>
                  </strong>
                  <Badge kind={DISPUTE_KIND[d.status] ?? "warn"}>{d.status}</Badge>
                </div>
                <ol className="vc-timeline">
                  <li>
                    <strong>{party(d.partyId)} agent</strong> <Address value={d.agent} /> raised the dispute — <span className="text-muted">{fmtTime(d.raisedAt)}</span>
                    <blockquote className="mt-1 border-s-2 border-border ps-2 italic">“{d.reason}”</blockquote>
                    {d.evidenceCid ? (
                      <div className="mt-1 text-xs">
                        Evidence: <HashValue value={d.evidenceCid} />
                      </div>
                    ) : null}
                    <div className="mt-1 text-xs text-muted">Disputed figures hash {shortHash(d.disputedFiguresHash)}</div>
                  </li>
                  {d.resolution.kind !== "None" ? (
                    <li>
                      Officer <Address value={d.resolution.resolvedBy} /> {d.resolution.kind === "FiguresCorrected" ? "corrected the figures (new signing round)" : "confirmed the original figures"} —{" "}
                      <span className="text-muted">{fmtTime(d.resolution.resolvedAt)}</span>
                      {d.resolution.note ? <blockquote className="mt-1 border-s-2 border-border ps-2 italic">“{d.resolution.note}”</blockquote> : null}
                      {d.resolution.documentCid ? (
                        <div className="mt-1 text-xs">
                          Resolution document: <HashValue value={d.resolution.documentCid} />
                        </div>
                      ) : null}
                    </li>
                  ) : null}
                  {d.resolution.acceptedAt ? (
                    <li>
                      Disputing agent accepted the resolution — <span className="text-muted">{fmtTime(d.resolution.acceptedAt)}</span>
                    </li>
                  ) : null}
                  {d.resolution.escalatedAt ? (
                    <li>
                      Escalated to the independent auditor — <span className="text-muted">{fmtTime(d.resolution.escalatedAt)}</span>
                    </li>
                  ) : null}
                  {d.ruling.ruledAt ? (
                    <li>
                      Auditor ruling: <strong>{d.ruling.upheld ? "UPHELD — correction required" : "DISMISSED — signing continues"}</strong> — <span className="text-muted">{fmtTime(d.ruling.ruledAt)}</span>
                      {d.ruling.documentCid ? (
                        <div className="mt-1 text-xs">
                          Ruling document: <HashValue value={d.ruling.documentCid} />
                        </div>
                      ) : null}
                    </li>
                  ) : null}
                </ol>

                {/* officer: confirm original figures */}
                {isOfficer && active && unit.status === "Frozen" && !d.requiresCorrection ? (
                  <div className="mt-3 flex flex-col gap-3">
                    <Alert kind="warn" title="This result is frozen">
                      Either confirm the original figures with a documented resolution, or correct the figures using the form above.
                    </Alert>
                    <IpfsUpload label="Resolution document (optional)" purpose="resolution" uploader={wallet?.address} onUploaded={setDocCid} />
                    <NoteField
                      label="Resolution note"
                      value={note}
                      onChange={setNote}
                      isRequired
                      placeholder="e.g. Figures re-checked against the signed EC8A form in the presence of agents; original figures are correct."
                    />
                    <div>
                      <Button variant="primary" isDisabled={busy || !note.trim()} onPress={() => sendTx("Resolve dispute", (c) => c.verification.resolveDispute(LEVEL_INDEX[unit.level], unit.unitId, d.id, docCid, note))}>
                        Confirm original figures
                      </Button>
                    </div>
                  </div>
                ) : null}
                {isOfficer && active && unit.status === "Frozen" && d.requiresCorrection ? (
                  <div className="mt-3">
                    <Alert kind="danger" title="Correction required">
                      The auditor upheld this dispute. Submit corrected figures to resolve it — confirming the original figures is no longer possible.
                    </Alert>
                  </div>
                ) : null}

                {/* disputing agent: accept or escalate */}
                {mine && d.status === "Resolved" ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button variant="primary" isDisabled={busy} onPress={() => sendTx("Accept resolution", (c) => c.verification.acceptResolution(d.id))}>
                      Accept resolution
                    </Button>
                    <ConfirmButton
                      variant="secondary"
                      status="warning"
                      isDisabled={busy}
                      title="Escalate to the independent auditor?"
                      body="The auditor will rule on this dispute. The result stays frozen until the ruling is recorded."
                      confirmLabel="Escalate"
                      onConfirm={() => sendTx("Escalate to auditor", (c) => c.verification.escalateDispute(d.id))}
                    >
                      Escalate to independent auditor
                    </ConfirmButton>
                  </div>
                ) : null}

                {/* auditor: rule */}
                {isAuditor && d.status === "Escalated" ? (
                  <div className="mt-3 flex flex-col gap-3">
                    <IpfsUpload label="Ruling document (optional)" purpose="ruling" uploader={wallet?.address} onUploaded={setRulingCid} />
                    <div className="flex flex-wrap gap-2">
                      <ConfirmButton
                        variant="danger"
                        status="danger"
                        isDisabled={busy}
                        title="Uphold this dispute?"
                        body="The officer will be required to submit corrected figures. Your ruling is recorded permanently on-chain."
                        confirmLabel="Uphold dispute"
                        onConfirm={() => sendTx("Uphold dispute", (c) => c.verification.ruleOnEscalation(d.id, true, rulingCid))}
                      >
                        Uphold (require correction)
                      </ConfirmButton>
                      <ConfirmButton
                        variant="secondary"
                        status="warning"
                        isDisabled={busy}
                        title="Dismiss this dispute?"
                        body="The disputing agent's signature is waived and signing continues. Your ruling is recorded permanently on-chain."
                        confirmLabel="Dismiss dispute"
                        onConfirm={() => sendTx("Dismiss dispute", (c) => c.verification.ruleOnEscalation(d.id, false, rulingCid))}
                      >
                        Dismiss (waive agent, continue)
                      </ConfirmButton>
                    </div>
                  </div>
                ) : null}
              </section>
            );
          })}
      </div>
    </Panel>
  );
}

/** Actions available to a party agent assigned to this unit. */
export function AgentActions({ unit }) {
  const { role, wallet, sendTx, busy, election } = useApp();
  const [reason, setReason] = useState("");
  const [evidenceCid, setEvidenceCid] = useState("");
  const [mode, setMode] = useState(null); // 'objection' | 'dispute'
  if (!wallet || !role || role.category !== "PartyAgent" || role.level !== unit.level || role.unitId !== unit.unitId) return null;
  const mine = unit.signatures.find((s) => s.agent.toLowerCase() === wallet.address.toLowerCase());
  const lvl = LEVEL_INDEX[unit.level];
  const partyName = election?.parties.find((p) => p.id === role.partyId)?.name;

  if (unit.status === "Approved" || unit.status === "Declared")
    return <Alert kind="ok" title="Approved">This result is approved by every registered party agent{mine?.objection ? " (your objection is on record)" : ""}.</Alert>;
  if (unit.status === "Open") return <Alert kind="info" title="Nothing to review yet">You will be able to review and sign once the {unit.form} figures are on-chain.</Alert>;
  if (unit.status === "Frozen" || unit.status === "Resolved" || unit.status === "Escalated")
    return <Alert kind="warn" title="Signing paused">Dispute #{unit.activeDisputeId || ""} is being resolved.</Alert>;
  if (mine?.signed) return <Alert kind="ok" title="You have signed">Round {unit.round}{mine.objection ? ", with an objection" : ""}. Waiting for the other agents.</Alert>;

  return (
    <Panel
      title={`Your decision as ${partyName} agent`}
      description={`Compare the on-chain figures and the scanned ${unit.form} form with what you witnessed. Your signature is bound to figures hash ${shortHash(unit.figuresHash)}.`}
      data-testid="agent-actions"
    >
      {mode === null ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" isDisabled={busy} onPress={() => sendTx("Sign result", (c) => c.verification.signResult(lvl, unit.unitId, unit.figuresHash))}>
            Sign — figures are correct
          </Button>
          <Button variant="secondary" isDisabled={busy} onPress={() => setMode("objection")}>
            Sign with objection
          </Button>
          <Button variant="danger-soft" isDisabled={busy} onPress={() => setMode("dispute")}>
            Reject — raise dispute
          </Button>
        </div>
      ) : null}
      {mode === "objection" ? (
        <div className="flex flex-col gap-3">
          <Alert kind="info">An objection is recorded permanently on-chain but does not stop the collation (the figures tally). Raise a dispute instead when the figures differ from the physical form.</Alert>
          <NoteField label="Objection" value={reason} onChange={setReason} isRequired />
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" isDisabled={busy || !reason.trim()} onPress={() => sendTx("Sign with objection", (c) => c.verification.signWithObjection(lvl, unit.unitId, unit.figuresHash, reason))}>
              Sign with objection
            </Button>
            <Button variant="tertiary" onPress={() => setMode(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {mode === "dispute" ? (
        <div className="flex flex-col gap-3">
          <Alert kind="danger" title="A dispute freezes this result immediately">
            The officer must resolve it and every agent must sign again before it can move upward.
          </Alert>
          <NoteField label="Reason" value={reason} onChange={setReason} isRequired placeholder="e.g. The signed EC8A form shows 310 votes for PA, the upload says 300." />
          <IpfsUpload label="Evidence (photo of the form, optional)" purpose="evidence" uploader={wallet?.address} onUploaded={setEvidenceCid} />
          <div className="flex flex-wrap gap-2">
            <ConfirmButton
              variant="danger"
              status="danger"
              isDisabled={busy || !reason.trim()}
              title="Raise a dispute and freeze this result?"
              body={
                <>
                  <p>Your reason will be recorded permanently on-chain:</p>
                  <blockquote className="mt-2 border-s-2 border-border ps-2 italic">“{reason}”</blockquote>
                </>
              }
              confirmLabel="Raise dispute"
              onConfirm={() => sendTx("Raise dispute", (c) => c.verification.raiseDispute(lvl, unit.unitId, reason, evidenceCid))}
            >
              Raise dispute
            </ConfirmButton>
            <Button variant="tertiary" onPress={() => setMode(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}

export function UnitInfo({ unit }) {
  const items = [];
  if (unit.level === "PollingUnit") {
    items.push(["Code", <span className="font-mono" key="code">{unit.code}</span>], ["Ward", `#${unit.wardId}`], ["Registered voters (INEC register)", unit.registeredVoters], ["Presiding officer", <Address value={unit.presidingOfficer} copy key="po" />]);
  } else {
    items.push(["Collation officer", <Address value={unit.officer} copy key="co" />]);
    if (unit.pollingUnitIds) items.push(["Polling units", unit.pollingUnitIds.length]);
    if (unit.wardIds) items.push(["Wards", unit.wardIds.length]);
  }
  items.push(["Required signatures", `${unit.requiredSignatures} (one per contesting party)`]);
  return (
    <Panel title="Unit details">
      <KeyValues items={items} />
    </Panel>
  );
}

export { STATE_UNIT_ID, shortAddr };
