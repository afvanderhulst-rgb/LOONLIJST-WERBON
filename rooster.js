/* Storingsrooster uitlezen uit de tekst van de PDF (pdf.js getTextContent).
   Gebruikt door beheer.html. Geeft {weken, monteurs, calamiteiten, titel, fouten} terug. */
(function(root){
function norm(v){return String(v||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'')}
function lev(a,b){var m=a.length,n=b.length,d=[],i,j;for(i=0;i<=m;i++){d[i]=[i]}for(j=0;j<=n;j++)d[0][j]=j;
 for(i=1;i<=m;i++)for(j=1;j<=n;j++)d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(a[i-1]===b[j-1]?0:1));return d[m][n]}
// hoe goed lijken twee namen op elkaar (0 = gelijk)
function dist(a,b){a=norm(a);b=norm(b);if(!a||!b)return 99;if(a===b)return 0;return lev(a,b)}
function best(name,list,max){var r=null,bd=99,second=99;list.forEach(function(x){var d=dist(name,x);if(d<bd){second=bd;bd=d;r=x}else if(d<second)second=d});
 return (r!=null&&bd<=(max==null?2:max)&&second>bd)?{naam:r,d:bd}:null}
function iso(s){var m=/^(\d{2})-(\d{2})-(\d{2})$/.exec(s);if(!m)return null;return '20'+m[3]+'-'+m[2]+'-'+m[1]}
function parse(items,H){
 var it=items.filter(function(i){return i&&String(i.str||'').trim()}).map(function(i){var t=i.transform||[1,0,0,1,0,0];return {s:String(i.str).trim(),x:t[4],y:H-t[5],w:i.width||0,rot:Math.abs(t[1])>0.01}});
 var F=[],T=function(re){return it.filter(function(i){return re.test(i.s)})[0]};
 // 1. kolommen: gedraaide datums, twee rijen (einde en start)
 var dates=it.filter(function(i){return i.rot&&/^\d{2}-\d{2}-\d{2}$/.test(i.s)}),rows={};
 dates.forEach(function(d){var k=Math.round(d.y);var r=null;for(var y in rows)if(Math.abs(+y-d.y)<3)r=y;(rows[r||k]=rows[r||k]||[]).push(d)});
 var ry=Object.keys(rows).filter(function(y){return rows[y].length>=10}).sort(function(a,b){return rows[b].length-rows[a].length}).slice(0,2);
 if(ry.length<2){F.push('Datums van het rooster niet gevonden.');return {fouten:F}}
 ry.forEach(function(y){rows[y].sort(function(a,b){return a.x-b.x})});
 var A=rows[ry[0]],B=rows[ry[1]],sRow=(iso(A[0].s)<iso(B[0].s))?A:B,eRow=sRow===A?B:A;
 var cols=sRow.map(function(d){var e=null,bd=99;eRow.forEach(function(x){var dd=Math.abs(x.x-d.x);if(dd<bd){bd=dd;e=x}});return {x:d.x,s:iso(d.s),e:e&&bd<4?iso(e.s):null}});
 cols.forEach(function(c){if(!c.e){var d=new Date(c.s+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+7);c.e=d.toISOString().slice(0,10)}});
 // weeknummers: getallenrij net onder de startdatums
 var lbl=T(/^weeknummer/i),wy=lbl?lbl.y+4:null;
 var nums=it.filter(function(i){return !i.rot&&/^\d{1,2}$/.test(i.s)&&(wy==null||Math.abs(i.y-wy)<8)});
 var cx=function(i){return i.x+i.w/2},near=function(x){var r=null,bd=99;cols.forEach(function(c,k){var d=Math.abs(x-c.x);if(d<bd){bd=d;r=k}});return bd<7?r:null};
 nums.forEach(function(n){var k=near(cx(n));if(k!=null&&cols[k].w==null)cols[k].w=+n.s});
 cols.forEach(function(c){if(c.w==null){var m=new Date(c.s+'T12:00:00Z');m.setUTCDate(m.getUTCDate()+3);var t=new Date(m);t.setUTCDate(t.getUTCDate()+3);var y=t.getUTCFullYear();c.w=Math.ceil(((t-Date.UTC(y,0,1))/864e5+1)/7)}});
 // 2. bouwvak: label boven de kolommen
 var bv=it.filter(function(i){return /^bouwvak$/i.test(i.s)});
 cols.forEach(function(c){c.bouwvak=bv.some(function(b){return c.x>=b.x-4&&c.x<=b.x+b.w+4})});
 // 3. monteurs: rijen tussen "Monteurs Service & Onderhoud" en "Bij storing"
 var top=T(/^Monteurs Service/i),bot=T(/^Bij storing/i),y0=top?top.y+3:0,y1=bot?bot.y-3:H,x0=cols[0].x-10;
 var names=it.filter(function(i){return !i.rot&&i.x<x0&&i.y>y0&&i.y<y1&&/[a-z]{2}/i.test(i.s)});
 var weken=cols.map(function(c){return {w:c.w,s:c.s,e:c.e,bouwvak:c.bouwvak,wie:[]}}),mont=[];
 names.forEach(function(nm){var n=0;it.forEach(function(i){if(i.s==='1'&&!i.rot&&Math.abs(i.y-nm.y)<4.5&&i.x>x0){var k=near(cx(i));if(k!=null){weken[k].wie.push(nm.s);n++}}});mont.push({naam:nm.s,n:n})});
 // 4. telefoonnummers
 var tel=it.filter(function(i){return /^:?\s*0\d[\d ]{7,}$/.test(i.s)}),cal=T(/^Bij Cal/i),calX=cal?cal.x+200:300,lijst=[],calam=[];
 tel.forEach(function(t){var nm=null,bd=1e9;it.forEach(function(i){if(i!==t&&!i.rot&&/[a-z]{2}/i.test(i.s)&&Math.abs(i.y-t.y)<2&&i.x<t.x){var d=t.x-(i.x+i.w);if(d<bd){bd=d;nm=i}}});
  if(!nm)return;var o={naam:nm.s.replace(/\s*:\s*$/,''),tel:t.s.replace(/^:\s*/,'').replace(/\s+/g,' ').trim(),y:t.y};(t.x<calX&&cal&&t.y>cal.y?calam:lijst).push(o)});
 calam.sort(function(a,b){return a.y-b.y});lijst.sort(function(a,b){return a.y-b.y});calam.forEach(function(o){delete o.y});lijst.forEach(function(o){delete o.y});
 mont.forEach(function(m){var b=best(m.naam,lijst.map(function(x){return x.naam}));if(b){var o=lijst.filter(function(x){return x.naam===b.naam})[0];m.tel=o.tel;m.telNaam=o.naam}});
 var tt=T(/^Rooster storingsdienst/i);
 if(!weken.some(function(w){return w.wie.length}))F.push('Geen diensten gevonden in het rooster.');
 return {titel:tt?tt.s:'Rooster storingsdienst',weken:weken,monteurs:mont,calamiteiten:calam,collegas:lijst,fouten:F}}
var api={parse:parse,dist:dist,best:best,norm:norm};
if(typeof module!=='undefined')module.exports=api;else root.mitRooster=api;
})(this);
