#!/usr/bin/env python3
"""Deepen each partner gene's Open Targets disease list so the engine's disease
FLAGS are comprehensive. build_data.py keeps only the top-8 associations, which
truncates real signal away — e.g. autism sits at OT rank ~15-22 for several
CTBP1 partners (FOXP1, TBL1XR1) and never surfaced. This re-fetches the named
associations (top-20) and widens node.dis IN PLACE. The flag logic is unchanged;
it simply now sees the associations that were always in the data. Stdlib only.

Themes are untouched (they come from node.areas, not node.dis), so this only
makes flags more complete — it does not invent anything.
"""
import urllib.request, json, time, re, sys, os

OT = 'https://api.platform.opentargets.org/api/v4/graphql'
HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, '..', 'app-data.js')
N = 20

def _try(fn, n=6):
    for k in range(n):
        try: return fn()
        except Exception:
            if k == n - 1: raise
            time.sleep(0.7 * (k + 1))

def ot_dis(ens):
    q = '{target(ensemblId:"%s"){associatedDiseases(page:{index:0,size:%d}){rows{score disease{name}}}}}' % (ens, N)
    req = urllib.request.Request(OT, data=json.dumps({'query': q}).encode(),
                                 headers={'Content-Type': 'application/json'}, method='POST')
    j = json.load(urllib.request.urlopen(req, timeout=40))
    rows = (((j.get('data') or {}).get('target') or {}).get('associatedDiseases') or {}).get('rows') or []
    return [{'n': r['disease']['name'], 's': round(r['score'], 3)} for r in rows]

raw = open(APP).read()
m = re.match(r'\s*window\.CTBP1_DATA\s*=\s*(\{.*\})\s*;\s*$', raw, re.S)
if not m:
    print('ERROR: could not parse app-data.js'); sys.exit(1)
data = json.loads(m.group(1))

AUT = re.compile(r'autism|asperger|\bASD\b', re.I)
done = auts = 0
for n in data['nodes']:
    ens = n.get('ensembl')
    if not ens:
        continue
    try:
        dis = _try(lambda: ot_dis(ens))
    except Exception as ex:
        print('  err', n['sym'], str(ex)[:40]); continue
    if dis:
        n['dis'] = dis
    if any(AUT.search(d['n']) for d in n.get('dis', [])):
        auts += 1
    done += 1
    if done % 15 == 0:
        print('  %d/%d  last=%s dis=%d' % (done, len(data['nodes']), n['sym'], len(n['dis'])))
    time.sleep(0.1)

out = 'window.CTBP1_DATA = ' + json.dumps(data, separators=(',', ':')) + ';\n'
open(APP, 'w').write(out)
print('done. nodes updated=%d, genes carrying an autism association=%d, bytes=%d' % (done, auts, len(out)))
