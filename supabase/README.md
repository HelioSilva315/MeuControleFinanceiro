# Backend do Nosso Caixa (Supabase)

Este diretório é o "servidor" do app: contas de usuário, o casal (household),
o controle de **premium** (Stripe na web + Google Play no Android) e o
**backup na nuvem** — sempre **criptografado no aparelho** (o servidor nunca vê
seus lançamentos em texto puro).

```
supabase/
  schema.sql                       # tabelas, funções e políticas (RLS)
  .env.example                     # variáveis/segredos que você vai definir
  functions/
    entitlement/index.ts           # o app pergunta "sou premium?"
    stripe-webhook/index.ts        # Stripe avisa pagamento -> grava premium
    google-play-verify/index.ts    # valida a compra do Play e grava premium
    google-play-rtdn/index.ts      # Google avisa renovação/cancelamento
    _shared/                       # utilidades (clientes, Google API, upsert)
```

## 1. Criar o projeto

1. Acesse <https://supabase.com> → **New project** (região `South America (São Paulo)` se disponível).
2. Guarde **Project URL**, **anon key** e **service_role key** (Settings → API).
   - `anon key` pode ir no app (público); **`service_role key` NUNCA** vai para o app.
3. Em **Authentication → Providers**, deixe **Email** ligado. Para testar rápido,
   desligue "Confirm email" (Authentication → Settings). Em produção, configure SMTP.

## 2. Criar as tabelas

No **SQL Editor**, cole e rode todo o conteúdo de `schema.sql`.

Isso cria `profiles`, `households`, `household_members`, `subscriptions`,
`cloud_backups`, as funções `i_am_premium()` / `is_premium()` e todas as
políticas de segurança (RLS).

## 3. Publicar as funções

Instale a CLI e faça deploy:

```bash
npm install -g supabase
supabase login
supabase link --project-ref SEU_PROJECT_REF
supabase functions deploy entitlement
supabase functions deploy stripe-webhook --no-verify-jwt
supabase functions deploy google-play-verify
supabase functions deploy google-play-rtdn --no-verify-jwt
```

- `stripe-webhook` e `google-play-rtdn` usam `--no-verify-jwt` porque quem chama
  é a Stripe / o Pub/Sub (sem JWT de usuário) — a autenticidade é validada por
  assinatura/token dentro da função.
- `entitlement` e `google-play-verify` recebem o JWT do usuário logado.

## 4. Definir os segredos

```bash
supabase secrets set --env-file supabase/.env
```

(As variáveis `SUPABASE_URL`, `SUPABASE_ANON_KEY` e `SUPABASE_SERVICE_ROLE_KEY`
já são injetadas automaticamente nas funções.)

## 5. Stripe (cobrança na web)

1. Crie um **Produto** com um **Preço recorrente** (ex.: R$ 14,90/mês) — copie o `price_id` para `STRIPE_PRICE_ID`.
2. Crie um **Webhook** apontando para
   `https://SEU_PROJECT.supabase.co/functions/v1/stripe-webhook`
   com os eventos: `checkout.session.completed`,
   `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`. Copie o `whsec_...` para `STRIPE_WEBHOOK_SECRET`.
3. No checkout (backend do app), crie a sessão passando
   `metadata.household_id` e `client_reference_id = household_id`. É assim que o
   webhook sabe a quem creditar o premium.

## 6. Google Play (Android / TWA)

1. Publique o app na Play Console (pode ser o PWA empacotado como **TWA** com o
   [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap)).
2. No **Google Cloud**, crie uma **Service Account** e ative a
   **Android Publisher API**. Em **Play Console → Users and permissions**, dê a
   essa conta acesso ao app (permissão de financeiro/gerenciar pedidos).
3. Baixe a chave JSON da Service Account e coloque em `GOOGLE_SERVICE_ACCOUNT`
   (uma linha). Ajuste `GOOGLE_PACKAGE_NAME`.
4. **Real-time Developer Notifications**: em Play Console, configure um tópico
   do Pub/Sub. Crie uma **assinatura push** apontando para
   `https://SEU_PROJECT.supabase.co/functions/v1/google-play-rtdn`.
5. No app Android, após a compra pelo Play Billing, envie o `purchaseToken`
   para `google-play-verify` (com o JWT do usuário). A função valida na Google e
   grava o premium.

## 7. Como o app usa

- **Login**: `supabase.auth.signUp/signIn` (email + senha ou link mágico).
- **Sou premium?**: `GET /functions/v1/entitlement` → `{ premium, until }`.
- **Backup na nuvem**: grava/lê `cloud_backups.ciphertext` (o blob já cifrado
  pelo app) — leitura liberada para o casal, escrita só para premium.
- **Cobrança**: web → Stripe Checkout; Android → Play Billing + `google-play-verify`.

## Custos (referência)

- Supabase: plano **Free** já atende o desenvolvimento (2 projetos, 500 MB de
  banco, 50k usuários ativos/mês). Produção leve: **Pro** (~US$ 25/mês).
- Stripe: taxa por transação (sem mensalidade).
- Google Play: taxa única de registro (US$ 25) + 15% por assinatura.
- Hospedagem do app (Netlify) continua gratuita.

## Segurança

- O servidor guarda apenas o **backup cifrado** (AES-256-GCM no cliente). Nem o
  Supabase lê os lançamentos.
- A `service_role key` fica **somente** nas Edge Functions (nunca no app).
- Todas as tabelas têm **RLS**: cada usuário só vê o que é do seu household.
