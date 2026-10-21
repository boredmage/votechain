import { useEffect, useRef, useState } from "react";
import { Button, Chip, ComboBox, Input, Label, ListBox, Table } from "@heroui/react";
import { useApp } from "../hooks/useApp.jsx";
import { CATEGORY_LABEL, LEVEL_LABEL, PHASES } from "../lib/constants.js";
import { shortAddr, fmtTime } from "../lib/format.js";
import { api } from "../lib/api.js";
import { Badge, Empty, Panel, Loading } from "./common.jsx";

const SCOPED = new Set(["PresidingOfficer", "PartyAgent", "WardCollationOfficer", "LgaCollationOfficer"]);
const LEVEL_NAMES = ["PollingUnit", "Ward", "LGA", "State"];

/** Order for the demo role switcher (mirrors the collation flow). */
const ROLE_GROUPS = [
  ["InecAdmin", "INEC"],
  ["PresidingOfficer", "Presiding officers (EC8A)"],
  ["PartyAgent", "Party agents"],
  ["WardCollationOfficer", "Ward collation officers (EC8B)"],
  ["LgaCollationOfficer", "LGA collation officers (EC8C)"],
  ["StateReturningOfficer", "State returning officer (EC8D)"],
  ["Auditor", "Independent auditor"],
  ["ResultPublisher", "Result publisher"],
];

function Logo() {
  return (
    <span aria-hidden className="inline-flex size-8 items-center justify-center rounded-sm bg-accent text-accent-foreground shadow-sm">
      <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12.5l4.5 4.5L19 7.5" />
      </svg>
    </span>
  );
}

export function ThemeToggle() {
  const [theme, setTheme] = useState(() => (typeof document !== "undefined" && document.documentElement.classList.contains("dark") ? "dark" : "light"));
  useEffect(() => {
    const el = document.documentElement;
    el.classList.remove("light", "dark");
    el.classList.add(theme);
    el.dataset.theme = theme;
    try {
      localStorage.setItem("votechain.theme", theme);
    } catch {
      /* storage unavailable */
    }
  }, [theme]);
  const next = theme === "dark" ? "light" : "dark";
  return (
    <Button isIconOnly size="sm" variant="ghost" aria-label={`Switch to ${next} mode`} onPress={() => setTheme(next)}>
      {theme === "dark" ? (
        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      )}
    </Button>
  );
}

