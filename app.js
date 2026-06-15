/* ============================================================================
 * CTBP1 ATLAS — app.js  (rendering, interaction, views, drawer, AI export)
 * ----------------------------------------------------------------------------
 * Reads window.CTBP1_DATA + window.CTBP1_ENGINE. No build step, no framework,
 * no network at load. Every value rendered carries a click-through to the live
 * source that validates it; the Europe PMC / ClinVar query builders here are
 * byte-identical to the data pipeline so the in-app counts reproduce exactly.
 * ==========================================================================*/
(function () {
  'use strict';
  var DATA = window.CTBP1_DATA, ENGINE = window.CTBP1_ENGINE;
  if (!DATA || !ENGINE) { document.body.innerHTML = '<p style="padding:40px">Failed to load data/engine.</p>'; return; }

  var GENE = DATA.gene, META = DATA.meta;
  var THEMES = ENGINE.THEMES, ORDER = ENGINE.THEME_ORDER, HUB = ENGINE.HUB;
  var STOP = {}; ENGINE.STOPLIST.forEach(function (s) { STOP[s] = 1; });

  // -------- state --------
  var W = { phys: 0.5, lit: 0.3, ctx: 0.2 };
  var state = {
    view: 'constellation', layout: 'sector', limit: 100,
    sel: null,                 // selected partner sym (gene dossier)
    lens: null,                // selected disease-lens key (lens dossier); null = hub
    active: {},                // which lenses are toggled on (for filter/recolour)
    findingsArea: null
  };
  ORDER.forEach(function (k) { state.active[k] = true; });

  var analysis = ENGINE.analyse(W);             // sorted profiles w/ composite
  var bySym = {}; analysis.forEach(function (p) { bySym[p.sym] = p; });

  // ======================================================================
  // helpers
  // ======================================================================
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function enc(s) { return encodeURIComponent(s); }
  function pct(x) { return Math.round(x * 100); }
  function f2(x) { return (Math.round(x * 100) / 100).toFixed(2); }
  function areaColor(k) { return k && THEMES[k] ? THEMES[k].theme : 'var(--on-surface-variant)'; }
  function reanalyse() { analysis = ENGINE.analyse(W); bySym = {}; analysis.forEach(function (p) { bySym[p.sym] = p; }); }

  // ---- source URL builders (provenance) ----
  var URLS = {
    string: function (sym) { return 'https://string-db.org/cgi/network?identifiers=CTBP1%0d' + enc(sym) + '&species=9606'; },
    ot: function (ens) { return 'https://platform.opentargets.org/target/' + enc(ens); },
    otAssoc: function (ens) { return 'https://platform.opentargets.org/target/' + enc(ens) + '/associations'; },
    otDisease: function (n) { return 'https://platform.opentargets.org/search?q=' + enc(n); },
    intact: function (sym) { return 'https://www.ebi.ac.uk/intact/search?query=CTBP1%20AND%20' + enc(sym); },
    ncbi: function (entrez) { return 'https://www.ncbi.nlm.nih.gov/gene/' + enc(entrez); },
    genecards: function (sym) { return 'https://www.genecards.org/cgi-bin/carddisp.pl?gene=' + enc(sym); },
    ensembl: function (ens) { return 'https://www.ensembl.org/Homo_sapiens/Gene/Summary?g=' + enc(ens); },
    uniprot: function (acc) { return 'https://www.uniprot.org/uniprotkb/' + enc(acc) + '/entry'; },
    alphafold: function (acc) { return 'https://alphafold.ebi.ac.uk/entry/' + enc(acc); },
    pdbe: function (sym) { return 'https://www.ebi.ac.uk/pdbe/entry/search/index?gene_name:' + enc(sym); },
    omim: function (mim) { return 'https://www.omim.org/entry/' + enc(mim); },
    pubmedId: function (pmid) { return 'https://pubmed.ncbi.nlm.nih.gov/' + enc(pmid) + '/'; },
    epmc: function (q) { return 'https://europepmc.org/search?query=' + enc(q); },
    reactome: function (name) { return 'https://reactome.org/content/query?q=' + enc(name) + '&species=Homo+sapiens'; },
    hpo: function (entrez) { return 'https://ontology.jax.org/api/network/annotation/NCBIGene:' + enc(entrez); },
    monarch: function (entrez) { return 'https://monarchinitiative.org/NCBIGene:' + enc(entrez); },
    // ClinVar — MUST mirror the pipeline's exact [Filter] tokens (§5)
    clinvarTotal: function (sym) { return 'https://www.ncbi.nlm.nih.gov/clinvar/?term=' + enc(sym + '[gene]'); },
    clinvarPLP: function (sym) { return 'https://www.ncbi.nlm.nih.gov/clinvar/?term=' + enc(sym + '[gene] AND (clinsig_pathogenic[Filter] OR clinsig_likely_path[Filter])'); },
    clinvarVUS: function (sym) { return 'https://www.ncbi.nlm.nih.gov/clinvar/?term=' + enc(sym + '[gene] AND clinsig_vus[Filter]'); }
  };

  // Europe PMC co-mention queries — byte-identical to data/evidence.py cm_queries().
  // clause = ("SYM" OR "syn1" OR ...) using the SAME synonyms the pipeline stored in node.syn.
  function clauseFor(node) {
    var terms = [node.sym].concat(node.syn || []);
    return '(' + terms.map(function (t) { return '"' + t + '"'; }).join(' OR ') + ')';
  }
  function cmQueries(node) {
    var c = clauseFor(node);
    return {
      title: '(TITLE:"CTBP1" NOT TITLE:"CTBP1-AS2" NOT TITLE:"CTBP1-DT" NOT TITLE:"CTBP1-AS1") AND TITLE:' + c,
      abs: '(TITLE:"CTBP1" OR ABSTRACT:"CTBP1") AND (TITLE:' + c + ' OR ABSTRACT:' + c + ') NOT "CTBP1-AS2" NOT "CTBP1-DT" NOT "CTBP1-AS1"',
      all: '"CTBP1" AND ' + c + ' NOT "CTBP1-AS2" NOT "CTBP1-DT" NOT "CTBP1-AS1"'
    };
  }

  // ======================================================================
  // glossary tooltips (instant, body-level — never the native title=)
  // ======================================================================
  var GLOSS = {
    'tip-lenses': ['Disease areas + aging overlay', 'Five editorial <b>disease areas</b> (oncology, metabolic, neurodegeneration, CNS, neurodevelopment) — the constellation sectors — plus an <b>Aging / longevity overlay</b>, which is not a disease but a curated GenAge ∪ LongevityMap dimension shown as a gold halo. Which areas to show is editorial; which genes belong is decided only by the data. Toggle a lens to recolour and filter.'],
    'tip-weights': ['Evidence weighting', 'The composite score is a weighted blend of <b>Physical</b> (STRING experiments + curated databases — text-mining is deliberately excluded), <b>Literature</b> (synonym-aware CTBP1 co-mention), and <b>Network</b> (partner–partner context). Sliders re-rank live.'],
    'tip-limit': ['Display limit', 'How many of the top-ranked interactors to draw in the visual views. The Table and Findings ignore this slider; focus a lens (left panel) to filter them by area.'],
    'tip-trace': ['Trace connection', 'Every profiled gene is a direct STRING neighbour of CTBP1, so the trace is the direct edge — no spurious indirect detour through the corepressor hub clique.'],
    'composite': ['Composite connection', '100 × weighted mean of physical, literature and network sub-scores. Re-weight with the Evidence sliders.'],
    'phys': ['Physical', 'clamp(experiments + 0.5·curated-DB). STRING combined score is excluded so a text-only pair never reads as physical.'],
    'lit': ['Literature', 'log-scaled CTBP1 co-mention. Ambiguous/housekeeping symbols are zeroed out of this score.'],
    'ctx': ['Network context', 'Summed partner↔partner STRING edge weight (the CTBP1 hub excluded), normalised across the neighbourhood.'],
    'intact': ['IntAct', 'Curated <i>experimental</i> interaction evidence: interaction type (incl. direct interaction), detection method, PMID and MI-score.'],
    'miscore': ['MI-score', 'IntAct molecular-interaction confidence score (0–1) aggregating evidence for the pair.'],
    'plp': ['ClinVar P/LP', 'Pathogenic + Likely-pathogenic variant records (NCBI ClinVar, exact clinsig_pathogenic / clinsig_likely_path filters).'],
    'vus': ['ClinVar VUS', 'Variants of uncertain significance (clinsig_vus filter).'],
    'comention': ['Co-mention tiers', 'Synonym-aware CTBP1 co-occurrence: in title, in title+abstract, and anywhere in full text. Each links to the exact Europe PMC query.'],
    'channels': ['STRING channels', 'Evidence channels behind the combined score: experiments, databases, text-mining, co-expression, fusion, neighborhood, co-occurrence.'],
    'reactome': ['Reactome pathways', 'Specific leaf pathways mapped from UniProt, not broad umbrella categories.'],
    'hpo': ['HPO phenotypes', 'Human Phenotype Ontology clinical terms annotated to the gene (keyed by NCBI Gene id).'],
    'mech': ['Mechanism tags', 'Function-text tags (redox, chromatin, co-repression, Wnt/EMT, synaptic, apoptosis). NAD⁺/redox is a mechanism — not the Aging area.'],
    'type': ['Connection type', 'Core complex / Physical interactor / Literature-linked / Functional neighbour / Associated — keyed off physical evidence, never the DB channel alone.']
  };
  var tip = $('tip'), tipHideT;
  function showTip(target, html) {
    clearTimeout(tipHideT);
    tip.innerHTML = html;
    tip.classList.add('on');
    var r = target.getBoundingClientRect();
    tip.style.left = '0px'; tip.style.top = '0px';
    var tr = tip.getBoundingClientRect();
    var x = r.left + r.width / 2 - tr.width / 2;
    var y = r.top - tr.height - 8;
    if (y < 6) y = r.bottom + 8;                       // flip below near top
    x = Math.max(6, Math.min(x, window.innerWidth - tr.width - 6));   // clamp
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }
  function hideTip() { tipHideT = setTimeout(function () { tip.classList.remove('on'); }, 40); }
  function wireGlossary(root) {
    (root || document).querySelectorAll('.info[data-tip]').forEach(function (i) {
      var g = GLOSS[i.getAttribute('data-tip')];
      if (!g) return;
      i.setAttribute('tabindex', '0');
      i.setAttribute('aria-label', g[0]);
      function show() { showTip(i, '<b>' + g[0] + '</b><br>' + g[1]); }
      i.addEventListener('mouseenter', show);
      i.addEventListener('focus', show);
      i.addEventListener('mouseleave', hideTip);
      i.addEventListener('blur', hideTip);
    });
  }
  function info(key) { return '<span class="info" data-tip="' + key + '">i</span>'; }

  // ======================================================================
  // clipboard (robust on file://)
  // ======================================================================
  function copyText(text, btn) {
    function ok() { if (btn) { var o = btn.innerHTML; btn.innerHTML = '✓ Copied'; setTimeout(function () { btn.innerHTML = o; }, 1400); } }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok, function () { legacy(); });
    } else legacy();
    function legacy() {
      var ta = el('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); ok(); } catch (e) {}
      document.body.removeChild(ta);
    }
  }

  // ======================================================================
  // header chips
  // ======================================================================
  function renderChips() {
    var ids = GENE.ids, c = $('geneChips');
    var chips = [
      ['Ensembl', ids.ensembl, URLS.ensembl(ids.ensembl)],
      ['Entrez', ids.entrez, URLS.ncbi(ids.entrez)],
      ['UniProt', ids.uniprot, URLS.uniprot(ids.uniprot)],
      ['STRING', (ids.string || '').split('.').pop(), 'https://string-db.org/network/' + enc(ids.string)]
    ];
    if (GENE.mim) chips.push(['OMIM', GENE.mim, URLS.omim(GENE.mim)]);
    c.innerHTML = chips.map(function (x) {
      return '<span class="chip">' + x[0] + ' <a href="' + x[2] + '" target="_blank" rel="noopener"><b>' + esc(x[1]) + '</b></a></span>';
    }).join('') + '<span class="chip">' + META.nodeCount + ' genes · ' + META.edgeCount + ' edges</span>';
    var bd = $('builtDate'); if (bd) bd.innerHTML = 'Built <b class="mono">' + esc(META.date) + '</b>';   // build/snapshot date (top right)
  }

  // ======================================================================
  // left panel controls
  // ======================================================================
  function renderLenses() {
    var box = $('lensList'); box.innerHTML = '';
    var exposure = {}; ENGINE.themeExposure(W).forEach(function (t) { exposure[t.key] = t.count; });
    function addLens(key) {
      var T = THEMES[key];
      var b = el('button', 'lens');
      b.setAttribute('aria-pressed', state.active[key] ? 'true' : 'false');
      b.innerHTML = '<span class="sw" style="background:' + T.theme + '"></span>' +
        '<span class="nm">' + esc(T.label) + '</span>' +
        '<span class="ct">' + (exposure[key] || 0) + '</span>';
      b.addEventListener('click', function () {
        // Click = FOCUS this area (show only it everywhere); click the sole-focused lens again = reset to all.
        var sole = state.active[key] && ORDER.every(function (k) { return (k === key) ? state.active[k] : !state.active[k]; });
        ORDER.forEach(function (k) { state.active[k] = sole ? true : (k === key); });
        renderLenses();                      // refresh every lens's pressed/dimmed state
        openLens(key); renderActiveView();   // open the dossier + re-filter the current view
      });
      box.appendChild(b);
    }
    // the FIVE disease areas (these are the constellation sectors) …
    ORDER.filter(function (k) { return k !== 'aging'; }).forEach(addLens);
    // … then the aging/longevity OVERLAY, set apart — it is not a disease area
    box.appendChild(el('div', 'lensdiv', 'Overlay'));
    addLens('aging');
  }

  function wireWeights() {
    [['wPhys', 'phys', 'wPhysV'], ['wLit', 'lit', 'wLitV'], ['wCtx', 'ctx', 'wCtxV']].forEach(function (x) {
      var inp = $(x[0]), lab = $(x[2]);
      inp.addEventListener('input', function () {
        W[x[1]] = parseFloat(inp.value); lab.textContent = f2(W[x[1]]);
        reanalyse(); renderInsight(); renderLenses(); renderActiveView(); renderDiscoveries(); refreshDrawer();
      });
    });
    var lim = $('displayLimit');
    lim.max = analysis.length; lim.value = analysis.length; state.limit = analysis.length; $('limV').textContent = analysis.length;   // scale to the actual neighborhood
    lim.addEventListener('input', function () { state.limit = parseInt(lim.value, 10); $('limV').textContent = state.limit; renderActiveView(); });
    $('layoutToggle').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-layout]'); if (!b) return;
      state.layout = b.getAttribute('data-layout');
      Array.prototype.forEach.call($('layoutToggle').children, function (c) { c.setAttribute('aria-pressed', c === b ? 'true' : 'false'); });
      if (state.view === 'constellation') drawConstellation();
    });
    var sel = $('traceSel');
    analysis.slice().sort(function (a, b) { return a.sym < b.sym ? -1 : 1; }).forEach(function (p) {
      var o = el('option'); o.value = p.sym; o.textContent = p.sym + ' — ' + p.name; sel.appendChild(o);
    });
    sel.addEventListener('change', function () { if (sel.value) { trace(sel.value); select(sel.value); } });
  }

  function trace(sym) {
    var p = bySym[sym]; if (!p) return;
    var pa = ENGINE.path(HUB, sym);
    $('traceOut').innerHTML = '<b style="color:var(--on-surface)">CTBP1 → ' + esc(sym) + '</b> · direct STRING edge, combined score <span class="num" style="color:var(--primary)">' + f2(pa.weight) + '</span>. Type: ' + esc(p.type) + '.';
  }

  // ======================================================================
  // insight bar
  // ======================================================================
  function renderInsight() {
    var src = $('insightSrc');
    if (src && !src.getAttribute('data-filled')) {           // static "what + sources" line — fill once
      var SRC = [['STRING v12', 'https://string-db.org'], ['Open Targets', 'https://platform.opentargets.org'],
        ['Europe PMC', 'https://europepmc.org'], ['IntAct', 'https://www.ebi.ac.uk/intact'],
        ['ClinVar', 'https://www.ncbi.nlm.nih.gov/clinvar'], ['HPO', 'https://hpo.jax.org'],
        ['Reactome', 'https://reactome.org'], ['GenAge / LongevityMap', 'https://genomics.senescence.info']];
      src.innerHTML = '<b style="color:var(--on-surface)">' + analysis.length + ' STRING interactors</b> of human CTBP1 (top-250 by combined score) — fully offline; every value links to its live source. Snapshot ' + esc(META.date) + '. Sources: ' +
        SRC.map(function (x) { return '<a href="' + x[1] + '" target="_blank" rel="noopener">' + esc(x[0]) + '</a>'; }).join(' · ') + '. <a href="https://github.com/HADDTS-Foundation/Unnamed-Project/blob/main/BUILD-PROMPT.md" target="_blank" rel="noopener">How it was built ↗</a>';
      src.setAttribute('data-filled', '1');
    }
  }

  // ======================================================================
  // view switching
  // ======================================================================
  function setView(v) {
    state.view = v;
    document.querySelectorAll('#viewTabs button').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-view') === v ? 'true' : 'false'); });
    ['constellation', 'network', 'table', 'findings'].forEach(function (k) { $('v-' + k).classList.toggle('on', k === v); });
    renderActiveView();
  }
  function renderActiveView() {
    var v = state.view;
    if (v === 'constellation') { sizeCanvas($('cz')); drawConstellation(); }
    else if (v === 'network') { sizeCanvas($('nz')); layoutNetwork(); drawNetwork(); }
    else if (v === 'table') renderTable();
    else if (v === 'findings') renderFindings();
    var allOn = ORDER.every(function (k) { return state.active[k]; });
    if (v === 'table') $('viewMeta').textContent = analysis.filter(lensOn).length + ' / ' + analysis.length + ' genes';
    else if (v === 'findings') $('viewMeta').textContent = ENGINE.findings(W).filter(function (r) { return allOn || state.active[r.area]; }).length + ' memberships';
    else $('viewMeta').textContent = displayed().length + ' / ' + analysis.length + ' drawn';
  }

  // active-lens filter for the visual views
  function lensOn(p) {
    var allOn = ORDER.every(function (k) { return state.active[k]; });
    if (allOn) return true;
    return ORDER.some(function (k) { return state.active[k] && p.themes[k] !== undefined; });
  }
  function displayed() { return analysis.slice(0, state.limit).filter(lensOn); }

  // ======================================================================
  // CONSTELLATION (canvas)
  // ======================================================================
  var DPR = Math.max(1, window.devicePixelRatio || 1);
  var hot = { constellation: [], network: [] };
  function sizeCanvas(cv) {
    var r = cv.parentElement.getBoundingClientRect();
    cv.width = Math.max(50, r.width) * DPR; cv.height = Math.max(50, r.height) * DPR;
    cv.style.width = r.width + 'px'; cv.style.height = r.height + 'px';
  }
  function nodeRadius(p) { return 4 + (p.composite / 100) * 7 + (p.type === 'Core complex' ? 2 : 0); }

  function drawConstellation() {
    var cv = $('cz'), g = cv.getContext('2d'); g.setTransform(DPR, 0, 0, DPR, 0, 0);
    var Wd = cv.width / DPR, Ht = cv.height / DPR; g.clearRect(0, 0, Wd, Ht);
    var cx = Wd / 2, cy = Ht / 2, R = Math.min(Wd, Ht) / 2 - 54;
    var list = displayed();
    hot.constellation = [];

    // The constellation maps GENES, placed by their dominant DISEASE area. Aging is
    // an overlay (never a dominant area), so it gets NO sector — it shows as a gold
    // longevity halo on the genes that are aging members (drawn with the nodes).
    var SECTORS = ORDER.filter(function (k) { return k !== 'aging'; });   // 5 disease sectors
    var sectors = {}; SECTORS.forEach(function (k, i) { sectors[k] = { a0: (i / SECTORS.length) * Math.PI * 2 - Math.PI / 2, idx: 0, n: 0 }; });
    list.forEach(function (p) { var k = p.dominant || 'oncology'; if (sectors[k]) sectors[k].n++; });

    // sector backdrops + labels
    if (state.layout === 'sector') {
      SECTORS.forEach(function (k, i) {
        var a0 = (i / SECTORS.length) * Math.PI * 2 - Math.PI / 2, a1 = ((i + 1) / SECTORS.length) * Math.PI * 2 - Math.PI / 2;
        g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, R + 30, a0, a1); g.closePath();
        g.fillStyle = hexA(THEMES[k].theme, 0.045); g.fill();
        var am = (a0 + a1) / 2; g.fillStyle = hexA(THEMES[k].theme, 0.85);
        g.font = '600 10px Inter'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(THEMES[k].label.toUpperCase().replace(/ \(.*\)/, ''), cx + Math.cos(am) * (R + 16), cy + Math.sin(am) * (R + 16));
      });
    }
    // hub edges to displayed nodes (faint)
    var pos = {};
    list.forEach(function (p, i) {
      var ang, rad = R * (1 - 0.72 * (p.composite / 100));    // stronger → closer to hub
      if (state.layout === 'sector') {
        var s = sectors[p.dominant || 'oncology'];
        var a0 = s.a0, span = (Math.PI * 2 / SECTORS.length);
        ang = a0 + span * ((s.idx + 0.5) / Math.max(1, s.n)); s.idx++;
      } else {
        ang = (i / list.length) * Math.PI * 2 - Math.PI / 2;
      }
      pos[p.sym] = { x: cx + Math.cos(ang) * rad, y: cy + Math.sin(ang) * rad, p: p };
    });
    g.lineWidth = 1;
    list.forEach(function (p) {
      var q = pos[p.sym]; g.strokeStyle = hexA(areaSolid(p.dominant), 0.10 + 0.25 * (p.composite / 100));
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(q.x, q.y); g.stroke();
    });
    // nodes
    list.forEach(function (p) {
      var q = pos[p.sym], r = nodeRadius(p), col = areaSolid(p.dominant);
      var strong = p.flags.some(function (fl) { return fl.sev >= 3; });
      if (strong) { var pulse = 0.5 + 0.5 * Math.sin(clock / 380); g.beginPath(); g.arc(q.x, q.y, r + 4 + pulse * 3, 0, 7); g.fillStyle = hexA(col, 0.10 * pulse); g.fill(); }
      if (p.themes.aging !== undefined) {   // aging overlay: soft gold longevity halo (gold now denotes aging only)
        var ha = g.createRadialGradient(q.x, q.y, r * 0.5, q.x, q.y, r + 11);
        ha.addColorStop(0, hexA('#c8b560', 0.5)); ha.addColorStop(1, hexA('#c8b560', 0));
        g.beginPath(); g.arc(q.x, q.y, r + 11, 0, 7); g.fillStyle = ha; g.fill();
      }
      g.beginPath(); g.arc(q.x, q.y, r, 0, 7); g.fillStyle = col; g.fill();
      if (state.sel === p.sym) { g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke(); }
      hot.constellation.push({ sym: p.sym, x: q.x, y: q.y, r: r + 3 });
    });
    // hub
    g.beginPath(); g.arc(cx, cy, 15, 0, 7); g.fillStyle = '#0f131e'; g.fill(); g.lineWidth = 2.5; g.strokeStyle = '#4ea8ff'; g.stroke();
    g.fillStyle = '#e7eefb'; g.font = '700 11px ' + MONO; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('CTBP1', cx, cy);
    renderConstLegend();
  }
  var MONO = "ui-monospace,Menlo,monospace";
  function renderConstLegend() {
    var L = $('czLegend');
    // 5 disease sectors place genes; aging is a gene OVERLAY (gold halo), not a sector
    L.innerHTML = ORDER.filter(function (k) { return k !== 'aging'; }).map(function (k) {
      return '<div class="row"><span class="sw" style="background:' + THEMES[k].theme + '"></span>' + esc(THEMES[k].label.replace(/ \(.*\)/, '')) + '</div>';
    }).join('') +
      '<div class="row" style="margin-top:3px"><span class="halo"></span>aging / longevity (overlay)</div>';
  }
  function areaSolid(k) { return k && THEMES[k] ? THEMES[k].theme : '#5a6a8a'; }

  // hex + alpha → rgba
  function hexA(hex, a) {
    hex = (hex || '#888').replace('#', ''); if (hex.length === 3) hex = hex.split('').map(function (c) { return c + c; }).join('');
    var n = parseInt(hex, 16); return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  // ======================================================================
  // NETWORK (canvas, lightweight force layout)
  // ======================================================================
  var netPos = {}, netReady = false;
  function layoutNetwork() {
    var list = displayed(); var n = list.length;
    var cv = $('nz'), Wd = cv.width / DPR, Ht = cv.height / DPR;
    var idx = {}; list.forEach(function (p, i) { idx[p.sym] = i; });
    var P = list.map(function (p, i) {
      var a = (i / n) * Math.PI * 2; return { sym: p.sym, x: Wd / 2 + Math.cos(a) * 160 + (i % 7 - 3) * 6, y: Ht / 2 + Math.sin(a) * 160 + (i % 5 - 2) * 6, vx: 0, vy: 0, p: p };
    });
    var pmap = {}; P.forEach(function (q) { pmap[q.sym] = q; });
    var edges = DATA.edges.filter(function (e) { return pmap[e.a] && pmap[e.b]; });
    for (var it = 0; it < 220; it++) {
      var k = 0.0009 * (1 - it / 260);
      for (var i = 0; i < P.length; i++) {
        var a = P[i];
        for (var j = i + 1; j < P.length; j++) {
          var b = P[j], dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy + 0.01, d = Math.sqrt(d2);
          var f = 520 / d2; var ux = dx / d, uy = dy / d; a.vx += ux * f; a.vy += uy * f; b.vx -= ux * f; b.vy -= uy * f;
        }
        // gravity to centre
        a.vx += (Wd / 2 - a.x) * 0.0016; a.vy += (Ht / 2 - a.y) * 0.0016;
      }
      edges.forEach(function (e) {
        var a = pmap[e.a], b = pmap[e.b], dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) + 0.01;
        var target = 60 + (1 - e.s) * 80, f = (d - target) * 0.01 * e.s; var ux = dx / d, uy = dy / d;
        a.vx += ux * f; a.vy += uy * f; b.vx -= ux * f; b.vy -= uy * f;
      });
      P.forEach(function (q) { q.x += Math.max(-6, Math.min(6, q.vx)); q.y += Math.max(-6, Math.min(6, q.vy)); q.vx *= 0.86; q.vy *= 0.86; q.x = Math.max(20, Math.min(Wd - 20, q.x)); q.y = Math.max(20, Math.min(Ht - 20, q.y)); });
    }
    netPos = pmap; netReady = true;
  }
  function drawNetwork() {
    if (!netReady) layoutNetwork();
    var cv = $('nz'), g = cv.getContext('2d'); g.setTransform(DPR, 0, 0, DPR, 0, 0);
    var Wd = cv.width / DPR, Ht = cv.height / DPR; g.clearRect(0, 0, Wd, Ht);
    hot.network = [];
    var edges = DATA.edges.filter(function (e) { return netPos[e.a] && netPos[e.b]; });
    edges.forEach(function (e) { var a = netPos[e.a], b = netPos[e.b]; g.strokeStyle = hexA('#27395f', 0.18 + e.s * 0.5); g.lineWidth = 0.4 + e.s * 1.4; g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); });
    Object.keys(netPos).forEach(function (sym) {
      var q = netPos[sym], p = q.p, r = nodeRadius(p), col = areaSolid(p.dominant);
      if (p.themes.aging !== undefined) {   // aging overlay (gold halo), consistent with the constellation
        var ha = g.createRadialGradient(q.x, q.y, r * 0.5, q.x, q.y, r + 10);
        ha.addColorStop(0, hexA('#c8b560', 0.5)); ha.addColorStop(1, hexA('#c8b560', 0));
        g.beginPath(); g.arc(q.x, q.y, r + 10, 0, 7); g.fillStyle = ha; g.fill();
      }
      g.beginPath(); g.arc(q.x, q.y, r, 0, 7); g.fillStyle = col; g.fill();
      if (state.sel === sym) { g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke(); }
      hot.network.push({ sym: sym, x: q.x, y: q.y, r: r + 3 });
    });
  }

  // canvas interaction (hover tooltip + click select)
  function wireCanvas(cv, which) {
    cv.addEventListener('mousemove', function (e) {
      var r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      var hitNode = pick(which, mx, my);
      if (hitNode) {
        var p = bySym[hitNode.sym]; cv.style.cursor = 'pointer';
        var aging = p.themes.aging !== undefined ? ' · <span style="color:#c8b560">aging-linked</span>' : '';
        showTip(makePoint(e.clientX, e.clientY), '<b>' + esc(p.sym) + '</b> · ' + esc(p.type) + '<br>composite <span class="num">' + p.composite.toFixed(0) + '</span>/100 · ' + (p.dominant ? esc(THEMES[p.dominant].label.replace(/ \(.*\)/, '')) : 'no area') + aging);
      } else { cv.style.cursor = 'default'; hideTip(); }
    });
    cv.addEventListener('mouseleave', hideTip);
    cv.addEventListener('click', function (e) {
      var r = cv.getBoundingClientRect(), hit = pick(which, e.clientX - r.left, e.clientY - r.top);
      if (hit) select(hit.sym);
    });
  }
  function pick(which, mx, my) {
    var arr = hot[which], best = null, bd = 1e9;
    for (var i = 0; i < arr.length; i++) { var dx = arr[i].x - mx, dy = arr[i].y - my, d = dx * dx + dy * dy; if (d < arr[i].r * arr[i].r && d < bd) { bd = d; best = arr[i]; } }
    return best;
  }
  function makePoint(x, y) { return { getBoundingClientRect: function () { return { left: x, top: y, right: x, bottom: y, width: 0, height: 0 }; } }; }

  // ======================================================================
  // TABLE
  // ======================================================================
  var tableSort = { key: 'composite', dir: -1 };
  var COLS = [
    { k: 'rank', t: '#', num: true, get: function (p) { return p.rank; } },
    { k: 'sym', t: 'Gene', get: function (p) { return p.sym; } },
    { k: 'type', t: 'Type', get: function (p) { return p.type; } },
    { k: 'composite', t: 'Composite', num: true, get: function (p) { return p.composite; } },
    { k: 'phys', t: 'Phys', num: true, get: function (p) { return p.phys; } },
    { k: 'lit', t: 'Lit', num: true, get: function (p) { return p.lit; } },
    { k: 'ctx', t: 'Net', num: true, get: function (p) { return p.ctx; } },
    { k: 'areas', t: 'Areas', get: function (p) { return p.flags.length; } },
    { k: 'comention', t: 'Co-mentions', num: true, get: function (p) { return (p.node.comention || {}).all || 0; } },
    { k: 'plp', t: 'ClinVar P/LP', num: true, get: function (p) { return (p.node.clinvar || {}).plp || 0; } }
  ];
  function renderTable() {
    var thead = $('tbl').querySelector('thead'), tbody = $('tbl').querySelector('tbody');
    thead.innerHTML = '<tr>' + COLS.map(function (c) {
      var on = tableSort.key === c.k; return '<th data-k="' + c.k + '"' + (on ? ' aria-sort="x"' : '') + '>' + c.t + '<span class="ar">' + (on ? (tableSort.dir < 0 ? '▼' : '▲') : '▼') + '</span></th>';
    }).join('') + '</tr>';
    thead.querySelectorAll('th').forEach(function (th) {
      th.addEventListener('click', function () { var k = th.getAttribute('data-k'); if (tableSort.key === k) tableSort.dir *= -1; else { tableSort.key = k; tableSort.dir = (k === 'sym' || k === 'type') ? 1 : -1; } renderTable(); });
    });
    var col = COLS.filter(function (c) { return c.k === tableSort.key; })[0];
    var rows = analysis.filter(lensOn).sort(function (a, b) { var va = col.get(a), vb = col.get(b); if (typeof va === 'string') return va < vb ? -tableSort.dir : va > vb ? tableSort.dir : 0; return (va - vb) * tableSort.dir; });
    tbody.innerHTML = '';
    rows.forEach(function (p) {
      var dots = p.flags.map(function (fl) { return '<span class="adot" style="background:' + fl.theme + '" title="' + esc(fl.label) + '"></span>'; }).join('');
      var tr = el('tr'); if (p.sym === state.sel) tr.className = 'sel';
      tr.innerHTML =
        '<td class="num muted">' + p.rank + '</td>' +
        '<td><span class="sym">' + esc(p.sym) + '</span>' + (p.stop ? ' <span class="muted" style="font-size:10px">⚠</span>' : '') + '<div class="typ">' + esc(p.name).slice(0, 28) + '</div></td>' +
        '<td><span class="typ">' + esc(p.type) + '</span></td>' +
        '<td class="num">' + bar(p.composite / 100) + ' ' + p.composite.toFixed(0) + '</td>' +
        '<td class="num muted">' + f2(p.phys) + '</td>' +
        '<td class="num muted">' + f2(p.lit) + '</td>' +
        '<td class="num muted">' + f2(p.ctx) + '</td>' +
        '<td>' + (dots || '<span class="muted">—</span>') + '</td>' +
        '<td class="num muted">' + ((p.node.comention || {}).all || 0) + '</td>' +
        '<td class="num muted">' + ((p.node.clinvar || {}).plp || 0) + '</td>';
      tr.addEventListener('click', function () { select(p.sym); });
      tbody.appendChild(tr);
    });
  }
  function bar(frac) { return '<span class="bar" style="width:54px"><i style="width:' + Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%"></i></span>'; }

  // ======================================================================
  // FINDINGS
  // ======================================================================
  function renderFindings() {
    var fb = $('findingsFilter');
    var allOn = ORDER.every(function (k) { return state.active[k]; });          // same global filter as the left lenses
    fb.innerHTML = '<button class="fchip" data-a="" aria-pressed="' + (allOn ? 'true' : 'false') + '">All areas</button>' +
      ORDER.map(function (k) { return '<button class="fchip" data-a="' + k + '" aria-pressed="' + (!allOn && state.active[k] ? 'true' : 'false') + '"><span class="sw" style="background:' + THEMES[k].theme + '"></span>' + esc(THEMES[k].label.replace(/ \(.*\)/, '')) + '</button>'; }).join('');
    fb.querySelectorAll('.fchip').forEach(function (c) { c.addEventListener('click', function () {
      var a = c.getAttribute('data-a');
      ORDER.forEach(function (k) { state.active[k] = a ? (k === a) : true; });  // a chip focuses that area; "All areas" resets
      renderLenses(); renderFindings();                                         // keep the left lens panel in sync
    }); });

    var rows = ENGINE.findings(W).filter(function (r) { return allOn || state.active[r.area]; });
    var wrap = $('findingsWrap'); wrap.innerHTML = '';
    rows.forEach(function (r) {
      var node = bySym[r.sym].node;
      var d = el('div', 'finding');
      d.innerHTML =
        '<div class="g">' + esc(r.sym) + '<small>' + esc(r.name) + '</small></div>' +
        '<div class="ar" style="color:' + r.theme + '"><span class="sw" style="display:inline-block;width:9px;height:9px;border-radius:50%;background:' + r.theme + '"></span>' + esc(r.label.replace(/ \(.*\)/, '')) + '</div>' +
        '<div class="src">' + esc(r.source) + (r.top && r.top.n ? ' · e.g. <b style="color:var(--on-surface)">' + esc(r.top.n) + '</b> (' + f2(r.top.s) + ')' : '') + '</div>' +
        '<div class="sev">' + sevBars(r.sev, r.theme) + '</div>';
      d.addEventListener('click', function () { select(r.sym); });
      wrap.appendChild(d);
    });
    if (!rows.length) wrap.innerHTML = '<div class="empty">No memberships in this area.</div>';
  }
  function sevBars(sev, col) { var s = ''; for (var i = 1; i <= 3; i++) s += '<i style="background:' + (i <= sev ? col : 'var(--sc-high)') + '"></i>'; return s; }

  // ======================================================================
  // RIGHT DRAWER — three modes
  // ======================================================================
  function select(sym) { state.sel = sym; state.lens = null; renderDrawer(); if (state.view === 'table') renderTable(); if (state.view === 'constellation') drawConstellation(); if (state.view === 'network') drawNetwork(); }
  function openLens(key) { state.lens = key; state.sel = null; renderDrawer(); }
  function refreshDrawer() { renderDrawer(); }
  function renderDrawer() {
    var d = $('drawer');
    if (state.sel && bySym[state.sel]) d.innerHTML = '', d.appendChild(geneDossier(bySym[state.sel]));
    else if (state.lens) d.innerHTML = '', d.appendChild(lensDossier(state.lens));
    else d.innerHTML = '', d.appendChild(hubDossier());
    wireGlossary(d);
    d.querySelectorAll('button.copyai').forEach(function (b) { b.addEventListener('click', function () { copyText(b.closest('.aiblock').querySelector('pre').textContent, b); }); });
    d.querySelectorAll('a.gsel').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); var lens = a.getAttribute('data-lens'); if (lens) openLens(lens); else select(a.getAttribute('data-sym')); }); });
  }

  function sec(label, tipKey, bodyNode) {
    var s = el('div', 'dsec');
    s.appendChild(el('div', 'label-caps', esc(label) + (tipKey ? ' ' + info(tipKey) : '')));
    if (bodyNode) s.appendChild(bodyNode);
    return s;
  }
  function meter(name, tipKey, val, col) {
    return '<div class="meter"><div class="t"><span>' + esc(name) + ' ' + (tipKey ? info(tipKey) : '') + '</span><span class="vl">' + f2(val) + '</span></div><div class="mtrack"><i style="width:' + pct(val) + '%;background:' + (col || 'var(--primary)') + '"></i></div></div>';
  }

  function geneDossier(p) {
    var node = p.node, col = areaSolid(p.dominant);
    var box = el('div');
    // head
    var head = el('div', 'dhead');
    head.innerHTML = '<div class="tag" style="background:' + col + '"></div><div style="flex:1"><h2>' + esc(p.sym) + '</h2><div class="nm">' + esc(p.name) + '</div><div class="rk">rank #' + p.rank + ' · ' + esc(p.type) + ' ' + info('type') + '</div></div>';
    box.appendChild(head);
    if (p.stop) box.appendChild(el('div', 'caveat', '⚠ <div>Ambiguous / house-keeping symbol — its literature co-mention is unreliable and is excluded from the literature score.</div>'));

    // connection meters
    var conn = ENGINE.connection(p, W);
    box.appendChild(sec('Connection', 'composite', el('div', null,
      '<div class="meter"><div class="t"><span>Composite ' + info('composite') + '</span><span class="vl">' + conn.composite.toFixed(0) + ' / 100</span></div><div class="mtrack"><i style="width:' + conn.composite + '%;background:' + col + '"></i></div></div>' +
      meter('Physical', 'phys', p.phys) + meter('Literature', 'lit', p.lit) + meter('Network context', 'ctx', p.ctx, 'var(--tertiary)'))));

    // STRING channels
    var s = node.s, chans = [['e', 'Experiments'], ['d', 'Databases'], ['t', 'Text-mining'], ['a', 'Co-expression'], ['p', 'Fusion'], ['n', 'Neighborhood'], ['f', 'Co-occurrence']];
    var cb = el('div'); cb.innerHTML = '<div class="muted" style="font-size:11px;margin-bottom:6px">Combined <b class="num" style="color:var(--on-surface)">' + f2(s.c) + '</b> · physical uses experiments + databases only</div>' +
      chans.map(function (c) { return '<div class="chan"><span class="nm">' + c[1] + '</span>' + bar(s[c[0]] || 0) + '<span class="vl">' + f2(s[c[0]] || 0) + '</span></div>'; }).join('') +
      '<div class="links" style="margin-top:8px"><a href="' + URLS.string(p.sym) + '" target="_blank" rel="noopener">STRING network ↗</a></div>';
    box.appendChild(sec('STRING channels', 'channels', cb));

    // IntAct
    if (node.intact) {
      var ia = node.intact;
      var ib = el('div'); ib.innerHTML =
        '<div class="kv"><span class="k">Type</span><span class="v">' + esc(ia.type) + (ia.direct ? ' · <b style="color:var(--tertiary)">direct</b>' : '') + '</span></div>' +
        '<div class="kv"><span class="k">MI-score ' + info('miscore') + '</span><span class="v mono">' + f2(ia.miscore) + '</span></div>' +
        '<div class="kv"><span class="k">Records</span><span class="v mono">' + ia.count + '</span></div>' +
        (ia.methods && ia.methods.length ? '<div class="kv"><span class="k">Methods</span><span class="v" style="font-size:11px">' + esc(ia.methods.join(', ')) + '</span></div>' : '') +
        (ia.pmids && ia.pmids.length ? '<div class="kv"><span class="k">PMIDs</span><span class="v">' + ia.pmids.map(function (x) { return '<a href="' + URLS.pubmedId(x) + '" target="_blank" rel="noopener" class="mono">' + esc(x) + '</a>'; }).join(' ') + '</span></div>' : '') +
        '<div class="links" style="margin-top:7px"><a href="' + URLS.intact(p.sym) + '" target="_blank" rel="noopener">IntAct ↗</a></div>';
      box.appendChild(sec('IntAct experimental evidence', 'intact', ib));
    }

    // disease areas (flags)
    if (p.flags.length) {
      var fb = el('div');
      p.flags.forEach(function (fl) {
        var ex = '';
        if (fl.kind === 'aging') ex = fl.top ? (fl.top.why ? '<div class="ex">' + esc(fl.top.why) + '</div>' : '') : '';
        else if (fl.matched && fl.matches && fl.matches.length) ex = '<div class="ex">e.g. ' + fl.matches.slice(0, 2).map(function (m) { return '<a href="' + URLS.otDisease(m.n) + '" target="_blank" rel="noopener"><b>' + esc(m.n) + '</b></a> (' + f2(m.s) + ')'; }).join(', ') + '</div>';
        else if (fl.top && fl.top.n) ex = '<div class="ex muted">membership via OT therapeutic-area aggregate; top association <b>' + esc(fl.top.n) + '</b> (' + f2(fl.top.s) + ')</div>';
        fb.appendChild(el('div', 'flag', (function () {
          var e = '<div class="b"><div class="h" style="color:' + fl.theme + '">' + esc(fl.label) + '<span class="sev">' + sevBars(fl.sev, fl.theme) + '</span></div><div class="src">' + esc(fl.source) + '</div>' + ex + '</div>';
          return e;
        })()));
        fb.lastChild.style.borderLeftColor = fl.theme;
      });
      box.appendChild(sec('Area memberships', null, fb));
    }

    // top disease associations
    if ((node.dis || []).length) {
      var db = el('div');
      node.dis.slice(0, 8).forEach(function (dd) {
        db.appendChild(el('div', 'disrow', '<span class="nm"><a href="' + URLS.otDisease(dd.n) + '" target="_blank" rel="noopener">' + esc(dd.n) + '</a></span>' + bar(dd.s) + '<span class="vl">' + f2(dd.s) + '</span>'));
      });
      db.innerHTML += '<div class="links" style="margin-top:7px"><a href="' + URLS.otAssoc(node.ensembl) + '" target="_blank" rel="noopener">Open Targets associations ↗</a></div>';
      box.appendChild(sec('Top disease associations (Open Targets)', null, db));
    }

    // literature (tiered co-mention + papers)
    var q = cmQueries(node), cm = node.comention || { title: 0, abs: 0, all: 0 };
    var lb = el('div');
    lb.innerHTML =
      litRow('In title', cm.title, q.title) + litRow('Title + abstract', cm.abs, q.abs) + litRow('Full text', cm.all, q.all) +
      (node.syn && node.syn.length ? '<div class="muted" style="font-size:11px;margin:6px 0">synonyms searched: <span class="mono">' + esc(node.syn.join(', ')) + '</span></div>' : '');
    (node.refs || []).forEach(function (r) {
      lb.appendChild(el('div', 'paper', '<div class="t"><a href="' + URLS.pubmedId(r.pmid) + '" target="_blank" rel="noopener">' + esc(r.t || ('PMID ' + r.pmid)) + '</a></div><div class="m">' + esc([r.a, r.j, r.y].filter(Boolean).join(' · ')) + (r.c ? ' · ' + r.c + ' cites' : '') + '</div>'));
    });
    box.appendChild(sec('Literature co-mention', 'comention', lb));

    // clinical variants
    var cv = node.clinvar;
    if (cv) {
      var vb = el('div'); vb.innerHTML =
        '<div class="kv"><span class="k">Pathogenic / Likely-path ' + info('plp') + '</span><span class="v"><a class="mono" href="' + URLS.clinvarPLP(p.sym) + '" target="_blank" rel="noopener">' + cv.plp + '</a></span></div>' +
        '<div class="kv"><span class="k">Uncertain (VUS) ' + info('vus') + '</span><span class="v"><a class="mono" href="' + URLS.clinvarVUS(p.sym) + '" target="_blank" rel="noopener">' + cv.vus + '</a></span></div>' +
        '<div class="kv"><span class="k">Total records</span><span class="v"><a class="mono" href="' + URLS.clinvarTotal(p.sym) + '" target="_blank" rel="noopener">' + cv.total + '</a></span></div>';
      box.appendChild(sec('Clinical variants (ClinVar)', null, vb));
    }

    // phenotypes (HPO)
    if ((node.phenotypes || []).length) {
      var pb = el('div');
      pb.innerHTML = '<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:7px">' + node.phenotypes.slice(0, 12).map(function (t) { return '<span class="chip">' + esc(t) + '</span>'; }).join('') + '</div>' +
        '<div class="muted" style="font-size:11px">' + node.phenoCount + ' terms total</div>' +
        '<div class="links" style="margin-top:7px"><a href="' + URLS.hpo(node.entrez) + '" target="_blank" rel="noopener">HPO API ↗</a><a href="' + URLS.monarch(node.entrez) + '" target="_blank" rel="noopener">Monarch ↗</a></div>';
      box.appendChild(sec('Clinical phenotypes (HPO)', 'hpo', pb));
    }

    // pathways (Reactome)
    if ((node.pathways || []).length) {
      var rb = el('div');
      rb.innerHTML = node.pathways.slice(0, 10).map(function (n) { return '<div class="disrow"><span class="nm"><a href="' + URLS.reactome(n) + '" target="_blank" rel="noopener">' + esc(n) + '</a></span></div>'; }).join('');
      box.appendChild(sec('Pathways (Reactome)', 'reactome', rb));
    }

    // mechanism tags
    if (p.mech.length) {
      var mb = el('div', null, '<div style="display:flex;flex-wrap:wrap;gap:5px">' + p.mech.map(function (m) { return '<span class="chip">' + esc(m.label) + '</span>'; }).join('') + '</div>' + (node.func ? '<div class="muted" style="font-size:11px;margin-top:7px;line-height:1.45">' + esc(node.func) + '</div>' : ''));
      box.appendChild(sec('Mechanism tags', 'mech', mb));
    }

    // deep links
    var dl = el('div', 'links');
    dl.innerHTML = [
      ['STRING', URLS.string(p.sym)], ['Open Targets', URLS.ot(node.ensembl)], ['UniProt', URLS.uniprot(node.uniprot)],
      ['NCBI Gene', URLS.ncbi(node.entrez)], ['Ensembl', URLS.ensembl(node.ensembl)], ['GeneCards', URLS.genecards(p.sym)],
      ['AlphaFold', URLS.alphafold(node.uniprot)], ['PDBe', URLS.pdbe(p.sym)], ['IntAct', URLS.intact(p.sym)],
      node.mim ? ['OMIM', URLS.omim(node.mim)] : null
    ].filter(Boolean).map(function (x) { return '<a href="' + x[1] + '" target="_blank" rel="noopener">' + x[0] + ' ↗</a>'; }).join('');
    box.appendChild(sec('Open in databases', null, dl));

    box.appendChild(aiBlock('AI context — ' + p.sym, aiForGene(p)));
    return box;
  }
  function litRow(tier, n, query) { return '<div class="litrow"><span class="tier">' + tier + '</span><span class="n">' + n + '</span><a href="' + URLS.epmc(query) + '" target="_blank" rel="noopener">Europe PMC query ↗</a></div>'; }

  // disease-lens dossier
  function lensDossier(key) {
    var T = THEMES[key];
    var members = analysis.filter(function (p) { return p.themes[key] !== undefined; }).sort(function (a, b) { return b.themes[key] - a.themes[key]; });
    var box = el('div');
    var head = el('div', 'dhead');
    head.innerHTML = '<div class="tag" style="background:' + T.theme + '"></div><div style="flex:1"><h2 style="font-family:Inter;font-size:20px">' + esc(T.label) + '</h2><div class="nm">' + members.length + ' member genes · ' + ruleText(T) + '</div></div>';
    box.appendChild(head);
    box.appendChild(sec('Membership rule', null, el('div', 'muted', '<div style="font-size:12px;line-height:1.5">' + ruleLong(T) + '</div>')));
    var lb = el('div');
    members.forEach(function (p) {
      var fl = p.flags.filter(function (x) { return x.key === key; })[0];
      lb.appendChild(el('div', 'disrow', '<a class="gsel sym" data-sym="' + p.sym + '" href="#" style="width:84px">' + esc(p.sym) + '</a>' + bar(fl.strength) + '<span class="vl">' + f2(fl.strength) + '</span>'));
    });
    box.appendChild(sec('Members (by strength)', null, lb));
    // The Aging/longevity lens additionally carries CTBP1's curated, ortholog-aware
    // reading list (CtBP1 / CTBP-1 / ctbp-1) — incl. the C. elegans ctbp-1 life-span
    // paper a human-only "CTBP1" literature search misses. (BUILD-PROMPT §8)
    if (key === 'aging' && (GENE.agingRefs || []).length) {
      var ab = el('div');
      ab.appendChild(el('div', 'muted', '<div style="font-size:11.5px;line-height:1.45;margin-bottom:8px">Curated CTBP1 longevity / redox literature, ortholog-aware (CtBP1 · CTBP-1 · ctbp-1) — papers a human-only “CTBP1” search misses. A reading list, not a discovery claim.</div>'));
      GENE.agingRefs.forEach(function (r) {
        ab.appendChild(el('div', 'paper', '<div class="t"><a href="' + URLS.pubmedId(r.pmid) + '" target="_blank" rel="noopener">' + esc(r.t) + '</a></div><div class="m">' + esc([r.a, r.j, r.y].filter(Boolean).join(' · ')) + (r.c ? ' · ' + r.c + ' cites' : '') + ' · <span class="mono">PMID ' + esc(r.pmid) + '</span></div>'));
      });
      box.appendChild(sec('Aging / longevity reading list (curated, ortholog-aware)', null, ab));
    }
    box.appendChild(aiBlock('AI context — ' + T.label + ' lens', aiForLens(key)));
    return box;
  }
  function ruleText(T) { return T.kind === 'ot' ? 'OT EFO area-sum > ' + ENGINE.THRESH : T.kind === 'name' ? 'OT disease-name match' : 'GenAge ∪ LongevityMap'; }
  function ruleLong(T) {
    if (T.kind === 'ot') return 'A gene belongs if its Open Targets association scores summed over the EFO therapeutic area(s) <b>' + esc(T.efo.join(' + ')) + '</b> exceed ' + ENGINE.THRESH + '. The disease-name regex is used only to surface example diseases, never to decide membership.';
    if (T.kind === 'name') return 'A gene belongs if one of its own Open Targets disease associations matches the area\'s disease-name pattern and clears the floor (score ≥ ' + ENGINE.FLOOR_HARD + ', or a top-3 association with score ≥ ' + ENGINE.FLOOR_SOFT + ').';
    return 'A gene belongs if it is a curated human ageing gene in GenAge or carries a significant longevity association in LongevityMap (HAGR). Aging is an overlay — it never overrides a gene\'s dominant disease colour.';
  }

  // CTBP1 hub dossier
  function hubDossier() {
    var box = el('div');
    var head = el('div', 'dhead');
    head.innerHTML = '<div class="tag" style="background:var(--primary)"></div><div style="flex:1"><h2>CTBP1</h2><div class="nm">' + esc(GENE.name) + '</div><div class="rk">the subject hub · NAD(H)-sensing transcriptional corepressor</div></div>';
    box.appendChild(head);
    if (GENE.summary) box.appendChild(sec('Summary (NCBI/RefSeq)', null, el('div', 'muted', '<div style="font-size:12px;line-height:1.5">' + esc(GENE.summary) + '</div>')));
    if (GENE.uniprotFunc) box.appendChild(sec('Function (UniProt)', null, el('div', 'muted', '<div style="font-size:12px;line-height:1.5">' + esc(GENE.uniprotFunc) + (GENE.cofactor ? '<br><br><b style="color:var(--on-surface)">Cofactor:</b> ' + esc(GENE.cofactor) : '') + '</div>')));
    // theme roll-up (click a row → open that lens dossier; handled by the gsel wiring)
    var roll = el('div');
    ENGINE.themeExposure(W).forEach(function (t) {
      roll.appendChild(el('div', 'disrow', '<a class="gsel" data-lens="' + t.key + '" href="#" style="width:150px;color:' + t.theme + '">' + esc(THEMES[t.key].label.replace(/ \(.*\)/, '')) + '</a>' + bar(t.count / 100) + '<span class="vl">' + t.count + '</span>'));
    });
    box.appendChild(sec('Disease-area exposure (by gene count)', null, roll));
    // ids/clinvar
    var cv = GENE.clinvar;
    if (cv) box.appendChild(sec('CTBP1 clinical variants (ClinVar)', null, el('div', null,
      '<div class="kv"><span class="k">P/LP</span><span class="v"><a class="mono" href="' + URLS.clinvarPLP('CTBP1') + '" target="_blank" rel="noopener">' + cv.plp + '</a></span></div>' +
      '<div class="kv"><span class="k">VUS</span><span class="v"><a class="mono" href="' + URLS.clinvarVUS('CTBP1') + '" target="_blank" rel="noopener">' + cv.vus + '</a></span></div>' +
      '<div class="kv"><span class="k">Total</span><span class="v"><a class="mono" href="' + URLS.clinvarTotal('CTBP1') + '" target="_blank" rel="noopener">' + cv.total + '</a></span></div>')));
    // landmark refs
    if ((GENE.refs || []).length) {
      var rb = el('div'); (GENE.refs || []).slice(0, 6).forEach(function (r) { rb.appendChild(el('div', 'paper', '<div class="t"><a href="' + URLS.pubmedId(r.pmid) + '" target="_blank" rel="noopener">' + esc(r.t) + '</a></div><div class="m">' + esc([r.a, r.j, r.y].filter(Boolean).join(' · ')) + (r.c ? ' · ' + r.c + ' cites' : '') + '</div>')); });
      box.appendChild(sec('Landmark CTBP1 literature', null, rb));
    }
    // aging reading list
    if ((GENE.agingRefs || []).length) {
      var ab = el('div'); GENE.agingRefs.slice(0, 6).forEach(function (r) { ab.appendChild(el('div', 'paper', '<div class="t"><a href="' + URLS.pubmedId(r.pmid) + '" target="_blank" rel="noopener">' + esc(r.t) + '</a></div><div class="m">' + esc([r.a, r.j, r.y].filter(Boolean).join(' · ')) + '</div>')); });
      box.appendChild(sec('Aging / longevity reading list (curated, ortholog-aware)', null, ab));
    }
    var dl = el('div', 'links');
    dl.innerHTML = [['STRING', 'https://string-db.org/network/' + enc(GENE.ids.string)], ['Open Targets', URLS.ot(GENE.ids.ensembl)], ['UniProt', URLS.uniprot(GENE.ids.uniprot)], ['NCBI Gene', URLS.ncbi(GENE.ids.entrez)], ['Ensembl', URLS.ensembl(GENE.ids.ensembl)], ['GeneCards', URLS.genecards('CTBP1')], ['AlphaFold', URLS.alphafold(GENE.ids.uniprot)]].map(function (x) { return '<a href="' + x[1] + '" target="_blank" rel="noopener">' + x[0] + ' ↗</a>'; }).join('');
    box.appendChild(sec('Open in databases', null, dl));
    box.appendChild(aiBlock('AI context — CTBP1 hub', aiForHub()));
    return box;
  }

  // ======================================================================
  // AI blocks
  // ======================================================================
  function aiBlock(title, text) {
    var b = el('div', 'aiblock');
    b.innerHTML = '<div class="head"><span class="label-caps">' + esc(title) + '</span><button class="btn sm copyai" style="margin-left:auto">⧉ Copy</button></div>';
    var pre = el('pre'); pre.textContent = text; b.appendChild(pre);
    return b;
  }
  function aiForGene(p) {
    var n = p.node, q = cmQueries(n), cm = n.comention || {};
    var L = [];
    L.push('CTBP1 ATLAS — ' + p.sym + ' (' + n.name + ')');
    L.push('Rank #' + p.rank + ' of ' + analysis.length + ' STRING interactors · connection type: ' + p.type);
    L.push('IDs: Ensembl ' + n.ensembl + ' | Entrez ' + n.entrez + ' | UniProt ' + n.uniprot + (n.mim ? ' | OMIM ' + n.mim : ''));
    L.push('Composite ' + p.composite.toFixed(0) + '/100 (weights phys ' + W.phys + ' / lit ' + W.lit + ' / ctx ' + W.ctx + ')  ·  physical ' + f2(p.phys) + ' · literature ' + f2(p.lit) + ' · network ' + f2(p.ctx));
    L.push('STRING channels: combined ' + f2(n.s.c) + ' | experiments ' + f2(n.s.e) + ' | databases ' + f2(n.s.d) + ' | text-mining ' + f2(n.s.t) + ' | co-expr ' + f2(n.s.a) + ' | fusion ' + f2(n.s.p) + ' | neighborhood ' + f2(n.s.n) + ' | co-occurrence ' + f2(n.s.f));
    L.push('  STRING: ' + URLS.string(p.sym));
    if (n.intact) L.push('IntAct: ' + n.intact.type + (n.intact.direct ? ' (DIRECT)' : '') + ' · MI-score ' + n.intact.miscore + ' · ' + n.intact.count + ' records · methods: ' + (n.intact.methods || []).join('; ') + ' · PMIDs ' + (n.intact.pmids || []).join(', ') + '  → ' + URLS.intact(p.sym));
    if (p.flags.length) { L.push('Disease-area memberships:'); p.flags.forEach(function (fl) { L.push('  - ' + fl.label + ' (sev ' + fl.sev + ', strength ' + f2(fl.strength) + '): ' + fl.source + (fl.top && fl.top.n ? ' · e.g. ' + fl.top.n + ' (' + f2(fl.top.s) + ')' : '')); }); }
    if (p.mech.length) L.push('Mechanism tags: ' + p.mech.map(function (m) { return m.label; }).join(', '));
    if ((n.dis || []).length) { L.push('Top disease associations (Open Targets, ' + URLS.otAssoc(n.ensembl) + '):'); n.dis.slice(0, 8).forEach(function (d) { L.push('  - ' + d.n + ' (' + f2(d.s) + ')'); }); }
    L.push('Literature co-mention with CTBP1 (synonym-aware' + (n.syn && n.syn.length ? ': ' + [p.sym].concat(n.syn).join('/') : '') + '):');
    L.push('  in title: ' + (cm.title || 0) + '  → ' + URLS.epmc(q.title));
    L.push('  title+abstract: ' + (cm.abs || 0) + '  → ' + URLS.epmc(q.abs));
    L.push('  full text: ' + (cm.all || 0) + '  → ' + URLS.epmc(q.all));
    (n.refs || []).forEach(function (r) { L.push('  · ' + (r.t || ('PMID ' + r.pmid)) + ' [' + [r.a, r.j, r.y].filter(Boolean).join(', ') + '] ' + URLS.pubmedId(r.pmid)); });
    if (n.clinvar) L.push('ClinVar: P/LP ' + n.clinvar.plp + ' (' + URLS.clinvarPLP(p.sym) + ') · VUS ' + n.clinvar.vus + ' (' + URLS.clinvarVUS(p.sym) + ') · total ' + n.clinvar.total + ' (' + URLS.clinvarTotal(p.sym) + ')');
    if ((n.phenotypes || []).length) L.push('HPO phenotypes (' + n.phenoCount + ' total): ' + n.phenotypes.slice(0, 12).join('; ') + '  → ' + URLS.hpo(n.entrez) + ' | ' + URLS.monarch(n.entrez));
    if ((n.pathways || []).length) L.push('Reactome pathways: ' + n.pathways.slice(0, 10).join('; '));
    if (p.stop) L.push('NOTE: ambiguous/house-keeping symbol — literature co-mention excluded from the literature score.');
    return L.join('\n');
  }
  function aiForLens(key) {
    var T = THEMES[key];
    var members = analysis.filter(function (p) { return p.themes[key] !== undefined; }).sort(function (a, b) { return b.themes[key] - a.themes[key]; });
    var L = ['CTBP1 ATLAS — disease lens: ' + T.label, 'Membership rule: ' + ruleLong(T).replace(/<[^>]+>/g, ''), members.length + ' member genes (by strength):'];
    members.forEach(function (p) { var fl = p.flags.filter(function (x) { return x.key === key; })[0]; L.push('  - ' + p.sym + ' (strength ' + f2(fl.strength) + ', sev ' + fl.sev + '): ' + fl.source); });
    if (key === 'aging' && (GENE.agingRefs || []).length) {
      L.push('Curated CTBP1 aging/longevity reading list (ortholog-aware — CtBP1 / CTBP-1 / ctbp-1):');
      GENE.agingRefs.forEach(function (r) { L.push('  · ' + (r.t || ('PMID ' + r.pmid)) + ' [' + [r.a, r.j, r.y].filter(Boolean).join(', ') + '] PMID ' + r.pmid + '  ' + URLS.pubmedId(r.pmid)); });
    }
    return L.join('\n');
  }
  function aiForHub() {
    var L = ['CTBP1 ATLAS — hub: CTBP1 (' + GENE.name + ')'];
    L.push('IDs: Ensembl ' + GENE.ids.ensembl + ' | Entrez ' + GENE.ids.entrez + ' | UniProt ' + GENE.ids.uniprot + (GENE.mim ? ' | OMIM ' + GENE.mim : ''));
    if (GENE.summary) L.push('Summary: ' + GENE.summary);
    if (GENE.uniprotFunc) L.push('Function (UniProt): ' + GENE.uniprotFunc);
    if (GENE.cofactor) L.push('Cofactor: ' + GENE.cofactor);
    var syn = ENGINE.synthesis(W); L.push('Synthesis: ' + syn.lead + ' ' + syn.body);
    L.push('Disease-area exposure (by gene count):'); ENGINE.themeExposure(W).forEach(function (t) { L.push('  - ' + THEMES[t.key].label + ': ' + t.count); });
    if (GENE.clinvar) L.push('CTBP1 ClinVar: P/LP ' + GENE.clinvar.plp + ' · VUS ' + GENE.clinvar.vus + ' · total ' + GENE.clinvar.total + '  → ' + URLS.clinvarTotal('CTBP1'));
    (GENE.refs || []).slice(0, 6).forEach(function (r) { L.push('  · landmark: ' + r.t + ' [' + [r.a, r.j, r.y].filter(Boolean).join(', ') + '] ' + URLS.pubmedId(r.pmid)); });
    L.push('Sources: ' + (META.sources || []).join(' · ') + ' · snapshot ' + META.date);
    return L.join('\n');
  }
  function aiForAll() {
    var parts = ['================ CTBP1 ATLAS — FULL AI CONTEXT ================', aiForHub(), ''];
    ORDER.forEach(function (k) { parts.push('---- LENS: ' + THEMES[k].label + ' ----', aiForLens(k), ''); });
    parts.push('================ ALL ' + analysis.length + ' INTERACTORS ================', '');
    analysis.forEach(function (p) { parts.push(aiForGene(p), ''); });
    return parts.join('\n');
  }

  // ======================================================================
  // header buttons + modal
  // ======================================================================
  function wireHeader() {
    var ibx = $('btnInsightClose'); if (ibx) ibx.addEventListener('click', function () { var b = $('insightBar'); if (b) b.classList.add('hidden'); });
  }
  function flash(btn) { var o = btn.innerHTML; btn.innerHTML = '<span class="k">↻</span> Re-analyzed'; setTimeout(function () { btn.innerHTML = o; }, 1100); }

  function openMethods() {
    var ov = el('div'); ov.style.cssText = 'position:fixed;inset:0;z-index:9000;background:rgba(7,11,22,.78);display:flex;align-items:center;justify-content:center;padding:32px';
    var card = el('div'); card.style.cssText = 'max-width:760px;max-height:84vh;overflow:auto;background:var(--surface);border:1px solid var(--outline);border-radius:var(--r-lg);box-shadow:var(--shadow);padding:26px 30px';
    card.innerHTML =
      '<div style="display:flex;align-items:center"><h2 style="font-size:22px">How to read this</h2><button class="btn sm" style="margin-left:auto" id="mClose">Close ✕</button></div>' +
      '<p class="muted" style="margin:14px 0;line-height:1.6">CTBP1 ATLAS profiles the top ' + META.neighborhood + ' STRING interactors of human CTBP1 and derives disease/biology connections through a transparent inference engine. Every number links to the live source that validates it; the engine treats every gene identically — no partner is special-cased.</p>' +
      sectionHTML('The composite connection score', 'A weighted blend of three sub-scores. <b>Physical</b> = clamp(STRING experiments + 0.5·curated databases) — the combined score is deliberately excluded so text-mining can\'t inflate a pair into a fake physical interaction. <b>Literature</b> = log-scaled, synonym-aware CTBP1 co-mention (ambiguous/housekeeping symbols zeroed). <b>Network</b> = summed partner–partner STRING edge weight, hub excluded. Re-weight live with the sliders.') +
      sectionHTML('Connection types', 'Core complex / Physical interactor / Literature-linked / Functional neighbour / Associated. These key off physical evidence (experiments + IntAct), never the curated-DB channel alone — a database-only pair is never called a physical complex member.') +
      sectionHTML('Five disease areas + an aging overlay', '<b>Which</b> areas to show is an editorial choice; <b>which genes</b> belong is decided only by the data. The five <b>disease areas</b> are the constellation sectors: Oncology / Metabolic / CNS use Open Targets EFO therapeutic-area sums; Neurodegeneration / Neurodevelopment use OT disease-name matches. <b>Aging / longevity</b> is not a disease but an <b>overlay</b> (GenAge ∪ LongevityMap), shown as a gold halo on member genes — never its own sector. The test harness recomputes every membership straight from the raw data and asserts it equals the engine — a hand-placed gene would fail.') +
      sectionHTML('Provenance', 'Co-mention counts are tiered (title / title+abstract / full text) and link to the exact Europe PMC query that produced them. ClinVar counts use NCBI\'s precise clinsig filters. The ⧉ Copy buttons dump every shown value with its source URL as plain text for an LLM.') +
      sectionHTML('Sources', (META.sources || []).join(' · ') + '. Snapshot ' + META.date + '.');
    ov.appendChild(card); document.body.appendChild(ov); wireGlossary(card);
    function close() { document.body.removeChild(ov); }
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    $('mClose').addEventListener('click', close);
  }
  function sectionHTML(h, b) { return '<div style="margin-top:16px"><div class="label-caps" style="color:var(--primary);margin-bottom:5px">' + esc(h) + '</div><div class="muted" style="font-size:13px;line-height:1.6">' + b + '</div></div>'; }

  function liveProbe() {
    var btn = $('btnLive'), o = btn.innerHTML; btn.innerHTML = '<span class="k">◎</span> Probing…';
    var done = 0, results = [];
    function finish(label, ok) { results.push((ok ? '✓ ' : '✕ ') + label); if (++done === 2) { btn.innerHTML = o; toast('Live data probe:\n' + results.join('\n') + '\n\nThe bundled snapshot (' + META.date + ') stands regardless.'); } }
    probe('https://string-db.org/api/json/version', function (ok) { finish('STRING v12 API', ok); });
    probe('https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=CTBP1&format=json&pageSize=1', function (ok) { finish('Europe PMC API', ok); });
  }
  function probe(url, cb) {
    var t = setTimeout(function () { cb(false); }, 6000); var fired = false;
    fetch(url, { mode: 'cors' }).then(function (r) { if (fired) return; fired = true; clearTimeout(t); cb(r.ok); }).catch(function () { if (fired) return; fired = true; clearTimeout(t); cb(false); });
  }
  function toast(msg) {
    var t = el('div'); t.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:9500;max-width:340px;white-space:pre-wrap;background:var(--surface);border:1px solid var(--outline);border-left:3px solid var(--primary);border-radius:var(--r);box-shadow:var(--shadow);padding:14px 16px;font-size:12px;line-height:1.5;color:var(--on-surface)';
    t.textContent = msg; document.body.appendChild(t); setTimeout(function () { t.style.transition = 'opacity .4s'; t.style.opacity = '0'; setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 400); }, 6000);
  }

  // ======================================================================
  // animation clock (constellation pulse)
  // ======================================================================
  var clock = 0, animAccum = 0, animLast = 0;
  function tickAnim(ts) {
    var dt = ts - animLast; animLast = ts; clock += dt || 16; animAccum += dt || 16;
    if (animAccum >= 33) {                       // ~30fps pulse redraw, only when needed
      animAccum = 0;
      if (state.view === 'constellation' && analysis.some(function (p) { return p.flags.some(function (f) { return f.sev >= 3; }); })) drawConstellation();
    }
    requestAnimationFrame(tickAnim);
  }

  // ======================================================================
  // boot
  // ======================================================================
  function boot() {
    renderChips(); renderLenses(); wireWeights(); wireHeader(); renderInsight(); renderDiscoveries();
    document.querySelectorAll('#viewTabs button').forEach(function (b) { b.addEventListener('click', function () { setView(b.getAttribute('data-view')); }); });
    wireCanvas($('cz'), 'constellation'); wireCanvas($('nz'), 'network');
    wireGlossary(document);
    renderDrawer();                       // hub dossier by default
    setView('constellation');
    window.addEventListener('resize', debounce(function () { netReady = false; renderActiveView(); }, 180));
    var intro = $('intro');
    if (/[?&]noboot\b/.test(location.search)) { intro.parentNode && intro.parentNode.removeChild(intro); }
    else setTimeout(function () { intro.classList.add('gone'); setTimeout(function () { intro.parentNode && intro.parentNode.removeChild(intro); }, 600); }, 1150);
    requestAnimationFrame(tickAnim);
    window.CTBP1_APP = { select: select, openLens: openLens, state: state, copyAllContext: aiForAll, hot: hot };   // headless hook
  }
  function debounce(fn, ms) { var t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }

  function renderDiscoveries() {
    var box = $('discoveries'); if (!box) return; box.innerHTML = '';
    ENGINE.discoveries(W, 12).forEach(function (d) {
      var c = el('div', 'card'); c.style.borderTopColor = d.theme || 'var(--primary)';
      c.innerHTML = '<div class="kind">' + esc(d.kind.replace('area:', '').replace(/^\w/, function (m) { return m.toUpperCase(); })) + '</div><div class="sym" style="color:' + (d.theme || 'var(--on-surface)') + '">' + esc(d.sym) + '</div><div class="why">' + esc(d.reason) + '</div>';
      c.addEventListener('click', function () { select(d.sym); setView('constellation'); });
      box.appendChild(c);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
