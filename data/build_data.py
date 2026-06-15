import json, re, time
def load(f): return json.load(open(f))
partsF=sorted(load('data/string_partners_full.json'),key=lambda x:-x['score'])
enr=load('data/enrichment.json')
netF=load('data/string_network_full.json')
up=load('data/uniprot.json')
mg=load('data/mygene.json')
otc=load('data/ot_ctbp1.json')['data']['target']

TOPN=250   # top-N STRING interactors to profile (was 100)
keep=['CTBP1']+[x['preferredName_B'] for x in partsF[:TOPN]]
keepset=set(keep)
# CTBP1-centric channel scores
chan={x['preferredName_B']:x for x in partsF}

def trunc(s,n=240):
    if not s: return None
    s=re.sub(r'\s+',' ',s).strip()
    return s[:n]+('…' if len(s)>n else '')

nodes=[]
for i,sym in enumerate([x['preferredName_B'] for x in partsF[:TOPN]]):
    e=enr.get(sym,{}); c=chan.get(sym,{})
    nodes.append({
        'sym':sym,'name':e.get('name'),'ensembl':e.get('ensembl'),
        'rank':i+1,
        's':{'c':round(c.get('score',0),3),'e':c.get('escore',0),'t':c.get('tscore',0),
             'd':c.get('dscore',0),'a':c.get('ascore',0),'p':c.get('pscore',0),
             'n':c.get('nscore',0),'f':c.get('fscore',0)},
        'lit': e.get('litCTBP1') if isinstance(e.get('litCTBP1'),int) else 0,
        'dz': e.get('diseaseCount'),
        'tract':[t for t in (e.get('tract') or []) if t],
        'areas': e.get('themeAreas') or {},
        'dis': e.get('topDiseases') or [],
        'func': trunc(e.get('func'),200),
    })

# partner-partner edges (exclude CTBP1; that's in node.s.c)
edges=[]
seen=set()
for ed in netF:
    a,b=ed['preferredName_A'],ed['preferredName_B']
    if a not in keepset or b not in keepset: continue
    if a=='CTBP1' or b=='CTBP1': continue
    k=tuple(sorted((a,b)))
    if k in seen: continue
    seen.add(k)
    edges.append({'a':k[0],'b':k[1],'s':round(ed['score'],3)})

# CTBP1 identity from UniProt
def comments(t):
    out=[]
    for c in up.get('comments',[]):
        if c.get('commentType')==t:
            for tx in c.get('texts',[]): out.append(tx['value'])
            if t=='DISEASE' and c.get('disease'):
                d=c['disease']; out.append({'id':d.get('diseaseId'),'acr':d.get('acronym'),'desc':d.get('description')})
    return out
func=comments('FUNCTION'); cof=comments('COFACTOR'); dis=comments('DISEASE'); sub=comments('SUBUNIT')
cofname=None
for c in up.get('comments',[]):
    if c.get('commentType')=='COFACTOR':
        for co in c.get('cofactors',[]): cofname=co.get('name')

go=mg.get('go',{})
def goterms(cat):
    t=go.get(cat,[]); t=t if isinstance(t,list) else [t]
    seen=[]; 
    for x in t:
        nm=x.get('term')
        if nm and nm not in seen: seen.append(nm)
    return seen[:14]
pw=mg.get('pathway',{}); rx=pw.get('reactome',[]) if isinstance(pw,dict) else []
rx=rx if isinstance(rx,list) else [rx]
reactome=[]
for r in rx:
    nm=r.get('name')
    if nm and nm not in reactome: reactome.append(nm)

ta={}
for row in otc['associatedDiseases']['rows']:
    for a in row['disease']['therapeuticAreas']: ta[a['name']]=round(ta.get(a['name'],0)+row['score'],4)
gene={
 'sym':'CTBP1','name':'C-terminal binding protein 1',
 'summary':trunc(mg.get('summary'),600),
 'uniprotFunc':trunc(func[0] if func else None,600),
 'cofactor':cofname,'cofactorNote':trunc(cof[0] if cof else None,200),
 'disease':(dis[-1] if dis and isinstance(dis[-1],dict) else None),
 'subunit':[trunc(s,300) for s in sub][:4],
 'go':{'MF':goterms('MF'),'BP':goterms('BP'),'CC':goterms('CC')},
 'reactome':reactome[:12],
 'ids':{'ensembl':'ENSG00000159692','entrez':'1487','uniprot':'Q13363','string':'9606.ENSP00000290921'},
 'litTotal':2779,
 'diseaseCount':otc['associatedDiseases']['count'],
 'areas':dict(sorted(ta.items(),key=lambda x:-x[1])[:10]),
 'dis':[{'n':r['disease']['name'],'s':round(r['score'],3),
         'ta':[a['name'] for a in r['disease']['therapeuticAreas']]} for r in otc['associatedDiseases']['rows'][:18]],
 'tract':[x['label'] for x in otc.get('tractability',[]) if x['value']],
}
data={'gene':gene,'nodes':nodes,'edges':edges,
 'meta':{'date':time.strftime('%Y-%m-%d'),'species':'Homo sapiens (9606)','neighborhood':TOPN,
   'sources':['STRING v12 (string-db.org)','Open Targets Platform v4','Europe PMC','MyGene.info','UniProtKB Q13363','NCBI Gene 1487'],
   'channelLegend':{'e':'Experiments','d':'Curated DBs','t':'Text-mining','a':'Co-expression','p':'Gene fusion','n':'Neighborhood','f':'Co-occurrence'},
   'edgeCount':len(edges),'nodeCount':len(nodes)+1}}
js='window.CTBP1_DATA = '+json.dumps(data,separators=(',',':'))+';\n'
open('app-data.js','w').write(js)
print('app-data.js bytes:',len(js))
print('nodes:',len(nodes),'edges:',len(edges))
print('CTBP1 areas:',list(gene['areas'].items())[:5])
print('CTBP1 GO-CC:',gene['go']['CC'][:6])
print('sample node ACTL6B:',[n for n in nodes if n['sym']=='ACTL6B'])
