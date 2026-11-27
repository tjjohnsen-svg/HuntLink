import sys, socket, tempfile
import base64, copy, json, secrets, subprocess, time, urllib.parse, urllib.request, urllib.error
from pathlib import Path

project='demo-huntlink-local'
with socket.socket() as sock:
    sock.bind(('127.0.0.1',0))
    port=str(sock.getsockname()[1])
base='http://127.0.0.1:'+port
namespace=project+'-default-rtdb'
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
checks=[]
def token(uid):
    def enc(o):
        return base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip('=')
    return enc({'alg':'none','typ':'JWT'})+'.'+enc({'iss':'https://securetoken.google.com/'+project,'aud':project,'iat':int(time.time()),'exp':int(time.time())+3600,'sub':uid,'user_id':uid,'auth_time':int(time.time()),'firebase':{'sign_in_provider':'anonymous'}})+'.'

def request(method,path,who,value=None):
    query={'ns':namespace}
    headers={'Content-Type':'application/json'}
    if who=='admin':
        headers['Authorization']='Bearer owner'
    elif who:
        query['auth']=token(who)
    req=urllib.request.Request(base+'/'+path+'.json?'+urllib.parse.urlencode(query),method=method,headers=headers,data=None if value is None else json.dumps(value).encode())
    try:
        with opener.open(req,timeout=5) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code

def check(label,method,path,who,value=None,allow=True):
    status=request(method,path,who,value)
    assert (status==200 if allow else status in (401,403)),(label,status,allow)
    checks.append(label)

updated=json.loads((Path(__file__).resolve().parent.parent/'database.rules.json').read_text())
original=copy.deepcopy(updated)
del original['rules']['locations']['$uid']['measuredAt']
with tempfile.TemporaryFile() as log:
    proc=subprocess.Popen(['java','-jar',sys.argv[1],'--host','127.0.0.1','--port',port],stdout=log,stderr=log)
    try:
        for i in range(100):
            if proc.poll() is not None: raise RuntimeError('emulator startup failed')
            try:
                if request('GET','.settings/rules','admin')==200: break
            except OSError: pass
            time.sleep(.15)
        else: raise RuntimeError('emulator not ready')
        for version,rules in [('supplied',original),('candidate',updated)]:
            checks.clear()
            password=secrets.token_hex(20)
            check('install rules','PUT','.settings/rules','admin',rules)
            check('seed synthetic database','PUT','','admin',{'config':{'groupPassword':password}})
            legacy={'lat':0,'lng':0,'name':'Test','accuracy':4,'updatedAt':{'.sv':'timestamp'}}
            fix=dict(legacy,measuredAt=int(time.time()*1000)-8000)
            check('signed out cannot read','GET','locations',None,allow=False)
            check('signed out cannot join','PUT','members/a',None,password,False)
            check('nonmember cannot read','GET','locations','b',allow=False)
            check('wrong password rejected','PUT','members/a','a','invalid',False)
            check('nonmember cannot publish','PUT','locations/b','b',legacy,False)
            check('correct password accepted','PUT','members/a','a',password)
            check('member can read group','GET','locations','a')
            for path in ['', 'config','config/groupPassword','members','members/a','members/b']:
                check('private path '+path,'GET',path,'a',allow=False)
            check('member cannot edit password','PUT','config/groupPassword','a','other',False)
            check('cannot join another identity','PUT','members/b','a',password,False)
            check('another member joins','PUT','members/b','b',password)
            check('legacy publish','PUT','locations/a','a',legacy)
            check('member reads peer','GET','locations/a','b')
            check('updated publish','PUT','locations/a','a',fix,version=='candidate')
            for field,val in [('lat',91),('lng',181),('accuracy',-1),('name',''),('updatedAt',int(time.time()*1000)+60000),('extra',1)]:
                check('reject '+field,'PUT','locations/a','a',dict(legacy,**{field:val}),False)
            for val in [-1,'invalid',int(time.time()*1000)+60000]:
                check('reject invalid measurement','PUT','locations/a','a',dict(fix,measuredAt=val),False)
            check('cannot publish for peer','PUT','locations/a','b',legacy,False)
            check('cannot stop peer','DELETE','locations/a','b',allow=False)
            check('cannot remove peer membership','DELETE','members/a','b',allow=False)
            check('stop sharing','DELETE','locations/a','a')
            expired=dict(legacy,updatedAt=int(time.time()*1000)-7*3600000)
            check('seed expired record','PUT','locations/c','admin',expired)
            check('nonmember cannot remove expired record','DELETE','locations/c','z',allow=False)
            check('member cannot rewrite expired record','PUT','locations/c','b',legacy,False)
            check('member can remove a record older than 6 hours','DELETE','locations/c','b')
            check('seed recent record','PUT','locations/c','admin',dict(legacy,updatedAt=int(time.time()*1000)-5*3600000))
            check('member cannot remove a recent peer record','DELETE','locations/c','b',allow=False)
            check('owner can still remove own recent record','DELETE','locations/c','c')
            check('resume sharing','PUT','locations/a','a',legacy)
            newpass=secrets.token_hex(20)
            check('rotate synthetic password','PUT','config/groupPassword','admin',newpass)
            check('rotation revokes reads','GET','locations','a',allow=False)
            check('rotation revokes writes','PUT','locations/a','a',legacy,False)
            check('leave removes own fix after rotation','DELETE','locations/a','a')
            check('leave removes own membership after rotation','DELETE','members/a','a')
            check('old password no longer joins','PUT','members/a','a',password,False)
            check('new password joins','PUT','members/a','a',newpass)
            print(version,len(checks),'checks passed',flush=True)
    finally:
        proc.terminate()
        proc.wait(timeout=12)
