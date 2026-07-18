# NetOptim — KOSMIC Case Competition Project Documentation
**Last updated:** 15 July 2026 · **Prototype version:** v5

---

## 1. Competition context

- **Competition:** KOSMIC (Kearney Operations Studio for Moonshot Ideas & Concepts) — case competition for 2nd-year students (IIM Mumbai, IIT-B SJMSOM, SPJIMR). Team of 4.
- **Chosen case:** **Case 16 — Interactive Logistics Network Optimisation Agent.**
- **Round-1 deliverables:** (a) max 2-slide solution concept (PPT/PDF), (b) 90–120 s video pitch, all 4 members participating.
  - Slide 1: AI Solution & Decision Logic — problem, AI solution, key inputs, decision logic/workflow, outputs, user interaction.
  - Slide 2: Business Outcome & Implementation — outcome, value potential, risks/assumptions, implementation needs, adoption, successful pilot view.
- **Evaluation focus:** problem structuring, practical AI solution, decision logic & business reasoning, measurable impact, implementation feasibility, communication in 2 slides.
- **Prizes:** PPI with Kearney + cash; finalists get Kearney mentorship, Claude Premium, office visit.

## 2. Case 16 requirements (checklist)

Current-state network visualisation (nodes, customers, flows, volumes, costs, service) · nodes sized by throughput/utilisation/capacity/cost/role · flow lines by volume/cost/distance/mode/criticality · identify corridors, over/under-used nodes, long flows, cost hotspots · scenario builder (move/consolidate/close/add/resize) · recalculate KPIs (total cost, avg distance, service, flow reallocation, utilisation, carbon) · side-by-side scenario comparison vs baseline · sensitivity analysis (transport cost, demand, service targets, capacity, distance, carbon) · recommend optimal config with go/no-go rationale · explain logic defensibly · implementation considerations · interactive map dashboard.

**All of the above are implemented in the prototype.**

## 3. Solution concept & framing

**Product name:** NetOptim — "AI copilot for logistics network design".

**Three-layer architecture (the core pitch):**
1. **Visualise** — abstract (non-geographic) network canvas: DC nodes + demand diamonds + flow lines.
2. **Simulate** — deterministic engine: any change (open/close/expand DC, demand shift, lane rate, carbon tax) re-solves the network and recomputes every KPI live.
3. **Reason (AI copilot)** — auto-diagnoses hotspots on load, takes natural-language what-ifs, runs an objective-driven optimiser, explains recommendations in plain English with watch-outs, auto-logs every tested configuration for comparison.

**Honest AI framing (critical for judges):** the *engine and optimiser are real math* (enumerative search over configurations, verified by test harness). The *natural-language layer is rule-based in the demo* — in production it is an LLM; the demo parser is a drop-in placeholder. Mic button is visual only (artifact sandbox has no speech API); production wires a speech service. Say this proactively — it converts a weakness into credibility.

**Why AI vs a classic OR solver:** solvers exist; the differentiator is the copilot layer — conversational scenario setup, proactive hotspot flagging, plain-English trade-off explanation, auto-convergence with rationale, and auto-logged comparison. "Solver + reasoning copilot" is the defensible next-gen story.

## 4. The prototype (React artifact, single file `NetOptim.jsx`)

