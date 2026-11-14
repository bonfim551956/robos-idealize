import { test } from 'node:test'
import assert from 'node:assert/strict'
import { identificar, statusBraslab, requisicaoPermitida, limparTexto } from './regras.mjs'

test('identifica o laboratório pelo número', () => {
  assert.deepEqual(identificar(' 115945581 '), { numero: '115945581', laboratorio: 'braslab', empresa: null })
  assert.deepEqual(identificar('sp3485-061126-63'), { numero: 'SP3485-061126-63', laboratorio: 'haytek', empresa: 'SP3485' })
  assert.deepEqual(identificar('SP2277-141126-104'), { numero: 'SP2277-141126-104', laboratorio: 'haytek', empresa: 'SP2277' })
  assert.equal(identificar('SP9999-061126-63'), null)
  assert.equal(identificar('12345'), null)
  assert.equal(identificar('ABC'), null)
  assert.equal(identificar(''), null)
})

test('status da Braslab: etapa em andamento', () => {
  const r = statusBraslab([
    { nome: 'PEDIDO REALIZADO', concluida: true }, { nome: 'EM APROVAÇÃO', concluida: true },
    { nome: 'AR COATING', concluida: false }, { nome: 'EMBALAGEM', concluida: false },
  ])
  assert.equal(r.status, 'AR COATING')
  assert.deepEqual(r.etapas.map((e) => e.atual), [false, false, true, false])
})

test('status da Braslab: tudo concluído vira a última etapa', () => {
  const r = statusBraslab([{ nome: 'PEDIDO REALIZADO', concluida: true }, { nome: 'NFe', concluida: true }])
  assert.equal(r.status, 'NFe')
  assert.equal(r.etapas[1].atual, true)
})

test('status da Braslab: sem etapas não inventa nada', () => {
  assert.equal(statusBraslab([]), null)
  assert.equal(statusBraslab([{ nome: '' }]), null)
})

test('bloqueia ações que alteram o laboratório', () => {
  assert.equal(requisicaoPermitida('GET', 'https://x.com/qualquer'), true)
  assert.equal(requisicaoPermitida('POST', 'https://web.braslaboptical.com.br/consultaDetalhada'), true)
  assert.equal(requisicaoPermitida('POST', 'https://web.braslaboptical.com.br/auth/login'), true)
  assert.equal(requisicaoPermitida('POST', 'https://web.braslaboptical.com.br/solicitarCancelamento'), false)
  assert.equal(requisicaoPermitida('POST', 'https://web.braslaboptical.com.br/uploadLeitura'), false)
  assert.equal(requisicaoPermitida('POST', 'https://api.haytek.com.br/orders/123/cancel'), false)
  assert.equal(requisicaoPermitida('DELETE', 'https://api.haytek.com.br/orders/123'), false)
  assert.equal(requisicaoPermitida('PUT', 'https://api.haytek.com.br/orders/123'), false)
  assert.equal(requisicaoPermitida('POST', 'url inválida'), false)
})

test('limpa espaços e quebras', () => {
  assert.equal(limparTexto('  EM\n  APROVAÇÃO '), 'EM APROVAÇÃO')
})
