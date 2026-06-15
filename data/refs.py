#!/usr/bin/env python3
"""Fetch REAL references from Europe PMC and inject them into app-data.js.

For every gene we record the actual papers behind the numbers the engine
reports — the co-publications with CTBP1 (the literature co-mention count) and
the UniProt function-evidence PMIDs already embedded in the snapshot — so a
researcher can click straight through to the primary literature instead of
trusting a bare count. Idempotent: re-run safely; pass --force to refetch.
Standard library only, matching the rest of data/.

Adds, in place:
  gene.refs / node.refs       -> [{pmid,t,a,y,j,c}]  most relevant co-pubs
  gene.funcRefs / node.funcRefs-> resolved UniProt function-evidence PMIDs
  node.refHit                 -> Europe PMC hit count for "CTBP1" AND "<gene>"
"""
import urllib.request, urllib.parse, json, time, re, sys, os

PMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search?'
HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, '..', 'app-data.js')

def _try(fn, n=6, base=0.8):
    for k in range(n):
        try: return fn()
        except Exception:
            if k == n - 1: raise
            time.sleep(base * (k + 1))

def _get(params):
    return json.load(urllib.request.urlopen(PMC + urllib.parse.urlencode(params), timeout=30))

def short_auth(s):
    if not s: return None
    first = s.split(',')[0].strip().rstrip('.')
    return first + (' et al.' if s.count(',') >= 1 else '')

def trim(s, n=120):
    if not s: return None
    s = re.sub(r'\s+', ' ', s).strip()
    return s[:n].rstrip() + ('…' if len(s) > n else '')

def rec(r):
    pmid = r.get('pmid') or (r.get('id') if r.get('source') == 'MED' else None)
    return {'pmid': pmid, 't': trim(r.get('title'), 120), 'a': short_auth(r.get('authorString')),
            'y': r.get('pubYear'), 'j': r.get('journalTitle') or r.get('source'),
            'c': r.get('citedByCount', 0)}

def search(query, n, sort=None):
    p = {'query': query, 'format': 'json', 'resultType': 'lite', 'pageSize': n}
    if sort: p['sort'] = sort
    j = _try(lambda: _get(p))
    res = [rec(r) for r in j.get('resultList', {}).get('result', [])]
    return [r for r in res if r['pmid']], j.get('hitCount', 0)

# Match PubMed:<id> but reject ids the snapshot's truncation cut mid-number. The lookahead
# must forbid BOTH a following digit AND the ellipsis: with only (?!…), a greedy \d+ on
# "PubMed:20154…" backtracks to "2015" (next char "4" ≠ "…") and matches a bogus PMID 2015.
# (?![\d…]) blocks that — every shorter prefix is followed by a digit, the full run by "…".
# >=4 digits is a backstop.
PMID_RE = re.compile(r'PubMed:(\d+)(?![\d…])')
def inline_pmids(*texts):
    out = []
    for t in texts:
        items = t if isinstance(t, list) else [t]
        for x in items: out += [p for p in PMID_RE.findall(x or '') if len(p) >= 4]
    seen = []
    for p in out:
        if p not in seen: seen.append(p)
    return seen

def resolve_pmids(pmids):
    out, B = {}, 20
    for i in range(0, len(pmids), B):
        batch = pmids[i:i + B]
        q = '(' + ' OR '.join('EXT_ID:%s' % p for p in batch) + ') AND SRC:MED'
        try:
            j = _try(lambda: _get({'query': q, 'format': 'json', 'resultType': 'lite', 'pageSize': B}))
            for r in j.get('resultList', {}).get('result', []):
                if r.get('pmid'): out[r['pmid']] = rec(r)
        except Exception as ex:
            print('  pmid resolve batch failed:', str(ex)[:60])
        time.sleep(0.12)
    return out

# ---- load app-data.js (pure JSON after the assignment) ----
raw = open(APP).read()
m = re.match(r'\s*window\.CTBP1_DATA\s*=\s*(\{.*\})\s*;\s*$', raw, re.S)
if not m:
    print('ERROR: could not parse app-data.js'); sys.exit(1)
