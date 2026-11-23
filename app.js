import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY, ESTADOS, NAO_APLICAVEL, CONCLUIDO, CANCELADO, PROJETOS, POSCO } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $app = document.getElementById("app");
const FECHADOS = [CONCLUIDO, CANCELADO];
const ESTADOS_TAREFA = [...ESTADOS, NAO_APLICAVEL];

// =====================================================================
// Utilitários
// =====================================================================

// Cria um elemento: el("td", { class: "x", onclick: fn }, "texto", outroEl)
function el(tag, props = {}, ...filhos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "class") e.className = v;
    else if (k in e) e[k] = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const f of filhos.flat()) if (f !== null && f !== undefined && f !== false) e.append(f instanceof Node ? f : String(f));
  return e;
}

function avisar(msg) {
  const d = el("div", {}, msg);
  document.getElementById("toast").append(d);
  setTimeout(() => d.remove(), 3500);
}

const vazio = (v) => v === null || v === undefined || String(v).trim() === "";
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hoje = () => iso(new Date());
const paraDate = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const dias = (de, ate) => Math.round((paraDate(ate) - paraDate(de)) / 86400000);
const fmt = (s) => (s ? s.split("-").reverse().join("/") : "-");
const maisDias = (s, n) => { const d = paraDate(s); d.setDate(d.getDate() + n); return iso(d); };
// Data menos N meses (como o Luxon: 31/05 - 3 meses = 28/02)
function menosMeses(s, n) {
  const [y, m, d] = s.split("-").map(Number);
  const alvo = new Date(y, m - 1 - n, 1);
  const ultimo = new Date(alvo.getFullYear(), alvo.getMonth() + 1, 0).getDate();
  alvo.setDate(Math.min(d, ultimo));
  return iso(alvo);
}

function quando(data) {
  if (!data) return "Sem data";
  const n = dias(hoje(), data);
  if (n === 0) return "📍 Hoje";
  if (n === 1) return "Amanhã";
  if (n > 1) return `Daqui a ${n} dias`;
  return `⚠️ Há ${-n} dias`;
}

// =====================================================================
// Dados
// =====================================================================
let dados = { registos: [], porRegisto: new Map() };

// Lê uma tabela inteira (o Supabase devolve no máximo 1000 linhas por pedido)
async function tudo(tabela, colunas = "*") {
  const linhas = [];
  for (let de = 0; ; de += 1000) {
    const { data, error } = await sb.from(tabela).select(colunas).order("id").range(de, de + 999);
    if (error) throw error;
    linhas.push(...data);
    if (data.length < 1000) return linhas;
  }
}

async function carregar() {
  const [registos, tarefas] = await Promise.all([tudo("registos"), tudo("tarefas")]);
  const porRegisto = new Map();
  tarefas.sort((a, b) => a.ordem - b.ordem).forEach((t) => {
    if (!porRegisto.has(t.registo_id)) porRegisto.set(t.registo_id, []);
    porRegisto.get(t.registo_id).push(t);
  });
  dados = { registos, porRegisto };
}

const registo = (id) => dados.registos.find((r) => r.id === id);
const tarefasDe = (r) => dados.porRegisto.get(r.id) || [];
const proj = (r) => PROJETOS[r.projeto] || { nome: r.projeto, campos: [], obrigatorios: [], urs: [] };
const feita = (t) => [CONCLUIDO, NAO_APLICAVEL].includes(t.status);
const ativos = () => dados.registos.filter((r) => !r.arquivado && r.status !== CANCELADO);
const porData = (a, b) => (a.data || "9999").localeCompare(b.data || "9999");

function progresso(r) {
  const l = tarefasDe(r);
  return l.length ? `${l.filter(feita).length}/${l.length}` : "-";
}

// Status geral calculado pelas tarefas (igual ao Obsidian). null = não mexer.
function statusGeral(lista) {
  const s = lista.map((t) => t.status || "").filter((v) => !v.includes("Cancelado"));
  if (s.length === 0) return null;
  if (s.some((v) => v.includes("Bloqueado"))) return "🚧 Bloqueado";
  if (s.some((v) => v.includes("Pendente"))) return "⏸️ Pendente";
  if (s.every((v) => v.includes("Concluído") || v.includes("Não aplicável"))) return CONCLUIDO;
  if (s.some((v) => v.includes("Em curso") || v.includes("Concluído"))) return "🔄 Em curso";
  return null;
}

// O que falta para poder arquivar (Trabalhos em atraso)
function emFalta(r) {
  const p = proj(r);
  const falta = [];
  if (r.status !== CONCLUIDO) falta.push(`Status ainda "${r.status || "sem estado"}"`);
  p.obrigatorios.forEach(([campo, nome]) => vazio(r[campo]) && falta.push(`${nome} em falta`));
  const l = tarefasDe(r);
  const porFazer = l.filter((t) => !feita(t));
  if (porFazer.length) falta.push(`Checklist incompleta (${l.length - porFazer.length}/${l.length}): ${porFazer.map((t) => t.tarefa).join(", ")}`);
  if (p.respTarefas) {
    const semResp = l.filter((t) => vazio(t.responsavel)).length;
    if (semResp) falta.push(`Checklist sem responsável em ${semResp} tarefa(s)`);
  }
  return falta;
}

// Campos ainda vazios depois do prazo antes da data (ex.: UR Sistemas 3 meses antes)
function prazosFalhados(r) {
  if (!r.data || r.data < hoje()) return [];
  return (proj(r).prazos || [])
    .map(([[campo, nome], meses]) => ({ campo, nome, limite: menosMeses(r.data, meses) }))
    .filter((x) => vazio(r[x.campo]) && x.limite <= hoje());
}

// =====================================================================
// Gravar
// =====================================================================
async function gravarRegisto(r, valores) {
  const { error } = await sb.from("registos").update(valores).eq("id", r.id);
  if (error) { avisar(`Erro ao gravar: ${error.message}`); return false; }
  Object.assign(r, valores);
  agendar();
  return true;
}

async function gravarTarefa(r, t, valores) {
  const { error } = await sb.from("tarefas").update(valores).eq("id", t.id);
  if (error) return avisar(`Erro ao gravar: ${error.message}`);
  Object.assign(t, valores);
  if ("status" in valores && r.status !== CANCELADO) {
    const novo = statusGeral(tarefasDe(r));
    if (novo && novo !== r.status) await gravarRegisto(r, { status: novo });
  }
  agendar();
}

async function arquivar(r) {
  if (await gravarRegisto(r, { arquivado: true, data_conclusao: r.data_conclusao || hoje() })) avisar(`Loja ${r.loja} arquivada.`);
}

// =====================================================================
// Atualização automática (tempo real)
// Se alguém estiver a escrever num campo, espera que saia do campo.
// =====================================================================
let temporizador, pendente = false;
const aEditar = () => {
  const a = document.activeElement;
  return a && ["INPUT", "TEXTAREA", "SELECT"].includes(a.tagName) && $app.contains(a);
};
function agendar() {
  clearTimeout(temporizador);
  temporizador = setTimeout(async () => {
    if (aEditar()) { pendente = true; return; }
    await carregar();
    render();
  }, 500);
}
document.addEventListener("focusout", () =>
  setTimeout(() => { if (pendente && !aEditar()) { pendente = false; agendar(); } }, 50)
);

// =====================================================================
// Componentes
// =====================================================================
const linkLoja = (r) => el("a", { href: `#/registo/${r.id}` }, r.loja);
const tabela = (colunas, linhas) =>
  el("table", {}, el("thead", {}, el("tr", {}, colunas.map((c) => el("th", {}, c)))), el("tbody", {}, linhas));

function seletor(opcoes, atual, onchange) {
  const lista = atual && !opcoes.includes(atual) ? [atual, ...opcoes] : opcoes;
  const s = el("select", { onchange: () => onchange(s.value) }, !atual && el("option", { value: "" }, "—"), lista.map((o) => el("option", { value: o }, o)));
  s.value = atual || "";
  return s;
}

