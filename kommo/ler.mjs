// Robô de leitura da Kommo (auditoria do atendimento) — pedido do Diego em 07/11/2026 (PODE FAZER). Só leitura.
// Para cada lead da fila (public.aud_fila: amostra de conversas de ontem por operadora), abre o card do lead e copia
// o TEXTO das mensagens do chat para aud.conversas (public.aud_receber). Nunca digita, nunca envia, nunca muda etapa.
// O banco tira telefone e e-mail do texto antes de gravar. O log só mostra contagens.
import { chromium } from 'playwright'

const { KOMMO_EMAIL, KOMMO_SENHA, IDEALIZE_SERVICE_KEY } = process.env
const BASE = `https://${process.env.KOMMO_SUBDOMINIO || 'prevendasidealize'}.kommo.com`
const IDEALIZE_URL = process.env.IDEALIZE_URL || 'https://upkxaovgutzgackexhax.supabase.co'
const DIA = process.env.DIA || null                       // AAAA-MM-DD (padrão: ontem)
if (!KOMMO_EMAIL || !KOMMO_SENHA || !IDEALIZE_SERVICE_KEY) { console.error('Faltam os Secrets KOMMO_EMAIL, KOMMO_SENHA ou IDEALIZE_SERVICE_KEY.'); process.exit(1) }

const h = { apikey: IDEALIZE_SERVICE_KEY, Authorization: `Bearer ${IDEALIZE_SERVICE_KEY}`, 'Content-Type': 'application/json' }
async function rpc(fn, corpo) {
  const r = await fetch(`${IDEALIZE_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: h, body: JSON.stringify(corpo) })
  if (!r.ok) throw new Error(`${fn}: HTTP ${r.status} ${(await r.text()).slice(0, 160)}`)
  return r.json().catch(() => null)
}

async function entrar(page) {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  const usuario = page.locator('input[name="username"], #session_end_login, input[type="email"], input[placeholder*="ogin" i], input[placeholder*="mail" i]').first()
  const achou = await usuario.waitFor({ timeout: 30000 }).then(() => true).catch(() => false)
  if (!achou) {
    const diag = await page.evaluate(() => ({ caminho: location.pathname, campos: [...document.querySelectorAll('input')].map(e => `${e.type}|${e.name}|${e.placeholder}`).slice(0, 8),
      titulo: document.title.slice(0, 60) }))
    throw new Error('tela de login diferente: ' + JSON.stringify(diag))
  }
  await usuario.fill(KOMMO_EMAIL)
  await page.locator('input[type="password"]').first().fill(KOMMO_SENHA)
  await page.locator('button[type="submit"], #auth_submit, button:has-text("Login"), button:has-text("Entrar")').first().click()
  await page.waitForURL(u => !/auth|login/i.test(new URL(String(u)).pathname) && new URL(String(u)).pathname !== '/', { timeout: 45000 }).catch(() => {})
  await page.waitForLoadState('networkidle').catch(() => {})
  // confere se entrou (sem mostrar nada do cliente)
  const ok = await page.locator('text=Comunicações').first().isVisible().catch(() => false)
  if (!ok) {
    const diag = await page.evaluate(() => ({ caminho: location.pathname, campos: [...document.querySelectorAll('input')].map(e => e.placeholder || e.type).slice(0, 6),
      titulos: [...document.querySelectorAll('h1,h2,h3')].map(e => e.innerText.trim()).filter(Boolean).slice(0, 4) }))
    throw new Error('não entrou na Kommo: ' + JSON.stringify(diag))
  }
}

async function lerLead(page, id) {
  await page.goto(`${BASE}/leads/detail/${id}`, { waitUntil: 'domcontentloaded' })
  await page.locator('.notes-wrapper__scroller, [class*="feed-note"]').first().waitFor({ timeout: 30000 })
  await page.waitForTimeout(1500)
  // carrega o histórico mais antigo
  for (let i = 0; i < 15; i++) {
    const mais = page.locator('.notes-wrapper__load-more-button, [class*="notes-wrapper__load-more"]').filter({ hasText: /Carregar mais/i }).first()
    if (!(await mais.isVisible().catch(() => false))) break
    await mais.click().catch(() => {})
    await page.waitForTimeout(1500)
  }
  return page.evaluate(() => {
    const t = (e, s) => [...e.querySelectorAll(s)].map(x => x.innerText.trim()).filter(Boolean).join('\n')
    return [...document.querySelectorAll('.feed-note-wrapper-amojo')].map(w => {
      const autor = (w.querySelector('.feed-note__amojo-user')?.innerText || '').trim()
      const entrada = !!w.querySelector('.feed-note-incoming')
      return { em: (w.querySelector('.feed-note__date')?.innerText || '').trim().slice(0, 20), autor,
        de: entrada ? 'cliente' : /bot/i.test(autor) ? 'bot' : 'atendente', texto: t(w, '.feed-note__message_paragraph') }
    }).filter(m => m.texto)
  })
}

const fila = await rpc('aud_fila', { p_dia: DIA })
console.log(`${fila.length} conversa(s) na fila.`)
if (!fila.length) process.exit(0)
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'pt-BR' })
let lidas = 0, msgs = 0, erros = 0
try {
  await entrar(page)
  for (const c of fila) {
    try {
      const m = await lerLead(page, c.lead_id)
      const n = await rpc('aud_receber', { p_lead: c.lead_id, p_dia: c.dia, p_mensagens: m, p_erro: null })
      lidas++; msgs += Number(n || 0)
    } catch (e) {
      erros++
      console.error(`lead ${c.lead_id}: ${String(e.message || e).split('\n')[0].slice(0, 140)}`)
    }
  }
} catch (e) {
  console.error('Falhou:', String(e.message || e).split('\n')[0].slice(0, 300))
  erros++
} finally { await browser.close() }
console.log(`Conversas lidas ${lidas}, mensagens ${msgs}, erros ${erros}.`)
if (!lidas && erros) process.exit(1)
