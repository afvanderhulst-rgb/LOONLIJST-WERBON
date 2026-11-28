// MIT Werkbon - automatische test van de Firestore-regels (firestore-regels.txt).
// Draait in GitHub Actions vóór het publiceren van de regels (workflow "Firestore-regels naar Firebase"):
// gaat er een test mis, dan worden de regels NIET gepubliceerd en blijven de oude staan.
// Zelf draaien (met Java 21+):
//   npm i --no-save firebase-tools@14 @firebase/rules-unit-testing@4 firebase@11
//   npx firebase emulators:exec --only firestore --project demo-mit "node --test tests/*.test.mjs"
import {test, before, after, beforeEach} from 'node:test';
import {readFileSync} from 'node:fs';
import {initializeTestEnvironment, assertSucceeds, assertFails} from '@firebase/rules-unit-testing';
import {doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, where, getDocs} from 'firebase/firestore';

const [host, port] = String(process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
let env;
const ADMIN = {uid: 'uAdmin', email: 'a.f.vanderhulst@gmail.com'};
const KANTOOR = {uid: 'uK', email: 'kantoor@mit-installatietechniek.com'};
const JAN = {uid: 'uA', email: 'jan@mit-installatietechniek.com'};
const PIET = {uid: 'uB', email: 'piet@mit-installatietechniek.com'};
const VREEMD = {uid: 'uX', email: 'iemand@gmail.com'};
const GEBLOKT = {uid: 'uG', email: 'weg@mit-installatietechniek.com'};
const db = (p) => env.authenticatedContext(p.uid, {email: p.email, email_verified: true}).firestore();
const anon = () => env.unauthenticatedContext().firestore();

before(async () => {
  env = await initializeTestEnvironment({projectId: 'demo-mit', firestore: {rules: readFileSync(new URL('../firestore-regels.txt', import.meta.url), 'utf8'), host, port: +port}});
});
after(async () => { await env.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore();
    await setDoc(doc(f, 'kantoor/' + KANTOOR.email), {t: 1});
    await setDoc(doc(f, 'geblokkeerd/' + GEBLOKT.email), {volledig: true});
    await setDoc(doc(f, 'inbox/i1'), {voor: JAN.uid, status: 'klaar', t: 1, opm: ''});
    await setDoc(doc(f, 'inbox/i2'), {voor: PIET.uid, status: 'klaar', t: 1});
    await setDoc(doc(f, 'agenda/a1'), {voor: JAN.uid, pd: '2026-11-23', wb: '29145', oms: 'x'});
    await setDoc(doc(f, 'correctie/c1'), {voor: JAN.uid, wb: '29145', reden: ['Uren kloppen niet'], opm: '', door: KANTOOR.email, t: 1, status: 'open'});
    await setDoc(doc(f, 'bonpdf/uA_b1'), {uid: JAN.uid, wb: '29145', parts: 1});
    await setDoc(doc(f, 'mailuit/m1'), {uid: JAN.uid, status: 'ok'});
    await setDoc(doc(f, 'instellingen/app'), {planAan: true});
    await setDoc(doc(f, 'users/uB/backups/x'), {t: 1});
  });
});

// ---------- eigen back-ups ----------
test('monteur mag zijn eigen back-up schrijven en lezen', async () => {
  await assertSucceeds(setDoc(doc(db(JAN), 'users/uA/backups/x'), {t: 1}));
  await assertSucceeds(getDoc(doc(db(JAN), 'users/uA/backups/x')));
});
test('monteur mag de back-up van een collega niet lezen of schrijven', async () => {
  await assertFails(getDoc(doc(db(JAN), 'users/uB/backups/x')));
  await assertFails(setDoc(doc(db(JAN), 'users/uB/backups/y'), {t: 1}));
});
test('beheerder mag back-ups lezen', async () => { await assertSucceeds(getDoc(doc(db(ADMIN), 'users/uB/backups/x'))); });
test('vreemd adres (niet toegelaten) krijgt geen back-up', async () => { await assertFails(setDoc(doc(db(VREEMD), 'users/uX/backups/x'), {t: 1})); });
test('geblokkeerde gebruiker kan niets meer', async () => { await assertFails(setDoc(doc(db(GEBLOKT), 'users/uG/backups/x'), {t: 1})); });
test('niet ingelogd: niets', async () => {
  await assertFails(getDoc(doc(anon(), 'inbox/i1')));
  await assertFails(getDoc(doc(anon(), 'instellingen/app')));
});

