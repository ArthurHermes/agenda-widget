# Agenda Widget

Widget de área de trabalho (Windows) para a Google Agenda: várias contas, criar/editar/excluir
eventos e aparência totalmente customizável. Feito com Tauri 2 (Rust + WebView2), sem bundler.

## Instalar

1. Baixe o `Agenda-Widget_x.y.z_x64-setup.exe` em [**Releases**](https://github.com/ArthurHermes/agenda-widget/releases/latest).
2. Execute. Como o instalador não é assinado digitalmente, o Windows pode mostrar
   "O Windows protegeu o computador": clique em **Mais informações → Executar assim mesmo**.
3. O widget aparece no canto superior direito e um ícone fica na bandeja do sistema (perto do relógio).

Requer Windows 10/11 (o WebView2 já vem no Windows 11; no 10 o instalador baixa se faltar).

## Primeiro uso: conectar contas Google

O widget usa a Google Calendar API com OAuth, e para isso você precisa de um "app" seu no
Google Cloud (gratuito, feito uma vez só). O passo a passo também está em ⚙ → Contas Google.

1. [Google Cloud Console](https://console.cloud.google.com/projectcreate): crie um projeto.
2. Ative a [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com).
3. Em [Google Auth Platform](https://console.cloud.google.com/auth/overview): **Começar** → nome, tipo **Externo**, seu e-mail.
4. Em **Público-alvo**: **Publicar app** (em produção). No modo "Teste", cada conta precisa estar
   na lista de usuários de teste e o login expira a cada 7 dias.
5. Em [Clientes](https://console.cloud.google.com/auth/clients): **Criar cliente** → **App para computador**.
   Copie o ID e a chave secreta para ⚙ → Contas Google.
6. Clique em **Conectar conta Google** e repita para cada conta. No aviso "app não verificado",
   clique em **Avançado → Acessar** (o app é seu).

Os tokens ficam no **Gerenciador de Credenciais do Windows** (`agenda-widget`), não no arquivo de config.
A config fica em `%APPDATA%\dev.local.agenda-widget\config.json`.

## O que dá para fazer

- **Contas e agendas:** várias contas; escolha quais agendas de cada conta aparecem e a cor de cada uma.
- **Links iCal:** agendas extras somente leitura (feriados, agendas de terceiros).
- **Eventos:** clique para editar, ＋ no topo ou ao lado de cada dia para criar. Dá para trocar a
  agenda, inclusive para outra conta. Em eventos recorrentes, a edição vale só para a ocorrência clicada.
- **Aparência (prévia ao vivo):** temas prontos, cores de fundo/texto/destaque, opacidade, fonte,
  tamanho do texto, cantos, borda, layout lista ou compacto, e o que mostrar (cabeçalho, rodapé,
  local, nome da agenda, eventos passados, dias vazios, botões).
- **Janela:** posição e tamanho numéricos (ou arrastando), cantos e tamanhos pré-definidos,
  camada (área de trabalho / normal / sempre no topo) e travar posição.
- **Atravessar cliques:** os cliques passam para os ícones e janelas atrás do widget; segure **Ctrl**
  com o mouse em cima para usá-lo (aparece uma borda colorida). Opcionalmente, ele fica quase
  invisível quando o mouse passa por cima. Liga e desliga em ⚙ → Posição e janela ou pela bandeja.
- **Bandeja:** clique no ícone para mostrar/esconder o widget. Menu: atravessar cliques, atualizar, configurações, trazer para o canto, iniciar com o Windows, sair.

## Desenvolvimento

Requisitos: Node, Rust (MSVC) e WebView2 (já vem no Windows 11).

```bash
npm install
npm run dev      # modo debug
npm run build    # instalador em target/release/bundle/nsis
```

Em caminhos muito longos, o linker do MSVC falha (LNK1104): mova a pasta para um caminho curto
ou defina `CARGO_TARGET_DIR`.

## Estrutura

- `src/index.html`, `main.js`, `style.css`: o widget.
- `src/settings.*`: janela de configurações (rascunho com prévia ao vivo, só grava ao salvar).
- `src/event.*`: editor de evento.
- `src/lib/config.js`: padrões e migração da config. `lib/google.js`: chamadas à API. `lib/sources.js`: junta as fontes.
- `src/events.js`: leitura de `.ics` (recorrências, exceções, fusos).
- `src-tauri/src/google.rs`: OAuth (PKCE + loopback), tokens no cofre do Windows e proxy da API.
- `src-tauri/src/window.rs`: posição, camada, travamento e janelas extras.
