/* MIT Werkbon - servercode (Firebase Cloud Functions, regio europe-west1)
   - pushKlaar:   melding naar de monteur zodra kantoor een bon klaarzet (inbox/{id})
   - pushTest:    testmelding als de monteur in de app op "Testmelding" tikt (users/{uid}/pushq/{id})
   - pushPlan:    elke 15 minuten de geplande herinneringen versturen (users/{uid}/pushplan/plan)
   - mailKantoor: werkbon (PDF) direct naar kantoor mailen via Brevo, met kopie naar de monteur;
                  ook de weeklijst (weeklijst-PDF + verzamel-PDF) naar de leidinggevende (soort: 'weeklijst')
   - mailInbox:   werkbon klaarzetten doordat kantoor hem mailt naar <monteur>@mit-werkbon.com
                  (Cloudflare Email Routing + Worker; afzender wordt gecontroleerd met DMARC/DKIM/ARC)
   - (v202) rooster@mit-werkbon.com: storingsrooster-PDF van kantoor -> direct gepubliceerd (rooster/actief; vorige versie in rooster/vorige)
   - (v180) agenda@mit-werkbon.com: agenda-PDF van kantoor -> planning (collectie agenda), pushAgenda meldt het de monteur
   - inboxSetup:  knop op beheer.html die het Cloudflare-script maakt
   Geheimen (Secret Manager): VAPID_PRIVATE_KEY (pushmeldingen), BREVO_API_KEY (mailen). */
const {onDocumentCreated, onDocumentUpdated, onDocumentWritten} = require('firebase-functions/v2/firestore');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const {onRequest} = require('firebase-functions/v2/https');
const {setGlobalOptions, logger} = require('firebase-functions/v2');
const {defineSecret} = require('firebase-functions/params');
const functionsV1 = require('firebase-functions/v1'); // alleen voor de trigger bij een nieuw account (v173)
const admin = require('firebase-admin');
const webpush = require('web-push');
const crypto = require('crypto');

setGlobalOptions({region: 'europe-west1', maxInstances: 3});
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
const VAPID_PRIVATE_KEY = defineSecret('VAPID_PRIVATE_KEY');
const BREVO_API_KEY = defineSecret('BREVO_API_KEY');
const CONTACT = 'mailto:storingen@mit-installatietechniek.com';

const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
let ready = false;
function init() {
  if (ready) return;
  const priv = String(VAPID_PRIVATE_KEY.value() || '').trim();
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(priv.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  webpush.setVapidDetails(CONTACT, b64u(ecdh.getPublicKey()), priv);
  ready = true;
}

// stuur een melding naar alle aangemelde telefoons van een gebruiker; verlopen aanmeldingen opruimen
async function sendTo(uid, msg) {
  init();
  const subs = await db.collection('users').doc(uid).collection('push').get();
  let ok = 0;
  await Promise.all(subs.docs.map(async (d) => {
    const s = (d.data() || {}).sub;
    if (!s || !s.endpoint) return;
    try {
      await webpush.sendNotification(s, JSON.stringify(msg), {TTL: 6 * 3600, urgency: 'high'});
      ok++;
    } catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) await d.ref.delete().catch(() => {});
      else logger.warn('push mislukt', {uid, code: e && e.statusCode, msg: e && e.body});
    }
  }));
  return ok;
}

// planning (v170): dag en tijd als tekst, bijv. "di 24-11 10:30"
const DGN = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
const planTxt = (d) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d.pd || ''));
  if (!m) return '';
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return DGN[dt.getUTCDay()] + ' ' + (+m[3]) + '-' + (+m[2]) + (d.pt ? ' ' + d.pt : '');
};
const bonWie = (d) => {
  const g = d.g || {}, a = String(g.wadres || '').split('\n');
  return [(g.wb ? 'Werkbon ' + g.wb : ''), a[0], a[2]].filter(Boolean).join(' - ') || 'Een werkbon';
};

// staat de planning aan voor monteurs? (beheer.html > Instellingen > Planning)
async function planAan() {
  try { const s = await db.doc('instellingen/app').get(); return !!(s.exists && s.get('planAan')); } catch (e) { return false; }
}
// v215: planning-meldingen voor deze monteur? Planning aan, of hij is beheerder (die ziet de planning ook als hij nog uit staat, om te testen)
async function planVoor(uid) {
  if (await planAan()) return true;
  try { const m = await db.doc('monteurs/' + uid).get(); return BEHEERDERS.includes(String((m.exists && m.get('email')) || '').toLowerCase()); } catch (e) { return false; }
}
async function aantalTel(uid) {
  try { return (await db.collection('users').doc(uid).collection('push').get()).docs.filter((d) => ((d.data() || {}).sub || {}).endpoint).length; } catch (e) { return 0; }
}

exports.pushKlaar = onDocumentCreated({document: 'inbox/{id}', secrets: [VAPID_PRIVATE_KEY]}, async (ev) => {
  let d = (ev.data && ev.data.data()) || {};
  if (!d.voor || d.status !== 'klaar') return;
  if (d.pd && !(await planVoor(d.voor))) d = Object.assign({}, d, {pd: ''}); // planning nog uit: gewone melding
  const g = d.g || {};
  const wie = [g.naam || g.klant, [g.adres, g.plaats].filter(Boolean).join(', ')].filter(Boolean).join(' - ');
  await sendTo(d.voor, {
    title: 'Nieuwe werkbon klaargezet',
    body: (wie || 'Kantoor heeft een werkbon voor je klaargezet.') + (d.pd ? '\nGepland: ' + planTxt(d) : '') + (d.opm ? '\n' + String(d.opm).slice(0, 120) : ''),
    url: d.pd ? './?go=plan' : './?go=home', tag: 'klaar-' + ev.params.id, ok: true,
  });
});

// planning gewijzigd (andere monteur, dag of tijd): melding naar de monteur(s)
// agenda (v180): kantoor heeft een agenda-PDF ingelezen voor een monteur -> één melding per keer
exports.pushAgenda = onDocumentCreated({document: 'agendaimport/{id}', secrets: [VAPID_PRIVATE_KEY]}, async (ev) => {
  const d = (ev.data && ev.data.data()) || {};
  // v215: uitslag van de melding terugschrijven, zodat kantoor ziet of de telefoon hem kreeg (en zo niet: waarom)
  const uit = async (push, reden) => { try { await ev.data.ref.set({push, pushReden: reden, pushT: Date.now()}, {merge: true}); } catch (e) {} logger.info('pushAgenda', {voor: d.voor, push, reden}); };
  if (!d.voor) return;
  if (!(await planVoor(d.voor))) return uit(0, 'planning staat uit (beheer > Instellingen)');
  const dt = (iso) => { const p = String(iso || '').split('-'); if (p.length !== 3) return ''; const x = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); return DGN[x.getUTCDay()] + ' ' + (+p[2]) + '-' + (+p[1]); };
  const per = d.van ? ' (' + dt(d.van) + (d.tot && d.tot !== d.van ? ' t/m ' + dt(d.tot) : '') + ')' : '';
  const w = Array.isArray(d.wijz) ? d.wijz : [];
  if (d.eerste === false && !(d.bij || d.weg || d.gew)) return uit(0, 'niets gewijzigd'); // zelfde agenda opnieuw: geen melding
  const tel = await aantalTel(d.voor);
  if (!tel) return uit(0, 'meldingen staan niet aan op de telefoon');
  if (d.eerste === false) {
    const n = await sendTo(d.voor, {title: 'Planning gewijzigd' + per, body: w.slice(0, 3).join('\n') + (w.length > 3 ? '\n+ ' + (w.length - 3) + ' andere wijziging' + (w.length - 3 === 1 ? '' : 'en') : ''),
      url: './?go=plan', tag: 'agenda-' + (d.van || ev.params.id), ok: true});
    return uit(n, n ? 'verstuurd' : 'versturen mislukt');
  }
  const n = await sendTo(d.voor, {title: 'Nieuwe planning van kantoor',
    body: (d.n || 0) + ((d.n === 1) ? ' afspraak' : ' afspraken') + per + '. Tik om je planning te zien.',
    url: './?go=plan', tag: 'agenda-' + (d.van || ev.params.id), ok: true});
  return uit(n, n ? 'verstuurd' : 'versturen mislukt');
});

// v210: kantoor vraagt een correctie op een verstuurde werkbon -> melding (met OK) naar de monteur
exports.pushCorrectie = onDocumentCreated({document: 'correctie/{id}', secrets: [VAPID_PRIVATE_KEY]}, async (ev) => {
  const d = (ev.data && ev.data.data()) || {};
  if (!d.voor) return;
  const r = (Array.isArray(d.reden) ? d.reden : []).slice(0, 5).map((x) => '- ' + tekst(x, 60));
  await sendTo(d.voor, {title: 'Correctie gevraagd' + (d.wb ? ': werkbon ' + tekst(d.wb, 12) : ''),
    body: r.concat(d.opm ? [tekst(d.opm, 140)] : []).join('\n') || 'Kantoor vraagt je de werkbon aan te passen.',
    url: './?go=home', tag: 'corr-' + ev.params.id, ok: true});
});

