import urllib.request, urllib.parse, json, time
OT='https://api.platform.opentargets.org/api/v4/graphql'
def _try(fn,n=4):
    for k in range(n):
        try: return fn()
        except Exception as ex:
            if k==n-1: raise
            time.sleep(0.7*(k+1))
def ot(e):
    q="""query($id:String!){target(ensemblId:$id){approvedSymbol approvedName functionDescriptions tractability{label modality value} associatedDiseases(page:{index:0,size:20}){count rows{score disease{name therapeuticAreas{id name}}}}}}"""
    req=urllib.request.Request(OT,data=json.dumps({'query':q,'variables':{'id':e}}).encode(),headers={'Content-Type':'application/json'},method='POST')
    return json.load(urllib.request.urlopen(req,timeout=40))['data']['target']
def pmc(q):
    u='https://www.ebi.ac.uk/europepmc/webservices/rest/search?'+urllib.parse.urlencode({'query':q,'format':'json','resultType':'idlist','pageSize':1})
    return json.load(urllib.request.urlopen(u,timeout=30)).get('hitCount',0)
def mygene(syms):
    req=urllib.request.Request('https://mygene.info/v3/query',data=urllib.parse.urlencode({'q':','.join(syms),'scopes':'symbol','fields':'symbol,ensembl.gene,entrezgene','species':'human'}).encode(),method='POST')
    return json.load(urllib.request.urlopen(req,timeout=40))

out=json.load(open('data/enrichment.json'))
part=sorted(json.load(open('data/string_partners_full.json')),key=lambda x:-x['score'])
top=['CTBP1']+[x['preferredName_B'] for x in part[:250]]   # neighborhood size (was 100)
need=[s for s in top if s not in out or out.get(s,{}).get('ot_err') or out.get(s,{}).get('litCTBP1')=='ERR']
print('need to (re)enrich:',need)
mg=_try(lambda: mygene([s for s in need if s!='CTBP1']))
s2e={'CTBP1':'ENSG00000159692'}
for r in mg:
    s=r.get('symbol') or r.get('query'); e=r.get('ensembl'); g=e.get('gene') if isinstance(e,dict) else (next((i['gene'] for i in e if i.get('gene')),None) if isinstance(e,list) else None)
    if s and g: s2e.setdefault(s,g)
for s in need:
    rec=out.get(s,{}) ; rec['rank']=0 if s=='CTBP1' else top.index(s)
    if s in s2e: rec['ensembl']=s2e[s]
    if rec.get('ensembl'):
        try:
            t=_try(lambda: ot(rec['ensembl']))
            fd=t.get('functionDescriptions') or []
            rec['name']=t.get('approvedName'); rec['func']=fd[0] if fd else None
            rec['tract']=[x['label'] for x in (t.get('tractability') or []) if x['value']]
            rec['diseaseCount']=t['associatedDiseases']['count']
            ta={}; dz=[]
            for row in t['associatedDiseases']['rows']:
                dz.append({'n':row['disease']['name'],'s':round(row['score'],3)})
                for a in row['disease']['therapeuticAreas']: ta[a['name']]=round(ta.get(a['name'],0)+row['score'],4)
            rec['themeAreas']=dict(sorted(ta.items(),key=lambda x:-x[1])[:8]); rec['topDiseases']=dz[:8]
            rec.pop('ot_err',None)
        except Exception as ex: rec['ot_err']=str(ex)[:50]
    try: rec['litCTBP1']= None if s=='CTBP1' else _try(lambda: pmc(f'"CTBP1" AND "{s}"'))
    except Exception: rec['litCTBP1']='ERR'
    out[s]=rec; print(f'  {s}: themes={list((rec.get("themeAreas") or {}).keys())[:3]} lit={rec.get("litCTBP1")} tract={bool(rec.get("tract"))}')
    time.sleep(0.1)
json.dump(out,open('data/enrichment.json','w'),indent=1)
rem=[s for s in top if out.get(s,{}).get('ot_err') or out.get(s,{}).get('litCTBP1')=='ERR']
print('total enriched:',len(out),'| remaining errors:',rem)
a=out.get('ACTL6B',{}); print('ACTL6B =>', {k:a.get(k) for k in ['ensembl','litCTBP1','diseaseCount','themeAreas','topDiseases']})