// Campo de um registo, conforme o tipo
function campo(r, [nome, titulo, tipo]) {
  let input;
  if (tipo === "status") input = seletor(ESTADOS, r.status, (v) => gravarRegisto(r, { status: v }));
  else if (tipo === "bool") {
    input = seletor(["✅ Sim", "❌ Não"], r[nome] === true ? "✅ Sim" : r[nome] === false ? "❌ Não" : "", (v) =>
      gravarRegisto(r, { [nome]: v === "" ? null : v === "✅ Sim" })
    );
  } else {
    input = el("input", { type: tipo === "date" ? "date" : "text", value: r[nome] ?? "" });
    input.onchange = () => {
      const v = input.value.trim() || null;
      if (tipo === "date" && nome === "data_conclusao" && v && v > hoje()) {
        input.value = r[nome] ?? "";
        return avisar("A data de conclusão não pode ser no futuro.");
      }
      gravarRegisto(r, { [nome]: v });
    };
  }
  return el("label", {}, titulo, input);
}

// =====================================================================
// Vistas
// =====================================================================
let vistaAtual = () => {};
async function render() {
  const y = window.scrollY;
  await vistaAtual();
  window.scrollTo(0, y);
}

// ---------- Dashboard ----------
// Caixas do dashboard: [nome, função, ocupa a largura toda]
const CARTOES = {
  novo: ["➕ Novo registo", cartaoNovo, true],
  ongoing: ["📅 Ongoing", cartaoOngoing],
  semur: ["🔖 Sem UR", cartaoSemUR],
  atraso: ["⚠️ Em atraso", cartaoAtraso],
};

// Preferências de cada pessoa: caixas escondidas, ordem e projetos escondidos em cada caixa.
// Guardadas no Supabase (tabela preferencias, supabase/preferencias.sql), iguais em qualquer PC.
// Há uma cópia no browser, usada se a tabela ainda não existir.
const CAIXAS_COM_PROJETOS = ["ongoing", "semur", "atraso"];
const chavePrefs = () => `lidl.dashboard.${sessaoAtual?.user?.email || ""}`;
let prefsGuardadas = null, prefsNoSupabase = true;

function limparPrefs(p) {
  const ordem = (p?.ordem || []).filter((k) => k in CARTOES);
  Object.keys(CARTOES).forEach((k) => !ordem.includes(k) && ordem.push(k)); // caixas novas vão para o fim
  const projetos = {};
  CAIXAS_COM_PROJETOS.forEach((k) => (projetos[k] = (p?.projetos?.[k] || []).filter((d) => d in PROJETOS)));
  return { ordem, ocultos: (p?.ocultos || []).filter((k) => k in CARTOES), projetos };
}

function prefsLocais() {
  try { return JSON.parse(localStorage.getItem(chavePrefs())); } catch { return null; } // estragadas: usa as de origem
}

async function carregarPrefs() {
  const local = prefsLocais();
  const { data, error } = await sb.from("preferencias").select("dashboard").maybeSingle();
  if (error) { prefsNoSupabase = false; prefsGuardadas = local; return; } // tabela ainda não criada
  prefsNoSupabase = true;
  if (data) prefsGuardadas = data.dashboard;
  else if (local) await gravarPrefs(limparPrefs(local)); // 1.ª vez: passa a escolha deste browser para o Supabase
}

async function gravarPrefs(p) {
  prefsGuardadas = p;
  localStorage.setItem(chavePrefs(), JSON.stringify(p));
  if (!prefsNoSupabase) return;
  const { error } = await sb.from("preferencias").upsert({ user_id: sessaoAtual.user.id, dashboard: p, atualizado_em: new Date().toISOString() });
  if (error) avisar(`Não foi possível guardar no Supabase (fica só neste browser): ${error.message}`);
}

const prefsDashboard = () => limparPrefs(prefsGuardadas);
// Filtro de uma caixa: tira os projetos que a pessoa escondeu nela
const naCaixa = (caixa) => {
  const escondidos = prefsDashboard().projetos[caixa] || [];
  return (r) => !escondidos.includes(r.projeto);
};
const notaFiltro = (caixa) => {
  const n = (prefsDashboard().projetos[caixa] || []).length;
  return n ? el("span", { class: "etiqueta", title: "Muda em ⚙️ Personalizar" }, `${n} projeto(s) escondido(s)`) : null;
};
let aPersonalizar = false;

function vistaDashboard() {
  const p = prefsDashboard();
  const visiveis = p.ordem.filter((k) => !p.ocultos.includes(k));
  $app.replaceChildren(
    el("div", { class: "linha-form", style: "justify-content:space-between" },
      el("h1", {}, "📋 Dashboard de Acompanhamento"),
      el("button", { onclick: () => { aPersonalizar = !aPersonalizar; vistaDashboard(); } }, aPersonalizar ? "✔️ Fechar" : "⚙️ Personalizar")),
    aPersonalizar && painelPersonalizar(p),
    visiveis.length === 0
      ? el("p", { class: "resumo" }, "Todas as caixas estão escondidas. Carrega em ⚙️ Personalizar para as mostrar.")
      : el("div", { class: "grelha" }, visiveis.map((k) => {
          const [, fazer, largo] = CARTOES[k];
          const c = fazer();
          if (largo) c.style.gridColumn = "1 / -1";
          return c;
        }))
  );
}

function painelPersonalizar(p) {
  const mudar = (fn) => { fn(); gravarPrefs(p); vistaDashboard(); }; // gravarPrefs muda as preferências logo, antes de esperar pelo Supabase
  const trocar = (i, j) => mudar(() => ([p.ordem[i], p.ordem[j]] = [p.ordem[j], p.ordem[i]]));
  const projetosDa = (k) => !CAIXAS_COM_PROJETOS.includes(k) ? el("span", { class: "resumo" }, "-")
    : el("div", { class: "chips" }, Object.entries(PROJETOS).map(([dir, pr]) =>
        el("label", { class: "chip" },
          el("input", { type: "checkbox", checked: !p.projetos[k].includes(dir), onchange: (e) =>
            mudar(() => (p.projetos[k] = e.target.checked ? p.projetos[k].filter((d) => d !== dir) : [...p.projetos[k], dir])) }),
          ` ${pr.nome}`)));
  return el("div", { class: "cartao", style: "margin-bottom:1rem" },
    el("h2", {}, "⚙️ Personalizar o dashboard"),
    el("p", { class: "resumo" }, prefsNoSupabase
      ? "Escolhe que caixas aparecem, em que ordem e que projetos mostra cada uma. Fica guardado na tua conta (igual em qualquer PC) e só muda o teu dashboard."
      : "⚠️ A tabela de preferências ainda não existe no Supabase (corre supabase/preferencias.sql): por agora fica guardado só neste browser."),
    tabela(["Mostrar", "Caixa", "Ordem", "Projetos"], p.ordem.map((k, i) =>
      el("tr", {},
        el("td", {}, el("input", { type: "checkbox", checked: !p.ocultos.includes(k), onchange: (e) =>
          mudar(() => (p.ocultos = e.target.checked ? p.ocultos.filter((x) => x !== k) : [...p.ocultos, k])) })),
        el("td", {}, CARTOES[k][0]),
        el("td", {},
          el("button", { title: "Subir", disabled: i === 0, onclick: () => trocar(i, i - 1) }, "⬆️"), " ",
          el("button", { title: "Descer", disabled: i === p.ordem.length - 1, onclick: () => trocar(i, i + 1) }, "⬇️")),
        el("td", {}, projetosDa(k))))),
    el("button", { class: "discreto", style: "margin-top:.5rem", onclick: () => { gravarPrefs({}); vistaDashboard(); } }, "↺ Repor como estava"));
}

