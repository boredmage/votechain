import { useEffect, useState } from "react";
import { Button } from "@heroui/react";
import { useApp } from "../hooks/useApp.jsx";
import { emptyFigures, toChainFigures, isComplete, checkFigures } from "../lib/figures.js";
import { Alert, FiguresForm, IpfsUpload, Loading, Panel, Columns } from "../components/common.jsx";
import { useUnit } from "../components/geography.jsx";
import { UnitHeader, UnitFigures, UnitForm, SignaturesPanel, DisputesPanel, UnitInfo } from "../components/unit.jsx";
import { NotificationsPanel, ActivityFeed } from "../components/layout.jsx";

/** EC8A upload portal for the presiding officer of one polling unit (Section 3.7.1). */
export function PresidingOfficerPortal() {
  const { role, election, sendTx, busy, wallet } = useApp();
  const unit = useUnit("PollingUnit", role.unitId);
  const candidates = election?.candidates.map((c) => ({ ...c, acronym: election.parties.find((p) => p.id === c.partyId)?.acronym })) ?? [];
  const [figures, setFigures] = useState(emptyFigures(candidates.length));
  const [cid, setCid] = useState("");

  useEffect(() => {
    if (candidates.length && figures.candidateVotes.length !== candidates.length) setFigures(emptyFigures(candidates.length));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates.length]);

  // when correcting after a dispute, start from the current on-chain figures
  useEffect(() => {
    if (unit.data?.status === "Frozen" && unit.data.figures && !isComplete(figures)) {
      setFigures({ ...unit.data.figures, candidateVotes: [...unit.data.figures.candidateVotes] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unit.data?.status]);

  if (!unit.data) return <Loading>Loading your polling unit…</Loading>;
  const u = unit.data;
  const canSubmit = u.status === "Open" && election?.phase === "Active" && !u.cancelled;
  const canResubmit = u.status === "Frozen" && (election?.phase === "Active" || election?.phase === "Collation");
  const check = isComplete(figures) ? checkFigures(figures, candidates.length, u.registeredVoters) : null;
  const blocker = !isComplete(figures) ? "Fill in every figure." : !check?.ok ? "Fix the failing check above." : !cid ? "Upload the photograph of the signed form." : null;

  const submit = () =>
    sendTx(canResubmit ? "Resubmit corrected EC8A" : "Submit EC8A result", (c) =>
      canResubmit ? c.upload.resubmitResult(u.unitId, toChainFigures(figures), cid) : c.upload.submitResult(u.unitId, toChainFigures(figures), cid),
    );

  return (
    <div className="flex flex-col gap-5" data-testid="po-portal">
      <UnitHeader unit={u} />
      <Columns
        main={
          <>
            {canSubmit || canResubmit ? (
              <Panel
                title={canResubmit ? "Correct the figures (dispute resolution)" : "Upload EC8A result figures"}
                description={canResubmit ? null : "Enter the figures exactly as written on the signed EC8A form. The smart contract re-runs these checks and rejects any inconsistency."}
              >
                <div className="flex flex-col gap-5">
                  {canResubmit ? (
                    <Alert kind="warn" title={`Frozen by dispute #${u.activeDisputeId}`}>
                      Submitting corrected figures resolves the dispute and opens a new signing round for every agent.
                    </Alert>
                  ) : null}
                  <FiguresForm value={figures} onChange={setFigures} candidates={candidates} registerValue={u.registeredVoters} />
                  <IpfsUpload label="Photograph of the signed EC8A form" required purpose="ec8a" uploader={wallet?.address} onUploaded={setCid} />
                  <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
                    <Button variant="primary" isDisabled={busy || Boolean(blocker)} onPress={submit} data-testid="submit-ec8a">
                      {canResubmit ? "Resubmit corrected figures" : "Submit to blockchain"}
                    </Button>
                    {blocker ? <span className="text-sm text-muted">{blocker}</span> : <span className="text-sm text-muted">Ready — this is recorded permanently.</span>}
                  </div>
                </div>
              </Panel>
            ) : null}
            {u.status === "PendingSignatures" ? <Alert kind="info" title="Figures are on-chain">Party agents have been notified and are reviewing them.</Alert> : null}
            {u.status === "Approved" ? <Alert kind="ok" title="Result locked">Every registered party agent has signed. It has been forwarded to the ward collation queue.</Alert> : null}
            {u.status === "Resolved" || u.status === "Escalated" ? <Alert kind="warn" title="Waiting">Awaiting the disputing agent{u.status === "Escalated" ? " and the auditor" : ""}.</Alert> : null}
            {election?.phase !== "Active" && u.status === "Open" ? (
              <Alert kind="warn" title="Uploads closed">
                First-time uploads are only accepted while the election is Active (current phase: {election?.phase}).
              </Alert>
            ) : null}
            {u.figures ? <UnitFigures unit={u} /> : null}
            {u.formCid ? <UnitForm unit={u} /> : null}
          </>
        }
        side={
          <>
            <SignaturesPanel unit={u} />
            <DisputesPanel unit={u} />
            <UnitInfo unit={u} />
            <NotificationsPanel />
          </>
        }
      />
      <ActivityFeed level={0} unitId={u.unitId} limit={15} />
    </div>
  );
}
