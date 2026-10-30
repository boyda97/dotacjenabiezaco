// Zgody na cookies (Google Analytics, Google Ads, Meta Pixel). Skrypty reklamowe i analityczne ładują się
// dopiero po zgodzie (Google Consent Mode v2 w trybie podstawowym). Identyfikatory przychodzą z serwera
// (/api/site-config: GA_ID, GOOGLE_ADS_ID, META_PIXEL_ID w .env); bez nich baner się nie pokazuje,
// bo strona nie używa wtedy żadnych ciasteczek poza niezbędnym ciasteczkiem logowania.
(function(){
  var KEY="dotacjo:zgody",VER=1,cfg=null,state=null,loaded={},queue=[];
  function read(){try{var s=JSON.parse(localStorage.getItem(KEY)||"null");return s&&s.v===VER?s:null}catch(e){return null}}
  function save(s){state=s;try{localStorage.setItem(KEY,JSON.stringify(s))}catch(e){}}
  function el(tag,attrs,html){var e=document.createElement(tag);for(var k in attrs)e.setAttribute(k,attrs[k]);if(html!=null)e.innerHTML=html;return e}
  function script(src){var s=document.createElement("script");s.async=true;s.src=src;document.head.appendChild(s)}

  function apply(){
    if(!cfg||!state)return;
    var g=window.gtag;
    if(g)g("consent","update",{analytics_storage:state.analytics?"granted":"denied",ad_storage:state.marketing?"granted":"denied",ad_user_data:state.marketing?"granted":"denied",ad_personalization:state.marketing?"granted":"denied"});
    var needG=(state.analytics&&cfg.gaId)||(state.marketing&&cfg.adsId);
    if(needG&&!loaded.g){
      loaded.g=true;script("https://www.googletagmanager.com/gtag/js?id="+encodeURIComponent(cfg.gaId||cfg.adsId));
      window.gtag("js",new Date());
    }
    if(loaded.g){
      if(state.analytics&&cfg.gaId&&!loaded.ga){loaded.ga=true;window.gtag("config",cfg.gaId,{anonymize_ip:true})}
      if(state.marketing&&cfg.adsId&&!loaded.ads){loaded.ads=true;window.gtag("config",cfg.adsId)}
    }
    if(state.marketing&&cfg.metaPixelId&&!loaded.fb){
      loaded.fb=true;
      var f=window.fbq=function(){f.callMethod?f.callMethod.apply(f,arguments):f.queue.push(arguments)};
      if(!window._fbq)window._fbq=f;f.push=f;f.loaded=true;f.version="2.0";f.queue=[];
      script("https://connect.facebook.net/en_US/fbevents.js");
      window.fbq("init",cfg.metaPixelId);window.fbq("track","PageView");
    }
    while(queue.length)track.apply(null,queue.shift());
  }

  // Zdarzenia konwersji (np. zakup). Bez zgody nic nie wysyłają.
  function track(name,params){
    if(!cfg||!state){queue.push([name,params]);return}
    params=params||{};
    if(window.gtag&&loaded.g){
      if(state.analytics&&cfg.gaId)window.gtag("event",name,params);
      if(state.marketing&&cfg.adsId&&name==="purchase"&&cfg.adsPurchaseLabel)
        window.gtag("event","conversion",{send_to:cfg.adsId+"/"+cfg.adsPurchaseLabel,value:params.value,currency:params.currency||"PLN"});
    }
    if(window.fbq&&state.marketing){
      var FB={purchase:"Purchase",begin_checkout:"InitiateCheckout",search:"Search",sign_up:"CompleteRegistration"};
      if(FB[name])window.fbq("track",FB[name],params.value?{value:params.value,currency:params.currency||"PLN"}:{});
    }
  }

  var CSS=".zg{position:fixed;left:12px;right:12px;bottom:12px;z-index:1000;max-width:560px;margin-left:auto;background:#fff;color:#14211b;border:1px solid #e2e8e2;border-radius:16px;box-shadow:0 12px 40px rgba(0,61,43,.18);padding:18px 18px 16px;font:14px/1.55 'Plus Jakarta Sans',system-ui,sans-serif}"+
    ".zg h2{font-size:16px;margin:0 0 6px}.zg p{margin:0 0 12px;color:#5e6d66}.zg a{color:#006f3d}.zg .r{display:flex;flex-wrap:wrap;gap:8px}"+
    ".zg button{font:700 14px/1 inherit;font-family:inherit;padding:11px 14px;border-radius:10px;border:1px solid #e2e8e2;background:#fff;color:#14211b;cursor:pointer}"+
    ".zg button.p{background:#00854A;border-color:#00854A;color:#fff}.zg label{display:flex;gap:10px;align-items:flex-start;margin:0 0 10px;cursor:pointer}"+
    ".zg label input{margin-top:3px;width:18px;height:18px;accent-color:#00854A;flex:none}.zg label b{display:block;font-size:14px}.zg label span{color:#5e6d66;font-size:13px}"+
    "@media (max-width:520px){.zg{left:8px;right:8px;bottom:8px;padding:16px}.zg .r button{flex:1 1 auto}}";

  var box=null;
  function close(){if(box){box.remove();box=null}}
  function choose(analytics,marketing){save({v:VER,analytics:!!analytics,marketing:!!marketing,at:new Date().toISOString()});close();apply()}
  function open(details){
    if(!cfg)return;close();
    if(!document.getElementById("zgCss"))document.head.appendChild(el("style",{id:"zgCss"},CSS));
    var hasA=!!cfg.gaId,hasM=!!(cfg.adsId||cfg.metaPixelId),cur=state||{analytics:false,marketing:false};
    box=el("div",{"class":"zg",role:"dialog","aria-label":"Ustawienia cookies","aria-live":"polite"});
    box.innerHTML='<h2>Cookies</h2><p>Używamy niezbędnego ciasteczka do logowania. Za Twoją zgodą także cookies '+
      [hasA?"analitycznych (żeby wiedzieć, co poprawić)":"",hasM?"marketingowych (żeby mierzyć skuteczność naszych reklam)":""].filter(Boolean).join(" i ")+
      '. Zgodę możesz zmienić w każdej chwili w stopce strony.</p>'+
      (details?'<label><input type="checkbox" checked disabled><span><b>Niezbędne</b><span>logowanie i bezpieczeństwo, zawsze włączone</span></span></label>'+
        (hasA?'<label><input type="checkbox" id="zgA"'+(cur.analytics?" checked":"")+'><span><b>Analityczne</b><span>Google Analytics: statystyki odwiedzin</span></span></label>':"")+
        (hasM?'<label><input type="checkbox" id="zgM"'+(cur.marketing?" checked":"")+'><span><b>Marketingowe</b><span>'+[cfg.adsId?"Google Ads":"",cfg.metaPixelId?"Meta (Facebook, Instagram)":""].filter(Boolean).join(", ")+': pomiar reklam</span></span></label>':"")+
        '<div class="r"><button type="button" class="p" data-z="save">Zapisz wybór</button><button type="button" data-z="all">Akceptuję wszystkie</button></div>'
      :'<div class="r"><button type="button" class="p" data-z="all">Akceptuję wszystkie</button><button type="button" data-z="none">Tylko niezbędne</button><button type="button" data-z="more">Ustawienia</button></div>');
    box.addEventListener("click",function(e){
      var b=e.target.closest("button[data-z]");if(!b)return;var z=b.dataset.z;
      if(z==="all")choose(true,true);else if(z==="none")choose(false,false);else if(z==="more")open(true);
      else if(z==="save")choose(hasA&&document.getElementById("zgA").checked,hasM&&document.getElementById("zgM").checked);
    });
    document.body.appendChild(box);
    var first=box.querySelector("button");if(first&&details)first.focus();
  }

  // Google Consent Mode v2: domyślnie wszystko odmówione, dopóki użytkownik nie zdecyduje.
  window.dataLayer=window.dataLayer||[];
  window.gtag=window.gtag||function(){window.dataLayer.push(arguments)};
  window.gtag("consent","default",{analytics_storage:"denied",ad_storage:"denied",ad_user_data:"denied",ad_personalization:"denied",wait_for_update:500});

  // Zdarzenia zapisane przez stronę, zanim ten skrypt się wczytał: (window.zgodyQ=window.zgodyQ||[]).push([nazwa, parametry]).
  var early=window.zgodyQ||[];
  window.zgodyQ={push:function(a){track(a[0],a[1])}};
  window.Zgody={open:function(){open(true)},track:track};
  early.forEach(function(a){track(a[0],a[1])});
  state=read();
  fetch("/api/site-config",{credentials:"same-origin"}).then(function(r){return r.ok?r.json():{}}).then(function(c){
    if(!c||!(c.gaId||c.adsId||c.metaPixelId)){queue=[];return}
    cfg=c;
    document.querySelectorAll("[data-zgody]").forEach(function(a){a.hidden=false;a.addEventListener("click",function(e){e.preventDefault();open(true)})});
    if(state)apply();else open(false);
  }).catch(function(){});
})();