function cartaoNovo() {
  const proj_ = seletor(Object.keys(PROJETOS), "", () => (tipo.hidden = !proj_.value || proj_.value !== "Trabalhos_Extras"));
  [...proj_.options].forEach((o) => o.value && (o.textContent = PROJETOS[o.value].nome));
  proj_.options[0].textContent = "— Projeto —";
  const loja = el("input", { type: "text", placeholder: "Nº da loja" });
  const data = el("input", { type: "date", value: hoje() });
  const tipo = el("input", { type: "text", placeholder: "Tipo de trabalho", hidden: true });
  const botao = el("button", { class: "cta" }, "➕ Criar registo");
  botao.onclick = async () => {
    const dir = proj_.value, n = loja.value.trim();
    if (!dir) return avisar("Escolhe o projeto.");
    if (!n) return avisar("Escreve o número da loja.");
    if (dados.registos.some((r) => r.projeto === dir && r.loja === n && !r.arquivado))
      return avisar(`A loja ${n} já existe em ${PROJETOS[dir].nome}.`);
    botao.disabled = true;
    try {
      const id = await criarRegisto(dir, n, data.value || hoje(), tipo.value.trim());
      avisar(`Loja ${n} criada em ${PROJETOS[dir].nome}.`);
      await carregar();
      location.hash = `#/registo/${id}`;
    } catch (e) {
      avisar(`Erro: ${e.message}`);
    } finally {
      botao.disabled = false;
    }
  };
  return el("div", { class: "cartao azul" }, el("h2", {}, "➕ Novo registo"), el("div", { class: "linha-form" }, proj_, loja, data, tipo, botao));
}

async function criarRegisto(dir, loja, data, tipo, extra = {}) {
  const novo = { projeto: dir, loja, data, ...extra };
  if (dir === "Trabalhos_Extras") novo.tipo_trabalho = tipo || null;
  const { data: r, error } = await sb.from("registos").insert(novo).select("id").single();
  if (error) throw error;

  const { data: modelo, error: e2 } = await sb.from("modelos_checklist").select("*").eq("projeto", dir).order("ordem");
  if (e2) throw e2;
  if (modelo.length) {
    const { error: e3 } = await sb.from("tarefas").insert(
      modelo.map((m) => ({ registo_id: r.id, ordem: m.ordem, fase: m.fase, tarefa: m.tarefa, responsavel: m.responsavel }))
    );
    if (e3) throw e3;
  }
  const posco = PROJETOS[dir].posco;
  if (posco) {
    const linhas = ["pos", "sco"].flatMap((tipo) => (posco[tipo] || []).map((numero, ordem) => ({ registo_id: r.id, tipo, ordem, numero })));
    const { error: e4 } = await sb.from("equipamentos").insert(linhas);
    if (e4) throw e4;
  }
  return r.id;
}

function cartaoOngoing() {
  // Só a semana atual (segunda a domingo), incluindo as lojas desta semana já concluídas
  const inicio = maisDias(hoje(), -((paraDate(hoje()).getDay() + 6) % 7)); // segunda-feira
  const limite = maisDias(inicio, 6); // domingo
  const lista = dados.registos
    .filter(naCaixa("ongoing"))
    .filter((r) => r.status !== CANCELADO && r.data && r.data >= inicio && r.data <= limite && (!r.arquivado || r.status === CONCLUIDO))
    .sort(porData);
  const detalhes = (r) =>
    [["ur_sistemas", "UR Sistemas"], ["ur_nagios", "UR Nagios"], ["ur", "UR"], ["pedido_zetes", "Pedido Zetes"]]
      .filter(([k]) => r[k]).map(([k, t]) => `${t}: ${r[k]}`).join(" · ") || "-";
  return el("div", { class: "cartao verde" },
    el("h2", {}, "📅 Ongoing – semana atual ", notaFiltro("ongoing")),
    el("p", { class: "resumo" }, `De segunda ${fmt(inicio)} a domingo ${fmt(limite)} · ${lista.length} trabalho(s)`),
    lista.length === 0
      ? el("p", {}, "Sem trabalhos nesta semana.")
      : tabela(["Data", "Quando", "Projeto", "Loja", "Status", "Detalhes", "Checklist"], lista.map((r) =>
          el("tr", {}, el("td", {}, fmt(r.data)), el("td", {}, r.status === CONCLUIDO ? "✅ Feito" : quando(r.data)), el("td", {}, proj(r).nome), el("td", {}, linkLoja(r)),
            el("td", {}, r.status), el("td", {}, detalhes(r)), el("td", {}, progresso(r)))))
  );
}

function cartaoAtraso() {
  const base = ativos().filter(naCaixa("atraso"));
  const atrasadas = base.filter((r) => r.data && r.data < hoje()).map((r) => ({ r, falta: emFalta(r), prazos: [] }));
  const antecipadas = base
    .map((r) => ({ r, prazos: prazosFalhados(r) }))
    .filter((x) => x.prazos.length)
    .map((x) => ({ ...x, falta: x.prazos.map((f) => `${f.nome} em falta (prazo ${fmt(f.limite)})`) }));
  const lista = [...atrasadas, ...antecipadas].sort((a, b) => porData(a.r, b.r));
  const prontas = atrasadas.filter((x) => x.falta.length === 0).length;

  return el("div", { class: "cartao vermelho" },
    el("h2", {}, "⚠️ Em atraso ", notaFiltro("atraso")),
    lista.length === 0
      ? el("p", {}, "✅ Não há trabalhos em atraso.")
      : [
          el("p", { class: "resumo" }, `${atrasadas.length} com a data ultrapassada · ${prontas} pronto(s) para arquivar · ${atrasadas.length - prontas} com coisas em falta · ${antecipadas.length} com prazos falhados antes da data`),
          tabela(["Projeto", "Loja", "Data", "Atraso", "O que falta", "Ação"], lista.map(({ r, falta, prazos }) => {
            const desde = prazos.length ? prazos.map((f) => f.limite).sort()[0] : r.data;
            const n = dias(desde, hoje());
            return el("tr", {},
              el("td", {}, proj(r).nome), el("td", {}, linkLoja(r)), el("td", {}, fmt(r.data)),
              el("td", {}, prazos.length ? `${n} dia(s) após o prazo` : `${n} dia(s)`),
              el("td", {}, falta.length ? el("ul", {}, falta.map((f) => el("li", {}, `⚠️ ${f}`))) : "✅ Tudo preenchido"),
              el("td", {}, falta.length === 0 && !prazos.length
                ? el("button", { class: "cta", onclick: () => arquivar(r) }, "📦 Arquivar")
                : el("button", { onclick: () => (location.hash = `#/registo/${r.id}`) }, "✏️ Abrir")));
          })),
        ]
  );
}

function cartaoSemUR() {
  const lista = ativos().filter(naCaixa("semur"))
    .filter((r) => r.data)
    .map((r) => ({ r, falta: (proj(r).semUr || []).filter(([c]) => vazio(r[c])) }))
    .filter((x) => x.falta.length)
    .sort((a, b) => porData(a.r, b.r));
  const passados = lista.filter((x) => x.r.data < hoje()).length;

  return el("div", { class: "cartao roxo" },
    el("h2", {}, "🔖 Sem UR ", notaFiltro("semur")),
    lista.length === 0
      ? el("p", {}, "✅ Todos os trabalhos em curso têm o UR Sistemas preenchido.")
      : [
          el("p", { class: "resumo" }, `${lista.length} trabalho(s) sem UR · ${passados} com a data já ultrapassada · escreve o UR e carrega Enter`),
          tabela(["Projeto", "Loja", "Data", "Quando", "Status", "URs em falta"], lista.map(({ r, falta }) =>
            el("tr", {},
              el("td", {}, proj(r).nome), el("td", {}, linkLoja(r)), el("td", {}, fmt(r.data)), el("td", {}, quando(r.data)), el("td", {}, r.status),
              el("td", {}, falta.map(([c, nome]) => {
                const i = el("input", { type: "text", placeholder: "preencher", style: "width:9em" });
                let gravado = false;
                const gravar = async () => {
                  const v = i.value.trim();
                  if (!v || gravado) return;
                  gravado = true;
                  if (await gravarRegisto(r, { [c]: v })) avisar(`${nome} da loja ${r.loja} gravado.`);
                };
                i.onkeydown = (e) => e.key === "Enter" && gravar();
                i.onblur = gravar;
                return el("div", {}, `⚠️ ${nome}: `, i);
              }))))),
        ]
  );
}

