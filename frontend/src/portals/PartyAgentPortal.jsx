import { useApp } from "../hooks/useApp.jsx";
import { LEVEL_INDEX } from "../lib/constants.js";
import { Alert, Loading, Columns } from "../components/common.jsx";
import { useUnit } from "../components/geography.jsx";
import { UnitHeader, UnitFigures, UnitForm, SignaturesPanel, DisputesPanel, AgentActions, UnitInfo } from "../components/unit.jsx";
import { NotificationsPanel, ActivityFeed } from "../components/layout.jsx";

/** Review / sign / dispute portal for a party agent at any of the four levels (Section 3.5.3). */
export function PartyAgentPortal() {
  const { role, election } = useApp();
  const unit = useUnit(role.level, role.unitId);
  if (!unit.data) return <Loading>Loading your assigned unit…</Loading>;
  const u = unit.data;
  const party = election?.parties.find((p) => p.id === role.partyId);
  return (
    <div className="flex flex-col gap-5" data-testid="agent-portal">
      <Alert kind="info" title={`${party?.name ?? "Party"} (${party?.acronym ?? "—"}) agent`}>
        You represent your party for this {u.level === "PollingUnit" ? "polling unit" : u.level.toLowerCase()} only; the contract rejects any action elsewhere.
      </Alert>
      <UnitHeader unit={u} />
      <Columns
        main={
          <>
            <AgentActions unit={u} />
            <UnitFigures unit={u} compare={u.levelIndex > 0 && u.aggregate?.complete && u.figures ? u.aggregate.figures : null} compareLabel="Sum of approved lower level" />
            <UnitForm unit={u} />
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
      <ActivityFeed level={LEVEL_INDEX[u.level]} unitId={u.unitId} limit={15} />
    </div>
  );
}
