// Importa os módulos necessários
const express = require('express');
const http = require('http'); // Módulo HTTP do Node.js para criar o servidor
const socketIo = require('socket.io'); // Socket.IO para comunicação em tempo real
const path = require('path'); // Para lidar com caminhos de arquivos

// Configuração básica do Express
const app = express();
const server = http.createServer(app); // Cria um servidor HTTP a partir do app Express

// Configura o Socket.IO para trabalhar com o servidor HTTP
const io = new socketIo.Server(server);

// Define a porta em que o servidor irá escutar.
// process.env.PORT é uma variável de ambiente que o Render.com injeta.
// Se não estiver definida (ex: ao rodar localmente), usa a porta 3000.
const PORT = process.env.PORT || 3000;

// --- Configuração para Servir Arquivos Estáticos ---
// Serve os arquivos da pasta 'public' (HTML, CSS, JS do front-end)
app.use(express.static(path.join(__dirname, 'public')));

// --- Rota para a URL Raiz ---
// Garante que ao acessar a URL base (ex: https://seu-app.onrender.com/),
// o arquivo index.html seja servido automaticamente.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Lógica do Servidor Socket.IO ---

// Armazenamento simples de usuários e salas (em memória, não persistente)
// userSocketId -> { nickname, currentRoom }
const users = {}; 
// roomName -> { users: [userSocketIds...] }
const rooms = {
  'general': { users: [] },
  'random': { users: [] }
}; 

// Mapas para o WebRTC (para chamadas 1-para-1)
// socketId -> { peerSocketId }
const activeCalls = {}; 
// Set de socketIds de usuários que estão atualmente em uma chamada
const usersInCall = new Set(); 