// v203: nieuw storingsrooster -> melding (met OK) alleen naar monteurs bij wie hun eigen diensten (nog niet voorbij) zijn veranderd
exports.pushRooster = onDocumentWritten({document: 'rooster/{doc}', secrets: [VAPID_PRIVATE_KEY]}, async (ev) => {
  if (ev.params.doc !== 'actief') return;
  const voor = (ev.data && ev.data.before && ev.data.before.exists && ev.data.before.data()) || null;
  const na = (ev.data && ev.data.after && ev.data.after.exists && ev.data.after.data()) || null;
  if (!voor || !na) return; // eerste rooster of weggehaald: geen melding
  const R = require('./rooster.js');
  const vandaag = new Date().toISOString().slice(0, 10);
  const mijn = (x, n) => (x.weken || []).filter((w) => (w.wie || []).includes(n) && String(w.e || '') >= vandaag);
  const key = (w) => w.s + '|' + w.e + '|' + (w.b ? 1 : 0);
  const MD = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
  const dd = (iso) => { const p = String(iso || '').split('-'); if (p.length !== 3) return ''; const x = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); return DGN[x.getUTCDay()] + ' ' + (+p[2]) + ' ' + MD[+p[1] - 1]; };
  const txt = (w) => 'week ' + w.w + ': ' + dd(w.s) + ' t/m ' + dd(w.e) + (w.b ? ' (bouwvak)' : '');
  const namen = new Set();
  [voor, na].forEach((x) => (x.weken || []).forEach((w) => (w.wie || []).forEach((n) => namen.add(n))));
  const toonVan = (n) => { const m = (na.monteurs || []).concat(voor.monteurs || []).find((x) => x.naam === n); return (m && m.toon) || n; };
  const lijst = (await db.collection('monteurs').get()).docs.map((d) => Object.assign({uid: d.id}, d.data() || {}))
    .filter((m) => !['a.f.vanderhulst@gmail.com'].includes(String(m.email || '').toLowerCase()));
  const zoek = (n) => {
    const vast = lijst.filter((m) => m.rooster === n);
    if (vast.length) return vast;
    const t = toonVan(n), sc = lijst.filter((m) => m.naam && !m.rooster).map((m) => ({m, d: Math.min(R.dist(m.naam, n), R.dist(m.naam, t))})).sort((a, b) => a.d - b.d);
    return sc.length && sc[0].d <= 2 && (sc.length < 2 || sc[1].d > sc[0].d) ? [sc[0].m] : [];
  };
  let n = 0;
  for (const naam of namen) {
    const A = mijn(voor, naam), B = mijn(na, naam), ka = new Set(A.map(key)), kb = new Set(B.map(key));
    const bij = B.filter((w) => !ka.has(key(w))), weg = A.filter((w) => !kb.has(key(w)));
    if (!bij.length && !weg.length) continue;
    const regels = bij.map((w) => 'Nieuw: ' + txt(w)).concat(weg.map((w) => 'Vervallen: ' + txt(w)));
    for (const m of zoek(naam)) {
      await sendTo(m.uid, {title: 'Storingsrooster gewijzigd', body: regels.slice(0, 4).join('\n') + (regels.length > 4 ? '\n+ ' + (regels.length - 4) + ' andere' : ''),
        url: './?go=rooster', tag: 'rooster', ok: true});
      n++;
    }
  }
  logger.info('pushRooster', {meldingen: n});
});

exports.pushPlanning = onDocumentUpdated({document: 'inbox/{id}', secrets: [VAPID_PRIVATE_KEY]}, async (ev) => {
  const a = (ev.data && ev.data.before && ev.data.before.data()) || {}, b = (ev.data && ev.data.after && ev.data.after.data()) || {};
  if (b.verstuurd) return; // al afgerond
  const wie = bonWie(b), id = ev.params.id;
  const pa = await planVoor(b.voor || a.voor);
  if ((a.voor || '') === (b.voor || '') && !pa) return; // planning nog uit: geen meldingen over dag/tijd
  if (!pa) { b.pd = ''; a.pd = ''; }
  if ((a.voor || '') !== (b.voor || '')) {
    if (b.voor) {
      await sendTo(b.voor, {title: b.pd ? 'Werkbon voor je ingepland' : 'Nieuwe werkbon klaargezet',
        body: wie + (b.pd ? '\nGepland: ' + planTxt(b) : '') + (b.opm ? '\n' + String(b.opm).slice(0, 120) : ''),
        url: b.pd ? './?go=plan' : './?go=home', tag: 'klaar-' + id, ok: true});
    }
    if (a.voor && a.status !== 'opgehaald') {
      await sendTo(a.voor, {title: 'Werkbon verplaatst', body: wie + '\nKantoor heeft deze werkbon aan een collega gegeven.', url: './?go=plan', tag: 'weg-' + id, ok: true});
    }
    return;
  }
  if (b.voor && ((a.pd || '') !== (b.pd || '') || (a.pt || '') !== (b.pt || ''))) {
    await sendTo(b.voor, {title: 'Planning gewijzigd',
      body: wie + '\n' + (b.pd ? (a.pd ? 'Was ' + planTxt(a) + ', nu ' : 'Gepland: ') + planTxt(b) : 'Niet meer ingepland (kantoor plant hem opnieuw).'),
      url: './?go=plan', tag: 'klaar-' + id, ok: true});
  }
});

exports.pushTest = onDocumentCreated({document: 'users/{uid}/pushq/{id}', secrets: [VAPID_PRIVATE_KEY]}, async (ev) => {
  const n = await sendTo(ev.params.uid, {title: 'Testmelding MIT Werkbon', body: 'Meldingen werken op deze telefoon.', url: './?go=home', tag: 'test'});
  logger.info('testmelding', {uid: ev.params.uid, telefoons: n});
  await ev.data.ref.delete().catch(() => {});
});

// elke nacht oude werkbon-PDF's (bonpdf) opruimen: v206 na 7 jaar (wettelijke bewaartermijn; was 120 dagen)
exports.opruimen = onSchedule({schedule: 'every day 03:17', timeZone: 'Europe/Amsterdam'}, async () => {
  const grens = Date.now() - 7 * 366 * 864e5;
  const q = await db.collection('bonpdf').where('t', '<', grens).limit(300).get();
  for (const d of q.docs) {
    const n = d.get('parts') || 0;
    for (let i = 0; i < n; i++) await d.ref.collection('parts').doc(String(i)).delete().catch(() => {});
    await d.ref.delete().catch(() => {});
  }
  logger.info('opruimen bonpdf', {weg: q.size});
});

exports.pushPlan = onSchedule({schedule: 'every 15 minutes', timeZone: 'Europe/Amsterdam', secrets: [VAPID_PRIVATE_KEY]}, async () => {
  const now = Date.now(), D = 864e5;
  const plans = await db.collectionGroup('pushplan').get();
  for (const p of plans.docs) {
    if (p.id !== 'plan') continue;
    const uid = p.ref.parent.parent.id, d = p.data() || {}, sent = d.sent || {};
    const due = (d.items || []).filter((x) => x && x.id && x.at <= now && x.at > now - 12 * 3600e3 && !sent[x.id]);
    if (!due.length) continue;
    for (const x of due) {
      await sendTo(uid, {title: x.title, body: x.body, url: x.url || './', tag: x.id});
      sent[x.id] = now;
    }
    for (const k of Object.keys(sent)) if (now - sent[k] > 60 * D) delete sent[k];
    await p.ref.set({sent}, {merge: true});
  }
});

/* ===================== WERKBON DIRECT NAAR KANTOOR MAILEN (Brevo) =====================
   De app stuurt de PDF hierheen met het inlogbewijs van de monteur. Deze functie controleert alles
   en verstuurt de mail via de Brevo-API:
     afzender   MIT Werkbon <noreply@mit-werkbon.com>   (moet in Brevo bij Senders staan)
     aan        kantooradres; alleen adressen op de domeinen hieronder (tegen misbruik).
                Staat op beheer.html "Altijd naar vast adres" aan (instellingen/app: kantoorVast + kantoorAdres),
                dan gaat de mail ALTIJD naar dat adres, wat de app ook stuurt.
     CC         tot 3 extra adressen die de monteur invult (alleen als de beheerder CC toestaat); de monteur zelf niet meer (v231);
                "Beantwoorden" gaat naar de monteur
   BREVO_API_KEY is een API-sleutel van Brevo (Settings > SMTP & API > API Keys), GEEN SMTP-sleutel. */
const AFZENDER = {name: 'MIT Werkbon', email: 'noreply@mit-werkbon.com'};
const TOEGESTANE_DOMEINEN = ['mit-installatietechniek.com'];
const TOEGESTANE_ADRESSEN = ['a.f.vanderhulst@gmail.com']; // losse adressen (tijdelijk, om te testen); later weghalen
const MAX_PER_DAG = 60;            // mails per monteur per dag
const MAX_KLANT_PER_DAG = 30;      // v204: werkbonnen naar klanten per monteur per dag (elk adres; vaste tekst)
const MAX_CC = 3;                  // extra CC-adressen die de monteur mag invullen
const MAX_PDF = 10 * 1024 * 1024;  // 10 MB
const MAX_WL = 13 * 1024 * 1024;   // weeklijst: alle PDF's samen (Brevo: max. 20 MB per mail, na omzetting groter)
const MAX_WL_BIJL = 3;             // weeklijst: aantal PDF's (weeklijst + verzamel-PDF)

const MAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
const magNaar = (a) => MAIL_RE.test(a) && (TOEGESTANE_DOMEINEN.some((d) => a.toLowerCase().endsWith('@' + d))
  || TOEGESTANE_ADRESSEN.includes(a.toLowerCase()));
// eslint-disable-next-line no-control-regex
const tekst = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max);

