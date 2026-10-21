import { useState } from "react";
import { Button, Input, Label, ListBox, Select, Table, Tabs, TextArea, TextField } from "@heroui/react";
import { useApp, usePolled } from "../hooks/useApp.jsx";
import { api } from "../lib/api.js";
import { LEVEL_INDEX, CATEGORY_LABEL } from "../lib/constants.js";
import { fmtNum } from "../lib/format.js";
import { Alert, Empty, Badge, Stat, KeyValues, IpfsUpload, Panel, Checklist, ConfirmButton, Address, Loading, HashValue } from "../components/common.jsx";
import { GeographyTree } from "../components/geography.jsx";
import { NotificationsPanel, ActivityFeed } from "../components/layout.jsx";

/* ---- small form helpers ------------------------------------------------------------- */

function Field({ label, value, onChange, placeholder, isDisabled, type = "text", description, mono = false }) {
  return (
    <TextField className="w-full" value={value} onChange={onChange} isDisabled={isDisabled} type={type}>
      <Label className="text-sm font-medium">{label}</Label>
      <Input variant="secondary" placeholder={placeholder} className={mono ? "font-mono" : ""} />
      {description ? <span className="text-xs text-muted">{description}</span> : null}
    </TextField>
  );
}

/** Single-select built on HeroUI Select. `items`: [{ id, label }] */
function Picker({ label, items, value, onChange, isDisabled, placeholder = "Select…" }) {
  return (
    <Select variant="secondary" className="w-full" placeholder={placeholder} selectedKey={value === "" ? null : String(value)} onSelectionChange={(k) => onChange(k == null ? "" : String(k))} isDisabled={isDisabled}>
      <Label className="text-sm font-medium">{label}</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {items.map((it) => (
            <ListBox.Item key={it.id} id={String(it.id)} textValue={it.label}>
              {it.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(a.trim());

/** Geography options for the pickers (LGAs, wards, polling units) from the read model. */
function useGeoOptions() {
  const geo = usePolled(() => api.geography(), [], 10000);
  const lgas = geo.data?.lgas ?? [];
  return {
    lgas: lgas.map((l) => ({ id: l.id, label: `${l.name} LGA` })),
    wards: lgas.flatMap((l) => l.wards.map((w) => ({ id: w.id, label: `${w.name} · ${l.name}` }))),
    pollingUnits: lgas.flatMap((l) => l.wards.flatMap((w) => w.pollingUnits.map((pu) => ({ id: pu.id, label: `${pu.code} — ${pu.name}`, status: pu.status, cancelled: pu.cancelled })))),
  };
}

/** INEC administrator portal: configure the election (Registration phase) and drive its lifecycle. */
export function AdminPortal() {
  const { election, config } = useApp();
  const [tab, setTab] = useState("overview");
  return (
    <div className="flex flex-col gap-5" data-testid="admin-portal">
      <Panel
        title={<span className="text-lg">INEC administration</span>}
        description="Stakeholders and geography can only be changed during the Registration phase. Once Active, the role map is frozen and no administrator can alter, upload, sign or declare a result."
        actions={<Badge kind="info" size="md">Phase: {election?.phase}</Badge>}
      >
        <div className="flex flex-wrap gap-2.5">
          <Stat label="LGAs" value={election?.counts.lgas ?? "—"} />
          <Stat label="Wards" value={election?.counts.wards ?? "—"} />
          <Stat label="Polling units" value={fmtNum(election?.counts.pollingUnits)} />
          <Stat label="Parties" value={election?.counts.parties ?? "—"} />
          <Stat label="Candidates" value={election?.counts.candidates ?? "—"} />
          <Stat label="Pending escalations" value={election?.pendingEscalations ?? "—"} />
        </div>
      </Panel>
      <Tabs selectedKey={tab} onSelectionChange={(k) => setTab(String(k))} className="w-full">
        <Tabs.ListContainer className="overflow-x-auto">
          <Tabs.List aria-label="Administration sections">
            {[
              ["overview", "Overview & lifecycle"],
              ["election", "Election & candidates"],
              ["geography", "Geography"],
              ["stakeholders", "Stakeholders"],
              ["credentials", "Credentials"],
            ].map(([id, label]) => (
              <Tabs.Tab key={id} id={id} data-testid={`admin-tab-${id}`}>
                {label}
                <Tabs.Indicator />
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs.ListContainer>
        <Tabs.Panel id="overview" className="pt-5">
          <Overview config={config} />
        </Tabs.Panel>
        <Tabs.Panel id="election" className="pt-5">
          <ElectionSetup />
        </Tabs.Panel>
        <Tabs.Panel id="geography" className="pt-5">
          <GeographySetup />
        </Tabs.Panel>
        <Tabs.Panel id="stakeholders" className="pt-5">
          <Stakeholders />
        </Tabs.Panel>
        <Tabs.Panel id="credentials" className="pt-5">
          <Credentials />
        </Tabs.Panel>
      </Tabs>
    </div>
  );
}

const PHASE_TEXT = [
  ["Registration", "configure geography, candidates and stakeholders"],
  ["Active", "polling-unit uploads, signing, disputes and collation"],
  ["Collation", "upload window closed; collation and dispute handling continue"],
  ["Declared", "final result declared by the publisher after the audit"],
];

function Overview({ config }) {
  const { election, sendTx, busy } = useApp();
  const geo = useGeoOptions();
  const [cancelId, setCancelId] = useState("");
  const [cancelCid, setCancelCid] = useState("");
  const cancellable = geo.pollingUnits.filter((pu) => pu.status === "Open" && !pu.cancelled);
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-5">
        <Panel title="Lifecycle">
          <div className="flex flex-col gap-4">
            <Checklist
              items={PHASE_TEXT.map(([p, text], i) => ({
                done: election && election.phaseIndex >= i,
                content: (
                  <>
                    <strong className="font-semibold">{p}</strong> <span className="text-muted">— {text}</span>
                  </>
                ),
              }))}
            />
            {election?.phase === "Registration" ? (
              <div>
                <ConfirmButton
                  title="Activate the election?"
                  body="Geography, candidates and the stakeholder registry become permanently frozen. Presiding officers can start uploading EC8A results."
                  confirmLabel="Activate"
                  isDisabled={busy}
                  onConfirm={() => sendTx("Activate election", (c) => c.election.activateElection())}
                >
                  Activate election
                </ConfirmButton>
              </div>
            ) : null}
            {election?.phase === "Active" ? (
              <div>
                <ConfirmButton
                  variant="secondary"
                  status="warning"
                  title="Close polling-unit uploads?"
                  body="No new EC8A results will be accepted. Corrections for disputed units, signing and collation continue in the Collation phase."
                  confirmLabel="Close uploads"
                  isDisabled={busy}
                  onConfirm={() => sendTx("Close polling-unit uploads", (c) => c.election.closeSubmissions())}
                >
                  Close polling-unit uploads (→ Collation)
                </ConfirmButton>
              </div>
            ) : null}
            {election?.phase === "Collation" ? <Alert kind="info">Waiting for the auditor and the result publisher; the phase becomes Declared automatically.</Alert> : null}
            {election?.phase === "Declared" ? <Alert kind="ok" title="Election declared" /> : null}
          </div>
        </Panel>
        {election?.phase === "Active" || election?.phase === "Collation" ? (
          <Panel title="Cancel a polling unit" description="Where voting did not hold. Only possible before any figures are uploaded; the unit is then excluded from its ward aggregate.">
            <div className="flex flex-col gap-4">
              <Picker label="Polling unit" items={cancellable} value={cancelId} onChange={setCancelId} placeholder={cancellable.length ? "Select a unit with no upload" : "No eligible units"} isDisabled={!cancellable.length} />
              <IpfsUpload label="Cancellation notice (optional)" purpose="cancellation" onUploaded={setCancelCid} />
              <div>
                <ConfirmButton
                  variant="danger"
                  status="danger"
                  title="Cancel this polling unit?"
                  body={`${geo.pollingUnits.find((p) => String(p.id) === cancelId)?.label ?? "The unit"} will be excluded from its ward aggregate permanently.`}
                  confirmLabel="Cancel polling unit"
                  isDisabled={busy || !cancelId}
                  onConfirm={() => sendTx("Cancel polling unit", (c) => c.election.cancelPollingUnit(Number(cancelId), cancelCid))}
                >
                  Cancel polling unit
                </ConfirmButton>
              </div>
            </div>
          </Panel>
        ) : null}
        <Panel title="Deployed contracts">
          <KeyValues items={Object.entries(config?.contracts ?? {}).map(([k, v]) => [k, <HashValue value={v} key={k} />])} />
        </Panel>
      </div>
      <div className="flex min-w-0 flex-col gap-5">
        <Panel title="Live collation map">
          <GeographyTree />
        </Panel>
        <NotificationsPanel />
        <ActivityFeed limit={15} />
      </div>
    </div>
  );
}

const toUnix = (local) => (local ? Math.floor(new Date(local).getTime() / 1000) : 0);

function ElectionSetup() {
  const { election, sendTx, busy } = useApp();
  const [info, setInfo] = useState({ name: "", type: "Governorship", state: "Oyo", start: "", end: "" });
  const [party, setParty] = useState({ name: "", acronym: "" });
  const [cand, setCand] = useState({ partyId: "", name: "" });
  const reg = election?.phase === "Registration";
  const partiesWithout = (election?.parties ?? []).filter((p) => !p.hasCandidate).map((p) => ({ id: p.id, label: `${p.acronym} — ${p.name}` }));
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <Panel title="Election information">
        <div className="flex flex-col gap-4">
          <KeyValues items={[["Name", election?.name || "—"], ["Type", election?.electionType || "—"], ["State", election?.stateName || "—"]]} />
          {reg ? (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Election name" value={info.name} onChange={(v) => setInfo({ ...info, name: v })} />
                <Field label="Type" value={info.type} onChange={(v) => setInfo({ ...info, type: v })} />
                <Field label="State" value={info.state} onChange={(v) => setInfo({ ...info, state: v })} />
                <div />
                <Field label="Start" type="datetime-local" value={info.start} onChange={(v) => setInfo({ ...info, start: v })} />
                <Field label="End" type="datetime-local" value={info.end} onChange={(v) => setInfo({ ...info, end: v })} description="Leave empty for an open-ended election." />
              </div>
              <div>
                <Button variant="primary" isDisabled={busy || !info.name.trim()} onPress={() => sendTx("Set election info", (c) => c.election.setElectionInfo(info.name, info.type, info.state, toUnix(info.start), toUnix(info.end)))}>
                  Save election information
                </Button>
              </div>
            </>
          ) : (
            <Alert kind="info">Election information is frozen outside the Registration phase.</Alert>
          )}
        </div>
      </Panel>
      <Panel title="Parties and candidates">
        <div className="flex flex-col gap-5">
          {election?.parties.length ? (
            <Table variant="secondary">
              <Table.ScrollContainer>
                <Table.Content aria-label="Parties and candidates" className="min-w-[360px]">
                  <Table.Header>
                    <Table.Column className="w-10">#</Table.Column>
                    <Table.Column isRowHeader>Party</Table.Column>
                    <Table.Column>Candidate</Table.Column>
                  </Table.Header>
                  <Table.Body>
                    {election.parties.map((p) => (
                      <Table.Row key={p.id} id={String(p.id)}>
                        <Table.Cell className="text-muted">{p.id}</Table.Cell>
                        <Table.Cell>
                          <span className="font-semibold">{p.acronym}</span> <span className="text-muted">{p.name}</span>
                        </Table.Cell>
                        <Table.Cell>{p.hasCandidate ? election.candidates[p.candidateIndex]?.name : <span className="text-muted">No candidate</span>}</Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Content>
              </Table.ScrollContainer>
            </Table>
          ) : (
            <Empty>No parties registered yet.</Empty>
          )}
          {reg ? (
            <>
              <fieldset className="flex flex-col gap-3 rounded-sm border border-border p-3">
                <legend className="px-1 text-sm font-semibold">Add a party</legend>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[2fr_1fr]">
                  <Field label="Party name" value={party.name} onChange={(v) => setParty({ ...party, name: v })} />
                  <Field label="Acronym" value={party.acronym} onChange={(v) => setParty({ ...party, acronym: v.toUpperCase() })} />
                </div>
                <div>
                  <Button variant="secondary" isDisabled={busy || !party.name.trim() || !party.acronym.trim()} onPress={() => sendTx("Add party", (c) => c.election.addParty(party.name, party.acronym))}>
                    Add party
                  </Button>
                </div>
              </fieldset>
              <fieldset className="flex flex-col gap-3 rounded-sm border border-border p-3">
                <legend className="px-1 text-sm font-semibold">Add a candidate</legend>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Picker label="Party" items={partiesWithout} value={cand.partyId} onChange={(v) => setCand({ ...cand, partyId: v })} placeholder={partiesWithout.length ? "Select a party" : "Every party has a candidate"} />
                  <Field label="Candidate name" value={cand.name} onChange={(v) => setCand({ ...cand, name: v })} />
                </div>
                <div>
                  <Button variant="secondary" isDisabled={busy || !cand.partyId || !cand.name.trim()} onPress={() => sendTx("Add candidate", (c) => c.election.addCandidate(Number(cand.partyId), cand.name))}>
                    Add candidate
                  </Button>
                </div>
              </fieldset>
            </>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}

/** Parses "code, name, registered voters" lines; returns rows plus per-line errors. */
function parsePollingUnits(text) {
  const rows = [];
  const errors = [];
  text
    .split("\n")
    .map((l) => l.trim())
    .forEach((l, i) => {
      if (!l) return;
      const [code, name, regs] = l.split(",").map((x) => x.trim());
      if (!code) errors.push(`Line ${i + 1}: missing code`);
      else if (regs !== undefined && !/^\d+$/.test(regs)) errors.push(`Line ${i + 1}: registered voters must be a whole number`);
      else rows.push({ code, name: name || code, regs: Number(regs ?? 0) });
    });
  return { rows, errors };
}

function GeographySetup() {
  const { election, sendTx, busy } = useApp();
  const geo = useGeoOptions();
  const [lga, setLga] = useState("");
  const [ward, setWard] = useState({ lgaId: "", name: "" });
  const [pus, setPus] = useState({ wardId: "", lines: "" });
  const reg = election?.phase === "Registration";
  const parsed = parsePollingUnits(pus.lines);
  const addPus = () =>
    sendTx(`Add ${parsed.rows.length} polling unit(s)`, (c) =>
      c.election.addPollingUnits(
        Number(pus.wardId),
        parsed.rows.map((r) => r.code),
        parsed.rows.map((r) => r.name),
        parsed.rows.map((r) => r.regs),
      ),
    );
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <Panel title="Current geography">
        <GeographyTree />
      </Panel>
      <div className="flex min-w-0 flex-col gap-5">
        {!reg ? <Alert kind="warn" title="Geography is frozen">It can only be changed during the Registration phase.</Alert> : null}
        <Panel title="Add an LGA">
          <div className="flex flex-col gap-3">
            <Field label="LGA name" value={lga} onChange={setLga} isDisabled={!reg} placeholder="e.g. Ibadan North" />
            <div>
              <Button variant="secondary" isDisabled={busy || !reg || !lga.trim()} onPress={() => sendTx("Add LGA", (c) => c.election.addLga(lga))}>
                Add LGA
              </Button>
            </div>
          </div>
        </Panel>
        <Panel title="Add a ward">
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Picker label="LGA" items={geo.lgas} value={ward.lgaId} onChange={(v) => setWard({ ...ward, lgaId: v })} isDisabled={!reg} />
              <Field label="Ward name" value={ward.name} onChange={(v) => setWard({ ...ward, name: v })} isDisabled={!reg} />
            </div>
            <div>
              <Button variant="secondary" isDisabled={busy || !reg || !ward.lgaId || !ward.name.trim()} onPress={() => sendTx("Add ward", (c) => c.election.addWard(Number(ward.lgaId), ward.name))}>
                Add ward
              </Button>
            </div>
          </div>
        </Panel>
        <Panel title="Add polling units (batch)" description="One polling unit per line: code, name, registered voters.">
          <div className="flex flex-col gap-3">
            <Picker label="Ward" items={geo.wards} value={pus.wardId} onChange={(v) => setPus({ ...pus, wardId: v })} isDisabled={!reg} />
            <TextField className="w-full" value={pus.lines} onChange={(v) => setPus({ ...pus, lines: v })} isDisabled={!reg}>
              <Label className="text-sm font-medium">Polling units</Label>
              <TextArea variant="secondary" rows={5} className="w-full font-mono text-sm" placeholder={"OY/11/01/003, St. Anne's Primary School, 640\nOY/11/01/004, Town Hall, 512"} />
            </TextField>
            {parsed.errors.length ? (
              <Alert kind="danger" title="Fix these lines">
                <ul className="list-inside list-disc">
                  {parsed.errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </Alert>
            ) : parsed.rows.length ? (
              <span className="text-sm text-muted">{parsed.rows.length} polling unit(s) ready.</span>
            ) : null}
            <div>
              <Button variant="secondary" isDisabled={busy || !reg || !pus.wardId || !parsed.rows.length || parsed.errors.length > 0} onPress={addPus}>
                Add polling units
              </Button>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}

const OFFICER_KINDS = [
  ["PresidingOfficer", "registerPresidingOfficer", "pollingUnits", "Polling unit"],
  ["WardCollationOfficer", "registerWardCollationOfficer", "wards", "Ward"],
  ["LgaCollationOfficer", "registerLgaCollationOfficer", "lgas", "LGA"],
  ["StateReturningOfficer", "registerStateReturningOfficer", null],
  ["Auditor", "registerAuditor", null],
  ["ResultPublisher", "registerResultPublisher", null],
];
const AGENT_LEVELS = [
  ["PollingUnit", "Polling unit", "pollingUnits"],
  ["Ward", "Ward", "wards"],
  ["LGA", "LGA", "lgas"],
  ["State", "State", null],
];

function Stakeholders() {
  const { election, sendTx, busy } = useApp();
  const geo = useGeoOptions();
  const list = usePolled(() => api.stakeholders().catch(() => null), [], 10000);
  const [officer, setOfficer] = useState({ kind: "PresidingOfficer", address: "", unitId: "" });
  const [agent, setAgent] = useState({ address: "", partyId: "", level: "PollingUnit", unitId: "" });
  const [revoke, setRevoke] = useState("");
  const reg = election?.phase === "Registration";
  const kind = OFFICER_KINDS.find((k) => k[0] === officer.kind);
  const agentLevel = AGENT_LEVELS.find((l) => l[0] === agent.level);
  const registerOfficer = () =>
    sendTx(`Register ${CATEGORY_LABEL[officer.kind]}`, (c) => (kind[2] ? c.election[kind[1]](officer.address.trim(), Number(officer.unitId)) : c.election[kind[1]](officer.address.trim())));
  const registerAgent = () =>
    sendTx("Register party agent", (c) => c.election.registerPartyAgent(agent.address.trim(), Number(agent.partyId), LEVEL_INDEX[agent.level], agent.level === "State" ? 1 : Number(agent.unitId)));
  const addrHint = (a) => (a && !isAddress(a) ? "Not a valid 0x address (40 hex characters)." : null);
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-5">
        {!reg ? <Alert kind="warn" title="Registry frozen">Stakeholder registration is frozen outside the Registration phase (Section 3.5.1).</Alert> : null}
        <Panel title="Register an officer" description="Each wallet may hold exactly one stakeholder category (separation of duties).">
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Picker label="Category" items={OFFICER_KINDS.map((k) => ({ id: k[0], label: CATEGORY_LABEL[k[0]] }))} value={officer.kind} onChange={(v) => setOfficer({ ...officer, kind: v || "PresidingOfficer", unitId: "" })} isDisabled={!reg} />
              {kind?.[2] ? <Picker label={kind[3]} items={geo[kind[2]]} value={officer.unitId} onChange={(v) => setOfficer({ ...officer, unitId: v })} isDisabled={!reg} /> : null}
            </div>
            <Field label="Wallet address" mono value={officer.address} onChange={(v) => setOfficer({ ...officer, address: v })} isDisabled={!reg} placeholder="0x…" description={addrHint(officer.address)} />
            <div>
              <Button variant="primary" isDisabled={busy || !reg || !isAddress(officer.address) || (kind?.[2] && !officer.unitId)} onPress={registerOfficer}>
                Register officer
              </Button>
            </div>
          </div>
        </Panel>
        <Panel title="Register a party agent">
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Picker label="Party" items={(election?.parties ?? []).map((p) => ({ id: p.id, label: `${p.acronym} — ${p.name}` }))} value={agent.partyId} onChange={(v) => setAgent({ ...agent, partyId: v })} isDisabled={!reg} />
              <Picker label="Level" items={AGENT_LEVELS.map(([id, label]) => ({ id, label }))} value={agent.level} onChange={(v) => setAgent({ ...agent, level: v || "PollingUnit", unitId: "" })} isDisabled={!reg} />
              {agentLevel?.[2] ? <Picker label={agentLevel[1]} items={geo[agentLevel[2]]} value={agent.unitId} onChange={(v) => setAgent({ ...agent, unitId: v })} isDisabled={!reg} /> : null}
            </div>
            <Field label="Wallet address" mono value={agent.address} onChange={(v) => setAgent({ ...agent, address: v })} isDisabled={!reg} placeholder="0x…" description={addrHint(agent.address)} />
            <div>
              <Button variant="primary" isDisabled={busy || !reg || !isAddress(agent.address) || !agent.partyId || (agent.level !== "State" && !agent.unitId)} onPress={registerAgent}>
                Register agent
              </Button>
            </div>
          </div>
        </Panel>
        <Panel title="Revoke a stakeholder">
          <div className="flex flex-col gap-3">
            <Field label="Wallet address" mono value={revoke} onChange={setRevoke} isDisabled={!reg} placeholder="0x…" description={addrHint(revoke)} />
            <div>
              <ConfirmButton
                variant="danger"
                status="danger"
                title="Revoke this stakeholder?"
                body={<>The wallet <code className="break-all">{revoke}</code> loses its role immediately.</>}
                confirmLabel="Revoke"
                isDisabled={busy || !reg || !isAddress(revoke)}
                onConfirm={() => sendTx("Revoke stakeholder", (c) => c.election.revokeStakeholder(revoke.trim()))}
              >
                Revoke
              </ConfirmButton>
            </div>
          </div>
        </Panel>
      </div>
      <Panel title="Registered stakeholders" description={list.data?.length ? `${list.data.length} wallets` : null}>
        {list.loading ? <Loading /> : null}
        {!list.loading && list.data === null ? <Empty>Listing needs the PostgreSQL cache (DATABASE_URL); on-chain lookups by address still work in the Credentials tab.</Empty> : null}
        {list.data?.length === 0 ? <Empty>None yet.</Empty> : null}
        {list.data?.length ? (
          <Table variant="secondary">
            <Table.ScrollContainer className="max-h-[640px] overflow-y-auto">
              <Table.Content aria-label="Registered stakeholders" className="min-w-[420px]">
                <Table.Header>
                  <Table.Column isRowHeader>Category</Table.Column>
                  <Table.Column>Scope</Table.Column>
                  <Table.Column>Party</Table.Column>
                  <Table.Column>Address</Table.Column>
                </Table.Header>
                <Table.Body>
                  {list.data.map((s) => (
                    <Table.Row key={s.address} id={s.address}>
                      <Table.Cell>{CATEGORY_LABEL[s.category] ?? s.category}</Table.Cell>
                      <Table.Cell className="text-sm">
                        {["PU", "Ward", "LGA", "State"][s.level]} #{s.unitId}
                      </Table.Cell>
                      <Table.Cell>{s.partyId ? election?.parties.find((p) => p.id === Number(s.partyId))?.acronym : "—"}</Table.Cell>
                      <Table.Cell>
                        <Address value={s.address} copy />
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        ) : null}
      </Panel>
    </div>
  );
}

function Credentials() {
  const { wallet, toast } = useApp();
  const [address, setAddress] = useState("");
  const [lookup, setLookup] = useState(null);
  const [issued, setIssued] = useState(null);
  const [verifyInput, setVerifyInput] = useState("");
  const [verdict, setVerdict] = useState(null);
  const check = async () => {
    try {
      setLookup(await api.stakeholder(address.trim()));
    } catch (err) {
      toast(err.message, "error");
    }
  };
  const issue = async () => {
    try {
      const { message, payload } = await api.credentialMessage(address.trim());
      const signature = await wallet.signer.signMessage(message);
      const res = await api.issueCredential(address.trim(), signature, payload);
      setIssued(res);
      toast("Credential issued and stored.", "success");
    } catch (err) {
      toast(err.message, "error");
    }
  };
  const verify = async () => {
    try {
      const parsed = JSON.parse(verifyInput);
      setVerdict(await api.verifyCredential(parsed.payload, parsed.signature));
    } catch (err) {
      toast(err instanceof SyntaxError ? "That is not valid JSON. Paste the { payload, signature } object exactly." : err.message, "error");
    }
  };
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <Panel
        title="Issue a DID-style credential"
        description={
          <>
            Binds <code>did:ethr:&lt;chainId&gt;:&lt;address&gt;</code> to the role recorded on-chain, signed by this INEC admin wallet (EIP-191). Verification checks both the issuer signature and the live role registry.
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="Stakeholder wallet" mono value={address} onChange={(v) => { setAddress(v); setLookup(null); setIssued(null); }} placeholder="0x…" />
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onPress={check} isDisabled={!isAddress(address)}>
              Look up on-chain role
            </Button>
            <Button variant="primary" onPress={issue} isDisabled={!lookup || lookup.category === "None"}>
              Sign & issue credential
            </Button>
          </div>
          {lookup ? (
            <KeyValues items={[["Category", CATEGORY_LABEL[lookup.category] ?? lookup.category], ["Level", lookup.level], ["Unit", lookup.unitId], ["Party", lookup.partyId || "—"]]} />
          ) : null}
          {issued ? (
            <TextField className="w-full" value={JSON.stringify({ payload: issued.payload, signature: issued.signature }, null, 2)} isReadOnly>
              <Label className="text-sm font-medium">Issued credential</Label>
              <TextArea variant="secondary" rows={8} className="w-full font-mono text-xs" />
            </TextField>
          ) : null}
        </div>
      </Panel>
      <Panel title="Verify a credential">
        <div className="flex flex-col gap-3">
          <TextField className="w-full" value={verifyInput} onChange={setVerifyInput}>
            <Label className="text-sm font-medium">Paste {"{ payload, signature }"}</Label>
            <TextArea variant="secondary" rows={8} className="w-full font-mono text-xs" />
          </TextField>
          <div>
            <Button variant="secondary" onPress={verify} isDisabled={!verifyInput.trim()}>
              Verify
            </Button>
          </div>
          {verdict ? (
            verdict.valid ? (
              <Alert kind="ok" title="Valid credential">Issued by an INEC admin and consistent with the on-chain role.</Alert>
            ) : (
              <Alert kind="danger" title="Invalid credential">
                Issuer is INEC admin: {String(verdict.issuerIsInecAdmin)} · matches chain: {String(verdict.matchesOnChainRole)} · expired: {String(verdict.expired)}
              </Alert>
            )
          ) : null}
        </div>
      </Panel>
    </div>
  );
}
