#!/usr/bin/env python3
"""Annotate each gene with clinical-variant + structure/pathway/OMIM data:
  node.clinvar  = {plp, vus, total}  ClinVar record counts (NCBI eutils) by significance
  node.uniprot  = reviewed UniProt accession (for AlphaFold / PDBe structure links)
  node.pathways = top Reactome pathway names (MyGene)
  node.mim      = OMIM gene id
Adds clinical variants (counts shown offline; each links to the exact ClinVar query) plus
authoritative structure / pathway / OMIM links. Run after the other data steps. Stdlib only.
"""
import urllib.request, urllib.parse, json, time, re, os

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, '..', 'app-data.js')
EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi'
# ClinVar significance filters — use the [Filter] tokens Entrez actually recognises (verified
# against esummary germline_classification: clinsig_pathogenic=Pathogenic, clinsig_likely_path=
# Likely pathogenic, clinsig_vus=Uncertain significance). The "[Clinical significance]" field is
# NOT valid — Entrez silently maps it to [All Fields] (free text), which gave wrong counts and a
# "field ignored" error in the web UI. MUST match the cvURL() builders in app.js.
PLP = '(clinsig_pathogenic[Filter] OR clinsig_likely_path[Filter])'
VUS = 'clinsig_vus[Filter]'

def _try(fn, n=6, base=0.8):
    for k in range(n):
        try: return fn()
        except Exception:
            if k == n - 1: raise
            time.sleep(base * (k + 1))

def cv_count(term):
    u = EUTILS + '?' + urllib.parse.urlencode({'db': 'clinvar', 'term': term, 'retmode': 'json', 'retmax': 0})
    j = _try(lambda: json.load(urllib.request.urlopen(u, timeout=30)))
    return int(j['esearchresult'].get('count', '0'))

def clinvar(sym):
    cv = {'plp': cv_count('%s[gene] AND %s' % (sym, PLP)),
          'vus': cv_count('%s[gene] AND %s' % (sym, VUS)),
          'total': cv_count('%s[gene]' % sym)}
    time.sleep(0.34)  # NCBI: <=3 requests/sec without an API key (3 calls above)
    return cv

def mygene(syms):
    out = {}
    for i in range(0, len(syms), 100):
        data = urllib.parse.urlencode({'q': ','.join(syms[i:i + 100]), 'scopes': 'symbol',
                                       'fields': 'symbol,entrezgene,uniprot.Swiss-Prot,MIM,pathway.reactome', 'species': 'human'}).encode()
        req = urllib.request.Request('https://mygene.info/v3/query', data=data, method='POST')
        res = _try(lambda: json.load(urllib.request.urlopen(req, timeout=40)))
        for r in (res if isinstance(res, list) else [res]):
            sym = r.get('symbol') or r.get('query')
            up = (r.get('uniprot') or {}).get('Swiss-Prot'); up = up[0] if isinstance(up, list) else up
            rx = (r.get('pathway') or {}).get('reactome') or []
            rx = rx if isinstance(rx, list) else [rx]
            out[sym] = {'entrez': r.get('entrezgene'), 'uniprot': up, 'mim': r.get('MIM'),
                        'pathways': [p.get('name') for p in rx if p.get('name')][:5]}
        time.sleep(0.1)
    return out

def hpo(entrez):
    """HPO clinical phenotype terms for a gene (granular clinical features, distinct from the
    disease-name associations). Returns top terms + total count."""
    if not entrez: return {'terms': [], 'n': 0}
    try:
        j = _try(lambda: json.load(urllib.request.urlopen(
            'https://ontology.jax.org/api/network/annotation/NCBIGene:%s' % entrez, timeout=30)))
    except Exception:
        return {'terms': [], 'n': 0}
    ph = j.get('phenotypes') or []
    return {'terms': [p.get('name') for p in ph if p.get('name')][:12], 'n': len(ph)}