exports.mailKantoor = onRequest({
  secrets: [BREVO_API_KEY], cors: true, invoker: 'public',
  memory: '1GiB', timeoutSeconds: 90,
}, async (req, res) => {
  const fout = (code, msg) => res.status(code).json({ok: false, fout: msg});
  if (req.method !== 'POST') return fout(405, 'Alleen POST.');

  // 1. wie is het?
  const m = /^Bearer (.+)$/.exec(req.get('Authorization') || '');
  if (!m) return fout(401, 'Niet ingelogd.');
  let tok;
  try { tok = await admin.auth().verifyIdToken(m[1]); } catch (e) { return fout(401, 'Inlog verlopen.'); }
  if (!tok.email || !tok.email_verified) return fout(403, 'Bevestig eerst je e-mailadres (tandwieltje > Account).');
  const em = tok.email;
  try {
    for (const k of new Set([em, em.toLowerCase()])) {
      const g = await db.doc('geblokkeerd/' + k).get();
      if (g.exists && g.get('volledig') === true) return fout(403, 'De toegang tot de app is ingetrokken.');
    }
  } catch (e) { logger.warn('blokkade-check', e); }

  // 2. wat moet er verstuurd worden?
  const b = req.body || {};
  const id = tekst(b.id, 80), naam = tekst(b.naam, 80).trim();
  const soort = b.soort === 'weeklijst' ? 'weeklijst' : b.soort === 'klant' ? 'klant' : 'werkbon';
  let aan = tekst(b.to, 200).trim();
  // vast kantooradres van de beheerder gaat altijd voor (alleen bij werkbonnen; de weeklijst gaat naar de leidinggevende)
  let vast = '', ccMag = true;
  if (soort === 'werkbon') try {
    const inst = await db.doc('instellingen/app').get();
    // v229: standaard ALTIJD naar het kantooradres; alleen als de beheerder het vrijgeeft (kantoorVrij) kiest de monteur zelf. CC alleen als ccAan.
    const io = inst.exists ? inst.data() : {};
    if (io.kantoorVrij !== true) vast = tekst(io.kantoorAdres || 'storingen@mit-installatietechniek.com', 200).trim();
    ccMag = io.ccAan === true;
  } catch (e) { logger.warn('instellingen lezen', e); vast = 'storingen@mit-installatietechniek.com'; }
  // v232: storingsdienstlijst gaat alleen naar het kantooradres (storingen@), zonder CC
  const sdLijst = soort === 'weeklijst' && (b.sd === true || /^storingsdienst\b/i.test(tekst(b.subject, 40).trim()));
  if (sdLijst) {
    vast = 'storingen@mit-installatietechniek.com'; ccMag = false;
    try { const inst = await db.doc('instellingen/app').get(), ka = inst.exists && tekst(inst.get('kantoorAdres') || '', 200).trim(); if (ka && MAIL_RE.test(ka)) vast = ka; } catch (e) { logger.warn('instellingen lezen', e); }
  }
  if (vast && !MAIL_RE.test(vast)) vast = '';
  if (vast) aan = vast;
  // v204: werkbon naar de KLANT: elk geldig adres, maar onderwerp en tekst maakt de server zelf (geen vrije tekst), antwoorden gaan naar kantoor
  let kantoorAdres = 'storingen@mit-installatietechniek.com';
  if (soort === 'klant') try {
    const inst = await db.doc('instellingen/app').get(), ka = inst.exists && tekst(inst.get('kantoorAdres') || '', 200).trim();
    if (ka && MAIL_RE.test(ka)) kantoorAdres = ka;
  } catch (e) { logger.warn('instellingen lezen', e); }
  const wbNr = tekst(b.wb, 12).replace(/[^0-9A-Za-z-]/g, '');
  const onderwerp = soort === 'klant' ? 'Werkbon ' + (wbNr ? wbNr + ' ' : '') + '- MIT Installatietechniek'
    : (tekst(b.subject, 200).trim() || (soort === 'weeklijst' ? 'Weeklijst' : 'Werkbon'));
  const bericht = soort === 'klant'
    ? 'Geachte heer/mevrouw,\n\n' +
      'In de bijlage vindt u de werkbon' + (wbNr ? ' ' + wbNr : '') + ' van de werkzaamheden die ' + (naam || 'onze monteur') + ' van MIT Installatietechniek bij u heeft uitgevoerd.\n\n' +
      'Heeft u vragen over deze werkbon? Beantwoord dan deze e-mail; uw antwoord komt bij ons kantoor terecht.\n\n' +
      'Met vriendelijke groet,\n\n' + (naam ? naam + '\n' : '') + 'MIT Installatietechniek\ninfo@mit-installatietechniek.com'
    : tekst(b.text, 5000);
  const naamPdf = (v, std) => { let x = tekst(v, 120).replace(/[\\/:*?"<>|]+/g, '-').trim() || std; if (!/\.pdf$/i.test(x)) x += '.pdf'; return x; };
  const isPdf = (x) => typeof x === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(x) && Buffer.from(x.slice(0, 8), 'base64').toString('latin1').slice(0, 4) === '%PDF';
  if (!/^[\w-]{6,80}$/.test(id)) return fout(400, 'Ongeldig verzoek.');
  // mislukte pogingen ook vastleggen in mailuit (beheer.html > Systeem > Verzonden mails); een verstuurde mail blijft 'ok'
  const uitRef = db.doc(`mailuit/${tok.uid}_${id}`); // buiten users/: de app zelf kan hier niet bij (Firestore-regels)
  const mislukt = async (code, msg) => {
    try {
      const o = await uitRef.get();
      if (!(o.exists && o.get('status') === 'ok')) {
        const nu = Date.now();
        await uitRef.set({t: nu, eerst: (o.exists && o.get('eerst')) || nu, uid: tok.uid, van: em, naam, aan, soort, onderwerp: tekst(b.subject, 200),
          status: 'fout', fout: tekst(msg, 300), code, pogingen: admin.firestore.FieldValue.increment(1)}, {merge: true});
      }
    } catch (e) { logger.warn('mailuit (fout) schrijven', e); }
    return fout(code, msg);
  };
  const ccIn = soort !== 'klant' && ccMag && Array.isArray(b.cc) ? b.cc : [];
  if (ccIn.length > MAX_CC) return mislukt(400, 'CC: maximaal ' + MAX_CC + ' adressen.');
  const cc = [], gezien = new Set([aan.toLowerCase(), em.toLowerCase()]);
  for (const x of ccIn) {
    const a = tekst(x, 200).trim();
    if (!magNaar(a)) return mislukt(400, 'CC: naar ' + a + ' kan de app niet mailen. Alleen adressen op @' + TOEGESTANE_DOMEINEN.join(' of @') + '.');
    if (!gezien.has(a.toLowerCase())) { gezien.add(a.toLowerCase()); cc.push({email: a}); }
  }
  if (soort === 'klant' && !MAIL_RE.test(aan)) return mislukt(400, 'Het e-mailadres van de klant klopt niet: ' + aan);
  if (soort !== 'klant' && !vast && !magNaar(aan)) return mislukt(400, 'Naar dit adres kan de app niet mailen. Alleen adressen op @' + TOEGESTANE_DOMEINEN.join(' of @') + '.');
  // de PDF('s): werkbon = 1 PDF (b.pdf), weeklijst = lijst b.bijlagen [{name, pdf}]
  const bijlagen = [];
  if (soort === 'weeklijst') {
    const l = Array.isArray(b.bijlagen) ? b.bijlagen : [];
    if (!l.length) return mislukt(400, 'De PDF ontbreekt.');
    if (l.length > MAX_WL_BIJL) return mislukt(400, 'Te veel bijlagen.');
    for (const x of l) {
      const c = x && typeof x.pdf === 'string' ? x.pdf : '';
      if (!c) return mislukt(400, 'De PDF ontbreekt.');
      if (!isPdf(c)) return mislukt(400, 'Dit is geen PDF.');
      bijlagen.push({name: naamPdf(x.name, 'weeklijst.pdf'), content: c});
    }
  } else {
    const pdf = typeof b.pdf === 'string' ? b.pdf : '';
    if (!pdf || !/^[A-Za-z0-9+/]+={0,2}$/.test(pdf)) return mislukt(400, 'De PDF ontbreekt.');
    if (!isPdf(pdf)) return mislukt(400, 'Dit is geen PDF.');
    bijlagen.push({name: naamPdf(b.name, 'werkbon.pdf'), content: pdf});
  }
  const grootte = bijlagen.reduce((s, x) => s + Math.floor(x.content.length * 3 / 4), 0);
  const maxB = soort === 'weeklijst' ? MAX_WL : MAX_PDF;
  if (grootte > maxB) return mislukt(413, (soort === 'weeklijst' ? "De PDF's zijn" : 'De PDF is') + ' te groot (' + (grootte / 1048576).toFixed(1).replace('.', ',') + ' MB, maximaal ' + Math.round(maxB / 1048576) + ' MB).');
  const bestand = bijlagen.map((x) => x.name).join(', ');
  // status van de werkbon (Werk gereed / Reparatiemelding): bovenaan de mail, in kleur
  const STATUS = {gereed: ['GEREED !', '#1e7d34', '#e3f5e8'], niet: ['NIET GEREED !', '#c62828', '#fdeaea'], repm: ['REPARATIE MELDING !', '#c25e00', '#fff1e0']};
  const status = soort === 'werkbon' && Array.isArray(b.status) ? [...new Set(b.status.filter((x) => STATUS[x]))] : [];

  // 3. al eerder verstuurd (de app probeert opnieuw na een storing)? dan niet nog een keer
  const uit = uitRef;
  const al = await uit.get();
  if (al.exists && al.get('status') === 'ok') return res.json({ok: true, dubbel: true});

  // 4. niet te veel per dag
  const dag = new Date().toISOString().slice(0, 10);
  const teller = db.doc(`mailteller/${tok.uid}_${dag}` + (soort === 'klant' ? '_klant' : ''));
  const maxDag = soort === 'klant' ? MAX_KLANT_PER_DAG : MAX_PER_DAG;
  try {
    const n = await db.runTransaction(async (t) => {
      const s = await t.get(teller), v = ((s.exists && s.get('n')) || 0) + 1;
      if (v <= maxDag) t.set(teller, {n: v, t: Date.now()});
      return v;
    });
    if (n > maxDag) return mislukt(429, 'Je hebt vandaag al ' + maxDag + ' mails verstuurd. Verstuur deze via je mail-app.');
  } catch (e) { logger.warn('teller', e); }

  // 5. versturen via Brevo
  const mail = {
    sender: soort === 'klant' ? {name: 'MIT Installatietechniek', email: AFZENDER.email} : AFZENDER,
    to: [{email: aan}],
    replyTo: soort === 'klant' ? {email: kantoorAdres, name: 'MIT Installatietechniek'} : {email: em, name: naam || em},
    subject: onderwerp,
    textContent: bericht || onderwerp, // de status staat al in de tekst (tussen de tekst en de groet)
    attachment: bijlagen,
    tags: [soort],
  };
  if (status.length) {
    const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);
    // de statusregel in de tekst wordt in de HTML-mail een gekleurd blok (met ruimte erboven en eronder)
    const regel = status.map((x) => STATUS[x][0]).join('  /  ');
    const blok = '</div><div style="margin:18px 0">' + status.map((x) => '<span style="display:inline-block;margin:0 8px 6px 0;padding:8px 16px;border-radius:6px;font-size:18px;font-weight:bold;color:#fff;background:' + STATUS[x][1] + '">' + STATUS[x][0] + '</span>').join('') + '</div><div style="white-space:pre-wrap">';
    let t = esc(bericht || onderwerp).replace(/\r?\n/g, '\n');
    const er = esc(regel), i = t.indexOf('\n' + er + '\n');
    if (i >= 0) t = t.slice(0, i).replace(/\n+$/, '') + blok + t.slice(i + er.length + 2).replace(/^\n+/, '');
    else t = blok + t; // oude app-versie (status niet in de tekst): bovenaan
    mail.htmlContent = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222"><div style="white-space:pre-wrap">' + t + '</div></div>';
  }
  // v232: ook bij een werkbon naar de klant geen kopie meer naar de monteur
  // v231: werkbon naar kantoor en weeklijst: de monteur krijgt geen kopie meer (klant: stille kopie blijft)
  if (cc.length) mail.cc = cc;
  let r, j = {};
  try {
    r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {'api-key': String(BREVO_API_KEY.value() || '').trim(), 'content-type': 'application/json', 'accept': 'application/json'},
      body: JSON.stringify(mail),
    });
    j = await r.json().catch(() => ({}));
  } catch (e) {
    logger.error('brevo onbereikbaar', e);
    return mislukt(502, 'De mailserver is nu niet bereikbaar. De app probeert het later opnieuw.');
  }
  if (!r.ok) {
    logger.error('brevo weigert', {status: r.status, antwoord: j, uid: tok.uid});
    // 5xx/429 = tijdelijk (de app probeert later opnieuw); anders blijvend (de app meldt het de monteur)
    const tijdelijk = r.status >= 500 || r.status === 429;
    return mislukt(tijdelijk ? 503 : 422, 'De mailserver weigerde de mail (' + r.status + (j && j.message ? ': ' + tekst(j.message, 150) : '') + ').');
  }
  // v197: de verstuurde werkbon-PDF bewaren, zodat kantoor hem in de planning kan openen (7 jaar; zie opruimen)
  if (soort === 'werkbon' && bijlagen[0] && grootte <= 8 * 1048576) {
    try {
      const bonId = tekst(b.bon, 80).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60) || id;
      const ref = db.doc('bonpdf/' + tok.uid + '_' + bonId), c = bijlagen[0].content, n = Math.ceil(c.length / 300000);
      const oud = await ref.get(), oudN = (oud.exists && oud.get('parts')) || 0;
      for (let i = 0; i < n; i++) await ref.collection('parts').doc(String(i)).set({d: c.slice(i * 300000, (i + 1) * 300000)});
      for (let i = n; i < oudN; i++) await ref.collection('parts').doc(String(i)).delete().catch(() => {});
      await ref.set({uid: tok.uid, bon: bonId, wb: tekst(b.wb, 12).trim(), naam, bestand: bijlagen[0].name, t: Date.now(), st: status, parts: n, kb: Math.round(c.length * 3 / 4 / 1024)});
    } catch (e) { logger.warn('bonpdf bewaren mislukt', e && e.message); }
  }
  await uit.set({t: Date.now(), eerst: (al.exists && al.get('eerst')) || Date.now(), uid: tok.uid, van: em, naam, aan, cc: cc.map((c) => c.email), onderwerp, bestand, kb: Math.round(grootte / 1024), status: 'ok', soort, st: status, brevo: tekst(j.messageId, 200),
    fout: admin.firestore.FieldValue.delete(), code: admin.firestore.FieldValue.delete(), pogingen: admin.firestore.FieldValue.increment(1)}, {merge: true}).catch(() => {});
  logger.info(soort + ' gemaild', {uid: tok.uid, aan, bestand, kb: Math.round(grootte / 1024)});
  return res.json({ok: true});
});

