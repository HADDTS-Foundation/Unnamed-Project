import urllib.request, urllib.parse, json
part=sorted(json.load(open('data/string_partners_full.json')),key=lambda x:-x['score'])
nodes=['CTBP1']+[x['preferredName_B'] for x in part[:250]]   # neighborhood size (was 100)
# POST to STRING network endpoint (identifiers newline-separated)
data=urllib.parse.urlencode({'identifiers':'\r'.join(nodes),'species':'9606','required_score':'400'}).encode()
req=urllib.request.Request('https://string-db.org/api/json/network',data=data,method='POST')
net=json.load(urllib.request.urlopen(req,timeout=60))
json.dump(net,open('data/string_network_full.json','w'))
print('nodes:',len(nodes),'edges (>=0.4):',len(net))
# edge count touching CTBP1 vs partner-partner
c=sum(1 for e in net if 'CTBP1' in (e['preferredName_A'],e['preferredName_B']))
print('edges touching CTBP1:',c,'| partner-partner:',len(net)-c)

# CTBP1 GO + pathways from mygene
mg=json.load(open('data/mygene.json'))
go=mg.get('go',{})
for cat in ['MF','BP','CC']:
    terms=go.get(cat,[])
    terms=terms if isinstance(terms,list) else [terms]
    sel=[t.get('term') for t in terms][:12]
    print(f'GO-{cat}:', sel)
pw=mg.get('pathway',{})
print('pathway sources:', list(pw.keys()) if isinstance(pw,dict) else pw)
if isinstance(pw,dict) and 'reactome' in pw:
    rx=pw['reactome']; rx=rx if isinstance(rx,list) else [rx]
    print('reactome:', [r.get('name') for r in rx][:10])
