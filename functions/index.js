/* MIT Werkbon - servercode (Firebase Cloud Functions, regio europe-west1)
   - pushKlaar:   melding naar de monteur zodra kantoor een bon klaarzet (inbox/{id})
   - pushTest:    testmelding als de monteur in de app op "Testmelding" tikt (users/{uid}/pushq/{id})
   - pushPlan:    elke 15 minuten de geplande herinneringen versturen (users/{uid}/pushplan/plan)
   - mailKantoor: werkbon (PDF) direct naar kantoor mailen via Brevo, met kopie naar de monteur;
                  ook de weeklijst (weeklijst-PDF + verzamel-PDF) naar de leidinggevende (soort: 'weeklijst')
   - mailInbox:   werkbon klaarzetten doordat kantoor hem mailt naar <monteur>@mit-werkbon.com
                  (Cloudflare Email Routing + Worker; Brevo inbound wordt ook nog aangenomen)
   - inboxSetup:  knop op beheer.html die het Cloudflare-script maakt (of de koppeling met Brevo)
   Geheimen (Secret Manager): VAPID_PRIVATE_KEY (pushmeldingen), BREVO_API_KEY (mailen). */
const {onDocumentCreated} = require('firebase-functions/v2/firestore');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const {onRequest} = require('firebase-functions/v2/https');
const {setGlobalOptions, logger} = require('firebase-functions/v2');
const {defineSecret} = require('firebase-functions/params');
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

exports.pushKlaar = onDocumentCreated({document: 'inbox/{id}', secrets: [VAPID_PRIVATE_KEY]}, async (ev) => {
  const d = (ev.data && ev.data.data()) || {};
  if (!d.voor || d.status !== 'klaar') return;
  const g = d.g || {};
  const wie = [g.naam || g.klant, [g.adres, g.plaats].filter(Boolean).join(', ')].filter(Boolean).join(' - ');
  await sendTo(d.voor, {
    title: 'Nieuwe werkbon klaargezet',
    body: (wie || 'Kantoor heeft een werkbon voor je klaargezet.') + (d.opm ? '\n' + String(d.opm).slice(0, 120) : ''),
    url: './?go=home', tag: 'klaar-' + ev.params.id,
  });
});