// ---------- Controlo de um projeto (ou Arquivo) ----------
let filtro = "";
function vistaProjeto(dir, arquivo) {
  const p = PROJETOS[dir];
  if (!p) return $app.replaceChildren(el("p", {}, "Projeto desconhecido."));
  const lista = dados.registos.filter((r) => r.projeto === dir && !!r.arquivado === arquivo).sort(porData);

  const corpo = lista.map((r) => {
    const linha = el("tr", { "data-busca": [r.loja, r.status, r.responsavel, r.ur_sistemas, r.ur_nagios, r.ur, r.tipo_trabalho].join(" ").toLowerCase() },
      el("td", {}, linkLoja(r)),
      el("td", {}, arquivo ? fmt(r.data) : campo(r, ["data", "", "date"]).lastChild),
      el("td", {}, arquivo ? r.status : seletor(ESTADOS, r.status, (v) => gravarRegisto(r, { status: v }))),
      el("td", {}, p.urs.map(([c, nome]) => el("div", {}, `${nome}: `, r[c] || el("span", { class: "etiqueta" }, "em falta")))),
      el("td", {}, r.responsavel || "-"),
      el("td", {}, progresso(r)),
      el("td", {}, arquivo
        ? [`Concluído a ${fmt(r.data_conclusao)} `, el("button", { onclick: () => gravarRegisto(r, { arquivado: false }) }, "↩️ Reabrir")]
        : r.status === CONCLUIDO && el("button", { class: "cta", onclick: () => arquivar(r) }, "📦 Arquivar"))
    );
    return linha;
  });
  const aplicarFiltro = () => corpo.forEach((l) => (l.hidden = filtro && !l.dataset.busca.includes(filtro)));
  const busca = el("input", { type: "text", placeholder: "🔎 Filtrar (loja, status, UR…)", value: filtro, oninput: () => { filtro = busca.value.toLowerCase().trim(); aplicarFiltro(); } });
  aplicarFiltro();

  const aImportar = !arquivo && importacao?.dir === dir;
  $app.replaceChildren(
    el("h1", {}, `${p.nome} – ${arquivo ? "Arquivo" : "Controlo"}`),
    aImportar && cartaoImportar(dir),
    el("div", { class: "cartao" },
      el("div", { class: "linha-form", style: "margin-bottom:.6rem" }, busca,
        el("span", { class: "resumo" }, `${lista.length} registo(s)`),
        el("a", { href: arquivo ? `#/projeto/${dir}` : `#/arquivo/${dir}` }, arquivo ? "← Voltar ao Controlo" : "📦 Ver arquivo"),
        !arquivo && el("button", { onclick: () => { importacao = aImportar ? null : { dir }; render(); } }, aImportar ? "✖ Fechar importação" : "📥 Importar CSV")),
      tabela(["Loja", "Data", "Status", "URs", "Responsável", "Checklist", ""], corpo))
  );
}

// ---------- Importar CSV (Controlo de um projeto; só existe com login) ----------
// Igual ao Validar Excel do Obsidian: lojas que não existem são criadas a partir do modelo;
// nas que existem, a data é corrigida se for diferente. Canceladas/concluídas no CSV são ignoradas.
let importacao = null; // { dir, nome, linhas, titulos, colLoja, colData, colStatus, ignorar }
const SEM_DATA = "⏸️ Pendente";

function linhasCsv(texto) {
  texto = texto.replace(/^﻿/, "");
  const primeira = texto.split(/\r?\n/)[0] || "";
  const sep = (primeira.match(/;/g) || []).length > (primeira.match(/,/g) || []).length ? ";" : ",";
  const linhas = [];
  let linha = [], campo = "", aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      if (c === '"') {
        if (texto[i + 1] === '"') { campo += '"'; i++; } else aspas = false;
      } else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === sep) { linha.push(campo.trim()); campo = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && texto[i + 1] === "\n") i++;
      linha.push(campo.trim());
      linhas.push(linha);
      linha = [];
      campo = "";
    } else campo += c;
  }
  if (campo || linha.length) { linha.push(campo.trim()); linhas.push(linha); }
  return linhas;
}

const eLoja = (v) => /^\d{1,5}$/.test(String(v ?? "").trim().replace(/\.0+$/, ""));
function normalizarLoja(v) {
  const n = String(v ?? "").trim().replace(/\.0+$/, "");
  return /^\d+$/.test(n) ? n.padStart(4, "0") : n;
}

const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
// mesPrimeiro = true para datas mês/dia/ano (ex.: CSV do ST)
function normalizarData(v, mesPrimeiro = false) {
  const t = String(v ?? "").trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) {
    // Número de série de data do Excel
    const d = new Date(Math.round((Number(t) - 25569) * 86400 * 1000));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  // Mês por extenso, com ou sem ano: "17/Dezembro", "09/Dez", "17 de dezembro de 2026"
  let m = t.match(/^(\d{1,2})\s*(?:[\/\-.]|\s+de\s+|\s)\s*([a-zà-ú]{3,})\.?(?:\s*(?:[\/\-.]|\s+de\s+|\s)\s*(\d{4}))?/i);
  if (m) {
    const mes = MESES.indexOf(m[2].toLowerCase().slice(0, 3));
    if (mes < 0) return null;
    const dia = Number(m[1]);
    let ano = m[3] ? Number(m[3]) : new Date().getFullYear();
    if (!m[3] && Date.now() - new Date(ano, mes, dia).getTime() > 60 * 86400 * 1000) ano++;
    return `${ano}-${pad(mes + 1)}-${pad(dia)}`;
  }
  m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (m) {
    const [dia, mes] = mesPrimeiro ? [m[2], m[1]] : [m[1], m[2]];
    return `${m[3]}-${pad(mes)}-${pad(dia)}`;
  }
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

async function lerCsv(dir, ficheiro) {
  const buf = await ficheiro.arrayBuffer();
  let texto;
  try { texto = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { texto = new TextDecoder("windows-1252").decode(buf); }
  const linhas = linhasCsv(texto).filter((l) => l.some((c) => c !== ""));
  if (!linhas.length) return avisar("O ficheiro está vazio.");

  // Cabeçalho: linhas antes da 1.ª loja. Loja na coluna "Loja", senão na 1.ª.
  const procura = (cab, re) => (cab ? cab.findIndex((c) => re.test(String(c ?? "").trim())) : -1);
  const cabLoja = linhas.find((l) => l.some((c) => /^(n\.?º\s*)?loja/i.test(c)));
  const colLoja = Math.max(procura(cabLoja, /^(n\.?º\s*)?loja/i), 0);
  const iPrimeira = Math.max(linhas.findIndex((l) => eLoja(l[colLoja])), 0);
  const antes = linhas.slice(0, iPrimeira).reverse();
  const cabData = antes.find((l) => l.some((c) => /data/i.test(c)));
  const colData = [/data\s*(de\s*)?abertura/i, /data\s+de\s+interven/i, /data/i].map((re) => procura(cabData, re)).find((i) => i >= 0) ?? -1;
  const cabStatus = antes.find((l) => l.some((c) => /^(status|estado)$/i.test(c)));
  const colStatus = procura(cabStatus, /^(status|estado)$/i);

  const cab = antes.find((l) => l.filter(Boolean).length > 1) || [];
  const nCol = Math.max(...linhas.map((l) => l.length));
  const titulos = Array.from({ length: nCol }, (_, i) => `${i + 1}. ${cab[i] || "(sem título)"}`);
  importacao = { dir, nome: ficheiro.name, linhas, titulos, colLoja, colData, colStatus, ignorar: new Set() };
}

// O que fazer com cada loja do CSV
function analisarCsv(imp) {
  const mesPrimeiro = imp.colData >= 0 && imp.linhas.some((l) => {
    const m = String(l[imp.colData] ?? "").trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.]\d{4}/);
    return m && Number(m[2]) > 12;
  });
  const doProjeto = dados.registos.filter((r) => r.projeto === imp.dir);
  const vistas = new Set();
  const res = [];
  imp.linhas.forEach((l) => {
    if (!eLoja(l[imp.colLoja])) return;
    const loja = normalizarLoja(l[imp.colLoja]);
    if (vistas.has(loja)) return;
    vistas.add(loja);
    const bruto = imp.colData >= 0 ? String(l[imp.colData] ?? "").trim() : "";
    const data = bruto ? normalizarData(bruto, mesPrimeiro) : null;
    const tem = (re, exato) => (imp.colStatus >= 0 ? re.test(String(l[imp.colStatus] ?? "")) : l.some((c) => exato.test(c.trim())));
    const iguais = doProjeto.filter((r) => normalizarLoja(r.loja) === loja);
    const r = iguais.find((x) => !x.arquivado && x.status !== CANCELADO) || iguais[0];
    const x = { loja, data, r, acao: "ok", detalhe: "" };
    if (bruto && !data) Object.assign(x, { acao: "erro", detalhe: `Data não reconhecida: "${bruto}"` });
    else if (tem(/cancel/i, /^cancelad[oa]s?$/i)) Object.assign(x, { acao: "ignorar", detalhe: "Cancelada no CSV" });
    else if (tem(/^\s*conclu[íi]d[oa]\s*$/i, /^conclu[íi]d[oa]$/i)) Object.assign(x, { acao: "ignorar", detalhe: "Concluída no CSV" });
    else if (!r) {
      if (data && data < hoje()) Object.assign(x, { acao: "ignorar", detalhe: "Não existe e a data já passou" });
      else Object.assign(x, { acao: "criar", detalhe: data ? "Nova loja" : `Nova loja sem data (fica ${SEM_DATA})` });
    } else if (r.arquivado) x.detalhe = "Já está no arquivo (não mexe)";
    else if (r.status === CANCELADO) x.detalhe = "Cancelada no site (não mexe)";
    else if (!data) x.detalhe = "Sem data no CSV (não mexe)";
    else if (r.data === data) x.detalhe = "Data certa";
    else Object.assign(x, { acao: "data", detalhe: `${fmt(r.data)} → ${fmt(data)}` });
    res.push(x);
  });
  return res;
}

