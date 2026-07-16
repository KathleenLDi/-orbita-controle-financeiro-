/* ==========================================================
   Órbita · Camada de dados na nuvem (cloud-store.js)
   ----------------------------------------------------------
   Estrutura no Firestore:

     usuarios/{uid}
     espacos/{espacoId}            → nome, tipo, dono, membros[], convites[]
     espacos/{espacoId}/expenses/{id}
     espacos/{espacoId}/cards/{id}
     espacos/{espacoId}/incomes/{id}

   Os IDs dos documentos são os mesmos gerados pelo app
   (uid() do app.js) — isso preserva as referências
   metodo:'card:<id>' entre gastos e cartões.
   ========================================================== */

import { db, auth } from "./firebase-config.js";
import {
  collection, doc, addDoc, setDoc, updateDoc, deleteDoc, getDocs,
  query, where, onSnapshot, serverTimestamp,
  arrayUnion, arrayRemove, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const meuUid = () => auth.currentUser?.uid;
const meuEmail = () => (auth.currentUser?.email || "").toLowerCase();

/* Firestore não aceita undefined: troca por null */
function limpo(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = v === undefined ? null : v;
  return out;
}

/* =================== ESPAÇOS =================== */

export function ouvirMeusEspacos(callback, onErro) {
  const q = query(collection(db, "espacos"),
    where("membros", "array-contains", meuUid()));
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  }, (err) => { if (onErro) onErro(err); else console.error(err); });
}

export function ouvirMeusConvites(callback, onErro) {
  const q = query(collection(db, "espacos"),
    where("convites", "array-contains", meuEmail()));
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  }, (err) => { if (onErro) onErro(err); else console.error(err); });
}

export async function criarEspacoCompartilhado(nome) {
  const ref = await addDoc(collection(db, "espacos"), {
    nome,
    tipo: "compartilhado",
    dono: meuUid(),
    membros: [meuUid()],
    convites: [],
    criadoEm: serverTimestamp(),
  });
  return ref.id;
}

/* Espaço pessoal — usado no cadastro e como autocura quando
   uma conta é detectada sem nenhum espaço. */
export async function criarEspacoPessoal() {
  const ref = await addDoc(collection(db, "espacos"), {
    nome: "Meu espaço",
    tipo: "pessoal",
    dono: meuUid(),
    membros: [meuUid()],
    convites: [],
    criadoEm: serverTimestamp(),
  });
  return ref.id;
}

export async function convidarPorEmail(espacoId, email) {
  await updateDoc(doc(db, "espacos", espacoId), {
    convites: arrayUnion(email.toLowerCase().trim()),
  });
}

export async function aceitarConvite(espacoId) {
  await updateDoc(doc(db, "espacos", espacoId), {
    membros: arrayUnion(meuUid()),
    convites: arrayRemove(meuEmail()),
  });
}

export async function recusarConvite(espacoId) {
  await updateDoc(doc(db, "espacos", espacoId), {
    convites: arrayRemove(meuEmail()),
  });
}

export async function sairDoEspaco(espacoId) {
  await updateDoc(doc(db, "espacos", espacoId), {
    membros: arrayRemove(meuUid()),
  });
}

export async function renomearEspaco(espacoId, nome) {
  await updateDoc(doc(db, "espacos", espacoId), { nome });
}

export async function excluirEspaco(espacoId) {
  // Apaga os dados das três coleções e depois o espaço.
  const batch = writeBatch(db);
  for (const col of ["expenses", "cards", "incomes"]) {
    const snap = await getDocs(collection(db, "espacos", espacoId, col));
    snap.forEach((d) => batch.delete(d.ref));
  }
  batch.delete(doc(db, "espacos", espacoId));
  await batch.commit();
}

/* ============ DADOS (expenses | cards | incomes) ============ */

const col = (espacoId, nome) => collection(db, "espacos", espacoId, nome);

/* Escuta em tempo real. Retorna função para cancelar. */
export function ouvir(espacoId, colecao, callback, onErro) {
  return onSnapshot(col(espacoId, colecao), (snap) => {
    const lista = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
    // ordem estável: mais antigos primeiro
    lista.sort((a, b) => (a.criadoEm?.seconds || 0) - (b.criadoEm?.seconds || 0));
    callback(lista);
  }, (err) => {
    console.error(`Erro ao sincronizar ${colecao}:`, err);
    if (onErro) onErro(err);
  });
}

/* Cria mantendo o id gerado pelo app */
export async function salvarComId(espacoId, colecao, id, dados) {
  await setDoc(doc(db, "espacos", espacoId, colecao, id), limpo({
    ...dados,
    criadoPor: meuUid(),
    criadoEm: serverTimestamp(),
  }));
}

export async function editar(espacoId, colecao, id, dados) {
  await updateDoc(doc(db, "espacos", espacoId, colecao, id), limpo({
    ...dados,
    editadoPor: meuUid(),
    editadoEm: serverTimestamp(),
  }));
}

export async function excluir(espacoId, colecao, id) {
  await deleteDoc(doc(db, "espacos", espacoId, colecao, id));
}

/* Edita vários docs de uma vez (ex.: marcar fatura inteira paga) */
export async function editarLote(espacoId, colecao, itens) {
  const batch = writeBatch(db);
  for (const { id, dados } of itens) {
    batch.update(doc(db, "espacos", espacoId, colecao, id), limpo({
      ...dados,
      editadoPor: meuUid(),
      editadoEm: serverTimestamp(),
    }));
  }
  await batch.commit();
}

/* ============ MIGRAÇÃO / RESTAURAR BACKUP ============ */
/* Substitui TODO o conteúdo do espaço pelo estado dado
   ({incomes,cards,expenses} no formato do app), preservando
   os ids — inclusive as referências card:<id>. */
export async function substituirTudo(espacoId, estado) {
  const batch = writeBatch(db);
  const mapa = { expenses: estado.expenses, cards: estado.cards, incomes: estado.incomes };
  let total = 0;

  for (const [nome, lista] of Object.entries(mapa)) {
    // apaga o que existe
    const atual = await getDocs(col(espacoId, nome));
    atual.forEach((d) => batch.delete(d.ref));
    // grava o novo, mantendo os ids
    for (const item of lista || []) {
      const { id, ...dados } = item;
      batch.set(doc(db, "espacos", espacoId, nome, String(id)), limpo({
        ...dados,
        criadoPor: meuUid(),
        criadoEm: serverTimestamp(),
      }));
      total++;
    }
  }
  await batch.commit(); // limite de 500 operações por lote
  return total;
}