exports.pushTest = onDocumentCreated({document: 'users/{uid}/pushq/{id}', secrets: [VAPID_PRIVATE_KEY]}, async (ev) => {
  const n = await sendTo(ev.params.uid, {title: 'Testmelding MIT Werkbon', body: 'Meldingen werken op deze telefoon.', url: './?go=home', tag: 'test'});
  logger.info('testmelding', {uid: ev.params.uid, telefoons: n});
  await ev.data.ref.delete().catch(() => {});
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
     CC         tot 3 extra adressen die de monteur invult (zelfde domeinen) + altijd de monteur zelf;
                "Beantwoorden" gaat naar de monteur
   BREVO_API_KEY is een API-sleutel van Brevo (Settings > SMTP & API > API Keys), GEEN SMTP-sleutel. */
const AFZENDER = {name: 'MIT Werkbon', email: 'noreply@mit-werkbon.com'};
const TOEGESTANE_DOMEINEN = ['mit-installatietechniek.com'];
const TOEGESTANE_ADRESSEN = ['a.f.vanderhulst@gmail.com']; // losse adressen (tijdelijk, om te testen); later weghalen
const MAX_PER_DAG = 60;            // mails per monteur per dag
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
  const soort = b.soort === 'weeklijst' ? 'weeklijst' : 'werkbon';
  let aan = tekst(b.to, 200).trim();
  // vast kantooradres van de beheerder gaat altijd voor (alleen bij werkbonnen; de weeklijst gaat naar de leidinggevende)
  let vast = '';
  if (soort === 'werkbon') try {
    const inst = await db.doc('instellingen/app').get();
    if (inst.exists && inst.get('kantoorVast') === true) vast = tekst(inst.get('kantoorAdres') || 'storingen@mit-installatietechniek.com', 200).trim();
  } catch (e) { logger.warn('instellingen lezen', e); }
  if (vast && !MAIL_RE.test(vast)) vast = '';
  if (vast) aan = vast;
  const onderwerp = tekst(b.subject, 200).trim() || (soort === 'weeklijst' ? 'Weeklijst' : 'Werkbon');
  const bericht = tekst(b.text, 5000);
  const naamPdf = (v, std) => { let x = tekst(v, 120).replace(/[\\/:*?"<>|]+/g, '-').trim() || std; if (!/\.pdf$/i.test(x)) x += '.pdf'; return x; };
  const isPdf = (x) => typeof x === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(x) && Buffer.from(x.slice(0, 8), 'base64').toString('latin1').slice(0, 4) === '%PDF';
  if (!/^[\w-]{6,80}$/.test(id)) return fout(400, 'Ongeldig verzoek.');
  const ccIn = Array.isArray(b.cc) ? b.cc : [];
  if (ccIn.length > MAX_CC) return fout(400, 'CC: maximaal ' + MAX_CC + ' adressen.');
  const cc = [], gezien = new Set([aan.toLowerCase(), em.toLowerCase()]);
  for (const x of ccIn) {
    const a = tekst(x, 200).trim();
    if (!magNaar(a)) return fout(400, 'CC: naar ' + a + ' kan de app niet mailen. Alleen adressen op @' + TOEGESTANE_DOMEINEN.join(' of @') + '.');
    if (!gezien.has(a.toLowerCase())) { gezien.add(a.toLowerCase()); cc.push({email: a}); }
  }
  if (!vast && !magNaar(aan)) return fout(400, 'Naar dit adres kan de app niet mailen. Alleen adressen op @' + TOEGESTANE_DOMEINEN.join(' of @') + '.');
  // de PDF('s): werkbon = 1 PDF (b.pdf), weeklijst = lijst b.bijlagen [{name, pdf}]
  const bijlagen = [];
  if (soort === 'weeklijst') {
    const l = Array.isArray(b.bijlagen) ? b.bijlagen : [];
    if (!l.length) return fout(400, 'De PDF ontbreekt.');
    if (l.length > MAX_WL_BIJL) return fout(400, 'Te veel bijlagen.');
    for (const x of l) {
      const c = x && typeof x.pdf === 'string' ? x.pdf : '';
      if (!c) return fout(400, 'De PDF ontbreekt.');
      if (!isPdf(c)) return fout(400, 'Dit is geen PDF.');
      bijlagen.push({name: naamPdf(x.name, 'weeklijst.pdf'), content: c});
    }
  } else {
    const pdf = typeof b.pdf === 'string' ? b.pdf : '';
    if (!pdf || !/^[A-Za-z0-9+/]+={0,2}$/.test(pdf)) return fout(400, 'De PDF ontbreekt.');
    if (!isPdf(pdf)) return fout(400, 'Dit is geen PDF.');
    bijlagen.push({name: naamPdf(b.name, 'werkbon.pdf'), content: pdf});
  }
  const grootte = bijlagen.reduce((s, x) => s + Math.floor(x.content.length * 3 / 4), 0);
  const maxB = soort === 'weeklijst' ? MAX_WL : MAX_PDF;
  if (grootte > maxB) return fout(413, (soort === 'weeklijst' ? "De PDF's zijn" : 'De PDF is') + ' te groot (' + (grootte / 1048576).toFixed(1).replace('.', ',') + ' MB, maximaal ' + Math.round(maxB / 1048576) + ' MB).');
  const bestand = bijlagen.map((x) => x.name).join(', ');

  // 3. al eerder verstuurd (de app probeert opnieuw na een storing)? dan niet nog een keer
  const uit = db.doc(`mailuit/${tok.uid}_${id}`); // buiten users/: de app zelf kan hier niet bij (Firestore-regels)
  const al = await uit.get();
  if (al.exists && al.get('status') === 'ok') return res.json({ok: true, dubbel: true});

  // 4. niet te veel per dag
  const dag = new Date().toISOString().slice(0, 10);
  const teller = db.doc(`mailteller/${tok.uid}_${dag}`);
  try {
    const n = await db.runTransaction(async (t) => {
      const s = await t.get(teller), v = ((s.exists && s.get('n')) || 0) + 1;
      if (v <= MAX_PER_DAG) t.set(teller, {n: v, t: Date.now()});
      return v;
    });
    if (n > MAX_PER_DAG) return fout(429, 'Je hebt vandaag al ' + MAX_PER_DAG + ' mails verstuurd. Verstuur deze via je mail-app.');
  } catch (e) { logger.warn('teller', e); }

  // 5. versturen via Brevo
  const mail = {
    sender: AFZENDER,
    to: [{email: aan}],
    replyTo: {email: em, name: naam || em},
    subject: onderwerp,
    textContent: bericht || onderwerp,
    attachment: bijlagen,
    tags: [soort],
  };
  if (aan.toLowerCase() !== em.toLowerCase()) cc.push({email: em, name: naam || em});
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
    return fout(502, 'De mailserver is nu niet bereikbaar. De app probeert het later opnieuw.');
  }
  if (!r.ok) {
    logger.error('brevo weigert', {status: r.status, antwoord: j, uid: tok.uid});
    // 5xx/429 = tijdelijk (de app probeert later opnieuw); anders blijvend (de app meldt het de monteur)
    const tijdelijk = r.status >= 500 || r.status === 429;
    return fout(tijdelijk ? 503 : 422, 'De mailserver weigerde de mail (' + r.status + (j && j.message ? ': ' + tekst(j.message, 150) : '') + ').');
  }
  await uit.set({t: Date.now(), uid: tok.uid, aan, cc: cc.map((c) => c.email), bestand, kb: Math.round(grootte / 1024), status: 'ok', soort, brevo: tekst(j.messageId, 200)}).catch(() => {});
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
const INBOUND_DOMEIN = 'bon.mit-werkbon.com';                 // Brevo inbound (oude route)
const INBOUND_DOMEINEN = ['mit-werkbon.com', INBOUND_DOMEIN];  // alle domeinen waarop bonnen binnenkomen
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
// geeft de mail-authenticatie aan dat de afzender vervalst is?
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
    if (vervalst(m.headers)) { await logRef.set({status: 'geweigerd: afzender niet echt'}, {merge: true}); logger.warn('klaarzetten: vervalste afzender?', {van}); return 'vervalst'; }
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
        '\nMIT Werkbon\n\n' +
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
      van, onderwerp: mail.subject || '', opm: opmerking(mail.text || ''), adressen: [aan], headers: hdr,
      vanTekst: (mail.from && mail.from.text) || van, aanTekst: [mail.to && mail.to.text, mail.cc && ('CC: ' + mail.cc.text)].filter(Boolean).join('; ') || aan,
      datum: mail.date ? mail.date.toLocaleString('nl-NL', {timeZone: 'Europe/Amsterdam'}) : '', tekstVolledig: mail.text || '',
      bijlagen: (mail.attachments || []).map((a) => ({naam: a.filename || (/pdf/i.test(a.contentType || '') ? 'werkbon.pdf' : 'bijlage'), type: a.contentType,
        size: a.size || (a.content && a.content.length) || 0, inline: a.contentDisposition === 'inline' || !!a.related, buf: async () => a.content})),
    }, cache);
    logger.info('mailInbox (Cloudflare)', {van, aan, uitslag});
    return res.status(200).json({ok: true, uitslag});
    } catch (e) {
      logger.error('mailInbox (Cloudflare) mislukt', e);
      return res.status(500).send(tekst(e && e.message, 200));
    }
  }

  // B. Brevo inbound (oude route): JSON met items, sleutel in het adres
  if (!gelijk(String(req.query.key || ''), sys.token)) return res.status(403).send('');
  const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
  for (const it of items.slice(0, 20)) {
    const key = String(BREVO_API_KEY.value() || '').trim();
    await verwerkMail({
      sleutel: String(it.MessageId || it.Uuid || JSON.stringify(it.Subject) + JSON.stringify(it.From)),
      van: it.From && it.From.Address, onderwerp: it.Subject || '', opm: opmerking(it.ExtractedMarkdownMessage || it.RawTextBody || ''),
      adressen: [].concat(it.Recipients || [], (it.To || []).map((x) => x && x.Address), (it.Cc || []).map((x) => x && x.Address)), headers: it.Headers,
      vanTekst: it.From ? ((it.From.Name ? it.From.Name + ' ' : '') + '<' + it.From.Address + '>') : '', datum: it.SentAtDate || '',
      aanTekst: (it.To || []).map((x) => x && x.Address).filter(Boolean).join(', '), tekstVolledig: it.RawTextBody || '',
      bijlagen: (it.Attachments || []).filter((b) => b && b.DownloadToken).map((b) => ({naam: b.Name, type: b.ContentType, size: b.ContentLength || 0, inline: !!b.ContentID,
        buf: async () => {
          const r = await fetch('https://api.brevo.com/v3/inbound/attachments/' + encodeURIComponent(b.DownloadToken), {headers: {'api-key': key}});
          if (!r.ok) throw new Error('status ' + r.status);
          return Buffer.from(await r.arrayBuffer());
        }})),
    }, cache);
  }
  return res.status(200).json({ok: true});
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
    "    if (!r.ok) { const t = await r.text().catch(() => ''); console.log('MIT Werkbon: server gaf ' + r.status + ' ' + t.slice(0, 300)); throw new Error('Server gaf ' + r.status); }",
    "    console.log('MIT Werkbon: ' + (await r.text().catch(() => '')).slice(0, 200));",
    '  },',
    '};',
    ''].join('\n');
}

