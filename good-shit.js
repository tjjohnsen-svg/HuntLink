import { readWaypoints } from './waypoints.js';

const unsupported = 'I can help with straight-line distance and direction to people in your group or saved places.';
const voiceFailure = 'Voice unavailable. Tap a suggestion or type.';
const normalize = value => value.toLowerCase().trim().replace(/[?.!]+$/, '').trim().replace(/\s+/g,' ');
const directions = {N:'north', NE:'northeast', E:'east', SE:'southeast', S:'south', SW:'southwest', W:'west', NW:'northwest'};

export function cachedHunters() {
  let cache;
  try { cache = JSON.parse(localStorage.getItem('huntlinkLastKnown')); } catch { return []; }
  if (!Array.isArray(cache?.hunters)) return [];
  return cache.hunters.filter(h=>h && Number.isFinite(h.lat) && Number.isFinite(h.lng) &&
    Number.isFinite(h.time) && Date.now()-h.time<6*3600000);
}

export function cachedPeople() {
  return cachedHunters().sort((a,b)=>b.time-a.time).map(h=>{
    const seconds = Math.max(0,Math.floor((Date.now()-h.time)/1000));
    const age = seconds<60 ? seconds+'s' : Math.floor(seconds/60)+'m';
    return {...h,key:'person:'+(h.id??JSON.stringify([h.name,h.lat,h.lng])),person:true,
      age:'Last known · '+age+' ago'+(h.knownAge?'':' (GPS fix age unknown)')};
  });
}

export function formatDistance(meters) {
  return meters < 1609.344 ? Math.min(1759, Math.round(meters / 0.9144)).toLocaleString('en-US') + ' yd'
    : Number((meters / 1609.344).toFixed(1)) + ' mi';
}

export function compassDirection(from,to) {
  const rad = Math.PI / 180, a = from.lat * rad, b = to.lat * rad, delta = (to.lng - from.lng) * rad;
  const degrees = Math.atan2(Math.sin(delta)*Math.cos(b), Math.cos(a)*Math.sin(b)-Math.sin(a)*Math.cos(b)*Math.cos(delta)) / rad;
  return Object.keys(directions)[Math.round((degrees+360)/45)%8];
}