// ---------- klaargezette bonnen (inbox) ----------
test('kantoor mag een bon klaarzetten', async () => { await assertSucceeds(setDoc(doc(db(KANTOOR), 'inbox/n1'), {voor: JAN.uid, status: 'klaar', t: 1, opm: 'sleutel bij buren'})); });
test('kantoor: te lange opmerking wordt geweigerd', async () => { await assertFails(setDoc(doc(db(KANTOOR), 'inbox/n2'), {voor: JAN.uid, status: 'klaar', t: 1, opm: 'x'.repeat(600)})); });
test('kantoor: te groot PDF-deel wordt geweigerd', async () => {
  await assertSucceeds(setDoc(doc(db(KANTOOR), 'inbox/i1/parts/0'), {d: 'A'.repeat(1000)}));
  await assertFails(setDoc(doc(db(KANTOOR), 'inbox/i1/parts/1'), {d: 'A'.repeat(500000)}));
});
test('monteur ziet alleen zijn eigen klaargezette bonnen', async () => {
  await assertSucceeds(getDoc(doc(db(JAN), 'inbox/i1')));
  await assertFails(getDoc(doc(db(JAN), 'inbox/i2')));
  await assertSucceeds(getDocs(query(collection(db(JAN), 'inbox'), where('voor', '==', JAN.uid))));
});
test('monteur mag alleen status/verstuurd terugmelden, niet de bon wijzigen', async () => {
  await assertSucceeds(updateDoc(doc(db(JAN), 'inbox/i1'), {status: 'opgehaald', verstuurd: 2, gereed: 'ja'}));
  await assertFails(updateDoc(doc(db(JAN), 'inbox/i1'), {status: 'opgehaald', voor: PIET.uid}));
  await assertFails(setDoc(doc(db(JAN), 'inbox/n3'), {voor: JAN.uid, status: 'klaar'}));
});

test('monteur mag een overgenomen, niet verstuurde bon terugzetten naar klaargezet (v230)', async () => {
  await env.withSecurityRulesDisabled(async (c) => { await setDoc(doc(c.firestore(), 'inbox/i3'), {voor: JAN.uid, status: 'opgehaald', opgehaald: 5, t: 1}); await setDoc(doc(c.firestore(), 'inbox/i4'), {voor: JAN.uid, status: 'opgehaald', opgehaald: 5, verstuurd: 9, t: 1}); });
  await assertSucceeds(updateDoc(doc(db(JAN), 'inbox/i3'), {status: 'klaar', opgehaald: 0}));
  await assertFails(updateDoc(doc(db(JAN), 'inbox/i4'), {status: 'klaar', opgehaald: 0}));
  await assertFails(updateDoc(doc(db(PIET), 'inbox/i3'), {status: 'klaar'}));
});

