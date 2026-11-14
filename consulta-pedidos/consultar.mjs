// Robô da Consulta de Pedidos (Central Idealize) — aprovado pelo Diego em 14/11/2026 (PODE FAZER). SÓ LEITURA.
// Acordado pela função consulta-pedido do Central quando alguém consulta um pedido. Lê a fila no banco do Central,
// entra na Braslab (WebPedidos) ou na Haytek, busca o número e copia SÓ o status. Nunca cria, altera, cancela
// ou envia nada: só abre páginas de consulta, digita o número na busca e lê a tela; qualquer POST suspeito é bloqueado.
// Fica ligado alguns minutos esperando novas consultas (as próximas respondem em segundos) e depois desliga sozinho.
// O log só mostra contagens: nenhum dado de cliente, nenhuma senha.
import { chromium } from 'playwright'
import { identificar, statusBraslab, requisicaoPermitida, limparTexto, etapasDaPagina, linhaHaytek } from './regras.mjs'

const { CONSULTA_CHAVE, BRASLAB_LOGIN, BRASLAB_SENHA, HAYTEK_EMAIL, HAYTEK_SENHA } = process.env
const CENTRAL_URL = 'https://ifqaukdkurkirmahpuky.supabase.co'
const CENTRAL_CHAVE_PUBLICA = 'sb_publishable_K0XKMUMbZoWD1nP54G8tpA_b3fm5ZUr'
const BRASLAB = 'https://web.braslaboptical.com.br'
const HAYTEK = 'https://haytek.com.br'
const OCIOSO_MS = Number(process.env.OCIOSO_MIN || 5) * 60000   // desliga depois de N min sem consulta
const LIMITE_MS = 20 * 60000                                      // nunca passa disso numa rodada
const TEMPO_PAGINA = 30000

if (!CONSULTA_CHAVE) { console.error('Falta o Secret CONSULTA_CHAVE.'); process.exit(1) }

const espera = (ms) => new Promise((r) => setTimeout(r, ms))
async function rpc(fn, corpo) {
  const r = await fetch(`${CENTRAL_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: CENTRAL_CHAVE_PUBLICA, Authorization: `Bearer ${CENTRAL_CHAVE_PUBLICA}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_chave: CONSULTA_CHAVE, ...corpo }),
  })
  if (!r.ok) throw new Error(`${fn}: HTTP ${r.status} ${(await r.text()).slice(0, 160)}`)
  return r.json().catch(() => null)
}

class ErroConsulta extends Error {
  constructor(publico, interno) { super(interno || publico); this.publico = publico }
}

