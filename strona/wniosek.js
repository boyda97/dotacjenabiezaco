// „Jak złożyć wniosek” przy karcie programu (strona główna i wyszukiwarka). Gdy AI wyciągnęło z regulaminu
// miejsce złożenia i listę dokumentów, pokazujemy je; inaczej typowe kroki dla danego operatora.
(function(){
  function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
  function where(p){
    if(p.apply_where)return p.apply_where;
    var t=(p.op||"")+" "+(p.url||"");
    if(/parp/i.test(t))return "Wniosek składasz online w systemie PARP, zwykle z podpisem kwalifikowanym lub profilem zaufanym.";
    if(/nfo[sś]|wfo[sś]/i.test(t))return "Wniosek składasz online w generatorze wniosków funduszu ochrony środowiska.";
    if(/urz[aą]d pracy|\bPUP\b|praca\.gov/i.test(t))return "Wniosek składasz w powiatowym urzędzie pracy właściwym dla miejsca zamieszkania, często online przez praca.gov.pl.";
    if(/bgk|po[zż]ycz/i.test(t+" "+(p.type||"")))return "Wniosek składasz u pośrednika finansowego wskazanego w ogłoszeniu (fundusz pożyczkowy lub bank).";
    if(/lgd|lokaln/i.test(t))return "Wniosek składasz w lokalnej grupie działania (LGD) dla Twojej gminy.";
    return "Miejsce i sposób złożenia wniosku podaje ogłoszenie operatora (link w nazwie programu).";
  }
  var TYPICAL=["Dane firmy z CEIDG lub KRS","Opis projektu i budżet: lista wydatków, najlepiej z ofertami","Oświadczenie o otrzymanej pomocy de minimis (jeśli dotyczy)","Zaświadczenia o niezaleganiu z ZUS i podatkami (gdy wymaga regulamin)","Podpis kwalifikowany albo profil zaufany do złożenia wniosku online"];
  window.Wniosek={html:function(p){
    var docs=(p.documents&&p.documents.length)?p.documents:null;
    return '<details class="howto"><summary>Jak złożyć wniosek</summary>'+
      (p.how&&p.how.indexOf("{")<0?'<p><b>Na co:</b> '+esc(p.how)+'</p>':"")+
      '<p><b>Gdzie:</b> '+esc(where(p))+'</p>'+
      '<p><b>'+(docs?"Dokumenty z regulaminu:":"Zwykle potrzebne:")+'</b></p><ul>'+(docs||TYPICAL).map(function(d){return"<li>"+esc(d)+"</li>"}).join("")+'</ul>'+
      '<ol><li>Przeczytaj regulamin naboru (link w nazwie programu).</li><li>Przygotuj dokumenty i budżet.</li><li>Złóż wniosek kilka dni przed terminem, bo w ostatnim dniu systemy bywają przeciążone.</li></ol>'+
      '</details>';
  }};
})();
