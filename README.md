# Traqueamento de Pagina de Vendas

Scaffold completo de traqueamento para uma pagina de vendas em **HTML/CSS/JS puro**, com:

- **Meta Pixel** (navegador) + **Conversions API / CAPI** (servidor) com **deduplicacao** por `event_id`
- **Google Analytics 4 (GA4)**
- Eventos: **PageView**, **Scroll** (25/50/75/90%), **Tempo na pagina**, **InitiateCheckout**, **AddPaymentInfo**, **Purchase** (e Lead/ViewContent)

> Por que CAPI? Bloqueadores de anuncio e o iOS derrubam parte dos eventos do Pixel no navegador. A CAPI envia o evento pelo servidor tambem, e o `event_id` compartilhado evita contar a mesma conversao duas vezes.

---

## Estrutura

```
.
├── public/
│   ├── index.html          # Pagina de vendas de exemplo (com os eventos ja ligados)
│   └── js/tracking.js      # Biblioteca de tracking (Pixel + GA4 + CAPI)
├── server/
│   └── index.js            # Servidor Express: serve a pagina + endpoint da CAPI
├── .env.example            # Modelo de configuracao (copie para .env)
├── package.json
└── README.md
```

---

## Passo a passo

### 1. Instalar

```bash
npm install
```

### 2. Configurar credenciais

```bash
cp .env.example .env
```

Preencha o `.env`:

| Variavel | Onde encontrar |
|---|---|
| `META_PIXEL_ID` | Gerenciador de Eventos → Fontes de dados → seu Pixel (numero) |
| `META_CAPI_ACCESS_TOKEN` | Gerenciador de Eventos → Pixel → Configuracoes → **Conversions API → Gerar token de acesso** |
| `META_TEST_EVENT_CODE` | Gerenciador de Eventos → Pixel → **Testar eventos** (so para validar; deixe vazio em producao) |
| `GA4_MEASUREMENT_ID` | GA4 → Admin → Fluxos de dados → seu fluxo (`G-XXXXXXXXXX`) |

No `public/index.html`, troque `SEU_PIXEL_ID` no `<noscript>` pelo seu Pixel ID (fallback para quem esta sem JS).

### 3. Rodar

```bash
npm start          # producao
npm run dev        # com auto-reload
```

Acesse `http://localhost:3000`.

---

## Como disparar cada evento

Os botoes de compra ja disparam **InitiateCheckout** via `data-attributes` no HTML:

```html
<a data-track-event="InitiateCheckout"
   data-value="197" data-currency="BRL"
   data-content-name="Curso X" data-content-ids="produto-123">Comprar</a>
```

Os demais via API JavaScript:

```js
// Ao preencher o pagamento
window.salesTracking.addPaymentInfo({ value: 197, currency: 'BRL' });

// Na PAGINA DE OBRIGADO (venda confirmada):
window.salesTracking.purchase(
  { value: 197, currency: 'BRL', content_name: 'Curso X',
    content_ids: ['produto-123'], order_id: 'PEDIDO-0001' },
  { em: 'cliente@email.com', ph: '+5511999999999' } // PII: hasheado no servidor
);

// Captura de lead
window.salesTracking.lead({ content_name: 'Newsletter' }, { em: 'cliente@email.com' });
```

> **Importante (LGPD):** dados pessoais (email, telefone, nome) sao normalizados e
> convertidos em **hash SHA-256 no servidor** antes de ir para a Meta. Nunca trafegam
> em texto puro e nunca aparecem no codigo do navegador.

---

## Testar e validar

1. **Meta — Testar eventos:** coloque o `META_TEST_EVENT_CODE` no `.env`, navegue na pagina e veja os eventos chegando em tempo real (deve aparecer "Processado pelo navegador" **e** "pelo servidor" com a flag de deduplicacao).
2. **Meta Pixel Helper** (extensao do Chrome): confirma o disparo do Pixel no navegador.
3. **GA4 — DebugView:** Admin → DebugView mostra `page_view`, `begin_checkout`, `purchase`, etc.
4. **Console do navegador:** `window.salesTracking.track('ViewContent')` dispara um evento de teste.

### Deduplicacao (o ponto critico)
O mesmo `event_id` e enviado no Pixel (`eventID`) e na CAPI (`event_id`). A Meta
usa isso para entender que o evento do navegador e o do servidor sao **o mesmo**,
evitando contagem dupla. Nao remova essa logica.

---

## Setup com Kiwify (importante)

Voce **nao roda JS dentro do checkout da Kiwify**, entao os eventos sao divididos:

| Onde | Eventos | Responsavel |
|---|---|---|
| Sua pagina de vendas (este projeto) | PageView, Scroll, Tempo, **ViewContent** (clique no CTA) | Pixel + GA4 + nossa CAPI |
| Checkout Kiwify | **InitiateCheckout, AddPaymentInfo, Purchase** | Kiwify (nativo, pagamento confirmado no servidor) |

### 1. Configurar o Pixel + CAPI na Kiwify
Painel da Kiwify → **Apps → Pixel/Facebook** (ou Configuracoes → Pixel):
- Cole o **mesmo Pixel ID** que voce usa aqui.
- Cole o **token da Conversions API** (pode gerar um token proprio para a Kiwify no mesmo Pixel — varias fontes para um Pixel so e o recomendado).
- A Kiwify passa a disparar InitiateCheckout/AddPaymentInfo/**Purchase** com deduplicacao propria.

### 2. Configurar o GA4 na Kiwify
Mesmo painel → campo de **Google Analytics**: cole o `G-XXXXXXXXXX`.

### 3. Conectar a atribuicao (sua pagina → Kiwify)
O `tracking.js` ja **repassa automaticamente** `utm_*`, `fbclid`, `gclid`, `src` e `sck`
para qualquer link com a classe `cta` (ou `data-forward-params`). Garanta que o botao
de compra aponte para o seu link Kiwify:

```html
<a href="https://pay.kiwify.com.br/SEU_CODIGO" class="cta"
   data-track-event="ViewContent" data-value="197" data-currency="BRL">Comprar</a>
```

> **Metrica limpa (configuracao atual):** o CTA dispara `ViewContent` (interesse na oferta)
> e a **Kiwify e a unica fonte de InitiateCheckout** — sem contagem dupla. Purchase tambem
> nunca duplica (so a Kiwify dispara).

> **GA4 entre dominios:** como o checkout fica em `pay.kiwify.com.br`, a melhor atribuicao
> entre sua pagina e a venda e via **UTMs** (ja repassadas). O GA4 da Kiwify registra a
> compra a partir desses parametros.

---

## Producao

- Hospede o servidor Node com HTTPS (a CAPI e os cookies `_fbc`/`_fbp` exigem dominio seguro).
- Mantenha `META_CAPI_ACCESS_TOKEN` **apenas** no servidor (variavel de ambiente). Nunca no front.
- Configure `trust proxy` corretamente se usar CDN/reverse proxy (ja habilitado no `server/index.js`).
- Considere mascarar o endpoint `/api/track` atras do seu dominio (server-side) — ja e o caso aqui.