function cartaoImportar(dir) {
  const imp = importacao;
  const ficheiro = el("input", { type: "file", accept: ".csv,text/csv" });
  ficheiro.onchange = async () => {
    const f = ficheiro.files[0];
    if (!f) return;
    try { await lerCsv(dir, f); } catch (e) { avisar(`Erro a ler o CSV: ${e.message}`); }
    render();
  };
  const partes = [
    el("h2", {}, "📥 Importar CSV"),
    el("p", { class: "resumo" }, "Lojas que não existem são criadas com a checklist do modelo; nas que já existem, a data é corrigida se for diferente. Nada é gravado antes de carregares em Confirmar."),
    el("div", { class: "linha-form" }, ficheiro, imp.nome && el("span", { class: "etiqueta" }, imp.nome)),
  ];
  if (imp.linhas) {
    const coluna = (chave, comNenhuma) => {
      const s = el("select", { onchange: () => { imp[chave] = Number(s.value); render(); } },
        comNenhuma && el("option", { value: "-1" }, "— nenhuma —"), imp.titulos.map((t, i) => el("option", { value: String(i) }, t)));
      s.value = String(imp[chave]);
      return s;
    };
    const res = analisarCsv(imp);
    const ROTULO = { criar: "➕ Criar", data: "✏️ Mudar data", ok: "✔️ Sem mudanças", ignorar: "⏭️ Ignorada", erro: "⚠️ Erro" };
    const grava = (x) => ["criar", "data"].includes(x.acao);
    const aGravar = res.filter((x) => grava(x) && !imp.ignorar.has(x.loja));

    const confirmar = el("button", { class: "cta", disabled: aGravar.length === 0 }, `✅ Confirmar (${aGravar.length})`);
    confirmar.onclick = async () => {
      confirmar.disabled = true;
      confirmar.textContent = "A gravar…";
      let criadas = 0, mudadas = 0;
      const erros = [];
      for (const x of aGravar) {
        try {
          if (x.acao === "criar") {
            await criarRegisto(dir, x.loja, x.data, "", x.data ? {} : { status: SEM_DATA });
            criadas++;
          } else {
            // Estava pendente só por falta de data: passa a por iniciar (como no Obsidian)
            const extra = vazio(x.r.data) && x.r.status === SEM_DATA ? { status: "⏳ Por iniciar" } : {};
            const { error } = await sb.from("registos").update({ data: x.data, ...extra }).eq("id", x.r.id);
            if (error) throw error;
            mudadas++;
          }
        } catch (e) {
          erros.push(`${x.loja}: ${e.message}`);
        }
      }
      importacao = null;
      await carregar();
      render();
      avisar(`Importação: ${criadas} loja(s) criada(s), ${mudadas} data(s) corrigida(s)${erros.length ? `, ${erros.length} com erro` : ""}.`);
      if (erros.length) alert(`Lojas com erro:\n- ${erros.join("\n- ")}`);
    };

    partes.push(
      el("div", { class: "linha-form", style: "margin:.6rem 0" },
        "Coluna da loja:", coluna("colLoja", false), "Coluna da data:", coluna("colData", true), "Coluna do estado:", coluna("colStatus", true)),
      el("p", { class: "resumo" }, Object.entries(ROTULO).map(([a, t]) => `${t}: ${res.filter((x) => x.acao === a).length}`).join(" · ")),
      res.length === 0
        ? el("p", {}, "Não encontrei números de loja na coluna escolhida.")
        : tabela(["", "Loja", "Data no CSV", "Data no site", "Ação", "Detalhe"], res.map((x) =>
            el("tr", {},
              el("td", {}, grava(x) && el("input", { type: "checkbox", title: "Desmarca para não gravar esta loja", checked: !imp.ignorar.has(x.loja),
                onchange: (e) => { if (e.target.checked) imp.ignorar.delete(x.loja); else imp.ignorar.add(x.loja); render(); } })),
              el("td", {}, x.r ? linkLoja(x.r) : x.loja),
              el("td", {}, fmt(x.data)),
              el("td", {}, x.r ? fmt(x.r.data) : "-"),
              el("td", {}, ROTULO[x.acao]),
              el("td", {}, x.detalhe)))),
      el("div", { class: "linha-form", style: "margin-top:.6rem" }, confirmar,
        el("button", { onclick: () => { importacao = null; render(); } }, "Cancelar")));
  }
  return el("div", { class: "cartao laranja", style: "margin-bottom:1rem" }, partes);
}

// ---------- Um registo ----------
async function vistaRegisto(id) {
  const r = registo(id);
  if (!r) return $app.replaceChildren(el("p", {}, "Registo não encontrado (pode ter sido apagado)."), el("a", { href: "#/" }, "← Dashboard"));
  const p = proj(r);

  const [{ data: equip }, { data: hist }] = await Promise.all([
    p.posco ? sb.from("equipamentos").select("*").eq("registo_id", id).order("ordem") : Promise.resolve({ data: [] }),
    sb.from("historico").select("*").eq("registo_id", id).order("quando", { ascending: false }).limit(30),
  ]);
  if (location.hash !== `#/registo/${id}`) return; // mudou de página entretanto

  const notas = el("textarea", { value: r.notas || "" });
  notas.onchange = () => gravarRegisto(r, { notas: notas.value });

  const falta = emFalta(r);
  const acoes = el("div", { class: "linha-form" },
    r.arquivado
      ? el("button", { onclick: () => gravarRegisto(r, { arquivado: false }) }, "↩️ Reabrir (tirar do arquivo)")
      : el("button", {
          class: falta.length ? "" : "cta",
          onclick: () => (falta.length === 0 || confirm(`Ainda falta:\n- ${falta.join("\n- ")}\n\nArquivar mesmo assim?`)) && arquivar(r),
        }, "📦 Arquivar"),
    el("button", {
      class: "discreto",
      onclick: async () => {
        if (!confirm(`Apagar a loja ${r.loja} de ${p.nome}? Não dá para desfazer.`)) return;
        const { error } = await sb.from("registos").delete().eq("id", r.id);
        if (error) return avisar(`Erro: ${error.message}`);
        avisar(`Loja ${r.loja} apagada.`);
        await carregar();
        location.hash = `#/projeto/${r.projeto}`;
      },
    }, "🗑️ Apagar registo"),
    r.atualizado_por && el("span", { class: "resumo" }, `Última alteração: ${r.atualizado_por}, ${new Date(r.atualizado_em).toLocaleString("pt-PT")}`)
  );

  $app.replaceChildren(
    el("p", {}, el("a", { href: `#/${r.arquivado ? "arquivo" : "projeto"}/${r.projeto}` }, `← ${p.nome}`)),
    el("h1", {}, `Loja ${r.loja} – ${p.nome}`, r.arquivado && " ", r.arquivado && el("span", { class: "etiqueta" }, "📦 Arquivado")),
    el("div", { class: "cartao" }, el("div", { class: "campos" }, p.campos.map((c) => campo(r, c))), el("div", { style: "margin-top:.8rem" }, acoes)),
    el("div", { class: "cartao verde", style: "margin-top:1rem" }, el("h2", {}, `✅ Checklist (${progresso(r)})`), checklist(r)),
    p.posco ? el("div", { class: "cartao azul", style: "margin-top:1rem" }, posco(r, equip || [])) : "",
    el("div", { class: "cartao", style: "margin-top:1rem" }, el("h2", {}, "📝 Notas"), notas),
    el("div", { class: "cartao", style: "margin-top:1rem" }, el("h2", {}, "🕓 Histórico"), historico(hist || []))
  );
}

