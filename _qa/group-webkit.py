from pathlib import Path
import gi
gi.require_version('Gtk','3.0')
gi.require_version('WebKit2','4.1')
from gi.repository import Gtk, WebKit2, GLib
w=Gtk.OffscreenWindow()
w.set_default_size(390,844)
view=WebKit2.WebView.new_with_context(WebKit2.WebContext.new_ephemeral());w.add(view)
passed=False
def title(*_):
 global passed
 t=view.get_title() or ''
 if t.startswith(('PASS','FAIL')):
  passed=t.startswith('PASS');print(t,flush=True);Gtk.main_quit()
def loaded(view,event):
 if event==WebKit2.LoadEvent.FINISHED:
  def done(v,r,*a):
   print(v.evaluate_javascript_finish(r).to_string(),flush=True)
  view.evaluate_javascript("JSON.stringify([document.title,typeof L,document.body.innerText.slice(-250),innerWidth,innerHeight])",-1,None,None,None,done,None)
view.connect('load-changed',loaded)
view.connect('web-process-terminated',lambda v,r: print('terminated',r,flush=True))
view.connect('notify::title',title);w.show_all()
view.load_uri((Path.cwd()/'group.html').as_uri())
GLib.timeout_add_seconds(25,lambda: (Gtk.main_quit(),False)[1]);Gtk.main()

if not passed: raise SystemExit(1)