# Broad Reactome "umbrella" categories — kept as a backstop only; the ContentService mapping
# endpoint already returns specific leaf pathways, but drop these if any slip through.
REACTOME_UMBRELLA = {x.upper() for x in [
    'Signal Transduction', 'Disease', 'Metabolism', 'Metabolism of proteins', 'Metabolism of RNA',
    'Cell Cycle', 'Immune System', 'Gene expression (Transcription)', 'Developmental Biology',
    'Hemostasis', 'Neuronal System', 'Vesicle-mediated transport', 'Cellular responses to stimuli',
    'Cellular responses to stress', 'Post-translational protein modification',
    'Transport of small molecules', 'Programmed Cell Death']}

def reactome_pathways(uniprot, cap=5, fallback=None):
    """Leaf pathways from Reactome's ContentService (preferred — specific, not broad umbrellas).
    fail-FAST (1 attempt, no retry-storm): Reactome's mapping endpoint can 5xx, and retrying it 6x
    wasted ~12s/gene. On any failure/empty, fall back to MyGene's reactome list (lower quality, so
    umbrella-filtered) so pathways stay populated when the ContentService endpoint is down."""
    out = []
    if uniprot:
        try:
            j = _try(lambda: json.load(urllib.request.urlopen(
                'https://reactome.org/ContentService/data/mapping/UniProt/%s/pathways?species=9606' % uniprot, timeout=20)), 1)
            if isinstance(j, list):
                for p in j:
                    nm = p.get('displayName')
                    if nm and nm not in out and nm.upper() not in REACTOME_UMBRELLA: out.append(nm)
        except Exception:
            out = []
    if not out and fallback:                       # ContentService down/empty → MyGene reactome
        for nm in (fallback if isinstance(fallback, list) else [fallback]):
            if nm and nm not in out and nm.upper() not in REACTOME_UMBRELLA: out.append(nm)
    return out[:cap]

raw = open(APP).read()
m = re.match(r'\s*window\.CTBP1_DATA\s*=\s*(\{.*\})\s*;\s*$', raw, re.S)
data = json.loads(m.group(1))
syms = [n['sym'] for n in data['nodes']]
print('fetching MyGene (uniprot/MIM/reactome)…')
mg = _try(lambda: mygene(syms + ['CTBP1']))
print('fetching ClinVar counts per gene…')
done = 0
for n in data['nodes']:
    info = mg.get(n['sym'], {})
    if info.get('entrez'): n['entrez'] = info['entrez']
    if info.get('uniprot'): n['uniprot'] = info['uniprot']
    if info.get('mim'): n['mim'] = info['mim']
    n['pathways'] = reactome_pathways(info.get('uniprot') or n.get('uniprot'), fallback=info.get('pathways'))
    n['clinvar'] = _try(lambda: clinvar(n['sym']))
    hp = hpo(info.get('entrez') or n.get('entrez')); n['phenotypes'] = hp['terms']; n['phenoCount'] = hp['n']
    time.sleep(0.12)
    done += 1
    if done % 15 == 0:
        print('  %d/%d %s clinvar=%s uniprot=%s' % (done, len(data['nodes']), n['sym'], n['clinvar'], n.get('uniprot')))
g = data['gene']; gi = mg.get('CTBP1', {})
if gi.get('mim'): g['mim'] = gi['mim']
if gi.get('uniprot'): g['ids']['uniprot'] = g['ids'].get('uniprot') or gi['uniprot']
g['clinvar'] = _try(lambda: clinvar('CTBP1'))
ghp = hpo(g['ids'].get('entrez')); g['phenotypes'] = ghp['terms']; g['phenoCount'] = ghp['n']
rp = reactome_pathways(g['ids'].get('uniprot'), 8)
if rp: g['reactome'] = rp
open(APP, 'w').write('window.CTBP1_DATA = ' + json.dumps(data, separators=(',', ':')) + ';\n')
print('done. bytes', os.path.getsize(APP))
for s in ['CTBP1', 'TP53', 'RBBP8', 'SIRT1', 'FOXP1']:
    n = data['gene'] if s == 'CTBP1' else next(x for x in data['nodes'] if x['sym'] == s)
    print(' ', s, 'uniprot', n.get('uniprot') or n.get('ids', {}).get('uniprot'), 'clinvar', n.get('clinvar'), 'pathways', (n.get('pathways') or [])[:2])
