#!/usr/bin/env node
/* ============================================================================
 * CTBP1 ATLAS — falsifiable test harness  (BUILD-PROMPT §9)
 * ----------------------------------------------------------------------------
 * Runs the EXACT engine.js against the EXACT app-data.js and asserts GENERIC
 * INVARIANTS and DATA INTEGRITY only — never a predetermined biological
 * conclusion. The engine is free to disagree with the author's expectations
 * and still pass.
 *
 * The keystone is the anti-bias check: each area's membership is recomputed
 * STRAIGHT FROM THE RAW DATA (same EFO areas / disease-name regex / GenAge
 * bundle) and asserted equal to the engine's members, per gene. A hand-placed
 * gene — or any partner special-case in the engine — makes this diverge.
 *
 * FORBIDDEN here: any assertion pinning a named gene to a rank/area/type, or
 * requiring a specific disease or paper to appear. (We don't even pin the hub.)
 *
 * Usage:  node data/verify.js
 * ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');

// ---- load app-data.js + engine.js into a shared window-like global --------
const ROOT = path.resolve(__dirname, '..');
const sandbox = {};
function load(rel) { new Function('window', fs.readFileSync(path.join(ROOT, rel), 'utf8'))(sandbox); }
load('app-data.js');
load('engine.js');
const D = sandbox.CTBP1_DATA;
const E = sandbox.CTBP1_ENGINE;

// ---- tiny assertion harness ----------------------------------------------
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  → ' + detail : '')); }
}
function setEq(a, b) {
  const A = new Set(a), B = new Set(b);
  if (A.size !== B.size) return false;
  for (const x of A) if (!B.has(x)) return false;
  return true;
}
function diff(a, b) {
  const A = new Set(a), B = new Set(b);
  const only = (x, y) => [...x].filter(v => !y.has(v));
  return 'engine-only=[' + only(B, A) + '] data-only=[' + only(A, B) + ']';
}
const num = x => (typeof x === 'number' && isFinite(x)) ? x : 0;

const NODES = D.nodes;
const THEME_ORDER = E.THEME_ORDER;
const THEMES = E.THEMES;

// ===========================================================================
// INDEPENDENT RECOMPUTATION OF MEMBERSHIP  (does NOT call engine.classify)
// Uses the same rule DEFINITIONS the engine exposes (EFO keys, regexes, floor,
// GenAge bundle) but applies them itself, straight from the raw node fields.
// ===========================================================================
function top3(node) {
  return (node.dis || []).slice().sort((a, b) => num(b.s) - num(a.s)).slice(0, 3);
}
function floorOk(d, t3) {
  if (num(d.s) >= E.FLOOR_HARD) return true;
  return t3.indexOf(d) !== -1 && num(d.s) >= E.FLOOR_SOFT;
}
function efoSum(node, keys) {
  const a = node.areas || {}; let s = 0;
  keys.forEach(k => { s += num(a[k]); });
  return s;
}
function recomputeMembers(key) {
  const T = THEMES[key];
  return NODES.filter(node => {
    if (T.kind === 'ot') return efoSum(node, T.efo) > E.THRESH;
    if (T.kind === 'name') { const t3 = top3(node); return (node.dis || []).some(d => T.re.test(d.n) && floorOk(d, t3)); }
    if (T.kind === 'aging') return !!node.aging;
    return false;
  }).map(n => n.sym);
}
// engine's members for an area, read back from classify()
function engineMembers(key) {
  return NODES.filter(n => E.classify(n).flags.some(f => f.key === key)).map(n => n.sym);
}

console.log('\n=== Anti-bias core: membership == recomputation from raw data ===');
THEME_ORDER.forEach(key => {
  const a = recomputeMembers(key), b = engineMembers(key);
  check('membership[' + key + '] engine == independent data recomputation',
    setEq(a, b), diff(a, b));
});

// per-gene: displayed areas (engine flags) == recomputed membership set
let perGeneOk = true, perGeneBad = '';
NODES.forEach(node => {
  const eng = E.classify(node).flags.map(f => f.key);
  const dat = THEME_ORDER.filter(key => recomputeMembers(key).indexOf(node.sym) !== -1);
  if (!setEq(eng, dat)) { perGeneOk = false; perGeneBad = node.sym + ' ' + diff(dat, eng); }
});
check('per-gene displayed areas == per-gene data recomputation (no hand placement)', perGeneOk, perGeneBad);

// ===========================================================================
// AREA SET INTEGRITY
// ===========================================================================
console.log('\n=== Area set ===');
const want = ['oncology', 'metabolic', 'neurodegen', 'cns', 'neurodev', 'aging', 'immunity', 'cardiovascular', 'hematologic', 'eye'];
check('exactly the 10 chosen field keys exist', setEq(Object.keys(THEMES), want) && THEME_ORDER.length === want.length,
  '[' + Object.keys(THEMES).join(',') + ']');
check('THEME_ORDER is those keys in declared order', JSON.stringify(THEME_ORDER) === JSON.stringify(want));
check('exactly 5 SECTOR fields (constellation wedges)', THEME_ORDER.filter(k => THEMES[k].sector).length === 5);
const removed = ['cancer', 'neuro', 'autism', 'immune', 'cardio', 'developmental', 'development', 'metabolism'];
check('removed/renamed legacy area keys are gone', removed.every(k => !(k in THEMES)),
  removed.filter(k => k in THEMES).join(','));
check('aging area is kind "aging" (data-driven overlay), redox is NOT an area',
  THEMES.aging.kind === 'aging' && !('redox' in THEMES));
check('NAD/redox is a MECHANISM tag, not a disease area',
  E.MECH.some(m => m.key === 'redox') && THEME_ORDER.indexOf('redox') === -1);

// ===========================================================================
// FLAGS ARE MEMBERSHIPS, FULLY SOURCED
// ===========================================================================
console.log('\n=== Flags / sourcing ===');
const allFlags = [];
NODES.forEach(n => E.classify(n).flags.forEach(f => allFlags.push({ sym: n.sym, node: n, f })));

check('every flag carries {key,label,theme,source,sev,strength}',
  allFlags.every(x => x.f.key && x.f.label && x.f.theme && typeof x.f.source === 'string' && x.f.source.length > 0 &&
    x.f.sev >= 1 && x.f.sev <= 3 && typeof x.f.strength === 'number'));

check('sev == clamp(round(strength*3),1,3) for every flag',
  allFlags.every(x => x.f.sev === Math.max(1, Math.min(3, Math.round(x.f.strength * 3)))));

// every DISEASE-area flag cites a real OT disease from the gene's OWN associations
const diseaseFlags = allFlags.filter(x => x.f.kind === 'ot' || x.f.kind === 'name');
check('every disease-area flag cites a real OT disease from the gene\'s own associations',
  diseaseFlags.every(x => {
    if (!x.f.top || !x.f.top.n) return false;
    return (x.node.dis || []).some(d => d.n === x.f.top.n);
  }),
  (diseaseFlags.find(x => !x.f.top || !(x.node.dis || []).some(d => d.n === x.f.top.n)) || {}).sym);

// name-area citations must additionally match the area regex (real, on-theme)
const nameFlags = allFlags.filter(x => x.f.kind === 'name');
check('every NAME-area flag citation actually matches that area\'s disease regex',
  nameFlags.every(x => THEMES[x.f.key].re.test(x.f.top.n)));

// every aging flag cites GenAge/LongevityMap evidence (id or PubMed)
const agingFlags = allFlags.filter(x => x.f.kind === 'aging');
check('every aging flag cites GenAge/LongevityMap evidence (id or PMIDs)',
  agingFlags.length > 0 && agingFlags.every(x => x.f.top && (x.f.top.id || (x.f.top.pmids && x.f.top.pmids.length))));

// ===========================================================================
// FINDINGS = SUM OF MEMBERSHIPS
// ===========================================================================
console.log('\n=== Findings ===');
const findings = E.findings();
check('findings() row count == total membership count',
  findings.length === allFlags.length, findings.length + ' vs ' + allFlags.length);
check('every finding is sourced + scored',
  findings.every(r => r.source && typeof r.strength === 'number' && r.sev >= 1 && r.sev <= 3 && r.area && r.theme));
check('every finding belongs to one of the 6 areas',
  findings.every(r => THEME_ORDER.indexOf(r.area) !== -1));

// ===========================================================================
// STRUCTURAL INVARIANTS
// ===========================================================================
console.log('\n=== Structural ===');
const analysed = E.analyse();
check('analyse() returns ALL nodes', analysed.length === NODES.length);
check('analyse() is sorted by composite, non-increasing',
  analysed.every((p, i) => i === 0 || analysed[i - 1].composite >= p.composite - 1e-9));

const TYPES = ['Core complex', 'Physical interactor', 'Literature-linked', 'Functional neighbour', 'Associated'];
check('every node has a valid connection type', analysed.every(p => TYPES.indexOf(p.type) !== -1));

// every profiled gene is a DIRECT STRING neighbour of CTBP1 (no spurious indirect)
check('every profiled gene is a DIRECT STRING neighbour of CTBP1',
  NODES.every(n => { const pa = E.path(E.HUB, n.sym); return pa.direct === true && typeof pa.weight === 'number'; }));

// Core / Physical never from the DB channel alone
const physTypes = analysed.filter(p => p.type === 'Core complex' || p.type === 'Physical interactor');
check('Core / Physical never typed from the curated-DB channel alone',
  physTypes.every(p => num(p.node.s.e) >= 0.2 || p.intact.physical),
  (physTypes.find(p => !(num(p.node.s.e) >= 0.2 || p.intact.physical)) || {}).sym);

// composite weighting actually responds to weights (not a constant)
const wA = E.analyse({ phys: 1, lit: 0, ctx: 0 })[0].sym;
const wB = E.analyse({ phys: 0, lit: 1, ctx: 0 })[0].sym;
check('composite is weight-sensitive (phys-only and lit-only rank differently)', wA !== wB);

// ===========================================================================
// DATA INTEGRITY
// ===========================================================================
console.log('\n=== Data integrity ===');
check('no unresolved ID stubs: every node has a well-formed Ensembl + Entrez',
  NODES.every(n => /^ENSG\d+$/.test(n.ensembl || '') && /^\d+$/.test(String(n.entrez || ''))));

check('ClinVar present on every node and P/LP ≤ total',
  NODES.every(n => n.clinvar && typeof n.clinvar.total === 'number' && n.clinvar.plp <= n.clinvar.total));
check('CTBP1 hub ClinVar present and internally consistent (P/LP ≤ total)',
  D.gene.clinvar && D.gene.clinvar.plp <= D.gene.clinvar.total && typeof D.gene.clinvar.total === 'number');

// pathways: present on most nodes, none a broad top-level Reactome umbrella
const UMBRELLAS = new Set([
  'Signal Transduction', 'Metabolism', 'Metabolism of proteins', 'Metabolism of RNA',
  'Gene expression (Transcription)', 'Immune System', 'Disease', 'Developmental Biology',
  'Cell Cycle', 'Hemostasis', 'Programmed Cell Death', 'Transport of small molecules',
  'Vesicle-mediated transport', 'Cellular responses to stimuli', 'Cellular responses to stress',
  'Neuronal System', 'Muscle contraction', 'Extracellular matrix organization', 'DNA Repair',
  'DNA Replication', 'Chromatin organization', 'Cell-Cell communication', 'Autophagy',
  'Organelle biogenesis and maintenance', 'Reproduction', 'Circadian Clock', 'Metabolism of lipids'
]);
const withPathways = NODES.filter(n => (n.pathways || []).length > 0).length;
check('Reactome pathways present on most nodes (≥ 40)', withPathways >= 40, withPathways + ' nodes');
check('no node pathway list contains a broad Reactome umbrella',
  NODES.every(n => (n.pathways || []).every(p => !UMBRELLAS.has(p))),
  (NODES.find(n => (n.pathways || []).some(p => UMBRELLAS.has(p))) || {}).sym);

// ambiguous homograph aliases dropped from synonyms (§8 curated blocklist)
const BLOCK = new Set(['GLP1', 'P18', 'PC2', 'PH1', 'C21', 'DC42', 'IRA1']);
check('ambiguous homograph aliases dropped from every synonym list',
  NODES.every(n => (n.syn || []).every(s => !BLOCK.has(s))));

// co-mention tiers monotonic for every node: title ≤ abstract ≤ full-text
check('co-mention tiers monotonic for every node (title ≤ abs ≤ all)',
  NODES.every(n => { const c = n.comention || {}; return num(c.title) <= num(c.abs) && num(c.abs) <= num(c.all); }));

// references present on most nodes, all PMIDs well-formed
const withRefs = NODES.filter(n => (n.refs || []).length > 0).length;
check('co-mention references present on most nodes (≥ 60)', withRefs >= 60, withRefs + ' nodes');
check('every reference PMID is well-formed (1–8 digits)',
  NODES.every(n => (n.refs || []).every(r => /^\d{1,8}$/.test(String(r.pmid)))));
check('no truncated/junk function-evidence PMIDs',
  NODES.every(n => (n.funcRefs || []).every(r => /^\d{4,9}$/.test(String(r && r.pmid ? r.pmid : r)))));

// HPO phenotype counts consistent
const withPheno = NODES.filter(n => (n.phenotypes || []).length > 0).length;
check('HPO phenotypes present on a meaningful share of genes (≥ 25)', withPheno >= 25, withPheno + ' nodes');
check('phenoCount ≥ number of shown phenotype terms for every node',
  NODES.every(n => num(n.phenoCount) >= (n.phenotypes || []).length));
check('Entrez present wherever phenotypes exist (HPO is keyed by NCBIGene)',
  NODES.every(n => (n.phenotypes || []).length === 0 || /^\d+$/.test(String(n.entrez || ''))));

// meta sanity
check('meta declares the 6 STRING channel legend keys (e,d,t,a,p,n,f)',
  ['e', 'd', 't', 'a', 'p', 'n', 'f'].every(k => D.meta.channelLegend && D.meta.channelLegend[k]));
check('node count matches meta.neighborhood and is a substantial neighborhood (>= 200)',
  NODES.length === D.meta.neighborhood && NODES.length >= 200, NODES.length + ' nodes vs meta.neighborhood ' + D.meta.neighborhood);
check('meta.nodeCount == partners + 1 hub', D.meta.nodeCount === NODES.length + 1, D.meta.nodeCount + ' vs ' + (NODES.length + 1));

// ===========================================================================
console.log('\n' + (fail === 0 ? '✓ ' : '✗ ') + pass + '/' + (pass + fail) + ' checks passed' + (fail ? ('  (' + fail + ' FAILED)') : ''));
process.exit(fail === 0 ? 0 : 1);
