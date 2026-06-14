import urllib.request, urllib.parse, json, time
def get(u):
    return json.load(urllib.request.urlopen(u, timeout=30))
def post(u, data):
    req=urllib.request.Request(u, data=urllib.parse.urlencode(data).encode(), method='POST')
    return json.load(urllib.request.urlopen(req, timeout=40))

# 1) Full CTBP1 neighborhood
part=get('https://string-db.org/api/json/interaction_partners?identifiers=CTBP1&species=9606&limit=250')
json.dump(part, open('data/string_partners_full.json','w'))
ranked=sorted(part, key=lambda x:-x['score'])
names=[x['preferredName_B'] for x in ranked]
print('TOTAL partners returned:', len(part))
for t in ['TP53','ACTL6B','HIPK2']:
    print(f'  {t}: rank {names.index(t)+1 if t in names else "ABSENT"}  score {next((x["score"] for x in ranked if x["preferredName_B"]==t),"-")}')

# 2) Inter-partner edges among CTBP1 + top 40
top=['CTBP1']+names[:40]
ids='%0d'.join(top)
net=get(f'https://string-db.org/api/json/network?identifiers={ids}&species=9606&required_score=0')
json.dump(net, open('data/string_network.json','w'))
print('Inter-partner network edges:', len(net))

# 3) MyGene batch symbol -> ensembl/entrez
syms=','.join(top)
mg=post('https://mygene.info/v3/query', {'q':syms,'scopes':'symbol','fields':'symbol,name,ensembl.gene,entrezgene','species':'human'})
json.dump(mg, open('data/mygene_batch.json','w'))
print('MyGene batch records:', len(mg))

# 4) UniProt CTBP1
up=get('https://rest.uniprot.org/uniprotkb/Q13363.json')
json.dump(up, open('data/uniprot.json','w'))
comments={}
for c in up.get('comments',[]):
    t=c.get('commentType')
    comments.setdefault(t,0); comments[t]+=1
print('UniProt comment types:', comments)
for c in up.get('comments',[]):
    if c.get('commentType') in ('FUNCTION','COFACTOR','DISEASE'):
        for tx in c.get('texts',[]):
            print(f"  [{c['commentType']}] {tx['value'][:160]}")
        if c.get('commentType')=='DISEASE' and c.get('disease'):
            print(f"  [DISEASE name] {c['disease'].get('diseaseId')} - {c['disease'].get('description','')[:120]}")
