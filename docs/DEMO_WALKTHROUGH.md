# Demo walkthrough (defence script)

Runs on the seeded local election (`npm run seed:local`, prefill `live`): Oyo State with all 33 LGAs, 351
wards and 6,390 polling units under INEC's own names and codes (`contracts/data/oyo-register.json`), and 3
parties (PA, DC, LF). Everything is already approved except a small slice walked through live: polling units 1
and 2 (`30/01/01/001` A.U.D Pry. School and `30/01/01/002` Bode Open Space I), and therefore ward 1 (Ilora I),
LGA 1 (Afijio) and the state result. Every one of the 27,103 roles has an entry in the demo role switcher (top
bar; type a role, a place, a unit code or `#number`) — no MetaMask needed. Total time ≈ 12 minutes.

| Step | Role (switcher) | What to do | What the audience sees / the point being made |
|---|---|---|---|
| 1 | *(no wallet)* | Open the **Public verification** tab | Live collation tree: 33 LGAs, 32 of them Approved, Afijio "93/95 approved". Expand any LGA and ward and click a polling unit: figures, three signatures, hash integrity badge. |
| 2 | #4 Presiding Officer 30/01/01/001 | Enter figures that break a rule, e.g. total cast 310 with accredited 300 | The live check turns red ("Total votes cast must not exceed accredited voters"); the submit button stays disabled. Rule 1 of Table 3.2. |
| 3 | same | Correct to 1014 / 300 / 290 / 285 / 5 / PA 150 / DC 100 / LF 35, upload the EC8A photo, **Submit** | Toast "confirmed in block N"; status → *Pending signatures*; CID shown; figures hash displayed. |
| 4 | #6778 PA agent — PU 30/01/01/001 | **Sign — figures are correct** | Signature row turns green (1/3). Explain hash binding. |
| 5 | #13553 DC agent — PU 30/01/01/001 | **Reject — raise dispute**, reason "Form shows 160 for PA", optional photo | Status → *Frozen (dispute)*; the LF agent's portal now shows "Signing is paused". Dispute freeze invariant. |
| 6 | #4 Presiding Officer | The form is now titled *Correct the figures*; change PA to 160, valid 295, cast 300, accredited 310, upload, **Resubmit** | Status → *Resolved – awaiting agent*; dispute card shows "corrected the figures (new signing round)". |
| 7 | #13553 DC agent | **Accept resolution**, then **Sign** | Round 2 opens; the PA signature from round 1 does not carry over. |
| 8 | #6778 PA agent, then #20328 LF agent | PA: Sign. LF: **Sign with objection** ("kept outside during counting") | Status → *Approved*; LF's objection is permanent but did not block. Section 3.6. |
| 9 | #5 Presiding Officer 30/01/01/002 + its agents #1138, #2272, #20329 | Upload consistent figures (registered voters 941) and sign | Second PU approved → all 12 polling units of ward 1 are in, so it is collatable. |
| 10 | #6394 Ward Collation Officer (Ilora I) | Click **Fill from computed aggregate**, then add 100 to PA and **Confirm** | Pre-check warns; transaction succeeds but records a **mismatch alert**; status stays *Awaiting figures*; the banner "1 mismatch alert(s) permanently recorded". Table 3.2 rule 6 with evidence. |
| 11 | same | Fill from computed aggregate again (honest), **Confirm** | Status → *Pending signatures* for the ward. |
| 12 | Ward agents #2137, #3271, #26718 (Ilora I) | Sign | Ward 1 Approved. |
| 13 | #6745 LGA Collation Officer (Afijio) + LGA agents #2237, #3371, #27069 | Fill from computed aggregate, **Confirm**, sign | LGA 1 Approved — all 33 LGAs are in. |
| 14 | #1 State Returning Officer + state agents #2270, #3404, #27102 | Confirm EC8D, sign | State Approved; auditor notified. |
| 15 | #2 Independent Auditor | Show the readiness checklist and the full chain trace; upload the report; **1. Sign digest**, **2. Record on-chain** | Show `auditDigest()` in the UI; explain ecrecover. `Audit approval recorded` banner. |
| 16 | #3 Result Publisher | Before step 15 the button was blocked with *AuditNotApproved*; now **Declare the final result** | Phase → Declared. |
| 17 | *(no wallet)* | Public tab: declared result card, winner, audit signature, hash; click any unit and show "recomputed sum matches" | Public verifiability (Section 6.5). |

`frontend/e2e/walkthrough.mjs` drives exactly these steps in Chromium.

Talking points per objective (Section 1.3.2):

1. **Hierarchical architecture with nine roles** — the role switcher lists every category; try an action
   from the wrong role (e.g. the auditor clicking sign) to show the contract-level rejection.
2. **Automatic mathematical validation** — steps 2–3.
3. **Multi-party digital signatures bound to figures** — steps 4, 7–8 and the hash badge.
4. **On-chain dispute management** — steps 5–7 (and the escalation branch: officer confirms the original
   instead, agent escalates, auditor dismisses/upholds).
5. **Independent auditor gate** — steps 15–16.
6. **Role-specific portals** — one per row above.
7. **Evaluation** — `docs/EVALUATION.md` (gas, throughput, latency), `docs/SECURITY_STRIDE.md`, test suites.
