import json,urllib.parse,http.server,threading,gi,os,time,secrets
from pathlib import Path
gi.require_version('Gtk','3.0');gi.require_version('WebKit2','4.1')
from gi.repository import Gtk,WebKit2,GLib
root=Path.cwd();tmp=root
offline=False
class Server(http.server.SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  if offline:self.connection.close();return
  f=self.path.partition('?')[0].removeprefix('/HuntLink/')
  if f=='/parcels':
   q=urllib.parse.parse_qs(self.path.partition('?')[2]);rows=json.loads((tmp/'parcels-WA.json').read_text())
   data=json.dumps({'objectIdFieldName':'OBJECTID','objectIds':[r['properties']['OBJECTID'] for r in rows]} if 'returnIdsOnly' in q else {'type':'FeatureCollection','features':rows}).encode();mime='application/json'
  elif f.startswith('/tiles/'):data=(tmp/'tile').read_bytes();mime='image/png'
  elif f and (root/f).resolve().is_relative_to(root) and (root/f).is_file():
   data=(root/f).read_bytes();mime=self.guess_type(f)
   if f=='public-land.js':data=data.replace(b'https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Fee_Managers_PADUS/FeatureServer/0/query',b'/parcels')
   if f=='offline.js':
    data=data.replace(b'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile',b'/tiles').replace(b'const map = L.map',b'const map = window.testMap = L.map')
   if f=='offline.js':data=data.replace(b"} catch {\n    $('status').textContent='Download incomplete.",b"} catch(err) {\n    $('status').textContent=err+' Download incomplete.")
  else:self.send_error(404);return
  self.send_response(200);self.send_header('Content-type',mime);self.end_headers();self.wfile.write(data)
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Server);threading.Thread(target=server.serve_forever,daemon=True).start()
base='http://127.0.0.1:%d/HuntLink/'%server.server_port
store=str(tmp/secrets.token_hex(8));manager=WebKit2.WebsiteDataManager(base_data_directory=store,base_cache_directory=store+'/cache');ctx=WebKit2.WebContext.new_with_website_data_manager(manager)
window=Gtk.OffscreenWindow();window.set_default_size(390,844)
def new(url):
 v=WebKit2.WebView.new_with_context(ctx);window.add(v);window.show_all();v.load_uri(url);return v
view=new(base+'offline.html')
last="";step=0;passed=False;busy=False
def poll():
 global busy
 if busy:return True
 busy=True
 def done(v,res,*_):
  global step,offline,view,busy,passed,last
  try:s=v.evaluate_javascript_finish(res).to_string()
  except Exception:s=''
  busy=False
  if s!=last:print(step,repr(s[-380:]),flush=True);last=s
  if step==0 and 'Pan to an area' in s:
   step=10;v.evaluate_javascript("""Object.defineProperty(navigator,'geolocation',{value:{watchPosition:s=>{setTimeout(()=>s({timestamp:Date.now(),coords:{latitude:47.04,longitude:-122.90,accuracy:10}}),0);return 1;},clearWatch:()=>{}}});document.getElementById('locate').click()""",-1,None,None,None,None,None)
  elif step==10 and 'Your location' in s and 'Washington · Outlined' in s:
   step=1;v.evaluate_javascript("testMap.panTo([47.03,-122.91],{animate:false});document.getElementById('locate').click();setTimeout(()=>{if(testMap.getCenter().distanceTo([47.04,-122.90])<30)document.getElementById('download').click()},400)",-1,None,None,None,None,None)
  elif step==1 and 'Washington · Saved topo' in s:
   step=2;window.remove(view);view.destroy();offline=True;view=new(base)
  elif step==2 and 'Washington · Saved topo' in s and 'tile=true' in s and 'parcels=29' in s:
   step=3
   v.evaluate_javascript("""Object.defineProperty(navigator,'geolocation',{value:{watchPosition:s=>{setTimeout(()=>s({timestamp:Date.now(),coords:{latitude:47.04,longitude:-122.90,accuracy:10}}),0);return 1;},clearWatch:()=>{}}});document.getElementById('locate').click()""",-1,None,None,None,None,None)
  elif step==3 and 'Fix at' in s:
   step=4;v.evaluate_javascript("waypoints.open=true;window.prompt=()=>'Truck';markGps.click();",-1,None,None,None,None,None)
  elif step==4 and 'Waypoint saved on this device' in s:
   step=5;window.remove(view);view.destroy();view=new(base)
  elif step==5 and 'tile=true' in s:
   step=6;v.evaluate_javascript("waypoints.open=true;pointList.selectedIndex=1;pointList.dispatchEvent(new Event('change'));",-1,None,None,None,None,None)
  elif step==6 and 'Truck · Use My location' in s:
   print('PASS WebKit: close/reopen offline via app root, cached topo, simulated private GPS',flush=True);passed=True;Gtk.main_quit()
  elif 'storage is unavailable' in s or 'Download incomplete.' in s:print(s,flush=True);Gtk.main_quit()
 v=view;v.evaluate_javascript("""document.body.innerText+' parcels='+document.querySelectorAll('.leaflet-publicLand-pane path').length+' tile='+Array.from(document.querySelectorAll('.leaflet-tile')).some(i=>i.naturalWidth===256&&i.src.startsWith('blob:'))""",-1,None,None,None,done,None)
 return True
GLib.timeout_add(250,poll);GLib.timeout_add_seconds(45,lambda:(Gtk.main_quit(),False)[1]);Gtk.main();server.shutdown()
if not passed:raise SystemExit('failed at step '+str(step))