function checklist(r) {
  const lista = tarefasDe(r);
  if (lista.length === 0) return el("p", {}, "Este registo não tem checklist.");
  const comResp = proj(r).respTarefas;
  const colunas = ["Tarefa", comResp && "Responsável", "Status", "Notas"].filter(Boolean);
  const linhas = [];
  let faseAtual = null;
  lista.forEach((t) => {
    if (t.fase && t.fase !== faseAtual) {
      faseAtual = t.fase;
      const daFase = lista.filter((x) => x.fase === t.fase);
      linhas.push(el("tr", { class: "fase" }, el("td", { colSpan: colunas.length }, `${t.fase} (${daFase.filter(feita).length}/${daFase.length})`)));
    }
    const texto = (c) => {
      const i = el("input", { type: "text", value: t[c] || "", style: "width:100%" });
      i.onchange = () => gravarTarefa(r, t, { [c]: i.value.trim() });
      return el("td", {}, i);
    };
    linhas.push(el("tr", {},
      el("td", {}, t.tarefa),
      comResp && texto("responsavel"),
      el("td", {}, seletor(ESTADOS_TAREFA, t.status, (v) => gravarTarefa(r, t, { status: v }))),
      texto("notas")));
  });
  return tabela(colunas, linhas);
}

function posco(r, equip) {
  const alterar = async (fn) => { const { error } = await fn(); if (error) avisar(`Erro: ${error.message}`); agendar(); };
  return ["pos", "sco"].map((tipo) => {
    const g = POSCO[tipo];
    const lista = equip.filter((e) => e.tipo === tipo);
    return el("div", { style: "margin-bottom:1rem" },
      el("h2", {}, `${g.titulo} (${lista.filter((e) => e.instalado).length}/${lista.length} instalados)`),
      tabela(["Número", ...g.colunas.map((c) => c[1]), ""], lista.map((e) => {
        const num = el("input", { type: "text", value: e.numero || "", style: "width:5em" });
        num.onchange = () => alterar(() => sb.from("equipamentos").update({ numero: num.value.trim() }).eq("id", e.id));
        return el("tr", {},
          el("td", {}, num),
          g.colunas.map(([c]) => {
            const cx = el("input", { type: "checkbox", checked: e[c] === true });
            cx.onchange = () => alterar(() => sb.from("equipamentos").update({ [c]: cx.checked }).eq("id", e.id));
            return el("td", {}, cx);
          }),
          el("td", {}, el("button", { title: "Retirar esta linha", onclick: () => alterar(() => sb.from("equipamentos").delete().eq("id", e.id)) }, "✖")));
      })),
      el("button", {
        style: "margin-top:.4rem",
        onclick: () => alterar(() => sb.from("equipamentos").insert({ registo_id: r.id, tipo, ordem: lista.length ? Math.max(...lista.map((e) => e.ordem)) + 1 : 0 })),
      }, `➕ Acrescentar ${tipo.toUpperCase()}`));
  });
}

const IGNORAR = ["atualizado_em", "atualizado_por", "criado_em", "id", "registo_id"];
function historico(hist) {
  if (hist.length === 0) return el("p", { class: "resumo" }, "Sem alterações registadas.");
  return tabela(["Quando", "Quem", "O quê"], hist.map((h) => {
    let oque;
    if (h.acao === "INSERT") oque = "Criou o registo";
    else if (h.acao === "DELETE") oque = "Apagou";
    else {
      const mud = Object.keys(h.depois || {}).filter((k) => !IGNORAR.includes(k) && JSON.stringify(h.antes?.[k]) !== JSON.stringify(h.depois[k]));
      const prefixo = h.tabela === "tarefas" ? `Tarefa "${h.depois.tarefa}": ` : "";
      oque = prefixo + (mud.map((k) => `${k}: ${h.antes?.[k] ?? "—"} → ${h.depois[k] ?? "—"}`).join(" · ") || "sem mudanças visíveis");
    }
    return el("tr", {}, el("td", {}, new Date(h.quando).toLocaleString("pt-PT")), el("td", {}, h.quem), el("td", {}, oque));
  }));
}

// ---------- Vista do cliente (aberta, sem login) ----------
// Sem login lê só a função painel_cliente() (supabase/cliente.sql): sem telemóvel, IP, responsáveis nem notas do registo.
const GRUPOS = [
  ["🔄 Em curso", (s) => s.includes("Em curso"), "#3b82f6"],
  ["⏳ Por iniciar", (s) => s.includes("Por iniciar"), "#9ca3af"],
  ["⚠️ Pendentes / Bloqueadas", (s) => s.includes("Pendente") || s.includes("Bloqueado"), "#f59e0b"],
  ["✅ Concluídas", (s) => s === CONCLUIDO, "#22c55e"],
];
const corEstado = (s) => (GRUPOS.find(([, f]) => f(s || "")) || [0, 0, "#9ca3af"])[2];
const comBolinha = (s) => el("span", {}, el("span", { style: `color:${corEstado(s)}` }, "● "), s || "-");
const urs = (r) =>
  [["ur_sistemas", "UR Sistemas"], ["ur_nagios", "UR Nagios"], ["ur", "UR"], ["pedido_zetes", "Pedido Zetes"]]
    .filter(([k]) => r[k]).map(([k, t]) => `${t}: ${r[k]}`);

let equipCliente = new Map();
let sessaoAtual = null, clienteCarregado = false, clienteEm = null, cliProjeto = "", cliBusca = "";

async function carregarCliente() {
  const { data, error } = await sb.rpc("painel_cliente");
  if (error) throw error;
  const porRegisto = new Map();
  (data.tarefas || []).forEach((t) => {
    if (!porRegisto.has(t.registo_id)) porRegisto.set(t.registo_id, []);
    porRegisto.get(t.registo_id).push(t);
  });
  dados = { registos: data.registos || [], porRegisto };
  equipCliente = new Map();
  (data.equipamentos || []).forEach((e) => {
    if (!equipCliente.has(e.registo_id)) equipCliente.set(e.registo_id, []);
    equipCliente.get(e.registo_id).push(e);
  });
  clienteCarregado = true;
  clienteEm = data.gerado_em;
}

async function atualizarCliente() {
  try {
    if (sessaoAtual) await carregar(); else await carregarCliente();
    if (sessaoAtual) clienteEm = new Date().toISOString();
    vistaCliente();
  } catch (e) {
    avisar(`Erro a atualizar: ${e.message}`);
  }
}

function barra(r) {
  const l = tarefasDe(r);
  if (!l.length) return "-";
  const pct = Math.round((l.filter(feita).length / l.length) * 100);
  return el("span", { class: "progresso", title: `${pct}%` }, el("span", { class: "barra" }, el("span", { style: `width:${pct}%` })), ` ${progresso(r)}`);
}

const botaoPdf = (r) => el("button", { title: "Descarregar a checklist em PDF", onclick: (e) => pdfChecklist(r, e.currentTarget) }, "⬇️ PDF");

