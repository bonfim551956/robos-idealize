// Robô de leitura da Kommo (auditoria do atendimento) — pedido do Diego em 07/11/2026 (PODE FAZER). Só leitura.
// Para cada lead da fila (public.aud_fila: amostra de conversas de ontem por operadora), abre o card do lead e copia
// o TEXTO das mensagens do chat para aud.conversas (public.aud_receber). Nunca digita, nunca envia, nunca muda etapa.
// O banco tira telefone e e-mail do texto antes de gravar. O log só mostra contagens.
import { chromium } from 'playwright'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const { KOMMO_EMAIL, KOMMO_SENHA, IDEALIZE_SERVICE_KEY } = process.env
const BASE = `https://${process.env.KOMMO_SUBDOMINIO || 'prevendasidealize'}.kommo.com`
const IDEALIZE_URL = process.env.IDEALIZE_URL || 'https://upkxaovgutzgackexhax.supabase.co'
const DIA = process.env.DIA || null                       // AAAA-MM-DD (padrão: ontem)
const CODIGO = (process.env.CODIGO || '').replace(/\D/g, '')  // código de verificação que a Kommo manda por e-mail (1º login)
// sessão salva entre rodadas (cache do Actions), CRIPTOGRAFADA com chave que só existe nos Secrets
const ARQ_SESSAO = '.sessao.enc'
const chave = () => createHash('sha256').update('kommo-sessao|' + KOMMO_SENHA + '|' + IDEALIZE_SERVICE_KEY).digest()
function salvarSessao(estado) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', chave(), iv)
  const dados = Buffer.concat([c.update(JSON.stringify(estado)), c.final()])
  writeFileSync(ARQ_SESSAO, Buffer.concat([iv, c.getAuthTag(), dados]))
}
function lerSessao() {
  try {
    if (!existsSync(ARQ_SESSAO)) return undefined
    const b = readFileSync(ARQ_SESSAO), d = createDecipheriv('aes-256-gcm', chave(), b.subarray(0, 12))
    d.setAuthTag(b.subarray(12, 28))
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString())
  } catch { return undefined }
}
if (!KOMMO_EMAIL || !KOMMO_SENHA || !IDEALIZE_SERVICE_KEY) { console.error('Faltam os Secrets KOMMO_EMAIL, KOMMO_SENHA ou IDEALIZE_SERVICE_KEY.'); process.exit(1) }

const h = { apikey: IDEALIZE_SERVICE_KEY, Authorization: `Bearer ${IDEALIZE_SERVICE_KEY}`, 'Content-Type': 'application/json' }
async function rpc(fn, corpo) {
  const r = await fetch(`${IDEALIZE_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: h, body: JSON.stringify(corpo) })
  if (!r.ok) throw new Error(`${fn}: HTTP ${r.status} ${(await r.text()).slice(0, 160)}`)
  return r.json().catch(() => null)
}

async function logado(page) {
  await page.goto(BASE + '/chats/', { waitUntil: 'domcontentloaded' }).catch(() => {})
  await page.waitForTimeout(3000)
  return page.locator('text=Comunicações').first().isVisible().catch(() => false)
}

async function entrar(page) {
  if (await logado(page)) return
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
  await page.locator('input[type="password"]').first().press('Enter')
  await page.waitForTimeout(4000)
  if (/^\/?$/.test(new URL(page.url()).pathname)) {
    await page.locator('button[type="submit"], #auth_submit, button:has-text("Login"), button:has-text("Entrar")').first().click().catch(() => {})
  }
  // verificação por e-mail (dispositivo novo): usa o código informado na rodada
  // espera sair do login ou aparecer a tela do código (até 30 s)
  let pedeCodigo = false
  for (let i = 0; i < 30; i++) {
    if (new URL(page.url()).pathname.length > 1) break
    if (await page.locator('[class*="auth_mfa" i] input:visible, input[autocomplete="one-time-code"]:visible, input[name*="code" i]:visible').count()) { pedeCodigo = true; break }
    await page.waitForTimeout(1000)
  }
  if (!pedeCodigo && new URL(page.url()).pathname.length <= 1) {
    const vis = await page.evaluate(() => [...document.querySelectorAll('input')].filter(e => e.offsetParent !== null).map(e => `${e.type}|${e.name}|${e.placeholder}|${e.className}`.slice(0, 120)))
    console.log('Campos visíveis depois do login:', JSON.stringify(vis))
    pedeCodigo = vis.some(v => !/password|login|checkbox|hidden/i.test(v.split('|')[0] + v.split('|')[2]))
  }
  if (pedeCodigo) {
    // sem código na rodada: espera até 8 min o código que o Diego informar (Idealize: public.robo_codigo_pegar)
    let codigo = CODIGO
    for (let i = 0; !codigo && i < 48; i++) {
      if (i === 0) console.log('A Kommo pediu o código de verificação: aguardando o código (até 8 min).')
      codigo = String((await rpc('robo_codigo_pegar', { p_robo: 'kommo' }).catch(() => null)) || '').replace(/\D/g, '')
      if (!codigo) await page.waitForTimeout(10000)
    }
    if (!codigo) throw new Error('a Kommo pediu o código de verificação e ele não chegou em 8 minutos')
    const campo = page.locator('[class*="auth_mfa" i] input:visible, input[name*="code" i]:visible, input[autocomplete="one-time-code"]:visible, input[inputmode="numeric"]:visible').first()
    const alvo = (await campo.count()) ? campo : page.locator('input[type="text"]:visible, input[type="number"]:visible, input[type="tel"]:visible').last()
    const vis = await page.evaluate(() => [...document.querySelectorAll('input')].filter(e => e.offsetParent !== null)
      .map(e => `${e.type}|${e.name}|${e.maxLength}|${String(e.className).slice(0, 60)}`))
    console.log('Tela do código, campos visíveis:', JSON.stringify(vis))
    // digita como uma pessoa (serve para campo único ou para caixinhas de 1 dígito)
    await alvo.click()
    await page.keyboard.type(codigo, { delay: 120 })
    await page.waitForTimeout(800)
    const botao = page.locator('[class*="auth_mfa" i] button:visible, button:has-text("Confirmar"):visible, button:has-text("Verificar"):visible, button:has-text("Confirm"):visible').first()
    if (await botao.count()) await botao.click().catch(() => {}); else await page.keyboard.press('Enter')
    await page.waitForTimeout(5000)
  }
  await page.waitForURL(u => !/auth|login/i.test(new URL(String(u)).pathname) && new URL(String(u)).pathname !== '/', { timeout: 45000 }).catch(() => {})
  await page.waitForLoadState('networkidle').catch(() => {})
  // confere se entrou (sem mostrar nada do cliente)
  const ok = await page.locator('text=Comunicações').first().isVisible().catch(() => false)
  if (!ok) {
    const diag = await page.evaluate(() => ({ caminho: location.pathname, campos: [...document.querySelectorAll('input')].map(e => e.placeholder || e.type).slice(0, 6),
      titulos: [...document.querySelectorAll('h1,h2,h3')].map(e => e.innerText.trim()).filter(Boolean).slice(0, 4),
      avisos: [...document.querySelectorAll('[class*="error" i], [class*="alert" i], [class*="captcha" i], iframe')].map(e => (e.innerText || e.getAttribute('src') || e.className || '').toString().trim().slice(0, 80)).filter(Boolean).slice(0, 6) }))
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
const contexto = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'pt-BR', storageState: lerSessao() })
const page = await contexto.newPage()
let lidas = 0, msgs = 0, erros = 0
try {
  await entrar(page)
  salvarSessao(await contexto.storageState())
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
