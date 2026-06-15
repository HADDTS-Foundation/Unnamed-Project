#!/usr/bin/env python3
"""Pull stronger, more honest evidence into app-data.js (offline snapshot).

Run after build_data.py + refs.py. Adds, in place:

  node.comention = {title, abs, all}   tiered Europe PMC "documents mentioning BOTH
                                        CTBP1 and <gene>" counts — synonym-aware, so
                                        TP53 is also counted as p53. 'all' is loose
                                        full-text co-occurrence; 'abs'/'title' are the
                                        meaningful tiers.
  node.syn       = [...]                the partner synonyms actually searched (display)
  node.lit       = comention.all        (keeps the engine's literature score in sync)
  node.refs      = [...]                re-fetched to prefer papers with BOTH genes in
                                        title/abstract (genuinely about the pair)
  node.intact    = {type,direct,miscore,methods,pmids,count}  curated EXPERIMENTAL
                                        interaction evidence from IntAct (the gold
                                        standard: 'direct interaction' etc. + method + PMID)
  gene.agingRefs = [...]                CTBP1 longevity/redox literature, ortholog-aware
                                        (incl. the C. elegans ctbp-1 life-span paper a
                                        human-only 'CTBP1' search misses)

Stdlib only.
"""
import urllib.request, urllib.parse, json, time, re, sys, os

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, '..', 'app-data.js')
PMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search?'
INTACT = 'https://www.ebi.ac.uk/intact/ws/interaction/findInteractions/'

def _try(fn, n=6, base=0.8):
    for k in range(n):
        try: return fn()
        except Exception:
            if k == n - 1: raise
            time.sleep(base * (k + 1))

def _get(url):
    return json.load(urllib.request.urlopen(url, timeout=40))

# ---------- Europe PMC ----------
def pmc_count(query):
    u = PMC + urllib.parse.urlencode({'query': query, 'format': 'json', 'resultType': 'idlist', 'pageSize': 1})
    return _try(lambda: _get(u)).get('hitCount', 0)

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
            'y': r.get('pubYear'), 'j': r.get('journalTitle') or r.get('source'), 'c': r.get('citedByCount', 0)}

def pmc_search(query, n, sort=None):
    p = {'query': query, 'format': 'json', 'resultType': 'lite', 'pageSize': n}
    if sort: p['sort'] = sort
    j = _try(lambda: _get(PMC + urllib.parse.urlencode(p)))
    return [x for x in (rec(r) for r in j.get('resultList', {}).get('result', [])) if x['pmid']]

# ---------- synonyms (MyGene aliases, filtered) ----------
def mygene_aliases(syms):
    out = {}
    for i in range(0, len(syms), 90):
        chunk = syms[i:i + 90]
        data = urllib.parse.urlencode({'q': ','.join(chunk), 'scopes': 'symbol',
                                       'fields': 'symbol,alias', 'species': 'human'}).encode()
        req = urllib.request.Request('https://mygene.info/v3/query', data=data, method='POST')
        res = _try(lambda: json.load(urllib.request.urlopen(req, timeout=40)))
        for r in (res if isinstance(res, list) else [res]):
            sym = r.get('symbol') or r.get('query')
            al = r.get('alias') or []
            out[sym] = al if isinstance(al, list) else [al]
        time.sleep(0.1)
    return out

# Curated homograph blocklist: short aliases that are well-known names for an UNRELATED gene or
# concept, so searching them inflates the full-text co-mention with off-target papers. These can't
# be caught syntactically — 'p53' (good, =TP53) and 'P18' (bad) share the same shape — so the list
# is hand-verified: GLP1=glucagon-like peptide-1 (GCG); P18=generic/CDKN2C; PC2=PCSK2/PKD2;
# PH1=primary hyperoxaluria/PHF1; C21=chromosome-21/steroid; DC42≈CDC42; IRA1=yeast regulator.
AMBIG_ALIAS = {'GLP1', 'P18', 'PC2', 'PH1', 'C21', 'DC42', 'IRA1'}
def ok_alias(a):
    if not a or len(a) < 3: return False
    if a.upper() in AMBIG_ALIAS: return False    # verified homograph for an unrelated gene
    if not re.match(r'^[A-Za-z0-9][A-Za-z0-9-]{2,}$', a): return False
    if re.search(r'\d', a): return True          # has a digit -> specific (p53, SIR2, BCC7, G9A)
    return len(a) >= 5                            # long pure-alpha -> probably specific (avoids BARS/MFH/MEN)

