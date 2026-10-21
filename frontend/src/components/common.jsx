import { useEffect, useState } from "react";
import { FileTrigger } from "react-aria-components";
import { Alert as HAlert, AlertDialog, Button, Card, Chip, Label, NumberField, Spinner, Table } from "@heroui/react";
import { STATUS_LABEL, FIELD_LABEL } from "../lib/constants.js";
import { fmtNum, shortAddr, fmtTime } from "../lib/format.js";
import { api } from "../lib/api.js";
import { checkFigures, isComplete } from "../lib/figures.js";

/* ------------------------------------------------------------------------------------------
 * Shared presentation primitives built on HeroUI v3. Portals compose these instead of styling
 * HeroUI directly, so colour semantics (status → colour) stay identical everywhere.
 * ---------------------------------------------------------------------------------------- */

/** On-chain result status → chip colour. */
const STATUS_COLOR = {
  Open: "default",
  PendingSignatures: "accent",
  Frozen: "danger",
  Resolved: "warning",
  Escalated: "warning",
  Approved: "success",
  Declared: "success",
};

/** Legacy `kind` names used across the portals → HeroUI colour names. */
const KIND_COLOR = { ok: "success", warn: "warning", danger: "danger", info: "accent", role: "accent", "": "default" };

export function StatusBadge({ status, size = "sm" }) {
  return (
    <Chip size={size} variant={status === "Declared" ? "primary" : "soft"} color={STATUS_COLOR[status] ?? "default"} data-status={status}>
      {STATUS_LABEL[status] ?? status}
    </Chip>
  );
}

export function Badge({ kind = "", children, size = "sm" }) {
  return (
    <Chip size={size} variant="soft" color={KIND_COLOR[kind] ?? "default"}>
      {children}
    </Chip>
  );
}

/** Card with a consistent header (title, optional description and actions). */
export function Panel({ title, description, actions, children, className = "", contentClassName = "", variant, ...rest }) {
  return (
    <Card className={`w-full min-w-0 ${className}`} variant={variant} {...rest}>
      {title || description || actions ? (
        <Card.Header className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {title ? <Card.Title className="flex flex-wrap items-center gap-2 text-base font-semibold">{title}</Card.Title> : null}
            {description ? <Card.Description className="mt-1 text-sm">{description}</Card.Description> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </Card.Header>
      ) : null}
      <Card.Content className={`min-w-0 ${contentClassName}`}>{children}</Card.Content>
    </Card>
  );
}

export function Stat({ label, value, sub }) {
  return (
    <div className="flex min-w-[7.5rem] flex-1 flex-col gap-0.5 rounded-sm bg-default/60 px-3.5 py-2.5">
      <span className="text-[0.7rem] font-medium uppercase tracking-wider text-muted">{label}</span>
      <span className="text-xl font-semibold tabular-nums leading-tight">{value}</span>
      {sub ? <span className="text-xs text-muted">{sub}</span> : null}
    </div>
  );
}

const ALERT_STATUS = { info: "accent", ok: "success", warn: "warning", danger: "danger" };

export function Alert({ kind = "info", title, children, action }) {
  return (
    <HAlert status={ALERT_STATUS[kind] ?? "default"} data-kind={kind}>
      <HAlert.Indicator />
      <HAlert.Content>
        {title ? <HAlert.Title>{title}</HAlert.Title> : null}
        {children ? <HAlert.Description>{children}</HAlert.Description> : null}
        {action ? <div className="mt-2">{action}</div> : null}
      </HAlert.Content>
    </HAlert>
  );
}

export function Empty({ children }) {
  return <p className="py-3 text-sm text-muted">{children}</p>;
}

/** Centered spinner with a label for initial loads. */
export function Loading({ children = "Loading…" }) {
  return (
    <div className="flex items-center gap-3 py-6 text-sm text-muted" role="status">
      <Spinner size="sm" />
      {children}
    </div>
  );
}

/** Copies text to the clipboard and briefly confirms. */
export function CopyButton({ value, label = "Copy" }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-6 min-w-0 px-1.5 text-xs"
      aria-label={`${label} ${value}`}
      onPress={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          /* clipboard unavailable (insecure origin) */
        }
      }}
    >
      {done ? "Copied" : "Copy"}
    </Button>
  );
}

