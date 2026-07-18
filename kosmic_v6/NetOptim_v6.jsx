import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";
import Papa from "papaparse";
import { Cpu, Mic, Send, Zap, RotateCcw, X, AlertTriangle, Building2, Target, Truck, Leaf, Gauge, IndianRupee, Sparkles, ChevronRight, Upload, Download, Plus, Trash2, FileText, Map as MapIcon, Database, TrendingDown, TrendingUp, GitCompare, FilePlus2, RefreshCw, Grid3X3, Star } from "lucide-react";

/* ============================================================
   NetOptim v6 — AI copilot for logistics network design
   · Routing = cheapest true variable cost (freight + handling opex)
   · Carbon price (₹/tCO₂) converts emissions to cost, priced in optimiser
   · Lane cost views: multiplier / ₹ per unit / ₹cr per year
   · WH type + opex + explicit annual units
   · Coloured data encodings on monochrome chrome
   · Compare tab: bars, winner badge, live sensitivity

   v6 — reviewer high-priority fixes (H1–H4):
   · H1 optimiser now enumerates open/close over ALL non-locked sites, so it
     can exit an under-used existing DC (not just add candidates); per-site
     `lockOpen` flag keeps must-stay DCs in the search's open set.
   · H2 close-vs-shrink fixed-cost logic made explicit & consistent: in-lease
     shrink saves nothing; full fixed cost is avoidable only by exiting at
     lease break — which is how a closure is modelled (stated assumption).
   · H3 "service" objective now maximises the SAME metric the KPI bar shows —
     on-time share within the service threshold — avg distance as tiebreak.
   · (bonus) right-sizing iterates to convergence so a recommended config is
     feasible, not just single-pass.
   ============================================================ */

const SCALE_KM = 4.0;
const DEFAULT_SVC_KM = 700;
const EMISSION_FACTOR = 0.00009; // k tCO₂ per (’000u · km)
const EXP_RATE = 0.002;          // ₹cr per 1k units/yr capacity added above base

let UID = 0;
const uid = p => p + "_" + (++UID).toString(36) + Date.now().toString(36).slice(-3);

const WH_TYPES = ["Hub", "Regional", "Cross-dock", "Fulfilment", "3PL"];

const SEED_WAREHOUSES = [
  { id: "W1", name: "WH 1", x: 470, y: 190, capacity: 1800, fixedCost: 4.2, opex: 2.5, type: "Hub",        status: "active" },
  { id: "W2", name: "WH 2", x: 240, y: 560, capacity: 2200, fixedCost: 5.1, opex: 2.8, type: "Hub",        status: "active" },
  { id: "W3", name: "WH 3", x: 410, y: 820, capacity: 1500, fixedCost: 3.8, opex: 2.2, type: "Regional",   status: "active" },
  { id: "W4", name: "WH 4", x: 460, y: 490, capacity: 1400, fixedCost: 3.2, opex: 1.8, type: "Cross-dock", status: "active" },
  { id: "W5", name: "WH 5", x: 720, y: 470, capacity:  900, fixedCost: 2.6, opex: 2.4, type: "Regional",   status: "active" },
  { id: "W6", name: "WH 6", x: 850, y: 360, capacity: 1000, fixedCost: 2.4, opex: 1.6, type: "Regional",   status: "candidate" },
  { id: "W7", name: "WH 7", x: 470, y: 680, capacity: 1300, fixedCost: 3.5, opex: 2.0, type: "Regional",   status: "candidate" },
  { id: "W8", name: "WH 8", x: 250, y: 420, capacity: 1200, fixedCost: 3.6, opex: 2.6, type: "3PL",        status: "candidate" },
];

const SEED_CUSTOMERS = [
  { id: "D1", name: "D1", x: 450, y: 210, demand: 700 }, { id: "D2", name: "D2", x: 360, y: 300, demand: 300 },
  { id: "D3", name: "D3", x: 560, y: 320, demand: 350 }, { id: "D4", name: "D4", x: 230, y: 580, demand: 750 },
  { id: "D5", name: "D5", x: 280, y: 620, demand: 300 }, { id: "D6", name: "D6", x: 270, y: 430, demand: 400 },
  { id: "D7", name: "D7", x: 470, y: 500, demand: 250 }, { id: "D8", name: "D8", x: 400, y: 830, demand: 650 },
  { id: "D9", name: "D9", x: 500, y: 860, demand: 450 }, { id: "D10", name: "D10", x: 460, y: 690, demand: 500 },
  { id: "D11", name: "D11", x: 730, y: 480, demand: 550 }, { id: "D12", name: "D12", x: 860, y: 350, demand: 400 },
  { id: "D13", name: "D13", x: 680, y: 600, demand: 300 },
];

const SEED_BRIEF = `A consumer-goods company runs a 5-DC network (WH 1–5) serving ~5.9M units/yr across 13 demand regions (D1–D13).

Pain points: WH 3 and WH 5 are capacity-bound (~100%), the far-east region D12 is served from WH 1 at ~1,700 km, and WH 4 sits under-utilised (~25%). Three candidate sites (WH 6–8) are approved for evaluation with known fixed costs and handling rates.

Decision needed: which candidates (if any) to open, whether to resize or exit existing sites, and how demand growth or a carbon tax changes the answer — balancing total cost, service distance, utilisation risk and emissions.`;

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) * SCALE_KM;
const laneKey = (w, c) => w + "|" + c;

/* ---- MATRIX-MINIMUM assignment on TRUE variable cost ----
   Lane unit cost (₹/unit) = distance × base rate × lane multiplier + origin handling opex.
   Cheapest lanes fill first — no big-customer bias, no irrational cross-hauls. */
function assign(whs, custs, openIds0, capOverride, laneMult, baseRate) {
  const byId = Object.fromEntries(whs.map(w => [w.id, w]));
  const openIds = openIds0.filter(id => byId[id]);
  const capOf = id => (capOverride && capOverride[id] != null) ? capOverride[id] : byId[id].capacity;
  const remC = {}; openIds.forEach(id => { remC[id] = capOf(id); });
  const remD = {}; custs.forEach(c => { remD[c.id] = c.demand; });
  const mult = (w, c) => (laneMult && laneMult[laneKey(w, c)] != null) ? laneMult[laneKey(w, c)] : 1;
  const unitCost = (wid, c) => dist(byId[wid], c) * mult(wid, c.id) * (baseRate || 0) + (baseRate ? (byId[wid].opex || 0) : 0);
  const lanes = [];
  for (const id of openIds) for (const c of custs) {
    const d = dist(byId[id], c); const m = mult(id, c.id);
    lanes.push({ w: id, c: c.id, d, m, u: baseRate ? d * m * baseRate + (byId[id].opex || 0) : d * m });
  }
  lanes.sort((a, b) => a.u - b.u);
  const flows = [];
  for (const L of lanes) {
    const t = Math.min(remC[L.w], remD[L.c]);
    if (t > 0) { flows.push({ from: L.w, to: L.c, volume: t, distance: L.d, m: L.m }); remC[L.w] -= t; remD[L.c] -= t; }
  }
  for (const c of custs) {
    if (remD[c.id] > 0 && openIds.length) {
      const best = [...openIds].sort((a, b) => unitCost(a, c) - unitCost(b, c))[0];
      flows.push({ from: best, to: c.id, volume: remD[c.id], distance: dist(byId[best], c), m: mult(best, c.id), over: true });
      remC[best] -= remD[c.id]; remD[c.id] = 0;
    }
  }
  return { flows };
}

/* two-pass calibration: RATE fixed so seed freight = ₹30cr (pure-distance pass) */
const RATE_CR = (() => {
  const act = SEED_WAREHOUSES.filter(w => w.status === "active").map(w => w.id);
  const { flows } = assign(SEED_WAREHOUSES, SEED_CUSTOMERS, act, null, null, 0);
  return 30 / flows.reduce((s, f) => s + f.volume * f.distance * f.m, 0);
})();
const BASE_RATE = RATE_CR * 1e4; // ₹ per unit·km

/* opts: rateMult, demandMult, svcKm, carbonPrice (₹/tCO₂) */
function computeKpis(whs, custs0, openIds0, capOverride, laneMult, opts) {
  const o = { rateMult: 1, demandMult: 1, svcKm: DEFAULT_SVC_KM, carbonPrice: 0, ...(opts || {}) };
  const byId = Object.fromEntries(whs.map(w => [w.id, w]));
  const openIds = openIds0.filter(id => byId[id]);
  const custs = o.demandMult === 1 ? custs0 : custs0.map(c => ({ ...c, demand: Math.round(c.demand * o.demandMult) }));
  const capOf = id => (capOverride && capOverride[id] != null) ? capOverride[id] : byId[id].capacity;
  const totalDemand = Math.max(1, custs.reduce((s, c) => s + c.demand, 0));
  const { flows } = assign(whs, custs, openIds, capOverride, laneMult, BASE_RATE * o.rateMult);
  const costVD = flows.reduce((s, f) => s + f.volume * f.distance * f.m, 0);
  const distVD = flows.reduce((s, f) => s + f.volume * f.distance, 0);
  const transportCost = costVD * RATE_CR * o.rateMult;
  const handlingCost = flows.reduce((s, f) => s + f.volume * (byId[f.from].opex || 0), 0) / 1e4;
  const expansionCost = openIds.reduce((s, id) => s + Math.max(0, capOf(id) - byId[id].capacity) * EXP_RATE, 0);
  const fixedCost = openIds.reduce((s, id) => s + byId[id].fixedCost, 0) + expansionCost;
  const carbon = distVD * EMISSION_FACTOR;               // k tCO₂ / yr
  const carbonCost = carbon * o.carbonPrice / 1e4;       // ₹cr / yr
  const totalCost = transportCost + handlingCost + fixedCost + carbonCost;
  const avgDistance = distVD / totalDemand;
  const onTime = flows.filter(f => f.distance <= o.svcKm).reduce((s, f) => s + f.volume, 0);
  const serviceLevel = onTime / totalDemand;
  const throughput = {}, util = {};
  openIds.forEach(id => { throughput[id] = 0; });
  flows.forEach(f => { throughput[f.from] += f.volume; });
  openIds.forEach(id => { util[id] = capOf(id) > 0 ? throughput[id] / capOf(id) : 0; });
  return { flows, transportCost, handlingCost, fixedCost, expansionCost, carbonCost, totalCost, avgDistance, serviceLevel, carbon, util, throughput, openIds, totalDemand };
}

function optimize(whs, custs, objective, capOverride, laneMult, opts) {
  const byId = Object.fromEntries(whs.map(w => [w.id, w]));
  const activeIds = whs.filter(w => w.status === "active").map(w => w.id);

  /* H1 — enumerate open/close over ALL non-locked sites (active AND candidate),
     so the optimiser can EXIT an under-used existing DC, not just add candidates.
     `lockOpen` sites (e.g. a DC that can't leave its lease) are always kept open.
     Sites beyond the tractability cap are also forced open (never arbitrarily
     closed), preserving the old "actives stay" behaviour for very large uploads. */
  const nonLocked = whs.filter(w => !w.lockOpen).map(w => w.id);
  const enumIds = nonLocked.slice(0, 12);                       // 2^12 ceiling
  const forcedOpen = [
    ...whs.filter(w => w.lockOpen).map(w => w.id),
    ...nonLocked.slice(12),
  ];

  const evals = [];
  for (let m = 0; m < (1 << enumIds.length); m++) {
    const open = [...forcedOpen, ...enumIds.filter((_, i) => m & (1 << i))];
    if (open.length === 0) continue;                            // a network needs ≥1 DC

    /* Right-size to convergence: expanding an overloaded site reshuffles the
       assignment, which can push a DIFFERENT site over 100%, so iterate a few
       passes rather than a single pass. Only the feasible (right-sized) variant
       is scored — an overloaded-but-unpriced config is never a valid winner. */
    let cap = { ...(capOverride || {}) };
    let k = computeKpis(whs, custs, open, cap, laneMult, opts);
    const expanded = new Set();
    for (let pass = 0; pass < 4; pass++) {
      const over = open.filter(id => k.util[id] > 1.0001);
      if (!over.length) break;
      over.forEach(id => {
        cap[id] = Math.ceil(k.throughput[id] / 50) * 50;
        if (cap[id] > byId[id].capacity) expanded.add(id);
      });
      k = computeKpis(whs, custs, open, cap, laneMult, opts);
    }
    k.capUsed = cap;
    k.expIds = [...expanded].filter(id => cap[id] > byId[id].capacity);
    evals.push(k);
  }
  if (!evals.length) return { best: null, evalsCount: 0, activeIds };

  const costs = evals.map(e => e.totalCost), dists = evals.map(e => e.avgDistance);
  const cLo = Math.min(...costs), cHi = Math.max(...costs), dLo = Math.min(...dists), dHi = Math.max(...dists);
  const nrm = (v, lo, hi) => hi === lo ? 0 : (v - lo) / (hi - lo);
  /* H3 — "service" optimises the SAME metric the KPI bar reports: on-time share
     within the service threshold (maximise). Average haul is only a tiebreak, so
     the service-optimal scenario is guaranteed to top the Compare service column. */
  const score = e =>
    objective === "cost" ? e.totalCost :
    objective === "service" ? (1 - e.serviceLevel) * 1e4 + e.avgDistance :
    objective === "carbon" ? e.carbon :
    0.5 * nrm(e.totalCost, cLo, cHi) + 0.5 * nrm(e.avgDistance, dLo, dHi);
  const ranked = [...evals].sort((a, b) => score(a) - score(b));
  return { best: ranked[0], evalsCount: evals.length, activeIds };
}