/* ===================== WERKBON KLAARZETTEN PER MAIL =====================
   Kantoor mailt een werkbon-PDF naar  <monteur>@mit-werkbon.com  (bijv. jan.jansen@mit-werkbon.com).
   Cloudflare Email Routing (catch-all -> Worker) stuurt de hele mail naar mailInbox. Het Worker-script
   maak je met de knop op beheer.html (inboxSetup); daar staat de geheime sleutel al in.
   mailInbox controleert de afzender (kantoor-collega of beheerder), leest de PDF uit en zet de bon klaar
   in inbox/ (net als beheer.html > Bonnen klaarzetten). pushKlaar stuurt dan de melding naar de monteur.
   Het deel voor de @ = het deel voor de @ van het e-mailadres van de monteur, of zijn naam met punten
   (Jan Jansen -> jan.jansen). De afzender krijgt een mail terug of het gelukt is.
   (De oude route via Brevo inbound, bon.mit-werkbon.com, wordt ook nog aangenomen.) */
const INBOUND_DOMEINEN = ['mit-werkbon.com'];  // domein waarop bonnen binnenkomen (Cloudflare Email Routing)
const BEHEERDERS = ['a.f.vanderhulst@gmail.com', 'arjan@mit-installatietechniek.com']; // zelfde als in firestore-regels.txt
const MAX_PDF_IN = 15 * 1024 * 1024;   // per bijlage
const MAX_BIJLAGEN = 5;                // PDF's per mail
const CH = 300000;                     // zelfde stukgrootte als beheer.html
const BEVESTIG = true;                 // afzender krijgt een mail terug (telt mee voor de 300 per dag van Brevo)
const MAX_EXTRA = 10;                  // overige bijlagen (foto's, tekeningen, Word...) per bon
const MAX_EXTRA_BESTAND = 10 * 1024 * 1024, MAX_EXTRA_TOTAAL = 20 * 1024 * 1024;

const slug = (v) => String(v || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '');
const lokaal = (a) => String(a || '').toLowerCase().split('@')[0];
const projectId = () => {
  let fc = {}; try { fc = JSON.parse(process.env.FIREBASE_CONFIG || '{}'); } catch (e) { /* leeg */ }
  let ap = ''; try { ap = admin.app().options.projectId || ''; } catch (e) { /* leeg */ }
  return process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || fc.projectId || ap || 'backup-loonlijst-werkbon-mit';
};
const inboxUrl = () => `https://europe-west1-${projectId()}.cloudfunctions.net/mailInbox`;

