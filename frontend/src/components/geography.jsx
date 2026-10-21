import { useMemo, useState } from "react";
import { SearchField } from "@heroui/react";
import { useApp, usePolled } from "../hooks/useApp.jsx";
import { api } from "../lib/api.js";
import { StatusBadge, Badge, Empty, Loading } from "./common.jsx";

function Node({ selected, onSelect, level, id, children, testId }) {
  const isSel = selected && selected.level === level && selected.id === id;
  const interactive = Boolean(onSelect);
  const cls = `flex w-full min-w-0 flex-wrap items-center gap-2 rounded-sm px-2 py-1 text-start text-sm transition-colors ${
    isSel ? "bg-accent-soft text-foreground ring-1 ring-accent/40" : interactive ? "hover:bg-default" : ""
  }`;
  if (!interactive) return <div className={cls}>{children}</div>;
  return (
    <button type="button" className={cls} aria-pressed={isSel} onClick={() => onSelect({ level, id })} data-testid={testId}>
      {children}
    </button>
  );
}

const matches = (q, ...vals) => vals.some((v) => String(v ?? "").toLowerCase().includes(q));

/** LGA → ward → polling-unit tree with live statuses and a text filter. */
export function GeographyTree({ selected, onSelect, filter }) {
  const { data, error } = usePolled(() => api.geography(), [], 6000);
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();

  const lgas = useMemo(() => {
    if (!data) return [];
    if (!query) return data.lgas;
    return data.lgas
      .map((lga) => {
        const lgaHit = matches(query, lga.name, `${lga.name} lga`);
        const wards = lga.wards
          .map((w) => {
            const wardHit = lgaHit || matches(query, w.name);
            const pus = wardHit ? w.pollingUnits : w.pollingUnits.filter((pu) => matches(query, pu.name, pu.code));
            return wardHit || pus.length ? { ...w, pollingUnits: pus } : null;
          })
          .filter(Boolean);
        return lgaHit || wards.length ? { ...lga, wards } : null;
      })
      .filter(Boolean);
  }, [data, query]);

  if (error) return <Empty>{error}</Empty>;
  if (!data) return <Loading>Loading geography…</Loading>;
  const show = (level) => !filter || filter.includes(level);
  const puCount = data.lgas.reduce((n, l) => n + l.wards.reduce((m, w) => m + w.pollingUnits.length, 0), 0);

  return (
    <div className="flex flex-col gap-3">
      {puCount > 6 ? (
        <SearchField variant="secondary" aria-label="Filter units" value={q} onChange={setQ} className="w-full">
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder="Filter by LGA, ward, polling-unit name or code" />
            <SearchField.ClearButton />
          </SearchField.Group>
        </SearchField>
      ) : null}
      <ul className="vc-tree flex flex-col gap-0.5" aria-label="Collation hierarchy">
        {show("State") && !query ? (
          <li>
            <Node selected={selected} onSelect={onSelect} level="State" id={1} testId="tree-state">
              <strong className="font-semibold">{data.stateName ?? "Oyo"} State</strong> <StatusBadge status={data.stateStatus} />
            </Node>
          </li>
        ) : null}
        {lgas.map((lga) => (
          <li key={lga.id}>
            {show("LGA") ? (
              <Node selected={selected} onSelect={onSelect} level="LGA" id={lga.id} testId={`tree-lga-${lga.id}`}>
                <strong className="font-semibold">{lga.name} LGA</strong> <StatusBadge status={lga.status} />
              </Node>
            ) : (
              <span className="px-2 text-sm text-muted">{lga.name} LGA</span>
            )}
            <ul>
              {lga.wards.map((w) => (
                <li key={w.id}>
                  {show("Ward") ? (
                    <Node selected={selected} onSelect={onSelect} level="Ward" id={w.id} testId={`tree-ward-${w.id}`}>
                      <span>{w.name}</span> <StatusBadge status={w.status} />
                    </Node>
                  ) : (
                    <span className="px-2 text-sm text-muted">{w.name}</span>
                  )}
                  {show("PollingUnit") ? (
                    <ul>
                      {w.pollingUnits.map((pu) => (
                        <li key={pu.id}>
                          <Node selected={selected} onSelect={onSelect} level="PollingUnit" id={pu.id} testId={`tree-pu-${pu.id}`}>
                            <span className="font-mono text-xs text-muted">{pu.code}</span>
                            <span className="min-w-0">{pu.name}</span>
                            {pu.cancelled ? <Badge kind="warn">Cancelled</Badge> : <StatusBadge status={pu.status} />}
                          </Node>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          </li>
        ))}
        {query && lgas.length === 0 ? (
          <li>
            <Empty>No unit matches “{q}”.</Empty>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

/** Fetches one unit (polled) — used by every portal that shows a unit page. */
export function useUnit(level, id) {
  const { tick } = useApp();
  return usePolled(() => (level && id ? api.unit(level, id) : Promise.resolve(null)), [level, id, tick], 5000);
}
