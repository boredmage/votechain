import { useApp, usePolled } from "../hooks/useApp.jsx";
import { api } from "../lib/api.js";
import { STATE_UNIT_ID } from "../lib/constants.js";
import { fmtTime, shortAddr } from "../lib/format.js";
import { Alert, Empty, StatusBadge, FiguresTable, Panel, Checklist, ConfirmButton, Columns } from "../components/common.jsx";
import { useUnit } from "../components/geography.jsx";
import { UnitHeader, SignaturesPanel } from "../components/unit.jsx";
import { NotificationsPanel } from "../components/layout.jsx";
import { DeclarationCard } from "./PublicPortal.jsx";

/** State result publisher: may only trigger declareResult() once the auditor's signature is on-chain. */
export function PublisherPortal() {
  const { election, sendTx, busy } = useApp();
  const audit = usePolled(() => api.audit(), [], 6000);
  const state = useUnit("State", STATE_UNIT_ID);
  const candidates = election?.candidates.map((c) => ({ ...c, acronym: election.parties.find((p) => p.id === c.partyId)?.acronym })) ?? [];
  const a = audit.data;
  const stateApproved = state.data?.status === "Approved" || state.data?.status === "Declared";
  const declare = () => sendTx("Declare final result", (c) => c.audit.declareResult());

  return (
    <div className="flex flex-col gap-5" data-testid="publisher-portal">
      {a?.declaration?.declared ? <DeclarationCard declaration={a.declaration} audit={a.audit} candidates={candidates} election={election} /> : null}
      <Columns
        main={
          <>
            <Panel title="Declaration gate" description="All three conditions are enforced by the AuditDeclaration contract; no role, including INEC, can bypass them.">
              <div className="flex flex-col gap-4">
                <Checklist
                  items={[
                    { done: stateApproved, content: <>State collation approved by all state party agents {state.data ? <StatusBadge status={state.data.status} /> : null}</> },
                    { done: a?.audit.approved, content: <>Independent auditor's verification signature recorded {a?.audit.approved ? <span className="text-muted">({shortAddr(a.audit.auditor)}, {fmtTime(a.audit.approvedAt)})</span> : null}</> },
                    { done: a?.declaration?.declared, content: "Final declaration recorded on-chain" },
                  ]}
                />
                {!a?.audit.approved ? <Alert kind="warn" title="Waiting for the auditor">declareResult() reverts with AuditNotApproved until the auditor signs.</Alert> : null}
                {a?.audit.approved && !a?.declaration?.declared ? (
                  <div>
                    <ConfirmButton
                      variant="primary"
                      status="accent"
                      isDisabled={busy}
                      title="Declare the final result?"
                      body="The audited state figures become the declared result of the election. This is permanent and ends the election lifecycle."
                      confirmLabel="Declare result"
                      onConfirm={declare}
                    >
                      Declare the final result
                    </ConfirmButton>
                  </div>
                ) : null}
              </div>
            </Panel>
            {state.data?.figures ? (
              <Panel title="State figures to be declared">
                <FiguresTable label="EC8D state figures" figures={state.data.figures} candidates={candidates} />
              </Panel>
            ) : (
              <Panel title="State figures">
                <Empty>The state collation has not been confirmed yet.</Empty>
              </Panel>
            )}
          </>
        }
        side={
          <>
            {state.data ? (
              <>
                <UnitHeader unit={state.data} />
                <SignaturesPanel unit={state.data} />
              </>
            ) : null}
            <NotificationsPanel />
          </>
        }
      />
    </div>
  );
}
