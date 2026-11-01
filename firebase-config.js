/* Firebase-instellingen voor MIT Werkbonnen
   Vul hier de gegevens van JOUW Firebase-project in (zie INSTALLATIE.txt, stap "ACCOUNT EN ONLINE BACK-UP").
   Firebase console > Projectinstellingen (tandwieltje) > Algemeen > Jouw apps > Web-app > SDK-configuratie > "Config".
   Zolang apiKey met VUL_IN begint, werkt de app gewoon zonder account (zoals eerst). */
window.MIT_FIREBASE = {
  apiKey: "AIzaSyD1ZguEDLeMY-bnUG6blfWo0nlpneFKhUE",
  authDomain: "backup-loonlijst-werkbon-mit.firebaseapp.com",
  projectId: "backup-loonlijst-werkbon-mit",
  appId: "1:81998897599:web:c3646dc8a4eca739f3c10a",
  // e-mailadres van de beheerder (voor beheer.html); moet ook in de Firestore-regels staan
  adminEmail: "a.f.vanderhulst@gmail.com",
  // App Check: de reCAPTCHA v3-sitesleutel (zie INSTALLATIE.txt, "APP CHECK"). Leeg laten = uit.
  appCheckKey: ""
};
