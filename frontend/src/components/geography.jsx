import { useEffect, useMemo, useState } from "react";
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
/** Polling units a filter lists at once: the state has 6,390 and a common word matches thousands. */
const FILTER_ROWS_SHOWN = 200;
const isApproved = (u) => u.status === "Approved" || u.status === "Declared";
/** Keeps a row without a chevron in line with the rows that have one. */
const Spacer = () => <span className="size-7 shrink-0" aria-hidden />;

/** Chevron button that opens or closes one branch of the tree. */
function Toggle({ open, onToggle, label, testId }) {
  return (
    <button
      type="button"
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-muted transition-colors hover:bg-default hover:text-foreground"
      aria-expanded={open}
      aria-label={`Expand ${label}`}
      onClick={onToggle}
      data-testid={testId}
    >
      <svg viewBox="0 0 24 24" className={`size-4 transition-transform ${open ? "rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M9 6l6 6-6 6" />
      </svg>
    </button>
  );
}

/** "9/10 approved" — how much of a branch has been approved, readable while it is collapsed. Cancelled units are not expected to report. */
function Progress({ units }) {
  const expected = units.filter((u) => !u.cancelled);
  if (!expected.length) return null;
  return (
    <span className="ms-auto shrink-0 text-xs tabular-nums text-muted">
      {expected.filter(isApproved).length}/{expected.length} approved
    </span>
  );
}

/**
 * LGA → ward → polling-unit tree with live statuses and a text filter. Branches start collapsed (a
 * state has thousands of polling units); a filter opens every match, and picking a unit opens the
 * branch that holds it.
 */
export function GeographyTree({ selected, onSelect, filter }) {
  const { data, error } = usePolled(() => api.geography(), [], 6000);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(() => new Set());
  // one letter matches nearly every name: wait for two before filtering thousands of units
  const query = q.trim().length >= 2 ? q.trim().toLowerCase() : "";

  const { lgas, cut } = useMemo(() => {
    if (!data) return { lgas: [], cut: false };
    if (!query) return { lgas: data.lgas, cut: false };
    // a filter lists its matches open; past FILTER_ROWS_SHOWN polling units the rest are left out
    let room = FILTER_ROWS_SHOWN;
    let cut = false;
    const take = (pus) => {
      if (pus.length > room) cut = true;
      const kept = pus.slice(0, room);
      room -= kept.length;
      return kept;
    };
    const found = data.lgas
      .map((lga) => {
        const lgaHit = matches(query, lga.name, `${lga.name} lga`);
        const wards = lga.wards
          .map((w) => {
            const wardHit = lgaHit || matches(query, w.name);
            const pus = take(wardHit ? w.pollingUnits : w.pollingUnits.filter((pu) => matches(query, pu.name, pu.code)));
            return wardHit || pus.length ? { ...w, pollingUnits: pus } : null;
          })
          .filter(Boolean);
        return lgaHit || wards.length ? { ...lga, wards } : null;
      })
      .filter(Boolean);
    return { lgas: found, cut };
  }, [data, query]);

  // the branch that holds the selected unit
  const selectedPath = useMemo(() => {
    const path = new Set();
    if (!data || !selected || selected.level === "State" || selected.level === "LGA") return path;
    for (const lga of data.lgas) {
      for (const w of lga.wards) {
        const hit = selected.level === "Ward" ? w.id === selected.id : w.pollingUnits.some((pu) => pu.id === selected.id);
        if (!hit) continue;
        path.add(`lga-${lga.id}`);
        if (selected.level === "PollingUnit") path.add(`ward-${w.id}`);
      }
    }
    return path;
  }, [data, selected]);

  // picking a unit opens its branch; it can be closed again like any other
  const pathKey = [...selectedPath].join(" ");
  useEffect(() => {
    if (pathKey) setOpen((prev) => new Set([...prev, ...pathKey.split(" ")]));
  }, [pathKey]);

  if (error) return <Empty>{error}</Empty>;
  if (!data) return <Loading>Loading geography…</Loading>;
  const show = (level) => !filter || filter.includes(level);
  const puCount = data.lgas.reduce((n, l) => n + l.wards.reduce((m, w) => m + w.pollingUnits.length, 0), 0);
  // a small election (a handful of units) is shown whole; a filter shows only matches, so those open too
  const collapsible = puCount > 30 && !query;
  const isOpen = (key) => !collapsible || open.has(key);
  const toggle = (key) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

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
          <li className="flex min-w-0 items-center gap-1">
            {collapsible ? <Spacer /> : null}
            <div className="min-w-0 flex-1">
              <Node selected={selected} onSelect={onSelect} level="State" id={1} testId="tree-state">
                <strong className="font-semibold">{data.stateName ?? "Oyo"} State</strong> <StatusBadge status={data.stateStatus} />
              </Node>
            </div>
          </li>
        ) : null}
        {lgas.map((lga) => {
          const lgaKey = `lga-${lga.id}`;
          const lgaOpen = isOpen(lgaKey);
          return (
            <li key={lga.id}>
              <div className="flex min-w-0 items-center gap-1">
                {collapsible ? <Toggle open={lgaOpen} onToggle={() => toggle(lgaKey)} label={`${lga.name} LGA`} testId={`tree-toggle-lga-${lga.id}`} /> : null}
                <div className="min-w-0 flex-1">
                  {show("LGA") ? (
                    <Node selected={selected} onSelect={onSelect} level="LGA" id={lga.id} testId={`tree-lga-${lga.id}`}>
                      <strong className="font-semibold">{lga.name} LGA</strong> <StatusBadge status={lga.status} />
                      {collapsible ? <Progress units={lga.wards.flatMap((w) => w.pollingUnits)} /> : null}
                    </Node>
                  ) : (
                    <span className="px-2 text-sm text-muted">{lga.name} LGA</span>
                  )}
                </div>
              </div>
              {lgaOpen ? (
                <ul>
                  {lga.wards.map((w) => {
                    const wardKey = `ward-${w.id}`;
                    const wardOpen = show("PollingUnit") && isOpen(wardKey);
                    return (
                      <li key={w.id}>
                        <div className="flex min-w-0 items-center gap-1">
                          {show("PollingUnit") && collapsible ? <Toggle open={wardOpen} onToggle={() => toggle(wardKey)} label={`${w.name} ward`} testId={`tree-toggle-ward-${w.id}`} /> : null}
                          <div className="min-w-0 flex-1">
                            {show("Ward") ? (
                              <Node selected={selected} onSelect={onSelect} level="Ward" id={w.id} testId={`tree-ward-${w.id}`}>
                                <span>{w.name}</span> <StatusBadge status={w.status} />
                                {collapsible ? <Progress units={w.pollingUnits} /> : null}
                              </Node>
                            ) : (
                              <span className="px-2 text-sm text-muted">{w.name}</span>
                            )}
                          </div>
                        </div>
                        {wardOpen ? (
                          <ul>
                            {w.pollingUnits.map((pu) => (
                              <li key={pu.id} className="flex min-w-0 items-center gap-1">
                                {collapsible ? <Spacer /> : null}
                                <div className="min-w-0 flex-1">
                                  <Node selected={selected} onSelect={onSelect} level="PollingUnit" id={pu.id} testId={`tree-pu-${pu.id}`}>
                                    <span className="font-mono text-xs text-muted">{pu.code}</span>
                                    <span className="min-w-0">{pu.name}</span>
                                    {pu.cancelled ? <Badge kind="warn">Cancelled</Badge> : <StatusBadge status={pu.status} />}
                                  </Node>
                                </div>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </li>
          );
        })}
        {cut ? (
          <li>
            <Empty>Showing the first {FILTER_ROWS_SHOWN} matching polling units. Keep typing to narrow.</Empty>
          </li>
        ) : null}
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
