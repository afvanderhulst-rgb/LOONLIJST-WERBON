/* Externe onderdelen: eerst van het eigen adres (lib/, gevuld door Vercel bij publiceren),
   lukt dat niet dan automatisch van de oude externe plek (terugval). */
(function(){
var L={
 pdfjs:{n:'pdf.js (PDF lezen)',l:'lib/pdf.min.js',c:'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',g:'pdfjsLib'},
 pdfworker:{n:'pdf.js worker',l:'lib/pdf.worker.min.js',c:'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',g:'pdfjsWorker'},
 jspdf:{n:'jsPDF (PDF maken)',l:'lib/jspdf.umd.min.js',c:'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',g:'jspdf'},
 pdflib:{n:'pdf-lib (invulvelden, samenvoegen)',l:'lib/pdf-lib.min.js',c:'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js',g:'PDFLib'},
 jszip:{n:'JSZip (zip-bestand)',l:'lib/jszip.min.js',c:'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',g:'JSZip'},
 tesseract:{n:'Tesseract (bon scannen)',l:'lib/tesseract/tesseract.min.js',c:'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',g:'Tesseract'}
};
var USED={},P={};
function tag(src){return new Promise(function(ok,no){var s=document.createElement('script');s.src=src;s.onload=ok;s.onerror=function(){s.remove();no(new Error(src))};document.head.appendChild(s)})}
window.mitLoad=function(n){var d=L[n];if(!d)return Promise.reject(new Error('onbekend onderdeel '+n));
 if(d.g&&window[d.g]){if(!USED[n])USED[n]='eigen';return Promise.resolve()}
 if(P[n])return P[n];
 P[n]=tag(d.l).then(function(){if(d.g&&!window[d.g])throw new Error('leeg');USED[n]='eigen'})
  .catch(function(){return tag(d.c).then(function(){USED[n]='extern'})});
 P[n].catch(function(){P[n]=null});return P[n]};
window.mitLibs={list:L,used:USED,local:function(n){return USED[n]==='eigen'},abs:function(p){return new URL(p,location.href).href}};
})();
