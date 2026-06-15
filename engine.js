/* ============================================================================
 * CTBP1 ATLAS — inference engine  (window.CTBP1_ENGINE)
 * ----------------------------------------------------------------------------
 * A PURE module. It receives only window.CTBP1_DATA (raw, sourced evidence) and
 * derives every connection score, connection type, disease-area membership,
 * mechanism tag, path, discovery and synthesis from that evidence ALONE.
 *
 * NON-NEGOTIABLE (see BUILD-PROMPT §2.3): no partner gene is ever special-cased.
 * The ONLY gene-ish tokens permitted in this file are the subject hub `CTBP1`
 * and the documented literature stop-list (IMPACT, GAPDH, TBP, ACTB, B2M).
 * Everything else keys off disease names, EFO therapeutic areas, STRING channel
 * scores, IntAct evidence and the GenAge/LongevityMap bundle — never a symbol.
 *
 * No DOM access. Safe to eval in Node (data/verify.js) or the browser.
 * ==========================================================================*/
(function (root) {
  'use strict';

  var DATA = root.CTBP1_DATA;
  if (!DATA) { throw new Error('CTBP1_ENGINE: window.CTBP1_DATA must load first'); }

  var HUB = 'CTBP1';
  // Housekeeping / ambiguous symbols whose literature is uninformative. These
  // are zeroed out of the literature score and flagged in the UI. (§2.3, §8)
  var STOPLIST = ['IMPACT', 'GAPDH', 'TBP', 'ACTB', 'B2M'];
  var STOP = {};
  STOPLIST.forEach(function (s) { STOP[s] = 1; });

  // -------------------------------------------------------------------------
  // small helpers
  // -------------------------------------------------------------------------
  function clamp(x, lo, hi) {
    if (lo === undefined) lo = 0;
    if (hi === undefined) hi = 1;
    return Math.max(lo, Math.min(hi, x));
  }
  function num(x) { return (typeof x === 'number' && isFinite(x)) ? x : 0; }
  function round(x) { return Math.round(x); }
  function by(sel, dir) { dir = dir || 1; return function (a, b) { return (sel(b) - sel(a)) * dir; }; }

  // =========================================================================
  // 1. DISEASE AREAS  (the six editorial lenses — §6.3)
  //    `kind` decides membership PURELY from data:
  //      ot   → Open Targets EFO therapeutic-area aggregate sum > THRESH
  //      name → gene's own OT disease NAMES match a regex (membership)
  //      aging→ node.aging present (GenAge ∪ LongevityMap)
  //    The disease-name regexes below contain ONLY disease vocabulary — no
  //    gene symbols. For `ot` areas the regex is provenance-only (example
  //    diseases); it never alters who is a member.
  // =========================================================================
  var THRESH = 0.15;                       // EFO area-sum membership floor (§6.3)
  var FLOOR_HARD = 0.18;                    // a disease "counts" if s ≥ 0.18 …
  var FLOOR_SOFT = 0.10;                    // … or top-3 association and s ≥ 0.10

  var RE = {
    // cancer family (oncology citations / examples — provenance-only, so it is
    // broad on purpose: it also names well-known tumour-predisposition syndromes
    // whose plain names lack a cancer keyword. It NEVER decides membership.)
    cancer: /cancer|carcinoma|tumou?r|neoplas|leuk[ae]mia|lymphoma|melanoma|sarcoma|gliom|glioblast|blastoma|myeloma|adenoma|malignan|metasta|mesothelioma|astrocytoma|oncolog|polyposis|fibromatosis|nevus|nevi|adenocarcinoma|squamous|hodgkin|myelodysplas|myeloprolifer|li-fraumeni|cowden|lynch|peutz|fanconi|neurofibromat|hippel|retinoblast|wilms|nephroblast|hamartoma|papilloma|teratoma|seminoma/i,
    // nutritional / metabolic / endocrine (metabolic citations — provenance-only)
    metabolic: /diabet|obesity|metaboli|insulin|lipid|cholesterol|glucose|glyc[ae]mi|dyslipid|thyroid|adipos|fatty|steatos|hyperlipid|hyperglyc|endocrine|hormone|pituitar|adrenal|hypogonad|cushing|graves|hypopituit|nutritional|vitamin|porphyr|amyloid|gout|uric|hyperuric|wasting|cachexia|growth retard|short stature|tall stature/i,
    // nervous-system + psychiatric (CNS citations; broad on purpose — provenance only)
    cns: /schizophren|depress|bipolar|anxiety|psychiat|psychos|nervous system|neuropath|neuralgia|epilep|seizure|migraine|mood|addict|substance|alcohol|stroke|cerebr|encephal|neurolog|hearing|deaf|auditory|sensorineural|vision|visual|retina|ophthalm|nerve|myoclon|spastic/i,
    // classic neurodegeneration (MEMBERSHIP — precise)
    neurodegen: /alzheimer|parkinson|amyotrophic|huntington|dementia|frontotemporal|neurodegenerat|spinocerebellar ataxia|hereditary ataxia|motor neuron|lewy bod|tauopath|prion disease|multiple sclerosis|spinal muscular atroph/i,
    // neurodevelopment incl. ASD (MEMBERSHIP — precise)
    neurodev: /autis|asperger|\bASD\b|pervasive developmental|intellectual disab|intellectual developmental|mental retard|developmental delay|global developmental|developmental and epileptic|neurodevelopment/i,
    // additional OT-area "field" provenance regexes (examples only — membership is the EFO area-sum)
    immune: /immun|autoimmun|inflamm|arthritis|lupus|psoriasis|colitis|crohn|inflammatory bowel|allerg|asthma|vasculit|graft|lymphoproliferat|immunodefic|sjogren|celiac|coeliac|thyroiditis/i,
    cardio: /cardi|heart|coronary|myocard|arrhythm|atrial|ventric|aortic|vascular|hypertens|atheroscler|ischaem|ischem|stroke|aneurysm|thrombo|fibrillation|cardiomyopath|angina|\bvalve/i,
    hematologic: /leuk[ae]mia|lymphoma|myeloma|myelodysplas|myeloprolifer|an[ae]mia|thrombocyto|neutropen|h[ae]mato|coagulat|h[ae]mophil|sickle|thalass[ae]mia|pancytopen|bone marrow|polycyth[ae]mia/i,
    eye: /\beye|ocular|retin|macul|cornea|glaucoma|cataract|optic|vision|visual|blind|nystagmus|strabismus|ophthalm|uveitis|keratoconus|colou?r blindness/i
  };

  // THEMES — declared in display order. `efo` lists the EFO therapeutic-area
  // keys whose summed association score defines `ot` membership. Colours are
  // the verbatim tokens from BUILD-PROMPT §6.3.
  // "Fields" = disease/biology lenses. The five SECTOR fields get a constellation wedge and drive a
  // node's colour (its dominant). The rest are cross-cutting OVERLAY/FILTER fields — they filter the
  // views but never own a wedge (aging additionally paints a gold halo). Membership rule is per `kind`.
  var THEME_ORDER = ['oncology', 'metabolic', 'neurodegen', 'cns', 'neurodev', 'aging', 'immunity', 'cardiovascular', 'hematologic', 'eye'];
  var THEMES = {
    oncology:       { key: 'oncology',       label: 'Oncology',                     theme: '#ff5d73', kind: 'ot',    sector: true, efo: ['cancer or benign tumor'], re: RE.cancer },
    metabolic:      { key: 'metabolic',      label: 'Metabolic disease',            theme: '#24c8a4', kind: 'ot',    sector: true, efo: ['nutritional or metabolic disease', 'endocrine system disease'], re: RE.metabolic },
    neurodegen:     { key: 'neurodegen',     label: 'Neurodegeneration',            theme: '#f5a623', kind: 'name',  sector: true, re: RE.neurodegen },
    cns:            { key: 'cns',            label: 'CNS / neuroscience',           theme: '#8a7bff', kind: 'ot',    sector: true, efo: ['nervous system disease', 'psychiatric disorder'], re: RE.cns },
    neurodev:       { key: 'neurodev',       label: 'Neurodevelopment (incl. ASD)', theme: '#4aa3ff', kind: 'name',  sector: true, re: RE.neurodev },
    aging:          { key: 'aging',          label: 'Aging / longevity',            theme: '#c8b560', kind: 'aging' },
    immunity:       { key: 'immunity',       label: 'Immunity',                     theme: '#26de81', kind: 'ot',    efo: ['immune system disease'], re: RE.immune },
    cardiovascular: { key: 'cardiovascular', label: 'Cardiovascular',               theme: '#fd79a8', kind: 'ot',    efo: ['cardiovascular disease'], re: RE.cardio },
    hematologic:    { key: 'hematologic',    label: 'Hematologic (blood)',          theme: '#e17055', kind: 'ot',    efo: ['hematologic disease'], re: RE.hematologic },
    eye:            { key: 'eye',            label: 'Eye / vision',                 theme: '#00cec9', kind: 'ot',    efo: ['disorder of visual system'], re: RE.eye }
  };

  // =========================================================================
  // 2. MECHANISM TAGS  (separate from disease areas — §6.4)
  //    Matched uniformly against the gene's function text. NAD⁺/redox is a
  //    MECHANISM, explicitly NOT the Aging area.
  // =========================================================================
  var MECH = [
    { key: 'redox',     label: 'NAD⁺ / redox',     re: /NAD\s*\(?H?\)?|NADH|oxidoreduct|dehydrogenase|sirtuin|redox|oxidation-reduction/i },
    { key: 'chromatin', label: 'Chromatin',        re: /chromatin|histone|nucleosome|methyltransferase|acetyltransferase|deacetylase|demethylase|epigenet/i },
    { key: 'repress',   label: 'Co-repression',    re: /repress|corepressor|co-repressor|silenc/i },
    { key: 'wnt',       label: 'Wnt / EMT',        re: /\bwnt\b|epithelial[- ]mesenchymal|\bEMT\b|catenin/i },
    { key: 'synaptic',  label: 'Synaptic',         re: /synap|neurotransmitter|axon|dendrit/i },
    { key: 'apoptosis', label: 'Apoptosis',        re: /apopto|programmed cell death|caspase|cell death/i }
  ];

  // =========================================================================
  // 3. DATASET-WIDE NORMALISERS  (computed once from the snapshot)
  // =========================================================================
  var NODES = DATA.nodes || [];
  var EDGES = DATA.edges || [];

  function litEffOf(n) { return STOP[n.sym] ? 0 : num(n.lit); }

  // MAXLIT = the largest EFFECTIVE literature count (stop-listed → 0), so the
  // most-cited non-ambiguous partner normalises to 1.0.
  var MAXLIT = NODES.reduce(function (m, n) { return Math.max(m, litEffOf(n)); }, 0) || 1;
  var LOG_MAXLIT = Math.log10(MAXLIT + 1) || 1;

  // CTXRAW = summed partner↔partner STRING edge weight, EXCLUDING the CTBP1 hub.
  var CTXRAW = {};
  NODES.forEach(function (n) { CTXRAW[n.sym] = 0; });
  EDGES.forEach(function (e) {
    if (e.a === HUB || e.b === HUB) return;          // hub edges never feed context
    if (CTXRAW[e.a] !== undefined) CTXRAW[e.a] += num(e.s);
    if (CTXRAW[e.b] !== undefined) CTXRAW[e.b] += num(e.s);
  });
  var MAXCTX = Object.keys(CTXRAW).reduce(function (m, k) { return Math.max(m, CTXRAW[k]); }, 0) || 1;

  // partner↔partner edge index (for path())
  var EDGE_INDEX = {};
  EDGES.forEach(function (e) { EDGE_INDEX[e.a + ' ' + e.b] = e.s; EDGE_INDEX[e.b + ' ' + e.a] = e.s; });

  var DEFAULT_W = { phys: 0.5, lit: 0.3, ctx: 0.2 };

  // -------------------------------------------------------------------------
  // disease-floor: does association `d` "count" for this gene? (§6.3)
  // -------------------------------------------------------------------------
  function top3Set(dis) {
    var sorted = (dis || []).slice().sort(by(function (d) { return num(d.s); }));
    return sorted.slice(0, 3);
  }
  function passesFloor(d, top3) {
    if (num(d.s) >= FLOOR_HARD) return true;
    return top3.indexOf(d) !== -1 && num(d.s) >= FLOOR_SOFT;
  }

  function efoSum(node, keys) {
    var a = node.areas || {}, s = 0;
    for (var i = 0; i < keys.length; i++) s += num(a[keys[i]]);
    return s;
  }
  function areaBurden(node) {
    var a = node.areas || {}, s = 0;
    for (var k in a) if (Object.prototype.hasOwnProperty.call(a, k)) s += num(a[k]);
    return s;
  }

  // =========================================================================
  // 4. MEMBERSHIP + FLAGS  (the heart of the data-driven area assignment)
  //    Returns one flag per area the gene belongs to. A flag is a MEMBERSHIP,
  //    fully sourced — there is no separate hand-picked severity list (§6.3).
  // =========================================================================
  function flagsFor(node) {
    var dis = node.dis || [];
    var top3 = top3Set(dis);
    var burden = areaBurden(node);
    var out = [];

    THEME_ORDER.forEach(function (key) {
      var T = THEMES[key];
      var flag = null;

      if (T.kind === 'ot') {
        var sum = efoSum(node, T.efo);
        if (sum > THRESH) {
          // example diseases = the gene's OWN associations whose names match
          // the area regex AND clear the floor (provenance only).
          var matches = dis.filter(function (d) { return T.re.test(d.n) && passesFloor(d, top3); })
                           .sort(by(function (d) { return num(d.s); }));
          // citation: best matching example, else fall back to the gene's
          // single strongest association so a REAL OT disease is always cited.
          var top = matches[0] || top3[0] || dis[0] || null;
          var strength = burden > 0 ? clamp(sum / burden) : 0;
          flag = {
            key: key, label: T.label, theme: T.theme, kind: 'ot',
            strength: strength,
            sev: clamp(round(strength * 3), 1, 3),
            source: 'Open Targets — EFO therapeutic area "' + T.efo.join(' + ') + '" association sum ' + sum.toFixed(2) + ' (> ' + THRESH + ')',
            areaSum: +sum.toFixed(4),
            top: top ? { n: top.n, s: num(top.s) } : null,
            matched: matches.length > 0,                  // was the citation a real area match?
            matches: matches.slice(0, 4).map(function (d) { return { n: d.n, s: num(d.s) }; })
          };
        }
      } else if (T.kind === 'name') {
        var nmatch = dis.filter(function (d) { return T.re.test(d.n) && passesFloor(d, top3); })
                        .sort(by(function (d) { return num(d.s); }));
        if (nmatch.length) {
          var nstr = clamp(num(nmatch[0].s));
          flag = {
            key: key, label: T.label, theme: T.theme, kind: 'name',
            strength: nstr,
            sev: clamp(round(nstr * 3), 1, 3),
            source: 'Open Targets — disease-name match (' + nmatch.length + '): "' + nmatch[0].n + '" (' + num(nmatch[0].s).toFixed(2) + ')',
            top: { n: nmatch[0].n, s: num(nmatch[0].s) },
            matched: true,
            matches: nmatch.slice(0, 4).map(function (d) { return { n: d.n, s: num(d.s) }; })
          };
        }
      } else if (T.kind === 'aging') {
        var ag = node.aging;
        if (ag) {
          var astr = ag.genage ? 0.6 : 0.45;             // GenAge vs LongevityMap-only
          var src = ag.genage
            ? 'GenAge — curated human ageing gene' + (ag.id ? ' (HAGR GenAge id ' + ag.id + ')' : '')
            : 'LongevityMap — significant longevity association' + (ag.pmids && ag.pmids.length ? ' (PMID ' + ag.pmids.join(', ') + ')' : (ag.id ? ' (id ' + ag.id + ')' : ''));
          flag = {
            key: key, label: T.label, theme: T.theme, kind: 'aging',
            strength: astr,
            sev: clamp(round(astr * 3), 1, 3),
            source: src,
            top: { genage: !!ag.genage, longevity: !!ag.longevity, why: ag.why || '', id: ag.id || null, pmids: ag.pmids || [] },
            matched: true,
            matches: []
          };
        }
      }

      if (flag) out.push(flag);
    });

    return out;
  }

  // dominant DISEASE area drives node colour. Aging is an overlay: excluded
  // unless the gene belongs to no disease area at all (§6.3).
  function dominantOf(flags) {
    var sect = flags.filter(function (f) { return THEMES[f.key].sector; });   // only SECTOR fields colour/place a node
    if (!sect.length) return null;                                            // no sector membership → neutral (no dominant)
    return sect.slice().sort(by(function (f) { return f.strength; }))[0].key;
  }

  function mechFor(node) {
    var fn = node.func || '';
    return MECH.filter(function (m) { return m.re.test(fn); })
               .map(function (m) { return { key: m.key, label: m.label }; });
  }

  // =========================================================================
  // 5. CONNECTION TYPE  (keys off PHYSICAL evidence, never the DB channel
  //    alone — a DB-only pair is never a physical complex member. §6.2)
  // =========================================================================
  function intactFlags(node) {
    var ia = node.intact;
    if (!ia) return { direct: false, physical: false };
    var t = ia.type || '';
    var direct = ia.direct === true || /direct interaction/i.test(t);
    var physical = direct || /physical association/i.test(t);
    return { direct: direct, physical: physical };
  }

  function typeOf(s, phys, litNorm, ctx, ia) {
    if (num(s.c) >= 0.9 && (num(s.e) >= 0.5 || ia.direct)) return 'Core complex';
    if (num(s.e) >= 0.2 || ia.physical) return 'Physical interactor';
    if (litNorm >= 0.6 && phys < 0.45) return 'Literature-linked';
    if (ctx >= 0.45 && phys < 0.45) return 'Functional neighbour';
    return 'Associated';
  }

  // =========================================================================
  // 6. PROFILE  (static, weight-independent classification of one node)
  // =========================================================================
  function profile(node) {
    var s = node.s || {};
    var phys = clamp(num(s.e) + 0.5 * num(s.d));                 // experiments + curated DBs only
    var litEff = litEffOf(node);
    var litNorm = clamp(Math.log10(litEff + 1) / LOG_MAXLIT);
    var ctxRaw = num(CTXRAW[node.sym]);
    var ctx = clamp(ctxRaw / MAXCTX);
    var ia = intactFlags(node);
    var flags = flagsFor(node);
    var themes = {};
    flags.forEach(function (f) { themes[f.key] = f.strength; });
    return {
      sym: node.sym, name: node.name, rank: node.rank, node: node,
      phys: phys, lit: litNorm, litEff: litEff, ctx: ctx, ctxRaw: ctxRaw,
      stop: !!STOP[node.sym],
      type: typeOf(s, phys, litNorm, ctx, ia),
      intact: ia,
      flags: flags,
      themes: themes,
      dominant: dominantOf(flags),
      mech: mechFor(node)
    };
  }

  // cache the static profiles once
  var PROFILES = NODES.map(profile);
  var PROF_BY_SYM = {};
  PROFILES.forEach(function (p) { PROF_BY_SYM[p.sym] = p; });

  // =========================================================================
  // 7. WEIGHTED SCORING + PUBLIC ANALYSIS
  // =========================================================================
  function normW(W) {
    W = W || DEFAULT_W;
    var p = num(W.phys), l = num(W.lit), c = num(W.ctx);
    var sum = p + l + c;
    if (sum <= 0) { p = DEFAULT_W.phys; l = DEFAULT_W.lit; c = DEFAULT_W.ctx; sum = 1; }
    return { phys: p, lit: l, ctx: c, sum: sum };
  }

  function composite(p, W) {
    var w = normW(W);
    return 100 * (w.phys * p.phys + w.lit * p.lit + w.ctx * p.ctx) / w.sum;
  }

  // classify(node|sym) → the static profile (type, flags, mech, dominant)
  function classify(ref) {
    if (typeof ref === 'string') return PROF_BY_SYM[ref] || null;
    if (ref && ref.sym) return PROF_BY_SYM[ref.sym] || profile(ref);
    return null;
  }

  // connection(node|sym, W) → the weighted meters for one gene
  function connection(ref, W) {
    var p = classify(ref);
    if (!p) return null;
    return {
      sym: p.sym, type: p.type,
      phys: p.phys, lit: p.lit, ctx: p.ctx,
      composite: composite(p, W)
    };
  }

  // analyse(W) → ALL profiles, each with a weighted composite, sorted by
  // composite descending. This is the engine's primary entry point.
  function analyse(W) {
    return PROFILES.map(function (p) {
      var o = {};
      for (var k in p) o[k] = p[k];
      o.composite = composite(p, W);
      return o;
    }).sort(by(function (o) { return o.composite; }));
  }

  // =========================================================================
  // 8. PATHS  (every profiled gene is a DIRECT STRING neighbour of CTBP1, so
  //    return the direct edge — never a spurious indirect detour. §6.5)
  // =========================================================================
  function path(from, to) {
    from = from || HUB;
    if (from === to) return { from: from, to: to, direct: true, weight: 1, via: [from], note: 'self' };
    // hub ↔ partner: the direct STRING combined score is the partner's s.c
    if (from === HUB || to === HUB) {
      var sym = (from === HUB) ? to : from;
      var p = PROF_BY_SYM[sym];
      var w = p ? num(p.node.s && p.node.s.c) : null;
      return { from: from, to: to, direct: true, weight: w, via: [HUB, sym], hub: true };
    }
    // partner ↔ partner: direct edge if present, else route through the hub
    var key = from + ' ' + to;
    if (EDGE_INDEX[key] !== undefined) {
      return { from: from, to: to, direct: true, weight: num(EDGE_INDEX[key]), via: [from, to] };
    }
    var a = PROF_BY_SYM[from], b = PROF_BY_SYM[to];
    return {
      from: from, to: to, direct: false, via: [from, HUB, to],
      weight: (a && b) ? num(a.node.s.c) * num(b.node.s.c) : null, hub: true
    };
  }

  // =========================================================================
  // 9. DISCOVERIES  (blended, de-duplicated, diversity-capped feed — §6.5)
  //    One gene appears at most once.
  // =========================================================================
  function discoveries(W, limit) {
    limit = limit || 12;
    var ranked = analyse(W);
    var picks = [];
    var taken = {};

    function add(p, kind, reason) {
      if (!p || taken[p.sym]) return;
      taken[p.sym] = 1;
      picks.push({
        sym: p.sym, name: p.name, kind: kind, reason: reason,
        composite: p.composite, type: p.type, dominant: p.dominant,
        theme: p.dominant ? THEMES[p.dominant].theme : null
      });
    }

    // (a) the single strongest overall connection ("strongest" is a superlative — exactly one)
    if (ranked[0]) add(ranked[0], 'strongest', 'Strongest composite connection (' + ranked[0].composite.toFixed(0) + '/100), typed "' + ranked[0].type + '"');

    // (b) best exemplar per disease area (one gene per area)
    THEME_ORDER.forEach(function (key) {
      var best = ranked
        .filter(function (p) { return p.themes[key] !== undefined; })
        .sort(by(function (p) { return p.themes[key]; }))[0];
      if (best) {
        var f = best.flags.filter(function (x) { return x.key === key; })[0];
        add(best, 'area:' + key, 'Top exemplar for ' + THEMES[key].label + (f && f.top && f.top.n ? ' — ' + f.top.n : ''));
      }
    });

    // (c) most co-mentioned in the literature (stop-listed/ambiguous symbols
    //     excluded — their raw counts are an artifact of the homograph, §8)
    ranked.slice().filter(function (p) { return !p.stop; })
      .sort(by(function (p) { return num(p.node.comention && p.node.comention.all); }))
      .slice(0, 1).forEach(function (p) {                    // "most" co-mentioned — one
        var all = num(p.node.comention && p.node.comention.all);
        if (all > 0) add(p, 'comention', 'Most co-mentioned with CTBP1 (' + all + ' papers, synonym-aware)');
      });

    // (d) under-explored hypotheses: strong PHYSICAL evidence, thin literature
    ranked.slice()
      .filter(function (p) { return p.phys >= 0.45 && p.lit < 0.4 && !p.stop; })
      .sort(by(function (p) { return p.phys * (1 - p.lit); }))
      .slice(0, 3).forEach(function (p) {
        add(p, 'underexplored', 'Under-explored: strong physical evidence (phys ' + p.phys.toFixed(2) + ') but thin CTBP1 literature');
      });

    return picks.slice(0, limit);
  }

  // =========================================================================
  // 10. THEME ROLL-UPS + FINDINGS
  // =========================================================================
  // membership counts per area, ranked by gene count (exposure). (§6.5)
  function themeExposure(W) {
    var ranked = analyse(W);
    return THEME_ORDER.map(function (key) {
      var members = ranked.filter(function (p) { return p.themes[key] !== undefined; });
      return {
        key: key, label: THEMES[key].label, theme: THEMES[key].theme,
        count: members.length,
        kind: THEMES[key].kind
      };
    }).sort(by(function (t) { return t.count; }));
  }

  function themeSummary(W) {
    var ranked = analyse(W);
    return themeExposure(W).map(function (t) {
      var members = ranked
        .filter(function (p) { return p.themes[t.key] !== undefined; })
        .sort(by(function (p) { return p.themes[t.key]; }));
      var top = members[0];
      return {
        key: t.key, label: t.label, theme: t.theme, kind: t.kind, count: t.count,
        members: members.map(function (p) { return p.sym; }),
        exemplar: top ? top.sym : null
      };
    });
  }

  // findings() — one fully-sourced row per (gene × area membership). (§6.5)
  function findings(W) {
    var ranked = analyse(W);
    var rows = [];
    ranked.forEach(function (p) {
      p.flags.forEach(function (f) {
        rows.push({
          sym: p.sym, name: p.name, type: p.type, composite: p.composite,
          area: f.key, label: f.label, theme: f.theme, kind: f.kind,
          strength: f.strength, sev: f.sev, source: f.source,
          top: f.top, matches: f.matches
        });
      });
    });
    // order by area (display order), then strongest membership first
    rows.sort(function (a, b) {
      var d = THEME_ORDER.indexOf(a.area) - THEME_ORDER.indexOf(b.area);
      return d !== 0 ? d : (b.strength - a.strength);
    });
    return rows;
  }

  // =========================================================================
  // 11. SYNTHESIS  (a data-derived lead + body — factual, not editorial. §6.5)
  // =========================================================================
  function synthesis(W) {
    var ranked = analyse(W);
    var n = ranked.length;
    var counts = {};
    THEME_ORDER.forEach(function (k) { counts[k] = 0; });
    ranked.forEach(function (p) { p.flags.forEach(function (f) { counts[f.key]++; }); });

    var physical = ranked.filter(function (p) { return p.type === 'Core complex' || p.type === 'Physical interactor'; });
    var topPhys = physical.slice().sort(by(function (p) { return p.phys; }))[0];
    var topComention = ranked.slice().filter(function (p) { return !p.stop; }).sort(by(function (p) { return num(p.node.comention && p.node.comention.all); }))[0];
    var core = ranked.filter(function (p) { return p.type === 'Core complex'; }).length;

    var lead = 'CtBP1 is an NAD(H)-sensing transcriptional corepressor. Across its top ' + n +
      ' STRING interactors, ' + physical.length + ' show physical-grade evidence (' + core + ' core-complex), ' +
      counts.oncology + ' carry an oncology association and ' + counts.aging + ' a curated aging/longevity link.';

    var body = [
      'Strongest physical partner by experiment+database evidence: ' + (topPhys ? topPhys.sym + ' (phys ' + topPhys.phys.toFixed(2) + ')' : 'n/a') + '.',
      'Most co-mentioned partner in the literature: ' + (topComention ? topComention.sym + ' (' + num(topComention.node.comention && topComention.node.comention.all) + ' papers)' : 'n/a') + '.',
      'Disease-area exposure (by gene count): ' + THEME_ORDER.map(function (k) { return THEMES[k].label + ' ' + counts[k]; }).join(' · ') + '.'
    ].join(' ');

    return { lead: lead, body: body, counts: counts, total: n };
  }

  // =========================================================================
  // public surface
  // =========================================================================
  root.CTBP1_ENGINE = {
    // constants / config
    HUB: HUB, STOPLIST: STOPLIST.slice(), DEFAULT_W: DEFAULT_W,
    THEMES: THEMES, THEME_ORDER: THEME_ORDER, MECH: MECH, RE: RE,
    THRESH: THRESH, FLOOR_HARD: FLOOR_HARD, FLOOR_SOFT: FLOOR_SOFT,
    maxima: { MAXLIT: MAXLIT, MAXCTX: MAXCTX },
    // pure functions
    classify: classify,
    connection: connection,
    composite: composite,
    analyse: analyse,
    path: path,
    discoveries: discoveries,
    themeSummary: themeSummary,
    themeExposure: themeExposure,
    synthesis: synthesis,
    findings: findings,
    // low-level helpers exposed for the harness
    flagsFor: flagsFor,
    profile: profile,
    _profiles: function () { return PROFILES; }
  };

})(typeof window !== 'undefined' ? window : globalThis);