### Tab 1 · Problem & Data
- Editable **problem brief** textarea (seeded with anonymised narrative).
- Parameter cards: service threshold (700 km), base freight rate (₹/unit·km, calibrated), expansion cost (₹0.2cr/100k·yr), total annual demand.
- **Warehouse table:** name, **type** (Hub/Regional/Cross-dock/Fulfilment/3PL), x, y, capacity (’000u/**yr**), fixed cost (₹cr/yr), **opex (₹/unit handled)**, status (active/candidate toggle), delete. Add-row button.
- **Demand table:** name, x, y, demand (’000u/yr).
- **CSV upload flow:** pick dataset → shows required columns + units → download pre-filled template → upload; validated with row-level errors. **No IDs asked** — auto-generated internally (user-visible identity = name).
- **Lane-wise freight cost matrix** (WH × D) with three views: **Multiplier ×** (editable, default ×1.00 = uniform), **₹/unit** (computed = dist × base × mult, colour-coded), **₹cr/yr** (actual annual freight per lane under current sim config; "—" = no flow).
- **New problem** (blank slate) and **Load sample** buttons.

### Tab 2 · Simulator
- SVG network canvas: DC circles (size = throughput, colour = utilisation: cyan <50%, green healthy, amber ≥85%, red >100% with pulse), demand diamonds (size = volume), flow lines (thickness = volume → corridors; colour cyan→amber→red = lane cost intensity; dashed = overflow). Candidates dashed grey with "+".
- Click a DC → editor: utilisation, throughput, fixed cost, opex, **capacity slider** (expansion above base priced at ₹0.2cr/100k·yr, shown live, auto-logged on release), open/close.
- Click a demand diamond → editor: rename, **demand slider** (on release, posts a **before→after impact card** for the current network), served-from list, avg haul, remove.
- **"+ Demand centre"**: click map to place a new region.
- **Copilot panel:** auto network scan on load; understands open/close WH, demand ±%, carbon tax setting, optimise-for-X, reset (word-boundary name matching, "wh 6" and "wh6" both work); posts KPI cards with deltas; recommendation cards with Why + Watch-outs.
- **Objective presets:** Cost / Service / Balanced / Carbon + **Converge to optimum** button.
- **KPI bar:** total cost (freight + handling + fixed + carbon breakdown), avg distance, service %, sites at/over capacity, carbon (with **embedded carbon-price slider 0–2000 ₹/tCO₂**).

### Tab 3 · Compare & Sensitivity
- **Every tested configuration auto-logs here** (dedup by signature; no manual save needed).
- Sensitivity sliders re-solve all rows live: transport rate ×0.6–1.6, demand ×0.7–1.4, service threshold 400–1000 km, carbon price ₹0–2000/t.
- **Cost bar chart** per scenario + service column; **★ winner badge** for the currently selected objective; best value per column outlined; green/red deltas vs baseline; Load-into-simulator and delete per row.

## 5. Engine specification (all verified by node harness before shipping)

- **Distance:** Euclidean on 0–1000 canvas × 4.0 km/unit.
- **Assignment: matrix-minimum (cheapest-lane-first).** Lane unit cost = distance × base rate × lane multiplier **+ origin handling opex**. All lanes sorted ascending; volume allocated greedily until capacity/demand exhausts; overflow (demand > total capacity) goes to cheapest lane, flagged `over` (dashed line, util >100%).
  - *History:* v1–v3 used biggest-customer-first greedy → produced irrational cross-hauls (user caught "why is W4 not serving D10 when closer"); v4 fixed with matrix-minimum.
- **Calibration:** base rate fixed once so seed-network freight = ₹30cr (two-pass: pure-distance assignment for calibration, then rate held constant). Base ≈ ₹0.136/unit·km.
- **Cost model (₹cr/yr):** freight (Σ vol·dist·mult × rate) + handling (Σ vol × origin opex / 1e4) + fixed (Σ open fixedCost) + expansion (Σ max(0, cap − base) × 0.002) + carbon (k tCO₂ × price / 1e4).
- **Carbon:** emissions = physical vol·dist × 0.00009 (k tCO₂/yr) — uses raw distance, not rate-weighted.
- **Service level:** share of demand delivered within threshold (default 700 km).
- **Optimiser:** enumerates every open/close subset of candidate sites (≤10) on top of active sites; for any config with overloaded sites, also evaluates a **right-sized variant** (expand overloaded sites to fit throughput, expansion priced). Scores by objective (cost = total cost; service = avg distance; carbon = emissions; balanced = 50/50 normalised cost+distance). Returns best incl. capacity plan.
- **Baseline semantics:** baseline = active sites, no overrides, under **current** data — so KPI deltas isolate *network decisions*; demand changes get their own explicit before→after card instead.

### Verified numbers (seed data, v5 engine)
- Baseline: **₹50.3cr** (₹30.0 freight + ₹1.4 handling + ₹18.9 fixed), 374 km, **91.5%** service; util W1 94%, W2 66%, W3 100%, W4 25%, W5 100%.
- Open WH 6: **−₹5.85cr AND +6.8 svc pts** (hero demo moment — adding a DC improves both).
- Optimise-cost → open W6+W7 (₹~44cr class); optimise-service → W6+W7+W8. Distinct answers per objective.
- Carbon ₹500/t: +₹9.9cr baseline carbon cost; makes W6 an extra ₹2.7cr more attractive → "raise the tax, watch the optimum shift" demo beat.
- Demand shock D9 +30%: service falls (south capacity-bound) → opening W7 recovers it.

## 6. Seed dataset (anonymised)

- Names are **WH 1–8 / D1–D13** deliberately (user request: avoid city-name bias). Geometry mirrors an India-like layout but is presented as abstract.
- WH 1–5 active (capacities 1800/2200/1500/1400/900 k·u/yr; fixed ₹4.2/5.1/3.8/3.2/2.6cr; opex ₹2.5/2.8/2.2/1.8/2.4 per unit; types Hub/Hub/Regional/Cross-dock/Regional). WH 6–8 candidates (1000/1300/1200; ₹2.4/3.5/3.6cr; opex 1.6/2.0/2.6; Regional/Regional/3PL).
- 13 demand regions totalling 5,900k units/yr; largest D4 750k, D1 700k, D8 650k. D12 (far-east, 400k) is the pain: served from WH 1 at ~1,700 km.

## 7. Design decisions

- **Monochrome chrome + semantic data colours** (v5): UI is black/white/grey; *data* encodings are coloured (utilisation cyan/green/amber/red; flow-cost gradient; green/red deltas). v4 was fully B/W per request; user then found map indistinguishable → colours restored for data only.
- Typography: Space Grotesk (UI) + JetBrains Mono (numbers). Dark control-room aesthetic.
- Voice/mic: visual affordance with honest tooltip ("connects to a speech service in deployment").
- All figures are annual; labels say "/yr" explicitly.

## 8. Version history (each driven by user feedback)

| v | Changes |
|---|---|
| v1 | Core map + KPI bar + query box + objective presets; verified model harness first |
| v2 | 2 tabs (Problem & Data / Simulator); editable+addable demand centres; CSV upload w/ templates; editable data tables |
| v3 | Capacity expansion cost; demand before→after cards; New problem; Tab 3 (compare + sensitivity); IDs removed from upload |
| v4 | **Matrix-minimum assignment** (fixed irrational cross-hauls); expansion-aware optimiser; per-lane rate multipliers; auto-log scenarios; anonymised WH/D names; monochrome theme |
| v5 | Lane cost 3-view matrix (× / ₹/unit / ₹cr-yr); WH type + opex columns (opex in routing + P&L); colours restored for data encodings; Compare tab bars + ★ winner + carbon column; carbon price slider (KPI bar + sensitivity + copilot command), priced into optimiser |

## 9. Known limitations / deployment path

- NL parser is rule-based (→ LLM in production); mic is visual (→ speech API).
- Optimiser is enumerative over ≤10 candidates + expansion variants — not a full MILP; production would use a network-flow/MILP solver with the copilot on top. Assignment heuristic is near-optimal for this structure but not provably optimal.
- Geometry is abstract canvas coords, not geocoded; distances Euclidean.
- Single-period, deterministic demand; no inventory or multi-echelon.
- These are *scoping choices for a concept demo* — list them on Slide 2 as assumptions.

## 10. Remaining work (Round 1)

1. **Slide 1 — AI Solution & Decision Logic:** problem → 3-layer solution diagram → inputs (WH, demand, lane rates, carbon price) → decision logic (assign → evaluate → enumerate → recommend) → outputs (KPIs, ranked scenarios, recommendation card) → user interaction (click/type/voice).
2. **Slide 2 — Business Outcome & Implementation:** value (₹5.9cr/yr saving + 6.8 svc pts on demo network ≈ 12% network cost; decision cycle weeks→minutes) · risks/assumptions (data quality, deterministic demand, heuristic vs MILP) · implementation (data pipeline, LLM+solver wiring, SSO) · adoption (planners self-serve, no OR skills needed) · pilot = one region, 8–12 weeks, success = validated baseline ±5% of actuals + one board-approved network decision.
3. **90–120 s video script:** hook (network pain) → live demo arc: scan → "increase demand at D9 by 30%" → service drops → "converge to optimum" → recommendation card → compare tab sliders (robustness) → value line → team sign-off. Screen-record the artifact.
4. Optional polish: preset demo script button, export compare table.

## 11. Practical notes for a new chat

- Working file: `NetOptim.jsx` (React artifact; imports `papaparse`, `lucide-react`; no localStorage — state in memory).
- Ask Claude to load this MD + the latest `NetOptim.jsx` to continue. Model logic mirrors §5 exactly; a node harness reproducing §5 formulas validates any engine change before UI work.
- Competition PDF lives in the project files (`Kearney_Case_Comp_FINAL_CASES.pdf`).
