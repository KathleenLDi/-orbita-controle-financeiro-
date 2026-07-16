/* ==========================================================
   Órbita · Autenticação (auth.js)
   Cadastro, login, logout, recuperação de senha e proteção
   de páginas. No cadastro, um espaço pessoal é criado.
   ========================================================== */

import { auth, db } from "./firebase-config.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
  onAuthStateChanged,
  updateProfile,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, setDoc, addDoc, collection, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export async function cadastrar(nome, email, senha) {
  const cred = await createUserWithEmailAndPassword(auth, email, senha);
  await updateProfile(cred.user, { displayName: nome });

  // Perfil e espaço pessoal. Se algo falhar aqui, tudo bem:
  // o app cria o espaço pessoal sozinho no primeiro acesso.
  try {
    await setDoc(doc(db, "usuarios", cred.user.uid), {
      nome,
      email: email.toLowerCase(),
      criadoEm: serverTimestamp(),
    });
    await addDoc(collection(db, "espacos"), {
      nome: "Meu espaço",
      tipo: "pessoal",
      dono: cred.user.uid,
      membros: [cred.user.uid],
      convites: [],
      criadoEm: serverTimestamp(),
    });
  } catch (err) {
    console.warn("Cadastro ok, mas a criação inicial falhou (o app se recupera sozinho):", err);
  }

  return cred.user;
}

export async function entrar(email, senha) {
  const cred = await signInWithEmailAndPassword(auth, email, senha);
  return cred.user;
}

export async function sair() {
  await signOut(auth);
  window.location.href = "login.html";
}

export async function recuperarSenha(email) {
  await sendPasswordResetEmail(auth, email);
}

/* Protege o index.html: sem login → login.html */
export function exigirLogin(callback) {
  onAuthStateChanged(auth, (user) => {
    if (!user) window.location.href = "login.html";
    else callback(user);
  });
}

/* No login.html: já logado → index.html */
export function redirecionarSeLogado() {
  onAuthStateChanged(auth, (user) => {
    if (user) window.location.href = "index.html";
  });
}

export function mensagemErro(err) {
  const map = {
    "auth/invalid-email": "E-mail inválido.",
    "auth/user-not-found": "Nenhuma conta encontrada com esse e-mail.",
    "auth/wrong-password": "Senha incorreta.",
    "auth/invalid-credential": "E-mail ou senha incorretos.",
    "auth/email-already-in-use": "Já existe uma conta com esse e-mail.",
    "auth/weak-password": "A senha precisa ter pelo menos 6 caracteres.",
    "auth/too-many-requests": "Muitas tentativas. Aguarde um pouco e tente novamente.",
    "auth/network-request-failed": "Falha de conexão. Verifique sua internet.",
  };
  return map[err?.code] || "Algo deu errado. Tente novamente.";
}