data = json.loads(m.group(1))
force = '--force' in sys.argv

# ---- resolve every inline UniProt function PMID once ----
allpm = set(inline_pmids(data['gene'].get('uniprotFunc'), data['gene'].get('subunit')))
for n in data['nodes']:
    allpm.update(inline_pmids(n.get('func')))
print('inline function PMIDs to resolve:', len(allpm))
resolved = resolve_pmids(sorted(allpm)) if allpm else {}

def funcrefs(pmids, cap):
    out = [resolved[p] for p in pmids if p in resolved]
    out.sort(key=lambda r: -(r.get('c') or 0))
    return out[:cap]

# Co-mention reference queries — synonym-aware and tier-matched to node.comention, so the papers
# shown come from the SAME pool as the counts and the "Terms searched for X" line (earlier the refs
# used a bare '"CTBP1" AND "SYM"' query with NO synonyms, so it ignored the very aliases the tool
# advertised — e.g. TCF7L2's canonical name TCF-4 — and returned only a handful). Prefer the most-
# cited papers with both genes in TITLE/ABSTRACT; widen to full text only when that is sparse.
NOTLNC = ' NOT "CTBP1-AS2" NOT "CTBP1-DT" NOT "CTBP1-AS1"'
def _syn_clause(sym, syns):
    return '(' + ' OR '.join('"%s"' % t for t in [sym] + list(syns or [])) + ')'
def ref_query_ta(sym, syns):
    P = _syn_clause(sym, syns)
    return '(TITLE:"CTBP1" OR ABSTRACT:"CTBP1") AND (TITLE:%s OR ABSTRACT:%s)%s' % (P, P, NOTLNC)
def ref_query_all(sym, syns):
    return '"CTBP1" AND %s%s' % (_syn_clause(sym, syns), NOTLNC)

# ---- hub: landmark CTBP1 papers (most cited) ----
if force or not data['gene'].get('refs'):
    refs, _ = search('"CTBP1"', 6, sort='CITED desc')
    data['gene']['refs'] = refs[:5]
data['gene']['funcRefs'] = funcrefs(inline_pmids(data['gene'].get('uniprotFunc'), data['gene'].get('subunit')), 6)
print('hub refs:', len(data['gene'].get('refs', [])), 'funcRefs:', len(data['gene']['funcRefs']))

# ---- per-node co-publication references (the papers behind the co-mention count) ----
done = 0
for n in data['nodes']:
    n['funcRefs'] = funcrefs(inline_pmids(n.get('func')), 3)
    if n.get('refs') and not force:
        continue
    syns = n.get('syn') or []
    refs, hit = search(ref_query_ta(n['sym'], syns), 8, sort='CITED desc')  # key co-mention papers, most cited
    if len(refs) < 3:                                       # sparse in title/abstract -> widen to full text
        more, _ = search(ref_query_all(n['sym'], syns), 8)
        seen = {r['pmid'] for r in refs}
        for r in more:
            if r['pmid'] not in seen:
                refs.append(r); seen.add(r['pmid'])
    n['refs'] = refs[:5]
    n['refHit'] = hit
    done += 1
    if done % 10 == 0:
        print('  %d fetched… last=%s refs=%d hit=%d' % (done, n['sym'], len(n['refs']), hit))
    time.sleep(0.12)

out = 'window.CTBP1_DATA = ' + json.dumps(data, separators=(',', ':')) + ';\n'
open(APP, 'w').write(out)
print('wrote app-data.js bytes:', len(out), ' nodes with refs:', sum(1 for n in data['nodes'] if n.get('refs')))
for s in ['FOXP1', 'TP53', 'ACTL6B']:
    n = next((x for x in data['nodes'] if x['sym'] == s), None)
    if n: print(s, '->', [(r['y'], (r['t'] or '')[:42]) for r in n.get('refs', [])[:2]], 'hit', n.get('refHit'))
