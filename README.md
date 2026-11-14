# Robôs Idealize

Robôs de **leitura** usados pelos agentes de conferência da Idealize AI. Cada robô entra num sistema com o usuário próprio do
agente (senha nos Secrets do GitHub), lê relatórios e grava no banco da Idealize AI. Nenhum robô lança, cancela, recebe ou
altera nada nos sistemas.

| Robô | Sistema | Quando | O que lê |
|---|---|---|---|
| `consulta-pedidos/` | Braslab (WebPedidos) e Haytek | quando alguém consulta um pedido no Central (fica ~5 min ligado e desliga) | Só o status do pedido pelo número; grava no banco do Central |
| `multicrediario/` | Multicrediário (São Vicente) | todo dia às 7h | Operação (vendas garantidas e detalhes), Recebimentos (parcelas e detalhes), Status Garantia |

Secrets: `MULTI_USUARIO`, `MULTI_SENHA`, `IDEALIZE_SERVICE_KEY` (chave service_role do Supabase da Idealize AI).
Os registros de execução só mostram contagens: nenhum dado de cliente.

Secrets da Consulta de Pedidos: `CONSULTA_CHAVE` (chave do robô no banco do Central), `BRASLAB_LOGIN`, `BRASLAB_SENHA`,
`HAYTEK_EMAIL`, `HAYTEK_SENHA`. O robô bloqueia qualquer envio que pareça criar, alterar, cancelar, pagar ou anexar.