async function vistaCliente() {
  document.getElementById("topo").hidden = !sessaoAtual;
  if (!sessaoAtual && !clienteCarregado) {
    $app.replaceChildren(el("p", { class: "aviso" }, "A carregar…"));
    try {
      await carregarCliente();
    } catch (e) {
      return $app.replaceChildren(el("p", {}, `Erro a ler os dados: ${e.message}`), el("a", { href: "#/login" }, "🔐 Entrar (equipa)"));
    }
  }
  const regs = dados.registos.filter((r) => r.status !== CANCELADO);
  const ativas = regs.filter((r) => !r.arquivado && r.status !== CONCLUIDO);
  const ha30 = maisDias(hoje(), -30);
  const concluidas = regs.filter((r) => r.status === CONCLUIDO);
  const recentes = concluidas.filter((r) => (r.data_conclusao || r.data || "") >= ha30);
  const conta = (lista, i) => lista.filter((r) => GRUPOS[i][1](r.status || "")).length;
  const numero = (n, cor) => el("b", { style: `color:${cor}` }, n);

  const tiles = el("div", { class: "tiles" },
    el("div", { class: "tile" }, el("span", {}, "🏬 Lojas ativas"), el("b", {}, ativas.length)),
    GRUPOS.slice(0, 3).map(([nome, , cor], i) => el("div", { class: "tile" }, el("span", {}, nome), numero(conta(ativas, i), cor))),
    el("div", { class: "tile" }, el("span", {}, "✅ Concluídas (30 dias)"), numero(recentes.length, GRUPOS[3][2])));

  const porProjeto = tabela(["Projeto", "Ativas", ...GRUPOS.slice(0, 3).map((g) => g[0]), "✅ Concluídas (30 dias)"],
    Object.entries(PROJETOS).map(([dir, p]) => {
      const a = ativas.filter((r) => r.projeto === dir);
      return el("tr", {},
        el("td", {}, el("a", { href: "#/cliente", onclick: async (e) => {
          e.preventDefault();
          cliProjeto = dir;
          await vistaCliente();
          document.getElementById("lojas")?.scrollIntoView({ behavior: "smooth" });
        } }, p.nome)),
        el("td", {}, a.length),
        GRUPOS.slice(0, 3).map(([, , cor], i) => el("td", {}, numero(conta(a, i), cor))),
        el("td", {}, numero(recentes.filter((r) => r.projeto === dir).length, GRUPOS[3][2])));
    }));

  const limite = maisDias(hoje(), 14);
  const ongoing = ativas.filter((r) => r.data && r.data >= hoje() && r.data <= limite).sort(porData);

  $app.replaceChildren(
    el("div", { class: "linha-form", style: "justify-content:space-between;margin-bottom:.6rem" },
      el("h1", { style: "margin:0" }, "🏪 Lidl – Estado dos Projetos"),
      el("div", { class: "linha-form" },
        el("span", { class: "resumo", style: "margin:0" }, `Atualizado: ${new Date(clienteEm || Date.now()).toLocaleString("pt-PT")} · Winprovit`),
        el("button", { onclick: atualizarCliente }, "🔄 Atualizar"),
        sessaoAtual ? el("a", { href: "#/" }, "← Dashboard") : el("a", { href: "#/login", class: "botao" }, "🔐 Entrar (equipa)"))),
    el("div", { class: "cartao azul" }, el("h2", {}, "📈 Resumo"), tiles, porProjeto),
    el("div", { class: "cartao verde", style: "margin-top:1rem" },
      el("h2", {}, "📅 Ongoing"),
      el("p", { class: "resumo" }, `De ${fmt(hoje())} a ${fmt(limite)} · ${ongoing.length} trabalho(s)`),
      ongoing.length === 0
        ? el("p", {}, "Sem trabalhos planeados para as próximas 2 semanas.")
        : tabela(["Data", "Quando", "Projeto", "Loja", "Estado", "Progresso", "Checklist"], ongoing.map((r) =>
            el("tr", {}, el("td", {}, fmt(r.data)), el("td", {}, quando(r.data)), el("td", {}, proj(r).nome), el("td", {}, el("b", {}, r.loja)),
              el("td", {}, comBolinha(r.status)), el("td", {}, barra(r)), el("td", {}, botaoPdf(r)))))),
    cartaoLojasCliente(ativas, concluidas)
  );
}

function cartaoLojasCliente(ativas, concluidas) {
  const filtra = (lista) => lista.filter((r) => (!cliProjeto || r.projeto === cliProjeto) && (!cliBusca || String(r.loja).toLowerCase().includes(cliBusca)));
  const cartao = el("div", { class: "cartao", id: "lojas", style: "margin-top:1rem" });
  const desenhar = () => {
    const a = filtra(ativas).sort(porData);
    const c = filtra(concluidas).sort((x, y) => (y.data_conclusao || y.data || "").localeCompare(x.data_conclusao || x.data || ""));
    corpo.replaceChildren(
      el("h2", { style: "margin-top:1rem" }, `🏬 Lojas ativas (${a.length})`),
      a.length === 0 ? el("p", { class: "resumo" }, "Nenhuma loja.") :
        tabela(["Projeto", "Loja", "Data", "Estado", "Progresso", "URs", "Checklist"], a.map((r) =>
          el("tr", {}, el("td", {}, proj(r).nome), el("td", {}, el("b", {}, r.loja)), el("td", {}, fmt(r.data)), el("td", {}, comBolinha(r.status)),
            el("td", {}, barra(r)), el("td", {}, urs(r).map((u) => el("div", {}, u))), el("td", {}, botaoPdf(r))))),
      el("h2", { style: "margin-top:1.2rem" }, `✅ Concluídas (${c.length})`),
      c.length === 0 ? el("p", { class: "resumo" }, "Nenhuma loja.") :
        tabela(["Projeto", "Loja", "Data", "Data conclusão", "URs", "Checklist"], c.map((r) =>
          el("tr", {}, el("td", {}, proj(r).nome), el("td", {}, el("b", {}, r.loja)), el("td", {}, fmt(r.data)), el("td", {}, fmt(r.data_conclusao)),
            el("td", {}, urs(r).map((u) => el("div", {}, u))), el("td", {}, botaoPdf(r)))))
    );
  };
  const chips = el("div", { class: "chips" },
    [["", "Todos"], ...Object.entries(PROJETOS).map(([dir, p]) => [dir, p.nome])].map(([dir, nome]) =>
      el("button", { class: cliProjeto === dir ? "ativo" : "", onclick: (e) => {
        cliProjeto = dir;
        chips.querySelectorAll("button").forEach((b) => b.classList.toggle("ativo", b === e.currentTarget));
        desenhar();
      } }, nome)));
  const busca = el("input", { type: "text", placeholder: "🔎 Nº da loja", value: cliBusca, oninput: () => { cliBusca = busca.value.toLowerCase().trim(); desenhar(); } });
  const corpo = el("div");
  cartao.append(el("h2", {}, "🔎 Lojas e checklists"), el("div", { class: "linha-form" }, chips, busca), corpo);
  desenhar();
  return cartao;
}

// PDF da checklist de uma loja (jsPDF, carregado só quando é preciso).
// As fontes base do PDF não têm emojis: ficam de fora, os acentos mantêm-se.
const latin = (s) => String(s ?? "").replace(/[–—]/g, "-").replace(/[^\x00-\xFF]/g, "").replace(/\s+/g, " ").trim();
// Carrega um <script> clássico uma só vez (o jsPDF em UMD; o plugin acrescenta doc.autoTable)
const scripts = {};
const carregarScript = (src) => (scripts[src] ??= new Promise((ok, falha) => {
  const s = el("script", { src });
  s.onload = ok;
  s.onerror = () => { delete scripts[src]; falha(new Error(`não foi possível carregar ${src}`)); };
  document.head.append(s);
}));

