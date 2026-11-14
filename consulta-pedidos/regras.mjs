// Regras puras do robô da Consulta de Pedidos (sem navegador), testadas em regras.test.mjs.

// Número do pedido no laboratório → onde procurar. Mesma regra do banco (consulta_pedido_pedir).
export function identificar(numero) {
  const n = String(numero || '').replace(/\s/g, '').toUpperCase()
  if (/^\d{6,12}$/.test(n)) return { numero: n, laboratorio: 'braslab', empresa: null }
  const h = n.match(/^(SP2277|SP3485)-\d{6}-\d{1,6}$/)
  if (h) return { numero: n, laboratorio: 'haytek', empresa: h[1] }
  return null
}

// Etapas do acompanhamento da Braslab → status atual = primeira etapa ainda não concluída;
// com todas concluídas, a última. Nunca inventa etapa: só o que veio da página.
export function statusBraslab(etapas) {
  const lista = (etapas || []).filter((e) => e && e.nome)
  if (!lista.length) return null
  let atual = lista.findIndex((e) => !e.concluida)
  if (atual === -1) atual = lista.length - 1
  return {
    status: lista[atual].nome,
    etapas: lista.map((e, i) => ({ nome: e.nome.slice(0, 60), concluida: !!e.concluida, atual: i === atual })),
  }
}

export const limparTexto = (t) => String(t || '').replace(/\s+/g, ' ').trim()

// Pedidos com POST/PUT/DELETE que o robô nunca deixa sair do navegador (defesa extra além de nunca clicar nesses botões)
const PROIBIDO = /cancel|exclu|delet|remov|upload|anexo|carrinho|cart|checkout|pagamento|payment|cupom|coupon|frete|leilao|novo-?pedido|criar|create|salvar|save|alterar|editar|update|senha|password|perfil|profile/i
const SEMPRE_OK = /\/auth\/login|\/login|\/signin|\/session|\/token/i

export function requisicaoPermitida(metodo, url) {
  const m = String(metodo || 'GET').toUpperCase()
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true
  if (m === 'PUT' || m === 'PATCH' || m === 'DELETE') return false
  let caminho = ''
  try { const u = new URL(url); caminho = u.pathname + u.search } catch { return false }
  if (SEMPRE_OK.test(caminho)) return true
  return !PROIBIDO.test(caminho)
}

// Funções que rodam DENTRO da página (o Playwright as copia para o navegador): precisam ser autossuficientes.
// Braslab: cada <li> do acompanhamento; concluída = tem o selo StepOK.
export function etapasDaPagina(lis) {
  return lis.map((li) => ({
    nome: (li.querySelector('.LabelStep')?.innerText || '').replace(/\s+/g, ' ').trim(),
    concluida: !!li.querySelector('.BadgeStatus img[src*="StepOK"]'),
  }))
}

// Haytek: acha a linha do pedido na tabela "Meus pedidos" e devolve a coluna Status.
export function linhaHaytek(num) {
  const tabela = [...document.querySelectorAll('table')].find((t) => /Pedido Haytek/i.test(t.innerText))
  if (!tabela) return null
  const cab = [...tabela.querySelectorAll('thead th')].map((th) => th.innerText.trim())
  const iStatus = cab.findIndex((c) => /^Status$/i.test(c))
  const iPedido = cab.findIndex((c) => /Pedido Haytek/i.test(c))
  if (iPedido < 0 || iStatus < 0) return null
  for (const tr of tabela.querySelectorAll('tbody tr')) {
    const tds = [...tr.querySelectorAll('td')].map((td) => td.innerText.trim())
    if (tds[iPedido] === num) return { status: tds[iStatus] }
  }
  return { vazio: true }
}
