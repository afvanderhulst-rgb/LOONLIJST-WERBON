/* Firebase laden (moderne modules) voor MIT Werkbonnen en beheer.html.
   Inlog wordt in localStorage bewaard (geen verborgen iframe, geen service-worker-berichten),
   zodat inloggen niet kan blijven hangen. Geeft dezelfde vorm terug als de oude 'compat'-versie. */
(function(){
var EXT='https://www.gstatic.com/firebasejs/10.12.2/',P=null,BASE=EXT;
window.mitAppCheck='uit';
window.mitFBsrc='';
// eerst van het eigen adres (lib/firebase, gevuld door Vercel), anders van Google (gstatic)
async function mods(){var LOC=new URL('lib/firebase/',location.href).href;
 try{var m=await Promise.all([import(LOC+'firebase-app.js'),import(LOC+'firebase-auth.js'),import(LOC+'firebase-firestore.js')]);
  if(m[0].initializeApp&&m[1].initializeAuth&&m[2].getFirestore){window.mitFBsrc='eigen';BASE=LOC;return m}}catch(e){}
 var m2=await Promise.all([import(EXT+'firebase-app.js'),import(EXT+'firebase-auth.js'),import(EXT+'firebase-firestore.js')]);window.mitFBsrc='extern';return m2}
window.mitFB=function(){if(P)return P;P=(async function(){
 var C=window.MIT_FIREBASE;
 var m=await mods();
 var A=m[0],Au=m[1],Fs=m[2];
 var app=A.initializeApp(C);
 // App Check (reCAPTCHA v3): alleen als appCheckKey is ingevuld; zelfde bron als firebase-app gebruiken
 if(C.appCheckKey){try{var Ac=await import(BASE+'firebase-app-check.js');Ac.initializeAppCheck(app,{provider:new Ac.ReCaptchaV3Provider(C.appCheckKey),isTokenAutoRefreshEnabled:true});window.mitAppCheck='aan'}catch(e){window.mitAppCheck='fout';try{console.warn('App Check:',e)}catch(x){}}}
 var a=Au.initializeAuth(app,{persistence:Au.browserLocalPersistence});
 a.languageCode='nl';
 var fs=Fs.getFirestore(app);
 function snap(s){var ex=s.exists();return {id:s.id,exists:ex,data:function(){return s.data()},ref:doc(s.ref)}}
 function doc(r){return {id:r.id,
  set:function(o,opt){return Fs.setDoc(r,o,opt||{})},
  get:async function(){return snap(await Fs.getDoc(r))},
  delete:function(){return Fs.deleteDoc(r)},
  collection:function(n){return col(Fs.collection(r,n),[])}}}
 function col(c,cons){return {
  doc:function(id){return doc(Fs.doc(c,id))},
  orderBy:function(f,d){return col(c,cons.concat([Fs.orderBy(f,d||'asc')]))},
  limit:function(n){return col(c,cons.concat([Fs.limit(n)]))},
  get:async function(){var q=await Fs.getDocs(cons.length?Fs.query.apply(null,[c].concat(cons)):c);var d=q.docs.map(snap);return {docs:d,size:d.length}}}}
 var db={collection:function(p){return col(Fs.collection(fs,p),[])}};
 var auth={
  get currentUser(){return a.currentUser},
  onAuthStateChanged:function(f){return Au.onAuthStateChanged(a,f)},
  createUserWithEmailAndPassword:function(e,p){return Au.createUserWithEmailAndPassword(a,e,p)},
  signInWithEmailAndPassword:function(e,p){return Au.signInWithEmailAndPassword(a,e,p)},
  signOut:function(){return Au.signOut(a)},
  sendPasswordResetEmail:function(e){return Au.sendPasswordResetEmail(a,e)},
  sendEmailVerification:function(u){return Au.sendEmailVerification(u||a.currentUser)},
  reauth:function(pw){var u=a.currentUser;return Au.reauthenticateWithCredential(u,Au.EmailAuthProvider.credential(u.email,pw))},
  deleteMe:function(){return Au.deleteUser(a.currentUser)}};
 return {auth:auth,db:db}})();
 P.catch(function(){P=null});return P};
})();