/* objective score for compare-tab winner badge */
function objScore(k, objective, rows) {
  const costs = rows.map(r => r.k.totalCost), dists = rows.map(r => r.k.avgDistance);
  const nrm = (v, lo, hi) => hi === lo ? 0 : (v - lo) / (hi - lo);
  if (objective === "cost") return k.totalCost;
  if (objective === "service") return (1 - k.serviceLevel) * 1e4 + k.avgDistance; // H3: maximise on-time %, tiebreak avg haul
  if (objective === "carbon") return k.carbon;
  return 0.5 * nrm(k.totalCost, Math.min(...costs), Math.max(...costs)) + 0.5 * nrm(k.avgDistance, Math.min(...dists), Math.max(...dists));
}

/* ---- colours: monochrome chrome, semantic data encodings ---- */
const GOOD = "#3FB950", BAD = "#F85149";
const utilColor = u => u == null ? "#3a3a3a" : u > 1 ? "#F85149" : u >= 0.85 ? "#F5A524" : u >= 0.5 ? "#3FB950" : "#2FB8D6";
const hx = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const toHex = a => "#" + a.map(v => Math.round(v).toString(16).padStart(2, "0")).join("");
const mixC = (a, b, t) => toHex(hx(a).map((v, i) => v + (hx(b)[i] - v) * t));
const flowColor = t => t < 0.5 ? mixC("#2FB8D6", "#F5A524", t / 0.5) : mixC("#F5A524", "#F85149", (t - 0.5) / 0.5);
const inr = v => "₹" + v.toFixed(1) + "cr";

