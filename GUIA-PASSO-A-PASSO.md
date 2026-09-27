# 📘 GUIA PASSO A PASSO — UTM Tracker (para quem não é programador)

Este guia ensina **exatamente** o que clicar, o que digitar e onde, pra você rodar a plataforma no seu computador Windows.

---

## 🎯 O QUE VOCÊ VAI TER NO FINAL

Uma ferramenta web (igual ao Gerenciador de Anúncios da Meta) onde você:
1. Faz login com email/senha
2. Gera links rastreáveis com UTMs
3. Instala um script no seu site
4. Recebe vendas em tempo real via webhook
5. Vê no dashboard: quantos cliques, leads, vendas, ROAS, CPA, etc.

---

## ✅ PRÉ-REQUISITOS (instalar antes)

Você precisa de **3 coisas** instaladas no seu Windows:

### 1. Node.js (o "motor" que roda o backend)
- Baixe em: https://nodejs.org/
- Clique no botão verde **"LTS"** (versão recomendada)
- Instale clicando "Next, Next, Next" até terminar
- **Teste se funcionou:** abra o PowerShell e digite:
  ```
  node --version
  ```
  Deve aparecer algo tipo `v20.x.x`

### 2. PostgreSQL (o banco de dados)
- Baixe em: https://www.postgresql.org/download/windows/
- Clique em "Download the installer"
- Instale clicando "Next" — **ANOTE A SENHA** que você definir (vai precisar depois)
- Deixe a porta padrão: `5432`
- **Teste se funcionou:** abra o PowerShell e digite:
  ```
  psql --version
  ```
  Deve aparecer algo tipo `psql (PostgreSQL) 16.x`

### 3. Um editor de texto (opcional, mas ajuda)
- Baixe o VS Code: https://code.visualstudio.com/
- Instale clicando "Next, Next, Next"

---

## 🚀 PASSO 1 — Criar o banco de dados

Abra o **PowerShell** (clique no menu Iniciar → digite "PowerShell" → Enter).

Cole este comando e aperte Enter:

```powershell
psql -U postgres -c "CREATE DATABASE utm_tracker;"
```

Vai pedir a senha que você definiu na instalação do PostgreSQL. Digite e aperte Enter.

Se aparecer `CREATE DATABASE`, **deu certo!** ✅

---

## 🚀 PASSO 2 — Configurar o backend

No PowerShell, cole estes comandos **um por um** (aperte Enter depois de cada):

```powershell
cd C:\Users\Joaov\Downloads\claude\utm-tracker\backend
```

```powershell
npm install
```

⏳ Vai demorar uns 30 segundos baixando as dependências. Espere terminar.

Agora crie o arquivo de configuração:

```powershell
copy .env.example .env
```

Agora abra o arquivo `.env` no Bloco de Notas:

```powershell
notepad .env
```

**Edite estas linhas** (troque pelos seus valores):

```
DATABASE_URL=postgresql://postgres:SUA_SENHA_AQUI@localhost:5432/utm_tracker
JWT_SECRET=uma-frase-muito-longa-e-aleatoria-que-ninguem-vai-adivinhar-123456
FRONTEND_URL=http://localhost:5555
```

⚠️ **Troque `SUA_SENHA_AQUI` pela senha que você definiu na instalação do PostgreSQL.**

Salve o arquivo (Ctrl+S) e feche o Bloco de Notas.

---

## 🚀 PASSO 3 — Criar as tabelas no banco

No PowerShell (ainda na pasta backend), cole:

```powershell
npm run db:init
```

Deve aparecer:
```
🔄 Inicializando banco de dados...
✅ Banco de dados inicializado com sucesso!
```

---

## 🚀 PASSO 4 — Gerar dados de demonstração (opcional)

Pra você ver a plataforma com dados fictícios (50 visitantes, vendas, etc.):

```powershell
npm run db:seed
```

Deve aparecer:
```
✅ Dados de demonstração gerados com sucesso!
Login demo: demo@utmtracker.com / senha: demo123
```

---

## 🚀 PASSO 5 — Rodar o backend

No PowerShell, cole:

```powershell
npm run dev
```

Deve aparecer:
```
🚀 UTM Tracker Backend rodando em http://localhost:3000
📊 Frontend URL: http://localhost:5555
 NODE_ENV: development
 DATABASE_URL: ✓ Configurado
```

✅ **O backend está rodando!** Não feche esta janela do PowerShell.

---

## 🚀 PASSO 6 — Abrir o frontend

Abra **outra janela** do PowerShell (menu Iniciar → PowerShell novamente).

Cole:

```powershell
cd C:\Users\Joaov\Downloads\claude\utm-tracker\frontend
```

```powershell
npx serve -l 5555
```

⏳ Na primeira vez vai perguntar "Ok to proceed? (y)" — digite `y` e Enter.

Deve aparecer:
```
Serving!
- Local:    http://localhost:5555
```

---

## 🚀 PASSO 7 — Acessar a plataforma

Abra o **Chrome** (ou qualquer navegador) e acesse:

```
http://localhost:5555
```

Vai aparecer a tela de login. 🎉