def syn_clause(sym, aliases):
    terms = [sym] + [a for a in (aliases or []) if ok_alias(a) and a.upper() != sym.upper()]
    seen, uniq = set(), []
    for t in terms:
        if t.upper() not in seen:
            seen.add(t.upper()); uniq.append(t)
    uniq = uniq[:6]
    clause = '(' + ' OR '.join('"%s"' % t for t in uniq) + ')'
    return clause, uniq[1:]   # clause, extra-synonyms-for-display

# ---------- IntAct ----------
TYPE_RANK = {'direct interaction': 5, 'physical association': 4, 'association': 3, 'proximity': 2, 'colocalization': 1}
def intact_ctbp1():
    rows, page, PS = [], 0, 400
    while True:
        u = INTACT + 'CTBP1?' + urllib.parse.urlencode({'page': page, 'pageSize': PS})
        j = _try(lambda: _get(u))
        content = j.get('content', [])
        rows += content
        if page >= (j.get('totalPages', 1) - 1) or not content:
            break
        page += 1
        time.sleep(0.1)
    return rows

def is_ctbp1(mol, uid):
    return (mol or '').upper() == 'CTBP1' or 'Q13363' in (uid or '')

# =========================================================================
raw = open(APP).read()
m = re.match(r'\s*window\.CTBP1_DATA\s*=\s*(\{.*\})\s*;\s*$', raw, re.S)
if not m:
    print('ERROR: cannot parse app-data.js'); sys.exit(1)
data = json.loads(m.group(1))
nodes = data['nodes']

# Exclude the CTBP1-prefixed lncRNA loci (CTBP1-AS2 / CTBP1-DT / CTBP1-AS1), which token-match
# "CTBP1" in Europe PMC and otherwise inflate co-occurrence counts with unrelated antisense-RNA
# papers. ("CTBP1-AS" is unusable as an exclusion — "AS" is a stopword and removes everything.)
# These three query strings MUST stay identical to cmQueries() in app.js so the UI's per-tier
# links reproduce the bundled counts exactly.
def cm_queries(clause):
    return (
        '(TITLE:"CTBP1" NOT TITLE:"CTBP1-AS2" NOT TITLE:"CTBP1-DT" NOT TITLE:"CTBP1-AS1") AND TITLE:%s' % clause,
        '(TITLE:"CTBP1" OR ABSTRACT:"CTBP1") AND (TITLE:%s OR ABSTRACT:%s) NOT "CTBP1-AS2" NOT "CTBP1-DT" NOT "CTBP1-AS1"' % (clause, clause),
        '"CTBP1" AND %s NOT "CTBP1-AS2" NOT "CTBP1-DT" NOT "CTBP1-AS1"' % clause,
    )

# ---- 1. synonyms ----
print('fetching aliases…')
aliases = mygene_aliases([n['sym'] for n in nodes])

# ---- 2. IntAct (once) ----
print('fetching IntAct interactions…')
ia_rows = _try(intact_ctbp1)
print('  IntAct rows for CTBP1:', len(ia_rows))
ia = {}   # partner SYM -> aggregate
for r in ia_rows:
    a_is = is_ctbp1(r.get('moleculeA'), r.get('idA') or r.get('uniqueIdA'))
    b_is = is_ctbp1(r.get('moleculeB'), r.get('idB') or r.get('uniqueIdB'))
    if a_is == b_is:
        continue                                   # both or neither -> skip (homodimer/none)
    partner = (r.get('moleculeB') if a_is else r.get('moleculeA')) or ''
    ptax = r.get('taxIdB') if a_is else r.get('taxIdA')
    ctax = r.get('taxIdA') if a_is else r.get('taxIdB')
    if ctax != 9606 or ptax != 9606:               # human–human only, for a credible claim
        continue
    sym = partner.upper()
    typ = (r.get('type') or '').lower()
    e = ia.setdefault(sym, {'type': 'association', 'rank': 0, 'miscore': 0, 'methods': set(), 'pmids': set(), 'count': 0})
    e['count'] += 1
    if TYPE_RANK.get(typ, 0) > e['rank']:
        e['rank'] = TYPE_RANK.get(typ, 0); e['type'] = typ
    e['miscore'] = max(e['miscore'], r.get('intactMiscore') or 0)
    if r.get('detectionMethod'): e['methods'].add(r['detectionMethod'])
    if r.get('publicationPubmedIdentifier'): e['pmids'].add(str(r['publicationPubmedIdentifier']))