/** Searchable demo-account picker, grouped by stakeholder category. */
function RoleSwitcher() {
  const { demoAccounts, connectDemoAccount } = useApp();
  if (!demoAccounts) return null;
  // flat list in collation-flow order (sectioned ComboBoxes currently crash React Aria's filter)
  const ordered = ROLE_GROUPS.flatMap(([cat]) => demoAccounts.accounts.filter((a) => a.category === cat));
  return (
    <ComboBox
      aria-label="Demo role switcher"
      className="w-full sm:w-72"
      menuTrigger="focus"
      data-testid="role-switcher"
      onSelectionChange={(key) => {
        const acct = demoAccounts.accounts.find((a) => String(a.index) === String(key));
        if (acct) connectDemoAccount(acct.privateKey);
      }}
    >
      <Label className="sr-only">Demo role switcher</Label>
      <ComboBox.InputGroup>
        <Input variant="secondary" placeholder="Act as a demo role… (type to search)" data-testid="role-switcher-input" />
        <ComboBox.Trigger />
      </ComboBox.InputGroup>
      <ComboBox.Popover className="max-h-[60vh]">
        <ListBox>
          {ordered.map((a) => (
            <ListBox.Item key={a.index} id={String(a.index)} textValue={`${a.role} #${a.index}`} data-testid={`role-option-${a.index}`}>
              <span className="flex w-full items-center justify-between gap-3">
                <span className="truncate">{a.role}</span>
                <span className="font-mono text-xs text-muted">#{a.index}</span>
              </span>
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </ComboBox.Popover>
    </ComboBox>
  );
}

export function TopBar() {
  const { wallet, role, election, config, connectWallet, disconnect, demoMode, signedIn, signIn } = useApp();
  const roleLabel = role ? CATEGORY_LABEL[role.category] ?? role.category : null;
  const scope = role && SCOPED.has(role.category) ? `${LEVEL_LABEL[role.level] ?? LEVEL_LABEL[LEVEL_NAMES[role.level]] ?? role.level} #${role.unitId}` : null;
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-surface/85 backdrop-blur-md" data-testid="topbar">
      <div className="mx-auto flex max-w-[1280px] flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <Logo />
          <div className="min-w-0 leading-tight">
            <h1 className="text-base font-semibold tracking-tight">
              VoteChain<span className="sr-only"> — electoral result collation and public verification</span>
            </h1>
            <div className="truncate text-xs text-muted">{election?.stateName ? `${election.stateName} State · ` : ""}result collation & verification</div>
          </div>
        </div>
        <div className="hidden items-center gap-2 md:flex">
          {config ? (
            <Chip size="sm" variant="secondary">
              Chain {config.chainId}
            </Chip>
          ) : null}
        </div>
        <div className="flex-1" />
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          {wallet ? (
            <>
              <div className="flex min-w-0 flex-col items-start leading-tight sm:items-end" data-testid="wallet-identity">
                <span className="text-sm font-medium">
                  {roleLabel ?? "Loading role…"}
                  {scope ? <span className="text-muted"> · {scope}</span> : null}
                </span>
                <span className="font-mono text-xs text-muted" title={wallet.address}>
                  {shortAddr(wallet.address)}
                  {wallet.kind === "demo" ? " · demo key" : ""}
                </span>
              </div>
              {!signedIn ? (
                <Button size="sm" variant="secondary" onPress={signIn}>
                  Sign in
                </Button>
              ) : null}
              <Button size="sm" variant="tertiary" onPress={disconnect} data-testid="disconnect">
                Disconnect
              </Button>
            </>
          ) : (
            <>
              {demoMode ? <RoleSwitcher /> : null}
              <Button size="sm" variant="primary" onPress={connectWallet}>
                Connect wallet
              </Button>
            </>
          )}
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

/** Four-step lifecycle indicator shown under the header. */
export function PhaseStepper() {
  const { election } = useApp();
  if (!election) return null;
  const current = election.phaseIndex ?? PHASES.indexOf(election.phase);
  return (
    <nav aria-label="Election phase" className="mx-auto w-full max-w-[1280px] px-4 pt-4 sm:px-6">
      <ol className="grid grid-cols-4 gap-1.5">
        {PHASES.map((p, i) => {
          const state = i < current ? "done" : i === current ? "current" : "todo";
          return (
            <li key={p} aria-current={state === "current" ? "step" : undefined} className="flex flex-col gap-1.5">
              <span className={`h-1.5 rounded-full ${state === "todo" ? "bg-default" : "bg-accent"} ${state === "current" ? "animate-pulse" : ""}`} />
              <span className={`text-xs ${state === "current" ? "font-semibold text-foreground" : "text-muted"}`}>
                {state === "done" ? "✓ " : ""}
                {p}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function NotificationsPanel() {
  const { notifications, signedIn, signIn, wallet, loadNotifications } = useApp();
  if (!wallet) return null;
  if (!signedIn)
    return (
      <Panel title="Notifications" description="Sign a message with your wallet to load the notifications addressed to your role. No transaction, no gas.">
        <Button size="sm" variant="secondary" onPress={signIn}>
          Sign in for notifications
        </Button>
      </Panel>
    );
  const unread = notifications.filter((n) => !n.read);
  return (
    <Panel
      title={
        <>
          Notifications {unread.length ? <Badge kind="warn">{unread.length} new</Badge> : null}
        </>
      }
      actions={
        unread.length ? (
          <Button size="sm" variant="ghost" onPress={() => api.markAllRead().then(loadNotifications)}>
            Mark all read
          </Button>
        ) : null
      }
    >
      {notifications.length === 0 ? <Empty>Nothing yet. Notifications appear when the indexer sees an event that concerns your role.</Empty> : null}
      <ul className="flex flex-col gap-2">
        {notifications.slice(0, 12).map((n) => (
          <li key={n.id}>
            <button
              type="button"
              className={`w-full rounded-sm border-s-[3px] px-3 py-2 text-start text-sm transition-colors ${n.read ? "border-border bg-default/40" : "border-warning bg-warning-soft hover:bg-warning-soft-hover"}`}
              onClick={() => !n.read && api.markRead(n.id).then(loadNotifications)}
              aria-label={n.read ? n.message : `Unread: ${n.message}. Mark as read`}
            >
              <div>{n.message}</div>
              <div className="mt-0.5 text-xs text-muted">
                {n.kind} · {fmtTime(n.createdAt)}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

const STATUS_NAMES = ["Open", "PendingSignatures", "Frozen", "Resolved", "Escalated", "Approved", "Declared"];

export function ActivityFeed({ level, unitId, limit = 25 }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const { tick } = useApp();
  const [poll, setPoll] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setPoll((n) => n + 1), 10000); // public viewers see new events without reloading
    return () => clearInterval(id);
  }, []);
  useEffectOnce(async () => {
    try {
      const params = { limit };
      if (level !== undefined) params.level = level;
      if (unitId !== undefined) params.unitId = unitId;
      setRows(await api.activity(params));
      setErr(null);
    } catch (e) {
      setErr(e.message);
    }
  }, [tick, poll, level, unitId]);
  return (
    <Panel title="On-chain activity" description="Contract events picked up by the indexer, newest first.">
      {err ? <Empty>{/503|database/i.test(err) ? "The activity feed needs the PostgreSQL cache (DATABASE_URL). Every record is still verifiable from the contracts above." : err}</Empty> : null}
      {!rows && !err ? <Loading>Loading activity…</Loading> : null}
      {rows && rows.length === 0 ? <Empty>No events indexed yet.</Empty> : null}
      {rows && rows.length ? (
        <Table variant="secondary">
          <Table.ScrollContainer>
            <Table.Content aria-label="On-chain activity" className="min-w-[560px]">
              <Table.Header>
                <Table.Column className="w-20">Block</Table.Column>
                <Table.Column isRowHeader>Event</Table.Column>
                <Table.Column>Actor</Table.Column>
                <Table.Column>Details</Table.Column>
              </Table.Header>
              <Table.Body>
                {(showAll ? rows : rows.slice(0, 8)).map((r) => (
                  <Table.Row key={r.id} id={String(r.id)}>
                    <Table.Cell className="font-mono text-xs">{r.blockNumber}</Table.Cell>
                    <Table.Cell>
                      <div className="font-medium">{r.name}</div>
                      <div className="text-xs text-muted">{r.contract}</div>
                    </Table.Cell>
                    <Table.Cell className="whitespace-nowrap font-mono text-xs">{r.actor ? shortAddr(r.actor) : "—"}</Table.Cell>
                    <Table.Cell className="text-sm text-muted">{summarise(r)}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      ) : null}
      {rows && rows.length > 8 ? (
        <div className="mt-3 flex justify-center">
          <Button size="sm" variant="ghost" onPress={() => setShowAll((v) => !v)}>
            {showAll ? "Show fewer" : `Show all ${rows.length} events`}
          </Button>
        </div>
      ) : null}
    </Panel>
  );
}

function summarise(r) {
  const a = r.args || {};
  const parts = [];
  if (r.level !== null && r.level !== undefined) parts.push(`${["PU", "Ward", "LGA", "State"][r.level]} #${r.unitId}`);
  if (a.reason) parts.push(`“${a.reason}”`);
  if (a.disputeId) parts.push(`dispute #${a.disputeId}`);
  if (a.field !== undefined && a.declared !== undefined) parts.push(`declared ${a.declared} vs computed ${a.computed}`);
  if (a.round !== undefined) parts.push(`round ${a.round}`);
  if (a.to !== undefined && a.from !== undefined && r.name === "StatusChanged") parts.push(`${STATUS_NAMES[a.from]} → ${STATUS_NAMES[a.to]}`);
  return parts.join(" · ") || "—";
}

function useEffectOnce(fn, deps) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    ref.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
