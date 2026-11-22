// Dotacjo jako aplikacja na telefon (PWA): rejestruje service worker i proponuje instalację.
// Android (Chrome, Samsung, Edge): przycisk „Zainstaluj” otwiera systemowe okno instalacji.
// iPhone/iPad: Apple nie pozwala instalować jednym przyciskiem, więc pokazujemy 2 proste kroki w Safari.
// Baner pojawia się tylko na telefonie, tylko poza aplikacją, nie zasłania banera cookies,
// a po „Nie teraz” wraca dopiero po 30 dniach. Linki z atrybutem data-aplikacja otwierają to samo.
(function(){
  if("serviceWorker" in navigator){
    addEventListener("load",function(){navigator.serviceWorker.register("/sw.js").catch(function(){})});
  }

  var ua=navigator.userAgent||"";
  var standalone=(window.matchMedia&&matchMedia("(display-mode: standalone)").matches)||navigator.standalone===true;
  if(standalone){document.documentElement.classList.add("w-aplikacji");return}

  var KEY="dotacjo:aplikacja-ukryj",DAYS=30,promptEv=null,bar=null;
  var ios=/iPhone|iPad|iPod/.test(ua)||(navigator.platform==="MacIntel"&&navigator.maxTouchPoints>1);
  var inApp=/FBAN|FBAV|Instagram|Line\/|TikTok|Messenger/.test(ua);
  var phone=window.matchMedia&&matchMedia("(max-width: 820px) and (pointer: coarse)").matches;
  if(location.pathname.indexOf("/admin")===0)return;

  function hiddenRecently(){try{var t=+localStorage.getItem(KEY);return t&&Date.now()-t<DAYS*864e5}catch(e){return false}}
  function hideFor30(){try{localStorage.setItem(KEY,String(Date.now()))}catch(e){}}
  function available(){return !!promptEv||ios}

  var CSS=".apk{position:fixed;left:12px;right:12px;bottom:12px;z-index:990;max-width:480px;margin:0 auto;background:#fff;color:#050d09;"+
    "border:1px solid #a9b9ae;border-radius:16px;box-shadow:0 12px 40px rgba(0,61,43,.22);padding:14px;display:flex;gap:12px;align-items:center;"+
    "font:14px/1.45 'Plus Jakarta Sans',system-ui,-apple-system,sans-serif;padding-bottom:max(14px,env(safe-area-inset-bottom))}"+
    ".apk img{width:48px;height:48px;border-radius:12px;flex:none}.apk b{display:block;font-size:15px}.apk .t{flex:1;min-width:0}"+
    ".apk .t span{color:#2c3a33}.apk .r{display:flex;flex-direction:column;gap:6px;flex:none}"+
    ".apk button{font:inherit;font-weight:700;border-radius:10px;padding:10px 14px;cursor:pointer;border:0}"+
    ".apk .p{background:#003D2B;color:#fff}.apk .n{background:transparent;color:#2c3a33;padding:4px 8px;font-weight:600}"+
    ".apk-s{position:fixed;inset:0;z-index:9998;background:rgba(5,13,9,.5);display:flex;align-items:flex-end;justify-content:center;padding:12px}"+
    ".apk-s .b{background:#fff;color:#050d09;width:100%;max-width:440px;border-radius:20px;padding:22px 20px;padding-bottom:max(22px,env(safe-area-inset-bottom));"+
    "font:15px/1.5 'Plus Jakarta Sans',system-ui,-apple-system,sans-serif}.apk-s h3{margin:0 0 4px;font-size:19px}.apk-s p{margin:0 0 14px;color:#2c3a33}"+
    ".apk-s ol{margin:0 0 18px;padding:0;list-style:none;display:grid;gap:12px}.apk-s li{display:flex;gap:12px;align-items:center;background:#e6f5ec;border-radius:12px;padding:12px}"+
    ".apk-s li i{font-style:normal;font-weight:800;background:#003D2B;color:#fff;border-radius:50%;width:28px;height:28px;display:grid;place-items:center;flex:none}"+
    ".apk-s svg{vertical-align:-5px}.apk-s button{font:inherit;font-weight:700;width:100%;background:#003D2B;color:#fff;border:0;border-radius:12px;padding:13px;cursor:pointer}";
  var SHARE='<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#0a66d8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="Udostępnij"><path d="M12 3v12"/><path d="M8 7l4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>';
  var PLUS='<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#050d09" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/></svg>';

  function style(){if(document.getElementById("apk-css"))return;var s=document.createElement("style");s.id="apk-css";s.textContent=CSS;document.head.appendChild(s)}

  function iosSteps(){
    style();
    var w=document.createElement("div");w.className="apk-s";w.setAttribute("role","dialog");w.setAttribute("aria-modal","true");
    w.innerHTML='<div class="b"><h3>Dodaj Dotacjo do ekranu</h3>'+
      (inApp
        ?'<p>Ta przeglądarka nie pozwala instalować aplikacji. Otwórz dotacjo.pl w Safari: stuknij ••• w rogu i wybierz „Otwórz w przeglądarce”.</p>'
        :'<p>Na iPhonie zajmie to 10 sekund:</p><ol>'+
          '<li><i>1</i><span>Stuknij '+SHARE+' <b>Udostępnij</b> na dole ekranu (w Chrome: u góry obok adresu).</span></li>'+
          '<li><i>2</i><span>Przewiń w dół i wybierz '+PLUS+' <b>Do ekranu początkowego</b>, potem <b>Dodaj</b>.</span></li></ol>')+
      '<button type="button">Rozumiem</button></div>';
    w.addEventListener("click",function(e){if(e.target===w||e.target.tagName==="BUTTON")w.remove()});
    document.body.appendChild(w);
  }

  function install(){
    if(promptEv){
      var ev=promptEv;promptEv=null;ev.prompt();
      (ev.userChoice||Promise.resolve({})).then(function(c){if(c&&c.outcome==="accepted")closeBar(false);refreshLinks()});
    }else if(ios){iosSteps()}
  }

  function closeBar(remember){if(bar){bar.remove();bar=null}if(remember)hideFor30()}

  function showBar(){
    if(bar||!phone||!available()||hiddenRecently())return;
    if(document.querySelector(".zg"))return setTimeout(showBar,3000); // najpierw baner cookies
    style();
    bar=document.createElement("div");bar.className="apk";bar.setAttribute("role","region");bar.setAttribute("aria-label","Aplikacja Dotacjo");
    bar.innerHTML='<img src="/brand/icons/icon-192.png" alt=""><div class="t"><b>Dotacjo na telefonie</b><span>Ikona na ekranie, otwiera się jak aplikacja. Za darmo.</span></div>'+
      '<div class="r"><button type="button" class="p">Zainstaluj</button><button type="button" class="n">Nie teraz</button></div>';
    bar.querySelector(".p").onclick=install;
    bar.querySelector(".n").onclick=function(){closeBar(true)};
    document.body.appendChild(bar);
  }

  function refreshLinks(){
    document.querySelectorAll("[data-aplikacja]").forEach(function(a){
      a.hidden=!available();
      if(!a._apk){a._apk=1;a.addEventListener("click",function(e){e.preventDefault();install()})}
    });
  }

  addEventListener("beforeinstallprompt",function(e){e.preventDefault();promptEv=e;refreshLinks();setTimeout(showBar,4000)});
  addEventListener("appinstalled",function(){promptEv=null;closeBar(false);refreshLinks()});
  function start(){refreshLinks();if(ios)setTimeout(showBar,4000)}
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start);else start();
})();
