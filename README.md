# Piano Compartilhado - Sistema P2P 🎹

Um piano digital multi-user de alta performance, focado em experimentação sonora e colaboração em tempo real através do navegador.

O **Piano Compartilhado - Sistema P2P** permite que múltiplos usuários toquem no mesmo teclado virtual simultaneamente, com feedback visual dinâmico e processamento de áudio de baixa latência.

## 🚀 Funcionalidades Principais

- **Multi-User Real-time**: Sistema de salas privadas para tocar com amigos em tempo real. As notas trafegam direto entre os navegadores via **WebRTC (DataChannel)**; um pequeno servidor Node.js cuida só da parte de apresentação entre os peers (quem está na sala, troca de offer/answer/ICE). Abas do mesmo navegador também sincronizam via **BroadcastChannel**.
- **Audio Engine Dinâmica**: Osciladores nativos com suporte a 4 formas de onda (Sine, Square, Sawtooth, Triangle).
- **Visualizer Trails**: Sistema de partículas que gera rastros de cores baseados na nota tocada.
- **Customização Total**: Ajuste de oitava (com feedback sonoro), volume, sustain e efeitos visuais.
- **Interface Dark**: Design minimalista e moderno otimizado para o conforto visual.

## 💡 Inspiração e Créditos

Este projeto possui semelhanças funcionais com o Shared Piano do Google (Chrome Music Lab). É importante ressaltar que o desenvolvedor não copiou o código original; o Shared Piano serviu apenas como uma inspiração conceitual para a criação e desenvolvimento independente do Piano Compartilhado - Sistema P2P.

## 🔒 Privacidade & Segurança (Under 18 Safe)

Este projeto foi desenvolvido com foco total na privacidade e segurança, alinhado com princípios de proteção digital (como os debatidos no contexto do ECA Digital e segurança para menores):

- **Sem Coleta de Dados**: O servidor não grava nomes, e-mails, IPs ou qualquer informação pessoal em disco ou banco de dados — tudo existe só em memória, enquanto a sala está ativa, e some quando o usuário desconecta.
- **Ambiente Seguro**: Sem chat de texto ou troca de arquivos, eliminando riscos de assédio ou exposição a conteúdo impróprio.
- **Áudio sempre Peer-to-Peer**: O som das notas nunca passa pelo servidor — vai direto de um navegador para o outro via WebRTC. O servidor participa apenas do "aperto de mão" inicial entre os peers (sinalização), de forma efêmera e sem persistência.
- **Identidade Animal**: Uso de Emojis aleatórios para manter o anonimato de forma lúdica e segura.

## 📂 Como Hospedar

O projeto agora tem um pequeno backend em Node.js (responsável pela sinalização das salas), então não roda mais só como site estático — GitHub Pages sozinho não é suficiente. A combinação usada é **GitHub + Render**:

1. Suba o projeto para um repositório no GitHub (`git init`, `git add .`, `git commit`, `git push`).
2. No [Render](https://render.com), crie um **New > Web Service** apontando para esse repositório (o projeto já inclui `render.yaml` com a configuração pronta).
3. Build Command: `npm install` · Start Command: `npm start`. A porta é lida automaticamente de `process.env.PORT`.
4. Ao terminar o deploy, o Render fornece uma URL pública (`https://seu-app.onrender.com`) já com suporte a WebSocket/WebRTC funcionando sem configuração extra.

## 💻 Estrutura Técnica

- **Gráficos**: HTML5 Canvas API.
- **Som**: Web Audio API.
- **Rede**: WebRTC (DataChannel P2P) com sinalização própria via WebSocket, mais BroadcastChannel para abas do mesmo navegador.
- **Backend**: Node.js + Express + `ws` — só gerencia salas e repassa mensagens de sinalização, sem armazenar histórico.
- **Estilização**: Tailwind CSS.

## 📝 Licença

Distribuído sob a Licença MIT.

Desenvolvido com ❤️ por **Pane Developer**