// ---- PDF uitlezen: zelfde herkenning als beheer.html en de app ----
function lineText(a) {
  const ys = [];
  a.slice().sort((p, q) => p.y - q.y || p.x - q.x).forEach((i) => { const l = ys[ys.length - 1]; if (l && Math.abs(l.y - i.y) < 4) l.a.push(i); else ys.push({y: i.y, a: [i]}); });
  return ys.map((l) => { l.a.sort((p, q) => p.x - q.x); return l.a.map((i) => i.s).join(' ').replace(/\s+/g, ' ').trim(); }).filter(Boolean);
}
function parseSR(it) {
  const NLc = '\n', g = {}, all = lineText(it).join(' ');
  let m = all.match(/Werkbonnr\.?\s*:?\s*(\d+)/); if (m) g.wb = m[1];
  const col = (x0, x1) => lineText(it.filter((i) => i.x >= x0 && i.x < x1 && i.y > 292 && i.y < 392));
  const a = col(0, 318), b = col(318, 622), c = col(622, 2000);
  if (a.length) g.wadres = a.join(NLc); if (b.length) g.opdr = b.join(NLc); if (c.length) g.inst = c.join(NLc);
  const mid = lineText(it.filter((i) => i.y > 394 && i.y < 418)).join(' ');
  m = mid.match(/Datum melding\s*:?\s*([0-9-]+)/); if (m) g.dm = m[1];
  m = mid.match(/Datum afspraak\s*:?\s*([0-9-]+)/); if (m) g.da = m[1];
  m = mid.match(/Tijd\s*:?\s*([0-9]{1,2}:[0-9]{2})/); if (m) g.tijd = m[1];
  const s = lineText(it.filter((i) => i.y > 420 && i.y < 590)).filter((l) => !/^STORING\s*\/\s*SERVICE/i.test(l));
  if (s.length) g.storing = s.join(NLc);
  return g;
}
// ---- agenda-PDF (v180): tekst met posities -> regels (zelfde lezer als kantoor.html: agenda-parse.js) ----
async function pdfWoorden(buf) {
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const doc = await pdfjs.getDocument({data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0}).promise;
  const P = [];
  for (let p = 1; p <= Math.min(doc.numPages, 20); p++) {
    const pg = await doc.getPage(p), vp = pg.getViewport({scale: 1}), tc = await pg.getTextContent();
    P.push({w: vp.width, h: vp.height, items: tc.items.filter((i) => i.str && i.str.trim()).map((i) => { const q = vp.convertToViewportPoint(i.transform[4], i.transform[5]); return {s: i.str, x: q[0], y: q[1], w: i.width}; })});
  }
  await doc.destroy();
  return P;
}
// agenda-regels opslaan voor één monteur (v181): vergelijken met wat er al stond in dezelfde periode (van..tot van de hele PDF),
// alleen echt gewijzigde afspraken aanpassen, vervallen afspraken weghalen; de wijzigingen gaan mee voor de pushmelding
async function zetAgenda(mt, regels, door, bestand, via, van, tot) {
  const A = require('./agenda-parse.js');
  van = van || regels.reduce((a, r) => (!a || r.pd < a ? r.pd : a), ''); tot = tot || regels.reduce((a, r) => (r.pd > a ? r.pd : a), '');
  const oudQ = await db.collection('agenda').where('voor', '==', mt.uid).get();
  const oud = oudQ.docs.filter((d) => { const pd = d.get('pd') || ''; return pd >= van && pd <= tot; });
  const vg = A.vergelijk(oud.map((d) => d.data() || {}), regels), ids = A.docIds(mt.uid, regels), houd = new Set(ids);
  const imp = db.collection('agendaimport').doc(), t = Date.now();
  let b = db.batch(), n = 0;
  const tel = async () => { if (++n % 400 === 0) { await b.commit(); b = db.batch(); } };
  for (const d of oud) if (!houd.has(d.id)) { b.delete(d.ref); await tel(); }
  for (let i = 0; i < regels.length; i++) {
    const r = regels[i];
    b.set(db.collection('agenda').doc(ids[i]), {voor: mt.uid, voorMail: String(mt.email || '').toLowerCase(), voorNaam: mt.naam || '', pd: r.pd, pt: r.pt || '', duur: r.duur || '', min: r.min || 0,
      wb: tekst(r.wb, 12), inst: tekst(r.inst, 40), klant: tekst(r.klant, 120), adres: tekst(r.adres, 160), plaats: tekst(r.plaats, 80), tel: tekst(r.tel, 40), oms: tekst(r.oms, 800),
      imp: imp.id, t, door, bestand: tekst(bestand, 120)}, {merge: true}); // merge: status van de monteur (bezig/verstuurd/gereed) blijft staan
    await tel();
  }
  await b.commit();
  await imp.set({voor: mt.uid, voorNaam: mt.naam || '', voorMail: String(mt.email || '').toLowerCase(), door, t, n: regels.length, van, tot,
    bij: vg.bij, weg: vg.weg, gew: vg.gew, eerste: vg.eerste, wijz: vg.regels.slice(0, 20).map((x) => tekst(x, 160)), bestand: tekst(bestand, 120), via});
  return {van, tot, vg};
}
// ---- storingsrooster per mail (v202): rooster@mit-werkbon.com -> direct gepubliceerd voor alle collega's ----
// Zelfde lezer als kantoor.html (rooster.js; dezelfde kopie staat in functions/). De vorige versie blijft bewaard in rooster/vorige,
// zodat kantoor hem in de kantoor-app > Rooster kan terugzetten.
async function verwerkRoosterMail(m, van, logRef) {
  const R = require('./rooster.js');
  const pdfs = (m.bijlagen || []).filter((b) => /pdf/i.test(b.type || '') || /\.pdf$/i.test(b.naam || '')).slice(0, 5);
  const fouten = [];
  let r = null, bestand = '';
  if (!pdfs.length) fouten.push('Er zat geen PDF bij de mail.');
  for (const b of pdfs) {
    const naam = tekst(b.naam, 120) || 'rooster.pdf';
    let buf; try { buf = await b.buf(); } catch (e) { fouten.push(naam + ' kon niet worden opgehaald.'); continue; }
    if (buf.length > MAX_PDF_IN || buf.slice(0, 4).toString('latin1') !== '%PDF') { fouten.push(naam + ' is geen PDF of is te groot.'); continue; }
    try {
      const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
      const doc = await pdfjs.getDocument({data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0}).promise;
      const pg = await doc.getPage(1), vp = pg.getViewport({scale: 1}), tc = await pg.getTextContent();
      await doc.destroy();
      if (tc.items.filter((i) => i.str && i.str.trim()).length < 20) { fouten.push(naam + ': hierin staat geen tekst (een foto of scan). Stuur de PDF zoals hij uit het programma komt, of lees hem in via de kantoor-app > Rooster.'); continue; }
      const x = R.parse(tc.items, vp.height);
      if (!x.weken || !x.weken.length || !x.weken.some((w) => w.wie && w.wie.length)) { fouten.push(naam + ': geen storingsrooster gevonden' + (x.fouten && x.fouten.length ? ' (' + x.fouten.join(' ') + ')' : '') + '.'); continue; }
      r = x; bestand = naam; break;
    } catch (e) { fouten.push(naam + ' kon niet worden gelezen.'); }
  }
  if (!r) {
    await logRef.set({status: 'rooster mislukt', fouten}, {merge: true});
    await brevoMail(van, 'Rooster niet gepubliceerd: ' + tekst(m.onderwerp || 'rooster', 150),
      'Het storingsrooster is NIET gepubliceerd; collega\'s houden het rooster dat er al stond.\n\n- ' + fouten.join('\n- ') +
      '\n\nLukt het niet per mail? Kantoor-app > Rooster > PDF kiezen.\n\nMIT Werkbon\n(Verstuurd met de MIT Werkbon-app. Dit mailadres wordt niet beantwoord.)');
    return 'rooster mislukt';
  }
  const mon = r.monteurs.filter((x) => x.n > 0);
  const D = {titel: tekst(r.titel, 120), bestand: tekst(bestand, 120), t: Date.now(), door: van, via: 'mail',
    weken: r.weken.map((w) => ({w: w.w, s: w.s, e: w.e, b: !!w.bouwvak, wie: w.wie})),
    monteurs: mon.map((x) => ({naam: x.naam, toon: x.telNaam || x.naam, tel: tekst(x.tel || '', 40)})),
    calamiteiten: (r.calamiteiten || []).filter((c) => c.naam && c.tel).map((c) => ({naam: tekst(c.naam, 80), tel: tekst(c.tel, 40)}))};
  const oud = await db.doc('rooster/actief').get();
  if (oud.exists) await db.doc('rooster/vorige').set(Object.assign({}, oud.data(), {bewaard: Date.now()}));
  await db.doc('rooster/actief').set(D);
  await db.collection('inboxlog').doc(Date.now() + '_' + crypto.randomBytes(2).toString('hex')).set({t: Date.now(), door: van, actie: 'rooster gepubliceerd (per mail)', wb: tekst(bestand, 120), klant: '', voor: '', naar: ''});
  const ing = D.weken.filter((w) => w.wie.length), bv = D.weken.filter((w) => w.b).map((w) => w.w);
  const zonderTel = D.monteurs.filter((x) => !x.tel).map((x) => x.toon);
  const fd = (iso) => { const p = String(iso || '').split('-'); return p.length === 3 ? (+p[2]) + '-' + (+p[1]) + '-' + p[0] : ''; };
  await logRef.set({status: 'rooster gepubliceerd', aantal: ing.length, fouten: fouten.concat(r.fouten || [])}, {merge: true});
  logger.info('rooster per mail', {van, weken: ing.length});
  await brevoMail(van, 'Rooster gepubliceerd: ' + tekst(D.titel, 150),
    'Het storingsrooster is gepubliceerd voor alle collega\'s. Ze krijgen het bij het openen van de app.\n\n' +
    D.titel + ' (' + D.bestand + ')\n' +
    '- ' + ing.length + ' van de ' + D.weken.length + ' weken ingedeeld (' + fd(ing[0].s) + ' t/m ' + fd(ing[ing.length - 1].e) + ')\n' +
    '- bouwvak (overgang 17:00): ' + (bv.length ? 'week ' + bv.join(', ') : 'geen') + '\n' +
    '- monteurs: ' + D.monteurs.map((x) => x.toon + (x.tel ? '' : ' (GEEN telefoonnummer)')).join(', ') + '\n' +
    '- bij calamiteiten: ' + (D.calamiteiten.map((c) => c.naam).join(', ') || 'geen') + '\n' +
    (zonderTel.length ? '\nLet op: zonder telefoonnummer: ' + zonderTel.join(', ') + '. Vul het aan in de kantoor-app > Rooster.\n' : '') +
    ((r.fouten || []).concat(fouten).length ? '\nLet op:\n- ' + (r.fouten || []).concat(fouten).join('\n- ') + '\n' : '') +
    '\nKlopt er iets niet? Kantoor-app > Rooster: daar kun je de PDF opnieuw inlezen en aanpassen.\n\nMIT Werkbon\n(Verstuurd met de MIT Werkbon-app. Dit mailadres wordt niet beantwoord.)');
  return 'rooster';
}

async function verwerkAgendaMail(m, van, logRef, cache) {
  const A = require('./agenda-parse.js');
  // v188: test/beheer-accounts (zelfde lijst als PLAN_NIET in beheer.html) niet in de agenda
  const lijst = (await db.collection('monteurs').get()).docs.map((d) => Object.assign({uid: d.id}, d.data() || {})).filter((m) => !['a.f.vanderhulst@gmail.com'].includes(String(m.email || '').toLowerCase()));
  const pdfs = (m.bijlagen || []).filter((b) => /pdf/i.test(b.type || '') || /\.pdf$/i.test(b.naam || '')).slice(0, 10);
  const goed = [], fouten = [];
  if (!pdfs.length) fouten.push('Er zat geen PDF bij de mail.');
  for (const b of pdfs) {
    let buf; try { buf = await b.buf(); } catch (e) { fouten.push((b.naam || 'bijlage') + ' kon niet worden opgehaald.'); continue; }
    if (buf.length > MAX_PDF_IN || buf.slice(0, 4).toString('latin1') !== '%PDF') { fouten.push((b.naam || 'bijlage') + ' is geen PDF of is te groot.'); continue; }
    let P; try { P = await pdfWoorden(buf); } catch (e) { fouten.push((b.naam || 'bijlage') + ' kon niet worden gelezen.'); continue; }
    if (!P.some((p) => p.items.length > 20)) { fouten.push((b.naam || 'bijlage') + ': hierin staat geen tekst (een foto of scan zonder tekstherkenning). Sleep deze PDF in kantoor.html > Planning > Agenda inlezen: daar wordt de tekst herkend.'); continue; }
    const r = A.leesAgenda(P);
    r.fouten.forEach((f) => fouten.push((b.naam || 'agenda') + ': ' + f));
    if (!r.regels.length) { fouten.push((b.naam || 'agenda') + ': geen afspraken gevonden. Is dit de "Agenda servicemonteurs"?' + (P.some((p) => p.items.some((i) => /Rooster storingsdienst/i.test(i.s))) ? ' Dit lijkt het storingsrooster: stuur dat naar rooster@mit-werkbon.com.' : '')); continue; }
    const V = A.verdeel(r.regels, lijst);
    const pvan = r.regels.reduce((a, x) => (!a || x.pd < a ? x.pd : a), ''), ptot = r.regels.reduce((a, x) => (x.pd > a ? x.pd : a), '');
    V.los.forEach((x) => fouten.push('Monteur "' + (x.monteur || '?') + '" (' + x.pd + ' ' + x.pt + ') niet gevonden in de app; die regel is overgeslagen.'));
    for (const g of V.groepen) {
      const z = await zetAgenda(g.mt, g.regels, van, b.naam || 'agenda.pdf', 'mail', pvan, ptot), v = z.vg;
      goed.push('- ' + (g.mt.naam || g.mt.email) + ': ' + g.regels.length + (g.regels.length === 1 ? ' afspraak' : ' afspraken') +
        (v.eerste ? ' (nieuw)' : (v.bij + v.weg + v.gew ? ' (' + [v.gew ? v.gew + ' gewijzigd' : '', v.bij ? v.bij + ' nieuw' : '', v.weg ? v.weg + ' vervallen' : ''].filter(Boolean).join(', ') + ')' : ' (ongewijzigd, geen melding)')) +
        (!v.eerste && v.regels.length ? '\n    ' + v.regels.slice(0, 8).join('\n    ') : ''));
    }
  }
  const aan = await planAan();
  await logRef.set({status: goed.length ? 'agenda ingelezen' : 'agenda mislukt', aantal: goed.length, fouten}, {merge: true});
  logger.info('agenda per mail', {van, goed: goed.length, fouten});
  await brevoMail(van, (goed.length ? 'Agenda ingelezen' : 'Agenda niet ingelezen') + ': ' + tekst(m.onderwerp || 'agenda', 150),
    (goed.length ? 'Deze planning staat nu in de app:\n' + goed.join('\n') + '\n' : 'Er is niets in de planning gezet.\n') +
    (fouten.length ? '\nLet op:\n- ' + fouten.join('\n- ') + '\n' : '') +
    (goed.length && !aan ? '\nDe planning staat nog uit (beheer.html > Instellingen): alleen de beheerder ziet hem nu.\n' : '') +
    '\nControleren of aanpassen: kantoor.html > Planning.\n\nMIT Werkbon\n(Verstuurd met de MIT Werkbon-app. Dit mailadres wordt niet beantwoord.)');
  return goed.length ? 'agenda' : 'agenda mislukt';
}