async function pdfChecklist(r, botao) {
  if (botao) botao.disabled = true;
  try {
    await carregarScript("https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js");
    await carregarScript("https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.4/dist/jspdf.plugin.autotable.min.js");
    const { jsPDF } = window.jspdf;
    const autoTable = (doc, opcoes) => doc.autoTable(opcoes);
    const p = proj(r);
    const doc = new jsPDF({ unit: "mm", format: "a4" });
    doc.setFontSize(16);
    doc.text(latin(`Checklist - Loja ${r.loja}`), 14, 18);
    doc.setFontSize(11);
    doc.text(latin(p.nome), 14, 25);
    const info = [
      ["Data", fmt(r.data)],
      ["Estado", latin(r.status) || "-"],
      ["Progresso", progresso(r)],
      r.data_conclusao && ["Data conclusão", fmt(r.data_conclusao)],
      r.tipo_trabalho && ["Tipo de trabalho", latin(r.tipo_trabalho)],
      ...urs(r).map((u) => [u.slice(0, u.indexOf(": ")), latin(u.slice(u.indexOf(": ") + 2))]),
    ].filter(Boolean);
    autoTable(doc, { startY: 30, body: info, theme: "plain", styles: { fontSize: 10, cellPadding: 1 }, columnStyles: { 0: { fontStyle: "bold", cellWidth: 40 } } });

    const lista = tarefasDe(r);
    const corpo = [];
    let fase = null;
    lista.forEach((t) => {
      if (t.fase && t.fase !== fase) {
        fase = t.fase;
        const daFase = lista.filter((x) => x.fase === t.fase);
        corpo.push([{ content: latin(`${t.fase} (${daFase.filter(feita).length}/${daFase.length})`), colSpan: 3, styles: { fontStyle: "bold", fillColor: [238, 240, 243] } }]);
      }
      corpo.push([latin(t.tarefa), latin(t.status), latin(t.notas)]);
    });
    autoTable(doc, {
      startY: doc.lastAutoTable.finalY + 6,
      head: [["Tarefa", "Estado", "Notas"]],
      body: corpo.length ? corpo : [[{ content: "Este registo não tem checklist.", colSpan: 3 }]],
      styles: { fontSize: 9 },
      headStyles: { fillColor: [37, 99, 235] },
      columnStyles: { 0: { cellWidth: 80 }, 1: { cellWidth: 32 } },
    });

    // POS / SCO (Lojas Novas)
    if (p.posco) {
      let equip = equipCliente.get(r.id) || [];
      if (sessaoAtual) {
        const { data, error } = await sb.from("equipamentos").select("*").eq("registo_id", r.id).order("ordem");
        if (error) throw error;
        equip = data;
      }
      ["pos", "sco"].forEach((tipo) => {
        const g = POSCO[tipo];
        const lista = equip.filter((e) => e.tipo === tipo).sort((a, b) => a.ordem - b.ordem);
        autoTable(doc, {
          startY: doc.lastAutoTable.finalY + 6,
          head: [[{ content: latin(`${g.titulo} (${lista.filter((e) => e.instalado).length}/${lista.length} instalados)`), colSpan: g.colunas.length + 1 }],
            ["Número", ...g.colunas.map((c) => c[1])]],
          body: lista.length ? lista.map((e) => [latin(e.numero) || "-", ...g.colunas.map(([c]) => (e[c] ? "Sim" : "Não"))])
            : [[{ content: `Sem ${tipo.toUpperCase()} registados.`, colSpan: g.colunas.length + 1 }]],
          styles: { fontSize: 9 },
          headStyles: { fillColor: [37, 99, 235] },
        });
      });
    }
    const paginas = doc.getNumberOfPages();
    for (let i = 1; i <= paginas; i++) {
      doc.setPage(i);
      doc.setFontSize(8);
      doc.setTextColor(120);
      doc.text(`Gerado a ${new Date().toLocaleString("pt-PT")} · Winprovit · Página ${i}/${paginas}`, 14, 290);
    }
    doc.save(`Checklist_${r.loja}_${r.projeto}.pdf`);
  } catch (e) {
    avisar(`Não foi possível gerar o PDF: ${e.message}`);
  } finally {
    if (botao) botao.disabled = false;
  }
}

// ---------- Login ----------
function vistaLogin() {
  document.getElementById("topo").hidden = true;
  const email = el("input", { type: "email", placeholder: "email", autocomplete: "username", style: "width:100%" });
  const senha = el("input", { type: "password", placeholder: "palavra-passe", autocomplete: "current-password", style: "width:100%" });
  const entrar = el("button", { class: "cta", type: "submit", style: "width:100%" }, "Entrar");
  const form = el("form", { class: "cartao login" },
    el("h1", {}, "📋 Lidl Projetos"),
    el("p", {}, email), el("p", {}, senha), entrar,
    el("p", { class: "resumo" }, "As contas são criadas pelo administrador no Supabase."),
    el("p", {}, el("a", { href: "#/" }, "← Voltar à vista do cliente")));
  form.onsubmit = async (e) => {
    e.preventDefault();
    entrar.disabled = true;
    const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: senha.value });
    entrar.disabled = false;
    if (error) avisar("Email ou palavra-passe errados.");
  };
  $app.replaceChildren(form);
}

// =====================================================================
// Navegação
// =====================================================================
function menu() {
  const atual = location.hash || "#/";
  document.getElementById("menu").replaceChildren(
    el("a", { href: "#/", class: atual === "#/" ? "ativo" : "" }, "Dashboard"),
    ...Object.entries(PROJETOS).map(([dir, p]) =>
      el("a", { href: `#/projeto/${dir}`, class: atual.includes(`/${dir}`) ? "ativo" : "" }, p.nome)),
    el("a", { href: "#/cliente", class: atual === "#/cliente" ? "ativo" : "" }, "👁️ Vista cliente")
  );
}

// Sem login: vista do cliente, ou o formulário de login em #/login
function rotaSemLogin() {
  if (location.hash === "#/login") return vistaLogin();
  vistaAtual = vistaCliente;
  vistaCliente();
}

function rota() {
  const [, pagina, arg] = (location.hash.slice(1) || "/").split("/");
  menu();
  if (pagina === "cliente") vistaAtual = vistaCliente;
  else if (pagina === "projeto") vistaAtual = () => vistaProjeto(arg, false);
  else if (pagina === "arquivo") vistaAtual = () => vistaProjeto(arg, true);
  else if (pagina === "registo") vistaAtual = () => vistaRegisto(arg);
  else vistaAtual = vistaDashboard;
  window.scrollTo(0, 0);
  vistaAtual();
}

let canal = null;
async function iniciar(sessao) {
  sessaoAtual = sessao;
  clienteCarregado = false;
  if (!sessao) {
    prefsGuardadas = null;
    if (canal) { sb.removeChannel(canal); canal = null; }
    return rotaSemLogin();
  }
  if (location.hash === "#/login") history.replaceState(null, "", "#/");
  document.getElementById("topo").hidden = false;
  document.getElementById("utilizador").textContent = sessao.user.email;
  try {
    await Promise.all([carregar(), carregarPrefs().catch(() => (prefsNoSupabase = false))]);
  } catch (e) {
    return $app.replaceChildren(el("p", {}, `Erro a ler os dados: ${e.message}`));
  }
  if (!canal) {
    canal = sb.channel("alteracoes")
      .on("postgres_changes", { event: "*", schema: "public", table: "registos" }, agendar)
      .on("postgres_changes", { event: "*", schema: "public", table: "tarefas" }, agendar)
      .on("postgres_changes", { event: "*", schema: "public", table: "equipamentos" }, agendar)
      .subscribe();
  }
  rota();
}

window.addEventListener("hashchange", () => sb.auth.getSession().then(({ data }) => (data.session ? rota() : rotaSemLogin())));
document.getElementById("sair").onclick = () => sb.auth.signOut();

// Vista do cliente sem login: volta a ler os dados de 5 em 5 minutos (sem login não há tempo real)
setInterval(() => {
  if (!sessaoAtual && vistaAtual === vistaCliente && location.hash !== "#/login" && document.visibilityState === "visible") atualizarCliente();
}, 5 * 60 * 1000);

let ultimaSessao;
sb.auth.onAuthStateChange((evento, sessao) => {
  // Só reage a entrar/sair (o refresh do token não precisa de recarregar)
  const id = sessao?.user?.id ?? null;
  if (id === ultimaSessao) return;
  ultimaSessao = id;
  setTimeout(() => iniciar(sessao), 0);
});
