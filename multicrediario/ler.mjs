// Robô de leitura do Multicrediário — pedido do Diego em 07/11/2026 (PODE FAZER). Só leitura.
// Lê: Relatório de Operação (+ detalhe de cada dia), Recebimentos (+ detalhe de cada dia) e Status Garantia (T/G/P),
// e grava cada tela como veio (cabeçalho + linhas) em multi.capturas (Idealize AI) pela função public.multi_receber.
// O log só mostra contagens (o repositório pode estar público).
import { chromium } from 'playwright'

const BASE = 'https://cliente.multicrediario.com.br'
const { MULTI_USUARIO, MULTI_SENHA, IDEALIZE_SERVICE_KEY } = process.env
const IDEALIZE_URL = process.env.IDEALIZE_URL || 'https://upkxaovgutzgackexhax.supabase.co'
const DIAS = Math.min(Number(process.env.DIAS || 3), 62)          // detalhe dos últimos N dias
const MESES = Math.min(Number(process.env.MESES || 1), 3)        // 1 = mês corrente; 2 = inclui o anterior
const LOJA = process.env.LOJA || 'sao_vicente'
if (!MULTI_USUARIO || !MULTI_SENHA || !IDEALIZE_SERVICE_KEY) { console.error('Faltam os Secrets MULTI_USUARIO, MULTI_SENHA ou IDEALIZE_SERVICE_KEY.'); process.exit(1) }

const h = { apikey: IDEALIZE_SERVICE_KEY, Authorization: `Bearer ${IDEALIZE_SERVICE_KEY}`, 'Content-Type': 'application/json' }
async function rpc(fn, corpo) {
  const r = await fetch(`${IDEALIZE_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: h, body: JSON.stringify(corpo) })
  if (!r.ok) throw new Error(`${fn}: HTTP ${r.status} ${(await r.text()).slice(0, 160)}`)
  return r.json().catch(() => null)
}
const hoje = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }))
const br = d => d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
const iso = s => { const m = String(s || '').match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null }
const limite = new Date(hoje); limite.setDate(limite.getDate() - DIAS)
const noPrazo = dataBr => { const i = iso(dataBr); return i && new Date(i + 'T12:00:00') >= limite }

// todas as tabelas da página: cabeçalho e linhas (texto das células)
const lerTabelas = page => page.evaluate(() => [...document.querySelectorAll('table')].map(t => ({
  cabecalho: [...t.querySelectorAll('thead th, tr th')].map(th => th.innerText.trim()).filter(Boolean),
  linhas: [...t.querySelectorAll('tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.innerText.trim().replace(/\s+/g, ' '))).filter(l => l.length),
})).filter(t => t.linhas.length))
// links de detalhe (submit_href('...Detalhe...')) que estão nas tabelas
const linksDetalhe = page => page.evaluate(() => [...document.querySelectorAll('table a[onclick*="submit_href"]')]
  .map(a => (a.getAttribute('onclick').match(/submit_href\('([^']+)'/) || [])[1]).filter(Boolean))

let telas = 0, linhasTot = 0
async function gravar(relatorio, referencia, dia, tab) {
  const n = await rpc('multi_receber', { p_relatorio: relatorio, p_referencia: referencia, p_dia: dia, p_cabecalho: tab?.cabecalho ?? [], p_linhas: tab?.linhas ?? [], p_loja: LOJA })
  telas++; linhasTot += Number(n || 0)
}

async function entrar(page) {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.locator('input[placeholder*="Usu"]').first().fill(MULTI_USUARIO)
  await page.locator('input[type="password"]').first().fill(MULTI_SENHA)
  await page.getByRole('button', { name: /^Login$/i }).or(page.getByText(/^Login$/)).first().click()
  await page.waitForURL(/\/Home\//, { timeout: 30000 })
}

// relatório mensal (Operação ou Recebimentos) + detalhe de cada dia recente
async function relatorioMensal(page, caminho, nome) {
  for (let m = 0; m < MESES; m++) {
    await page.goto(BASE + caminho, { waitUntil: 'domcontentloaded' })
    const opcoes = await page.locator('#periodo option').allTextContents()
    const idx = opcoes.findIndex(t => /CORRENTE/i.test(t)); if (idx < 0) throw new Error(`${nome}: período corrente não encontrado`)
    await page.locator('#periodo').selectOption({ index: idx + m })
    await page.getByText('Localizar', { exact: true }).first().click()
    await page.locator('table th').first().waitFor({ timeout: 30000 })
    const tabs = await lerTabelas(page)
    await gravar(nome, `periodo=${opcoes[idx + m].trim()}`, null, tabs[0])
    const links = (await linksDetalhe(page)).filter(u => noPrazo((u.match(/Data=([\d/]+)/) || [])[1]))
    for (const u of links) {
      await page.evaluate(x => window.submit_href(x), u)
      await page.waitForURL(/Detalhe/i, { timeout: 30000 }).catch(() => {})
      await page.waitForLoadState('load')
      await page.waitForTimeout(800)
      const det = await lerTabelas(page)
      const ref = u.split('?')[1] || u
      await gravar(nome + '_detalhe', ref, iso((u.match(/Data=([\d/]+)/) || [])[1]), det[0] || { cabecalho: [], linhas: [] })
      await page.goBack({ waitUntil: 'load' }).catch(() => {})
    }
  }
}

async function garantias(page) {
  const ini = new Date(hoje); ini.setDate(ini.getDate() - 75)
  for (const tipo of ['T', 'G', 'P']) {
    await page.goto(BASE + '/Garantia/Garantia/StatusGarantia', { waitUntil: 'domcontentloaded' })
    await page.locator('#tipoGarantia').selectOption(tipo)
    await page.locator('#periodoInicial').fill(br(ini))
    await page.locator('#periodoFinal').fill(br(hoje))
    await page.locator('#btn_localizar').click()
    await page.waitForLoadState('load'); await page.waitForTimeout(1500)
    const tabs = await lerTabelas(page)
    await gravar('garantia', `${tipo}|${br(ini)}-${br(hoje)}`, null, tabs[0] || { cabecalho: [], linhas: [] })
  }
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
let ok = true
try {
  await entrar(page)
  await relatorioMensal(page, '/Relatorios/RelatoriosFechamentoDiario/RelOperacao', 'operacao')
  await relatorioMensal(page, '/Relatorios/RelatoriosFechamentoDiario/RelRecebimentos', 'recebimentos')
  await garantias(page)
} catch (e) {
  ok = false
  console.error('Falhou:', String(e.message || e).split('\n')[0].slice(0, 200), '| tela:', new URL(page.url()).pathname)
} finally { await browser.close() }
await rpc('multi_rodada', { p_resumo: { ok, telas, linhas: linhasTot, dias: DIAS, meses: MESES, loja: LOJA } }).catch(() => {})
console.log(`Telas lidas ${telas}, linhas ${linhasTot}, ${ok ? 'sem erro' : 'com erro'}.`)
if (!ok) process.exit(1)