// ---- koppeling met Brevo aanleggen (knop op beheer.html, alleen beheerder) ----
exports.inboxSetup = onRequest({secrets: [BREVO_API_KEY], cors: true, invoker: 'public', timeoutSeconds: 60}, async (req, res) => {
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
  const key = String(BREVO_API_KEY.value() || '').trim(), H = {'api-key': key, 'content-type': 'application/json', 'accept': 'application/json'};
  try {
    // oude koppelingen voor dit domein weghalen
    // (Brevo geeft een fout "Webhook record does not exist" als er nog geen koppeling is: dan is er niets weg te halen)
    const l = await fetch('https://api.brevo.com/v3/webhooks?type=inbound', {headers: H});
    const lj = await l.json().catch(() => ({}));
    if (!l.ok && (l.status === 401 || l.status === 403)) return fout(502, 'Brevo weigert (' + l.status + (lj.message ? ': ' + lj.message : '') + '). Heeft de API-sleutel volledige toegang?');
    for (const w of (l.ok ? (lj.webhooks || []) : [])) if (w && w.id && (w.domain === INBOUND_DOMEIN || String(w.url || '').indexOf('/mailInbox') > 0)) await fetch('https://api.brevo.com/v3/webhooks/' + w.id, {method: 'DELETE', headers: H});
    // nieuwe geheime sleutel + koppeling
    const token = crypto.randomBytes(24).toString('hex');
    await db.doc('systeem/inbound').set({token, t: Date.now(), door: tok.email}, {merge: true});
    const c = await fetch('https://api.brevo.com/v3/webhooks', {method: 'POST', headers: H, body: JSON.stringify({type: 'inbound', events: ['inboundEmailProcessed'],
      url: inboxUrl() + '?key=' + token, domain: INBOUND_DOMEIN, description: 'MIT Werkbon: bonnen klaarzetten per mail'})});
    const cj = await c.json().catch(() => ({}));
    if (!c.ok) return fout(502, 'Brevo weigert de koppeling (' + c.status + (cj.message ? ': ' + cj.message : '') + '). Is inkomende mail beschikbaar in jullie Brevo-abonnement?');
    return res.json({ok: true, domein: INBOUND_DOMEIN, id: cj.id});
  } catch (e) { logger.error('inboxSetup', e); return fout(500, 'Er ging iets mis: ' + tekst(e && e.message, 150)); }
});