// ---------- agenda ----------
test('monteur mag in de agenda alleen bezig/verstuurd terugmelden', async () => {
  await assertSucceeds(updateDoc(doc(db(JAN), 'agenda/a1'), {bezig: 5}));
  await assertFails(updateDoc(doc(db(JAN), 'agenda/a1'), {pd: '2026-11-24'}));
});
test('bijlagen bij een afspraak: kantoor schrijft, alleen de eigen monteur leest (v234)', async () => {
  await assertSucceeds(setDoc(doc(db(KANTOOR), 'agenda/a1/parts/b0_0'), {d: 'QUJD'}));
  await assertFails(setDoc(doc(db(KANTOOR), 'agenda/a1/parts/b0_1'), {d: 'A'.repeat(500000)}));
  await assertFails(setDoc(doc(db(JAN), 'agenda/a1/parts/b1_0'), {d: 'QUJD'}));
  await assertSucceeds(getDoc(doc(db(JAN), 'agenda/a1/parts/b0_0')));
  await assertFails(getDoc(doc(db(PIET), 'agenda/a1/parts/b0_0')));
  await assertSucceeds(updateDoc(doc(db(KANTOOR), 'agenda/a1'), {bijl: [{naam: 'tekening.pdf', type: 'application/pdf', size: 3, n: 1}]}));
});
test('kantoor: te lange omschrijving in de agenda wordt geweigerd', async () => {
  await assertSucceeds(setDoc(doc(db(KANTOOR), 'agenda/a2'), {voor: JAN.uid, pd: '2026-11-24', oms: 'kort'}));
  await assertFails(setDoc(doc(db(KANTOOR), 'agenda/a3'), {voor: JAN.uid, pd: '2026-11-24', oms: 'x'.repeat(1200)}));
  await assertSucceeds(deleteDoc(doc(db(KANTOOR), 'agenda/a1')));
});

// ---------- verstuurde werkbonnen (bonlog) ----------
test('monteur meldt zijn eigen verstuurde werkbon, niet die van een ander', async () => {
  const ok = {voor: JAN.uid, wb: '1', klant: 'k', adres: '', plaats: '', tel: '', pr: '', mis: [], dagen: [], van: '2026-11-23', tot: '2026-11-23', verstuurd: 1, gereed: 'ja', repm: false, t: 1};
  await assertSucceeds(setDoc(doc(db(JAN), 'bonlog/uA_b1'), ok));
  await assertFails(setDoc(doc(db(JAN), 'bonlog/uB_b1'), Object.assign({}, ok, {voor: PIET.uid})));
  await assertFails(setDoc(doc(db(JAN), 'bonlog/uA_b2'), Object.assign({}, ok, {extra: 'x'})));
  await assertSucceeds(setDoc(doc(db(JAN), 'bonlog/uA_b3'), Object.assign({}, ok, {hist: [{t: 1, w: 'aangemaakt', d: 'jan'}]})));
  await assertFails(setDoc(doc(db(JAN), 'bonlog/uA_b4'), Object.assign({}, ok, {hist: Array(25).fill({t: 1, w: 'x', d: ''})})));
  await assertFails(getDoc(doc(db(JAN), 'bonlog/uA_b1')));
  await assertSucceeds(getDoc(doc(db(KANTOOR), 'bonlog/uA_b1')));
});

// ---------- correctie gevraagd ----------
test('alleen kantoor/beheer vraagt een correctie', async () => {
  const c = {voor: JAN.uid, voorNaam: 'Jan', wb: '1', bon: '', ib: '', klant: '', reden: ['Handtekening ontbreekt'], opm: '', door: KANTOOR.email, t: 1, status: 'open'};
  await assertSucceeds(setDoc(doc(db(KANTOOR), 'correctie/c2'), c));
  await assertFails(setDoc(doc(db(KANTOOR), 'correctie/c3'), Object.assign({}, c, {door: 'iemand@anders.nl'})));
  await assertFails(setDoc(doc(db(JAN), 'correctie/c4'), Object.assign({}, c, {door: JAN.email})));
});
test('monteur leest en beantwoordt alleen zijn eigen correctie', async () => {
  await assertSucceeds(getDoc(doc(db(JAN), 'correctie/c1')));
  await assertFails(getDoc(doc(db(PIET), 'correctie/c1')));
  await assertSucceeds(updateDoc(doc(db(JAN), 'correctie/c1'), {status: 'opnieuw', opnieuw: 2}));
  await assertFails(updateDoc(doc(db(JAN), 'correctie/c1'), {reden: []}));
});

