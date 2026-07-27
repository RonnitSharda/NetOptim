import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";
import Papa from "papaparse";
import {
  Cpu, Mic, Send, Zap, RotateCcw, X, AlertTriangle, Building2, Target, Truck, Leaf, Gauge,
  IndianRupee, Sparkles, ChevronRight, ChevronLeft, Upload, Download, Plus, Trash2, FileText,
  Map as MapIcon, Database, TrendingDown, TrendingUp, GitCompare, FilePlus2, RefreshCw, Grid3X3,
  Star, Eye, MessageSquare, Archive, Rocket, Lock, Unlock, GraduationCap, Check, Wand2, Clock,
  Maximize2, Minimize2,
} from "lucide-react";

/* ============================================================
   NetOptim v8
   Implements Changes.md (C1–C6). v7 retained as the video build.

   C1  Reset restores the loaded dataset — demand, lane rates, carbon
       price, footprint, locks. v7 mutated demand permanently, which
       moved the baseline every KPI delta was measured against
       (₹7.03cr → ₹7.47cr after a demand shock). Scenario log now
       survives reset and has its own Clear control.
   C2  "LLM reasoning layer" removed from the roadmap.
   C3  exitCost is an explicit input. Objective stays on steady-state
       annual cost — amortising a one-time cost into the annual rate
       deleted the WH 4 closure at every horizon under 10 years, and
       with it the only feature answering "resize or exit". Transition
       economics (payback, NPV) are reported alongside instead.
   C4  Lane upload lives in the matrix card, where W×D shape is known.
       Dynamic template, long-format CSV, tolerant validation, and a
       Source view showing file-loaded vs defaulted lanes.
   C5  Brief is auto-drafted from the loaded network and editable.
       Missing site types are inferred and held for confirmation
       rather than silently applied.
   C6  Demo teleprompter replaced by a Tutorial for first-time users.
   ============================================================ */

const SCALE_KM = 4.0;
const DEFAULT_SVC_KM = 700;
const EMISSION_FACTOR = 0.00009;
const EXP_RATE = 0.002;
const SHADOW_CARBON = 700;
const EXIT_MULT_DEFAULT = 2.5;   // exitCost default = 2.5 × annual fixed cost
const NPV_YEARS = 5;

/* Map viewBox is padded beyond the 0–1000 node canvas so edge labels and the
   floating title/legend bars never clip the network. Click-mapping reads the
   same constant, so the two can't drift apart. */
const MAP_VB = { x: -40, y: -80, w: 1080, h: 1190 };
const MAP_VB_STR = `${MAP_VB.x} ${MAP_VB.y} ${MAP_VB.w} ${MAP_VB.h}`;

let UID = 0;
const uid = p => p + "_" + (++UID).toString(36) + Date.now().toString(36).slice(-3);

const WH_TYPES = ["Hub", "Regional", "Cross-dock", "Fulfilment", "3PL"];

const SEED_WAREHOUSES = [
  { id: "W1", name: "WH 1", x: 470, y: 190, capacity: 1800, fixedCost: 4.2, opex: 2.5, exitCost: 10.5, type: "Hub",        status: "active" },
  { id: "W2", name: "WH 2", x: 240, y: 560, capacity: 2200, fixedCost: 5.1, opex: 2.8, exitCost: 12.8, type: "Hub",        status: "active" },
  { id: "W3", name: "WH 3", x: 410, y: 820, capacity: 1500, fixedCost: 3.8, opex: 2.2, exitCost: 9.5,  type: "Regional",   status: "active" },
  { id: "W4", name: "WH 4", x: 460, y: 490, capacity: 1400, fixedCost: 3.2, opex: 1.8, exitCost: 8.0,  type: "Cross-dock", status: "active" },
  { id: "W5", name: "WH 5", x: 720, y: 470, capacity:  900, fixedCost: 2.6, opex: 2.4, exitCost: 6.5,  type: "Regional",   status: "active" },
  { id: "W6", name: "WH 6", x: 850, y: 360, capacity: 1000, fixedCost: 2.4, opex: 1.6, exitCost: 6.0,  type: "Regional",   status: "candidate" },
  { id: "W7", name: "WH 7", x: 470, y: 680, capacity: 1300, fixedCost: 3.5, opex: 2.0, exitCost: 8.8,  type: "Regional",   status: "candidate" },
  { id: "W8", name: "WH 8", x: 250, y: 420, capacity: 1200, fixedCost: 3.6, opex: 2.6, exitCost: 9.0,  type: "3PL",        status: "candidate" },
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

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) * SCALE_KM;
const laneKey = (w, c) => w + "|" + c;
const exitCostOf = w => (w.exitCost != null && isFinite(w.exitCost)) ? w.exitCost : w.fixedCost * EXIT_MULT_DEFAULT;

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

const RATE_CR = (() => {
  const act = SEED_WAREHOUSES.filter(w => w.status === "active").map(w => w.id);
  const { flows } = assign(SEED_WAREHOUSES, SEED_CUSTOMERS, act, null, null, 0);
  return 30 / flows.reduce((s, f) => s + f.volume * f.distance * f.m, 0);
})();
const BASE_RATE = RATE_CR * 1e4;

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
  const carbon = distVD * EMISSION_FACTOR;
  const carbonCost = carbon * o.carbonPrice / 1e4;
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

function paretoFront(evals) {
  return evals.filter(a => !evals.some(b =>
    b !== a && b.totalCost <= a.totalCost && b.avgDistance <= a.avgDistance &&
    (b.totalCost < a.totalCost || b.avgDistance < a.avgDistance)));
}

/* C3 — transition economics. Deliberately NOT folded into the objective.
   Amortising exit cost into the annual rate removed the WH 4 closure at
   every horizon under 10 years; steady-state cost and transition cost are
   different questions and are reported as such. */
function transitionEconomics(whs, closedIds, annualSaving, discountRate) {
  const byId = Object.fromEntries(whs.map(w => [w.id, w]));
  const oneTime = closedIds.reduce((s, id) => s + (byId[id] ? exitCostOf(byId[id]) : 0), 0);
  if (oneTime <= 0) return null;
  const r = (discountRate || 12) / 100;
  let npv = -oneTime;
  for (let t = 1; t <= NPV_YEARS; t++) npv += annualSaving / Math.pow(1 + r, t);
  const paybackYears = annualSaving > 0 ? oneTime / annualSaving : Infinity;
  const breakEven = annualSaving > 0 ? annualSaving * (1 - Math.pow(1 + r, -NPV_YEARS)) / r : 0;
  return { oneTime, npv, paybackYears, paybackMonths: paybackYears * 12, breakEven, discountRate: discountRate || 12 };
}

