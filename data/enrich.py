import urllib.request, urllib.parse, json, time
OT='https://api.platform.opentargets.org/api/v4/graphql'
def _try(fn, n=3):
    for k in range(n):
        try: return fn()
        except Exception as ex:
            if k==n-1: raise
            time.sleep(0.6*(k+1))
def ot(ensembl):
    q="""query($id:String!){target(ensemblId:$id){approvedSymbol approvedName functionDescriptions
      tractability{label modality value}
      associatedDiseases(page:{index:0,size:20}){count rows{score disease{name therapeuticAreas{id name}}}}}}"""
    body=json.dumps({'query':q,'variables':{'id':ensembl}}).encode()
    req=urllib.request.Request(OT, data=body, headers={'Content-Type':'application/json'}, method='POST')
    return json.load(urllib.request.urlopen(req, timeout=40))['data']['target']
def pmc(q):
    u='https://www.ebi.ac.uk/europepmc/webservices/rest/search?'+urllib.parse.urlencode({'query':q,'format':'json','resultType':'idlist','pageSize':1})
    return json.load(urllib.request.urlopen(u,timeout=30)).get('hitCount',0)
def mygene(syms):
    req=urllib.request.Request('https://mygene.info/v3/query',
        data=urllib.parse.urlencode({'q':','.join(syms),'scopes':'symbol','fields':'symbol,ensembl.gene,entrezgene','species':'human'}).encode(), method='POST')
    return json.load(urllib.request.urlopen(req,timeout=40))

part=json.load(open('data/string_partners_full.json'))
ranked=sorted(part,key=lambda x:-x['score'])
top=['CTBP1']+[x['preferredName_B'] for x in ranked[:250]]   # neighborhood size (was 90)
mg=_try(lambda: mygene(top))
sym2ens={'CTBP1':'ENSG00000159692'}
for r in mg:
    s=r.get('symbol') or r.get('query'); e=r.get('ensembl'); g=None
    if isinstance(e,dict): g=e.get('gene')
    elif isinstance(e,list):
        for it in e:
            if it.get('gene'): g=it['gene']; break
    if s and g: sym2ens.setdefault(s,g)
print('mapped',len(sym2ens),'of',len(top))

out={}; errs=0
for i,s in enumerate(top):
    rec={'rank': 0 if s=='CTBP1' else i}
    if s in sym2ens: rec['ensembl']=sym2ens[s]
    if s in sym2ens:
        try:
            t=_try(lambda: ot(sym2ens[s]))
            rec['name']=t.get('approvedName')
            fd=t.get('functionDescriptions') or []
            rec['func']=fd[0] if fd else None
            rec['tract']=[x['label'] for x in (t.get('tractability') or []) if x['value']]
            rec['diseaseCount']=t['associatedDiseases']['count']
            ta={}; dz=[]
            for row in t['associatedDiseases']['rows']:
                dz.append({'n':row['disease']['name'],'s':round(row['score'],3)})
                for a in row['disease']['therapeuticAreas']:
                    ta[a['name']]=round(ta.get(a['name'],0)+row['score'],4)
            rec['themeAreas']=dict(sorted(ta.items(),key=lambda x:-x[1])[:8])
            rec['topDiseases']=dz[:8]
        except Exception as ex:
            rec['ot_err']=str(ex)[:50]; errs+=1
    try:
        rec['litCTBP1']= None if s=='CTBP1' else _try(lambda: pmc(f'"CTBP1" AND "{s}"'))
    except Exception: rec['litCTBP1']='ERR'
    out[s]=rec
    if i%12==0: print(f'  {i}/{len(top)} {s} themes={list((rec.get("themeAreas") or {}).keys())[:2]} lit={rec.get("litCTBP1")}')
    time.sleep(0.1)
json.dump(out,open('data/enrichment.json','w'),indent=1)
print(f'saved. OT errors={errs}')
for s in ['CTBP1','TP53','ACTL6B','HIPK2','HDAC1','EP300','ZEB1']:
    r=out.get(s,{}); print(f"{s:7} lit={str(r.get('litCTBP1')):>5} dz={r.get('diseaseCount')} tract={r.get('tract')} themes={list((r.get('themeAreas') or {}).items())[:3]}")
