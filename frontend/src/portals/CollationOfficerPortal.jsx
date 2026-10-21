import { useEffect, useState } from "react";
import { Button, Table } from "@heroui/react";
import { useApp, usePolled } from "../hooks/useApp.jsx";
import { env } from "../lib/env.js";
import { api } from "../lib/api.js";
import { LEVEL_INDEX, LEVEL_LABEL, FORMS, STATE_UNIT_ID } from "../lib/constants.js";
import { emptyFigures, toChainFigures, isComplete } from "../lib/figures.js";
import { fmtNum } from "../lib/format.js";
import { Alert, Empty, Badge, StatusBadge, FiguresForm, FiguresTable, IpfsUpload, Loading, Panel, Columns } from "../components/common.jsx";
import { useUnit } from "../components/geography.jsx";
import { UnitHeader, UnitFigures, UnitForm, SignaturesPanel, DisputesPanel, UnitInfo, unitTitle } from "../components/unit.jsx";
import { NotificationsPanel, ActivityFeed } from "../components/layout.jsx";

/**
 * Ward collation officer (EC8B), LGA collation officer (EC8C) and state returning officer (EC8D)
 * share this portal: it lists the lower-level results, shows the contract-computed aggregate and
 * lets the officer declare the totals written on the physical form. A mismatch is recorded
 * on-chain and the collation stays blocked (Section 3.5.4).
 */
