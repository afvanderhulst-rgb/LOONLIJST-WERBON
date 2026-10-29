/* Firebase laden (moderne modules) voor MIT Werkbonnen en beheer.html.
   Inlog wordt in localStorage bewaard (geen verborgen iframe, geen service-worker-berichten),
   zodat inloggen niet kan blijven hangen. Geeft dezelfde vorm terug als de oude 'compat'-versie. */
(function(){
var V='https://www.gstatic.com/firebasejs/10.12.2/',P=null;
window.mitFB=function(){if(P)return P;P=(async function(){
 var C=window.MIT_FIREBASE;
 var m=await Promise.all([import(V+'firebase-app.js'),import(V+'firebase-auth.js'),import(V+'firebase-firestore.js')]);
 var A=m[0],Au=m[1],Fs=m[2];
 var app=A.initializeApp(C);
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
  sendEmailVerification:function(u){return Au.sendEmailVerification(u||a.currentUser)}};
 return {auth:auth,db:db}})();
 P.catch(function(){P=null});return P};
})();