async function leesBon(buf) {
  try {
    const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
    const doc = await pdfjs.getDocument({data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0}).promise;
    const pg = await doc.getPage(1), vp = pg.getViewport({scale: 1}), tc = await pg.getTextContent();
    const it = tc.items.filter((i) => i.str && i.str.trim()).map((i) => { const p = vp.convertToViewportPoint(i.transform[4], i.transform[5]); return {s: i.str, x: p[0] * 924 / vp.width, y: p[1] * 1307 / vp.height}; });
    await doc.destroy();
    return it.length ? parseSR(it) : {};
  } catch (e) { logger.warn('PDF uitlezen mislukt', e && e.message); return {}; }
}

// ---- mail sturen via Brevo (bevestiging / foutmelding naar kantoor) ----
async function brevoMail(aan, onderwerp, inhoud, bijlagen) {
  const stuur = async (b, extra) => fetch('https://api.brevo.com/v3/smtp/email', {method: 'POST',
    headers: {'api-key': String(BREVO_API_KEY.value() || '').trim(), 'content-type': 'application/json', 'accept': 'application/json'},
    body: JSON.stringify(Object.assign({sender: AFZENDER, to: [{email: aan}], subject: onderwerp, textContent: inhoud + (extra || ''), tags: ['klaarzetten']},
      b && b.length ? {attachment: b.map((x) => ({name: x.naam, content: x.buf.toString('base64')}))} : {}))});
  try {
    let r = await stuur(bijlagen);
    if (!r.ok && bijlagen && bijlagen.length) {
      const j = await r.json().catch(() => ({}));
      logger.warn('bevestiging met bijlagen geweigerd, opnieuw zonder', {status: r.status, msg: j && j.message});
      r = await stuur(null, '\n\n(De bijlagen konden niet worden meegestuurd: ' + tekst(j && j.message, 150) + '. Ze staan in de oorspronkelijke mail in je Verzonden items.)');
    }
    if (!r.ok) logger.warn('bevestiging niet verstuurd', {status: r.status});
  } catch (e) { logger.warn('bevestiging niet verstuurd', e && e.message); }
}

// v212: is een bijlage wat hij zegt te zijn? Gevaarlijke soorten weigeren en de inhoud (eerste bytes) controleren.
const GEVAARLIJK = ['exe', 'bat', 'cmd', 'com', 'scr', 'pif', 'js', 'jse', 'vbs', 'vbe', 'wsf', 'ps1', 'msi', 'msp', 'jar', 'lnk', 'hta', 'htm', 'html', 'svg', 'iso', 'img', 'dll', 'reg', 'cpl', 'apk', 'sh', 'app', 'dmg'];
const MAGIC = {pdf: ['25504446'], jpg: ['ffd8ff'], jpeg: ['ffd8ff'], png: ['89504e47'], gif: ['47494638'], bmp: ['424d'], tif: ['49492a00', '4d4d002a'], tiff: ['49492a00', '4d4d002a'],
  docx: ['504b0304'], xlsx: ['504b0304'], pptx: ['504b0304'], docm: ['504b0304'], ods: ['504b0304'], zip: ['504b0304'],
  doc: ['d0cf11e0'], xls: ['d0cf11e0'], ppt: ['d0cf11e0'], msg: ['d0cf11e0'], rtf: ['7b5c727466'], heic: [], webp: ['52494646']};
function bijlageOk(naam, buf) {
  const ext = ((String(naam || '').toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1]) || '';
  const hex = buf.slice(0, 8).toString('hex');
  if (GEVAARLIJK.includes(ext)) return 'dit soort bestand (.' + ext + ') wordt niet aangenomen';
  if (hex.startsWith('4d5a') || hex.startsWith('7f454c46')) return 'dit is een programma';
  if (MAGIC[ext] && MAGIC[ext].length && !MAGIC[ext].some((m) => hex.startsWith(m))) return 'de inhoud past niet bij .' + ext;
  if (ext === 'heic' && buf.slice(4, 8).toString('latin1') !== 'ftyp') return 'de inhoud past niet bij .heic';
  if (!MAGIC[ext] && buf.slice(0, 1024).includes(0)) return 'onbekend soort bestand';
  return '';
}

// welke bijlagen mogen terug naar kantoor (Brevo accepteert alleen bekende extensies, max. 20 MB per mail)
const TERUG_EXT = ['pdf', 'jpg', 'jpeg', 'png', 'gif', 'tif', 'tiff', 'bmp', 'doc', 'docx', 'docm', 'xls', 'xlsx', 'ods', 'csv', 'txt', 'rtf',
  'ppt', 'pptx', 'zip', 'xml', 'msg', 'ics', 'htm', 'html', 'eps'];
