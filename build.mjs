// Bouwt de app voor Vercel: kopieert de app naar dist/ en de externe onderdelen uit node_modules naar dist/lib/.
// Ontbreekt een onderdeel, dan gaat het publiceren gewoon door; de app gebruikt dan voor dat onderdeel de oude externe plek.
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// Onderdelen met vaste versies. Elk pakket wordt los geinstalleerd: mislukt er een, dan gaat het publiceren door.
const PKGS = [['pdfjs-dist', '3.11.174'], ['jspdf', '2.5.1'], ['pdf-lib', '1.17.1'], ['jszip', '3.10.1'],
  ['tesseract.js', '5.1.1'], ['tesseract.js-core', '5.1.1'], ['@tesseract.js-data/nld', '1.0.0'], ['firebase', '10.12.2']];
// elk pakket in een eigen map (.mitlibs/<naam>), zodat een volgende installatie de vorige niet opruimt
const BASE = process.env.MIT_LIBDIR || '.mitlibs';
const dirOf = n => path.join(BASE, n.replace(/[@/]/g, '_'));
if (!process.env.MIT_SKIP_INSTALL) {
  for (const [n, v] of PKGS) {
    const d = dirOf(n);
    try { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'package.json'), '{"private":true}');
      execSync(`npm install --prefix "${d}" --no-audit --no-fund --ignore-scripts ${n}@${v}`, { stdio: 'inherit' }); }
    catch (e) { console.warn(`LET OP: ${n}@${v} kon niet worden opgehaald.`); }
  }
}
// map van een pakket na installatie
const P = n => path.join(dirOf(n), 'node_modules', n);

const OUT = 'dist', LIB = path.join(OUT, 'lib');
const APP = ['index.html', 'beheer.html', 'sw.js', 'manifest.webmanifest', 'fb.js', 'rooster.js', 'libs.js',
  'firebase-config.js', 'handleiding.pdf', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'];
const log = [], miss = [];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(LIB, { recursive: true });

function copy(from, to) {
  try { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); log.push(to.replace(OUT + '/', '')); return true; }
  catch (e) { miss.push(from); return false; }
}
for (const f of APP) if (!copy(f, path.join(OUT, f))) console.warn('LET OP: app-bestand ontbreekt:', f);

// losse onderdelen
copy(`${P('pdfjs-dist')}/build/pdf.min.js`, `${LIB}/pdf.min.js`);
copy(`${P('pdfjs-dist')}/build/pdf.worker.min.js`, `${LIB}/pdf.worker.min.js`);
copy(`${P('jspdf')}/dist/jspdf.umd.min.js`, `${LIB}/jspdf.umd.min.js`);
copy(`${P('pdf-lib')}/dist/pdf-lib.min.js`, `${LIB}/pdf-lib.min.js`);
copy(`${P('jszip')}/dist/jszip.min.js`, `${LIB}/jszip.min.js`);

// tekstherkenning: programma, worker, kern (wasm) en Nederlandse taaldata
copy(`${P('tesseract.js')}/dist/tesseract.min.js`, `${LIB}/tesseract/tesseract.min.js`);
copy(`${P('tesseract.js')}/dist/worker.min.js`, `${LIB}/tesseract/worker.min.js`);
try {
  for (const f of fs.readdirSync(P('tesseract.js-core'))) if (/^tesseract-core.*\.(js|wasm)$/.test(f)) copy(`${P('tesseract.js-core')}/${f}`, `${LIB}/tesseract-core/${f}`);
} catch (e) { miss.push('tesseract.js-core'); }
(function lang() {
  const base = P('@tesseract.js-data/nld');
  const cand = ['4.0.0_best_int', '4.0.0', ''];
  for (const c of cand) { const p = path.join(base, c, 'nld.traineddata.gz'); if (fs.existsSync(p)) { copy(p, `${LIB}/tessdata/nld.traineddata.gz`); return; } }
  miss.push('nld.traineddata.gz');
})();

// Firebase (moderne modules): onderlinge verwijzingen naar gstatic omzetten naar het eigen adres
for (const f of ['firebase-app.js', 'firebase-auth.js', 'firebase-firestore.js', 'firebase-app-check.js']) {
  try {
    const src = fs.readFileSync(`${P('firebase')}/${f}`, 'utf8').replace(/https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\//g, './');
    fs.mkdirSync(`${LIB}/firebase`, { recursive: true }); fs.writeFileSync(`${LIB}/firebase/${f}`, src); log.push(`lib/firebase/${f}`);
  } catch (e) { miss.push(`firebase/${f}`); }
}

fs.writeFileSync(`${LIB}/manifest.json`, JSON.stringify({ gebouwd: new Date().toISOString(), bestanden: log.filter(f => f.startsWith('lib/')), ontbreekt: miss }, null, 1));
console.log(`Klaar: ${log.length} bestanden in ${OUT}/.`);
if (miss.length) console.warn('Niet gevonden (app gebruikt hiervoor de externe terugval):', miss.join(', '));