// ---------- navegador com trava de segurança ----------
let navegador
const contextos = {}
const bloqueadas = []
async function pagina(lab) {
  if (contextos[lab]) return contextos[lab].page
  navegador ||= await chromium.launch()
  const context = await navegador.newContext({ locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', viewport: { width: 1366, height: 900 } })
  await context.route('**/*', (route) => {
    const req = route.request()
    if (requisicaoPermitida(req.method(), req.url())) return route.continue()
    try { bloqueadas.push(`${req.method()} ${new URL(req.url()).pathname}`) } catch { bloqueadas.push(req.method()) }
    return route.abort()
  })
  context.setDefaultTimeout(TEMPO_PAGINA)
  const page = await context.newPage()
  page.on('dialog', (d) => d.dismiss().catch(() => {}))   // nunca confirma nada
  contextos[lab] = { context, page, logado: false, empresa: null }
  return page
}
async function diagnostico(page) {
  return page.evaluate(() => ({ caminho: location.pathname, titulo: document.title.slice(0, 60) })).catch(() => ({}))
}

// ---------- Braslab (WebPedidos) ----------
async function braslabEntrar(page) {
  if (!BRASLAB_LOGIN || !BRASLAB_SENHA) throw new ErroConsulta('Login da Braslab não configurado.')
  await page.goto(`${BRASLAB}/auth/login?acesso=braslab-prod&sistema=otica`, { waitUntil: 'domcontentloaded' })
  if (!new URL(page.url()).pathname.startsWith('/auth')) { contextos.braslab.logado = true; return }
  const usuario = page.getByPlaceholder('Informe seu login')
  const achou = await usuario.waitFor().then(() => true).catch(() => false)
  if (!achou) throw new ErroConsulta('O portal da Braslab mudou ou não respondeu.', 'login braslab: ' + JSON.stringify(await diagnostico(page)))
  await usuario.fill(BRASLAB_LOGIN)
  await page.getByPlaceholder('Informe sua senha').fill(BRASLAB_SENHA)
  await page.getByRole('button', { name: 'ENTRAR' }).click()
  const saiu = await page.waitForURL((u) => !u.pathname.startsWith('/auth'), { timeout: TEMPO_PAGINA }).then(() => true).catch(() => false)
  if (!saiu) {
    const texto = await page.locator('body').innerText().catch(() => '')
    if (/captcha|verifica[çc][ãa]o|c[óo]digo/i.test(texto)) throw new ErroConsulta('A Braslab pediu verificação extra no login. Avise a administração.')
    throw new ErroConsulta('A Braslab recusou o login do robô. Avise a administração.')
  }
  contextos.braslab.logado = true
}

async function braslabConsultar(numero, tentativa = 1) {
  const page = await pagina('braslab')
  if (!contextos.braslab.logado) await braslabEntrar(page)
  await page.goto(`${BRASLAB}/consultarapida?id=${encodeURIComponent(numero)}`, { waitUntil: 'domcontentloaded' })
  if (new URL(page.url()).pathname.startsWith('/auth')) {          // sessão expirou: entra de novo uma vez
    contextos.braslab.logado = false
    if (tentativa > 1) throw new ErroConsulta('A sessão da Braslab não se manteve.')
    return braslabConsultar(numero, tentativa + 1)
  }
  const pronto = await page.waitForFunction(() => {
    const t = document.body?.innerText || ''
    if (/Nenhum pedido encontrado/i.test(t)) return 'nao'
    return document.querySelectorAll('.Steps ol li .LabelStep').length > 0 ? 'sim' : false
  }, null, { timeout: 40000 }).then((h) => h.jsonValue()).catch(() => null)
  if (!pronto) throw new ErroConsulta('O portal da Braslab mudou ou não respondeu.', 'braslab consulta: ' + JSON.stringify(await diagnostico(page)))
  if (pronto === 'nao') return { situacao: 'nao_localizado' }

  // o portal também acha por "Ordem de Compra": só vale se o ID mostrado for exatamente o número pedido
  const texto = await page.locator('body').innerText()
  const id = (texto.match(/ID do Pedido\s+(\d+)/) || [])[1]
  if (id !== numero) return { situacao: 'nao_localizado' }

  await page.waitForTimeout(800)   // termina de desenhar os selos das etapas
  const etapas = await page.$$eval('.Steps ol li', etapasDaPagina)
  const r = statusBraslab(etapas)
  if (!r) throw new ErroConsulta('O portal da Braslab mudou ou não respondeu.', 'braslab sem etapas')
  return { situacao: 'encontrado', status: r.status, etapas: r.etapas }
}

// ---------- Haytek ----------
async function haytekEntrar(page) {
  if (!HAYTEK_EMAIL || !HAYTEK_SENHA) throw new ErroConsulta('Login da Haytek não configurado.')
  await page.goto(`${HAYTEK}/admin/dashboard`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  const jaDentro = await page.getByText('Trocar empresa').first().isVisible().catch(() => false)
  if (jaDentro) { contextos.haytek.logado = true; return }
  await page.goto(`${HAYTEK}/`, { waitUntil: 'domcontentloaded' })
  const email = page.locator('input[type="email"], input[name*="mail" i], input[placeholder*="mail" i]').first()
  const achou = await email.waitFor().then(() => true).catch(() => false)
  if (!achou) throw new ErroConsulta('O portal da Haytek mudou ou não respondeu.', 'login haytek: ' + JSON.stringify(await diagnostico(page)))
  await email.fill(HAYTEK_EMAIL)
  await page.locator('input[type="password"]').first().fill(HAYTEK_SENHA)
  await page.getByRole('button', { name: /^Entrar$/ }).first().click()
  const entrou = await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: TEMPO_PAGINA }).then(() => true).catch(() => false)
  if (!entrou) throw new ErroConsulta('A Haytek recusou o login do robô. Avise a administração.')
  contextos.haytek.logado = true
}

// Mesmo acesso, duas empresas (SP2277 Sorocaba, SP3485 São Vicente): seleciona a do número antes de buscar
async function haytekEmpresa(page, empresa) {
  if (contextos.haytek.empresa === empresa) return
  await page.goto(`${HAYTEK}/admin/dashboard#modal-change-company`, { waitUntil: 'domcontentloaded' })
  const linha = page.locator('tr', { hasText: empresa }).filter({ has: page.getByRole('button', { name: 'Selecionar' }) }).first()
  const achou = await linha.waitFor({ timeout: TEMPO_PAGINA }).then(() => true).catch(() => false)
  if (!achou) throw new ErroConsulta('A empresa deste pedido não está no acesso da Haytek.', 'haytek sem empresa ' + empresa)
  await linha.getByRole('button', { name: 'Selecionar' }).click()
  await page.waitForTimeout(2500)
  contextos.haytek.empresa = empresa
}

async function haytekConsultar(numero, empresa, tentativa = 1) {
  const page = await pagina('haytek')
  if (!contextos.haytek.logado) await haytekEntrar(page)
  await haytekEmpresa(page, empresa)
  await page.goto(`${HAYTEK}/admin/meuspedidos`, { waitUntil: 'domcontentloaded' })
  const campo = page.getByRole('textbox', { name: 'Número Pedido Haytek' })
  const achou = await campo.waitFor().then(() => true).catch(() => false)
  if (!achou) {
    if (/^\/?$/.test(new URL(page.url()).pathname) && tentativa === 1) {    // caiu no login: sessão expirou
      Object.assign(contextos.haytek, { logado: false, empresa: null })
      return haytekConsultar(numero, empresa, 2)
    }
    throw new ErroConsulta('O portal da Haytek mudou ou não respondeu.', 'haytek busca: ' + JSON.stringify(await diagnostico(page)))
  }
  // confere que a empresa certa está ativa (o código aparece no topo)
  const empresaAtiva = await page.getByText(empresa, { exact: true }).first().isVisible().catch(() => false)
  if (!empresaAtiva) {
    contextos.haytek.empresa = null
    if (tentativa === 1) return haytekConsultar(numero, empresa, 2)
    throw new ErroConsulta('Não foi possível selecionar a empresa na Haytek.')
  }
  await campo.fill(numero)
  await page.getByRole('button', { name: 'Buscar' }).click()
  await page.getByText('Filtro Aplicado').first().waitFor({ timeout: TEMPO_PAGINA }).catch(() => {})

  // espera a tabela trazer o pedido (ou ficar claro que não veio)
  let achado = null
  for (let i = 0; i < 20 && !achado; i++) {
    await page.waitForTimeout(750)
    achado = await page.evaluate(linhaHaytek, numero)
    if (achado?.vazio) achado = i >= 6 ? achado : null    // dá tempo da busca terminar antes de dizer "não achou"
  }
  if (!achado) throw new ErroConsulta('O portal da Haytek mudou ou não respondeu.', 'haytek sem tabela')
  if (achado.vazio) return { situacao: 'nao_localizado' }
  const status = limparTexto(achado.status)
  if (!status) throw new ErroConsulta('O portal da Haytek mudou ou não respondeu.', 'haytek sem status')
  return { situacao: 'encontrado', status, etapas: null }
}

// ---------- fila ----------
async function processar(item) {
  const alvo = identificar(item.numero)
  if (!alvo || alvo.laboratorio !== item.laboratorio) {
    return rpc('consulta_pedido_robo_resultado', { p_numero: item.numero, p_situacao: 'erro', p_erro: 'Número de pedido inválido.' })
  }
  try {
    const r = alvo.laboratorio === 'braslab'
      ? await braslabConsultar(alvo.numero)
      : await haytekConsultar(alvo.numero, alvo.empresa)
    await rpc('consulta_pedido_robo_resultado', {
      p_numero: alvo.numero, p_situacao: r.situacao, p_status: r.status ?? null, p_etapas: r.etapas ?? null,
    })
    return r.situacao
  } catch (e) {
    console.error(`[${alvo.laboratorio}] falha: ${String(e.message || e).slice(0, 200)}`)
    // a sessão pode ter ficado num estado ruim: começa do zero na próxima
    if (contextos[alvo.laboratorio]) { await contextos[alvo.laboratorio].context.close().catch(() => {}); delete contextos[alvo.laboratorio] }
    await rpc('consulta_pedido_robo_resultado', {
      p_numero: alvo.numero, p_situacao: 'erro', p_erro: e.publico || 'Não foi possível consultar o laboratório.',
    }).catch((x) => console.error('não gravou o erro:', String(x).slice(0, 160)))
    return 'erro'
  }
}

const inicio = Date.now()
let ultimo = Date.now()
const conta = { encontrado: 0, nao_localizado: 0, erro: 0 }
try {
  while (true) {
    const fila = (await rpc('consulta_pedido_robo_fila', {})) || []
    if (fila.length) {
      for (const item of fila) conta[await processar(item)]++
      ultimo = Date.now()
      continue
    }
    const tempo = Date.now() - inicio
    if (Date.now() - ultimo > OCIOSO_MS || tempo > LIMITE_MS) {
      if (await rpc('consulta_pedido_robo_sair', {})) break
      if (tempo > LIMITE_MS + 120000) break
      continue
    }
    await espera(2000)
  }
} finally {
  await navegador?.close().catch(() => {})
  console.log(`Consultas: ${conta.encontrado} encontradas, ${conta.nao_localizado} não localizadas, ${conta.erro} com erro.`)
  if (bloqueadas.length) console.log(`Ações bloqueadas pela trava de segurança: ${bloqueadas.length} (${[...new Set(bloqueadas)].slice(0, 10).join('; ')})`)
}