// ---------- overige ----------
test('verstuurde PDF: kantoor leest, monteur niet, niemand schrijft', async () => {
  await assertSucceeds(getDoc(doc(db(KANTOOR), 'bonpdf/uA_b1')));
  await assertFails(getDoc(doc(db(JAN), 'bonpdf/uA_b1')));
  await assertFails(setDoc(doc(db(KANTOOR), 'bonpdf/x'), {uid: 'u'}));
});
test('verstuurde werkbon verwijderen: alleen de beheerder (v231)', async () => {
  await assertFails(deleteDoc(doc(db(KANTOOR), 'bonpdf/uA_b1')));
  await assertFails(deleteDoc(doc(db(JAN), 'bonpdf/uA_b1')));
  await assertFails(deleteDoc(doc(db(KANTOOR), 'bonlog/uA_b1')));
  await assertSucceeds(deleteDoc(doc(db(ADMIN), 'bonpdf/uA_b1/parts/0')));
  await assertSucceeds(deleteDoc(doc(db(ADMIN), 'bonpdf/uA_b1')));
  await assertSucceeds(deleteDoc(doc(db(ADMIN), 'bonlog/uA_b1')));
});
test('verzonden mails: alleen de beheerder', async () => {
  await assertSucceeds(getDoc(doc(db(ADMIN), 'mailuit/m1')));
  await assertFails(getDoc(doc(db(KANTOOR), 'mailuit/m1')));
});
test('instellingen: iedereen leest, alleen de beheerder schrijft', async () => {
  await assertSucceeds(getDoc(doc(db(JAN), 'instellingen/app')));
  await assertFails(setDoc(doc(db(JAN), 'instellingen/app'), {planAan: false}));
  await assertFails(setDoc(doc(db(KANTOOR), 'instellingen/app'), {planAan: false}));
  await assertSucceeds(setDoc(doc(db(ADMIN), 'instellingen/app'), {planAan: false}));
});
test('kantoor geeft alleen MIT-adressen toegang tot kantoor', async () => {
  await assertSucceeds(setDoc(doc(db(KANTOOR), 'kantoor/nieuw@mit-installatietechniek.com'), {t: 1, door: KANTOOR.email}));
  await assertFails(setDoc(doc(db(KANTOOR), 'kantoor/iemand@gmail.com'), {t: 1, door: KANTOOR.email}));
  await assertFails(setDoc(doc(db(JAN), 'kantoor/jan@mit-installatietechniek.com'), {t: 1, door: JAN.email}));
});
test('klantenbestand: collega mag een geldige klant opslaan, vreemde niet', async () => {
  const k = {naam: 'Klant', adres: 'Straat 1', plaats: 'Plaats', zoek: 'klant', door: JAN.email, t: 1};
  await assertSucceeds(setDoc(doc(db(JAN), 'klanten/k1'), k));
  await assertFails(setDoc(doc(db(JAN), 'klanten/k2'), Object.assign({}, k, {extra: 1})));
  await assertFails(setDoc(doc(db(VREEMD), 'klanten/k3'), Object.assign({}, k, {door: VREEMD.email})));
});
test('monteurslijst: alleen je eigen naam', async () => {
  await assertSucceeds(setDoc(doc(db(JAN), 'monteurs/uA'), {email: JAN.email, naam: 'Jan', rooster: 'Jan Jansen'}));
  await assertFails(setDoc(doc(db(JAN), 'monteurs/uB'), {email: PIET.email, naam: 'Piet'}));
});
test('monteur vooraf aanmelden: alleen de beheerder (v236)', async () => {
  const pre = {email: 'nieuw@mit-installatietechniek.com', naam: 'Nieuw', vooraf: true, t: 1, door: ADMIN.email};
  await assertSucceeds(setDoc(doc(db(ADMIN), 'monteurs/pre_nieuw'), pre));
  await assertFails(setDoc(doc(db(KANTOOR), 'monteurs/pre_nieuw2'), pre));
  await assertFails(setDoc(doc(db(JAN), 'monteurs/pre_nieuw3'), pre));
  await assertSucceeds(getDocs(query(collection(db(ADMIN), 'monteurs'), where('vooraf', '==', true))));
  await assertSucceeds(setDoc(doc(db(KANTOOR), 'agenda/a9'), {voor: 'pre_nieuw', pd: '2026-12-01', oms: 'x'}));
});
test('kantoor: monteur vooraf aanmelden en uit dienst (v237)', async () => {
  const pre = {email: 'nieuw@mit-installatietechniek.com', naam: 'Nieuw', vooraf: true, t: 1, door: KANTOOR.email};
  await assertSucceeds(setDoc(doc(db(KANTOOR), 'monteurs/pre_nieuw'), pre));
  await assertFails(setDoc(doc(db(KANTOOR), 'monteurs/pre_g'), Object.assign({}, pre, {email: 'iemand@gmail.com'})));
  await assertFails(setDoc(doc(db(KANTOOR), 'monteurs/uX'), pre));
  await assertFails(setDoc(doc(db(JAN), 'monteurs/pre_j'), Object.assign({}, pre, {door: JAN.email})));
  await assertSucceeds(deleteDoc(doc(db(KANTOOR), 'monteurs/pre_nieuw')));
  const ud = {volledig: true, uitdienst: true, t: 1, door: KANTOOR.email, naam: 'Piet'};
  await assertSucceeds(setDoc(doc(db(KANTOOR), 'geblokkeerd/' + PIET.email), ud));
  await assertSucceeds(getDocs(query(collection(db(KANTOOR), 'geblokkeerd'), where('uitdienst', '==', true))));
  await assertFails(getDoc(doc(db(KANTOOR), 'geblokkeerd/' + GEBLOKT.email)));
  await assertFails(setDoc(doc(db(KANTOOR), 'geblokkeerd/arjan@mit-installatietechniek.com'), ud));
  await assertFails(setDoc(doc(db(KANTOOR), 'geblokkeerd/' + KANTOOR.email), ud));
  await assertFails(setDoc(doc(db(KANTOOR), 'geblokkeerd/iemand@gmail.com'), ud));
  await assertFails(deleteDoc(doc(db(KANTOOR), 'geblokkeerd/' + GEBLOKT.email)));
  await assertFails(setDoc(doc(db(JAN), 'geblokkeerd/' + PIET.email), Object.assign({}, ud, {door: JAN.email})));
  await assertSucceeds(deleteDoc(doc(db(KANTOOR), 'geblokkeerd/' + PIET.email)));
});
test('aandachtspunten afhandelen: kantoor wel, monteur niet', async () => {
  await assertSucceeds(setDoc(doc(db(KANTOOR), 'afgehandeld/x'), {t: 1, door: KANTOOR.email}));
  await assertFails(setDoc(doc(db(JAN), 'afgehandeld/y'), {t: 1}));
});
test('beheerlogboek: kantoor/beheer schrijft, alleen beheer leest', async () => {
  const l = {t: 1, door: KANTOOR.email, actie: 'test', wat: ''};
  await assertSucceeds(setDoc(doc(db(KANTOOR), 'beheerlog/l1'), l));
  await assertFails(setDoc(doc(db(KANTOOR), 'beheerlog/l2'), Object.assign({}, l, {door: 'nep@mit-installatietechniek.com'})));
  await assertFails(setDoc(doc(db(JAN), 'beheerlog/l3'), Object.assign({}, l, {door: JAN.email})));
  await assertFails(getDoc(doc(db(KANTOOR), 'beheerlog/l1')));
  await assertSucceeds(getDoc(doc(db(ADMIN), 'beheerlog/l1')));
});