const TERUG_MAX = 13 * 1024 * 1024; // samen, voor base64 (+33%) en tekst onder de 20 MB
async function terugBijlagen(lijst) {
  const mee = [], niet = [];
  let totaal = 0;
  // werkbon-PDF's eerst, daarna de rest
  const volgorde = lijst.slice().sort((a, b) => (/\.pdf$/i.test(b.naam || '') ? 1 : 0) - (/\.pdf$/i.test(a.naam || '') ? 1 : 0));
  for (const b of volgorde) {
    const naam = tekst(b.naam, 120).replace(/[\\/:*?"<>|]+/g, '-').trim() || 'bijlage';
    const ext = (naam.match(/\.([a-z0-9]+)$/i) || [])[1];
    if (!ext || !TERUG_EXT.includes(ext.toLowerCase())) { niet.push(naam + ' (soort bestand kan niet mee)'); continue; }
    let buf;
    try { buf = await b.buf(); } catch (e) { niet.push(naam + ' (kon niet worden opgehaald)'); continue; }
    if (totaal + buf.length > TERUG_MAX) { niet.push(naam + ' (te groot om mee te sturen)'); continue; }
    totaal += buf.length;
    mee.push({naam, buf});
  }
  return {mee, niet};
}

// mag deze afzender bonnen klaarzetten?
async function magKlaarzetten(van) {
  const em = String(van || '').toLowerCase();
  if (!em) return false;
  const g = await db.doc('geblokkeerd/' + em).get();
  if (g.exists && g.get('volledig') === true) return false;
  if (BEHEERDERS.includes(em)) return true;
  return (await db.doc('kantoor/' + em).get()).exists;
}
// v173: is de mail aantoonbaar echt van de afzender? Controle op de ruwe mail met mailauth:
// DMARC pass, of een geldige ARC-keten (Cloudflare) waarin DMARC pass staat, of een geldige DKIM-handtekening van het
// domein van de afzender. Strenge stand (standaard): anders geweigerd. Uit (beheer > Instellingen): alleen weigeren
// als de controle aantoonbaar mislukt (zoals vroeger).
async function afzenderControle(raw, van, envFrom) {
  let streng = true;
  try { const s = await db.doc('instellingen/app').get(); if (s.exists && s.get('afzenderStreng') === false) streng = false; } catch (e) { /* standaard streng */ }
  const dom = String(van || '').toLowerCase().split('@')[1] || '';
  if (!raw || !raw.length || !dom) return {ok: !streng, waarom: 'geen mail om te controleren'};
  let r;
  try {
    const {authenticate} = require('mailauth');
    r = await authenticate(raw, Object.assign({trustReceived: true, mta: 'mit-werkbon', disableBimi: true}, envFrom ? {sender: String(envFrom)} : {}));
  } catch (e) {
    logger.warn('afzendercontrole mislukt', e && e.message);
    return {ok: !streng, waarom: 'controle mislukt (' + tekst(e && e.message, 80) + ')'};
  }
  const dm = (r.dmarc && r.dmarc.status && r.dmarc.status.result) || 'none';
  if (dm === 'pass') return {ok: true, waarom: 'dmarc=pass'};
  const arcR = (r.arc && r.arc.status) || {}, ac = String(arcR.comment || '').toLowerCase();
  if (arcR.result === 'pass' && /dmarc=pass/.test(ac) && ac.includes('fromdomain=' + dom)) return {ok: true, waarom: 'arc dmarc=pass'};
  const dk = ((r.dkim && r.dkim.results) || []).find((x) => x && x.status && x.status.result === 'pass' &&
    (String(x.signingDomain || '').toLowerCase() === dom || String(x.signingDomain || '').toLowerCase().endsWith('.' + dom)));
  if (dk) return {ok: true, waarom: 'dkim=pass ' + dk.signingDomain};
  const spf = (r.spf && r.spf.status && r.spf.status.result) || 'none';
  const spfDom = String((r.spf && r.spf.domain) || String(envFrom || '').split('@')[1] || '').toLowerCase();
  if (spf === 'pass' && spfDom && (spfDom === dom || spfDom.endsWith('.' + dom))) return {ok: true, waarom: 'spf=pass ' + spfDom};
  const waarom = 'niet aantoonbaar echt (dmarc=' + dm + ', spf=' + spf + ', arc=' + (arcR.result || 'none') + ')';
  if (/^(fail|reject|quarantine)$/.test(dm)) return {ok: false, waarom};
  return {ok: !streng, waarom};
}
// (oud, blijft als extra controle) geeft de mail-authenticatie aan dat de afzender vervalst is?
function vervalst(headers) {
  const h = headers || {}, waarden = [];
  for (const k of Object.keys(h)) if (/^(arc-)?authentication-results$/i.test(k)) waarden.push(...[].concat(h[k]).map(String));
  const t = waarden.join(' ').toLowerCase();
  if (!t) return false;
  if (/dmarc=fail/.test(t)) return true;
  if (/spf=fail/.test(t) && !/dkim=pass/.test(t)) return true;
  return false;
}
// welke monteur hoort bij dit adres?
async function zoekMonteur(adres, cache) {
  const lp = lokaal(adres);
  if (!cache.lijst) cache.lijst = (await db.collection('monteurs').get()).docs.map((d) => Object.assign({uid: d.id}, d.data() || {}));
  const hits = cache.lijst.filter((m) => m.email && (lokaal(m.email) === lp || (m.naam && slug(m.naam) === lp)));
  const uniek = [...new Map(hits.map((m) => [m.uid, m])).values()];
  return uniek.length === 1 ? uniek[0] : (uniek.length > 1 ? 'dubbel' : null);
}

// tekst van de mail -> opmerking (doorgestuurde kopjes en handtekening eraf, max. 300 tekens)
function opmerking(t) {
  const regels = String(t || '').split(/\r?\n/), uit = [];
  for (const r of regels) {
    if (/^\s*(-{2,}|_{5,}|>|Van:|From:|Verzonden:|Sent:|Op .+ schreef|On .+ wrote|Met vriendelijke groet)/i.test(r)) break;
    uit.push(r);
  }
  return tekst(uit.join(' ').replace(/\s+/g, ' ').trim(), 300);
}

// een binnengekomen mail verwerken (zelfde voor Cloudflare en Brevo)
// m = {sleutel, van, onderwerp, opm, adressen[], headers{}, bijlagen:[{naam, type, size, buf() -> Promise<Buffer>}]}
async function verwerkMail(m, cache) {
  const van = String(m.van || '').trim().toLowerCase();
  for (const b of (m.bijlagen || [])) { const f = b.buf; let p = null; b.buf = () => (p = p || f()); }
  // plaatjes die in de tekst staan (logo's in de handtekening) tellen niet als bijlage
  m.bijlagen = (m.bijlagen || []).filter((b) => !(b.inline && /^image\//i.test(b.type || '') && (b.size || 0) < 100 * 1024));
  const msgId = crypto.createHash('sha256').update(String(m.sleutel)).digest('hex').slice(0, 40);
  const logRef = db.doc('inboundlog/' + msgId);
  try {
    if ((await logRef.get()).exists) return 'dubbel'; // al verwerkt
    await logRef.set({t: Date.now(), van, onderwerp: tekst(m.onderwerp, 200), status: 'bezig'});
    // afzender controleren; onbekenden krijgen GEEN antwoord (geen spam terugsturen)
    if (!(await magKlaarzetten(van))) { await logRef.set({status: 'geweigerd: afzender onbekend'}, {merge: true}); logger.warn('klaarzetten: onbekende afzender', {van}); return 'onbekend'; }
    const ck = await afzenderControle(m.raw, van, m.envFrom);
    if (!ck.ok) {
      await logRef.set({status: 'geweigerd: ' + ck.waarom}, {merge: true});
      logger.warn('klaarzetten: afzender niet gecontroleerd', {van, waarom: ck.waarom});
      // hoogstens één uitleg-mail per afzender per uur (geen mailbom als iemand het adres vervalst)
      const wRef = db.doc('inboundweiger/' + crypto.createHash('sha256').update(van).digest('hex').slice(0, 32));
      const wOud = await wRef.get().catch(() => null);
      if (wOud && wOud.exists && Date.now() - (wOud.get('t') || 0) < 3600000) return 'niet gecontroleerd';
      await wRef.set({t: Date.now()}).catch(() => {});
      await brevoMail(van, 'Niet klaargezet: ' + tekst(m.onderwerp || 'werkbon', 150),
        'Er kwam een mail binnen op ' + tekst((m.adressen || []).join(', '), 200) + ' met jouw adres als afzender, maar we konden niet controleren ' +
        'dat die echt van jou kwam (' + ck.waarom + '). Daarom is er niets klaargezet.\n\n' +
        'Heb jij deze mail gestuurd? Zet de bon dan klaar via kantoor.html, of vraag de beheerder om naar de afzendercontrole te kijken ' +
        '(beheer.html > Instellingen). Heb je hem niet gestuurd? Meld het dan bij de beheerder.\n\nMIT Werkbon\n' +
        '(Verstuurd met de MIT Werkbon-app. Dit mailadres wordt niet beantwoord.)');
      return 'niet gecontroleerd';
    }
    if (vervalst(m.headers)) { await logRef.set({status: 'geweigerd: afzender niet echt'}, {merge: true}); logger.warn('klaarzetten: vervalste afzender?', {van}); return 'vervalst'; }
    // rooster@mit-werkbon.com: storingsrooster van kantoor, direct publiceren (v202)
    if ((m.adressen || []).some((a) => /^rooster@/i.test(String(a || '').trim()))) return await verwerkRoosterMail(m, van, logRef);
    // agenda@mit-werkbon.com: weekplanning van kantoor (v180)
    if ((m.adressen || []).some((a) => /^agenda@/i.test(String(a || '').trim()))) return await verwerkAgendaMail(m, van, logRef, cache);
    // voor welke monteur(s)?
    const adressen = [...new Set((m.adressen || []).map((a) => String(a || '').trim().toLowerCase())
      .filter((a) => INBOUND_DOMEINEN.some((d) => a.endsWith('@' + d))))];
    const monteurs = [], fouten = [];
    for (const a of adressen) {
      const mt = await zoekMonteur(a, cache);
      if (mt === 'dubbel') fouten.push(a + ': meerdere monteurs passen bij dit adres. Gebruik het adres uit de lijst op beheer.html.');
      else if (!mt) fouten.push(a + ': geen monteur gevonden. Kijk op beheer.html > Bonnen klaarzetten voor de juiste adressen.');
      else { const bl = await db.doc('geblokkeerd/' + String(mt.email).toLowerCase()).get(); if (bl.exists && bl.get('volledig') === true) fouten.push(a + ': deze monteur is geblokkeerd.'); else monteurs.push(mt); }
    }
    // PDF's ophalen en uitlezen; een PDF met werkbonnummer = een bon, de rest gaat als bijlage mee
    const isPdf = (b) => /pdf/i.test(b.type || '') || /\.pdf$/i.test(b.naam || '');
    const pdfs = (m.bijlagen || []).filter(isPdf).slice(0, MAX_BIJLAGEN + MAX_EXTRA);
    if (!pdfs.length) fouten.push('Er zat geen PDF bij de mail.');
    const gelezen = [];
    if (monteurs.length) {
      for (const b of pdfs) {
        if ((b.size || 0) > MAX_PDF_IN) { fouten.push((b.naam || 'bijlage') + ' is groter dan 15 MB.'); continue; }
        let buf;
        try { buf = await b.buf(); } catch (e) { fouten.push((b.naam || 'bijlage') + ' kon niet worden opgehaald (' + tekst(e && e.message, 60) + ').'); continue; }
        if (buf.length > MAX_PDF_IN) { fouten.push((b.naam || 'bijlage') + ' is groter dan 15 MB.'); continue; }
        if (buf.slice(0, 4).toString('latin1') !== '%PDF') { fouten.push((b.naam || 'bijlage') + ' is geen PDF.'); continue; }
        gelezen.push({b, naam: tekst(b.naam, 120) || 'werkbon.pdf', buf, g: await leesBon(buf)});
      }
    }
    let bestanden = gelezen.filter((f) => f.g && f.g.wb).slice(0, MAX_BIJLAGEN);
    if (!bestanden.length && gelezen.length) bestanden = [gelezen[0]]; // geen werkbonnummer gevonden: de eerste PDF is de bon
    // overige bijlagen: PDF's zonder werkbonnummer, foto's, Word, Excel enz. (logo's in de handtekening zijn al weg)
    const extra = [], extraNiet = [];
    if (monteurs.length && bestanden.length) {
      let totaal = 0;
      const kandidaten = [].concat(gelezen.filter((f) => !bestanden.includes(f)).map((f) => ({naam: f.naam, type: 'application/pdf', buf: async () => f.buf})),
        (m.bijlagen || []).filter((b) => !isPdf(b)).map((b) => ({naam: tekst(b.naam, 120) || 'bijlage', type: b.type || 'application/octet-stream', buf: b.buf, size: b.size})));
      for (const k of kandidaten) {
        if (extra.length >= MAX_EXTRA) { extraNiet.push(k.naam + ' (te veel bijlagen)'); continue; }
        let buf; try { buf = await k.buf(); } catch (e) { extraNiet.push(k.naam + ' (kon niet worden opgehaald)'); continue; }
        const nee = bijlageOk(k.naam, buf);
        if (nee) { extraNiet.push(k.naam + ' (' + nee + ')'); continue; }
        if (buf.length > MAX_EXTRA_BESTAND || totaal + buf.length > MAX_EXTRA_TOTAAL) { extraNiet.push(k.naam + ' (te groot)'); continue; }
        totaal += buf.length; extra.push({naam: k.naam, type: k.type, buf});
      }
    }
    // klaarzetten (zelfde vorm als beheer.html)
    const opm = tekst(m.opm, 300), gelukt = [];
    for (const mt of monteurs) {
      for (const f of bestanden) {
        const id = Date.now() + '_' + crypto.randomBytes(4).toString('hex'), ref = db.collection('inbox').doc(id);
        const b64 = f.buf.toString('base64'), n = Math.ceil(b64.length / CH);
        for (let i = 0; i < n; i++) await ref.collection('parts').doc(String(i)).set({d: b64.slice(i * CH, (i + 1) * CH)});
        // bijlagen van kantoor: in dezelfde subcollectie, als b<nr>_<deel> (de Firestore-regels voor parts gelden dan ook)
        const bijl = [];
        for (let j = 0; j < extra.length; j++) {
          const x = extra[j], xb = x.buf.toString('base64'), xn = Math.max(1, Math.ceil(xb.length / CH));
          for (let i = 0; i < xn; i++) await ref.collection('parts').doc('b' + j + '_' + i).set({d: xb.slice(i * CH, (i + 1) * CH)});
          bijl.push({naam: x.naam, type: x.type, size: x.buf.length, n: xn});
        }
        await ref.set({voor: mt.uid, voorMail: String(mt.email || '').toLowerCase(), voorNaam: mt.naam || '', door: van, t: Date.now(), status: 'klaar',
          bestand: f.naam, size: f.buf.length, parts: n, g: f.g || {}, opm, via: 'mail', bijl});
        const klant = String((f.g && f.g.wadres) || '').split('\n')[0];
        await db.collection('inboxlog').doc(Date.now() + '_' + crypto.randomBytes(2).toString('hex')).set({t: Date.now(), door: van, actie: 'klaargezet (per mail)',
          wb: String((f.g && f.g.wb) || f.naam), klant, voor: mt.naam || mt.email || '', naar: ''});
        gelukt.push('- ' + (mt.naam || mt.email) + ': ' + (f.g && f.g.wb ? 'werkbon ' + f.g.wb : f.naam) + (klant ? ' (' + klant + ')' : '') +
          (bijl.length ? ', met ' + bijl.length + (bijl.length === 1 ? ' bijlage' : ' bijlagen') : ''));
      }
    }
    await logRef.set({status: gelukt.length ? 'klaargezet' : 'mislukt', aantal: gelukt.length, fouten}, {merge: true});
    logger.info('klaarzetten per mail', {van, aantal: gelukt.length, fouten});
    // antwoord naar kantoor
    if (BEVESTIG || fouten.length) {
      const ond = (gelukt.length ? 'Klaargezet' : 'Niet klaargezet') + ': ' + tekst(m.onderwerp || 'werkbon', 150);
      const tb = await terugBijlagen(m.bijlagen || []);
      const txt = (gelukt.length ? 'Deze werkbon(nen) staan klaar in de app:\n' + gelukt.join('\n') + '\n' +
          (extra.length ? 'Bijlagen bij de bon (de monteur kan ze openen in de app): ' + extra.map((x) => x.naam).join(', ') + '\n' : '') +
          (extraNiet.length ? 'Niet bij de bon gezet: ' + extraNiet.join(', ') + '\n' : '') : 'Er is niets klaargezet.\n') +
        (fouten.length ? '\nLet op:\n- ' + fouten.join('\n- ') + '\n' : '') +
        '\nOp beheer.html > Bonnen klaarzetten kun je een bon nog verplaatsen of intrekken.\n' +
        (tb.mee.length ? '\nMeegestuurd (uit de oorspronkelijke mail): ' + tb.mee.map((x) => x.naam).join(', ') + '\n' : '') +
        (tb.niet.length ? 'Niet meegestuurd: ' + tb.niet.join(', ') + '\n' : '') +
        '\nMIT Werkbon\n(Verstuurd met de MIT Werkbon-app. Dit mailadres wordt niet beantwoord.)\n\n' +
        '---------- Oorspronkelijk bericht ----------\n' +
        'Van: ' + tekst(m.vanTekst || van, 200) + '\n' +
        (m.datum ? 'Verzonden: ' + tekst(m.datum, 100) + '\n' : '') +
        'Aan: ' + tekst(m.aanTekst || (m.adressen || []).join(', '), 400) + '\n' +
        'Onderwerp: ' + tekst(m.onderwerp, 300) + '\n\n' +
        tekst(m.tekstVolledig || '', 20000);
      await brevoMail(van, ond, txt, tb.mee);
    }
    return gelukt.length ? 'klaargezet' : 'mislukt';
  } catch (e) {
    logger.error('klaarzetten per mail mislukt', e);
    await logRef.set({status: 'fout: ' + tekst(e && e.message, 200)}, {merge: true}).catch(() => {});
    return 'fout';
  }
}

const gelijk = (a, b) => { a = String(a || ''); b = String(b || ''); return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); };

exports.mailInbox = onRequest({secrets: [BREVO_API_KEY], invoker: 'public', memory: '1GiB', timeoutSeconds: 300}, async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('');
  let sys = {};
  try { const d = await db.doc('systeem/inbound').get(); sys = d.exists ? (d.data() || {}) : {}; } catch (e) { /* leeg */ }
  const cache = {};

  // A. Cloudflare Email Worker: de hele mail (MIME) met de sleutel in een kopregel
  if (req.get('x-mit-sleutel') !== undefined) {
    if (!gelijk(req.get('x-mit-sleutel'), sys.cfToken)) { logger.warn('mailInbox: sleutel van Cloudflare klopt niet'); return res.status(403).send('sleutel'); }
    const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody : (Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : ''));
    if (!raw.length) { logger.error('mailInbox: lege mail ontvangen', {type: req.get('content-type')}); return res.status(400).send('leeg'); }
    try {
    const {simpleParser} = require('mailparser');
    const mail = await simpleParser(raw, {skipHtmlToText: false, skipTextLinks: true});
    const hdr = {};
    for (const [k, v] of mail.headers) if (/authentication-results/i.test(k)) hdr[k] = [].concat(v).map((x) => typeof x === 'string' ? x : JSON.stringify(x));
    const van = (mail.from && mail.from.value && mail.from.value[0] && mail.from.value[0].address) || req.get('x-mail-from') || '';
    const aan = String(req.get('x-mail-to') || '');
    const uitslag = await verwerkMail({
      sleutel: 'cf|' + (mail.messageId || crypto.createHash('sha256').update(raw).digest('hex')) + '|' + aan.toLowerCase(),
      van, onderwerp: mail.subject || '', opm: opmerking(mail.text || ''), adressen: [aan], headers: hdr, raw, envFrom: req.get('x-mail-from') || '',
      vanTekst: (mail.from && mail.from.text) || van, aanTekst: [mail.to && mail.to.text, mail.cc && ('CC: ' + mail.cc.text)].filter(Boolean).join('; ') || aan,
      datum: mail.date ? mail.date.toLocaleString('nl-NL', {timeZone: 'Europe/Amsterdam'}) : '', tekstVolledig: mail.text || '',
      bijlagen: (mail.attachments || []).map((a) => ({naam: a.filename || (/pdf/i.test(a.contentType || '') ? 'werkbon.pdf' : 'bijlage'), type: a.contentType,
        size: a.size || (a.content && a.content.length) || 0, inline: a.contentDisposition === 'inline' || !!a.related, buf: async () => a.content})),
    }, cache);
    logger.info('mailInbox (Cloudflare)', {van, aan, uitslag});
    return res.status(200).json({ok: true, uitslag});
    } catch (e) {
      logger.error('mailInbox (Cloudflare) mislukt', e);
      return res.status(500).json({ok: false, fout: tekst(e && e.message, 200)});
    }
  }

  // alleen Cloudflare (de oude route via Brevo inbound is weggehaald, v173)
  return res.status(403).send('');
});

// het script voor Cloudflare (Workers & Pages > je Worker > Code bewerken > plakken > Deploy)
function cfScript(url, sleutel) {
  return [
    '// MIT Werkbon: mail naar <monteur>@mit-werkbon.com doorgeven aan de server (werkbon klaarzetten).',
    '// Gemaakt op beheer.html. Niet delen: hierin staat de geheime sleutel.',
    "const URL = '" + url + "';",
    "const SLEUTEL = '" + sleutel + "';",
    'export default {',
    '  async email(message, env, ctx) {',
    "    if (message.rawSize > 25 * 1024 * 1024) { message.setReject('Bericht is te groot (max. 25 MB).'); return; }",
    '    const raw = await new Response(message.raw).arrayBuffer();',
    '    const r = await fetch(URL, {method: \'POST\', body: raw, headers: {',
    "      'content-type': 'message/rfc822', 'x-mit-sleutel': SLEUTEL,",
    "      'x-mail-from': message.from, 'x-mail-to': message.to}});",
    "    if (r.status === 403) { console.log('MIT Werkbon: sleutel klopt niet (403). Maak een nieuw script op beheer.html.'); message.setReject('Niet toegestaan.'); return; }",
    "    const t = await r.text().catch(() => '');",
    "    if (!r.ok) { console.log('MIT Werkbon: server gaf ' + r.status + ' ' + t.slice(0, 300)); throw new Error('Server gaf ' + r.status); }",
    "    console.log('MIT Werkbon: ' + t.slice(0, 200));",
    '  },',
    '};',
    ''].join('\n');
}

// ---- script voor Cloudflare maken (knop op beheer.html, alleen beheerder) ----
exports.inboxSetup = onRequest({cors: true, invoker: 'public', timeoutSeconds: 60}, async (req, res) => {
  const fout = (c, m) => res.status(c).json({ok: false, fout: m});
  if (req.method !== 'POST') return fout(405, 'Alleen POST.');
  const m = /^Bearer (.+)$/.exec(req.get('Authorization') || '');
  let tok; try { tok = await admin.auth().verifyIdToken(m ? m[1] : ''); } catch (e) { return fout(401, 'Niet ingelogd.'); }
  if (!tok.email_verified || !BEHEERDERS.includes(String(tok.email || '').toLowerCase())) return fout(403, 'Alleen de beheerder.');
  // Cloudflare: nieuwe sleutel maken en het script teruggeven (de oude sleutel werkt dan niet meer)
  if ((req.body && req.body.mode) === 'cloudflare') {
    const cfToken = crypto.randomBytes(24).toString('hex');
    await db.doc('systeem/inbound').set({cfToken, cfT: Date.now(), cfDoor: tok.email}, {merge: true});
    return res.json({ok: true, script: cfScript(inboxUrl(), cfToken)});
  }
  return fout(400, 'Alleen de koppeling met Cloudflare wordt nog ondersteund.');
});

// ---- v173: nieuwe accounts alleen voor MIT-adressen en toegelaten adressen ----
// Iemand met een ander adres kan in de app geen account meer maken (de app controleert het al). Lukt het toch
// (bijvoorbeeld rechtstreeks via de Firebase-API), dan haalt deze functie het account direct weer weg.
// Toegelaten zijn: @mit-installatietechniek.com, de beheerders, en adressen in toegang/ of kantoor/ (beheer.html).
exports.nieuwAccount = functionsV1.region('europe-west1').auth.user().onCreate(async (user) => {
  const a = String((user && user.email) || '').trim().toLowerCase();
  let ok = !!a && (TOEGESTANE_DOMEINEN.some((d) => a.endsWith('@' + d)) || BEHEERDERS.includes(a));
  if (!ok && a) {
    try {
      const [t, k] = await Promise.all([db.doc('toegang/' + a).get(), db.doc('kantoor/' + a).get()]);
      ok = t.exists || k.exists;
    } catch (e) { logger.error('nieuwAccount: controle mislukt, account blijft staan', e); return; }
  }
  if (ok) return;
  try {
    await admin.auth().deleteUser(user.uid);
    await db.collection('users').doc(user.uid).delete().catch(() => {});
    logger.warn('nieuwAccount: account weggehaald (adres niet toegelaten)', {uid: user.uid, domein: a.split('@')[1] || '(geen adres)'});
  } catch (e) { logger.error('nieuwAccount: weghalen mislukt', e); }
});
