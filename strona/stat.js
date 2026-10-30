// Licznik odwiedzin Dotacjo: bez ciasteczek i bez danych osobowych (ścieżka strony + skąd przyszedł gość).
(function(){try{var d=JSON.stringify({p:location.pathname,r:document.referrer||""});if(navigator.sendBeacon)navigator.sendBeacon("/api/stats/hit",d);else fetch("/api/stats/hit",{method:"POST",body:d,keepalive:true})}catch(e){}})();