io.on('connection', (socket) => {
  console.log('Novo usuário conectado:', socket.id);

  // --- Gerenciamento de Usuários e Salas ---
  socket.on('set nickname', (nickname) => {
    // Verifica se o apelido já está em uso
    if (Object.values(users).some(u => u.nickname === nickname)) {
      socket.emit('nickname error', 'Apelido já em uso. Por favor, escolha outro.');
      return;
    }
    
    // Armazena as informações do usuário
    const userId = socket.id;
    users[userId] = { socketId: userId, nickname: nickname, currentRoom: 'general' };
    socket.join('general'); // Adiciona o usuário à sala 'general' por padrão

    // Adiciona o usuário à lista da sala
    if (!rooms['general'].users.includes(userId)) {
        rooms['general'].users.push(userId);
    }

    // Notifica o cliente que o apelido foi definido e o chat pode ser mostrado
    socket.emit('nickname set', nickname);
    // Notifica os outros usuários da sala que um novo usuário entrou
    io.to('general').emit('user joined', nickname);
    // Atualiza a lista de usuários para todos na sala 'general'
    updateRoomUsersList('general'); 

    console.log(`Usuário ${nickname} (${userId}) entrou na sala general.`);
  });

  socket.on('join room', (roomName) => {
    const user = users[socket.id];
    if (!user) {
      socket.emit('chat message', 'Erro: Defina seu apelido primeiro.');
      return;
    }

    // Se a sala não existe, cria
    if (!rooms[roomName]) {
      rooms[roomName] = { users: [] }; 
    }

    // Sai da sala anterior, se houver
    if (user.currentRoom) {
      socket.leave(user.currentRoom);
      const oldRoomUsers = rooms[user.currentRoom].users;
      rooms[user.currentRoom].users = oldRoomUsers.filter(id => id !== socket.id);
      io.to(user.currentRoom).emit('user left', user.nickname);
      updateRoomUsersList(user.currentRoom);
    }

    // Entra na nova sala
    socket.join(roomName);
    user.currentRoom = roomName;
    if (!rooms[roomName].users.includes(socket.id)) {
        rooms[roomName].users.push(socket.id);
    }
    io.to(roomName).emit('user joined', user.nickname);
    updateRoomUsersList(roomName); // Atualiza lista para a nova sala

    socket.emit('room joined', roomName);
    console.log(`Usuário ${user.nickname} (${socket.id}) entrou na sala ${roomName}.`);
  });

  // --- Lógica de Chat ---
  socket.on('chat message', (msg) => {
    const user = users[socket.id];
    if (user) {
      // Envia a mensagem para todos na sala atual do usuário
      io.to(user.currentRoom).emit('chat message', `${user.nickname}: ${msg}`);
      console.log(`Mensagem na sala ${user.currentRoom} de ${user.nickname}: ${msg}`);
    }
  });

  // --- Lógica de WebRTC (Signaling para Áudio) ---

  // Lidar com oferta (SDP) de um peer
  socket.on('offer', (id, description) => {
    const user = users[socket.id];
    const targetUser = users[id];
    if (!user || !targetUser) {
      console.warn(`Oferta recebida, mas usuário ou alvo não encontrados. De: ${socket.id}, Para: ${id}`);
      return;
    }
    console.log(`Offer de ${user.nickname} para ${targetUser.nickname}`);
    // Encaminha a oferta para o peer de destino
    socket.to(id).emit('offer', socket.id, description);
  });

  // Lidar com resposta (SDP) de um peer
  socket.on('answer', (id, description) => {
    const user = users[socket.id];
    const targetUser = users[id];
     if (!user || !targetUser) {
      console.warn(`Resposta recebida, mas usuário ou alvo não encontrados. De: ${socket.id}, Para: ${id}`);
      return;
    }
    console.log(`Answer de ${user.nickname} para ${targetUser.nickname}`);
    // Encaminha a resposta para o peer de origem da oferta
    socket.to(id).emit('answer', socket.id, description);
  });

  // Lidar com candidatos ICE (informações de rede)
  socket.on('candidate', (id, candidate) => {
    const user = users[socket.id];
    const targetUser = users[id];
     if (!user || !targetUser) {
      console.warn(`Candidato recebido, mas usuário ou alvo não encontrados. De: ${socket.id}, Para: ${id}`);
      return;
    }
    console.log(`Candidate de ${user.nickname} para ${targetUser.nickname}`);
    // Encaminha o candidato ICE para o peer de destino
    socket.to(id).emit('candidate', socket.id, candidate);
  });

  // Iniciar uma chamada de áudio
  socket.on('start call', (targetSocketId) => {
    const caller = users[socket.id];
    const receiver = users[targetSocketId];

    if (!caller || !receiver) {
      socket.emit('call error', 'Usuário não encontrado para a chamada.');
      return;
    }
    if (usersInCall.has(socket.id) || usersInCall.has(targetSocketId)) {
        socket.emit('call error', `${receiver.nickname} ou você já está em uma chamada.`);
        return;
    }

    console.log(`${caller.nickname} (${socket.id}) está chamando ${receiver.nickname} (${targetSocketId})`);
    // Notifica o receptor sobre a chamada
    socket.to(targetSocketId).emit('incoming call', socket.id, caller.nickname);
    
    // Marca ambos como "em chamada"
    usersInCall.add(socket.id);
    usersInCall.add(targetSocketId);
    activeCalls[socket.id] = { peerSocketId: targetSocketId }; 
    activeCalls[targetSocketId] = { peerSocketId: socket.id };

    // Atualiza o status visual dos usuários nas suas respectivas salas
    updateRoomUsersList(caller.currentRoom);
    if (caller.currentRoom !== receiver.currentRoom) {
        updateRoomUsersList(receiver.currentRoom);
    }
  });

  // Lidar com o usuário aceitando a chamada
  socket.on('accept call', (callerSocketId) => {
    const receiver = users[socket.id];
    const caller = users[callerSocketId];

    if (!receiver || !caller || !activeCalls[socket.id] || activeCalls[socket.id].peerSocketId !== callerSocketId) {
        socket.emit('call error', 'Chamada inválida ou não existente.');
        return;
    }

    console.log(`${receiver.nickname} (${socket.id}) aceitou a chamada de ${caller.nickname} (${callerSocketId})`);
    // Notifica o chamador que a chamada foi aceita
    socket.to(callerSocketId).emit('call accepted', socket.id);
    // Emite para ambos a informação que a chamada foi estabelecida
    io.to(caller.currentRoom).emit('call established', caller.nickname, receiver.nickname);
  });

  // Lidar com o usuário recusando/encerrando a chamada
  socket.on('end call', (targetSocketId) => {
    const user = users[socket.id];
    const peerUser = users[targetSocketId];

    if (user) {
        console.log(`${user.nickname} (${socket.id}) encerrou a chamada com ${peerUser ? peerUser.nickname : 'desconhecido'}.`);
        
        // Remove dos sets de chamada
        usersInCall.delete(socket.id);
        usersInCall.delete(targetSocketId);

        // Limpa registros de chamadas ativas
        delete activeCalls[socket.id];
        delete activeCalls[targetSocketId];

        // Notifica o outro peer que a chamada foi encerrada
        if (peerUser) {
            socket.to(targetSocketId).emit('call ended', socket.id);
            updateRoomUsersList(peerUser.currentRoom);
        }
        updateRoomUsersList(user.currentRoom);
    }
  });


  // --- Desconexão ---
  socket.on('disconnect', () => {
    const user = users[socket.id];
    if (user) {
      console.log(`Usuário ${user.nickname} (${socket.id}) desconectou.`);
      // Remove o usuário da sala
      if (user.currentRoom && rooms[user.currentRoom]) {
        const roomUsers = rooms[user.currentRoom].users;
        rooms[user.currentRoom].users = roomUsers.filter(id => id !== socket.id);
        io.to(user.currentRoom).emit('user left', user.nickname);
        updateRoomUsersList(user.currentRoom);
      }

      // Se o usuário estava em uma chamada, encerra a chamada para o outro peer
      if (usersInCall.has(socket.id)) {
          usersInCall.delete(socket.id);
          const peerId = activeCalls[socket.id]?.peerSocketId;
          if (peerId && usersInCall.has(peerId)) {
              usersInCall.delete(peerId);
              delete activeCalls[peerId];
              socket.to(peerId).emit('call ended', socket.id);
              if (users[peerId]) { // Garante que o peer ainda está conectado
                  updateRoomUsersList(users[peerId].currentRoom);
              }
          }
          delete activeCalls[socket.id];
      }
      delete users[socket.id];
    }
  });

  // Função auxiliar para atualizar a lista de usuários em uma sala
  function updateRoomUsersList(roomName) {
    if (rooms[roomName]) {
      const userListForRoom = rooms[roomName].users;
      const nicknamesWithStatus = userListForRoom
        .map(id => users[id] ? `${users[id].nickname}:${id}${usersInCall.has(id) ? ' (em chamada)' : ''}` : null)
        .filter(n => n !== null); // Filtra nulos se houver usuários desconectados mas ainda no array
      
      io.to(roomName).emit('room users', nicknamesWithStatus);
    }
  }

});

// Inicia o servidor HTTP e Socket.IO
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Acesse localmente: http://localhost:${PORT}`);
});
