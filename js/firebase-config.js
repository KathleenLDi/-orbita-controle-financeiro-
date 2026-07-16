/* ==========================================================
   Órbita · Configuração do Firebase (projeto: orbita-fe72e)
   ----------------------------------------------------------
   Essas chaves NÃO são secretas — apenas identificam o
   projeto. A segurança vem das regras do Firestore.
   ========================================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyB9WNO71IsZReiVCmZmYo03lyKu0PNKQmw",
  authDomain: "orbita-fe72e.firebaseapp.com",
  projectId: "orbita-fe72e",
  storageBucket: "orbita-fe72e.firebasestorage.app",
  messagingSenderId: "949120841759",
  appId: "1:949120841759:web:f4146fd52cea3c9d2cfd2a",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
