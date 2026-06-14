#!/usr/bin/env python3
"""Bundle a data-driven Aging / Longevity signal per gene from the Human Ageing Genomic Resources
(HAGR), so the Aging lens is sourced — not a keyword guess on function text (which misses FOXO3,
TP53, even CtBP1 itself, because UniProt/OT function descriptions don't use aging vocabulary).

Two authorities, applied uniformly (membership = "is this gene listed", yes/no):
  - GenAge human  (genomics.senescence.info) — curated genes linked to human ageing; carries a
                  short "why" + a GenAge id.
  - LongevityMap  (genomics.senescence.info) — human longevity genetic-association studies; we
                  keep genes with a SIGNIFICANT association and store the supporting PubMed ids.

Sets node.aging = {genage:bool, longevity:bool, why, id, pmids[]} on member genes only. Stdlib only.
"""
import urllib.request, zipfile, io, csv, json, re, os

HERE = os.path.dirname(os.path.abspath(__file__)); APP = os.path.join(HERE, '..', 'app-data.js')
GENAGE = 'https://genomics.senescence.info/genes/human_genes.zip'
LONGEV = 'https://genomics.senescence.info/longevity/longevity_genes.zip'

def fetch_csv(url):
    z = zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(url, timeout=60).read()))
    fn = [n for n in z.namelist() if n.endswith('.csv')][0]
    return list(csv.reader(io.TextIOWrapper(z.open(fn), 'utf-8')))

# ---- GenAge human: curated ageing genes ----
g_rows = fetch_csv(GENAGE)
g_hdr = g_rows[0]
ci = {c.lower().strip(): i for i, c in enumerate(g_hdr)}
SYM, WHY, GID = ci.get('symbol'), ci.get('why'), ci.get('genage id')
genage = {}
for r in g_rows[1:]:
    if len(r) > SYM and r[SYM]:
        genage[r[SYM].upper()] = {'why': (r[WHY] if WHY is not None and len(r) > WHY else '') or '', 'id': r[GID] if GID is not None and len(r) > GID else ''}
print('GenAge human genes:', len(genage))

# ---- LongevityMap: human longevity-association studies (keep SIGNIFICANT only) ----
l_rows = fetch_csv(LONGEV)
l_hdr = l_rows[0]
li = {c.lower().strip(): i for i, c in enumerate(l_hdr)}
GI, AI, PI = li.get('gene(s)'), li.get('association'), li.get('pubmed')
assoc_vals = {}
longevity = {}
for r in l_rows[1:]:
    if GI is None or len(r) <= GI:
        continue
    assoc = (r[AI] if AI is not None and len(r) > AI else '').strip().lower()
    assoc_vals[assoc] = assoc_vals.get(assoc, 0) + 1
    if 'significant' not in assoc or 'non-significant' in assoc or 'not significant' in assoc:
        continue
    pmid = (r[PI] if PI is not None and len(r) > PI else '').strip()
    for g in re.split(r'[,;/\s]+', r[GI]):
        g = g.upper().strip()
        if not g:
            continue
        e = longevity.setdefault(g, set())
        if pmid.isdigit():
            e.add(pmid)
print('LongevityMap association values:', assoc_vals)
print('LongevityMap genes (significant):', len(longevity))

# ---- bundle onto member nodes ----
raw = open(APP).read()
m = re.match(r'\s*window\.CTBP1_DATA\s*=\s*(\{.*\})\s*;\s*$', raw, re.S)
data = json.loads(m.group(1))
hits = []
for n in data['nodes']:
    s = n['sym'].upper()
    ga, lm = genage.get(s), longevity.get(s)
    if not ga and not lm:
        n.pop('aging', None)
        continue
    rec = {'genage': bool(ga), 'longevity': bool(lm)}
    if ga:
        if ga['why']: rec['why'] = ga['why'][:300]
        if ga['id']: rec['id'] = ga['id']
    if lm:
        rec['pmids'] = sorted(lm)[:6]
    n['aging'] = rec
    hits.append(n['sym'])

open(APP, 'w').write('window.CTBP1_DATA = ' + json.dumps(data, separators=(',', ':')) + ';\n')
print('Aging/Longevity member genes (%d):' % len(hits), ', '.join(hits))
