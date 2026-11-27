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
        check('another group leader cannot delete a spot','DELETE',f'groups/{g1}/locations/x','lead2',allow=False)
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

        # Leader controls: remove, co-leaders, approval and resetting the invite link.
        checks.clear()
        check('Dave rejoins group 1','PATCH','','x',join('x',g1,k1,'Dave'))
        check('Sam joins group 1','PATCH','','y',join('y',g1,k1,'Sam'))
        def remove_member(uid,k): return {f'groups/{g1}/members/{uid}':None,f'groups/{g1}/locations/{uid}':None,f'invites/{k}/people/{uid}':None,f'groups/{g1}/removed/{uid}':True}
        check('member cannot remove another member','PATCH','','x',remove_member('y',k1),False)
        check('other group leader cannot remove a member','PATCH','','lead2',remove_member('y',k1),False)
        check('member cannot see who was removed','GET',f'groups/{g1}/removed','x',allow=False)
        check('Sam shares','PUT',f'groups/{g1}/locations/y','y',fix())
        check('leader removes Sam, with spot and preview name','PATCH','','lead1',remove_member('y',k1))
        check('removed member loses the map','GET',f'groups/{g1}/locations','y',allow=False)
        check('removed member cannot read the roster','GET',f'groups/{g1}/members','y',allow=False)
        check('removed phone cannot rejoin with the same link','PATCH','','y',join('y',g1,k1,'Sam'),False)
        check('leader sees who was removed','GET',f'groups/{g1}/removed','lead1')
        check('member cannot make themselves a leader','PATCH',f'groups/{g1}/members/x','x',{'role':'leader'},False)
        check('leader makes Dave a co-leader','PATCH',f'groups/{g1}/members/x','lead1',{'role':'leader'})
        check('co-leader can make a new code','PATCH','','x',{f'codes/{(cc:=code())}':{'k':k1,'exp':ms()+86400000},f'groups/{g1}/info/code':cc,f'groups/{g1}/info/codeExp':ms()+86400000})
        check('leader cannot rename someone else','PATCH',f'groups/{g1}/members/x','lead1',{'name':'Renamed'},False)
        check('leader turns Dave back into a member','PATCH',f'groups/{g1}/members/x','lead1',{'role':'member'})
        check('member cannot turn on approval','PUT',f'groups/{g1}/info/approval','x',True,False)
        check('leader turns on Ask before new people join','PUT',f'groups/{g1}/info/approval','lead1',True)
        check('with approval on, joining straight in is refused','PATCH','','z',join('z',g1,k1,'Zed'),False)
        req=lambda uid,k,name='Zed': {f'groups/{g1}/pending/{uid}':{'name':name,'key':k,'at':ts}}
        check('request with the wrong key is refused','PATCH','','z',req('z',key()),False)
        check('request to join with the link','PATCH','','z',req('z',k1))
        check('requester can see their own request','GET',f'groups/{g1}/pending/z','z')
        check('requester still cannot see the map','GET',f'groups/{g1}/locations','z',allow=False)
        check('member cannot see requests','GET',f'groups/{g1}/pending','x',allow=False)
        check('leader sees requests','GET',f'groups/{g1}/pending','lead1')
        check('member cannot approve','PATCH','','x',{f'groups/{g1}/members/z':{'name':'Zed','role':'member','joinedAt':ts,'key':k1},f'groups/{g1}/pending/z':None},False)
        check('leader cannot approve under a different name','PATCH','','lead1',{f'groups/{g1}/members/z':{'name':'Other','role':'member','joinedAt':ts,'key':k1},f'groups/{g1}/pending/z':None},False)
        check('leader cannot add someone who never asked','PATCH','','lead1',{f'groups/{g1}/members/w':{'name':'W','role':'member','joinedAt':ts,'key':k1}},False)
        check('leader approves Zed','PATCH','','lead1',{f'groups/{g1}/members/z':{'name':'Zed','role':'member','joinedAt':ts,'key':k1},f'groups/{g1}/pending/z':None,f'invites/{k1}/people/z':'Zed'})
        check('approved member sees the map','GET',f'groups/{g1}/locations','z')
        check('second request','PATCH','','w',req('w',k1,'Walt'))
        check('leader declines a request','DELETE',f'groups/{g1}/pending/w','lead1')
        check('declined requester is not a member','GET',f'groups/{g1}/locations','w',allow=False)
        check('removed phone cannot request either','PATCH','','y',req('y',k1,'Sam'),False)
        check('leader turns approval off','PUT',f'groups/{g1}/info/approval','lead1',False)
        k1b,c1c=key(),code()
        people={'lead1':'Lead lead1','x':'Dave','z':'Zed'}
        reset={f'invites/{k1b}':{'g':g1,'name':'Elk camp','by':'Lead lead1','people':people},f'invites/{k1}':None,
               f'groups/{g1}/info/invite':k1b,f'groups/{g1}/info/code':c1c,f'groups/{g1}/info/codeExp':ms()+3*86400000,
               f'codes/{c1c}':{'k':k1b,'exp':ms()+3*86400000}}
        check('member cannot reset the invite link','PATCH','','x',reset,False)
        check('leader resets the invite link and code in one step','PATCH','','lead1',reset)
        check('old link is gone','GET',f'invites/{k1}','v')
        check('old link no longer joins','PATCH','','v',join('v',g1,k1,'Vic'),False)
        check('new link joins','PATCH','','v',join('v',g1,k1b,'Vic'))
        check('people already in the group stay after a reset','GET',f'groups/{g1}/locations','x')
        check('leader un-blocks a removed phone','DELETE',f'groups/{g1}/removed/y','lead1')
        check('un-blocked phone can join with the new link','PATCH','','y',join('y',g1,k1b,'Sam'))
        check('leader removes a spot older than 6 hours or any spot','DELETE',f'groups/{g1}/locations/x','lead1')
        check('other group leader still cannot change group 1','PUT',f'groups/{g1}/info/approval','lead2',True,False)
        check('member cannot mark the invite as approval-only','PUT',f'invites/{k1b}/ask','x',True,False)
        check('leader marks the invite as approval-only for the preview','PUT',f'invites/{k1b}/ask','lead1',True)
        # Optional: ask for a group password each time HuntLinq opens.
        gp=secrets.token_hex(8)
        check('member cannot set a group password','PATCH','','x',{f'groups/{g1}/lock':gp,f'groups/{g1}/info/lock':True},False)
        check('leader turns on the group password in one step','PATCH','','lead1',{f'groups/{g1}/lock':gp,f'groups/{g1}/info/lock':True,f'groups/{g1}/unlocked/lead1':gp})
        check('nobody can read the group password','GET',f'groups/{g1}/lock','lead1',allow=False)
        check('without the password, a member cannot see the map','GET',f'groups/{g1}/locations','x',allow=False)
        check('without the password, a member cannot share','PUT',f'groups/{g1}/locations/x','x',fix(),False)
        check('a member still sees the group name and roster','GET',f'groups/{g1}/members','x')
        check('wrong group password refused','PUT',f'groups/{g1}/unlocked/x','x','wrong-pass',False)
        check('nonmember cannot unlock even with the password','PUT',f'groups/{g1}/unlocked/w','w',gp,False)
        check('cannot unlock for someone else','PUT',f'groups/{g1}/unlocked/z','x',gp,False)
        check('right group password unlocks','PUT',f'groups/{g1}/unlocked/x','x',gp)
        check('unlocked member sees the map','GET',f'groups/{g1}/locations','x')
        check('unlocked member shares','PUT',f'groups/{g1}/locations/x','x',fix())
        check('member locks again at the next launch','DELETE',f'groups/{g1}/unlocked/x','x')
        check('locked again until the password is entered','GET',f'groups/{g1}/locations','x',allow=False)
        check('leader changes the password','PATCH','','lead1',{f'groups/{g1}/lock':gp+'x',f'groups/{g1}/unlocked/lead1':gp+'x'})
        check('old group password no longer unlocks','PUT',f'groups/{g1}/unlocked/x','x',gp,False)
        check('leader turns the group password off','PATCH','','lead1',{f'groups/{g1}/lock':None,f'groups/{g1}/info/lock':False})
        check('with it off, members see the map again','GET',f'groups/{g1}/locations','x')
        print('leader controls',len(checks),'checks passed',flush=True)
    finally:
        proc.terminate()
        proc.wait(timeout=12)