function optimize(whs, custs, objective, capOverride, laneMult, opts) {
  const byId = Object.fromEntries(whs.map(w => [w.id, w]));
  const activeIds = whs.filter(w => w.status === "active").map(w => w.id);
  const nonLocked = whs.filter(w => !w.lockOpen).map(w => w.id);
  const enumIds = nonLocked.slice(0, 12);
  const forcedOpen = [...whs.filter(w => w.lockOpen).map(w => w.id), ...nonLocked.slice(12)];
  const cappedOut = Math.max(0, nonLocked.length - 12);

  const evals = [];
  for (let m = 0; m < (1 << enumIds.length); m++) {
    const open = [...forcedOpen, ...enumIds.filter((_, i) => m & (1 << i))];
    if (open.length === 0) continue;
    let cap = {};                       // capacity is a decision variable
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
  if (!evals.length) return { best: null, evalsCount: 0, activeIds, cappedOut };

  const front = paretoFront(evals);
  const cLo = Math.min(...front.map(e => e.totalCost)), cHi = Math.max(...front.map(e => e.totalCost));
  const dLo = Math.min(...front.map(e => e.avgDistance)), dHi = Math.max(...front.map(e => e.avgDistance));
  const nrm = (v, lo, hi) => hi === lo ? 0 : (v - lo) / (hi - lo);
  const shadow = e => e.totalCost - e.carbonCost + e.carbon * SHADOW_CARBON / 1e4;

  const score = e =>
    objective === "cost" ? e.totalCost :
    objective === "service" ? (1 - e.serviceLevel) * 1e4 + e.avgDistance :
    objective === "carbon" ? shadow(e) :
    0.5 * nrm(e.totalCost, cLo, cHi) + 0.5 * nrm(e.avgDistance, dLo, dHi);

  const ranked = [...evals].sort((a, b) => score(a) - score(b));
  const best = ranked[0];
  let cheaperAlt = null;
  if (objective === "service") {
    const tied = evals.filter(e => Math.abs(e.serviceLevel - best.serviceLevel) < 1e-9 && e.totalCost < best.totalCost - 0.01);
    if (tied.length) cheaperAlt = tied.sort((a, b) => a.totalCost - b.totalCost)[0];
  }
  return { best, evalsCount: evals.length, activeIds, cappedOut, cheaperAlt };
}

function objScore(k, objective, rows) {
  const costs = rows.map(r => r.k.totalCost), dists = rows.map(r => r.k.avgDistance);
  const nrm = (v, lo, hi) => hi === lo ? 0 : (v - lo) / (hi - lo);
  if (objective === "cost") return k.totalCost;
  if (objective === "service") return (1 - k.serviceLevel) * 1e4 + k.avgDistance;
  if (objective === "carbon") return k.totalCost - k.carbonCost + k.carbon * SHADOW_CARBON / 1e4;
  return 0.5 * nrm(k.totalCost, Math.min(...costs), Math.max(...costs)) + 0.5 * nrm(k.avgDistance, Math.min(...dists), Math.max(...dists));
}

/* C5 — infer a site type where the source data doesn't supply one.
   Held for confirmation, never applied silently. */
function inferType(w) {
  if (w.capacity >= 1700) return "Hub";
  if (w.capacity >= 1000) return "Regional";
  return "Cross-dock";
}

/* C5 — draft the brief from what was actually loaded */
function draftBrief(whs, custs, k) {
  if (!whs.length || !custs.length) return "";
  const act = whs.filter(w => w.status === "active");
  const cand = whs.filter(w => w.status === "candidate");
  const totalDemand = custs.reduce((s, c) => s + c.demand, 0);
  const byId = Object.fromEntries(whs.map(w => [w.id, w]));
  const bound = act.filter(w => (k.util[w.id] || 0) >= 0.95).map(w => w.name);
  const idle = act.filter(w => (k.util[w.id] || 0) < 0.5).map(w => `${w.name} (${((k.util[w.id] || 0) * 100).toFixed(0)}%)`);
  const worst = [...k.flows].sort((a, b) => b.distance - a.distance)[0];
  const cst = worst ? custs.find(c => c.id === worst.to) : null;

  const L = [];
  L.push(`The network has ${whs.length} sites — ${act.length} active, ${cand.length} candidate — serving ${totalDemand.toLocaleString()}k units a year across ${custs.length} demand regions.`);
  const pains = [];
  if (bound.length) pains.push(`${bound.join(" and ")} ${bound.length > 1 ? "are" : "is"} capacity-bound at or above 95%, leaving no headroom for a demand shock`);
  if (idle.length) pains.push(`${idle.join(", ")} ${idle.length > 1 ? "are" : "is"} under-used below 50%`);
  if (worst && cst) pains.push(`${cst.name} is served from ${byId[worst.from]?.name} at roughly ${worst.distance.toFixed(0)} km, a cost and service hotspot`);
  if (pains.length) L.push(`Pain points: ${pains.join("; ")}.`);
  if (cand.length) L.push(`Candidate sites approved for evaluation: ${cand.map(w => `${w.name} (${w.capacity.toLocaleString()}k capacity, ₹${w.fixedCost.toFixed(1)}cr fixed)`).join(", ")}.`);
  L.push(`Decision needed: which candidates to open, whether to resize or exit existing sites, and how demand growth or a carbon price changes the answer — balancing total cost, service distance, utilisation risk and emissions.`);
  return L.join("\n\n");
}

const GOOD = "#3FB950", BAD = "#F85149", WARN = "#F5A524", INFO = "#2FB8D6", EXIT = "#F85149", BLUE = "#79b8ff";
const utilColor = u => u == null ? "#3a3a3a" : u > 1 ? BAD : u >= 0.85 ? WARN : u >= 0.5 ? GOOD : INFO;
const hx = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const toHex = a => "#" + a.map(v => Math.round(v).toString(16).padStart(2, "0")).join("");
const mixC = (a, b, t) => toHex(hx(a).map((v, i) => v + (hx(b)[i] - v) * t));
const flowColor = t => t < 0.5 ? mixC(INFO, WARN, t / 0.5) : mixC(WARN, BAD, (t - 0.5) / 0.5);
const inr = v => (v < 0 ? "−₹" : "₹") + Math.abs(v).toFixed(1) + "cr";

function downloadCsv(filename, rows, columns) {
  const csv = Papa.unparse(rows.map(r => Object.fromEntries(columns.map(c => [c, r[c]]))), { columns });
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  URL.revokeObjectURL(a.href);
}
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function useCountUp(target, ms = 550) {
  const [v, setV] = useState(target);
  const fromRef = useRef(target), startRef = useRef(0), rafRef = useRef(0);
  useEffect(() => {
    if (!isFinite(target)) return;
    const from = fromRef.current;
    if (Math.abs(target - from) < 0.01) { setV(target); fromRef.current = target; return; }
    startRef.current = performance.now();
    const tick = now => {
      const p = Math.min(1, (now - startRef.current) / ms);
      const e = 1 - Math.pow(1 - p, 3);
      setV(from + (target - from) * e);
      if (p < 1) rafRef.current = requestAnimationFrame(tick); else fromRef.current = target;
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, ms]);
  return v;
}

/* Web Speech API — feature-detected. If the browser or the frame won't
   provide it the control never renders, so there is no dead button. */
function useSpeech(onText) {
  const [supported] = useState(() => typeof window !== "undefined" &&
    !!(window.SpeechRecognition || window.webkitSpeechRecognition));
  const [listening, setListening] = useState(false);
  const [err, setErr] = useState("");
  const recRef = useRef(null);
  const start = useCallback(() => {
    if (!supported) return;
    try {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      const r = new SR();
      r.lang = "en-IN"; r.interimResults = false; r.maxAlternatives = 1;
      r.onresult = e => { const t = e.results[0][0].transcript; onText(t); };
      r.onerror = e => { setErr(e.error === "not-allowed" ? "Microphone permission denied" : "Speech recognition unavailable"); setListening(false); };
      r.onend = () => setListening(false);
      recRef.current = r; setErr(""); setListening(true); r.start();
    } catch { setErr("Speech recognition unavailable"); setListening(false); }
  }, [supported, onText]);
  const stop = useCallback(() => { try { recRef.current && recRef.current.stop(); } catch {} setListening(false); }, []);
  return { supported, listening, err, start, stop };
}

const STAGES = [
  { id: "perceive", label: "Perceive", icon: Eye,           note: "Reads the network, flags hotspots" },
  { id: "reason",   label: "Reason",   icon: Sparkles,      note: "Interprets a plain-English what-if" },
  { id: "act",      label: "Act",      icon: Zap,           note: "Searches configurations, re-solves" },
  { id: "explain",  label: "Explain",  icon: MessageSquare, note: "Justifies the call, names the risks" },
  { id: "learn",    label: "Learn",    icon: Archive,       note: "Logs every option it has tried" },
];

/* C2 — LLM roadmap item removed */
const ROADMAP = [
  { h: "Prescriptive alerting", d: "Watch cost and service drift against plan, and raise a re-optimisation before the network is off track." },
  { h: "Scenario auto-generation", d: "Propose the stress cases worth testing — competitor entry, port disruption, fuel spike — rather than waiting to be asked." },
  { h: "MILP solver core", d: "Replace enumeration with a network-flow/MILP solve for provable optimality at scale." },
  { h: "Live data feeds", d: "Telematics and WMS in place of static files — a network that re-optimises continuously." },
];

const TUTORIAL = [
  { tab: null,    anchor: null,        title: "What NetOptim does", body: "Network design normally takes a four-week study in a spreadsheet nobody can audit. NetOptim turns it into a conversation: ask a what-if, get a costed answer with its reasoning attached. This walkthrough takes about a minute." },
  { tab: "setup", anchor: "data",      title: "Your network", body: "Everything starts here — sites, capacities, fixed costs, handling rates, exit costs, and demand by region. Load your own data from CSV or edit any value in place. Rows are matched by name, so no IDs are needed." },
  { tab: "setup", anchor: "lanes",     title: "Lane economics", body: "Freight rarely scales with straight-line distance. This matrix holds a multiplier per warehouse–region pair, so terrain, tolls and contracted rates are all reflected. Download the template, fill it, upload it back." },
  { tab: "sim",   anchor: "map",       title: "The simulator", body: "Circles are distribution centres, sized by throughput and coloured by utilisation. Diamonds are demand regions. Click any site to open it, exit it, or resize its capacity — the network re-solves instantly." },
  { tab: "sim",   anchor: "copilot",   title: "Ask in plain English", body: "Type a what-if — “increase demand at D9 by 30%” — and the copilot parses it, re-solves, and shows what moved. Or press Converge to optimum and it searches every open-close combination itself, then explains the recommendation and its watch-outs." },
  { tab: "cmp",   anchor: "cmp",       title: "Stress-test the winner", body: "Every configuration you test is logged here automatically. Drag the assumptions — freight rates, demand, service promise, carbon price — and watch whether the same option keeps winning. That is what makes a recommendation signable." },
];

/* ============================================================ */
export default function NetOptim() {
  const [tab, setTab] = useState("setup");
  const [brief, setBrief] = useState("");
  const [briefIsDraft, setBriefIsDraft] = useState(false);
  const [warehouses, setWarehouses] = useState(SEED_WAREHOUSES);
  const [customers, setCustomers] = useState(SEED_CUSTOMERS);
  const [openIds, setOpenIds] = useState(SEED_WAREHOUSES.filter(w => w.status === "active").map(w => w.id));
  const [capOverride, setCapOverride] = useState({});
  const [laneMult, setLaneMult] = useState({});
  const [laneSource, setLaneSource] = useState({});
  const [carbonPrice, setCarbonPrice] = useState(0);
  const [discountRate, setDiscountRate] = useState(12);
  const [objective, setObjective] = useState("balanced");
  const [selected, setSelected] = useState(null);
  const [addingDemand, setAddingDemand] = useState(false);
  const [query, setQuery] = useState("");
  const [flowMetric, setFlowMetric] = useState("cost");
  const [mapFull, setMapFull] = useState(false);
  const [messages, setMessages] = useState([]);
  const [uploadKind, setUploadKind] = useState(null);
  const [uploadErr, setUploadErr] = useState("");
  const [scenarios, setScenarios] = useState([]);
  const [sens, setSens] = useState({ rateMult: 1, demandMult: 1, svcKm: DEFAULT_SVC_KM, exitMult: 1 });
  const [laneView, setLaneView] = useState("mult");
  const [showLanes, setShowLanes] = useState(false);
  const [laneNotice, setLaneNotice] = useState(null);
  const [typeReview, setTypeReview] = useState(null);
  const [stage, setStage] = useState(null);
  const [busy, setBusy] = useState(null);
  const [tut, setTut] = useState({ on: false, step: 0 });
  const [tutRect, setTutRect] = useState(null);

  const feedRef = useRef(null), svgRef = useRef(null), fileRef = useRef(null), laneFileRef = useRef(null);
  const bootRef = useRef(false), demandStartRef = useRef(null), capStartRef = useRef(null);
  const stageTimer = useRef(null);
  /* C1 — the loaded dataset, so Reset has something true to return to */
  const pristineRef = useRef(null);
  const anchors = { data: useRef(null), lanes: useRef(null), map: useRef(null), copilot: useRef(null), cmp: useRef(null) };

  const activeIds = useMemo(() => warehouses.filter(w => w.status === "active").map(w => w.id), [warehouses]);
  const whById = useMemo(() => Object.fromEntries(warehouses.map(w => [w.id, w])), [warehouses]);
  const cById = useMemo(() => Object.fromEntries(customers.map(c => [c.id, c])), [customers]);
  const lockedCount = useMemo(() => warehouses.filter(w => w.lockOpen).length, [warehouses]);

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
    if (!mapFull) return;
    const onKey = e => { if (e.key === "Escape") setMapFull(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mapFull]);

  const fire = useCallback(s => {
    setStage(s);
    clearTimeout(stageTimer.current);
    stageTimer.current = setTimeout(() => setStage(null), 2200);
  }, []);
  useEffect(() => () => clearTimeout(stageTimer.current), []);

  /* snapshot on first mount so the seed network is resettable too */
  useEffect(() => {
    if (!pristineRef.current) {
      pristineRef.current = { warehouses: SEED_WAREHOUSES, customers: SEED_CUSTOMERS, laneMult: {}, laneSource: {}, carbonPrice: 0 };
      const k = computeKpis(SEED_WAREHOUSES, SEED_CUSTOMERS, SEED_WAREHOUSES.filter(w => w.status === "active").map(w => w.id), {}, {}, {});
      setBrief(draftBrief(SEED_WAREHOUSES, SEED_CUSTOMERS, k));
      setBriefIsDraft(true);
    }
  }, []);

  const laneFlows = useMemo(() => {
    const m = new Map();
    kpi.flows.forEach(f => {
      const k = laneKey(f.from, f.to);
      const e = m.get(k);
      if (e) { e.volume += f.volume; e.over = e.over || f.over; }
      else m.set(k, { ...f, key: k });
    });
    return [...m.values()];
  }, [kpi.flows]);

  useEffect(() => {
    if (tab !== "sim" || bootRef.current || !hasData) return;
    bootRef.current = true;
    const over = openIds.filter(id => (kpi.util[id] || 0) > 0.95).map(id => whById[id].name);
    const low = openIds.filter(id => (kpi.util[id] || 0) < 0.5).map(id => whById[id].name);
    const worst = [...kpi.flows].sort((a, b) => b.distance - a.distance)[0];
    fire("perceive");
    push("ai", {
      kind: "diagnostic", title: "Network scan complete",
      lines: [
        `Mapped ${openIds.length} active DCs serving ${kpi.totalDemand.toLocaleString()}k units/yr across ${customers.length} regions.`,
        over.length ? `Capacity-bound: ${over.join(", ")} at or near 100% — no headroom for a demand shock.` : `No overloaded sites.`,
        low.length ? `Under-used: ${low.join(", ")} below 50% — consolidation or exit candidates.` : ``,
        worst ? `Longest haul: ${cById[worst.to]?.name} served from ${whById[worst.from]?.name} at ${worst.distance.toFixed(0)} km — a cost and service hotspot.` : ``,
      ].filter(Boolean),
      cta: "Nobody asked it to look. Every configuration you test from here is logged automatically.",
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
    const parts = [
      closed.length && "exit " + closed.join("+"),
      added.length && "open " + added.join("+"),
      expanded.length && "expand " + expanded.join("+"),
    ].filter(Boolean);
    return (prefix ? prefix + " · " : "") + (parts.length ? parts.join(", ") : "as-is");
  }
  function autoLog(open, capUsed, prefix) {
    const sig = JSON.stringify({ o: [...open].sort(), c: capUsed || {} });
    setScenarios(s => {
      if (s.some(x => x.sig === sig)) return s;
      fire("learn");
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
      subtitle: "Impact on the current network, before → after the change:",
      metrics: metricRow(after, before),
      note: "Demand is now changed for every later run. Reset simulation restores it.",
    });
  }

  function applyCarbonPrice(np, sourceLabel) {
    const before = computeKpis(warehouses, customers, openIds, capOverride, laneMult, { carbonPrice });
    const after = computeKpis(warehouses, customers, openIds, capOverride, laneMult, { carbonPrice: np });
    setCarbonPrice(np);
    push("ai", {
      kind: "scenario",
      title: `Carbon price → ₹${np}/tCO₂${sourceLabel ? " · " + sourceLabel : ""}`,
      subtitle: "Emissions now carry a cost — the optimiser will penalise long hauls accordingly:",
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
    fire("act");
    setBusy("Converging…");
    setTimeout(() => {
      const res = optimize(warehouses, customers, o, capOverride, laneMult, simOpts);
      const { best, evalsCount, activeIds: act, cappedOut, cheaperAlt } = res;
      setBusy(null);
      if (!best) { push("ai", { kind: "note", text: "Nothing to optimise yet — add at least one site and one demand region." }); return; }
      setOpenIds(best.openIds);
      setCapOverride(best.capUsed || {});
      autoLog(best.openIds, best.capUsed, `opt-${o}`);
      fire("explain");

      const added = best.openIds.filter(id => !act.includes(id)).map(id => whById[id].name);
      const closedIds = act.filter(id => !best.openIds.includes(id));
      const closed = closedIds.map(id => whById[id].name);
      const expanded = (best.expIds || []).map(id => `${whById[id].name} → ${(best.capUsed[id]).toLocaleString()}k`);
      const dCost = best.totalCost - baseline.totalCost;
      const dSvc = (best.serviceLevel - baseline.serviceLevel) * 100;
      const annualSaving = baseline.totalCost - best.totalCost;
      const te = transitionEconomics(warehouses, closedIds, annualSaving, discountRate);
      const objLabel = { cost: "lowest cost", service: "highest service level", balanced: "cost–service balance", carbon: "lowest carbon" }[o];
      const moves = [
        closed.length && "exit " + closed.join(" + "),
        added.length && "open " + added.join(" + "),
        expanded.length && "expand " + expanded.join(", "),
      ].filter(Boolean).join("; ") || "keep the current footprint";

      push("ai", {
        kind: "recommend", objLabel, hero: closed.length > 0,
        headline: `Optimal for ${objLabel}: ${moves}.`,
        metrics: metricRow(best, baseline).slice(0, 3),
        transition: te,
        rationale: [
          `Evaluated ${evalsCount.toLocaleString()} configurations — every open/close combination across all non-locked sites, plus right-sized capacity variants where a site overloads (expansion priced at ₹${(EXP_RATE * 100).toFixed(1)}cr per 100k/yr).`,
          `Unit cost model: freight (distance × ₹${BASE_RATE.toFixed(2)}/u·km × lane rate) + origin handling opex${carbonPrice > 0 ? ` + carbon at ₹${carbonPrice}/tCO₂` : ""}.`,
          o === "carbon" ? `Emissions are shadow-priced at ₹${SHADOW_CARBON}/tCO₂ so carbon trades off against cost, rather than trivially favouring more sites.` : ``,
          closed.length ? `Exiting ${closed.join(" & ")} removes under-used fixed cost: the volume reallocates to the cheapest remaining DCs and the added freight is smaller than the fixed cost saved.` : ``,
          added.length ? `Opening ${added.join(" & ")} moves supply closer to under-served demand — long-haul freight falls faster than fixed cost rises.` : `The existing footprint already wins on this objective.`,
          expanded.length ? `Capacity expansion beat the alternative of longer hauls: ${expanded.join(", ")}.` : ``,
          cheaperAlt ? `Note: a ${cheaperAlt.openIds.length}-DC variant reaches the same service level for ${inr(best.totalCost - cheaperAlt.totalCost)} less — worth reviewing if capital is tight.` : ``,
          te ? `Steady-state and transition are scored separately: the ranking above is on annual run-rate, with the one-time exit cost of ${inr(te.oneTime)} assessed on payback and NPV rather than folded into the annual rate.` : ``,
          `Net versus today: ${dCost < 0 ? "saves " + inr(Math.abs(dCost)) : "adds " + inr(dCost)} per year, service ${dSvc >= 0 ? "up" : "down"} ${Math.abs(dSvc).toFixed(1)} points.`,
        ].filter(Boolean),
        watchouts: [
          te
            ? `Exit assumes lease break is achievable. Payback ${te.paybackMonths.toFixed(0)} months at ${inr(te.oneTime)} one-time; NPV turns negative above ${inr(te.breakEven)} — confirm the real exit cost before committing.`
            : `Verify lease break-clauses before committing capital.`,
          added.length ? `Transition: site fit-out and ramp of roughly 8–12 weeks before the savings land.` : `Low transition risk — no new sites.`,
          cappedOut > 0 ? `${cappedOut} site${cappedOut > 1 ? "s were" : " was"} held open: the closure search is capped at 12 sites for tractability.` : ``,
          `Logged to Compare — stress-test it against the sensitivity sliders there.`,
        ].filter(Boolean),
      });
    }, 30);
  }

  function parseQuery(raw) {
    const q = " " + raw.toLowerCase().replace(/\s+/g, " ") + " ";
    fire("reason");
    const hit = list => list.find(o => {
      const n = o.name.toLowerCase();
      return new RegExp("\\b" + esc(n) + "\\b").test(q) || new RegExp("\\b" + esc(n.replace(/\s+/g, "")) + "\\b").test(q.replace(/\s+/g, ""));
    });
    if (/carbon/.test(q) && /(tax|price|cost|penalt)/.test(q)) {
      const num = (q.match(/(\d{2,5})/) || [])[1];
      if (num) return applyCarbonPrice(Math.min(2000, +num), "via copilot");
      return push("ai", { kind: "note", text: `Give it a number — "set carbon tax to 800" (₹/tCO₂, up to 2000).` });
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
      return push("ai", { kind: "note", text: `Name a region — "increase demand at D9 by 30%" — or click any diamond on the map.` });
    }
    const w = hit(warehouses);
    if (w && /close|shut|remove|exit|drop/.test(q)) {
      if (!openIds.includes(w.id)) return push("ai", { kind: "note", text: `${w.name} isn't open right now.` });
      return applyConfig(openIds.filter(x => x !== w.id), `Scenario · exit ${w.name}`);
    }
    if (w && /add|open|build|new|launch|expand/.test(q)) {
      if (/expand/.test(q)) { setSelected({ kind: "wh", id: w.id }); return push("ai", { kind: "note", text: `Use the capacity slider on ${w.name} — expansion above base is priced at ₹${(EXP_RATE * 100).toFixed(1)}cr per 100k/yr.` }); }
      if (openIds.includes(w.id)) return push("ai", { kind: "note", text: `${w.name} is already open.` });
      return applyConfig([...openIds, w.id], `Scenario · open ${w.name}`);
    }
    if (w) { setSelected({ kind: "wh", id: w.id }); return push("ai", { kind: "note", text: `Selected ${w.name} — open, exit, or resize it in the panel.` }); }
    const c = hit(customers);
    if (c) { demandStartRef.current = c.demand; setSelected({ kind: "cust", id: c.id }); return push("ai", { kind: "note", text: `Selected ${c.name} at ${c.demand}k units a year — adjust demand in the panel.` }); }
    push("ai", { kind: "note", text: `Try "open WH 6", "increase demand at D9 by 30%", "set carbon tax to 800", or "optimise for cost".` });
  }

  function submitQuery() { const t = query.trim(); if (!t) return; push("user", { text: t }); setQuery(""); parseQuery(t); }

  /* ---- C1: reset restores the loaded dataset ---- */
  function doReset() {
    const p = pristineRef.current;
    if (!p) return;
    const changedDemand = customers.some(c => { const o = p.customers.find(x => x.id === c.id); return o && o.demand !== c.demand; });
    const changedCarbon = carbonPrice !== p.carbonPrice;
    const changedLanes = Object.keys(laneMult).length !== Object.keys(p.laneMult).length;

    setWarehouses(p.warehouses.map(w => ({ ...w, lockOpen: false })));
    setCustomers(p.customers);
    setLaneMult({ ...p.laneMult });
    setLaneSource({ ...p.laneSource });
    setCarbonPrice(p.carbonPrice);
    setOpenIds(p.warehouses.filter(w => w.status === "active").map(w => w.id));
    setCapOverride({});
    setSelected(null); setAddingDemand(false);
    setSens({ rateMult: 1, demandMult: 1, svcKm: DEFAULT_SVC_KM, exitMult: 1 });

    const restored = [
      `${p.warehouses.filter(w => w.status === "active").length} DCs`,
      changedDemand && "demand",
      changedLanes && "lane rates",
      changedCarbon && "carbon price",
      "capacity overrides", "locks",
    ].filter(Boolean).join(", ");
    push("ai", { kind: "note", text: `Reset to loaded data — restored ${restored}. ${scenarios.length} scenario${scenarios.length === 1 ? "" : "s"} kept in Compare.` });
  }

  function snapshot(whs, custs, lm, ls, cp) {
    pristineRef.current = { warehouses: whs, customers: custs, laneMult: lm || {}, laneSource: ls || {}, carbonPrice: cp || 0 };
  }

  function newProblem() {
    setBrief(""); setBriefIsDraft(false); setWarehouses([]); setCustomers([]); setOpenIds([]);
    setCapOverride({}); setLaneMult({}); setLaneSource({}); setCarbonPrice(0);
    setScenarios([]); setMessages([]); setSelected(null); bootRef.current = false;
    setSens({ rateMult: 1, demandMult: 1, svcKm: DEFAULT_SVC_KM, exitMult: 1 });
    setObjective("balanced"); setFlowMetric("cost"); setLaneView("mult");
    setTypeReview(null); setLaneNotice(null);
    snapshot([], [], {}, {}, 0);
  }
  function loadSample() {
    setWarehouses(SEED_WAREHOUSES); setCustomers(SEED_CUSTOMERS);
    setOpenIds(SEED_WAREHOUSES.filter(w => w.status === "active").map(w => w.id));
    setCapOverride({}); setLaneMult({}); setLaneSource({}); setCarbonPrice(0);
    setScenarios([]); setMessages([]); setSelected(null); bootRef.current = false;
    setSens({ rateMult: 1, demandMult: 1, svcKm: DEFAULT_SVC_KM, exitMult: 1 });
    setObjective("balanced"); setFlowMetric("cost"); setLaneView("mult");
    setTypeReview(null); setLaneNotice(null);
    snapshot(SEED_WAREHOUSES, SEED_CUSTOMERS, {}, {}, 0);
    const k = computeKpis(SEED_WAREHOUSES, SEED_CUSTOMERS, SEED_WAREHOUSES.filter(w => w.status === "active").map(w => w.id), {}, {}, {});
    setBrief(draftBrief(SEED_WAREHOUSES, SEED_CUSTOMERS, k)); setBriefIsDraft(true);
  }
  function regenerateBrief() {
    const k = computeKpis(warehouses, customers, activeIds, {}, laneMult, simOpts);
    setBrief(draftBrief(warehouses, customers, k)); setBriefIsDraft(true);
    fire("perceive");
  }

  /* ---- C6: tutorial ---- */
  function startTutorial() { setTut({ on: true, step: 0 }); const s = TUTORIAL[0]; if (s.tab) setTab(s.tab); }
  function tutGo(n) {
    if (n < 0 || n >= TUTORIAL.length) { setTut({ on: false, step: 0 }); setTutRect(null); return; }
    const s = TUTORIAL[n];
    if (s.tab && s.tab !== tab) setTab(s.tab);
    if (s.anchor === "lanes") setShowLanes(true);
    setTut({ on: true, step: n });
  }
  useEffect(() => {
    if (!tut.on) { setTutRect(null); return; }
    const s = TUTORIAL[tut.step];
    if (!s.anchor) { setTutRect(null); return; }
    let raf1 = 0, raf2 = 0;
    const measure = () => {
      const el = anchors[s.anchor] && anchors[s.anchor].current;
      if (!el) { setTutRect(null); return; }
      // Scroll first, then read the box on the next frame — reading before the
      // scroll settles is what put the highlight in the wrong place.
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          const r = el.getBoundingClientRect();
          setTutRect({ top: r.top, left: r.left, width: r.width, height: r.height });
        });
      });
    };
    // Give a tab switch time to mount the target before measuring.
    const t = setTimeout(measure, 300);
    return () => { clearTimeout(t); cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
  }, [tut, tab]); // eslint-disable-line
  function tutorialWalkthrough() {
    setTut({ on: false, step: 0 }); setTutRect(null);
    loadSample(); setTab("sim");
    setTimeout(() => runOptimize("cost"), 420);
  }

  function svgPoint(e) {
    const r = svgRef.current.getBoundingClientRect();
    // preserveAspectRatio="xMidYMid meet": content is scaled uniformly and centred,
    // so undo the letterbox offset before converting to viewBox coordinates.
    const scale = Math.min(r.width / MAP_VB.w, r.height / MAP_VB.h);
    const offX = (r.width - MAP_VB.w * scale) / 2;
    const offY = (r.height - MAP_VB.h * scale) / 2;
    return {
      x: (e.clientX - r.left - offX) / scale + MAP_VB.x,
      y: (e.clientY - r.top - offY) / scale + MAP_VB.y,
    };
  }
  function mapClick(e) {
    if (addingDemand) {
      const { x, y } = svgPoint(e);
      const id = uid("D");
      setCustomers(cs => [...cs, { id, name: "D" + (cs.length + 1), x: Math.round(x), y: Math.round(y), demand: 300 }]);
      demandStartRef.current = 300;
      setSelected({ kind: "cust", id }); setAddingDemand(false);
      push("ai", { kind: "note", text: `New demand region placed at 300k a year. Rename and set demand in the panel.` });
      return;
    }
    setSelected(null);
  }
  const toggleNode = id => openIds.includes(id)
    ? applyConfig(openIds.filter(x => x !== id), `Scenario · exit ${whById[id].name}`)
    : applyConfig([...openIds, id], `Scenario · open ${whById[id].name}`);

  const setCustField = (id, patch) => setCustomers(cs => cs.map(c => c.id === id ? { ...c, ...patch } : c));
  const removeCust = id => { setCustomers(cs => cs.filter(c => c.id !== id)); setSelected(null); };
  const setWhField = (id, patch) => {
    setWarehouses(ws => ws.map(w => w.id === id ? { ...w, ...patch } : w));
    if (patch.status) setOpenIds(ids => patch.status === "candidate" ? ids.filter(x => x !== id) : Array.from(new Set([...ids, id])));
  };
  const removeWh = id => { setWarehouses(ws => ws.filter(w => w.id !== id)); setOpenIds(ids => ids.filter(x => x !== id)); };
  const addWhRow = () => setWarehouses(ws => [...ws, { id: uid("W"), name: "WH " + (ws.length + 1), x: 500, y: 500, capacity: 1000, fixedCost: 3.0, opex: 2.0, exitCost: 7.5, type: "Regional", status: "candidate" }]);
  const addCustRow = () => setCustomers(cs => [...cs, { id: uid("D"), name: "D" + (cs.length + 1), x: 500, y: 500, demand: 300 }]);

  const WH_COLS = ["name", "type", "x", "y", "capacity", "fixedCost", "opex", "exitCost", "status"];
  const CU_COLS = ["name", "x", "y", "demand"];
  const LANE_COLS = ["warehouse", "region", "multiplier"];

  function handleFile(e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = ""; if (!f) return;
    Papa.parse(f, {
      header: true, skipEmptyLines: true,
      complete: res => {
        try {
          const rows = res.data;
          if (!rows.length) throw new Error("That file has no rows.");
          if (uploadKind === "warehouses") {
            const inferred = [];
            const parsed = rows.map((r, i) => {
              const rawType = (r.type || "").trim();
              const o = {
                id: uid("W"), name: String(r.name || "WH " + (i + 1)).trim(),
                type: WH_TYPES.includes(rawType) ? rawType : null,
                x: +r.x, y: +r.y, capacity: +r.capacity, fixedCost: +r.fixedCost,
                opex: r.opex != null && r.opex !== "" ? +r.opex : 2.0,
                exitCost: r.exitCost != null && r.exitCost !== "" ? +r.exitCost : null,
                status: (r.status || "active").trim(),
              };
              if ([o.x, o.y, o.capacity, o.fixedCost, o.opex].some(v => !isFinite(v))) throw new Error(`Row ${i + 1}: x, y, capacity, fixedCost and opex all need to be numbers.`);
              if (!["active", "candidate"].includes(o.status)) throw new Error(`Row ${i + 1}: status must be "active" or "candidate".`);
              if (!o.type) { o.type = inferType(o); inferred.push({ id: o.id, name: o.name, type: o.type }); }
              if (o.exitCost == null) o.exitCost = +(o.fixedCost * EXIT_MULT_DEFAULT).toFixed(2);
              return o;
            });
            setWarehouses(parsed);
            const act = parsed.filter(w => w.status === "active").map(w => w.id);
            setOpenIds(act); setCapOverride({}); setLaneMult({}); setLaneSource({}); setScenarios([]);
            snapshot(parsed, customers, {}, {}, carbonPrice);
            const k = computeKpis(parsed, customers, act, {}, {}, simOpts);
            setBrief(draftBrief(parsed, customers, k)); setBriefIsDraft(true);
            setTypeReview(inferred.length ? inferred : null);
            bootRef.current = false;
          } else {
            const parsed = rows.map((r, i) => {
              const o = { id: uid("D"), name: String(r.name || "D" + (i + 1)).trim(), x: +r.x, y: +r.y, demand: +r.demand };
              if ([o.x, o.y, o.demand].some(v => !isFinite(v))) throw new Error(`Row ${i + 1}: x, y and demand all need to be numbers.`);
              return o;
            });
            setCustomers(parsed); setLaneMult({}); setLaneSource({});
            snapshot(warehouses, parsed, {}, {}, carbonPrice);
            const k = computeKpis(warehouses, parsed, activeIds, {}, {}, simOpts);
            setBrief(draftBrief(warehouses, parsed, k)); setBriefIsDraft(true);
            bootRef.current = false;
          }
          setUploadKind(null); setUploadErr("");
        } catch (err) { setUploadErr(err.message); }
      },
      error: err => setUploadErr(err.message),
    });
  }

  /* ---- C4: lane template + upload, scoped to the loaded W×D grid ---- */
  function downloadLaneTemplate() {
    const rows = [];
    warehouses.forEach(w => customers.forEach(c => {
      rows.push({ warehouse: w.name, region: c.name, multiplier: (laneMult[laneKey(w.id, c.id)] ?? 1).toFixed(2) });
    }));
    downloadCsv(`lane_rates_${warehouses.length}x${customers.length}.csv`, rows, LANE_COLS);
  }
  function handleLaneFile(e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = ""; if (!f) return;
    Papa.parse(f, {
      header: true, skipEmptyLines: true,
      complete: res => {
        const rows = res.data;
        const whByName = Object.fromEntries(warehouses.map(w => [w.name.trim().toLowerCase(), w]));
        const cuByName = Object.fromEntries(customers.map(c => [c.name.trim().toLowerCase(), c]));
        const next = {}, src = {};
        let loaded = 0, clamped = 0, dupes = 0;
        const errors = [];
        rows.forEach((r, i) => {
          const wn = String(r.warehouse || "").trim().toLowerCase();
          const cn = String(r.region || "").trim().toLowerCase();
          const w = whByName[wn], c = cuByName[cn];
          if (!w) { if (errors.length < 5) errors.push(`Row ${i + 2}: “${r.warehouse}” is not a loaded site.`); return; }
          if (!c) { if (errors.length < 5) errors.push(`Row ${i + 2}: “${r.region}” is not a loaded region.`); return; }
          let m = +r.multiplier;
          if (!isFinite(m)) { if (errors.length < 5) errors.push(`Row ${i + 2}: multiplier “${r.multiplier}” is not a number.`); return; }
          if (m < 0.25 || m > 4) { m = Math.max(0.25, Math.min(4, m)); clamped++; }
          const key = laneKey(w.id, c.id);
          if (next[key] != null) dupes++;
          next[key] = m; src[key] = "file"; loaded++;
        });
        const total = warehouses.length * customers.length;
        const kept = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== 1));
        setLaneMult(kept); setLaneSource(src);
        setShowLanes(true); setLaneView("source");
        setLaneNotice({
          ok: loaded > 0,
          lines: [
            `${loaded} of ${total} lanes loaded${total > loaded ? `; ${total - loaded} defaulted to 1.00` : ""}.`,
            clamped ? `${clamped} value${clamped === 1 ? "" : "s"} clamped to the 0.25–4.00 range.` : "",
            dupes ? `${dupes} duplicate pair${dupes === 1 ? "" : "s"} — last value kept.` : "",
            ...errors,
            errors.length >= 5 ? "…further errors suppressed." : "",
          ].filter(Boolean),
        });
      },
      error: err => setLaneNotice({ ok: false, lines: [err.message] }),
    });
  }

  const selWh = selected?.kind === "wh" ? whById[selected.id] : null;
  const selCust = selected?.kind === "cust" ? cById[selected.id] : null;
  const selOpen = selWh ? openIds.includes(selWh.id) : false;
  const selCap = selWh ? (capOverride[selWh.id] ?? selWh.capacity) : 0;
  const selExpCost = selWh ? Math.max(0, selCap - selWh.capacity) * EXP_RATE : 0;
  const capMin = selWh ? Math.max(50, Math.round(selWh.capacity * 0.4 / 50) * 50) : 0;
  const capMax = selWh ? Math.max(Math.round(selWh.capacity * 2.2 / 50) * 50, Math.ceil(selCap / 50) * 50) : 0;

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

  const animCost = useCountUp(kpi.totalCost);
  const animSvc = useCountUp(kpi.serviceLevel * 100);

  const briefSpeech = useSpeech(useCallback(t => { setBrief(b => (b ? b + " " : "") + t); setBriefIsDraft(false); }, []));
  const querySpeech = useSpeech(useCallback(t => { setQuery(t); }, []));

  return (
    <div style={S.root}>
      <style>{css}</style>

      <header style={S.topbar}>
        <div style={S.brand}>
          <div style={S.logoMark}><Cpu size={19} strokeWidth={2.4} /></div>
          <div>
            <div style={S.brandName}>NetOptim</div>
            <div style={S.brandSub}>AI copilot · logistics network design</div>
          </div>
        </div>

        <div style={S.tabs}>
          <button onClick={() => setTab("setup")} style={{ ...S.tabBtn, ...(tab === "setup" ? S.tabOn : {}) }}><Database size={14} /> 1 · Problem &amp; Data</button>
          <button onClick={() => setTab("sim")} style={{ ...S.tabBtn, ...(tab === "sim" ? S.tabOn : {}) }}><MapIcon size={14} /> 2 · Simulator</button>
          <button onClick={() => setTab("cmp")} style={{ ...S.tabBtn, ...(tab === "cmp" ? S.tabOn : {}) }}>
            <GitCompare size={14} /> 3 · Compare &amp; Sensitivity {scenarios.length > 0 && <span style={S.tabCount}>{scenarios.length}</span>}
          </button>
        </div>

        {tab === "sim" && <>
          <div style={S.objWrap}>
            <span style={S.objLabel}>Optimise for</span>
            <div style={S.objGroup}>
              {objectives.map(o => { const Ic = o.icon; const on = objective === o.id; return (
                <button key={o.id} onClick={() => setObjective(o.id)} style={{ ...S.objBtn, ...(on ? S.objBtnOn : {}) }}><Ic size={14} strokeWidth={2.2} /> {o.label}</button>); })}
            </div>
          </div>
          <div style={S.topActions}>
            {lockedCount > 0 && <span style={S.lockChip} title="Locked sites are excluded from the closure search"><Lock size={12} /> {lockedCount} locked</span>}
            <button onClick={startTutorial} style={S.tutBtn} title="How this tool works"><GraduationCap size={14} /> Tutorial</button>
            <button onClick={() => runOptimize()} style={{ ...S.optimizeBtn, ...(busy ? S.optimizeBusy : {}) }} className={busy ? "" : "glow"} disabled={!!busy}>
              <Zap size={15} strokeWidth={2.5} /> {busy || "Converge to optimum"}
            </button>
            <button onClick={doReset} style={S.resetBtn} title="Reset simulation — restores demand, lane rates, carbon price and footprint"><RotateCcw size={15} /></button>
          </div>
        </>}
        {tab !== "sim" && (
          <div style={S.topActions}>
            {tab === "setup" && <>
              <button onClick={newProblem} style={S.ghostBtn}><FilePlus2 size={14} /> New problem</button>
              <button onClick={loadSample} style={S.ghostBtn}><RefreshCw size={14} /> Load sample</button>
            </>}
            <button onClick={startTutorial} style={S.tutBtn}><GraduationCap size={14} /> Tutorial</button>
            {tab === "setup" && <button onClick={() => setTab("sim")} style={S.optimizeBtn} className="glow">Open simulator <ChevronRight size={15} /></button>}
          </div>
        )}
      </header>

      <div style={S.loopStrip}>
        <span style={S.loopLead}>Agentic loop</span>
        {STAGES.map((s, i) => {
          const Ic = s.icon; const on = stage === s.id;
          return (
            <React.Fragment key={s.id}>
              {i > 0 && <span style={S.loopArrow}>→</span>}
              <span style={{ ...S.loopStage, ...(on ? S.loopStageOn : {}) }} title={s.note}>
                <Ic size={13} strokeWidth={2.3} /> {s.label}
              </span>
            </React.Fragment>
          );
        })}
        <span style={S.loopNote}>
          {stage ? STAGES.find(s => s.id === stage)?.note : "Perceives, interprets intent, decides, explains, and remembers what it tried"}
        </span>
      </div>

      {/* ============ TAB 1 ============ */}
      {tab === "setup" && (
        <div style={S.setupWrap}>
          <div style={S.setupGrid}>
            <section style={S.card}>
              <div style={S.cardHeadRow}>
                <div style={S.cardHead}><FileText size={15} /> Problem brief {briefIsDraft && <span style={S.draftTag}>auto-drafted</span>}</div>
                <div style={{ display: "flex", gap: 7 }}>
                  {briefSpeech.supported && (
                    <button onClick={() => briefSpeech.listening ? briefSpeech.stop() : briefSpeech.start()}
                      style={{ ...S.addRowBtn, ...(briefSpeech.listening ? S.micLive : {}) }}>
                      <Mic size={14} /> {briefSpeech.listening ? "Listening…" : "Speak"}
                    </button>
                  )}
                  <button onClick={regenerateBrief} style={S.addRowBtn} disabled={!hasData}><Wand2 size={14} /> Regenerate</button>
                </div>
              </div>
              <p style={S.cardText}>
                Drafted from the data you loaded — sites, utilisation, hotspots and the decision to be made. Correct anything it got wrong, or dictate your own.
                {briefSpeech.err && <span style={{ color: WARN }}> · {briefSpeech.err}</span>}
              </p>
              <textarea value={brief} onChange={e => { setBrief(e.target.value); setBriefIsDraft(false); }} style={S.brief} spellCheck={false}
                placeholder="Load a network and the brief writes itself — or describe the problem here." />
              <div style={S.paramRow}>
                <Param label="Service threshold" value={`${DEFAULT_SVC_KM} km`} />
                <Param label="Base freight rate" value={`₹${BASE_RATE.toFixed(2)}/u·km`} />
                <Param label="Expansion cost" value={`₹${(EXP_RATE * 100).toFixed(1)}cr /100k·yr`} />
                <Param label="Annual demand" value={`${customers.reduce((s, c) => s + c.demand, 0).toLocaleString()}k units`} />
              </div>
            </section>

            <section style={S.card}>
              <div style={S.cardHead}><Upload size={15} /> Bring your own network</div>
              <p style={S.cardText}>Load sites and demand from CSV. Pick a dataset and you get the exact columns required plus a pre-filled template. <b style={{ color: "#e8e8e8" }}>No IDs needed</b> — rows are matched by name. Lane rates load separately, in the matrix below.</p>
              <div style={S.uploadBtns}>
                <button style={S.upBtn} onClick={() => { setUploadKind("warehouses"); setUploadErr(""); }}><Building2 size={15} /> Warehouse data</button>
                <button style={S.upBtn} onClick={() => { setUploadKind("demand"); setUploadErr(""); }}><Target size={15} /> Demand data</button>
              </div>
              {uploadKind && (
                <div style={S.uploadPanel}>
                  <div style={S.upTitle}>Required columns · {uploadKind}</div>
                  <code style={S.cols}>{(uploadKind === "warehouses" ? WH_COLS : CU_COLS).join(", ")}</code>
                  <div style={S.upNote}>{uploadKind === "warehouses"
                    ? `type = Hub | Regional | Cross-dock | Fulfilment | 3PL (inferred if blank) · x,y = canvas 0–1000 · capacity in ’000 units/YEAR · fixedCost in ₹cr/yr · opex in ₹ per unit handled · exitCost = one-time ₹cr to close (defaults to ${EXIT_MULT_DEFAULT}× fixed cost)`
                    : "x,y = canvas coordinates 0–1000 · demand in ’000 units/YEAR"}</div>
                  <div style={S.upActions}>
                    <button style={S.tmplBtn} onClick={() => uploadKind === "warehouses"
                      ? downloadCsv("warehouses_template.csv", warehouses.length ? warehouses : SEED_WAREHOUSES, WH_COLS)
                      : downloadCsv("demand_template.csv", customers.length ? customers : SEED_CUSTOMERS, CU_COLS)}>
                      <Download size={14} /> Download template
                    </button>
                    <button style={S.chooseBtn} onClick={() => fileRef.current && fileRef.current.click()}><Upload size={14} /> Choose CSV file</button>
                    <button style={S.cancelBtn} onClick={() => setUploadKind(null)}>Cancel</button>
                  </div>
                  {uploadErr && <div style={S.upErr}><AlertTriangle size={13} /> {uploadErr}</div>}
                  <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={handleFile} style={{ display: "none" }} />
                </div>
              )}
            </section>
          </div>

          {/* C5 — inferred types held for confirmation */}
          {typeReview && (
            <div style={S.reviewStrip}>
              <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                <AlertTriangle size={15} color={WARN} />
                <b style={{ fontSize: 14 }}>{typeReview.length} site{typeReview.length === 1 ? "" : "s"} had no type in the file.</b>
                <span style={{ fontSize: 13.5, color: "#c9c9c9" }}>
                  Inferred from capacity: {typeReview.map(t => `${t.name} → ${t.type}`).join(", ")}. Confirm, or change them in the table below.
                </span>
              </div>
              <button style={S.confirmSmall} onClick={() => setTypeReview(null)}><Check size={14} /> Confirm</button>
            </div>
          )}

          <section style={S.card} ref={anchors.data}>
            <div style={S.cardHeadRow}>
              <div style={S.cardHead}><Building2 size={15} /> Warehouses &amp; candidate sites <span style={S.count}>{warehouses.length}</span></div>
              <button style={S.addRowBtn} onClick={addWhRow}><Plus size={14} /> Add site</button>
            </div>
            {warehouses.length === 0 ? <Empty text="No sites yet. Add one, upload a CSV, or load the sample network." /> : (
              <div style={S.tableWrap}>
                <table style={S.table}>
                  <thead><tr>{["Name", "Type", "X", "Y", "Capacity (’000u / yr)", "Fixed cost (₹cr / yr)", "Opex (₹ / unit)", "Exit cost (₹cr one-time)", "Status", "Lock", ""].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
                  <tbody>
                    {warehouses.map(w => (
                      <tr key={w.id}>
                        <td style={S.td}><input style={S.cellIn} value={w.name} onChange={e => setWhField(w.id, { name: e.target.value })} /></td>
                        <td style={S.td}>
                          <select style={{ ...S.cellSel, ...(typeReview && typeReview.some(t => t.id === w.id) ? S.cellInferred : {}) }} value={w.type} onChange={e => setWhField(w.id, { type: e.target.value })}>
                            {WH_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                          </select>
                        </td>
                        <td style={S.td}><input style={S.cellNum} type="number" value={w.x} onChange={e => setWhField(w.id, { x: +e.target.value || 0 })} /></td>
                        <td style={S.td}><input style={S.cellNum} type="number" value={w.y} onChange={e => setWhField(w.id, { y: +e.target.value || 0 })} /></td>
                        <td style={S.td}><input style={S.cellNum} type="number" value={w.capacity} onChange={e => setWhField(w.id, { capacity: Math.max(0, +e.target.value || 0) })} /></td>
                        <td style={S.td}><input style={S.cellNum} type="number" step="0.1" value={w.fixedCost} onChange={e => setWhField(w.id, { fixedCost: Math.max(0, +e.target.value || 0) })} /></td>
                        <td style={S.td}><input style={S.cellNum} type="number" step="0.1" value={w.opex} onChange={e => setWhField(w.id, { opex: Math.max(0, +e.target.value || 0) })} /></td>
                        <td style={S.td}><input style={{ ...S.cellNum, color: WARN }} type="number" step="0.5" value={exitCostOf(w).toFixed(1)} onChange={e => setWhField(w.id, { exitCost: Math.max(0, +e.target.value || 0) })} /></td>
                        <td style={S.td}><button onClick={() => setWhField(w.id, { status: w.status === "active" ? "candidate" : "active" })}
                          style={{ ...S.statusPill, ...(w.status === "active" ? S.pillActive : S.pillCand) }}>{w.status}</button></td>
                        <td style={S.td}>
                          <button onClick={() => setWhField(w.id, { lockOpen: !w.lockOpen })} title={w.lockOpen ? "Locked open — excluded from the closure search" : "Lock open"}
                            style={{ ...S.lockCell, color: w.lockOpen ? BLUE : "#6f6f6f" }}>
                            {w.lockOpen ? <Lock size={14} /> : <Unlock size={14} />}
                          </button>
                        </td>
                        <td style={S.td}><button style={S.rowDel} onClick={() => removeWh(w.id)}><Trash2 size={14} /></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section style={S.card}>
            <div style={S.cardHeadRow}>
              <div style={S.cardHead}><Target size={15} /> Demand regions <span style={S.count}>{customers.length}</span></div>
              <button style={S.addRowBtn} onClick={addCustRow}><Plus size={14} /> Add region</button>
            </div>
            {customers.length === 0 ? <Empty text="No demand regions yet. Add one, upload a CSV, or load the sample network." /> : (
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
                        <td style={S.td}><button style={S.rowDel} onClick={() => removeCust(c.id)}><Trash2 size={14} /></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* C4 — lane matrix owns its own I/O */}
          <section style={S.card} ref={anchors.lanes}>
            <div style={S.cardHeadRow}>
              <div style={S.cardHead}><Grid3X3 size={15} /> Lane-wise freight cost <span style={S.count}>{warehouses.length} × {customers.length} = {warehouses.length * customers.length} lanes</span></div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <button style={S.tmplBtn} onClick={downloadLaneTemplate} disabled={!hasData} title="Template regenerates from the sites and regions currently loaded">
                  <Download size={14} /> Download template
                </button>
                <button style={S.chooseBtn} onClick={() => laneFileRef.current && laneFileRef.current.click()} disabled={!hasData}>
                  <Upload size={14} /> Upload lane rates
                </button>
                <input ref={laneFileRef} type="file" accept=".csv,text/csv" onChange={handleLaneFile} style={{ display: "none" }} />
                <button style={S.addRowBtn} onClick={() => setShowLanes(v => !v)}>{showLanes ? "Hide matrix" : "Show matrix"}</button>
              </div>
            </div>
            <p style={S.cardText}>
              Lane freight per unit = distance × ₹{BASE_RATE.toFixed(2)}/unit·km × <b style={{ color: "#e8e8e8" }}>lane multiplier</b>. Routing assigns volume by <b style={{ color: "#e8e8e8" }}>freight plus origin handling opex</b>, not raw distance.
              The template is generated from the sites and regions loaded above, so it always matches the current {warehouses.length}×{customers.length} grid — fill it in and upload it back. Any lane you leave out defaults to 1.00.
            </p>

            {laneNotice && (
              <div style={{ ...S.laneNotice, borderColor: laneNotice.ok ? "rgba(63,185,80,.35)" : "rgba(248,81,73,.4)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  {laneNotice.ok ? <Check size={14} color={GOOD} /> : <AlertTriangle size={14} color={BAD} />}
                  <b style={{ fontSize: 13.5 }}>{laneNotice.ok ? "Lane rates loaded" : "Lane file could not be read"}</b>
                  <button style={{ ...S.rowDel, marginLeft: "auto" }} onClick={() => setLaneNotice(null)}><X size={13} /></button>
                </div>
                {laneNotice.lines.map((l, i) => <div key={i} style={S.laneNoticeLine}>{l}</div>)}
              </div>
            )}

            {showLanes && <div style={{ display: "flex", gap: 8, margin: "4px 0 12px" }}>
              <div style={S.objGroup}>
                {[["mult", "Multiplier ×"], ["unit", "₹ / unit"], ["annual", "₹cr / yr"], ["source", "Source"]].map(([v, l]) => (
                  <button key={v} onClick={() => setLaneView(v)} style={{ ...S.objBtn, ...(laneView === v ? S.objBtnOn : {}), fontSize: 12.5, padding: "6px 10px" }}>{l}</button>))}
              </div>
            </div>}

            {showLanes && (warehouses.length && customers.length ? (
              <div style={S.tableWrap}>
                <table style={S.table}>
                  <thead><tr><th style={S.th}>{laneView === "mult" ? "× base" : laneView === "unit" ? "₹ / unit" : laneView === "annual" ? "₹cr / yr" : "source"}</th>{customers.map(c => <th key={c.id} style={S.thC}>{c.name}</th>)}</tr></thead>
                  <tbody>
                    {warehouses.map(w => (
                      <tr key={w.id}>
                        <td style={{ ...S.tdc, fontFamily: mono, fontSize: 13, whiteSpace: "nowrap" }}>{w.name}</td>
                        {customers.map(c => {
                          const k = laneKey(w.id, c.id);
                          const m = laneMult[k] ?? 1;
                          if (laneView === "mult") return <td key={c.id} style={S.tdLane}>
                            <input style={{ ...S.laneIn, color: m !== 1 ? WARN : "#9a9a9a", fontWeight: m !== 1 ? 700 : 400 }}
                              type="number" step="0.05" min="0.25" max="4" value={m}
                              onChange={e => { const nv = +e.target.value; setLaneMult(x => { const n = { ...x }; if (!isFinite(nv) || nv === 1) delete n[k]; else n[k] = Math.max(0.25, Math.min(4, nv)); return n; }); setLaneSource(s => ({ ...s, [k]: "manual" })); }} />
                          </td>;
                          if (laneView === "unit") { const v = dist(w, c) * m * BASE_RATE; return <td key={c.id} style={{ ...S.tdLane, fontFamily: mono, fontSize: 12, color: v > 120 ? BAD : v > 60 ? WARN : "#9a9a9a" }}>{v.toFixed(0)}</td>; }
                          if (laneView === "source") {
                            const s = laneSource[k];
                            return <td key={c.id} style={{ ...S.tdLane, fontFamily: mono, fontSize: 11 }}>
                              <span style={{ color: s === "file" ? GOOD : s === "manual" ? WARN : "#3f3f3f" }}>{s === "file" ? "file" : s === "manual" ? "edit" : "—"}</span>
                            </td>;
                          }
                          const a = laneAnnual[k]; return <td key={c.id} style={{ ...S.tdLane, fontFamily: mono, fontSize: 12, color: a ? (a > 2 ? BAD : a > 1 ? WARN : "#c9c9c9") : "#3a3a3a" }}>{a ? a.toFixed(2) : "—"}</td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {laneView === "source" && <div style={S.barLegend}>file = loaded from CSV · edit = changed by hand · — = defaulted to 1.00</div>}
              </div>
            ) : <Empty text="Add warehouses and demand regions first — the lane grid is sized from them." />)}
          </section>

          <section style={S.card}>
            <div style={S.cardHead}><Rocket size={15} /> Where this goes next</div>
            <div style={S.roadGrid}>
              {ROADMAP.map(r => (
                <div key={r.h} style={S.roadCell}>
                  <div style={S.roadH}>{r.h}</div>
                  <div style={S.roadD}>{r.d}</div>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {/* ============ TAB 2 ============ */}
      {tab === "sim" && <>
        <div style={S.main}>
          <section style={{ ...S.mapWrap, ...(mapFull ? S.mapWrapFull : {}) }} ref={anchors.map}>
            {!hasData && <div style={S.noData}>No network loaded.<br /><span style={{ fontSize: 14, color: "#8f8f8f" }}>Add sites and demand regions in <b>Problem &amp; Data</b>, or load the sample.</span></div>}
            <div style={S.mapChrome}>
              <div style={S.mapTitle}>Network · <span style={{ color: "#b0b0b0" }}>{openIds.length} open DCs · {customers.length} regions</span></div>
              <div style={{ display: "flex", gap: 8, pointerEvents: "auto" }}>
                <button onClick={() => setAddingDemand(a => !a)} style={{ ...S.addDemandBtn, ...(addingDemand ? S.addDemandOn : {}) }}>
                  <Plus size={14} /> {addingDemand ? "Click map to place…" : "Demand centre"}
                </button>
                <div style={S.flowToggle}>
                  <span style={S.toggleLabel}>Flows by</span>
                  {["cost", "volume"].map(m => (
                    <button key={m} onClick={() => setFlowMetric(m)} style={{ ...S.toggleBtn, ...(flowMetric === m ? S.toggleBtnOn : {}) }}>{m}</button>))}
                </div>
                <button onClick={() => setMapFull(f => !f)} style={S.fullBtn} title={mapFull ? "Exit full screen (Esc)" : "View map full screen"}>
                  {mapFull ? <><Minimize2 size={14} /> Exit</> : <><Maximize2 size={14} /> Full screen</>}
                </button>
              </div>
            </div>

            <svg ref={svgRef} viewBox={MAP_VB_STR} preserveAspectRatio="xMidYMid meet" style={{ ...S.svg, cursor: addingDemand ? "crosshair" : "default" }} onClick={mapClick}>
              <defs>
                <pattern id="grid" width="50" height="50" patternUnits="userSpaceOnUse">
                  <path d="M50 0 H0 V50" fill="none" stroke="#161616" strokeWidth="1" />
                </pattern>
                <radialGradient id="vig" cx="50%" cy="45%" r="75%">
                  <stop offset="55%" stopColor="transparent" /><stop offset="100%" stopColor="#050505" />
                </radialGradient>
              </defs>
              <rect x={MAP_VB.x} y={MAP_VB.y} width={MAP_VB.w} height={MAP_VB.h} fill="url(#grid)" />
              <rect x={MAP_VB.x} y={MAP_VB.y} width={MAP_VB.w} height={MAP_VB.h} fill="url(#vig)" />

              {laneFlows.map(f => {
                const w = whById[f.from], c = cById[f.to]; if (!w || !c) return null;
                const t = uHi === uLo ? 0 : (f.distance * f.m - uLo) / (uHi - uLo);
                const col = flowMetric === "cost" ? flowColor(t) : "#4a7fbd";
                return <line key={f.key} x1={w.x} y1={w.y} x2={c.x} y2={c.y} stroke={col}
                  strokeWidth={0.8 + (f.volume / maxVol) * 6} strokeOpacity={f.over ? 0.95 : 0.62}
                  strokeLinecap="round" strokeDasharray={f.over ? "2 6" : "none"} className="lane" />;
              })}

              {customers.map(c => {
                const s = 6 + (c.demand / maxDemand) * 8;
                const isSel = selected?.kind === "cust" && selected.id === c.id;
                return (
                  <g key={c.id} onClick={e => { e.stopPropagation(); if (!addingDemand) { demandStartRef.current = c.demand; setSelected({ kind: "cust", id: c.id }); } }} style={{ cursor: "pointer" }}>
                    {isSel && <rect x={c.x - s - 5} y={c.y - s - 5} width={(s + 5) * 2} height={(s + 5) * 2} rx="3" transform={`rotate(45 ${c.x} ${c.y})`} fill="none" stroke="#ffffff" strokeWidth="2" />}
                    <rect x={c.x - s} y={c.y - s} width={s * 2} height={s * 2} rx="1.5" transform={`rotate(45 ${c.x} ${c.y})`}
                      fill="#6b7fa4" fillOpacity={isSel ? 1 : 0.9} className="node" />
                    <text x={c.x} y={c.y + s + 17} style={S.custLabel}>{c.name}</text>
                  </g>
                );
              })}

              {warehouses.map(w => {
                const isOpen = openIds.includes(w.id);
                const exited = !isOpen && w.status === "active";
                const u = kpi.util[w.id];
                const r = isOpen ? 14 + Math.sqrt(kpi.throughput[w.id] || 0) / Math.sqrt(maxThru) * 22 : 12;
                const col = isOpen ? utilColor(u) : exited ? EXIT : "#454545";
                const isSel = selected?.kind === "wh" && selected.id === w.id;
                return (
                  <g key={w.id} onClick={e => { e.stopPropagation(); if (!addingDemand) { capStartRef.current = capOverride[w.id] ?? w.capacity; setSelected({ kind: "wh", id: w.id }); } }} style={{ cursor: "pointer" }}>
                    {isSel && <circle cx={w.x} cy={w.y} r={r + 9} fill="none" stroke="#ffffff" strokeWidth="2.2" strokeOpacity="0.9" />}
                    {isOpen && u > 1 && <circle cx={w.x} cy={w.y} r={r + 6} fill="none" stroke={BAD} strokeWidth="1.8" strokeOpacity="0.6" className="pulse" />}
                    {exited && <circle cx={w.x} cy={w.y} r={r + 7} fill="none" stroke={EXIT} strokeWidth="1.6" strokeOpacity="0.45" className="pulse" />}
                    <circle cx={w.x} cy={w.y} r={r} fill={isOpen ? col : "transparent"} fillOpacity={isOpen ? 0.22 : 1}
                      stroke={col} strokeWidth={isOpen ? 2.8 : 2} strokeDasharray={isOpen ? "none" : "5 4"} className="node" />
                    <circle cx={w.x} cy={w.y} r={3.4} fill={col} />
                    {exited && <>
                      <line x1={w.x - 6} y1={w.y - 6} x2={w.x + 6} y2={w.y + 6} stroke={EXIT} strokeWidth="2.4" strokeLinecap="round" />
                      <line x1={w.x + 6} y1={w.y - 6} x2={w.x - 6} y2={w.y + 6} stroke={EXIT} strokeWidth="2.4" strokeLinecap="round" />
                    </>}
                    <text x={w.x} y={w.y - r - 10} style={{ ...S.whLabel, fill: isOpen ? "#f7f7f7" : exited ? EXIT : "#8a8a8a" }}>
                      {w.name}{!isOpen && !exited && " +"}
                    </text>
                    {isOpen && <text x={w.x} y={w.y - r + 9} style={S.whUtil}>{((u || 0) * 100).toFixed(0)}%</text>}
                    {exited && <text x={w.x} y={w.y + r + 19} style={S.exitTag}>✕ EXITED</text>}
                    {w.lockOpen && <text x={w.x + r + 4} y={w.y - r + 2} style={S.lockTag}>🔒</text>}
                  </g>
                );
              })}
            </svg>

            <div style={S.legend}>
              <Dot c={INFO} t="Under 50%" /><Dot c={GOOD} t="Healthy" /><Dot c={WARN} t="High load" /><Dot c={BAD} t="Overloaded" />
              <span style={S.legendSep} />
              <Dot c={EXIT} t="✕ Exited site" /><Dot c="#454545" t="+ Candidate" />
              <span style={S.legendSep} />
              <span style={S.legendNote}>line colour = lane cost · thickness = volume · ◇ demand · ○ DC sized by throughput</span>
            </div>

            {selWh && (
              <div style={S.editor}>
                <div style={S.editorHead}>
                  <div>
                    <div style={S.editorName}><Building2 size={15} /> {selWh.name}</div>
                    <div style={S.editorRole}>
                      {selWh.type}
                      {selWh.status === "candidate" ? " · candidate" : ""}
                      {!selOpen && selWh.status === "active" ? " · exited" : ""}
                    </div>
                  </div>
                  <button onClick={() => setSelected(null)} style={S.editorClose}><X size={15} /></button>
                </div>
                {selOpen ? <>
                  <Row k="Utilisation" v={((kpi.util[selWh.id] || 0) * 100).toFixed(0) + "%"} c={utilColor(kpi.util[selWh.id])} />
                  <Row k="Throughput" v={Math.round(kpi.throughput[selWh.id] || 0).toLocaleString() + "k u/yr"} />
                  <Row k="Fixed cost" v={inr(selWh.fixedCost) + "/yr"} />
                  <Row k="Handling opex" v={"₹" + selWh.opex.toFixed(1) + "/unit"} />
                  <Row k="Exit cost" v={inr(exitCostOf(selWh)) + " one-time"} c={WARN} />
                  <div style={S.sliderRow}>
                    <div style={S.sliderTop}><span>Capacity (’000u/yr)</span><b>{selCap.toLocaleString()}k</b></div>
                    <input type="range" min={capMin} max={capMax} step={50} value={selCap}
                      onChange={e => setCapOverride(o => ({ ...o, [selWh.id]: +e.target.value }))}
                      onMouseUp={() => { if (capStartRef.current !== selCap) { autoLog(openIds, capOverride); capStartRef.current = selCap; } }}
                      onTouchEnd={() => { if (capStartRef.current !== selCap) { autoLog(openIds, capOverride); capStartRef.current = selCap; } }}
                      style={S.slider} />
                  </div>
                  {selExpCost > 0 && (
                    <div style={S.expWarn}><AlertTriangle size={12} color={WARN} /> +{(selCap - selWh.capacity).toLocaleString()}k capacity → <b>+{inr(selExpCost)}/yr</b></div>
                  )}
                  {selCap < selWh.capacity && (
                    <div style={S.shrinkNote}>Shrinking saves no fixed cost — the lease is committed — and pushes volume to other DCs, so expect freight and service to worsen.</div>
                  )}
                  <div style={S.leaseNote}>Closing avoids {inr(selWh.fixedCost)}/yr fixed cost at lease break, against a one-time exit cost of {inr(exitCostOf(selWh))}.</div>
                  <button onClick={() => toggleNode(selWh.id)} style={S.dangerBtn}>Exit this DC</button>
                  <button onClick={() => setWhField(selWh.id, { lockOpen: !selWh.lockOpen })}
                    style={{ ...S.lockBtn, ...(selWh.lockOpen ? S.lockBtnOn : {}) }}>
                    {selWh.lockOpen ? <><Lock size={13} /> Locked open</> : <><Unlock size={13} /> Lock open</>}
                  </button>
                </> : <>
                  <Row k="Capacity" v={selWh.capacity.toLocaleString() + "k u/yr"} />
                  <Row k={selWh.status === "active" ? "Fixed cost avoided" : "Opening cost"} v={inr(selWh.fixedCost) + "/yr"} />
                  <Row k="Handling opex" v={"₹" + selWh.opex.toFixed(1) + "/unit"} />
                  {selWh.status === "active" && <Row k="One-time exit cost" v={inr(exitCostOf(selWh))} c={WARN} />}
                  <div style={S.candNote}>
                    {selWh.status === "active"
                      ? `Exited site. Volume has been reallocated to the cheapest remaining DCs. Avoids ${inr(selWh.fixedCost)}/yr from lease break, against ${inr(exitCostOf(selWh))} one-time.`
                      : "Candidate site — opening it adds its fixed cost to the network."}
                  </div>
                  <button onClick={() => toggleNode(selWh.id)} style={S.confirmBtn}>
                    {selWh.status === "active" ? "Re-open this DC" : "Open this DC"}
                  </button>
                </>}
              </div>
            )}

            {selCust && (
              <div style={S.editor}>
                <div style={S.editorHead}>
                  <div>
                    <div style={S.editorName}><Target size={15} /> Demand region</div>
                    <input style={S.nameIn} value={selCust.name} onChange={e => setCustField(selCust.id, { name: e.target.value })} />
                  </div>
                  <button onClick={() => setSelected(null)} style={S.editorClose}><X size={15} /></button>
                </div>
                <div style={S.sliderRow}>
                  <div style={S.sliderTop}><span>Demand (’000u/yr)</span><b>{selCust.demand.toLocaleString()}k</b></div>
                  <input type="range" min={50} max={1500} step={25} value={selCust.demand}
                    onChange={e => setCustField(selCust.id, { demand: +e.target.value })}
                    onMouseUp={() => { const s = demandStartRef.current; if (s != null && s !== selCust.demand) { const cur = selCust.demand; setCustField(selCust.id, { demand: s }); setTimeout(() => applyDemandChange(selCust.id, cur, "via slider"), 0); demandStartRef.current = cur; } }}
                    style={S.slider} />
                </div>
                <Row k="Served from" v={kpi.flows.filter(f => f.to === selCust.id).map(f => whById[f.from]?.name).join(", ") || "—"} />
                <Row k="Avg haul" v={(() => { const fl = kpi.flows.filter(f => f.to === selCust.id); const v = fl.reduce((s, f) => s + f.volume, 0); return v ? (fl.reduce((s, f) => s + f.volume * f.distance, 0) / v).toFixed(0) + " km" : "—"; })()} />
                <button onClick={() => removeCust(selCust.id)} style={S.dangerBtn}>Remove region</button>
              </div>
            )}
          </section>

          <aside style={S.copilot} ref={anchors.copilot}>
            <div style={S.copilotHead}>
              <div style={S.copilotTitle}><Sparkles size={16} /> Copilot</div>
              <div style={S.copilotObj}>objective · <b style={{ color: "#ffffff" }}>{objective}</b></div>
            </div>
            <div ref={feedRef} style={S.feed}>
              {messages.map(m => m.role === "user" ? <div key={m.id} style={S.userMsg}>{m.payload.text}</div> : <AiMsg key={m.id} p={m.payload} />)}
            </div>
            <div style={S.composer}>
              {querySpeech.supported && (
                <button onClick={() => querySpeech.listening ? querySpeech.stop() : querySpeech.start()}
                  style={{ ...S.micBtn, ...(querySpeech.listening ? S.micLive : {}) }} title="Dictate a what-if">
                  <Mic size={16} />
                </button>
              )}
              <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === "Enter" && submitQuery()}
                placeholder="Ask a what-if, or say “optimise for cost”…" style={S.input} />
              <button onClick={submitQuery} style={S.sendBtn}><Send size={16} /></button>
            </div>
            <div style={S.suggestRow}>
              {["Open WH 6", "Increase demand at D9 by 30%", "Set carbon tax to 800", "Optimise for cost"].map(s => (
                <button key={s} onClick={() => { push("user", { text: s }); parseQuery(s); }} style={S.chip}>{s}</button>))}
            </div>
          </aside>
        </div>

        <footer style={S.kpiBar}>
          <Kpi icon={IndianRupee} label="Total network cost" value={inr(animCost)} delta={deltas.cost} unit="cr" good={deltas.cost < 0}
            sub={`${inr(kpi.transportCost)} freight · ${inr(kpi.handlingCost)} handling · ${inr(kpi.fixedCost)} fixed${kpi.carbonCost > 0.05 ? ` · ${inr(kpi.carbonCost)} carbon` : ""}`} />
          <Kpi icon={Truck} label="Avg distance" value={kpi.avgDistance.toFixed(0) + " km"} delta={deltas.distance} unit=" km" good={deltas.distance < 0} sub="service proxy" />
          <Kpi icon={Gauge} label="Service level" value={animSvc.toFixed(1) + "%"} delta={deltas.service} unit=" pts" good={deltas.service > 0} sub={`within ${DEFAULT_SVC_KM} km`} />
          <Kpi icon={Building2} label="Sites at capacity" value={`${openIds.filter(id => kpi.util[id] > 0.99).length} / ${openIds.length}`} sub="utilisation risk" />
          <div style={S.kpi}>
            <div style={S.kpiTop}><Leaf size={14} color="#8f8f8f" /><span style={S.kpiLabel}>Carbon</span></div>
            <div style={S.kpiValRow}>
              <span style={S.kpiValue}>{kpi.carbon.toFixed(0)}k</span>
              {Math.abs(deltas.carbon) > 0.05 && <span style={{ ...S.kpiDelta, color: deltas.carbon < 0 ? GOOD : BAD }}>
                {deltas.carbon < 0 ? <TrendingDown size={13} /> : <TrendingUp size={13} />}{deltas.carbon > 0 ? "+" : ""}{deltas.carbon.toFixed(0)}k</span>}
            </div>
            <div style={S.kpiSub}>tax ₹{carbonPrice}/t{kpi.carbonCost > 0.05 ? ` · ${inr(kpi.carbonCost)}` : ""}</div>
            <input type="range" min={0} max={2000} step={50} value={carbonPrice}
              onChange={e => setCarbonPrice(+e.target.value)} style={{ width: "100%", marginTop: 6 }} title="Carbon price ₹/tCO₂" />
          </div>
        </footer>
      </>}

      {/* ============ TAB 3 ============ */}
      {tab === "cmp" && (
        <div style={S.setupWrap}>
          <section style={S.card}>
            <div style={S.cardHead}><Gauge size={15} /> Sensitivity — stress-test the assumptions</div>
            <p style={S.cardText}>Every configuration tested in the Simulator is logged below automatically. Drag these to see how each one holds up if freight rates spike, demand grows, the service promise tightens, or a carbon tax lands. A scenario that keeps winning as the assumptions swing is a robust recommendation.</p>
            <div style={S.sensGrid}>
              <SensSlider label="Transport rate" value={sens.rateMult} min={0.6} max={1.6} step={0.05} fmt={v => "×" + v.toFixed(2)} base={1}
                onChange={v => setSens(s => ({ ...s, rateMult: v }))} />
              <SensSlider label="Demand (all regions)" value={sens.demandMult} min={0.7} max={1.4} step={0.05} fmt={v => "×" + v.toFixed(2)} base={1}
                onChange={v => setSens(s => ({ ...s, demandMult: v }))} />
              <SensSlider label="Service threshold" value={sens.svcKm} min={400} max={1000} step={25} fmt={v => v + " km"} base={DEFAULT_SVC_KM}
                onChange={v => setSens(s => ({ ...s, svcKm: v }))} />
              <SensSlider label="Carbon price" value={carbonPrice} min={0} max={2000} step={50} fmt={v => "₹" + v + "/t"} base={0}
                onChange={v => setCarbonPrice(v)} />
              <SensSlider label="Exit cost" value={sens.exitMult} min={0.5} max={3} step={0.1} fmt={v => "×" + v.toFixed(1)} base={1}
                onChange={v => setSens(s => ({ ...s, exitMult: v }))} />
              <div style={{ display: "flex", alignItems: "flex-end" }}>
                <button style={S.ghostBtn} onClick={() => { setSens({ rateMult: 1, demandMult: 1, svcKm: DEFAULT_SVC_KM, exitMult: 1 }); setCarbonPrice(0); }}><RotateCcw size={14} /> Reset</button>
              </div>
            </div>
          </section>

          <section style={S.card} ref={anchors.cmp}>
            <div style={S.cardHeadRow}>
              <div style={S.cardHead}><GitCompare size={15} /> Scenario comparison <span style={S.count}>{allCmp.length}</span></div>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontSize: 12.5, color: "#8f8f8f" }}>winner scored on</span>
                <div style={S.objGroup}>
                  {objectives.map(o => { const on = objective === o.id; return (
                    <button key={o.id} onClick={() => setObjective(o.id)} style={{ ...S.objBtn, ...(on ? S.objBtnOn : {}), fontSize: 12.5, padding: "6px 10px" }}>{o.label}</button>); })}
                </div>
                {scenarios.length > 0 && <button style={S.ghostBtn} onClick={() => setScenarios([])}><Trash2 size={14} /> Clear log</button>}
              </div>
            </div>
            {scenarios.length === 0 && <Empty text="Nothing logged yet. Test configurations in the Simulator — open or exit sites, resize capacity, or run the optimiser — and each one appears here automatically. Resetting the simulation keeps this log." />}

            {scenarios.length > 0 && (
              <div style={S.barSection}>
                {allCmp.map(({ sc, k }) => {
                  const isWin = sc.id === winnerId;
                  return (
                    <div key={sc.id} style={S.barRow}>
                      <div style={S.barName} title={sc.name}>{isWin && <Star size={12} fill={WARN} color={WARN} style={{ marginRight: 5, verticalAlign: "-1px" }} />}{sc.name}</div>
                      <div style={S.barTrack}>
                        <div style={{ ...S.barFill, width: (k.totalCost / maxCmpCost * 100) + "%", background: isWin ? `linear-gradient(90deg,${GOOD},${INFO})` : "#3a3a3a" }} />
                        <span style={S.barVal}>{inr(k.totalCost)}</span>
                      </div>
                      <div style={{ ...S.barSvc, color: k.serviceLevel >= 0.98 ? GOOD : k.serviceLevel >= 0.9 ? WARN : BAD }}>{(k.serviceLevel * 100).toFixed(1)}%</div>
                    </div>
                  );
                })}
                <div style={S.barLegend}>bar = total annual cost, shorter is better · right column = service level · ★ = best for “{objective}” under the current assumptions</div>
              </div>
            )}

            <div style={S.tableWrap}>
              <table style={S.table}>
                <thead><tr>{["Scenario", "", "Total cost", "Freight", "Handling", "Fixed", "Carbon ₹", "Avg dist", "Service", "At cap", "Exit ₹", "Payback"].map((h, i) => <th key={i} style={S.th}>{h}</th>)}</tr></thead>
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
                    const closedIds = activeIds.filter(id => !k.openIds.includes(id));
                    const saving = cmpBaseline.totalCost - k.totalCost;
                    const te = isBase ? null : transitionEconomics(
                      warehouses.map(w => ({ ...w, exitCost: exitCostOf(w) * sens.exitMult })), closedIds, saving, discountRate);
                    return (
                      <tr key={sc.id} style={isBase ? S.baseRow : (isWin ? S.winRow : null)}>
                        <td style={S.tdc}>
                          <div style={{ fontWeight: 600, fontSize: 13.5 }}>{isWin && <Star size={12} fill={WARN} color={WARN} style={{ marginRight: 5, verticalAlign: "-1px" }} />}{sc.name}</div>
                          <div style={{ fontSize: 11.5, color: "#8f8f8f", fontFamily: mono }}>{k.openIds.length} DCs open</div>
                        </td>
                        <td style={S.tdc}>{!isBase && <div style={{ display: "flex", gap: 5 }}>
                          <button style={S.miniBtn} onClick={() => { setOpenIds([...sc.openIds]); setCapOverride({ ...sc.capOverride }); setTab("sim"); push("ai", { kind: "note", text: `Loaded “${sc.name}” into the simulator.` }); }}>Load</button>
                          <button style={S.rowDel} onClick={() => setScenarios(s => s.filter(x => x.id !== sc.id))}><Trash2 size={13} /></button>
                        </div>}</td>
                        {cell(inr(k.totalCost), Math.abs(k.totalCost - bestCost) < 1e-9, k.totalCost - cmpBaseline.totalCost, "cr")}
                        {cell(inr(k.transportCost), false, k.transportCost - cmpBaseline.transportCost, "cr")}
                        {cell(inr(k.handlingCost), false, k.handlingCost - cmpBaseline.handlingCost, "cr")}
                        {cell(inr(k.fixedCost), false, k.fixedCost - cmpBaseline.fixedCost, "cr")}
                        {cell(k.carbonCost > 0.005 ? inr(k.carbonCost) : "—", false, k.carbonCost - cmpBaseline.carbonCost, "cr")}
                        {cell(k.avgDistance.toFixed(0) + " km", Math.abs(k.avgDistance - bestDist) < 1e-9, k.avgDistance - cmpBaseline.avgDistance, "km")}
                        {cell((k.serviceLevel * 100).toFixed(1) + "%", Math.abs(k.serviceLevel - bestSvc) < 1e-9, (k.serviceLevel - cmpBaseline.serviceLevel) * 100, "pts", false)}
                        <td style={S.tdc}><div style={{ ...S.cmpVal, color: overCap ? WARN : GOOD }}>{overCap} / {k.openIds.length}</div></td>
                        <td style={S.tdc}><div style={{ ...S.cmpVal, color: te ? WARN : "#5a5a5a" }}>{te ? inr(te.oneTime) : "—"}</div></td>
                        <td style={S.tdc}>
                          <div style={{ ...S.cmpVal, color: !te ? "#5a5a5a" : te.npv > 0 ? GOOD : BAD }}>
                            {!te ? "—" : te.paybackMonths < 600 ? te.paybackMonths.toFixed(0) + " mo" : "never"}
                          </div>
                          {te && <div style={{ ...S.cmpDelta, color: te.npv > 0 ? GOOD : BAD }}>NPV {inr(te.npv)}</div>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {scenarios.length > 0 && (
              <div style={S.cmpNote}>
                All rows re-solved live under the sensitivity assumptions above. Green deltas beat the baseline, red fall short; the best value in each column is outlined.
                Exit cost and payback are transition economics — a {NPV_YEARS}-year NPV at {discountRate}% against the annual saving — and are deliberately kept out of the ranking, which scores steady-state annual cost.
                If the ★ stays on one scenario as you drag, that recommendation is robust.
              </div>
            )}
          </section>

          <section style={S.card}>
            <div style={S.cardHead}><Rocket size={15} /> Where this goes next</div>
            <div style={S.roadGrid}>
              {ROADMAP.map(r => (
                <div key={r.h} style={S.roadCell}>
                  <div style={S.roadH}>{r.h}</div>
                  <div style={S.roadD}>{r.d}</div>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {/* ============ C6 · TUTORIAL ============ */}
      {tut.on && (
        <div style={S.tutOverlay} onClick={() => tutGo(-1)}>
          {tutRect
            ? <div style={{ ...S.tutSpot, top: tutRect.top - 6, left: tutRect.left - 6, width: tutRect.width + 12, height: tutRect.height + 12 }} />
            : <div style={S.tutDim} />}
          <div style={{ ...S.tutCard, ...(tutRect ? tutCardPos(tutRect) : S.tutCardCenter) }} onClick={e => e.stopPropagation()}>
            <div style={S.tutTop}>
              <span style={S.tutStep}>{tut.step + 1} / {TUTORIAL.length}</span>
              <div style={S.tutDots}>
                {TUTORIAL.map((_, i) => <span key={i} style={{ ...S.tutDot, ...(i === tut.step ? S.tutDotOn : {}) }} />)}
              </div>
              <button style={S.tutSkip} onClick={() => tutGo(-1)}>Skip</button>
            </div>
            <div style={S.tutTitle}>{TUTORIAL[tut.step].title}</div>
            <div style={S.tutBody}>{TUTORIAL[tut.step].body}</div>
            <div style={S.tutActions}>
              <button style={{ ...S.tutBack, visibility: tut.step === 0 ? "hidden" : "visible" }} onClick={() => tutGo(tut.step - 1)}>
                <ChevronLeft size={14} /> Back
              </button>
              {tut.step === TUTORIAL.length - 1 ? (
                <div style={{ display: "flex", gap: 8 }}>
                  <button style={S.tutGhost} onClick={() => tutGo(-1)}>Explore myself</button>
                  <button style={S.tutNext} onClick={tutorialWalkthrough}><Zap size={14} /> Run a sample optimisation</button>
                </div>
              ) : (
                <button style={S.tutNext} onClick={() => tutGo(tut.step + 1)}>Next <ChevronRight size={14} /></button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function tutCardPos(r) {
  const below = r.top + r.height + 18;
  const spaceBelow = (typeof window !== "undefined" ? window.innerHeight : 900) - below;
  const w = 400;
  const left = Math.max(18, Math.min((typeof window !== "undefined" ? window.innerWidth : 1400) - w - 18, r.left + r.width / 2 - w / 2));
  if (spaceBelow > 210) return { top: below, left, width: w };
  return { top: Math.max(18, r.top - 232), left, width: w };
}

const Dot = ({ c, t }) => <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "#a8a8a8" }}><span style={{ width: 10, height: 10, borderRadius: 10, background: c }} />{t}</span>;
const Param = ({ label, value }) => <div style={S.param}><div style={S.paramLabel}>{label}</div><div style={S.paramValue}>{value}</div></div>;
const Row = ({ k, v, c }) => <div style={S.editRow}><span>{k}</span><b style={c ? { color: c } : null}>{v}</b></div>;
const Empty = ({ text }) => <div style={S.empty}>{text}</div>;

function SensSlider({ label, value, min, max, step, fmt, base, onChange }) {
  const changed = Math.abs(value - base) > 0.001;
  return (
    <div style={S.sensCell}>
      <div style={S.sliderTop}><span>{label}</span><b style={{ color: changed ? WARN : "#d4d4d4" }}>{fmt(value)}</b></div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(+e.target.value)} style={{ width: "100%" }} />
    </div>
  );
}

function Kpi({ icon: Ic, label, value, delta, unit, good, sub }) {
  const show = typeof delta === "number" && Math.abs(delta) > 0.05;
  return (
    <div style={S.kpi}>
      <div style={S.kpiTop}><Ic size={14} color="#8f8f8f" /><span style={S.kpiLabel}>{label}</span></div>
      <div style={S.kpiValRow}>
        <span style={S.kpiValue}>{value}</span>
        {show && <span style={{ ...S.kpiDelta, color: good ? GOOD : BAD }}>
          {good ? <TrendingDown size={13} /> : <TrendingUp size={13} />}{delta > 0 ? "+" : ""}{Math.abs(delta) >= 10 ? delta.toFixed(0) : delta.toFixed(1)}{unit}
        </span>}
      </div>
      <div style={S.kpiSub}>{sub}</div>
    </div>
  );
}

function AiMsg({ p }) {
  if (p.kind === "note") return <div style={S.aiNote}>{p.text}</div>;
  return (
    <div style={{ ...S.aiCard, ...(p.hero ? S.aiCardHero : {}) }}>
      {p.kind === "diagnostic" && <>
        <div style={S.aiCardTitle}><Eye size={14} /> {p.title}</div>
        {p.lines.map((l, i) => <div key={i} style={S.aiLine}>{l}</div>)}
        {p.cta && <div style={S.aiCta}><ChevronRight size={13} />{p.cta}</div>}
      </>}
      {p.kind === "scenario" && <>
        <div style={S.aiCardTitle}><Target size={14} /> {p.title}</div>
        {p.subtitle && <div style={S.aiSubtitle}>{p.subtitle}</div>}
        <MetricGrid metrics={p.metrics} />
        {p.note && <div style={S.aiFoot}>{p.note}</div>}
      </>}
      {p.kind === "recommend" && <>
        <div style={S.recBadge}>Recommendation · {p.objLabel}</div>
        <div style={S.recHead}>{p.headline}</div>
        <MetricGrid metrics={p.metrics} big />
        {p.transition && (
          <div style={S.teBox}>
            <div style={S.teHead}><Clock size={13} /> Transition economics</div>
            <div style={S.teGrid}>
              <div><div style={S.teLabel}>One-time exit</div><div style={S.teVal}>{inr(p.transition.oneTime)}</div></div>
              <div><div style={S.teLabel}>Payback</div><div style={{ ...S.teVal, color: p.transition.paybackMonths <= 24 ? GOOD : WARN }}>{p.transition.paybackMonths.toFixed(0)} months</div></div>
              <div><div style={S.teLabel}>{NPV_YEARS}-yr NPV @ {p.transition.discountRate}%</div><div style={{ ...S.teVal, color: p.transition.npv > 0 ? GOOD : BAD }}>{inr(p.transition.npv)}</div></div>
            </div>
          </div>
        )}
        <div style={S.aiSubhead}>Why</div>
        {p.rationale.map((l, i) => <div key={i} style={S.aiLine}>{l}</div>)}
        <div style={S.aiSubhead}>Watch-outs</div>
        {p.watchouts.map((l, i) => <div key={i} style={S.aiWatch}><AlertTriangle size={12} color={WARN} style={{ flexShrink: 0, marginTop: 2 }} /> {l}</div>)}
      </>}
    </div>
  );
}

function MetricGrid({ metrics, big }) {
  return (
    <div style={S.metricGrid}>
      {metrics.map((m, i) => {
        const show = typeof m.delta === "number" && Math.abs(m.delta) > 0.05;
        return (
          <div key={i} style={S.metricCell}>
            <div style={S.metricLabel}>{m.label}</div>
            <div style={{ ...S.metricValue, ...(big ? { fontSize: 19 } : {}) }}>{m.value}</div>
            {show && <div style={{ ...S.metricDelta, color: m.good ? GOOD : BAD }}>
              {m.good ? "▼" : "▲"} {m.delta > 0 ? "+" : ""}{Math.abs(m.delta) >= 10 ? m.delta.toFixed(0) : m.delta.toFixed(1)}{m.unit || ""}</div>}
          </div>
        );
      })}
    </div>
  );
}

const mono = "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace";
const sans = "'Space Grotesk', -apple-system, system-ui, sans-serif";
const css = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
* { box-sizing: border-box; }
.glow:hover { box-shadow: 0 4px 26px rgba(255,255,255,0.28); transform: translateY(-1px); }
.pulse { animation: pulse 2s ease-in-out infinite; }
@keyframes pulse { 0%,100% { stroke-opacity: .6; } 50% { stroke-opacity: .12; } }
.lane { transition: stroke-width .45s cubic-bezier(.4,0,.2,1), stroke .45s ease, stroke-opacity .45s ease; }
.node { transition: r .45s cubic-bezier(.4,0,.2,1), fill .45s ease, stroke .45s ease; }
@keyframes livepulse { 0%,100%{ box-shadow:0 0 0 0 rgba(248,81,73,.5);} 50%{ box-shadow:0 0 0 6px rgba(248,81,73,0);} }
input[type=range]{ -webkit-appearance:none; appearance:none; height:5px; border-radius:5px; background:#2a2a2a; outline:none; }
input[type=range]::-webkit-slider-thumb{ -webkit-appearance:none; width:16px; height:16px; border-radius:50%; background:#f5f5f5; cursor:pointer; border:2px solid #0a0a0a; }
input[type=range]::-moz-range-thumb{ width:16px; height:16px; border-radius:50%; background:#f5f5f5; cursor:pointer; border:2px solid #0a0a0a; }
input[type=number]::-webkit-inner-spin-button{ opacity:.3; }
select{ appearance:none; -webkit-appearance:none; }
::-webkit-scrollbar{ width:9px; height:9px; } ::-webkit-scrollbar-thumb{ background:#333; border-radius:9px; }
textarea:focus, input:focus, select:focus { border-color:#5a5a5a !important; }
button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid #58a6ff; outline-offset: 2px; }
button:disabled { opacity:.42; cursor:not-allowed; }
@media (prefers-reduced-motion: reduce){ .pulse,.glow,.lane,.node{ animation:none !important; transition:none !important; } }
`;

const BORDER = "#262626", BORDER_SOFT = "#1f1f1f", MUTED = "#8f8f8f", DIM = "#7a7a7a";

const S = {
  root: { fontFamily: sans, background: "#0a0a0a", color: "#f2f2f2", height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" },
  topbar: { display: "flex", alignItems: "center", gap: 14, padding: "12px 20px", borderBottom: "1px solid " + BORDER, background: "#0e0e0e", flexWrap: "wrap" },
  brand: { display: "flex", alignItems: "center", gap: 12 },
  logoMark: { width: 38, height: 38, borderRadius: 10, background: "#f5f5f5", display: "grid", placeItems: "center", color: "#0a0a0a" },
  brandName: { fontWeight: 700, fontSize: 18, letterSpacing: "-0.02em" },
  brandSub: { fontSize: 12, color: MUTED },
  tabs: { display: "flex", background: "#0a0a0a", border: "1px solid " + BORDER, borderRadius: 11, padding: 3, gap: 2 },
  tabBtn: { display: "inline-flex", alignItems: "center", gap: 7, border: "none", background: "transparent", color: "#b0b0b0", fontFamily: sans, fontSize: 13.5, fontWeight: 600, padding: "8px 13px", borderRadius: 8, cursor: "pointer" },
  tabOn: { background: "#f5f5f5", color: "#0a0a0a" },
  tabCount: { fontSize: 11.5, fontFamily: mono, background: "rgba(0,0,0,.25)", borderRadius: 8, padding: "1px 7px", marginLeft: 4 },
  objWrap: { display: "flex", alignItems: "center", gap: 10 },
  objLabel: { fontSize: 12, color: MUTED, textTransform: "uppercase", letterSpacing: "0.08em" },
  objGroup: { display: "flex", background: "#0a0a0a", border: "1px solid " + BORDER, borderRadius: 10, padding: 3, gap: 2 },
  objBtn: { display: "inline-flex", alignItems: "center", gap: 6, border: "none", background: "transparent", color: "#b0b0b0", fontFamily: sans, fontSize: 13.5, fontWeight: 500, padding: "7px 12px", borderRadius: 7, cursor: "pointer" },
  objBtnOn: { background: "#2a2a2a", color: "#ffffff", boxShadow: "inset 0 0 0 1px #444" },
  topActions: { marginLeft: "auto", display: "flex", gap: 9, alignItems: "center" },
  lockChip: { display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, fontFamily: mono, color: BLUE, background: "#1f6feb1a", border: "1px solid #1f6feb55", borderRadius: 7, padding: "5px 9px" },
  ghostBtn: { display: "inline-flex", alignItems: "center", gap: 7, background: "#161616", border: "1px solid #303030", color: "#e0e0e0", fontFamily: sans, fontSize: 13.5, fontWeight: 600, padding: "9px 14px", borderRadius: 10, cursor: "pointer" },
  tutBtn: { display: "inline-flex", alignItems: "center", gap: 7, background: "#1f6feb1a", border: "1px solid #1f6feb66", color: BLUE, fontFamily: sans, fontSize: 13.5, fontWeight: 600, padding: "9px 14px", borderRadius: 10, cursor: "pointer" },
  optimizeBtn: { display: "inline-flex", alignItems: "center", gap: 8, background: "#f5f5f5", color: "#0a0a0a", border: "none", fontFamily: sans, fontWeight: 700, fontSize: 14, padding: "10px 16px", borderRadius: 10, cursor: "pointer", transition: "all .18s" },
  optimizeBusy: { background: "#3a3a3a", color: "#e0e0e0", cursor: "wait" },
  resetBtn: { display: "grid", placeItems: "center", width: 39, height: 39, background: "#161616", border: "1px solid #303030", color: "#b0b0b0", borderRadius: 10, cursor: "pointer" },

  loopStrip: { display: "flex", alignItems: "center", gap: 8, padding: "8px 20px", background: "#0c0c0c", borderBottom: "1px solid " + BORDER, flexWrap: "wrap" },
  loopLead: { fontSize: 11, color: DIM, textTransform: "uppercase", letterSpacing: ".1em", fontWeight: 600, marginRight: 4 },
  loopStage: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600, color: "#6a6a6a", background: "#111", border: "1px solid " + BORDER_SOFT, borderRadius: 7, padding: "5px 10px", transition: "all .25s ease" },
  loopStageOn: { color: "#0a0a0a", background: "#f5f5f5", borderColor: "#f5f5f5", boxShadow: "0 0 18px rgba(255,255,255,.28)" },
  loopArrow: { color: "#3a3a3a", fontSize: 12 },
  loopNote: { fontSize: 12, color: DIM, marginLeft: 8 },

  setupWrap: { flex: 1, overflowY: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 16 },
  setupGrid: { display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 16 },
  card: { background: "#101010", border: "1px solid " + BORDER, borderRadius: 14, padding: 18 },
  cardHead: { display: "flex", alignItems: "center", gap: 9, fontWeight: 600, fontSize: 15.5, marginBottom: 13 },
  cardHeadRow: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 13, flexWrap: "wrap", gap: 9 },
  count: { fontSize: 12, fontFamily: mono, color: MUTED, background: "#0a0a0a", border: "1px solid " + BORDER, borderRadius: 6, padding: "2px 8px", marginLeft: 7 },
  cardText: { fontSize: 13.5, color: "#a8a8a8", lineHeight: 1.6, margin: "0 0 13px" },
  draftTag: { fontSize: 11, fontFamily: mono, color: BLUE, background: "#1f6feb1a", border: "1px solid #1f6feb55", borderRadius: 6, padding: "2px 8px", marginLeft: 8, fontWeight: 600 },
  brief: { width: "100%", minHeight: 168, background: "#0a0a0a", border: "1px solid " + BORDER, borderRadius: 10, padding: 13, color: "#dcdcdc", fontFamily: sans, fontSize: 13.8, lineHeight: 1.65, resize: "vertical", outline: "none" },
  paramRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 10, marginTop: 13 },
  param: { background: "#0a0a0a", border: "1px solid " + BORDER, borderRadius: 10, padding: "10px 12px" },
  paramLabel: { fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 5 },
  paramValue: { fontSize: 14.5, fontFamily: mono, fontWeight: 600 },
  uploadBtns: { display: "flex", gap: 10, flexWrap: "wrap" },
  upBtn: { display: "inline-flex", alignItems: "center", gap: 8, background: "#161616", border: "1px solid #303030", color: "#e0e0e0", fontFamily: sans, fontSize: 13.5, fontWeight: 600, padding: "10px 15px", borderRadius: 10, cursor: "pointer" },
  uploadPanel: { marginTop: 14, background: "#0a0a0a", border: "1px solid " + BORDER, borderRadius: 10, padding: 14 },
  upTitle: { fontSize: 12, color: "#b0b0b0", textTransform: "uppercase", letterSpacing: ".07em", fontWeight: 600, marginBottom: 8 },
  cols: { display: "block", fontFamily: mono, fontSize: 13, color: "#ffffff", background: "#101010", border: "1px solid " + BORDER, borderRadius: 8, padding: "8px 11px", marginBottom: 9 },
  upNote: { fontSize: 12.5, color: MUTED, lineHeight: 1.55, marginBottom: 12 },
  upActions: { display: "flex", gap: 9, flexWrap: "wrap" },
  tmplBtn: { display: "inline-flex", alignItems: "center", gap: 7, background: "#161616", border: "1px solid #3a3a3a", color: "#e8e8e8", fontFamily: sans, fontSize: 13, fontWeight: 600, padding: "8px 13px", borderRadius: 9, cursor: "pointer" },
  chooseBtn: { display: "inline-flex", alignItems: "center", gap: 7, background: "#f5f5f5", border: "none", color: "#0a0a0a", fontFamily: sans, fontSize: 13, fontWeight: 700, padding: "8px 13px", borderRadius: 9, cursor: "pointer" },
  cancelBtn: { background: "transparent", border: "1px solid #303030", color: "#b0b0b0", fontFamily: sans, fontSize: 13, padding: "8px 13px", borderRadius: 9, cursor: "pointer" },
  upErr: { display: "flex", alignItems: "center", gap: 7, marginTop: 11, fontSize: 13, color: BAD },
  laneNotice: { background: "#0a0a0a", border: "1px solid", borderRadius: 10, padding: "11px 13px", marginBottom: 12 },
  laneNoticeLine: { fontSize: 12.5, color: "#b4b4b4", lineHeight: 1.55 },
  reviewStrip: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, background: "rgba(245,165,36,.07)", border: "1px solid rgba(245,165,36,.35)", borderRadius: 12, padding: "12px 15px", flexWrap: "wrap" },
  confirmSmall: { display: "inline-flex", alignItems: "center", gap: 6, background: "#f5f5f5", border: "none", color: "#0a0a0a", fontFamily: sans, fontSize: 13, fontWeight: 700, padding: "8px 14px", borderRadius: 9, cursor: "pointer" },
  tableWrap: { overflowX: "auto" },
  table: { width: "100%", borderCollapse: "collapse" },
  th: { textAlign: "left", fontSize: 11.5, color: MUTED, textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 600, padding: "8px 10px", borderBottom: "1px solid " + BORDER, whiteSpace: "nowrap" },
  thC: { textAlign: "center", fontSize: 11.5, color: MUTED, fontFamily: mono, fontWeight: 600, padding: "8px 5px", borderBottom: "1px solid " + BORDER, whiteSpace: "nowrap" },
  td: { padding: "5px 7px", borderBottom: "1px solid #1a1a1a" },
  tdc: { padding: "10px 10px", borderBottom: "1px solid #1a1a1a", verticalAlign: "top" },
  tdLane: { padding: "3px 3px", borderBottom: "1px solid #1a1a1a", textAlign: "center" },
  laneIn: { width: 56, background: "transparent", border: "1px solid transparent", borderRadius: 6, fontFamily: mono, fontSize: 12.5, padding: "5px 3px", outline: "none", textAlign: "center" },
  baseRow: { background: "rgba(255,255,255,.035)" },
  winRow: { background: "rgba(63,185,80,.06)" },
  bestCell: { boxShadow: "inset 0 0 0 1px rgba(63,185,80,.5)", borderRadius: 6, background: "rgba(63,185,80,.07)" },
  cmpVal: { fontFamily: mono, fontSize: 14, fontWeight: 600 },
  cmpDelta: { fontFamily: mono, fontSize: 11.5, marginTop: 3 },
  cmpNote: { marginTop: 13, fontSize: 12.5, color: MUTED, lineHeight: 1.6 },
  miniBtn: { background: "#161616", border: "1px solid #303030", color: "#e0e0e0", fontFamily: sans, fontSize: 12, fontWeight: 600, padding: "5px 10px", borderRadius: 7, cursor: "pointer" },
  cellIn: { width: "100%", minWidth: 88, background: "transparent", border: "1px solid transparent", borderRadius: 6, color: "#f2f2f2", fontFamily: sans, fontSize: 13.5, padding: "7px 8px", outline: "none" },
  cellNum: { width: 92, background: "transparent", border: "1px solid transparent", borderRadius: 6, color: "#f2f2f2", fontFamily: mono, fontSize: 13, padding: "7px 8px", outline: "none" },
  cellSel: { background: "#161616", border: "1px solid #303030", borderRadius: 7, color: "#e0e0e0", fontFamily: sans, fontSize: 13, padding: "6px 9px", outline: "none", cursor: "pointer" },
  cellInferred: { borderColor: "rgba(245,165,36,.6)", color: WARN },
  statusPill: { border: "none", fontFamily: mono, fontSize: 11.5, fontWeight: 700, padding: "5px 11px", borderRadius: 20, cursor: "pointer", textTransform: "uppercase", letterSpacing: ".04em" },
  pillActive: { background: "#f5f5f5", color: "#0a0a0a" },
  pillCand: { background: "transparent", color: "#b0b0b0", boxShadow: "inset 0 0 0 1px #444" },
  lockCell: { display: "grid", placeItems: "center", background: "transparent", border: "none", cursor: "pointer", padding: 5, borderRadius: 6 },
  rowDel: { display: "grid", placeItems: "center", background: "transparent", border: "none", color: DIM, cursor: "pointer", padding: 5, borderRadius: 6 },
  addRowBtn: { display: "inline-flex", alignItems: "center", gap: 6, background: "#161616", border: "1px solid #303030", color: "#e0e0e0", fontFamily: sans, fontSize: 13, fontWeight: 600, padding: "7px 12px", borderRadius: 9, cursor: "pointer" },
  micLive: { background: "rgba(248,81,73,.14)", borderColor: "rgba(248,81,73,.5)", color: BAD, animation: "livepulse 1.6s ease-in-out infinite" },
  empty: { padding: "24px 16px", textAlign: "center", fontSize: 13.5, color: MUTED, background: "#0a0a0a", border: "1px dashed " + BORDER, borderRadius: 10, lineHeight: 1.6 },
  sensGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 14 },
  sensCell: { background: "#0a0a0a", border: "1px solid " + BORDER, borderRadius: 10, padding: "12px 14px" },
  barSection: { margin: "4px 0 18px", display: "flex", flexDirection: "column", gap: 8 },
  barRow: { display: "grid", gridTemplateColumns: "310px 1fr 70px", alignItems: "center", gap: 12 },
  barName: { fontSize: 13, color: "#d0d0d0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  barTrack: { position: "relative", height: 22, background: "#161616", borderRadius: 7, overflow: "hidden" },
  barFill: { position: "absolute", inset: "0 auto 0 0", borderRadius: 7, transition: "width .45s cubic-bezier(.4,0,.2,1)" },
  barVal: { position: "absolute", right: 9, top: "50%", transform: "translateY(-50%)", fontFamily: mono, fontSize: 12, color: "#f2f2f2", fontWeight: 600 },
  barSvc: { fontFamily: mono, fontSize: 13, fontWeight: 600, textAlign: "right" },
  barLegend: { fontSize: 11.5, color: DIM, marginTop: 5 },

  roadGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(210px,1fr))", gap: 12 },
  roadCell: { background: "#0a0a0a", border: "1px solid " + BORDER, borderRadius: 10, padding: "13px 14px" },
  roadH: { fontSize: 13.5, fontWeight: 700, marginBottom: 6 },
  roadD: { fontSize: 12.5, color: MUTED, lineHeight: 1.55 },

  main: { flex: 1, display: "flex", minHeight: 0 },
  mapWrap: { flex: 1, position: "relative", borderRight: "1px solid " + BORDER, minWidth: 0, minHeight: 0 },
  mapWrapFull: { position: "fixed", inset: 0, zIndex: 45, borderRight: "none", background: "#0a0a0a" },
  fullBtn: { display: "inline-flex", alignItems: "center", gap: 6, background: "rgba(10,10,10,.8)", border: "1px solid #303030", color: "#e0e0e0", fontFamily: sans, fontSize: 13, fontWeight: 600, padding: "7px 12px", borderRadius: 9, cursor: "pointer", backdropFilter: "blur(6px)" },
  noData: { position: "absolute", inset: 0, zIndex: 6, display: "grid", placeItems: "center", textAlign: "center", background: "rgba(10,10,10,.85)", fontSize: 16, fontWeight: 600, lineHeight: 1.8 },
  mapChrome: { position: "absolute", top: 0, left: 0, right: 0, zIndex: 3, display: "flex", justifyContent: "space-between", alignItems: "center", padding: "13px 17px", pointerEvents: "none", gap: 10, flexWrap: "wrap" },
  mapTitle: { fontSize: 14, fontWeight: 600, background: "rgba(10,10,10,.8)", padding: "6px 11px", borderRadius: 8, backdropFilter: "blur(6px)" },
  addDemandBtn: { display: "inline-flex", alignItems: "center", gap: 6, background: "rgba(10,10,10,.8)", border: "1px solid #303030", color: "#e0e0e0", fontFamily: sans, fontSize: 13, fontWeight: 600, padding: "7px 12px", borderRadius: 9, cursor: "pointer", backdropFilter: "blur(6px)" },
  addDemandOn: { background: "#f5f5f5", borderColor: "#f5f5f5", color: "#0a0a0a" },
  flowToggle: { display: "flex", alignItems: "center", gap: 7, background: "rgba(10,10,10,.8)", padding: "6px 9px", borderRadius: 9, backdropFilter: "blur(6px)" },
  toggleLabel: { fontSize: 11.5, color: MUTED },
  toggleBtn: { border: "none", background: "transparent", color: "#b0b0b0", fontFamily: mono, fontSize: 12, padding: "4px 9px", borderRadius: 6, cursor: "pointer", textTransform: "capitalize" },
  toggleBtnOn: { background: "#2a2a2a", color: "#ffffff" },
  svg: { position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" },
  custLabel: { fill: "#909090", fontSize: 12, fontFamily: sans, textAnchor: "middle" },
  whLabel: { fontSize: 15, fontWeight: 700, fontFamily: sans, textAnchor: "middle" },
  whUtil: { fill: "#f2f2f2", fontSize: 12, fontFamily: mono, textAnchor: "middle", fontWeight: 600 },
  exitTag: { fill: EXIT, fontSize: 11.5, fontFamily: mono, fontWeight: 700, textAnchor: "middle", letterSpacing: ".06em" },
  lockTag: { fontSize: 13, textAnchor: "middle" },
  legend: { position: "absolute", bottom: 13, left: 17, right: 17, zIndex: 3, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", background: "rgba(10,10,10,.82)", padding: "8px 13px", borderRadius: 9, backdropFilter: "blur(6px)", border: "1px solid " + BORDER },
  legendSep: { width: 1, height: 15, background: "#333" },
  legendNote: { fontSize: 11.5, color: DIM },

  editor: { position: "absolute", top: 58, left: 17, zIndex: 5, width: 272, maxHeight: "calc(100% - 92px)", overflowY: "auto", background: "#121212", border: "1px solid #333", borderRadius: 13, padding: 15, boxShadow: "0 18px 50px rgba(0,0,0,.75)" },
  editorHead: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 },
  editorName: { display: "flex", alignItems: "center", gap: 7, fontWeight: 600, fontSize: 14.5 },
  editorRole: { fontSize: 12, color: MUTED, marginTop: 3 },
  editorClose: { background: "transparent", border: "none", color: MUTED, cursor: "pointer", padding: 2 },
  nameIn: { marginTop: 6, width: 190, background: "#0a0a0a", border: "1px solid #303030", borderRadius: 8, color: "#f2f2f2", fontFamily: sans, fontSize: 13.5, padding: "6px 9px", outline: "none" },
  editRow: { display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13, color: "#a8a8a8", padding: "7px 0", fontFamily: mono, borderTop: "1px solid " + BORDER_SOFT },
  sliderRow: { margin: "9px 0 7px" },
  sliderTop: { display: "flex", justifyContent: "space-between", fontSize: 13, color: "#a8a8a8", marginBottom: 8, fontFamily: mono },
  slider: { width: "100%" },
  expWarn: { display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, color: WARN, background: "rgba(245,165,36,.08)", border: "1px solid rgba(245,165,36,.32)", borderRadius: 8, padding: "7px 10px", margin: "5px 0 3px", lineHeight: 1.45, flexWrap: "wrap" },
  shrinkNote: { fontSize: 12, color: WARN, lineHeight: 1.5, margin: "5px 0 3px" },
  leaseNote: { fontSize: 11.5, color: DIM, lineHeight: 1.5, margin: "6px 0 2px" },
  dangerBtn: { width: "100%", marginTop: 11, padding: 9, background: "rgba(248,81,73,.09)", border: "1px solid rgba(248,81,73,.38)", color: BAD, borderRadius: 9, fontFamily: sans, fontSize: 13.5, fontWeight: 600, cursor: "pointer" },
  confirmBtn: { width: "100%", marginTop: 11, padding: 9, background: "rgba(63,185,80,.11)", border: "1px solid rgba(63,185,80,.42)", color: GOOD, borderRadius: 9, fontFamily: sans, fontSize: 13.5, fontWeight: 700, cursor: "pointer" },
  lockBtn: { width: "100%", marginTop: 7, padding: 9, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7, background: "transparent", border: "1px solid #333", color: MUTED, borderRadius: 9, fontFamily: sans, fontSize: 13, fontWeight: 600, cursor: "pointer" },
  lockBtnOn: { background: "#1f6feb1a", borderColor: "#1f6feb88", color: BLUE },
  candNote: { fontSize: 12.5, color: MUTED, marginTop: 9, lineHeight: 1.55 },

  copilot: { width: 400, minWidth: 400, display: "flex", flexDirection: "column", background: "#0c0c0c", minHeight: 0 },
  copilotHead: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 17px", borderBottom: "1px solid " + BORDER },
  copilotTitle: { display: "flex", alignItems: "center", gap: 8, fontWeight: 600, fontSize: 15.5 },
  copilotObj: { fontSize: 12.5, color: MUTED, fontFamily: mono },
  feed: { flex: 1, overflowY: "auto", padding: 15, display: "flex", flexDirection: "column", gap: 12, minHeight: 0 },
  userMsg: { alignSelf: "flex-end", maxWidth: "84%", background: "#f5f5f5", color: "#0a0a0a", padding: "9px 13px", borderRadius: "13px 13px 3px 13px", fontSize: 13.8, lineHeight: 1.45, fontWeight: 500 },
  aiNote: { alignSelf: "flex-start", maxWidth: "94%", color: "#a8a8a8", fontSize: 13.3, lineHeight: 1.55, fontStyle: "italic" },
  aiCard: { alignSelf: "flex-start", width: "100%", background: "#121212", border: "1px solid " + BORDER, borderRadius: 13, padding: 15 },
  aiCardHero: { border: "1px solid rgba(63,185,80,.45)", boxShadow: "0 0 30px rgba(63,185,80,.13)" },
  aiCardTitle: { display: "flex", alignItems: "center", gap: 7, fontWeight: 600, fontSize: 14, marginBottom: 10 },
  aiSubtitle: { fontSize: 12.5, color: MUTED, marginBottom: 10, marginTop: -4, lineHeight: 1.5 },
  aiLine: { fontSize: 13.3, color: "#cfcfcf", lineHeight: 1.6, marginBottom: 7 },
  aiCta: { display: "flex", alignItems: "center", gap: 5, fontSize: 12.8, color: "#ffffff", marginTop: 5, fontWeight: 500 },
  aiFoot: { fontSize: 12, color: DIM, marginTop: 9, lineHeight: 1.5, fontStyle: "italic" },
  aiSubhead: { fontSize: 11.5, color: MUTED, textTransform: "uppercase", letterSpacing: ".09em", marginTop: 14, marginBottom: 8, fontWeight: 700 },
  aiWatch: { display: "flex", alignItems: "flex-start", gap: 7, fontSize: 12.8, color: "#b4b4b4", lineHeight: 1.55, marginBottom: 6 },
  recBadge: { display: "inline-block", fontSize: 11, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: "#0a0a0a", background: "#f5f5f5", padding: "4px 10px", borderRadius: 6, marginBottom: 10 },
  recHead: { fontSize: 16, fontWeight: 700, lineHeight: 1.4, marginBottom: 12 },
  teBox: { marginTop: 11, background: "rgba(245,165,36,.06)", border: "1px solid rgba(245,165,36,.3)", borderRadius: 10, padding: "11px 13px" },
  teHead: { display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em", color: WARN, marginBottom: 9 },
  teGrid: { display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 9 },
  teLabel: { fontSize: 11, color: MUTED, marginBottom: 3 },
  teVal: { fontSize: 14.5, fontWeight: 700, fontFamily: mono },
  metricGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9, margin: "2px 0" },
  metricCell: { background: "#0a0a0a", border: "1px solid " + BORDER_SOFT, borderRadius: 9, padding: "9px 11px" },
  metricLabel: { fontSize: 11.5, color: MUTED, marginBottom: 4 },
  metricValue: { fontSize: 16.5, fontWeight: 600, fontFamily: mono },
  metricDelta: { fontSize: 12, fontFamily: mono, marginTop: 3, fontWeight: 500 },
  composer: { display: "flex", alignItems: "center", gap: 8, padding: "13px 15px 9px", borderTop: "1px solid " + BORDER, position: "relative" },
  micBtn: { display: "grid", placeItems: "center", width: 39, height: 39, minWidth: 39, background: "#161616", border: "1px solid #303030", color: "#b0b0b0", borderRadius: 10, cursor: "pointer" },
  input: { flex: 1, background: "#121212", border: "1px solid #303030", borderRadius: 10, padding: "10px 13px", color: "#f2f2f2", fontFamily: sans, fontSize: 14, outline: "none" },
  sendBtn: { display: "grid", placeItems: "center", width: 39, height: 39, minWidth: 39, background: "#f5f5f5", border: "none", color: "#0a0a0a", borderRadius: 10, cursor: "pointer" },
  suggestRow: { display: "flex", gap: 7, padding: "0 15px 15px", flexWrap: "wrap" },
  chip: { background: "#121212", border: "1px solid #303030", color: "#b0b0b0", fontSize: 12.5, fontFamily: sans, padding: "6px 11px", borderRadius: 20, cursor: "pointer" },

  kpiBar: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(210px,1fr))", borderTop: "1px solid " + BORDER, background: "#0e0e0e" },
  kpi: { padding: "13px 18px", borderRight: "1px solid " + BORDER },
  kpiTop: { display: "flex", alignItems: "center", gap: 7, marginBottom: 7 },
  kpiLabel: { fontSize: 11.5, color: MUTED, textTransform: "uppercase", letterSpacing: ".05em" },
  kpiValRow: { display: "flex", alignItems: "baseline", gap: 9, flexWrap: "wrap" },
  kpiValue: { fontSize: 26, fontWeight: 600, fontFamily: mono, letterSpacing: "-0.03em" },
  kpiDelta: { display: "inline-flex", alignItems: "center", gap: 3, fontSize: 13, fontFamily: mono, fontWeight: 600 },
  kpiSub: { fontSize: 11.5, color: DIM, marginTop: 4 },

  tutOverlay: { position: "fixed", inset: 0, zIndex: 60 },
  tutDim: { position: "fixed", inset: 0, background: "rgba(5,5,5,.74)", backdropFilter: "blur(1.5px)" },
  tutSpot: { position: "fixed", borderRadius: 14, border: "2px solid " + BLUE, boxShadow: "0 0 0 9999px rgba(5,5,5,.74), 0 0 34px rgba(121,184,255,.45)", pointerEvents: "none", transition: "top .3s cubic-bezier(.4,0,.2,1), left .3s cubic-bezier(.4,0,.2,1), width .3s cubic-bezier(.4,0,.2,1), height .3s cubic-bezier(.4,0,.2,1)" },
  tutCard: { position: "fixed", background: "#131820", border: "1px solid #2c3a4e", borderRadius: 15, padding: 19, boxShadow: "0 24px 64px rgba(0,0,0,.8)" },
  tutCardCenter: { top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 460 },
  tutTop: { display: "flex", alignItems: "center", gap: 11, marginBottom: 12 },
  tutStep: { fontSize: 11.5, fontFamily: mono, fontWeight: 700, color: "#0a1220", background: BLUE, borderRadius: 6, padding: "3px 8px" },
  tutDots: { display: "flex", gap: 5, flex: 1 },
  tutDot: { width: 7, height: 7, borderRadius: 7, background: "#2c3a4e" },
  tutDotOn: { background: BLUE, width: 18 },
  tutSkip: { background: "transparent", border: "none", color: "#7e8fa4", fontFamily: sans, fontSize: 12.5, cursor: "pointer" },
  tutTitle: { fontSize: 18, fontWeight: 700, marginBottom: 9, letterSpacing: "-0.01em" },
  tutBody: { fontSize: 13.8, color: "#c3d0e0", lineHeight: 1.65, marginBottom: 16 },
  tutActions: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 9 },
  tutBack: { display: "inline-flex", alignItems: "center", gap: 5, background: "transparent", border: "1px solid #2c3a4e", color: "#a8b8c8", fontFamily: sans, fontSize: 13, fontWeight: 600, padding: "8px 13px", borderRadius: 9, cursor: "pointer" },
  tutNext: { display: "inline-flex", alignItems: "center", gap: 6, background: BLUE, border: "none", color: "#0a1220", fontFamily: sans, fontSize: 13, fontWeight: 700, padding: "9px 15px", borderRadius: 9, cursor: "pointer" },
  tutGhost: { background: "transparent", border: "1px solid #2c3a4e", color: "#a8b8c8", fontFamily: sans, fontSize: 13, fontWeight: 600, padding: "9px 14px", borderRadius: 9, cursor: "pointer" },
};
