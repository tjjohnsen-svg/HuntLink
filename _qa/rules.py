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
    path=path.strip('/') if path else ''
    query={'ns':namespace}
    headers={'Content-Type':'application/json'}
    if who=='admin':
        headers['Authorization']='Bearer owner'
    elif who:
        query['auth']=token(who)
    req=urllib.request.Request(base+'/'+path+('.json?' if path else '.json?')+urllib.parse.urlencode(query),method=method,headers=headers,data=None if value is None else json.dumps(value).encode())
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

        # Groups: each group is private to its own members (per-group isolation).
        checks.clear()
        check('install candidate rules for groups','PUT','.settings/rules','admin',updated)
        check('reset synthetic database','PUT','','admin',{'config':{'groupPassword':secrets.token_hex(20)}})
        ms=lambda: int(time.time()*1000)
        ts={'.sv':'timestamp'}
        def key(): return secrets.token_urlsafe(16)
        alphabet='ABCDEFGHJKMNPQRSTUVWXYZ23456789'
        def code(): return ''.join(secrets.choice(alphabet) for _ in range(6))
        def gid(): return 'g'+secrets.token_hex(8)
        def create(uid,g,k,c,name='Elk camp',exp=None,**over):
            exp=exp or ms()+3*86400000
            body={f'groups/{g}/info':{'name':name,'leader':uid,'createdAt':ts,'invite':k,'code':c,'codeExp':exp},
                  f'groups/{g}/members/{uid}':{'name':'Lead '+uid,'role':'leader','joinedAt':ts},
                  f'invites/{k}':{'g':g,'name':name,'by':'Lead '+uid,'people':{uid:'Lead '+uid}},
                  f'codes/{c}':{'k':k,'exp':exp}}
            body.update(over)
            return {p:v for p,v in body.items() if v is not None}
        def join(uid,g,k,name='Hunter',role='member'):
            return {f'groups/{g}/members/{uid}':{'name':name,'role':role,'joinedAt':ts,'key':k},f'invites/{k}/people/{uid}':name}
        g1,k1,c1=gid(),key(),code(); g2,k2,c2=gid(),key(),code()
        check('signed out cannot create a group','PATCH','',None,create('lead1',g1,k1,c1),False)
        check('cannot create a group led by someone else','PATCH','','x',create('lead1',g1,k1,c1),False)
        check('cannot create a group without being its leader member','PATCH','','lead1',create('lead1',g1,k1,c1,**{f'groups/{g1}/members/lead1':None}),False)
        check('cannot create a group with an unsafe id','PATCH','','lead1',create('lead1','short',k1,c1),False)
        check('code must last at most 3 days','PATCH','','lead1',create('lead1',g1,k1,c1,exp=ms()+5*86400000),False)
        check('invite code must point at the group invite','PATCH','','lead1',create('lead1',g1,k1,c1,**{f'codes/{c1}':{'k':k2,'exp':ms()+86400000}}),False)
        check('leader creates group 1 in one step','PATCH','','lead1',create('lead1',g1,k1,c1))
        check('another leader creates group 2','PATCH','','lead2',create('lead2',g2,k2,c2,name='Duck blind'))
        check('cannot take over an existing group','PATCH','','x',create('x',g1,key(),code()),False)
        for path in ['groups','invites','codes',f'groups/{g1}']:
            check('nobody can list '+path,'GET',path,'lead1',allow=False)
        check('signed out cannot open an invite','GET',f'invites/{k1}',None,allow=False)
        check('anyone signed in with the link can preview it','GET',f'invites/{k1}','x')
        check('anyone signed in with the code can look it up','GET',f'codes/{c1}','x')
        check('a made-up code is refused','GET','codes/'+code(),'x',allow=False)
        for part in ['info','members','locations']:
            check('nonmember cannot read group '+part,'GET',f'groups/{g1}/{part}','x',allow=False)
        check('wrong invite key cannot join','PATCH','','x',join('x',g1,key()),False)
        check("another group's key cannot join",'PATCH','','x',join('x',g1,k2),False)
        check('cannot join as a leader','PATCH','','x',join('x',g1,k1,role='leader'),False)
        check('cannot join for someone else','PATCH','','x',join('y',g1,k1),False)
        check('joining with the invite key works','PATCH','','x',join('x',g1,k1,'Dave'))
        check('member reads group 1 info','GET',f'groups/{g1}/info','x')
        check('member reads group 1 roster','GET',f'groups/{g1}/members','x')
        check('member reads group 1 locations','GET',f'groups/{g1}/locations','x')
        fix=lambda: {'lat':0.001,'lng':0.002,'name':'Dave','accuracy':5,'measuredAt':ms()-3000,'updatedAt':ts}
        check('member shares in group 1','PUT',f'groups/{g1}/locations/x','x',fix())
        for part in ['info','members','locations','locations/lead2']:
            check('group 1 member cannot read group 2 '+part,'GET',f'groups/{g2}/{part}','x',allow=False)
        check('group 1 member cannot share into group 2','PUT',f'groups/{g2}/locations/x','x',fix(),False)
        for part in ['info','members','locations','locations/x']:
            check('group 2 leader cannot read group 1 '+part,'GET',f'groups/{g1}/{part}','lead2',allow=False)
        check('nonmember cannot share into group 1','PUT',f'groups/{g1}/locations/z','z',fix(),False)
        check('member cannot publish for a peer','PUT',f'groups/{g1}/locations/lead1','x',fix(),False)
        check('member cannot delete a peer spot','DELETE',f'groups/{g1}/locations/x','lead1',allow=False)
        check('member cannot promote themselves','PUT',f'groups/{g1}/members/x','x',{'name':'Dave','role':'leader','joinedAt':ms()-1000,'key':k1},False)
        check('member cannot add someone else','PUT',f'groups/{g1}/members/y','x',{'name':'Pal','role':'member','joinedAt':ts,'key':k1},False)
        check('member cannot change group info','PUT',f'groups/{g1}/info/name','x','Mine now',False)
        check('member cannot make an invite for the group','PATCH','','x',{f'invites/{key()}':{'g':g1,'name':'x','by':'x'}},False)
        check('member cannot delete the invite','DELETE',f'invites/{k1}','x',allow=False)
        check('member cannot overwrite the invite','PUT',f'invites/{k1}/name','x','Spam',False)
        check("member cannot edit another person's preview name",'PUT',f'invites/{k1}/people/lead1','x','Spam',False)
        check('nonmember cannot add a preview name','PUT',f'invites/{k1}/people/z','z','Spy',False)
        check('group 2 leader cannot reuse an active group 1 code','PATCH','','lead2',{f'codes/{c1}':{'k':k2,'exp':ms()+86400000},f'groups/{g2}/info/code':c1},False)
        check('member cannot delete the code','DELETE',f'codes/{c1}','x',allow=False)
        c1b=code()
        check('leader makes a new 3-day code','PATCH','','lead1',{f'codes/{c1b}':{'k':k1,'exp':ms()+3*86400000},f'groups/{g1}/info/code':c1b,f'groups/{g1}/info/codeExp':ms()+3*86400000,f'codes/{c1}':None})
        check('old code no longer opens','GET',f'codes/{c1}','z',allow=False)
        c_old=code()
        check('seed expired code','PUT',f'codes/{c_old}','admin',{'k':k2,'exp':ms()-1000})
        check('an expired code cannot be looked up','GET',f'codes/{c_old}','z',allow=False)
        check('another leader may reuse an expired code','PATCH','','lead1',{f'codes/{c_old}':{'k':k1,'exp':ms()+86400000},f'groups/{g1}/info/code':c_old,f'groups/{g1}/info/codeExp':ms()+86400000})
        check('member renames themselves','PATCH',f'groups/{g1}/members/x','x',{'name':'Dave R'})
        expired=dict(fix(),updatedAt=ms()-7*3600000,measuredAt=ms()-7*3600000)
        check('seed old spot in group 1','PUT',f'groups/{g1}/locations/old','admin',expired)
        check('group 2 leader cannot tidy group 1','DELETE',f'groups/{g1}/locations/old','lead2',allow=False)
        check('group 1 member tidies a spot older than 6 hours','DELETE',f'groups/{g1}/locations/old','x')
        for field,val in [('lat',91),('lng',181),('accuracy',-1),('name',''),('extra',1)]:
            check('group spot rejects '+field,'PUT',f'groups/{g1}/locations/x','x',dict(fix(),**{field:val}),False)
        check('leave group in one step','PATCH','','x',{f'groups/{g1}/members/x':None,f'groups/{g1}/locations/x':None,f'invites/{k1}/people/x':None})
        check('after leaving, locations are private again','GET',f'groups/{g1}/locations','x',allow=False)
        check('after leaving, cannot share','PUT',f'groups/{g1}/locations/x','x',fix(),False)
        check('legacy group still works beside groups','PUT','members/x','x','invalid',False)
        print('groups',len(checks),'checks passed',flush=True)
    finally:
        proc.terminate()
        proc.wait(timeout=12)