export function CollationOfficerPortal() {
  const { role, election, sendTx, busy, wallet } = useApp();
  const level = role.level;
  const unitId = level === "State" ? STATE_UNIT_ID : role.unitId;
  const lvl = LEVEL_INDEX[level];
  const unit = useUnit(level, unitId);
  const lower = usePolled(() => api.geography(), [], 6000);
  const candidates = election?.candidates.map((c) => ({ ...c, acronym: election.parties.find((p) => p.id === c.partyId)?.acronym })) ?? [];
  const [declared, setDeclared] = useState(emptyFigures(candidates.length));
  const [cid, setCid] = useState("");
  const [precheck, setPrecheck] = useState(null);

  useEffect(() => {
    if (candidates.length && declared.candidateVotes.length !== candidates.length) setDeclared(emptyFigures(candidates.length));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates.length]);

  useEffect(() => {
    setPrecheck(null);
    if (!isComplete(declared) || !unit.data?.aggregate?.complete) return;
    const t = setTimeout(() => {
      api
        .checkCollation(lvl, unitId, declared) // plain strings/numbers: BigInt is not JSON-serialisable
        .then(setPrecheck)
        .catch((e) => setPrecheck({ error: e.message }));
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(declared), unit.data?.aggregate?.complete]);

  if (!unit.data) return <Loading>Loading your collation unit…</Loading>;
  const u = unit.data;
  const agg = u.aggregate;
  const canConfirm = (u.status === "Open" || u.status === "Frozen") && agg?.complete && (election?.phase === "Active" || election?.phase === "Collation");
  const lowerLevel = ["PollingUnit", "Ward", "LGA"][lvl - 1];
  const lowerRows = lowerUnits(lower.data, level, unitId);
  const approvedCount = lowerRows?.filter((r) => r.status === "Approved" || r.cancelled).length ?? 0;

  const confirm = () => sendTx(`Confirm ${u.form} collation`, (c) => c.collation.confirmCollation(lvl, unitId, toChainFigures(declared), cid));
  const fillFromComputed = () => setDeclared({ ...agg.figures, candidateVotes: [...agg.figures.candidateVotes] });
  const blocker = !isComplete(declared) ? "Fill in every total." : !cid ? `Upload the photograph of the signed ${u.form} form.` : null;

  return (
    <div className="flex flex-col gap-5" data-testid="collation-portal">
      <UnitHeader unit={u} />
      <Columns
        main={
          <>
            <Panel
              title={`${LEVEL_LABEL[lowerLevel]} results feeding this collation`}
              actions={agg?.complete ? <Badge kind="ok">All approved</Badge> : <Badge kind="warn">Waiting on unit #{agg?.blockingUnitId}</Badge>}
              description={lowerRows ? `${approvedCount} of ${lowerRows.length} approved or cancelled` : null}
            >
              {lowerRows ? (
                lowerRows.length ? (
                  <Table variant="secondary">
                    <Table.ScrollContainer>
                      <Table.Content aria-label={`${LEVEL_LABEL[lowerLevel]} results`} className="min-w-[320px]">
                        <Table.Header>
                          <Table.Column isRowHeader>Unit</Table.Column>
                          <Table.Column>Status</Table.Column>
                        </Table.Header>
                        <Table.Body>
                          {lowerRows.map((r) => (
                            <Table.Row key={r.id} id={String(r.id)}>
                              <Table.Cell>
                                {r.code ? <span className="me-2 font-mono text-xs text-muted">{r.code}</span> : null}
                                {r.name}
                              </Table.Cell>
                              <Table.Cell>{r.cancelled ? <Badge kind="warn">Cancelled</Badge> : <StatusBadge status={r.status} />}</Table.Cell>
                            </Table.Row>
                          ))}
                        </Table.Body>
                      </Table.Content>
                    </Table.ScrollContainer>
                  </Table>
                ) : (
                  <Empty>No units below this one.</Empty>
                )
              ) : (
                <Loading />
              )}
            </Panel>

            {agg?.complete ? (
              <Panel title="Aggregate computed by the smart contract" description={`Field-by-field sum of every approved ${LEVEL_LABEL[lowerLevel].toLowerCase()} result (cancelled units excluded).`}>
                <FiguresTable label="Computed aggregate" figures={agg.figures} candidates={candidates} />
              </Panel>
            ) : null}

            {canConfirm ? (
              <Panel
                title={u.status === "Frozen" ? `Re-confirm ${u.form} (dispute correction)` : `Declare ${u.form} totals`}
                description={`Enter the totals exactly as written on the physical ${u.form} form. The contract requires them to equal the computed aggregate — zero tolerance. A mismatch is recorded permanently as an alert and blocks the collation.`}
              >
                <div className="flex flex-col gap-5">
                  {u.status === "Frozen" ? (
                    <Alert kind="warn" title={`Frozen by dispute #${u.activeDisputeId}`}>
                      Re-confirming with a new form scan resolves it as a correction and opens a new signing round.
                    </Alert>
                  ) : null}
                  {env.DEMO_MODE ? (
                  <div className="flex flex-wrap items-center gap-3 rounded-sm bg-default/50 p-3">
                    <Button size="sm" variant="secondary" onPress={fillFromComputed}>
                      Fill from computed aggregate
                    </Button>
                    <span className="text-xs text-muted">Demo mode only — a real officer types the totals from the signed form.</span>
                  </div>
                  ) : null}
                  <FiguresForm value={declared} onChange={setDeclared} candidates={candidates} />
                  {precheck && !precheck.error ? (
                    precheck.ok ? (
                      <Alert kind="ok" title="Totals match the computed aggregate" />
                    ) : (
                      <Alert kind="danger" title={`Mismatch on ${precheck.field}${precheck.field === "CandidateVotes" ? ` (candidate #${precheck.candidateIndex})` : ""}`}>
                        Declared {fmtNum(precheck.declared)} vs computed {fmtNum(precheck.computed)}. Submitting will record a mismatch alert on-chain.
                      </Alert>
                    )
                  ) : null}
                  <IpfsUpload label={`Photograph of the signed ${u.form} form`} required purpose={u.form.toLowerCase()} uploader={wallet?.address} onUploaded={setCid} />
                  <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
                    <Button variant={precheck && !precheck.error && !precheck.ok ? "danger" : "primary"} isDisabled={busy || Boolean(blocker)} onPress={confirm} data-testid="confirm-collation">
                      Confirm collation on-chain
                    </Button>
                    {blocker ? <span className="text-sm text-muted">{blocker}</span> : null}
                  </div>
                </div>
              </Panel>
            ) : null}
            {!agg?.complete && u.status === "Open" ? (
              <Alert kind="info" title="Not ready to collate">
                Collation opens automatically once every {LEVEL_LABEL[lowerLevel].toLowerCase()} result below is approved by its party agents.
              </Alert>
            ) : null}
            {u.status === "PendingSignatures" ? (
              <Alert kind="info" title={`${u.form} totals confirmed`}>
                {LEVEL_LABEL[level]} party agents are reviewing and signing.
              </Alert>
            ) : null}
            {u.status === "Approved" ? <Alert kind="ok" title="Collation approved">Approved by every {LEVEL_LABEL[level].toLowerCase()} party agent and forwarded upward.</Alert> : null}
            {u.figures ? <UnitFigures unit={u} compare={agg?.complete ? agg.figures : null} compareLabel="Recomputed" /> : null}
            {u.formCid ? <UnitForm unit={u} /> : null}
          </>
        }
        side={
          <>
            {u.mismatchAttempts ? (
              <Alert kind="danger" title="Mismatch alerts on record">
                {u.mismatchAttempts} mismatch alert(s) are permanently recorded against this unit.
              </Alert>
            ) : null}
            <SignaturesPanel unit={u} />
            <DisputesPanel unit={u} />
            <UnitInfo unit={u} />
            <NotificationsPanel />
          </>
        }
      />
      <ActivityFeed level={lvl} unitId={unitId} limit={15} />
    </div>
  );
}

function lowerUnits(geo, level, unitId) {
  if (!geo) return null;
  if (level === "Ward") {
    for (const lga of geo.lgas) for (const w of lga.wards) if (w.id === unitId) return w.pollingUnits;
    return [];
  }
  if (level === "LGA") {
    const lga = geo.lgas.find((l) => l.id === unitId);
    return lga ? lga.wards : [];
  }
  return geo.lgas.map((l) => ({ id: l.id, name: `${l.name} LGA`, status: l.status }));
}

export { unitTitle, FORMS };