function downloadCsv(filename, rows, columns) {
  const csv = Papa.unparse(rows.map(r => Object.fromEntries(columns.map(c => [c, r[c]]))), { columns });
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  URL.revokeObjectURL(a.href);
}
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* ============================================================ */
export default function NetOptim() {
  const [tab, setTab] = useState("setup");
  const [brief, setBrief] = useState(SEED_BRIEF);
  const [warehouses, setWarehouses] = useState(SEED_WAREHOUSES);
  const [customers, setCustomers] = useState(SEED_CUSTOMERS);
  const [openIds, setOpenIds] = useState(SEED_WAREHOUSES.filter(w => w.status === "active").map(w => w.id));
  const [capOverride, setCapOverride] = useState({});
  const [laneMult, setLaneMult] = useState({});
  const [carbonPrice, setCarbonPrice] = useState(0);
  const [objective, setObjective] = useState("balanced");
  const [selected, setSelected] = useState(null);
  const [addingDemand, setAddingDemand] = useState(false);
  const [query, setQuery] = useState("");
  const [flowMetric, setFlowMetric] = useState("cost");
  const [micHint, setMicHint] = useState(false);
  const [messages, setMessages] = useState([]);
  const [uploadKind, setUploadKind] = useState(null);
  const [uploadErr, setUploadErr] = useState("");
  const [scenarios, setScenarios] = useState([]);
  const [sens, setSens] = useState({ rateMult: 1, demandMult: 1, svcKm: DEFAULT_SVC_KM });
  const [laneView, setLaneView] = useState("mult"); // mult | unit | annual
  const [showLanes, setShowLanes] = useState(false);
  const feedRef = useRef(null), svgRef = useRef(null), fileRef = useRef(null);
  const bootRef = useRef(false), demandStartRef = useRef(null), capStartRef = useRef(null);

  const activeIds = useMemo(() => warehouses.filter(w => w.status === "active").map(w => w.id), [warehouses]);
  const whById = useMemo(() => Object.fromEntries(warehouses.map(w => [w.id, w])), [warehouses]);
  const cById = useMemo(() => Object.fromEntries(customers.map(c => [c.id, c])), [customers]);

  const simOpts = useMemo(() => ({ carbonPrice }), [carbonPrice]);
  const baseline = useMemo(() => computeKpis(warehouses, customers, activeIds, {}, laneMult, simOpts), [warehouses, customers, activeIds, laneMult, simOpts]);
  const kpi = useMemo(() => computeKpis(warehouses, customers, openIds, capOverride, laneMult, simOpts), [warehouses, customers, openIds, capOverride, laneMult, simOpts]);

  const hasData = warehouses.length > 0 && customers.length > 0;
  const maxVol = Math.max(1, ...kpi.flows.map(f => f.volume));
  const uLo = kpi.flows.length ? Math.min(...kpi.flows.map(f => f.distance * f.m)) : 0;
  const uHi = kpi.flows.length ? Math.max(...kpi.flows.map(f => f.distance * f.m)) : 1;
  const maxThru = Math.max(1, ...Object.values(kpi.throughput));
  const maxDemand = Math.max(1, ...customers.map(c => c.demand));

  useEffect(() => { if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight; }, [messages]);
  const push = useCallback((role, payload) => setMessages(m => [...m, { role, payload, id: Math.random() }]), []);

  useEffect(() => {
    if (tab !== "sim" || bootRef.current || !hasData) return;
    bootRef.current = true;
    const over = openIds.filter(id => (kpi.util[id] || 0) > 0.95).map(id => whById[id].name);
    const low = openIds.filter(id => (kpi.util[id] || 0) < 0.5).map(id => whById[id].name);
    const worst = [...kpi.flows].sort((a, b) => b.distance - a.distance)[0];
    push("ai", {
      kind: "diagnostic", title: "Network scan complete",
      lines: [
        `Mapped ${openIds.length} active DCs serving ${kpi.totalDemand.toLocaleString()}k units/yr across ${customers.length} regions.`,
        over.length ? `⚠ Capacity-bound: ${over.join(", ")} at/near 100% — no headroom for demand shocks.` : `No overloaded sites.`,
        low.length ? `↓ Under-used: ${low.join(", ")} below 50% — consolidation candidates.` : ``,
        worst ? `Longest-haul: ${cById[worst.to]?.name} served from ${whById[worst.from]?.name} at ${worst.distance.toFixed(0)} km — a cost & service hotspot (red line).` : ``,
      ].filter(Boolean),
      cta: "Every configuration you test is auto-logged to the Compare tab.",
    });
  }, [tab]); // eslint-disable-line

  const deltas = {
    cost: kpi.totalCost - baseline.totalCost,
    distance: kpi.avgDistance - baseline.avgDistance,
    service: (kpi.serviceLevel - baseline.serviceLevel) * 100,
    carbon: kpi.carbon - baseline.carbon,
  };

  const metricRow = (k, b) => ([
    { label: "Total cost", value: inr(k.totalCost), delta: k.totalCost - b.totalCost, unit: "cr", good: k.totalCost < b.totalCost },
    { label: "Avg distance", value: k.avgDistance.toFixed(0) + " km", delta: k.avgDistance - b.avgDistance, unit: " km", good: k.avgDistance < b.avgDistance },
    { label: "Service", value: (k.serviceLevel * 100).toFixed(1) + "%", delta: (k.serviceLevel - b.serviceLevel) * 100, unit: " pts", good: k.serviceLevel > b.serviceLevel },
    { label: "Carbon", value: k.carbon.toFixed(0) + "k tCO₂", delta: k.carbon - b.carbon, unit: "k", good: k.carbon < b.carbon },
  ]);

  function configName(open, capUsed, prefix) {
    const added = open.filter(id => !activeIds.includes(id)).map(id => whById[id]?.name);
    const closed = activeIds.filter(id => !open.includes(id)).map(id => whById[id]?.name);
    const expanded = Object.keys(capUsed || {}).filter(id => whById[id] && capUsed[id] > whById[id].capacity).map(id => whById[id].name);
    const parts = [added.length && "open " + added.join("+"), closed.length && "close " + closed.join("+"), expanded.length && "expand " + expanded.join("+")].filter(Boolean);
    return (prefix ? prefix + " · " : "") + (parts.length ? parts.join(", ") : "as-is");
  }
  function autoLog(open, capUsed, prefix) {
    const sig = JSON.stringify({ o: [...open].sort(), c: capUsed || {} });
    setScenarios(s => {
      if (s.some(x => x.sig === sig)) return s;
      const name = `S${s.length + 1} · ${configName(open, capUsed, prefix)}`;
      return [...s.slice(-19), { id: uid("sc"), sig, name, openIds: [...open], capOverride: { ...(capUsed || {}) } }];
    });
  }

  function applyConfig(nextOpen, note) {
    const k = computeKpis(warehouses, customers, nextOpen, capOverride, laneMult, simOpts);
    setOpenIds(nextOpen);
    autoLog(nextOpen, capOverride);
    push("ai", { kind: "scenario", title: note, metrics: metricRow(k, baseline) });
  }

  function applyDemandChange(custId, newDemand, sourceLabel) {
    const c = cById[custId]; if (!c || c.demand === newDemand) return;
    const before = computeKpis(warehouses, customers, openIds, capOverride, laneMult, simOpts);
    const nextCustomers = customers.map(x => x.id === custId ? { ...x, demand: newDemand } : x);
    const after = computeKpis(warehouses, nextCustomers, openIds, capOverride, laneMult, simOpts);
    setCustomers(nextCustomers);
    const pct = ((newDemand - c.demand) / c.demand * 100);
    push("ai", {
      kind: "scenario",
      title: `Demand shock · ${c.name} ${pct > 0 ? "+" : ""}${pct.toFixed(0)}% (${c.demand}k → ${newDemand}k)${sourceLabel ? " · " + sourceLabel : ""}`,
      subtitle: "Impact on the CURRENT network (before → after the demand change):",
      metrics: metricRow(after, before),
    });
  }

  function applyCarbonPrice(np, sourceLabel) {
    const before = computeKpis(warehouses, customers, openIds, capOverride, laneMult, { carbonPrice });
    const after = computeKpis(warehouses, customers, openIds, capOverride, laneMult, { carbonPrice: np });
    setCarbonPrice(np);
    push("ai", {
      kind: "scenario",
      title: `Carbon price → ₹${np}/tCO₂${sourceLabel ? " · " + sourceLabel : ""}`,
      subtitle: "Emissions now cost money — the optimiser will penalise long hauls accordingly:",
      metrics: [
        { label: "Total cost", value: inr(after.totalCost), delta: after.totalCost - before.totalCost, unit: "cr", good: after.totalCost < before.totalCost },
        { label: "Carbon cost", value: inr(after.carbonCost), delta: after.carbonCost - before.carbonCost, unit: "cr", good: after.carbonCost < before.carbonCost },
        { label: "Emissions", value: after.carbon.toFixed(0) + "k tCO₂", delta: 0 },
        { label: "Service", value: (after.serviceLevel * 100).toFixed(1) + "%", delta: 0 },
      ],
    });
  }

  function runOptimize(obj) {
    const o = obj || objective;
    setObjective(o);
    const { best, evalsCount, activeIds: act } = optimize(warehouses, customers, o, capOverride, laneMult, simOpts);
    if (!best) { push("ai", { kind: "note", text: "No feasible configuration to optimise — add at least one warehouse and one demand region." }); return; }
    setOpenIds(best.openIds);
    setCapOverride(best.capUsed || {});
    autoLog(best.openIds, best.capUsed, `opt-${o}`);
    const added = best.openIds.filter(id => !act.includes(id)).map(id => whById[id].name);
    const closed = act.filter(id => !best.openIds.includes(id)).map(id => whById[id].name); // H1: machine-found exits
    const expanded = (best.expIds || []).map(id => `${whById[id].name} → ${(best.capUsed[id]).toLocaleString()}k`);
    const dCost = best.totalCost - baseline.totalCost;
    const dSvc = (best.serviceLevel - baseline.serviceLevel) * 100;
    const objLabel = { cost: "lowest cost", service: "highest service level", balanced: "cost–service balance", carbon: "lowest carbon" }[o];
    const moves = [
      added.length && "open " + added.join(" + "),
      closed.length && "exit " + closed.join(" + "),
      expanded.length && "expand " + expanded.join(", "),
    ].filter(Boolean).join("; ") || "keep the current footprint";
    push("ai", {
      kind: "recommend", objLabel,
      headline: `Optimal for ${objLabel}: ${moves}.`,
      metrics: metricRow(best, baseline).slice(0, 3),
      rationale: [
        `Evaluated ${evalsCount} configurations — every open/close combination across all non-locked sites, plus right-sized capacity variants where sites overload (expansion priced at ₹${(EXP_RATE * 100).toFixed(1)}cr per 100k/yr).`,
        `Cost model per unit: freight (dist × ₹${BASE_RATE.toFixed(2)}/u·km × lane rate) + origin handling opex${carbonPrice > 0 ? ` + carbon at ₹${carbonPrice}/tCO₂` : ""}.`,
        added.length ? `Opening ${added.join(" & ")} moves supply closer to under-served demand — long-haul freight falls faster than fixed cost rises.` : `The existing footprint already dominates on this objective.`,
        closed.length ? `Exiting ${closed.join(" & ")} strips out under-used fixed cost: its volume reallocates to the cheapest remaining DCs and the added freight is smaller than the fixed cost saved.` : ``,
        expanded.length ? `Capacity expansion beat the alternative of longer hauls: ${expanded.join(", ")}.` : ``,
        `Net vs today: ${dCost < 0 ? "saves " + inr(Math.abs(dCost)) : "adds " + inr(dCost)}, service ${dSvc >= 0 ? "up" : "down"} ${Math.abs(dSvc).toFixed(1)} pts.`,
      ].filter(Boolean),
      watchouts: [
        added.length ? `Transition: site fit-out & ramp (~8–12 wks) before savings land.` : `Low transition risk — no new sites.`,
        closed.length ? `Closure assumption: modelled at LEASE EXIT/BREAK — the full fixed cost is only avoided when the lease can be exited; an in-lease shrink saves nothing. Lock any DC that can't exit mid-lease before converging.` : `Lease/contract: verify break-clauses before capex commit.`,
        `Result auto-logged to Compare — stress-test it with the sensitivity sliders there.`,
      ].filter(Boolean),
    });
  }

  function parseQuery(raw) {
    const q = " " + raw.toLowerCase().replace(/\s+/g, " ") + " ";
    const hit = list => list.find(o => {
      const n = o.name.toLowerCase();
      return new RegExp("\\b" + esc(n) + "\\b").test(q) || new RegExp("\\b" + esc(n.replace(/\s+/g, "")) + "\\b").test(q.replace(/\s+/g, ""));
    });
    if (/carbon/.test(q) && /(tax|price|cost|penalt)/.test(q)) {
      const num = (q.match(/(\d{2,5})/) || [])[1];
      if (num) return applyCarbonPrice(Math.min(2000, +num), "via copilot");
      return push("ai", { kind: "note", text: `Give a number, e.g. “set carbon tax to 800” (₹/tCO₂, up to 2000). You can also drag the slider under the Carbon KPI.` });
    }
    if (/optim|converge|best|recommend/.test(q)) {
      const obj = /cost|cheap|saving|spend/.test(q) ? "cost" : /service|deliver|distance|fast|speed/.test(q) ? "service" : /carbon|emission|green|co2/.test(q) ? "carbon" : "balanced";
      return runOptimize(obj);
    }
    if (/reset|baseline|revert|start over/.test(q)) return doReset();
    if (/demand/.test(q)) {
      const c = hit(customers);
      if (c) {
        const pct = (q.match(/(\d+)\s*%/) || [])[1];
        const factor = pct ? +pct / 100 : 0.2;
        const dec = /decrease|reduce|cut|drop|fall/.test(q);
        const nd = Math.max(25, Math.round(c.demand * (1 + (dec ? -factor : factor))));
        return applyDemandChange(c.id, nd, "via copilot");
      }
      return push("ai", { kind: "note", text: `Name a region, e.g. “increase demand at D9 by 30%”, or click any ◇ on the map.` });
    }
    const w = hit(warehouses);
    if (w && /close|shut|remove|exit|drop/.test(q)) {
      if (!openIds.includes(w.id)) return push("ai", { kind: "note", text: `${w.name} isn't open right now.` });
      return applyConfig(openIds.filter(x => x !== w.id), `Scenario · close ${w.name}`);
    }
    if (w && /add|open|build|new|launch|expand/.test(q)) {
      if (/expand/.test(q)) { setSelected({ kind: "wh", id: w.id }); return push("ai", { kind: "note", text: `Use the capacity slider on ${w.name} — expansion above base is priced at ₹${(EXP_RATE * 100).toFixed(1)}cr per 100k/yr.` }); }
      if (openIds.includes(w.id)) return push("ai", { kind: "note", text: `${w.name} is already open.` });
      return applyConfig([...openIds, w.id], `Scenario · open ${w.name}`);
    }
    if (w) { setSelected({ kind: "wh", id: w.id }); return push("ai", { kind: "note", text: `Selected ${w.name} — open/close it or adjust capacity in the panel.` }); }
    const c = hit(customers);
    if (c) { demandStartRef.current = c.demand; setSelected({ kind: "cust", id: c.id }); return push("ai", { kind: "note", text: `Selected ${c.name} (${c.demand}k u/yr) — adjust demand in the panel.` }); }
    push("ai", { kind: "note", text: `Try: “open WH 6”, “increase demand at D9 by 30%”, “set carbon tax to 800”, or “optimise for cost”.` });
  }

  function submitQuery() { const t = query.trim(); if (!t) return; push("user", { text: t }); setQuery(""); parseQuery(t); }

  function doReset() {
    setOpenIds(activeIds); setCapOverride({}); setSelected(null); setAddingDemand(false);
    push("ai", { kind: "note", text: `Reset to current-state baseline (${activeIds.length} DCs).` });
  }
  function newProblem() {
    setBrief(""); setWarehouses([]); setCustomers([]); setOpenIds([]); setCapOverride({}); setLaneMult({}); setCarbonPrice(0);
    setScenarios([]); setMessages([]); setSelected(null); bootRef.current = false;
    setSens({ rateMult: 1, demandMult: 1, svcKm: DEFAULT_SVC_KM });
  }
  function loadSample() {
    setBrief(SEED_BRIEF); setWarehouses(SEED_WAREHOUSES); setCustomers(SEED_CUSTOMERS);
    setOpenIds(SEED_WAREHOUSES.filter(w => w.status === "active").map(w => w.id));
    setCapOverride({}); setLaneMult({}); setCarbonPrice(0); setScenarios([]); setMessages([]); setSelected(null); bootRef.current = false;
    setSens({ rateMult: 1, demandMult: 1, svcKm: DEFAULT_SVC_KM });
  }

  function svgPoint(e) {
    const r = svgRef.current.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * 1000, y: (e.clientY - r.top) / r.height * 1000 };
  }
  function mapClick(e) {
    if (addingDemand) {
      const { x, y } = svgPoint(e);
      const id = uid("D");
      setCustomers(cs => [...cs, { id, name: "D" + (cs.length + 1), x: Math.round(x), y: Math.round(y), demand: 300 }]);
      demandStartRef.current = 300;
      setSelected({ kind: "cust", id }); setAddingDemand(false);
      push("ai", { kind: "note", text: `New demand region placed (300k/yr default). Rename and set demand in the panel.` });
      return;
    }
    setSelected(null);
  }
  const toggleNode = id => openIds.includes(id)
    ? applyConfig(openIds.filter(x => x !== id), `Scenario · close ${whById[id].name}`)
    : applyConfig([...openIds, id], `Scenario · open ${whById[id].name}`);

  const setCustField = (id, patch) => setCustomers(cs => cs.map(c => c.id === id ? { ...c, ...patch } : c));
  const removeCust = id => { setCustomers(cs => cs.filter(c => c.id !== id)); setSelected(null); };
  const setWhField = (id, patch) => {
    setWarehouses(ws => ws.map(w => w.id === id ? { ...w, ...patch } : w));
    if (patch.status) setOpenIds(ids => patch.status === "candidate" ? ids.filter(x => x !== id) : Array.from(new Set([...ids, id])));
  };
  const removeWh = id => { setWarehouses(ws => ws.filter(w => w.id !== id)); setOpenIds(ids => ids.filter(x => x !== id)); };
  const addWhRow = () => setWarehouses(ws => [...ws, { id: uid("W"), name: "WH " + (ws.length + 1), x: 500, y: 500, capacity: 1000, fixedCost: 3.0, opex: 2.0, type: "Regional", status: "candidate" }]);
  const addCustRow = () => setCustomers(cs => [...cs, { id: uid("D"), name: "D" + (cs.length + 1), x: 500, y: 500, demand: 300 }]);

  const WH_COLS = ["name", "type", "x", "y", "capacity", "fixedCost", "opex", "status"];
  const CU_COLS = ["name", "x", "y", "demand"];
  function handleFile(e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = ""; if (!f) return;
    Papa.parse(f, {
      header: true, skipEmptyLines: true,
      complete: res => {
        try {
          const rows = res.data;
          if (!rows.length) throw new Error("File is empty.");
          if (uploadKind === "warehouses") {
            const parsed = rows.map((r, i) => {
              const o = { id: uid("W"), name: String(r.name || "WH " + (i + 1)).trim(), type: WH_TYPES.includes((r.type || "").trim()) ? r.type.trim() : "Regional", x: +r.x, y: +r.y, capacity: +r.capacity, fixedCost: +r.fixedCost, opex: r.opex != null && r.opex !== "" ? +r.opex : 2.0, status: (r.status || "active").trim() };
              if ([o.x, o.y, o.capacity, o.fixedCost, o.opex].some(v => !isFinite(v))) throw new Error(`Row ${i + 1}: x, y, capacity, fixedCost, opex must be numbers.`);
              if (!["active", "candidate"].includes(o.status)) throw new Error(`Row ${i + 1}: status must be "active" or "candidate".`);
              return o;
            });
            setWarehouses(parsed);
            setOpenIds(parsed.filter(w => w.status === "active").map(w => w.id));
            setCapOverride({}); setLaneMult({}); setScenarios([]);
          } else {
            const parsed = rows.map((r, i) => {
              const o = { id: uid("D"), name: String(r.name || "D" + (i + 1)).trim(), x: +r.x, y: +r.y, demand: +r.demand };
              if ([o.x, o.y, o.demand].some(v => !isFinite(v))) throw new Error(`Row ${i + 1}: x, y, demand must be numbers.`);
              return o;
            });
            setCustomers(parsed); setLaneMult({});
          }
          setUploadKind(null); setUploadErr("");
        } catch (err) { setUploadErr(err.message); }
      },
      error: err => setUploadErr(err.message),
    });
  }

  const selWh = selected?.kind === "wh" ? whById[selected.id] : null;
  const selCust = selected?.kind === "cust" ? cById[selected.id] : null;
  const selOpen = selWh ? openIds.includes(selWh.id) : false;
  const selCap = selWh ? (capOverride[selWh.id] ?? selWh.capacity) : 0;
  const selExpCost = selWh ? Math.max(0, selCap - selWh.capacity) * EXP_RATE : 0;

  const sensOpts = { rateMult: sens.rateMult, demandMult: sens.demandMult, svcKm: sens.svcKm, carbonPrice };
  const cmpBaseline = useMemo(() => computeKpis(warehouses, customers, activeIds, {}, laneMult, sensOpts), [warehouses, customers, activeIds, laneMult, sens, carbonPrice]); // eslint-disable-line
  const cmpRows = useMemo(() => scenarios.map(sc => ({ sc, k: computeKpis(warehouses, customers, sc.openIds, sc.capOverride, laneMult, sensOpts) })), [scenarios, warehouses, customers, laneMult, sens, carbonPrice]); // eslint-disable-line
  const allCmp = [{ sc: { id: "base", name: "Baseline (current state)" }, k: cmpBaseline }, ...cmpRows];
  const bestCost = Math.min(...allCmp.map(r => r.k.totalCost));
  const bestDist = Math.min(...allCmp.map(r => r.k.avgDistance));
  const bestSvc = Math.max(...allCmp.map(r => r.k.serviceLevel));
  const bestCarb = Math.min(...allCmp.map(r => r.k.carbon));
  const maxCmpCost = Math.max(...allCmp.map(r => r.k.totalCost), 1);
  const winnerId = allCmp.length > 1 ? [...allCmp].sort((a, b) => objScore(a.k, objective, allCmp) - objScore(b.k, objective, allCmp))[0].sc.id : null;

  /* lane flow ₹cr/yr lookup from current sim flows */
  const laneAnnual = useMemo(() => {
    const m = {};
    kpi.flows.forEach(f => { m[laneKey(f.from, f.to)] = (m[laneKey(f.from, f.to)] || 0) + f.volume * f.distance * f.m * RATE_CR; });
    return m;
  }, [kpi.flows]);

  const objectives = [
    { id: "cost", label: "Cost", icon: IndianRupee },
    { id: "service", label: "Service", icon: Truck },
    { id: "balanced", label: "Balanced", icon: Target },
    { id: "carbon", label: "Carbon", icon: Leaf },
  ];

  return (
    <div style={S.root}>
      <style>{css}</style>

      <header style={S.topbar}>
        <div style={S.brand}>
          <div style={S.logoMark}><Cpu size={17} strokeWidth={2.4} /></div>
          <div>
            <div style={S.brandName}>NetOptim</div>
            <div style={S.brandSub}>AI copilot · logistics network design</div>
          </div>
        </div>

        <div style={S.tabs}>
          <button onClick={() => setTab("setup")} style={{ ...S.tabBtn, ...(tab === "setup" ? S.tabOn : {}) }}><Database size={13} /> 1 · Problem & Data</button>
          <button onClick={() => setTab("sim")} style={{ ...S.tabBtn, ...(tab === "sim" ? S.tabOn : {}) }}><MapIcon size={13} /> 2 · Simulator</button>
          <button onClick={() => setTab("cmp")} style={{ ...S.tabBtn, ...(tab === "cmp" ? S.tabOn : {}) }}>
            <GitCompare size={13} /> 3 · Compare & Sensitivity {scenarios.length > 0 && <span style={S.tabCount}>{scenarios.length}</span>}
          </button>
        </div>

        {tab === "sim" && <>
          <div style={S.objWrap}>
            <span style={S.objLabel}>Optimise for</span>
            <div style={S.objGroup}>
              {objectives.map(o => { const Ic = o.icon; const on = objective === o.id; return (
                <button key={o.id} onClick={() => setObjective(o.id)} style={{ ...S.objBtn, ...(on ? S.objBtnOn : {}) }}><Ic size={13} strokeWidth={2.2} /> {o.label}</button>); })}
            </div>
          </div>
          <div style={S.topActions}>
            <button onClick={() => runOptimize()} style={S.optimizeBtn} className="glow"><Zap size={14} strokeWidth={2.5} /> Converge to optimum</button>
            <button onClick={doReset} style={S.resetBtn} title="Reset to baseline"><RotateCcw size={14} /></button>
          </div>
        </>}
        {tab === "setup" && (
          <div style={S.topActions}>
            <button onClick={newProblem} style={S.ghostBtn}><FilePlus2 size={14} /> New problem</button>
            <button onClick={loadSample} style={S.ghostBtn}><RefreshCw size={14} /> Load sample</button>
            <button onClick={() => setTab("sim")} style={S.optimizeBtn} className="glow">Open simulator <ChevronRight size={14} /></button>
          </div>
        )}
      </header>

      {/* ============ TAB 1 ============ */}
      {tab === "setup" && (
        <div style={S.setupWrap}>
          <div style={S.setupGrid}>
            <section style={S.card}>
              <div style={S.cardHead}><FileText size={14} /> Problem brief</div>
              <textarea value={brief} onChange={e => setBrief(e.target.value)} style={S.brief} spellCheck={false}
                placeholder="Describe the client's network problem: current footprint, pain points, candidate options, and the decision to be made…" />
              <div style={S.paramRow}>
                <Param label="Service threshold" value={`${DEFAULT_SVC_KM} km`} />
                <Param label="Base freight rate" value={`₹${BASE_RATE.toFixed(2)}/unit·km`} />
                <Param label="Expansion cost" value={`₹${(EXP_RATE * 100).toFixed(1)}cr /100k·yr`} />
                <Param label="Total annual demand" value={`${customers.reduce((s, c) => s + c.demand, 0).toLocaleString()}k units`} />
              </div>
            </section>

            <section style={S.card}>
              <div style={S.cardHead}><Upload size={14} /> Bring your own data</div>
              <p style={S.cardText}>Load your network from CSV. Pick a dataset — you get the exact columns required and a pre-filled template. <b style={{ color: "#e8e8e8" }}>No IDs needed</b> — rows are identified by name; IDs are generated automatically.</p>
              <div style={S.uploadBtns}>
                <button style={S.upBtn} onClick={() => { setUploadKind("warehouses"); setUploadErr(""); }}><Building2 size={14} /> Warehouse data</button>
                <button style={S.upBtn} onClick={() => { setUploadKind("demand"); setUploadErr(""); }}><Target size={14} /> Demand data</button>
              </div>
              {uploadKind && (
                <div style={S.uploadPanel}>
                  <div style={S.upTitle}>Required columns · {uploadKind}</div>
                  <code style={S.cols}>{(uploadKind === "warehouses" ? WH_COLS : CU_COLS).join(", ")}</code>
                  <div style={S.upNote}>{uploadKind === "warehouses"
                    ? "type = Hub | Regional | Cross-dock | Fulfilment | 3PL · x,y = canvas 0–1000 · capacity in ’000 units/YEAR · fixedCost in ₹cr/yr · opex in ₹ per unit handled"
                    : "x,y = canvas coords 0–1000 · demand in ’000 units/YEAR"}</div>
                  <div style={S.upActions}>
                    <button style={S.tmplBtn} onClick={() => uploadKind === "warehouses"
                      ? downloadCsv("warehouses_template.csv", warehouses.length ? warehouses : SEED_WAREHOUSES, WH_COLS)
                      : downloadCsv("demand_template.csv", customers.length ? customers : SEED_CUSTOMERS, CU_COLS)}>
                      <Download size={13} /> Download template (pre-filled)
                    </button>
                    <button style={S.chooseBtn} onClick={() => fileRef.current && fileRef.current.click()}><Upload size={13} /> Choose CSV file</button>
                    <button style={S.cancelBtn} onClick={() => setUploadKind(null)}>Cancel</button>
                  </div>
                  {uploadErr && <div style={S.upErr}><AlertTriangle size={12} /> {uploadErr}</div>}
                  <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={handleFile} style={{ display: "none" }} />
                </div>
              )}
            </section>
          </div>

          <section style={S.card}>
            <div style={S.cardHeadRow}>
              <div style={S.cardHead}><Building2 size={14} /> Warehouses & candidate sites <span style={S.count}>{warehouses.length}</span></div>
              <button style={S.addRowBtn} onClick={addWhRow}><Plus size={13} /> Add site</button>
            </div>
            {warehouses.length === 0 ? <Empty text="No sites yet — add one, upload a CSV, or load the sample." /> : (
              <div style={S.tableWrap}>
                <table style={S.table}>
                  <thead><tr>{["Name", "Type", "X", "Y", "Capacity (’000u / yr)", "Fixed cost (₹cr / yr)", "Opex (₹ / unit)", "Status", ""].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
                  <tbody>
                    {warehouses.map(w => (
                      <tr key={w.id}>
                        <td style={S.td}><input style={S.cellIn} value={w.name} onChange={e => setWhField(w.id, { name: e.target.value })} /></td>
                        <td style={S.td}>
                          <select style={S.cellSel} value={w.type} onChange={e => setWhField(w.id, { type: e.target.value })}>
                            {WH_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                          </select>
                        </td>
                        <td style={S.td}><input style={S.cellNum} type="number" value={w.x} onChange={e => setWhField(w.id, { x: +e.target.value || 0 })} /></td>
                        <td style={S.td}><input style={S.cellNum} type="number" value={w.y} onChange={e => setWhField(w.id, { y: +e.target.value || 0 })} /></td>
                        <td style={S.td}><input style={S.cellNum} type="number" value={w.capacity} onChange={e => setWhField(w.id, { capacity: Math.max(0, +e.target.value || 0) })} /></td>
                        <td style={S.td}><input style={S.cellNum} type="number" step="0.1" value={w.fixedCost} onChange={e => setWhField(w.id, { fixedCost: Math.max(0, +e.target.value || 0) })} /></td>
                        <td style={S.td}><input style={S.cellNum} type="number" step="0.1" value={w.opex} onChange={e => setWhField(w.id, { opex: Math.max(0, +e.target.value || 0) })} /></td>
                        <td style={S.td}><button onClick={() => setWhField(w.id, { status: w.status === "active" ? "candidate" : "active" })}
                          style={{ ...S.statusPill, ...(w.status === "active" ? S.pillActive : S.pillCand) }}>{w.status}</button></td>
                        <td style={S.td}><button style={S.rowDel} onClick={() => removeWh(w.id)}><Trash2 size={13} /></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section style={S.card}>
            <div style={S.cardHeadRow}>
              <div style={S.cardHead}><Target size={14} /> Demand regions <span style={S.count}>{customers.length}</span></div>
              <button style={S.addRowBtn} onClick={addCustRow}><Plus size={13} /> Add region</button>
            </div>
            {customers.length === 0 ? <Empty text="No demand regions yet — add one, upload a CSV, or load the sample." /> : (
              <div style={S.tableWrap}>
                <table style={S.table}>
                  <thead><tr>{["Region", "X", "Y", "Demand (’000u / yr)", ""].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
                  <tbody>
                    {customers.map(c => (
                      <tr key={c.id}>
                        <td style={S.td}><input style={S.cellIn} value={c.name} onChange={e => setCustField(c.id, { name: e.target.value })} /></td>
                        <td style={S.td}><input style={S.cellNum} type="number" value={c.x} onChange={e => setCustField(c.id, { x: +e.target.value || 0 })} /></td>
                        <td style={S.td}><input style={S.cellNum} type="number" value={c.y} onChange={e => setCustField(c.id, { y: +e.target.value || 0 })} /></td>
                        <td style={S.td}><input style={S.cellNum} type="number" value={c.demand} onChange={e => setCustField(c.id, { demand: Math.max(0, +e.target.value || 0) })} /></td>
                        <td style={S.td}><button style={S.rowDel} onClick={() => removeCust(c.id)}><Trash2 size={13} /></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* lane freight cost */}
          <section style={S.card}>
            <div style={S.cardHeadRow}>
              <div style={S.cardHead}><Grid3X3 size={14} /> Lane-wise freight cost <span style={S.count}>{warehouses.length}×{customers.length}</span></div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {showLanes && <div style={S.objGroup}>
                  {[["mult", "Multiplier ×"], ["unit", "₹ / unit"], ["annual", "₹cr / yr"]].map(([v, l]) => (
                    <button key={v} onClick={() => setLaneView(v)} style={{ ...S.objBtn, ...(laneView === v ? S.objBtnOn : {}), fontSize: 11.5, padding: "5px 9px" }}>{l}</button>))}
                </div>}
                <button style={S.addRowBtn} onClick={() => setShowLanes(v => !v)}>{showLanes ? "Hide" : "Show lane costs"}</button>
              </div>
            </div>
            <p style={S.cardText}>
              Lane freight ₹/unit = distance × ₹{BASE_RATE.toFixed(2)}/unit·km × <b style={{ color: "#e8e8e8" }}>lane multiplier</b> (edit in Multiplier view; default ×1.00 = uniform rate).
              The routing engine assigns volume by <b style={{ color: "#e8e8e8" }}>freight + origin handling opex</b>, not raw distance. ₹cr/yr view shows actual annual freight on each lane under the current simulator configuration ("—" = no flow).
            </p>
            {showLanes && (warehouses.length && customers.length ? (
              <div style={S.tableWrap}>
                <table style={S.table}>
                  <thead><tr><th style={S.th}>{laneView === "mult" ? "× base" : laneView === "unit" ? "₹ / unit" : "₹cr / yr"}</th>{customers.map(c => <th key={c.id} style={S.thC}>{c.name}</th>)}</tr></thead>
                  <tbody>
                    {warehouses.map(w => (
                      <tr key={w.id}>
                        <td style={{ ...S.tdc, fontFamily: mono, fontSize: 12, whiteSpace: "nowrap" }}>{w.name}</td>
                        {customers.map(c => {
                          const k = laneKey(w.id, c.id);
                          const m = laneMult[k] ?? 1;
                          if (laneView === "mult") return <td key={c.id} style={S.tdLane}>
                            <input style={{ ...S.laneIn, color: m !== 1 ? "#F5A524" : "#8a8a8a", fontWeight: m !== 1 ? 700 : 400 }}
                              type="number" step="0.05" min="0.25" max="4" value={m}
                              onChange={e => { const nv = +e.target.value; setLaneMult(x => { const n = { ...x }; if (!isFinite(nv) || nv === 1) delete n[k]; else n[k] = Math.max(0.25, Math.min(4, nv)); return n; }); }} />
                          </td>;
                          if (laneView === "unit") { const v = dist(w, c) * m * BASE_RATE; return <td key={c.id} style={{ ...S.tdLane, fontFamily: mono, fontSize: 11, color: v > 120 ? "#F85149" : v > 60 ? "#F5A524" : "#8a8a8a" }}>{v.toFixed(0)}</td>; }
                          const a = laneAnnual[k]; return <td key={c.id} style={{ ...S.tdLane, fontFamily: mono, fontSize: 11, color: a ? (a > 2 ? "#F85149" : a > 1 ? "#F5A524" : "#c9c9c9") : "#3a3a3a" }}>{a ? a.toFixed(2) : "—"}</td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <Empty text="Add warehouses and demand regions first." />)}
          </section>
        </div>
      )}

      {/* ============ TAB 2 ============ */}
      {tab === "sim" && <>
        <div style={S.main}>
          <section style={S.mapWrap}>
            {!hasData && <div style={S.noData}>No network loaded.<br /><span style={{ fontSize: 12.5, color: "#777" }}>Add sites & demand regions in <b>Problem & Data</b>, or load the sample.</span></div>}
            <div style={S.mapChrome}>
              <div style={S.mapTitle}>Network · <span style={{ color: "#9a9a9a" }}>{openIds.length} active DCs · {customers.length} regions</span></div>
              <div style={{ display: "flex", gap: 8, pointerEvents: "auto" }}>
                <button onClick={() => setAddingDemand(a => !a)} style={{ ...S.addDemandBtn, ...(addingDemand ? S.addDemandOn : {}) }}>
                  <Plus size={13} /> {addingDemand ? "Click map to place…" : "Demand centre"}
                </button>
                <div style={S.flowToggle}>
                  <span style={S.toggleLabel}>Flows by</span>
                  {["cost", "volume"].map(m => (
                    <button key={m} onClick={() => setFlowMetric(m)} style={{ ...S.toggleBtn, ...(flowMetric === m ? S.toggleBtnOn : {}) }}>{m}</button>))}
                </div>
              </div>
            </div>

            <svg ref={svgRef} viewBox="0 0 1000 1000" style={{ ...S.svg, cursor: addingDemand ? "crosshair" : "default" }} onClick={mapClick}>
              <defs>
                <pattern id="grid" width="50" height="50" patternUnits="userSpaceOnUse">
                  <path d="M50 0 H0 V50" fill="none" stroke="#151515" strokeWidth="1" />
                </pattern>
                <radialGradient id="vig" cx="50%" cy="45%" r="75%">
                  <stop offset="55%" stopColor="transparent" /><stop offset="100%" stopColor="#050505" />
                </radialGradient>
              </defs>
              <rect width="1000" height="1000" fill="url(#grid)" />
              <rect width="1000" height="1000" fill="url(#vig)" />

              {kpi.flows.map((f, i) => {
                const w = whById[f.from], c = cById[f.to]; if (!w || !c) return null;
                const t = uHi === uLo ? 0 : (f.distance * f.m - uLo) / (uHi - uLo);
                const col = flowMetric === "cost" ? flowColor(t) : "#3d6ea8";
                return <line key={i} x1={w.x} y1={w.y} x2={c.x} y2={c.y} stroke={col}
                  strokeWidth={0.6 + (f.volume / maxVol) * 5.2} strokeOpacity={f.over ? 0.95 : 0.55}
                  strokeLinecap="round" strokeDasharray={f.over ? "2 6" : "none"} />;
              })}

              {customers.map(c => {
                const s = 5 + (c.demand / maxDemand) * 7;
                const isSel = selected?.kind === "cust" && selected.id === c.id;
                return (
                  <g key={c.id} onClick={e => { e.stopPropagation(); if (!addingDemand) { demandStartRef.current = c.demand; setSelected({ kind: "cust", id: c.id }); } }} style={{ cursor: "pointer" }}>
                    {isSel && <rect x={c.x - s - 5} y={c.y - s - 5} width={(s + 5) * 2} height={(s + 5) * 2} rx="3" transform={`rotate(45 ${c.x} ${c.y})`} fill="none" stroke="#ffffff" strokeWidth="1.8" />}
                    <rect x={c.x - s} y={c.y - s} width={s * 2} height={s * 2} rx="1.5" transform={`rotate(45 ${c.x} ${c.y})`}
                      fill="#5b6f92" fillOpacity={isSel ? 1 : 0.85} />
                    <text x={c.x} y={c.y + s + 15} style={S.custLabel}>{c.name}</text>
                  </g>
                );
              })}

              {warehouses.map(w => {
                const isOpen = openIds.includes(w.id);
                const u = kpi.util[w.id];
                const r = isOpen ? 12 + Math.sqrt(kpi.throughput[w.id] || 0) / Math.sqrt(maxThru) * 20 : 11;
                const col = isOpen ? utilColor(u) : "#3a3a3a";
                const isSel = selected?.kind === "wh" && selected.id === w.id;
                return (
                  <g key={w.id} onClick={e => { e.stopPropagation(); if (!addingDemand) { capStartRef.current = capOverride[w.id] ?? w.capacity; setSelected({ kind: "wh", id: w.id }); } }} style={{ cursor: "pointer" }}>
                    {isSel && <circle cx={w.x} cy={w.y} r={r + 8} fill="none" stroke="#ffffff" strokeWidth="2" strokeOpacity="0.9" />}
                    {isOpen && u > 1 && <circle cx={w.x} cy={w.y} r={r + 5} fill="none" stroke="#F85149" strokeWidth="1.5" strokeOpacity="0.6" className="pulse" />}
                    <circle cx={w.x} cy={w.y} r={r} fill={isOpen ? col : "transparent"} fillOpacity={isOpen ? 0.2 : 1}
                      stroke={col} strokeWidth={isOpen ? 2.4 : 1.6} strokeDasharray={isOpen ? "none" : "4 4"} />
                    <circle cx={w.x} cy={w.y} r={3} fill={col} />
                    <text x={w.x} y={w.y - r - 8} style={{ ...S.whLabel, fill: isOpen ? "#f2f2f2" : "#6e6e6e" }}>{w.name}{!isOpen && " +"}</text>
                    {isOpen && <text x={w.x} y={w.y - r + 7} style={S.whUtil}>{((u || 0) * 100).toFixed(0)}%</text>}
                  </g>
                );
              })}
            </svg>

            <div style={S.legend}>
              <Dot c="#2FB8D6" t="Under 50%" /><Dot c="#3FB950" t="Healthy" /><Dot c="#F5A524" t="High load" /><Dot c="#F85149" t="Overloaded" />
              <span style={S.legendSep} />
              <span style={S.legendNote}>line colour = lane cost (cyan→red) · thickness = volume (corridors) · ◇ demand · ○ DC (size = throughput) · dashed = candidate</span>
            </div>

            {selWh && (
              <div style={S.editor}>
                <div style={S.editorHead}>
                  <div>
                    <div style={S.editorName}><Building2 size={14} /> {selWh.name}</div>
                    <div style={S.editorRole}>{selWh.type}{selWh.status === "candidate" ? " · candidate" : ""}</div>
                  </div>
                  <button onClick={() => setSelected(null)} style={S.editorClose}><X size={14} /></button>
                </div>
                {selOpen ? <>
                  <Row k="Utilisation" v={((kpi.util[selWh.id] || 0) * 100).toFixed(0) + "%"} c={utilColor(kpi.util[selWh.id])} />
                  <Row k="Throughput" v={Math.round(kpi.throughput[selWh.id] || 0).toLocaleString() + "k u/yr"} />
                  <Row k="Fixed cost" v={inr(selWh.fixedCost) + "/yr"} />
                  <Row k="Handling opex" v={"₹" + selWh.opex.toFixed(1) + "/unit"} />
                  <div style={S.sliderRow}>
                    <div style={S.sliderTop}><span>Capacity (’000u/yr)</span><b>{selCap.toLocaleString()}k</b></div>
                    <input type="range" min={600} max={3000} step={50} value={selCap}
                      onChange={e => setCapOverride(o => ({ ...o, [selWh.id]: +e.target.value }))}
                      onMouseUp={() => { if (capStartRef.current !== selCap) { autoLog(openIds, capOverride); capStartRef.current = selCap; } }}
                      onTouchEnd={() => { if (capStartRef.current !== selCap) { autoLog(openIds, capOverride); capStartRef.current = selCap; } }}
                      style={S.slider} />
                  </div>
                  {selExpCost > 0
                    ? <div style={S.expWarn}><AlertTriangle size={11} color="#F5A524" /> Expansion +{(selCap - selWh.capacity).toLocaleString()}k → <b>+{inr(selExpCost)}/yr</b> fixed cost (priced into optimiser)</div>
                    : <div style={S.expNote}>Expanding above base ({selWh.capacity.toLocaleString()}k) costs ₹{(EXP_RATE * 100).toFixed(1)}cr per 100k/yr — priced into the optimiser. In-lease shrink below base saves nothing (lease committed); the full fixed cost is avoidable only by exiting the site at lease break — which is how a closure is modelled.</div>}
                  <button onClick={() => toggleNode(selWh.id)} style={S.dangerBtn}>Close this DC</button>
                  <button onClick={() => setWhField(selWh.id, { lockOpen: !selWh.lockOpen })}
                    style={{ ...S.dangerBtn, marginTop: 6, background: selWh.lockOpen ? "#1f6feb22" : "transparent", borderColor: selWh.lockOpen ? "#1f6feb" : "#30363d", color: selWh.lockOpen ? "#58a6ff" : "#8b949e" }}>
                    {selWh.lockOpen ? "🔒 Locked open — optimiser can't close this DC" : "Lock open (exclude from close search)"}
                  </button>
                </> : <>
                  <Row k="Capacity" v={selWh.capacity.toLocaleString() + "k u/yr"} />
                  <Row k="Opening cost" v={inr(selWh.fixedCost) + "/yr"} />
                  <Row k="Handling opex" v={"₹" + selWh.opex.toFixed(1) + "/unit"} />
                  <div style={S.candNote}>Candidate site — opening adds its fixed cost to the network.</div>
                  <button onClick={() => toggleNode(selWh.id)} style={S.confirmBtn}>Open this DC</button>
                </>}
              </div>
            )}

            {selCust && (
              <div style={S.editor}>
                <div style={S.editorHead}>
                  <div>
                    <div style={S.editorName}><Target size={14} /> Demand region</div>
                    <input style={S.nameIn} value={selCust.name} onChange={e => setCustField(selCust.id, { name: e.target.value })} />
                  </div>
                  <button onClick={() => setSelected(null)} style={S.editorClose}><X size={14} /></button>
                </div>
                <div style={S.sliderRow}>
                  <div style={S.sliderTop}><span>Demand (’000u/yr)</span><b>{selCust.demand.toLocaleString()}k</b></div>
                  <input type="range" min={50} max={1500} step={25} value={selCust.demand}
                    onChange={e => setCustField(selCust.id, { demand: +e.target.value })}
                    onMouseUp={() => { const s = demandStartRef.current; if (s != null && s !== selCust.demand) { const cur = selCust.demand; setCustField(selCust.id, { demand: s }); setTimeout(() => applyDemandChange(selCust.id, cur, "via slider"), 0); demandStartRef.current = cur; } }}
                    onTouchEnd={() => { const s = demandStartRef.current; if (s != null && s !== selCust.demand) { const cur = selCust.demand; setCustField(selCust.id, { demand: s }); setTimeout(() => applyDemandChange(selCust.id, cur, "via slider"), 0); demandStartRef.current = cur; } }}
                    style={S.slider} />
                </div>
                <Row k="Served from" v={kpi.flows.filter(f => f.to === selCust.id).map(f => whById[f.from]?.name).join(", ") || "—"} />
                <Row k="Avg haul" v={(() => { const fl = kpi.flows.filter(f => f.to === selCust.id); const v = fl.reduce((s, f) => s + f.volume, 0); return v ? (fl.reduce((s, f) => s + f.volume * f.distance, 0) / v).toFixed(0) + " km" : "—"; })()} />
                <button onClick={() => removeCust(selCust.id)} style={S.dangerBtn}>Remove region</button>
              </div>
            )}
          </section>

          <aside style={S.copilot}>
            <div style={S.copilotHead}>
              <div style={S.copilotTitle}><Sparkles size={15} /> Copilot</div>
              <div style={S.copilotObj}>obj: <b style={{ color: "#ffffff" }}>{objective}</b></div>
            </div>
            <div ref={feedRef} style={S.feed}>
              {messages.map(m => m.role === "user" ? <div key={m.id} style={S.userMsg}>{m.payload.text}</div> : <AiMsg key={m.id} p={m.payload} />)}
            </div>
            <div style={S.composer}>
              <button onMouseEnter={() => setMicHint(true)} onMouseLeave={() => setMicHint(false)} onClick={() => setMicHint(h => !h)} style={S.micBtn} title="Voice input"><Mic size={15} /></button>
              {micHint && <div style={S.micTip}>Voice connects to a speech service in deployment</div>}
              <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === "Enter" && submitQuery()}
                placeholder="Ask a what-if or say “optimise for cost”…" style={S.input} />
              <button onClick={submitQuery} style={S.sendBtn}><Send size={15} /></button>
            </div>
            <div style={S.suggestRow}>
              {["Open WH 6", "Increase demand at D9 by 30%", "Set carbon tax to 800", "Optimise for cost"].map(s => (
                <button key={s} onClick={() => { push("user", { text: s }); parseQuery(s); }} style={S.chip}>{s}</button>))}
            </div>
          </aside>
        </div>

        <footer style={S.kpiBar}>
          <Kpi icon={IndianRupee} label="Total network cost" value={inr(kpi.totalCost)} delta={deltas.cost} unit="cr" good={deltas.cost < 0}
            sub={`${inr(kpi.transportCost)} freight + ${inr(kpi.handlingCost)} handling + ${inr(kpi.fixedCost)} fixed${kpi.carbonCost > 0.05 ? ` + ${inr(kpi.carbonCost)} carbon` : ""}`} />
          <Kpi icon={Truck} label="Avg distance to customer" value={kpi.avgDistance.toFixed(0) + " km"} delta={deltas.distance} unit=" km" good={deltas.distance < 0} sub="service proxy" />
          <Kpi icon={Gauge} label="Service level" value={(kpi.serviceLevel * 100).toFixed(1) + "%"} delta={deltas.service} unit=" pts" good={deltas.service > 0} sub={`within ${DEFAULT_SVC_KM} km`} />
          <Kpi icon={Building2} label="Sites at/over capacity" value={`${openIds.filter(id => kpi.util[id] > 0.99).length} / ${openIds.length}`} sub="utilisation risk" />
          <div style={S.kpi}>
            <div style={S.kpiTop}><Leaf size={13} color="#6e6e6e" /><span style={S.kpiLabel}>Carbon</span></div>
            <div style={S.kpiValRow}>
              <span style={S.kpiValue}>{kpi.carbon.toFixed(0)}k</span>
              {Math.abs(deltas.carbon) > 0.05 && <span style={{ ...S.kpiDelta, color: deltas.carbon < 0 ? GOOD : BAD }}>
                {deltas.carbon < 0 ? <TrendingDown size={12} /> : <TrendingUp size={12} />}{deltas.carbon > 0 ? "+" : ""}{deltas.carbon.toFixed(0)}k</span>}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 4 }}>
              <span style={{ ...S.kpiSub, whiteSpace: "nowrap" }}>tax ₹{carbonPrice}/t{kpi.carbonCost > 0.05 ? ` (${inr(kpi.carbonCost)})` : ""}</span>
              <input type="range" min={0} max={2000} step={50} value={carbonPrice}
                onChange={e => setCarbonPrice(+e.target.value)} style={{ flex: 1, minWidth: 50 }} title="Carbon price ₹/tCO₂" />
            </div>
          </div>
        </footer>
      </>}

      {/* ============ TAB 3 ============ */}
      {tab === "cmp" && (
        <div style={S.setupWrap}>
          <section style={S.card}>
            <div style={S.cardHead}><Gauge size={14} /> Sensitivity — stress-test the assumptions</div>
            <p style={S.cardText}>Every configuration tested in the Simulator is logged below automatically. Drag these to see how each holds up if freight rates spike, demand grows, the service promise tightens, or a carbon tax lands. A scenario that keeps winning as assumptions swing is a robust recommendation.</p>
            <div style={S.sensGrid}>
              <SensSlider label="Transport rate" value={sens.rateMult} min={0.6} max={1.6} step={0.05} fmt={v => "×" + v.toFixed(2)} base={1}
                onChange={v => setSens(s => ({ ...s, rateMult: v }))} />
              <SensSlider label="Demand (all regions)" value={sens.demandMult} min={0.7} max={1.4} step={0.05} fmt={v => "×" + v.toFixed(2)} base={1}
                onChange={v => setSens(s => ({ ...s, demandMult: v }))} />
              <SensSlider label="Service threshold" value={sens.svcKm} min={400} max={1000} step={25} fmt={v => v + " km"} base={DEFAULT_SVC_KM}
                onChange={v => setSens(s => ({ ...s, svcKm: v }))} />
              <SensSlider label="Carbon price" value={carbonPrice} min={0} max={2000} step={50} fmt={v => "₹" + v + "/t"} base={0}
                onChange={v => setCarbonPrice(v)} />
              <div style={{ display: "flex", alignItems: "flex-end" }}>
                <button style={S.ghostBtn} onClick={() => { setSens({ rateMult: 1, demandMult: 1, svcKm: DEFAULT_SVC_KM }); setCarbonPrice(0); }}><RotateCcw size={13} /> Reset</button>
              </div>
            </div>
          </section>

          <section style={S.card}>
            <div style={S.cardHeadRow}>
              <div style={S.cardHead}><GitCompare size={14} /> Scenario comparison <span style={S.count}>{allCmp.length}</span></div>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <span style={{ fontSize: 11.5, color: "#777" }}>winner scored on:</span>
                <div style={S.objGroup}>
                  {objectives.map(o => { const on = objective === o.id; return (
                    <button key={o.id} onClick={() => setObjective(o.id)} style={{ ...S.objBtn, ...(on ? S.objBtnOn : {}), fontSize: 11.5, padding: "5px 9px" }}>{o.label}</button>); })}
                </div>
              </div>
            </div>
            {scenarios.length === 0 && <Empty text="Nothing logged yet. Test configurations in the Simulator — open/close sites, expand capacity, or run the optimiser — and each one appears here automatically." />}

            {scenarios.length > 0 && (
              <div style={S.barSection}>
                {allCmp.map(({ sc, k }) => {
                  const isWin = sc.id === winnerId;
                  return (
                    <div key={sc.id} style={S.barRow}>
                      <div style={S.barName}>{isWin && <Star size={11} fill="#F5A524" color="#F5A524" style={{ marginRight: 4, verticalAlign: "-1px" }} />}{sc.name}</div>
                      <div style={S.barTrack}>
                        <div style={{ ...S.barFill, width: (k.totalCost / maxCmpCost * 100) + "%", background: isWin ? "linear-gradient(90deg,#3FB950,#2FB8D6)" : "#3a3a3a", outline: isWin ? "1px solid rgba(63,185,80,.5)" : "none" }} />
                        <span style={S.barVal}>{inr(k.totalCost)}</span>
                      </div>
                      <div style={{ ...S.barSvc, color: k.serviceLevel >= 0.98 ? GOOD : k.serviceLevel >= 0.9 ? "#F5A524" : BAD }}>{(k.serviceLevel * 100).toFixed(1)}%</div>
                    </div>
                  );
                })}
                <div style={S.barLegend}>bar = total cost (shorter is better) · right column = service level · ★ = best for “{objective}” under current assumptions</div>
              </div>
            )}

            <div style={S.tableWrap}>
              <table style={S.table}>
                <thead><tr>{["Scenario", "Total cost", "Freight", "Handling", "Fixed", "Carbon ₹", "Avg dist", "Service", "Over-cap", "tCO₂", ""].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
                <tbody>
                  {allCmp.map(({ sc, k }) => {
                    const isBase = sc.id === "base";
                    const isWin = sc.id === winnerId;
                    const cell = (val, isBest, delta, unit, goodDown = true) => (
                      <td style={{ ...S.tdc, ...(isBest ? S.bestCell : {}) }}>
                        <div style={S.cmpVal}>{val}</div>
                        {!isBase && Math.abs(delta) > 0.05 && <div style={{ ...S.cmpDelta, color: (goodDown ? delta < 0 : delta > 0) ? GOOD : BAD }}>{delta > 0 ? "+" : ""}{Math.abs(delta) >= 10 ? delta.toFixed(0) : delta.toFixed(1)}{unit}</div>}
                      </td>);
                    const overCap = k.openIds.filter(id => k.util[id] > 0.99).length;
                    return (
                      <tr key={sc.id} style={isBase ? S.baseRow : (isWin ? S.winRow : null)}>
                        <td style={S.tdc}>
                          <div style={{ fontWeight: 600, fontSize: 12.8 }}>{isWin && <Star size={11} fill="#F5A524" color="#F5A524" style={{ marginRight: 4, verticalAlign: "-1px" }} />}{sc.name}</div>
                          <div style={{ fontSize: 10.5, color: "#777", fontFamily: mono }}>{k.openIds.length} DCs open</div>
                        </td>
                        {cell(inr(k.totalCost), Math.abs(k.totalCost - bestCost) < 1e-9, k.totalCost - cmpBaseline.totalCost, "cr")}
                        {cell(inr(k.transportCost), false, k.transportCost - cmpBaseline.transportCost, "cr")}
                        {cell(inr(k.handlingCost), false, k.handlingCost - cmpBaseline.handlingCost, "cr")}
                        {cell(inr(k.fixedCost), false, k.fixedCost - cmpBaseline.fixedCost, "cr")}
                        {cell(k.carbonCost > 0.005 ? inr(k.carbonCost) : "—", false, k.carbonCost - cmpBaseline.carbonCost, "cr")}
                        {cell(k.avgDistance.toFixed(0) + " km", Math.abs(k.avgDistance - bestDist) < 1e-9, k.avgDistance - cmpBaseline.avgDistance, "km")}
                        {cell((k.serviceLevel * 100).toFixed(1) + "%", Math.abs(k.serviceLevel - bestSvc) < 1e-9, (k.serviceLevel - cmpBaseline.serviceLevel) * 100, "pts", false)}
                        <td style={S.tdc}><div style={{ ...S.cmpVal, color: overCap ? "#F5A524" : GOOD }}>{overCap} / {k.openIds.length}</div></td>
                        {cell(k.carbon.toFixed(0) + "k", Math.abs(k.carbon - bestCarb) < 1e-9, k.carbon - cmpBaseline.carbon, "k")}
                        <td style={S.tdc}>{!isBase && <div style={{ display: "flex", gap: 4 }}>
                          <button style={S.miniBtn} onClick={() => { setOpenIds([...sc.openIds]); setCapOverride({ ...sc.capOverride }); setTab("sim"); push("ai", { kind: "note", text: `Loaded “${sc.name}” into the simulator.` }); }}>Load</button>
                          <button style={S.rowDel} onClick={() => setScenarios(s => s.filter(x => x.id !== sc.id))}><Trash2 size={12} /></button>
                        </div>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {scenarios.length > 0 && (
              <div style={S.cmpNote}>All rows re-solved live under the sensitivity assumptions above — green deltas = better than baseline, red = worse. Best value per column outlined. If the ★ stays on one scenario as you drag the sliders, that recommendation is robust.</div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

/* ---- small components ---- */
const Dot = ({ c, t }) => <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: "#9a9a9a" }}><span style={{ width: 9, height: 9, borderRadius: 9, background: c }} />{t}</span>;
const Param = ({ label, value }) => <div style={S.param}><div style={S.paramLabel}>{label}</div><div style={S.paramValue}>{value}</div></div>;
const Row = ({ k, v, c }) => <div style={S.editRow}><span>{k}</span><b style={c ? { color: c } : null}>{v}</b></div>;
const Empty = ({ text }) => <div style={S.empty}>{text}</div>;

function SensSlider({ label, value, min, max, step, fmt, base, onChange }) {
  const changed = Math.abs(value - base) > 0.001;
  return (
    <div style={S.sensCell}>
      <div style={S.sliderTop}><span>{label}</span><b style={{ color: changed ? "#F5A524" : "#c9c9c9" }}>{fmt(value)}</b></div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(+e.target.value)} style={{ width: "100%" }} />
    </div>
  );
}

function Kpi({ icon: Ic, label, value, delta, unit, good, sub }) {
  const show = typeof delta === "number" && Math.abs(delta) > 0.05;
  return (
    <div style={S.kpi}>
      <div style={S.kpiTop}><Ic size={13} color="#6e6e6e" /><span style={S.kpiLabel}>{label}</span></div>
      <div style={S.kpiValRow}>
        <span style={S.kpiValue}>{value}</span>
        {show && <span style={{ ...S.kpiDelta, color: good ? GOOD : BAD }}>
          {good ? <TrendingDown size={12} /> : <TrendingUp size={12} />}{delta > 0 ? "+" : ""}{Math.abs(delta) >= 10 ? delta.toFixed(0) : delta.toFixed(1)}{unit}
        </span>}
      </div>
      <div style={S.kpiSub}>{sub}</div>
    </div>
  );
}

function AiMsg({ p }) {
  if (p.kind === "note") return <div style={S.aiNote}>{p.text}</div>;
  return (
    <div style={S.aiCard}>
      {p.kind === "diagnostic" && <>
        <div style={S.aiCardTitle}><Cpu size={13} /> {p.title}</div>
        {p.lines.map((l, i) => <div key={i} style={S.aiLine}>{l}</div>)}
        {p.cta && <div style={S.aiCta}><ChevronRight size={12} />{p.cta}</div>}
      </>}
      {p.kind === "scenario" && <>
        <div style={S.aiCardTitle}><Target size={13} /> {p.title}</div>
        {p.subtitle && <div style={S.aiSubtitle}>{p.subtitle}</div>}
        <MetricGrid metrics={p.metrics} />
      </>}
      {p.kind === "recommend" && <>
        <div style={S.recBadge}>RECOMMENDATION · {p.objLabel}</div>
        <div style={S.recHead}>{p.headline}</div>
        <MetricGrid metrics={p.metrics} />
        <div style={S.aiSubhead}>Why</div>
        {p.rationale.map((l, i) => <div key={i} style={S.aiLine}>{l}</div>)}
        <div style={S.aiSubhead}>Watch-outs</div>
        {p.watchouts.map((l, i) => <div key={i} style={S.aiWatch}><AlertTriangle size={11} color="#F5A524" /> {l}</div>)}
      </>}
    </div>
  );
}

function MetricGrid({ metrics }) {
  return (
    <div style={S.metricGrid}>
      {metrics.map((m, i) => {
        const show = typeof m.delta === "number" && Math.abs(m.delta) > 0.05;
        return (
          <div key={i} style={S.metricCell}>
            <div style={S.metricLabel}>{m.label}</div>
            <div style={S.metricValue}>{m.value}</div>
            {show && <div style={{ ...S.metricDelta, color: m.good ? GOOD : BAD }}>
              {m.good ? "▼" : "▲"} {m.delta > 0 ? "+" : ""}{Math.abs(m.delta) >= 10 ? m.delta.toFixed(0) : m.delta.toFixed(1)}{m.unit || ""}</div>}
          </div>
        );
      })}
    </div>
  );
}

/* ---- styles: monochrome chrome, semantic data colours ---- */
const mono = "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace";
const sans = "'Space Grotesk', -apple-system, system-ui, sans-serif";
const css = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
* { box-sizing: border-box; }
.glow:hover { box-shadow: 0 4px 24px rgba(255,255,255,0.25); transform: translateY(-1px); }
.pulse { animation: pulse 2s ease-in-out infinite; }
@keyframes pulse { 0%,100% { stroke-opacity: .6; } 50% { stroke-opacity: .12; } }
input[type=range]{ -webkit-appearance:none; appearance:none; height:4px; border-radius:4px; background:#242424; outline:none; }
input[type=range]::-webkit-slider-thumb{ -webkit-appearance:none; width:14px; height:14px; border-radius:50%; background:#f5f5f5; cursor:pointer; border:2px solid #0a0a0a; }
input[type=range]::-moz-range-thumb{ width:14px; height:14px; border-radius:50%; background:#f5f5f5; cursor:pointer; border:2px solid #0a0a0a; }
input[type=number]::-webkit-inner-spin-button{ opacity:.3; }
select{ appearance:none; -webkit-appearance:none; }
::-webkit-scrollbar{ width:8px; height:8px; } ::-webkit-scrollbar-thumb{ background:#2a2a2a; border-radius:8px; }
textarea:focus, input:focus, select:focus { border-color:#4a4a4a !important; }
@media (prefers-reduced-motion: reduce){ .pulse,.glow{ animation:none !important; } }
`;

const S = {
  root: { fontFamily: sans, background: "#0a0a0a", color: "#f2f2f2", height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" },
  topbar: { display: "flex", alignItems: "center", gap: 14, padding: "11px 18px", borderBottom: "1px solid #1e1e1e", background: "#0e0e0e", flexWrap: "wrap" },
  brand: { display: "flex", alignItems: "center", gap: 11 },
  logoMark: { width: 34, height: 34, borderRadius: 9, background: "#f5f5f5", display: "grid", placeItems: "center", color: "#0a0a0a" },
  brandName: { fontWeight: 700, fontSize: 16, letterSpacing: "-0.02em" },
  brandSub: { fontSize: 10.5, color: "#777" },
  tabs: { display: "flex", background: "#0a0a0a", border: "1px solid #242424", borderRadius: 10, padding: 3, gap: 2 },
  tabBtn: { display: "inline-flex", alignItems: "center", gap: 6, border: "none", background: "transparent", color: "#9a9a9a", fontFamily: sans, fontSize: 12.5, fontWeight: 600, padding: "7px 12px", borderRadius: 7, cursor: "pointer" },
  tabOn: { background: "#f5f5f5", color: "#0a0a0a" },
  tabCount: { fontSize: 10, fontFamily: mono, background: "rgba(0,0,0,.25)", borderRadius: 8, padding: "1px 6px", marginLeft: 3 },
  objWrap: { display: "flex", alignItems: "center", gap: 9 },
  objLabel: { fontSize: 11, color: "#777", textTransform: "uppercase", letterSpacing: "0.08em" },
  objGroup: { display: "flex", background: "#0a0a0a", border: "1px solid #242424", borderRadius: 9, padding: 3, gap: 2 },
  objBtn: { display: "inline-flex", alignItems: "center", gap: 5, border: "none", background: "transparent", color: "#9a9a9a", fontFamily: sans, fontSize: 12.5, fontWeight: 500, padding: "6px 11px", borderRadius: 6, cursor: "pointer" },
  objBtnOn: { background: "#242424", color: "#ffffff", boxShadow: "inset 0 0 0 1px #3a3a3a" },
  topActions: { marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" },
  ghostBtn: { display: "inline-flex", alignItems: "center", gap: 6, background: "#141414", border: "1px solid #2a2a2a", color: "#d4d4d4", fontFamily: sans, fontSize: 12.5, fontWeight: 600, padding: "8px 13px", borderRadius: 9, cursor: "pointer" },
  optimizeBtn: { display: "inline-flex", alignItems: "center", gap: 7, background: "#f5f5f5", color: "#0a0a0a", border: "none", fontFamily: sans, fontWeight: 700, fontSize: 13, padding: "9px 15px", borderRadius: 9, cursor: "pointer", transition: "all .18s" },
  resetBtn: { display: "grid", placeItems: "center", width: 36, height: 36, background: "#141414", border: "1px solid #2a2a2a", color: "#9a9a9a", borderRadius: 9, cursor: "pointer" },

  setupWrap: { flex: 1, overflowY: "auto", padding: 18, display: "flex", flexDirection: "column", gap: 16 },
  setupGrid: { display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 16 },
  card: { background: "#0f0f0f", border: "1px solid #1e1e1e", borderRadius: 14, padding: 16 },
  cardHead: { display: "flex", alignItems: "center", gap: 8, fontWeight: 600, fontSize: 14, marginBottom: 12 },
  cardHeadRow: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 },
  count: { fontSize: 11, fontFamily: mono, color: "#777", background: "#0a0a0a", border: "1px solid #242424", borderRadius: 5, padding: "1px 7px", marginLeft: 6 },
  cardText: { fontSize: 12.5, color: "#9a9a9a", lineHeight: 1.6, margin: "0 0 12px" },
  brief: { width: "100%", minHeight: 168, background: "#0a0a0a", border: "1px solid #242424", borderRadius: 10, padding: 12, color: "#d4d4d4", fontFamily: sans, fontSize: 12.8, lineHeight: 1.65, resize: "vertical", outline: "none" },
  paramRow: { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginTop: 12 },
  param: { background: "#0a0a0a", border: "1px solid #242424", borderRadius: 9, padding: "9px 11px" },
  paramLabel: { fontSize: 10, color: "#777", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 },
  paramValue: { fontSize: 13, fontFamily: mono, fontWeight: 600 },
  uploadBtns: { display: "flex", gap: 9 },
  upBtn: { display: "inline-flex", alignItems: "center", gap: 7, background: "#141414", border: "1px solid #2a2a2a", color: "#d4d4d4", fontFamily: sans, fontSize: 12.5, fontWeight: 600, padding: "9px 14px", borderRadius: 9, cursor: "pointer" },
  uploadPanel: { marginTop: 13, background: "#0a0a0a", border: "1px solid #242424", borderRadius: 10, padding: 13 },
  upTitle: { fontSize: 11, color: "#9a9a9a", textTransform: "uppercase", letterSpacing: ".07em", fontWeight: 600, marginBottom: 7 },
  cols: { display: "block", fontFamily: mono, fontSize: 12, color: "#ffffff", background: "#0f0f0f", border: "1px solid #242424", borderRadius: 7, padding: "7px 10px", marginBottom: 8 },
  upNote: { fontSize: 11.5, color: "#777", lineHeight: 1.5, marginBottom: 11 },
  upActions: { display: "flex", gap: 8, flexWrap: "wrap" },
  tmplBtn: { display: "inline-flex", alignItems: "center", gap: 6, background: "#141414", border: "1px solid #3a3a3a", color: "#e8e8e8", fontFamily: sans, fontSize: 12, fontWeight: 600, padding: "7px 12px", borderRadius: 8, cursor: "pointer" },
  chooseBtn: { display: "inline-flex", alignItems: "center", gap: 6, background: "#f5f5f5", border: "none", color: "#0a0a0a", fontFamily: sans, fontSize: 12, fontWeight: 700, padding: "7px 12px", borderRadius: 8, cursor: "pointer" },
  cancelBtn: { background: "transparent", border: "1px solid #2a2a2a", color: "#9a9a9a", fontFamily: sans, fontSize: 12, padding: "7px 12px", borderRadius: 8, cursor: "pointer" },
  upErr: { display: "flex", alignItems: "center", gap: 6, marginTop: 10, fontSize: 12, color: "#F85149" },
  tableWrap: { overflowX: "auto" },
  table: { width: "100%", borderCollapse: "collapse" },
  th: { textAlign: "left", fontSize: 10.5, color: "#777", textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 600, padding: "7px 9px", borderBottom: "1px solid #1e1e1e", whiteSpace: "nowrap" },
  thC: { textAlign: "center", fontSize: 10.5, color: "#777", fontFamily: mono, fontWeight: 600, padding: "7px 4px", borderBottom: "1px solid #1e1e1e", whiteSpace: "nowrap" },
  td: { padding: "4px 6px", borderBottom: "1px solid #161616" },
  tdc: { padding: "9px 9px", borderBottom: "1px solid #161616", verticalAlign: "top" },
  tdLane: { padding: "2px 2px", borderBottom: "1px solid #161616", textAlign: "center" },
  laneIn: { width: 52, background: "transparent", border: "1px solid transparent", borderRadius: 5, fontFamily: mono, fontSize: 11.5, padding: "4px 3px", outline: "none", textAlign: "center" },
  baseRow: { background: "rgba(255,255,255,.03)" },
  winRow: { background: "rgba(63,185,80,.05)" },
  bestCell: { boxShadow: "inset 0 0 0 1px rgba(63,185,80,.45)", borderRadius: 6, background: "rgba(63,185,80,.06)" },
  cmpVal: { fontFamily: mono, fontSize: 13, fontWeight: 600 },
  cmpDelta: { fontFamily: mono, fontSize: 10.5, marginTop: 2 },
  cmpNote: { marginTop: 12, fontSize: 11.5, color: "#777", lineHeight: 1.55 },
  miniBtn: { background: "#141414", border: "1px solid #2a2a2a", color: "#d4d4d4", fontFamily: sans, fontSize: 11, fontWeight: 600, padding: "4px 9px", borderRadius: 6, cursor: "pointer" },
  cellIn: { width: "100%", minWidth: 84, background: "transparent", border: "1px solid transparent", borderRadius: 6, color: "#f2f2f2", fontFamily: sans, fontSize: 12.8, padding: "6px 7px", outline: "none" },
  cellNum: { width: 88, background: "transparent", border: "1px solid transparent", borderRadius: 6, color: "#f2f2f2", fontFamily: mono, fontSize: 12.3, padding: "6px 7px", outline: "none" },
  cellSel: { background: "#141414", border: "1px solid #2a2a2a", borderRadius: 6, color: "#d4d4d4", fontFamily: sans, fontSize: 12, padding: "5px 8px", outline: "none", cursor: "pointer" },
  statusPill: { border: "none", fontFamily: mono, fontSize: 10.5, fontWeight: 700, padding: "4px 10px", borderRadius: 20, cursor: "pointer", textTransform: "uppercase", letterSpacing: ".04em" },
  pillActive: { background: "#f5f5f5", color: "#0a0a0a" },
  pillCand: { background: "transparent", color: "#9a9a9a", boxShadow: "inset 0 0 0 1px #3a3a3a" },
  rowDel: { display: "grid", placeItems: "center", background: "transparent", border: "none", color: "#5a5a5a", cursor: "pointer", padding: 5, borderRadius: 6 },
  addRowBtn: { display: "inline-flex", alignItems: "center", gap: 5, background: "#141414", border: "1px solid #2a2a2a", color: "#d4d4d4", fontFamily: sans, fontSize: 12, fontWeight: 600, padding: "6px 11px", borderRadius: 8, cursor: "pointer" },
  empty: { padding: "22px 14px", textAlign: "center", fontSize: 12.5, color: "#777", background: "#0a0a0a", border: "1px dashed #242424", borderRadius: 10, lineHeight: 1.6 },
  sensGrid: { display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 14 },
  sensCell: { background: "#0a0a0a", border: "1px solid #242424", borderRadius: 10, padding: "11px 13px" },
  barSection: { margin: "4px 0 16px", display: "flex", flexDirection: "column", gap: 7 },
  barRow: { display: "grid", gridTemplateColumns: "220px 1fr 64px", alignItems: "center", gap: 10 },
  barName: { fontSize: 12, color: "#c9c9c9", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  barTrack: { position: "relative", height: 20, background: "#141414", borderRadius: 6, overflow: "hidden" },
  barFill: { position: "absolute", inset: "0 auto 0 0", borderRadius: 6, transition: "width .3s" },
  barVal: { position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", fontFamily: mono, fontSize: 11, color: "#f2f2f2", fontWeight: 600 },
  barSvc: { fontFamily: mono, fontSize: 12, fontWeight: 600, textAlign: "right" },
  barLegend: { fontSize: 10.5, color: "#666", marginTop: 4 },

  main: { flex: 1, display: "flex", minHeight: 0 },
  mapWrap: { flex: 1, position: "relative", borderRight: "1px solid #1e1e1e", minWidth: 0, minHeight: 0 },
  noData: { position: "absolute", inset: 0, zIndex: 6, display: "grid", placeItems: "center", textAlign: "center", background: "rgba(10,10,10,.85)", fontSize: 15, fontWeight: 600, lineHeight: 1.8 },
  mapChrome: { position: "absolute", top: 0, left: 0, right: 0, zIndex: 3, display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", pointerEvents: "none" },
  mapTitle: { fontSize: 13, fontWeight: 600, background: "rgba(10,10,10,.75)", padding: "5px 10px", borderRadius: 7, backdropFilter: "blur(6px)" },
  addDemandBtn: { display: "inline-flex", alignItems: "center", gap: 5, background: "rgba(10,10,10,.75)", border: "1px solid #2a2a2a", color: "#d4d4d4", fontFamily: sans, fontSize: 12, fontWeight: 600, padding: "6px 11px", borderRadius: 8, cursor: "pointer", backdropFilter: "blur(6px)" },
  addDemandOn: { background: "#f5f5f5", borderColor: "#f5f5f5", color: "#0a0a0a" },
  flowToggle: { display: "flex", alignItems: "center", gap: 6, background: "rgba(10,10,10,.75)", padding: "5px 8px", borderRadius: 8, backdropFilter: "blur(6px)" },
  toggleLabel: { fontSize: 10.5, color: "#777" },
  toggleBtn: { border: "none", background: "transparent", color: "#9a9a9a", fontFamily: mono, fontSize: 11, padding: "3px 8px", borderRadius: 5, cursor: "pointer", textTransform: "capitalize" },
  toggleBtnOn: { background: "#242424", color: "#ffffff" },
  svg: { position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" },
  custLabel: { fill: "#6e6e6e", fontSize: 10.5, fontFamily: sans, textAnchor: "middle" },
  whLabel: { fontSize: 13, fontWeight: 700, fontFamily: sans, textAnchor: "middle" },
  whUtil: { fill: "#e8e8e8", fontSize: 10.5, fontFamily: mono, textAnchor: "middle" },
  legend: { position: "absolute", bottom: 12, left: 16, right: 16, zIndex: 3, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", background: "rgba(10,10,10,.78)", padding: "7px 12px", borderRadius: 8, backdropFilter: "blur(6px)", border: "1px solid #1e1e1e" },
  legendSep: { width: 1, height: 14, background: "#2a2a2a" },
  legendNote: { fontSize: 10.5, color: "#777" },

  editor: { position: "absolute", top: 52, left: 16, zIndex: 5, width: 256, background: "#101010", border: "1px solid #2e2e2e", borderRadius: 12, padding: 14, boxShadow: "0 18px 50px rgba(0,0,0,.7)" },
  editorHead: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 11 },
  editorName: { display: "flex", alignItems: "center", gap: 6, fontWeight: 600, fontSize: 13.5 },
  editorRole: { fontSize: 11, color: "#777", marginTop: 2 },
  editorClose: { background: "transparent", border: "none", color: "#777", cursor: "pointer", padding: 2 },
  nameIn: { marginTop: 5, width: 182, background: "#0a0a0a", border: "1px solid #2a2a2a", borderRadius: 7, color: "#f2f2f2", fontFamily: sans, fontSize: 12.5, padding: "5px 8px", outline: "none" },
  editRow: { display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12, color: "#9a9a9a", padding: "6px 0", fontFamily: mono, borderTop: "1px solid #1e1e1e" },
  sliderRow: { margin: "8px 0 6px" },
  sliderTop: { display: "flex", justifyContent: "space-between", fontSize: 12.3, color: "#9a9a9a", marginBottom: 7, fontFamily: mono },
  slider: { width: "100%" },
  expWarn: { display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "#F5A524", background: "rgba(245,165,36,.07)", border: "1px solid rgba(245,165,36,.3)", borderRadius: 7, padding: "6px 9px", margin: "4px 0 2px", lineHeight: 1.45, flexWrap: "wrap" },
  expNote: { fontSize: 11, color: "#777", lineHeight: 1.5, margin: "4px 0 2px" },
  dangerBtn: { width: "100%", marginTop: 11, padding: 8, background: "rgba(248,81,73,.08)", border: "1px solid rgba(248,81,73,.35)", color: "#F85149", borderRadius: 8, fontFamily: sans, fontSize: 12.5, fontWeight: 600, cursor: "pointer" },
  confirmBtn: { width: "100%", marginTop: 11, padding: 8, background: "rgba(63,185,80,.1)", border: "1px solid rgba(63,185,80,.4)", color: "#3FB950", borderRadius: 8, fontFamily: sans, fontSize: 12.5, fontWeight: 700, cursor: "pointer" },
  candNote: { fontSize: 11.5, color: "#777", marginTop: 8, lineHeight: 1.5 },

  copilot: { width: 372, minWidth: 372, display: "flex", flexDirection: "column", background: "#0c0c0c", minHeight: 0 },
  copilotHead: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "13px 16px", borderBottom: "1px solid #1e1e1e" },
  copilotTitle: { display: "flex", alignItems: "center", gap: 7, fontWeight: 600, fontSize: 14 },
  copilotObj: { fontSize: 11.5, color: "#777", fontFamily: mono },
  feed: { flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 11, minHeight: 0 },
  userMsg: { alignSelf: "flex-end", maxWidth: "82%", background: "#f5f5f5", color: "#0a0a0a", padding: "8px 12px", borderRadius: "12px 12px 3px 12px", fontSize: 13, lineHeight: 1.4, fontWeight: 500 },
  aiNote: { alignSelf: "flex-start", maxWidth: "92%", color: "#9a9a9a", fontSize: 12.5, lineHeight: 1.55, fontStyle: "italic" },
  aiCard: { alignSelf: "flex-start", width: "100%", background: "#101010", border: "1px solid #242424", borderRadius: 12, padding: 13 },
  aiCardTitle: { display: "flex", alignItems: "center", gap: 6, fontWeight: 600, fontSize: 13, marginBottom: 9 },
  aiSubtitle: { fontSize: 11.5, color: "#777", marginBottom: 9, marginTop: -4, lineHeight: 1.45 },
  aiLine: { fontSize: 12.5, color: "#c9c9c9", lineHeight: 1.55, marginBottom: 6 },
  aiCta: { display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#ffffff", marginTop: 4, fontWeight: 500 },
  aiSubhead: { fontSize: 10.5, color: "#777", textTransform: "uppercase", letterSpacing: ".08em", marginTop: 12, marginBottom: 7, fontWeight: 600 },
  aiWatch: { display: "flex", alignItems: "flex-start", gap: 6, fontSize: 12, color: "#a8a8a8", lineHeight: 1.5, marginBottom: 5 },
  recBadge: { display: "inline-block", fontSize: 10, fontWeight: 700, letterSpacing: ".09em", color: "#0a0a0a", background: "#f5f5f5", padding: "3px 8px", borderRadius: 5, marginBottom: 9 },
  recHead: { fontSize: 14, fontWeight: 600, lineHeight: 1.4, marginBottom: 11 },
  metricGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, margin: "2px 0" },
  metricCell: { background: "#0a0a0a", border: "1px solid #1e1e1e", borderRadius: 8, padding: "8px 10px" },
  metricLabel: { fontSize: 10.5, color: "#777", marginBottom: 3 },
  metricValue: { fontSize: 15, fontWeight: 600, fontFamily: mono },
  metricDelta: { fontSize: 11, fontFamily: mono, marginTop: 2, fontWeight: 500 },
  composer: { display: "flex", alignItems: "center", gap: 7, padding: "12px 14px 8px", borderTop: "1px solid #1e1e1e", position: "relative" },
  micBtn: { display: "grid", placeItems: "center", width: 36, height: 36, minWidth: 36, background: "#141414", border: "1px solid #2a2a2a", color: "#9a9a9a", borderRadius: 9, cursor: "pointer" },
  micTip: { position: "absolute", bottom: 52, left: 14, background: "#1a1a1a", color: "#d4d4d4", fontSize: 11, padding: "6px 9px", borderRadius: 7, border: "1px solid #2e2e2e", maxWidth: 210, lineHeight: 1.4, zIndex: 10 },
  input: { flex: 1, background: "#101010", border: "1px solid #2a2a2a", borderRadius: 9, padding: "9px 12px", color: "#f2f2f2", fontFamily: sans, fontSize: 13, outline: "none" },
  sendBtn: { display: "grid", placeItems: "center", width: 36, height: 36, minWidth: 36, background: "#f5f5f5", border: "none", color: "#0a0a0a", borderRadius: 9, cursor: "pointer" },
  suggestRow: { display: "flex", gap: 6, padding: "0 14px 14px", flexWrap: "wrap" },
  chip: { background: "#101010", border: "1px solid #2a2a2a", color: "#9a9a9a", fontSize: 11.5, fontFamily: sans, padding: "5px 9px", borderRadius: 20, cursor: "pointer" },

  kpiBar: { display: "grid", gridTemplateColumns: "repeat(5,1fr)", borderTop: "1px solid #1e1e1e", background: "#0e0e0e" },
  kpi: { padding: "12px 16px", borderRight: "1px solid #1e1e1e" },
  kpiTop: { display: "flex", alignItems: "center", gap: 6, marginBottom: 6 },
  kpiLabel: { fontSize: 10.5, color: "#777", textTransform: "uppercase", letterSpacing: ".05em" },
  kpiValRow: { display: "flex", alignItems: "baseline", gap: 8 },
  kpiValue: { fontSize: 21, fontWeight: 600, fontFamily: mono, letterSpacing: "-0.03em" },
  kpiDelta: { display: "inline-flex", alignItems: "center", gap: 2, fontSize: 12, fontFamily: mono, fontWeight: 500 },
  kpiSub: { fontSize: 10.5, color: "#5a5a5a", marginTop: 3 },
};
