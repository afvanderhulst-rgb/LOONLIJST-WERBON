/* MIT Werkbon - "Agenda servicemonteurs" (PDF van kantoor) uitlezen.
   Werkt op een digitale PDF en op een foto/scan met tekstlaag (bijv. Microsoft Lens).
   Invoer: pagina's met woorden + positie (zoals pdf.js of Tesseract ze geeft):
     [{w: breedte, h: hoogte, items: [{s: 'tekst', x, y (basislijn, van boven), w: breedte}]}]
   Uitvoer: {regels: [{monteur, pd:'JJJJ-MM-DD', pt:'UU:MM', duur:'U,MM', min, wb, inst, klant, adres, plaats, tel, oms}], fouten: []}
   LET OP: dit bestand staat twee keer: in de app-map (voor beheer/kantoor.html) en in functions/ (voor de server).
   Pas ze allebei aan (ze moeten gelijk zijn). */
(function (root) {
  'use strict';
  var DAG = /^(ma|di|wo|do|vr|za|zo)\.?$/i;
  var DATUM = /(\d{1,2})-(\d{1,2})-(\d{4})/;
  var TIJD = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/;
  var DUUR = /^(\d{1,2})[,.](\d{2})$/;
  var TEL = /^(\+?\d[\d -]{7,}\d)$/;

  // woorden met spaties erin opdelen, met een geschatte x per woord
  function woorden(items) {
    var out = [];
    (items || []).forEach(function (i) {
      var s = String(i.s || '').replace(/\s+/g, ' ').trim();
      if (!s) return;
      var delen = s.split(' '), w = +i.w || s.length * 4, per = w / Math.max(1, s.length), pos = 0;
      delen.forEach(function (d) {
        out.push({s: d.replace(/^\|+/, ''), x: (+i.x) + pos * per, y: +i.y});
        pos += d.length + 1;
      });
    });
    return out.filter(function (o) { return o.s; });
  }
  // woorden met ongeveer dezelfde y samen in een regel, van links naar rechts
  function regels(ws, tol) {
    var r = [];
    ws.slice().sort(function (a, b) { return a.y - b.y || a.x - b.x; }).forEach(function (w) {
      var l = r[r.length - 1];
      if (l && Math.abs(l.y - w.y) <= tol) { l.ws.push(w); l.y = (l.y * (l.ws.length - 1) + w.y) / l.ws.length; } else r.push({y: w.y, ws: [w]});
    });
    r.forEach(function (l) { l.ws.sort(function (a, b) { return a.x - b.x; }); l.t = l.ws.map(function (w) { return w.s; }).join(' ').replace(/\s+/g, ' ').trim(); });
    return r;
  }
  function kop(ws, re, minY) { for (var i = 0; i < ws.length; i++) if (ws[i].y > (minY || 0) && re.test(ws[i].s)) return ws[i]; return null; }

  function pagina(p, fouten) {
    var ws = woorden(p.items), W = +p.w || 500, uit = [];
    if (!ws.length) return uit;
    // kolomkoppen (of een schatting als ze ontbreken)
    var kB = kop(ws, /^bonnummer/i), kN = kop(ws, /^naam/i), kT = kop(ws, /^telefoon/i), kM = kop(ws, /^monteur/i), kD = kop(ws, /^datum$/i, kM ? kM.y - 2 : 0);
    var X = {
      bon: kB ? kB.x : W * 0.09, naam: kN ? kN.x : W * 0.17, tel: kT ? kT.x : W * 0.39,
      mon: kM ? kM.x : W * 0.48, dat: kD ? kD.x : W * 0.72,
    };
    var kopY = Math.max(kM ? kM.y : 0, kD ? kD.y : 0, kN ? kN.y : 0) + 4;
    var lijf = ws.filter(function (w) { return w.y > kopY; });
    // ankers: een datum in de kolom Planning
    var ankers = lijf.filter(function (w) { return DATUM.test(w.s) && w.x > X.mon + (X.dat - X.mon) * 0.5; }).sort(function (a, b) { return a.y - b.y; });
    var dd = []; ankers.forEach(function (a) { if (!dd.length || a.y - dd[dd.length - 1].y > 6) dd.push(a); }); ankers = dd;
    // tekstherkenning mist soms de datum: een tijd in de kolom Tijd zonder datum ernaast is ook een nieuwe regel
    var tijden = lijf.filter(function (w) { return /^\d{1,2}[:.]\d{2}$/.test(w.s) && w.x > X.dat + 15 && w.x < X.dat + 110; });
    var offs = []; ankers.forEach(function (a) { tijden.forEach(function (t) { if (Math.abs(t.y - a.y) < 5) offs.push(t.x - a.x); }); });
    offs.sort(function (a, b) { return a - b; });
    var off = offs.length ? offs[Math.floor(offs.length / 2)] : 47;
    // alleen als er op dezelfde hoogte ook een duur (reparatietijd) staat; anders is het tekst als "niet voor 15.30 uur"
    var duren = lijf.filter(function (w) { return DUUR.test(w.s) && w.x > X.dat + 60; });
    tijden.forEach(function (t) { if (!ankers.some(function (a) { return Math.abs(a.y - t.y) < 8; }) && duren.some(function (d) { return d.x > t.x && Math.abs(d.y - t.y) < 7; })) ankers.push({s: '', x: t.x - off, y: t.y, synth: true}); });
    ankers.sort(function (a, b) { return a.y - b.y; });
    if (!ankers.length) return uit;
    var vorigePd = '';
    var hoogte = 0; for (var i = 1; i < ankers.length; i++) hoogte = Math.max(hoogte, ankers[i].y - ankers[i - 1].y);
    ankers.forEach(function (a, n) {
      var dx = a.x - X.dat; // scheef gefotografeerd: kolommen schuiven mee
      var y0 = a.y - 7, y1 = n + 1 < ankers.length ? ankers[n + 1].y - 7 : a.y + Math.max(40, hoogte || 60);
      var band = lijf.filter(function (w) { return w.y >= y0 && w.y < y1; });
      var b = {naam: X.naam + dx - (X.naam - X.bon) * 0.3, tel: X.tel + dx - (X.tel - X.naam) * 0.15, mon: X.mon + dx - (X.mon - X.tel) * 0.3, dag: X.dat + dx - 26};
      var kol = function (w) { return w.x < b.naam ? 'bon' : w.x < b.tel ? 'naam' : w.x < b.mon ? 'tel' : 'mon'; };
      var K = {bon: [], naam: [], tel: [], mon: []};
      band.forEach(function (w) { K[kol(w)].push(w); });
      // monteur-kolom: de regel op de hoogte van het anker = monteur + dag/datum/tijd/duur; de rest = omschrijving
      var mr = regels(K.mon, 3.5), ai = -1, best = 1e9;
      mr.forEach(function (l, j) { var d = Math.abs(l.y - a.y); if (d < best) { best = d; ai = j; } });
      var r = {monteur: '', pd: '', pt: '', duur: '', min: 0, wb: '', inst: '', klant: '', adres: '', plaats: '', tel: '', oms: ''};
      if (ai >= 0) {
        var naam = [], rest = [];
        mr[ai].ws.forEach(function (w) { (w.x < b.dag ? naam : rest).push(w); });
        r.monteur = naam.map(function (w) { return w.s; }).join(' ').replace(/[|\[\](){}]/g, '').replace(/\s+/g, ' ').trim();
        var t = rest.map(function (w) { return w.s; }).join(' ');
        var m = DATUM.exec(t);
        if (m) r.pd = m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
        var na = m ? t.slice(m.index + m[0].length) : t, mt = TIJD.exec(na);
        if (mt) r.pt = ('0' + mt[1]).slice(-2) + ':' + mt[2];
        var laatste = rest.length ? rest[rest.length - 1].s : '', md = DUUR.exec(laatste);
        if (md && !(mt && laatste.indexOf(':') >= 0)) { r.duur = md[1] + ',' + md[2]; r.min = (+md[1]) * 60 + Math.min(59, +md[2]); }
        r.monteur = r.monteur.replace(/^[^A-Za-z\u00C0-\u024F]+/, '');
      }
      // tijd/duur die net iets hoger of lager staan (scheve foto): in de buurt van het anker zoeken
      var gebruikt = [];
      if (!r.pt) { var tt0 = K.mon.filter(function (w) { return w.x > b.dag + 20 && /^\d{1,2}[:.]\d{2}$/.test(w.s) && Math.abs(w.y - a.y) < 7; })[0]; if (tt0) { var q0 = TIJD.exec(tt0.s); r.pt = ('0' + q0[1]).slice(-2) + ':' + q0[2]; gebruikt.push(tt0); } }
      if (!r.duur) { var du0 = K.mon.filter(function (w) { return w.x > b.dag + 70 && DUUR.test(w.s) && Math.abs(w.y - a.y) < 7; })[0]; if (du0) { var q1 = DUUR.exec(du0.s); r.duur = q1[1] + ',' + q1[2]; r.min = (+q1[1]) * 60 + Math.min(59, +q1[2]); gebruikt.push(du0); } }
      if (gebruikt.length) mr = regels(K.mon.filter(function (w) { return gebruikt.indexOf(w) < 0; }), 3.5).map(function (l) { return l; });
      if (gebruikt.length) { ai = -1; best = 1e9; mr.forEach(function (l, j) { var d = Math.abs(l.y - a.y); if (d < best) { best = d; ai = j; } }); if (best > 5) ai = -1; }
      r.oms = mr.filter(function (l, j) { return j !== ai; }).map(function (l) { return l.t; }).filter(Boolean).join('\n');
      // links: bonnummer + installatienummer, naam/adres/plaats, telefoon
      var br = regels(K.bon, 3.5), nr = regels(K.naam, 3.5), tr = regels(K.tel, 3.5);
      br.forEach(function (l) { var m5 = /\b(\d{5,6})\b/.exec(l.t); if (!r.wb && m5 && Math.abs(l.y - a.y) < 6) r.wb = m5[1]; else if (!r.inst && l.t && !(m5 && m5[1] === r.wb)) r.inst = l.t.replace(/\s+/g, ''); });
      var tt = tr.map(function (l) { return l.t; }).join(' ').replace(/\s+/g, ' ').trim(); if (TEL.test(tt.replace(/\s/g, ''))) r.tel = tt.replace(/\s/g, ''); else r.tel = tt;
      var nl = nr.map(function (l) { return l.t; }).filter(Boolean);
      // een bonnummer dat net in de naamkolom viel
      if (!r.wb && nl.length) { var m6 = /^(\d{5,6})\s+(.*)$/.exec(nl[0]); if (m6) { r.wb = m6[1]; nl[0] = m6[2]; } }
      var pi = -1; nl.forEach(function (x, j) { if (/\b\d{4}\s?[A-Z]{2}\b/.test(x)) pi = j; });
      if (pi >= 0) { r.plaats = nl[pi].replace(/^(\d{4})\s*([A-Z]{2})\s+/, '$1 $2 '); }
      var voor = pi >= 0 ? nl.slice(0, pi) : nl;
      if (voor.length) { r.klant = voor[0]; r.adres = voor.slice(1).join(', '); }
      // installatienummer (bijv. 1411DD7/0) dat over twee kolommen viel
      if (/\/$/.test(r.inst) && /^\d+\s/.test(r.adres)) { r.inst += r.adres.split(' ')[0]; r.adres = r.adres.replace(/^\d+\s+/, ''); }
      if (/\/$/.test(r.inst) && /^\d+\s/.test(r.klant) && !r.adres) { r.inst += r.klant.split(' ')[0]; r.klant = r.klant.replace(/^\d+\s+/, ''); }
      if (!r.pd && a.synth && vorigePd && r.pt) { r.pd = vorigePd; r.gok = 1; fouten.push('Datum bij ' + r.pt + ' ' + (r.klant || r.oms.split('\n')[0] || '') + ' niet goed leesbaar: dezelfde dag als de regel erboven aangenomen. Controleer dit.'); }
      if (!r.pd) { fouten.push('Regel zonder leesbare datum overgeslagen (' + (r.klant || r.monteur || 'onbekend') + ').'); return; }
      vorigePd = r.pd;
      if (!r.pt) fouten.push('Geen tijd gevonden bij ' + r.pd + ' ' + (r.klant || r.oms.split('\n')[0] || '') + '.');
      uit.push(r);
    });
    return uit;
  }

  function leesAgenda(paginas) {
    var fouten = [], alle = [];
    (paginas || []).forEach(function (p) { alle = alle.concat(pagina(p, fouten)); });
    // dubbele regels (zelfde pagina twee keer gescand) eruit; de vollediger regel blijft
    var gez = {}, uit = [];
    alle.forEach(function (r) {
      var k = r.pd + '|' + r.pt + '|' + (r.wb || '') + '|' + (r.monteur.split(' ').pop() || '').toLowerCase();
      var vol = function (x) { return (x.klant + x.adres + x.plaats + x.oms + x.tel + x.duur).length; };
      if (gez[k] == null) { gez[k] = uit.length; uit.push(r); } else if (vol(r) > vol(uit[gez[k]])) uit[gez[k]] = r;
    });
    uit.sort(function (a, b) { return (a.pd + a.pt).localeCompare(b.pd + b.pt); });
    return {regels: uit, fouten: fouten};
  }

  // monteur zoeken op naam (OCR-fouten toegestaan: "Arian" = "Arjan")
  function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim(); }
  function lev(a, b) {
    var m = a.length, n = b.length, d = [], i, j;
    for (i = 0; i <= m; i++) d[i] = [i];
    for (j = 0; j <= n; j++) d[0][j] = j;
    for (i = 1; i <= m; i++) for (j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[m][n];
  }
  function zoekMonteur(naam, lijst) {
    var a = norm(naam); if (!a) return null;
    var best = null, bs = 1e9;
    (lijst || []).forEach(function (m) {
      var b = norm(m.naam || ''); if (!b) return;
      var s = lev(a, b);
      if (s < bs) { bs = s; best = m; }
    });
    return best && bs <= Math.max(2, Math.round(norm(naam).length * 0.15)) ? best : null;
  }

  // regels per monteur; een naam die niet te lezen was hoort bij de enige monteur van deze agenda (als dat er één is)
  function verdeel(regels, lijst) {
    var G = {}, los = [], uids = [];
    regels.forEach(function (x) { var mt = zoekMonteur(x.monteur, lijst); if (mt) { if (!G[mt.uid]) { G[mt.uid] = {mt: mt, regels: []}; uids.push(mt.uid); } G[mt.uid].regels.push(x); } else los.push(x); });
    if (uids.length === 1 && los.length) { los.forEach(function (x) { x.gokMonteur = 1; G[uids[0]].regels.push(x); }); los = []; }
    uids.forEach(function (u) { G[u].regels.sort(function (a, b) { return (a.pd + a.pt).localeCompare(b.pd + b.pt); }); });
    return {groepen: uids.map(function (u) { return G[u]; }), los: los};
  }
  // ---- wijzigingen t.o.v. de vorige agenda (v181) ----
  var DGN = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
  function hash(t) { var h = 5381; t = String(t || ''); for (var i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0; return h.toString(36); }
  function eerste(r) { return String(r.oms || '').split('\n')[0].trim().toLowerCase(); }
  function sleutel(r) { return r.pd + '_' + String(r.pt || '').replace(':', '') + '_' + (r.wb ? r.wb : 'x' + hash(eerste(r))); }
  // vaste document-id per afspraak: opnieuw inlezen overschrijft dezelfde afspraak (geen dubbele meldingen)
  function docIds(uid, regels) { var gez = {}; return regels.map(function (r) { var id = (uid + '_' + sleutel(r)).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 140), k = id, n = 1; while (gez[k]) k = id + '_' + (++n); gez[k] = 1; return k; }); }
  function inhoud(r) { return [r.duur, r.wb, r.klant, r.adres, r.plaats, r.tel, r.oms].map(function (x) { return String(x || '').trim(); }).join('|'); }
  function kort(r) { var p = String(r.pd || '').split('-'), d = p.length === 3 ? new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])) : null;
    return (d ? DGN[d.getUTCDay()] + ' ' + (+p[2]) + '-' + (+p[1]) : r.pd) + (r.pt ? ' ' + r.pt : '') + ' ' + (r.wb ? r.wb + (r.klant ? ' ' + r.klant : '') : String(r.oms || '').split('\n')[0]); }
  // oud = afspraken die er al stonden (zelfde monteur, zelfde periode), nieuw = de nieuwe agenda
  function vergelijk(oud, nieuw) {
    var O = {}, N = {}, bij = [], weg = [], gew = [];
    oud.forEach(function (r) { O[sleutel(r)] = r; }); nieuw.forEach(function (r) { N[sleutel(r)] = r; });
    nieuw.forEach(function (r) { var o = O[sleutel(r)]; if (!o) bij.push(r); else if (inhoud(o) !== inhoud(r)) gew.push({oud: o, nieuw: r, tekst: kort(r) + ': gegevens aangepast'}); });
    oud.forEach(function (r) { if (!N[sleutel(r)]) weg.push(r); });
    // verzet naar een andere tijd of dag: zelfde bon (of zelfde omschrijving) in dezelfde week
    bij = bij.filter(function (r) {
      var i = -1; weg.forEach(function (o, j) { if (i < 0 && (r.wb ? o.wb === r.wb : (!o.wb && eerste(o) === eerste(r) && o.pd === r.pd))) i = j; });
      if (i < 0) return true;
      var o = weg.splice(i, 1)[0];
      gew.push({oud: o, nieuw: r, tekst: 'Verzet: ' + kort(o) + ' \u2192 ' + kort(r).split(' ').slice(0, r.pt ? 3 : 2).join(' ')});
      return false;
    });
    var regels = [].concat(gew.map(function (g) { return g.tekst; }), bij.map(function (r) { return 'Nieuw: ' + kort(r); }), weg.map(function (r) { return 'Vervallen: ' + kort(r); }));
    return {bij: bij.length, weg: weg.length, gew: gew.length, eerste: !oud.length, regels: regels};
  }
  var api = {leesAgenda: leesAgenda, zoekMonteur: zoekMonteur, verdeel: verdeel, docIds: docIds, vergelijk: vergelijk, kort: kort};
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.mitAgenda = api;
})(typeof window !== 'undefined' ? window : this);