print('  human–human partners with IntAct evidence:', len(ia),
      '| direct:', sum(1 for v in ia.values() if v['type'] == 'direct interaction'))

# ---- 3. per-node: tiered counts + better refs + intact ----
print('per-node Europe PMC tiers + refs…')
done = 0
for n in nodes:
    clause, extra = syn_clause(n['sym'], aliases.get(n['sym']))
    n['syn'] = extra
    qT, qA, qAll = cm_queries(clause)
    title = pmc_count(qT)
    absc  = pmc_count(qA)
    allc  = pmc_count(qAll)
    n['comention'] = {'title': title, 'abs': absc, 'all': allc}
    n['lit'] = allc
    n.pop('refHit', None)
    # refs: prefer papers with both in title/abstract (genuinely about the pair), most-cited
    refs = pmc_search(qA, 5, sort='CITED desc')
    if len(refs) < 2:
        refs = pmc_search(qAll, 5)   # fall back to loose relevance
    n['refs'] = refs[:4]
    sym = n['sym'].upper()
    if sym in ia:
        e = ia[sym]
        n['intact'] = {'type': e['type'], 'direct': e['type'] == 'direct interaction',
                       'miscore': round(e['miscore'], 2), 'count': e['count'],
                       'methods': sorted(e['methods'])[:3], 'pmids': sorted(e['pmids'])[:3]}
    else:
        n.pop('intact', None)
    done += 1
    if done % 12 == 0:
        print('  %d/%d  %s  title/abs/all=%d/%d/%d  intact=%s' %
              (done, len(nodes), n['sym'], title, absc, allc, n.get('intact', {}).get('type', '-')))
    time.sleep(0.08)

# ---- 4. CTBP1 aging / longevity literature (ortholog-aware, title/abstract scoped) ----
print('fetching CTBP1 aging literature…')
cterm = '(TITLE:"CtBP1" OR TITLE:"CTBP-1" OR TITLE:"CtBP-1" OR ABSTRACT:"CtBP1" OR ABSTRACT:"CtBP-1" OR ABSTRACT:"CTBP-1" OR ABSTRACT:"C-terminal binding protein 1")'
aterm = '(TITLE:"life span" OR TITLE:lifespan OR TITLE:longevity OR TITLE:aging OR TITLE:ageing OR TITLE:senescence OR ABSTRACT:"life span" OR ABSTRACT:lifespan OR ABSTRACT:longevity OR ABSTRACT:aging OR ABSTRACT:ageing OR ABSTRACT:senescence)'
aging = pmc_search('%s AND %s NOT "CTBP1-AS2" NOT "CTBP1-DT" NOT "CTBP1-AS1"' % (cterm, aterm), 8, sort='CITED desc')
if not any(r['pmid'] == '19164523' for r in aging):     # ensure the landmark worm paper is present
    worm = pmc_search('EXT_ID:19164523 AND SRC:MED', 1)
    if worm: aging = worm + aging
data['gene']['agingRefs'] = aging[:6]
print('  aging refs:', len(data['gene']['agingRefs']), '| worm paper present:',
      any(r['pmid'] == '19164523' for r in data['gene']['agingRefs']))

out = 'window.CTBP1_DATA = ' + json.dumps(data, separators=(',', ':')) + ';\n'
open(APP, 'w').write(out)
print('wrote app-data.js bytes:', len(out))
for s in ['TP53', 'FOXP1', 'HDAC1', 'ACTL6B']:
    n = next((x for x in nodes if x['sym'] == s), None)
    if n: print('  %-7s comention=%s syn=%s intact=%s' % (s, n['comention'], n.get('syn'), n.get('intact', {}).get('type', '-')))
