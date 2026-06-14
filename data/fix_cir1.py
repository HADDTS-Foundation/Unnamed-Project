#!/usr/bin/env python3
"""One-off: resolve the CIR1 node, which the build-time symbol->Ensembl mapping missed.
HGNC renamed CIR1 -> CIRSR, so MyGene symbol-scope lookup of 'CIR1' returns notfound and
the node was left with ensembl=null (=> empty Open Targets areas => "unclassified", degraded
links). Verified IDs (MyGene gene/9541 + Open Targets target(ENSG00000138433) -> CIRSR):
  Ensembl ENSG00000138433 · Entrez 9541 · UniProt Q86X95 · OMIM 605228
NOTE: the reviewer's suggested Ensembl ENSG00000080438 is WRONG (returns null in Open Targets);
the correct one is ENSG00000138433. Display symbol stays 'CIR1' (STRING's name); links resolve
via the IDs. Re-fetches OT areas/dis/func/tract + Reactome pathways + HPO phenotypes in the exact
shapes the pipeline (build_data/enrich/diseases/annotate) uses. Stdlib only."""
import urllib.request, urllib.parse, json, time, re, os

HERE = os.path.dirname(os.path.abspath(__file__)); APP = os.path.join(HERE, '..', 'app-data.js')
OT = 'https://api.platform.opentargets.org/api/v4/graphql'
ENS, ENTREZ, UNIPROT, MIM = 'ENSG00000138433', '9541', 'Q86X95', '605228'

def _try(fn, n=3):
    for k in range(n):
        try: return fn()
        except Exception:
            if k == n - 1: raise
            time.sleep(0.7 * (k + 1))

def ot():
    q = ('{target(ensemblId:"%s"){approvedName functionDescriptions tractability{label value} '
         'associatedDiseases(page:{index:0,size:20}){count rows{score disease{name therapeuticAreas{name}}}}}}' % ENS)
    req = urllib.request.Request(OT, data=json.dumps({'query': q}).encode(),
                                 headers={'Content-Type': 'application/json'}, method='POST')
    return json.load(urllib.request.urlopen(req, timeout=40))['data']['target']

def reactome():
    j = _try(lambda: json.load(urllib.request.urlopen(
        'https://mygene.info/v3/gene/%s?fields=pathway.reactome' % ENTREZ, timeout=30)))
    rx = (j.get('pathway') or {}).get('reactome') or []; rx = rx if isinstance(rx, list) else [rx]
    out = []
    for r in rx:
        nm = r.get('name')
        if nm and nm not in out: out.append(nm)
    return out[:5]

def hpo():
    try:
        j = _try(lambda: json.load(urllib.request.urlopen(
            'https://ontology.jax.org/api/network/annotation/NCBIGene:%s' % ENTREZ, timeout=30)))
    except Exception:
        return [], 0
    ph = j.get('phenotypes') or []
    return [p.get('name') for p in ph if p.get('name')][:12], len(ph)

raw = open(APP).read()
m = re.match(r'\s*window\.CTBP1_DATA\s*=\s*(\{.*\})\s*;\s*$', raw, re.S)
data = json.loads(m.group(1))
n = next(x for x in data['nodes'] if x['sym'] == 'CIR1')

t = _try(ot)
ta, dz = {}, []
for row in t['associatedDiseases']['rows']:
    dz.append({'n': row['disease']['name'], 's': round(row['score'], 3)})
    for a in row['disease']['therapeuticAreas']:
        ta[a['name']] = round(ta.get(a['name'], 0) + row['score'], 4)

n['ensembl'] = ENS; n['entrez'] = ENTREZ; n['uniprot'] = UNIPROT; n['mim'] = MIM
if t.get('approvedName'): n['name'] = t['approvedName']
n['areas'] = dict(sorted(ta.items(), key=lambda x: -x[1])[:8])
n['dis'] = dz[:20]
n['dz'] = t['associatedDiseases']['count']
fd = t.get('functionDescriptions') or []
if fd: n['func'] = fd[0][:200]
n['tract'] = [x['label'] for x in (t.get('tractability') or []) if x['value']]
n['pathways'] = reactome()
ph, phn = hpo(); n['phenotypes'] = ph; n['phenoCount'] = phn

open(APP, 'w').write('window.CTBP1_DATA = ' + json.dumps(data, separators=(',', ':')) + ';\n')
print('CIR1 fixed:')
print('  ids   ens', n['ensembl'], 'entrez', n['entrez'], 'uniprot', n['uniprot'], 'mim', n['mim'])
print('  name ', n['name'])
print('  areas', list(n['areas'].items())[:4])
print('  dz   ', n['dz'], '| top dis', [d['n'] for d in n['dis'][:3]])
print('  pathways', n['pathways'][:3])
print('  phenotypes', n['phenoCount'], n['phenotypes'][:4])
