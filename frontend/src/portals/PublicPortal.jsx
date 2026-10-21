import { useEffect, useRef, useState } from "react";
import { Card } from "@heroui/react";
import { useApp, usePolled } from "../hooks/useApp.jsx";
import { api } from "../lib/api.js";
import { fmtNum, fmtTime, pct } from "../lib/format.js";
import { Stat, Alert, Empty, FiguresTable, KeyValues, Panel, StatusBadge, Address, HashValue, Loading } from "../components/common.jsx";
import { GeographyTree, useUnit } from "../components/geography.jsx";
import { UnitHeader, UnitFigures, UnitForm, SignaturesPanel, DisputesPanel, UnitInfo } from "../components/unit.jsx";
import { ActivityFeed } from "../components/layout.jsx";

/** Read-only portal: anyone can verify the full chain without a wallet (Section 6.5). */
export function PublicPortal() {
  const { election } = useApp();
  const [selected, setSelected] = useState(null);
  const unit = useUnit(selected?.level, selected?.id);
  const audit = usePolled(() => api.audit(), [], 8000);
  const candidates = election?.candidates.map((c) => ({ ...c, acronym: election.parties.find((p) => p.id === c.partyId)?.acronym }));
  const detailRef = useRef(null);

  // on narrow screens the detail column sits below the tree — bring it into view after a pick
  useEffect(() => {
    if (selected && window.matchMedia("(max-width: 1023px)").matches) detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selected]);

  return (
    <div className="flex flex-col gap-5" data-testid="public-portal">
      <Card className="w-full">
        <Card.Header className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <Card.Title className="text-xl font-semibold tracking-tight sm:text-2xl">{election?.name ?? "VoteChain election"}</Card.Title>
            <Card.Description className="mt-1 text-sm">
              {election?.electionType} · {election?.stateName} State. Every figure, signature, dispute and declaration below is read directly from the blockchain — no account needed.
            </Card.Description>
          </div>
          {election ? <StatusBadge status={election.declared ? "Declared" : election.stateStatus} size="md" /> : null}
        </Card.Header>
        <Card.Content>
          <div className="flex flex-wrap gap-2.5">
            <Stat label="LGAs" value={election?.counts.lgas ?? "—"} />
            <Stat label="Wards" value={election?.counts.wards ?? "—"} />
            <Stat label="Polling units" value={fmtNum(election?.counts.pollingUnits)} />
            <Stat label="Parties" value={election?.counts.parties ?? "—"} />
            <Stat label="Audit" value={election ? (election.auditApproved ? "Signed" : "Pending") : "—"} />
            <Stat label="Declared" value={election ? (election.declared ? "Yes" : "No") : "—"} />
          </div>
        </Card.Content>
      </Card>

      {audit.data?.declaration?.declared ? <DeclarationCard declaration={audit.data.declaration} audit={audit.data.audit} candidates={candidates} election={election} /> : null}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Panel title="Collation hierarchy" description="Select any unit to inspect its figures, signatures and disputes." className="lg:sticky lg:top-24 lg:max-h-[calc(100vh-7rem)] lg:self-start" contentClassName="lg:overflow-y-auto">
          <GeographyTree selected={selected} onSelect={setSelected} />
        </Panel>
        <div ref={detailRef} className="flex min-w-0 scroll-mt-24 flex-col gap-5">
          {!selected ? (
            <Panel title="Verify a result">
              <ol className="grid gap-2 text-sm text-muted">
                <li>1. Pick the state, an LGA, a ward or a polling unit from the hierarchy.</li>
                <li>2. Compare the on-chain figures with the scanned form and the sum of the level below.</li>
                <li>3. Check which party agents signed, and read any dispute and how it was resolved.</li>
              </ol>
            </Panel>
          ) : null}
          {selected && !unit.data ? <Loading>Loading unit…</Loading> : null}
          {selected && unit.data ? (
            <>
              <UnitHeader unit={unit.data} />
              <UnitFigures unit={unit.data} compare={unit.data.aggregate?.complete && unit.data.figures ? unit.data.aggregate.figures : null} compareLabel="Recomputed from level below" />
              <SignaturesPanel unit={unit.data} />
              <DisputesPanel unit={unit.data} />
              <UnitForm unit={unit.data} />
              <UnitInfo unit={unit.data} />
            </>
          ) : null}
        </div>
      </div>
      <ActivityFeed limit={30} />
    </div>
  );
}

export function DeclarationCard({ declaration, audit, candidates }) {
  const winner = candidates?.[declaration.winnerCandidateIndex];
  return (
    <Panel
      data-testid="declaration"
      className="border-2 border-accent/50"
      title={
        <>
          <span className="text-lg">Declared result</span> <StatusBadge status="Declared" />
        </>
      }
      description={`Declared on ${fmtTime(declaration.declaredAt)} in block ${declaration.blockNumber}.`}
    >
      <div className="flex flex-col gap-5">
        {declaration.tie ? <Alert kind="warn" title="Tie">The two leading candidates are tied; no winner is recorded on-chain.</Alert> : null}
        {!declaration.tie && winner ? (
          <div className="rounded-sm bg-accent-soft p-4">
            <p className="text-xs font-medium uppercase tracking-wider text-muted">Winner</p>
            <p className="mt-1 text-2xl font-semibold tracking-tight">
              {winner.name} <span className="text-base font-medium text-muted">({winner.acronym})</span>
            </p>
            <p className="mt-1 text-sm">
              {fmtNum(declaration.winnerVotes)} valid votes — {pct(declaration.winnerVotes, declaration.figures.validVotes)} of valid votes
            </p>
          </div>
        ) : null}
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
          <FiguresTable label="Declared state figures" figures={declaration.figures} candidates={candidates} />
          <KeyValues
            items={[
              ["Declared by", <Address value={declaration.publisher} copy key="p" />],
              ["State result hash", <HashValue value={declaration.stateResultHash} key="h" />],
              ["Audited by", <Address value={audit?.auditor} copy key="a" />],
              ["Audit report CID", audit?.reportCid ? <HashValue value={audit.reportCid} key="c" /> : "—"],
              ["Audit signature", <HashValue value={audit?.signature} key="s" />],
            ]}
          />
        </div>
      </div>
    </Panel>
  );
}

export { Empty };