export function setupQuestions({map, people, ownFix, findFix, releaseFix, waiting}) {
  const nav = document.getElementById('askTool');
  const sheet = document.createElement('aside');
  sheet.id = 'askSheet';
  sheet.hidden = true;
  sheet.setAttribute('aria-labelledby','askTitle');
  sheet.innerHTML = `<div class="ask-heading"><h2 id="askTitle">The good shit</h2><button type="button" aria-label="Dictate question"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10a7 7 0 0 0 14 0m-7 7v5m-4 0h8"/></svg></button><button type="button" aria-label="Close The good shit">Close</button></div>
    <div class="ask-list"></div><p class="ask-feedback" role="status"></p>
    <form class="ask-entry"><input aria-label="Ask about a person or place" placeholder="Ask about a person or place." autocomplete="off" enterkeyhint="send"><button>Send</button></form>`;
  map.getContainer().after(sheet);
  const list = sheet.querySelector('.ask-list'), feedback = sheet.querySelector('.ask-feedback');
  const form = sheet.querySelector('form'), input = form.querySelector('input'), mic = sheet.querySelector('[aria-label="Dictate question"]');
  const micIcon = mic.innerHTML;
  let refreshTimer;
  let frameNote = '';
  let submission = 0, placeLoad, places = [], view = 'suggest', selected, choices = [], line, recognition, revision = 0;

  function targets() {
    return [...people(), ...places];
  }
  function clearLine() { line?.remove(); line = null; }
  function select(target) {
    submission++;
    frameNote = '';
    stopVoice();
    feedback.textContent = '';
    selected = target.key;
    view = 'single';
    if (!ownFix()) findFix();
    render();
  }
  function render() {
    if (sheet.hidden) return;
    const all = targets(), from = ownFix();
    const member = all.filter(t => t.person);
    const items = [];
    const add = (text, action, key = text) => items.push({text, action, key});
    const meters = t => L.latLng(from).distanceTo(t);
    const reading = t => {
      const m = meters(t);
      const direction = m <= from.accuracy + (t.accuracy || 0) ? ' · direction uncertain within GPS accuracy' : ' ' + directions[compassDirection(from,t)];
      return formatDistance(m) + direction + ' · straight-line';
    };
    const label = t => t.label || t.name;
    const t = all.find(item => item.key === selected);
    if (view !== 'single' || !from || !t) clearLine();
    if (view === 'suggest') {
      const anchors = places.slice().sort((a,b)=>Number(/\b(truck|camp|trailhead)\b/i.test(b.name))-Number(/\b(truck|camp|trailhead)\b/i.test(a.name)));
      const suggestions = [...new Set([member[0], anchors[0], ...member, ...anchors].filter(Boolean))].slice(0,3);
      for (const target of suggestions) add('How far to '+label(target)+'?',()=>select(target),target.key);
      if (!suggestions.length) add('Ask about a group member or saved place.');
    } else if (view === 'choices') {
      add('Which one?');
      for (const target of all.filter(x => choices.includes(x.key))) {
        const detail = target.person ? 'Group member · '+target.age : 'Saved place #'+target.id;
        add(label(target)+' · '+detail,()=>select(target),target.key);
      }
    } else if (view === 'group') {
      if (!member.length) add('No other hunters have shared in the last 6 hours.');
      else {
        if (from) member.sort((a,b)=>meters(a)-meters(b));
        else add(waiting());
        for (const target of member) add(label(target)+' · '+(from?reading(target)+' · ':'')+target.age,()=>select(target),target.key);
      }
    } else if (view === 'single') {
      if (!t) add('This location is no longer available.');
      else {
        add(label(t)+(from?' is '+reading(t):' · '+waiting()));
        if (t.age) add(t.age);
        if (from) {
          if (!line) line = L.polyline([from,t],{className:'question-line',color:'#20272b',weight:4,dashArray:'8 6',interactive:false}).addTo(map);
          else {
            const [start,end] = line.getLatLngs();
            if (!start.equals(from) || !end.equals(t)) line.setLatLngs([from,t]);
          }
          add('Show on map',()=>{
            render();
            if (!line) return;
            map.fitBounds(line.getBounds(),{paddingTopLeft:[18,18],paddingBottomRight:[18,sheet.offsetHeight+18],maxZoom:16,animate:false});
            frameNote = map.getBounds().contains(line.getBounds()) ? '' : 'One or both locations are outside this map view.';
            render();
          });
          if (frameNote) add(frameNote);
        }
      }
    } else add(unsupported);
    // Keep buttons under the user's finger when a GPS or age update arrives.
    items.forEach(({text,action,key},index)=>{
      let el = list.children[index];
      const tag = action?'BUTTON':'P';
      if (!el || el.tagName!==tag || el.dataset.key!==key) {
        const next = document.createElement(tag);
        next.dataset.key = key;
        if (el) el.replaceWith(next); else list.append(next);
        el = next;
      }
      if (el.textContent!==text) el.textContent = text;
      el.onclick = action || null;
    });
    while (list.children.length>items.length) list.lastChild.remove();
  }
  async function submit() {
    const request = ++submission;
    const query = normalize(input.value);
    if (!query) return;
    input.blur(); stopVoice(); feedback.textContent = ''; clearLine();
    if (/^where (?:is|are) (?:everyone|everybody|all hunters|the group)$/.test(query)) {
      view = 'group';
      if (people().length && !ownFix()) findFix();
    } else {
      const name = query.replace(/^(?:how far (?:am i from|(?:is it )?to|is)|(?:which|what) direction (?:is|to)|where is|distance to)\s+/, '').replace(/ from me$/,'');
      const version = revision;
      if (placeLoad) await placeLoad;
      if (sheet.hidden || request!==submission || version!==revision) return;
      const all = targets(), exact = all.filter(t=>normalize(t.name)===name);
      const matches = exact.length ? exact : all.filter(t=>normalize(t.name).split(' ').includes(name));
      if (matches.length===1) { select(matches[0]); return; }
      choices = matches.map(t=>t.key);
      view = choices.length?'choices':'unsupported';
    }
    render();
  }
  form.onsubmit = e=>{e.preventDefault(); submit();};
  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  mic.hidden = !Speech;
  function stopVoice() {
    const old = recognition;
    recognition = null;
    if (old) { try { old.abort(); } catch {} }
    mic.innerHTML = micIcon;
    mic.setAttribute('aria-label','Dictate question');
  }
  mic.onclick = ()=>{
    if (recognition) { recognition.stop(); return; }
    try {
      const session = new Speech();
      recognition = session;
      session.lang = 'en-US';
      session.onresult = e=>{if (recognition===session) input.value=e.results[0][0].transcript;};
      session.onerror = ()=>{if (recognition===session) feedback.textContent=voiceFailure;};
      session.onend = ()=>{
        if (recognition!==session) return;
        recognition=null; mic.innerHTML=micIcon; mic.setAttribute('aria-label','Dictate question');
        if (feedback.textContent==='Listening…') feedback.textContent='';
      };
      session.start(); mic.textContent='Stop'; mic.setAttribute('aria-label','Stop dictation'); feedback.textContent='Listening…';
    } catch { stopVoice(); feedback.textContent=voiceFailure; }
  };
  async function loadPlaces() {
    const version = ++revision;
    try {
      const rows = await readWaypoints();
      if (sheet.hidden || version!==revision) return;
      places = rows.filter(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lng)).map(p=>({...p,key:'place:'+p.id}));
    } catch { if (version===revision) places=[]; }
    render();
  }
  function layout() {
    if (sheet.hidden) return;
    const rect = map.getContainer().getBoundingClientRect(), vp = window.visualViewport;
    const gap = vp ? Math.max(0,rect.bottom-vp.offsetTop-vp.height) : 0;
    sheet.style.setProperty('--keyboard-gap',gap+'px');
    sheet.style.setProperty('--visible-height',Math.max(0,rect.height-gap)+'px');
  }
  function close() {
    if (sheet.hidden) return;
    window.clearInterval(refreshTimer);
    sheet.hidden=true; nav.setAttribute('aria-expanded','false'); clearLine(); stopVoice(); releaseFix();
    places=[]; selected=null; choices=[]; view='suggest'; input.value=''; feedback.textContent=''; list.replaceChildren();
  }
  nav.onclick=()=>{
    if (!sheet.hidden) {close(); return;}
    refreshTimer=window.setInterval(render,1000);
    sheet.hidden=false; nav.setAttribute('aria-expanded','true'); layout(); render(); placeLoad=loadPlaces();
  };
  sheet.querySelector('.ask-heading button:last-child').onclick=()=>{close(); nav.focus();};
  window.addEventListener('pagehide',close);
  window.addEventListener('focus',()=>{if (!sheet.hidden) placeLoad=loadPlaces();});
  window.addEventListener('waypoints-changed',()=>{if (!sheet.hidden) placeLoad=loadPlaces();});
  new ResizeObserver(layout).observe(map.getContainer());
  window.visualViewport?.addEventListener('resize',layout);
  window.visualViewport?.addEventListener('scroll',layout);
  return {render,close,needsFix:()=>!sheet.hidden && (view==='single' || view==='group')};
}