### Opção A — Usar conta demo (se você rodou o Passo 4):
- Email: `demo@utmtracker.com`
- Senha: `demo123`

### Opção B — Criar sua conta:
- Clique em "Cadastre-se"
- Preencha nome, email e senha
- Clique em "Criar Conta"

---

## 🎮 COMO USAR A PLATAFORMA

### 1. Dashboard (tela inicial)
Mostra:
- Investimento, Receita, Vendas, Leads, Cliques
- CPA, CPL, ROAS, Ticket Médio, Lucro
- Gráficos de receita, vendas, cliques ao longo do tempo
- Vendas recentes em tempo real

Mude o período no topo: Hoje / Ontem / 7 dias / 30 dias.

### 2. Gerar Link Rastreável
- Clique em **"Links"** no menu lateral
- Clique em **"+ Gerar Link Rastreável"**
- Preencha:
  - URL de destino: `https://meusite.com/oferta`
  - utm_source: `tiktok`
  - utm_medium: `paid`
  - utm_campaign: `campanha_setembro`
  - campaign_id: `123456` (ID da campanha no TikTok/Meta)
  - ad_id: `789` (ID do anúncio)
- Clique em **"Gerar Link"**
- Copie o link gerado e use nos seus anúncios

### 3. Instalar o Script de Tracking no seu site
- Clique em **"Tracking"** no menu lateral
- Copie o código que aparece
- Cole no seu site **antes do `</body>`**:
  ```html
  <script src="http://localhost:3000/tracking.js" data-api="http://localhost:3000/api/track"></script>
  ```
- Quando alguém acessar seu site com UTMs, o script registra automaticamente

### 4. Configurar Webhook de Vendas
- Clique em **"Webhooks"** no menu lateral
- Copie a URL que aparece em "Endpoint de Webhook para Vendas"
- Na sua plataforma de pagamento (Hotmart, Kiwify, Stripe, etc.), cole essa URL como webhook
- Quando uma venda acontecer, ela aparece **instantaneamente** no dashboard

### 5. Ver Vendas e Jornada do Cliente
- Clique em **"Vendas"** no menu lateral
- Veja todas as vendas com origem, campanha, valor, status
- Clique em **"Ver Jornada"** pra ver o funil completo:
  - Anúncio → Clique → Landing Page → Lead → Checkout → Compra

### 6. Conectar Plataformas (Meta Ads, TikTok, Google)
- Clique em **"Integrações"** no menu lateral
- Por enquanto mostra "Estrutura pronta" — quando você tiver as chaves de API, é só colar aqui
- Não inventa integração falsa — só mostra o que realmente está conectado

---

## 🛑 COMO PARAR TUDO

Quando quiser parar a plataforma:

1. Na janela do PowerShell do **backend**, aperte `Ctrl+C`
2. Na janela do PowerShell do **frontend**, aperte `Ctrl+C`
3. Pronto, tudo parou

---

## 🔄 COMO RODAR DE NOVO DEPOIS

Da próxima vez que quiser usar:

1. Abra PowerShell → `cd C:\Users\Joaov\Downloads\claude\utm-tracker\backend` → `npm run dev`
2. Abra outro PowerShell → `cd C:\Users\Joaov\Downloads\claude\utm-tracker\frontend` → `npx serve -l 5555`
3. Acesse `http://localhost:5555` no navegador

---

## ❓ PROBLEMAS COMUNS

| Problema | Solução |
|----------|---------|
| "node não é reconhecido" | Reinstale o Node.js e reinicie o PowerShell |
| "psql não é reconhecido" | Adicione `C:\Program Files\PostgreSQL\16\bin` nas variáveis de ambiente do Windows |
| "Erro de conexão com banco" | Confira se a senha no `.env` é a mesma da instalação do PostgreSQL |
| "Port 3000 already in use" | Feche qualquer outro programa usando a porta 3000, ou mude `PORT=3001` no `.env` |
| "Página em branco" | Confira se o backend está rodando (Passo 5) antes de abrir o frontend |
| "CORS error" | Confira se `FRONTEND_URL=http://localhost:5555` no `.env` |

---

## 🌐 COMO COLOCAR NA INTERNET (DEPOIS)

Quando quiser que outras pessoas acessem (não só no seu computador):

### Backend → Railway (grátis)
1. Crie conta em railway.app
2. Suba a pasta `backend/` pro GitHub
3. Importe no Railway
4. Adicione variáveis de ambiente (igual o `.env`)
5. Use PostgreSQL gerenciado do Railway

### Frontend → Vercel (grátis)
1. Crie conta em vercel.com
2. Suba a pasta `frontend/` pro GitHub
3. Importe no Vercel
4. Configure a variável `API_URL` apontando pro Railway

---

## 📞 PRECISA DE AJUDA?

Se travar em algum passo, me mande:
1. **Print da tela** onde travou
2. **Mensagem de erro completa** (copie e cole)
3. **Qual passo** você estava seguindo

Eu te ajudo a resolver rapidinho.

---

**Pronto!** Agora é só seguir os passos 1-7 e você vai ter a plataforma rodando no seu computador. 🚀