export function Address({ value, copy = false }) {
  if (!value) return <span className="text-muted">—</span>;
  return (
    <span className="inline-flex items-center gap-1">
      <span className="whitespace-nowrap font-mono text-[0.85em]" title={value}>
        {shortAddr(value)}
      </span>
      {copy ? <CopyButton value={value} label="Copy address" /> : null}
    </span>
  );
}

/** A long hex value (hash, signature, CID) that wraps, with a copy action. */
export function HashValue({ value, copy = true }) {
  if (!value) return <span className="text-muted">—</span>;
  return (
    <span className="inline-flex max-w-full items-start gap-1">
      <span className="vc-hash min-w-0">{value}</span>
      {copy ? <CopyButton value={value} label="Copy value" /> : null}
    </span>
  );
}

/** Table of result figures; `compare` (optional) adds a second column with mismatch highlighting. */
export function FiguresTable({ figures, candidates = [], compare = null, compareLabel = "Computed", label = "Result figures" }) {
  if (!figures) return <Empty>No figures on-chain yet.</Empty>;
  const rows = [
    ["RegisteredVoters", figures.registeredVoters, compare?.registeredVoters],
    ["AccreditedVoters", figures.accreditedVoters, compare?.accreditedVoters],
    ["TotalVotesCast", figures.totalVotesCast, compare?.totalVotesCast],
    ["ValidVotes", figures.validVotes, compare?.validVotes],
    ["RejectedVotes", figures.rejectedVotes, compare?.rejectedVotes],
  ].map(([k, v, c]) => ({ id: k, label: FIELD_LABEL[k], v, c }));
  figures.candidateVotes.forEach((v, i) => {
    const cand = candidates[i];
    rows.push({
      id: `c${i}`,
      label: cand ? (
        <span>
          <strong className="font-semibold">{cand.acronym ?? `#${i}`}</strong> <span className="text-muted">— {cand.name}</span>
        </span>
      ) : (
        `Candidate #${i}`
      ),
      v,
      c: compare?.candidateVotes?.[i],
      candidate: true,
    });
  });
  return (
    <Table variant="secondary">
      <Table.ScrollContainer>
        <Table.Content aria-label={label} className="min-w-[320px]">
          <Table.Header>
            <Table.Column isRowHeader>Field</Table.Column>
            <Table.Column className="vc-num">{compare ? "Declared" : "Value"}</Table.Column>
            {compare ? <Table.Column className="vc-num">{compareLabel}</Table.Column> : null}
          </Table.Header>
          <Table.Body>
            {rows.map((r) => {
              const mismatch = compare && Number(r.v) !== Number(r.c);
              return (
                <Table.Row key={r.id} id={r.id} className={mismatch ? "bg-danger-soft" : ""} data-mismatch={mismatch || undefined}>
                  <Table.Cell className={r.candidate ? "" : "text-muted"}>{r.label}</Table.Cell>
                  <Table.Cell className="vc-num font-medium">{fmtNum(r.v)}</Table.Cell>
                  {compare ? <Table.Cell className={`vc-num ${mismatch ? "font-semibold text-danger" : ""}`}>{fmtNum(r.c)}</Table.Cell> : null}
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
  );
}

/** One numeric entry field. Values are kept as strings so empty ≠ 0 (the form must be complete). */
function FigureField({ label, value, onChange, disabled, hint, testId }) {
  const num = String(value ?? "").trim() === "" ? NaN : Number(value);
  return (
    <NumberField
      variant="secondary"
      className="w-full"
      minValue={0}
      isWheelDisabled
      value={num}
      isDisabled={disabled}
      formatOptions={{ maximumFractionDigits: 0, useGrouping: true }}
      onChange={(n) => onChange(Number.isNaN(n) || n === null ? "" : String(Math.max(0, Math.trunc(n))))}
    >
      <Label className="text-xs font-medium text-muted">{label}</Label>
      <NumberField.Group>
        <NumberField.Input className="w-full tabular-nums" data-testid={testId} placeholder="0" />
      </NumberField.Group>
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </NumberField>
  );
}

/** Editable figures form with the six-rule live check (client mirror of the contract's rules). */
export function FiguresForm({ value, onChange, candidates, registerValue = 0, disabled = false }) {
  const set = (k, v) => onChange({ ...value, [k]: v });
  const setCand = (i, v) => {
    const cv = [...value.candidateVotes];
    cv[i] = v;
    onChange({ ...value, candidateVotes: cv });
  };
  const complete = isComplete(value);
  const check = complete ? checkFigures(value, candidates.length, registerValue) : null;
  const rules = check?.rules ?? checkFigures({ ...value, candidateVotes: value.candidateVotes.map(() => 0) }, candidates.length, registerValue).rules;
  const fields = [
    ["registeredVoters", "Registered voters"],
    ["accreditedVoters", "Accredited voters"],
    ["totalVotesCast", "Total votes cast"],
    ["validVotes", "Valid votes"],
    ["rejectedVotes", "Rejected votes"],
  ];
  return (
    <div className="flex flex-col gap-5" data-testid="figures-form">
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-sm font-semibold">Voter and ballot totals</legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {fields.map(([k, label]) => (
            <FigureField
              key={k}
              label={label}
              value={value[k]}
              disabled={disabled}
              testId={`fig-${k}`}
              onChange={(v) => set(k, v)}
              hint={k === "registeredVoters" && registerValue ? `INEC register: ${fmtNum(registerValue)}` : null}
            />
          ))}
        </div>
      </fieldset>
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-sm font-semibold">Votes per candidate</legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {candidates.map((c, i) => (
            <FigureField key={c.index ?? i} label={`${c.acronym} — ${c.name}`} value={value.candidateVotes[i] ?? ""} disabled={disabled} testId={`fig-candidate-${i}`} onChange={(v) => setCand(i, v)} />
          ))}
        </div>
      </fieldset>
      <div className="rounded-sm border border-border p-3">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Smart-contract checks</p>
        <ul className="grid gap-1.5" aria-live="polite">
          {rules.map((r) => {
            const state = complete ? (r.pass ? "pass" : "fail") : "idle";
            return (
              <li key={r.name} className="flex items-start gap-2 text-sm" data-rule={r.name} data-state={state}>
                <span
                  aria-hidden
                  className={`mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full text-[0.65rem] font-bold ${
                    state === "pass" ? "bg-success text-success-foreground" : state === "fail" ? "bg-danger text-danger-foreground" : "bg-default text-muted"
                  }`}
                >
                  {state === "pass" ? "✓" : state === "fail" ? "✕" : "·"}
                </span>
                <span className={state === "fail" ? "text-danger" : ""}>
                  <span className="sr-only">{state === "pass" ? "Passes: " : state === "fail" ? "Fails: " : "Not checked yet: "}</span>
                  {r.text}
                  {complete ? <span className="text-muted"> — {r.detail}</span> : null}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
      {complete && check && !check.ok ? (
        <Alert kind="danger" title="The smart contract would reject these figures">
          Rule violated: {check.violated}. Correct the figures to match the physical form.
        </Alert>
      ) : null}
      {complete && check && check.ok ? <Alert kind="ok" title="All arithmetic checks pass">The contract will accept these figures.</Alert> : null}
    </div>
  );
}

/** File picker that pins to IPFS through the backend and returns the CID. */
export function IpfsUpload({ label = "Scanned form", purpose, uploader, onUploaded, accept = "image/*,application/pdf", required = false }) {
  const [state, setState] = useState({ busy: false, error: null, result: null, name: null });
  const onSelect = async (files) => {
    const file = files?.[0];
    if (!file) return;
    setState({ busy: true, error: null, result: null, name: file.name });
    try {
      const res = await api.ipfsUpload(file, purpose, uploader);
      setState({ busy: false, error: null, result: res, name: file.name });
      onUploaded?.(res.cid, res);
    } catch (err) {
      setState({ busy: false, error: err.message, result: null, name: file.name });
    }
  };
  return (
    <div className="flex flex-col gap-2 rounded-sm border border-dashed border-border p-3" data-testid={`upload-${purpose}`}>
      <span className="text-sm font-medium">
        {label}
        {required ? <span className="text-danger"> *</span> : null}
      </span>
      <div className="flex flex-wrap items-center gap-3">
        <FileTrigger acceptedFileTypes={accept.split(",")} onSelect={onSelect}>
          <Button size="sm" variant="secondary" isDisabled={state.busy}>
            {state.result ? "Replace file" : "Choose file"}
          </Button>
        </FileTrigger>
        {state.name ? <span className="max-w-[16rem] truncate text-sm text-muted">{state.name}</span> : <span className="text-sm text-muted">Image or PDF</span>}
        {state.busy ? (
          <span className="inline-flex items-center gap-2 text-sm text-muted">
            <Spinner size="sm" /> Pinning to IPFS…
          </span>
        ) : null}
      </div>
      {state.error ? (
        <span className="text-sm text-danger" role="alert">
          {state.error}
        </span>
      ) : null}
      {state.result ? (
        <span className="flex flex-wrap items-center gap-2 text-xs" data-testid="upload-done">
          <Chip size="sm" color="success" variant="soft">
            Pinned ({state.result.provider})
          </Chip>
          <span className="vc-hash">{state.result.cid}</span>
        </span>
      ) : null}
    </div>
  );
}

/** Shows an IPFS-hosted form image (or a link for PDFs). */
export function FormPreview({ cid, label = "Scanned form" }) {
  const [exists, setExists] = useState(null);
  useEffect(() => {
    let stop = false;
    if (!cid) return undefined;
    api
      .ipfsExists(cid)
      .then((r) => !stop && setExists(r.exists))
      .catch(() => !stop && setExists(false));
    return () => {
      stop = true;
    };
  }, [cid]);
  if (!cid) return <Empty>No form uploaded.</Empty>;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">{label} CID</span>
        <HashValue value={cid} />
        {exists === false ? <Badge kind="warn">not retrievable from the configured IPFS provider</Badge> : null}
        {exists ? <Badge kind="ok">available</Badge> : null}
      </div>
      {exists ? (
        <a href={api.ipfsUrl(cid)} target="_blank" rel="noreferrer" className="block">
          <img className="max-h-[360px] max-w-full rounded-sm border border-border" src={api.ipfsUrl(cid)} alt={`${label} scan`} onError={(e) => (e.currentTarget.style.display = "none")} />
        </a>
      ) : null}
    </div>
  );
}

export function KeyValues({ items }) {
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="m-0 min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Timestamp({ value }) {
  return <span className="text-sm text-muted">{fmtTime(value)}</span>;
}

/** Ordered checklist with tick marks (lifecycle, declaration gate, audit readiness). */
export function Checklist({ items }) {
  return (
    <ol className="grid gap-2">
      {items.map((it, i) => (
        <li key={i} className="flex items-start gap-2.5 text-sm" data-done={it.done ? "true" : "false"}>
          <span
            aria-hidden
            className={`mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[0.7rem] font-bold ${it.done ? "bg-success text-success-foreground" : "bg-default text-muted"}`}
          >
            {it.done ? "✓" : i + 1}
          </span>
          <span className={it.done ? "" : "text-foreground/80"}>
            <span className="sr-only">{it.done ? "Done: " : "Pending: "}</span>
            {it.content}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * A button that asks for confirmation before an irreversible on-chain action.
 * `status` drives the dialog icon colour; `onConfirm` runs after the user confirms.
 */
export function ConfirmButton({ children, title, body, confirmLabel, onConfirm, variant = "primary", status = "accent", isDisabled = false, size = "md" }) {
  return (
    <AlertDialog>
      <Button variant={variant} isDisabled={isDisabled} size={size}>
        {children}
      </Button>
      <AlertDialog.Backdrop>
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-[460px]">
            <AlertDialog.CloseTrigger />
            <AlertDialog.Header>
              <AlertDialog.Icon status={status} />
              <AlertDialog.Heading>{title}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <div className="text-sm">{body}</div>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary">
                Cancel
              </Button>
              <Button slot="close" variant={variant === "secondary" || variant === "tertiary" ? "primary" : variant} onPress={onConfirm} data-testid="confirm-action">
                {confirmLabel ?? children}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  );
}

/** Responsive two-column page body: main column + side column; stacks on narrow screens. */
export function Columns({ main, side }) {
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="flex min-w-0 flex-col gap-5">{main}</div>
      <div className="flex min-w-0 flex-col gap-5">{side}</div>
    </div>
  );
}
