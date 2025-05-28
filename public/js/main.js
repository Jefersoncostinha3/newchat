// --- Elementos do DOM ---
const nicknameScreen = document.getElementById('nickname-screen');
const nicknameInput = document.getElementById('nickname-input');
const setNicknameBtn = document.getElementById('set-nickname-btn');
const nicknameError = document.getElementById('nickname-error');

const chatScreen = document.getElementById('chat-screen');
const messagesDiv = document.getElementById('messages');
const messageInput = document.getElementById('message-input');
const sendMessageBtn = document.getElementById('send-message-btn');

const roomList = document.getElementById('room-list');
const usersList = document.getElementById('users-list');
const currentRoomNameSpan = document.getElementById('current-room-name');
const newRoomInput = document.getElementById('new-room-input');
const joinNewRoomBtn = document.getElementById('join-new-room-btn');

const callControls = document.getElementById('call-controls');
const callStatus = document.getElementById('call-status');
const endCallBtn = document.getElementById('end-call-btn');
const muteUnmuteBtn = document.getElementById('mute-unmute-btn');

const callModal = document.getElementById('call-modal');
const incomingCallMessage = document.getElementById('incoming-call-message');
const acceptCallBtn = document.getElementById('accept-call-btn');
const declineCallBtn = document.getElementById('decline-call-btn');

// --- Variáveis Globais ---
const socket = io(); // Conecta ao servidor Socket.IO
let myNickname = '';
let currentRoom = 'general';
let localStream; // Stream de áudio do usuário local
let peerConnection; // Objeto RTCPeerConnection para a chamada
let callingPeerId = null; // ID do socket do usuário que está em chamada com a gente (ou quem nos chamou)
let isMuted = false;
let usersData = {}; // Objeto para mapear socketId -> nickname (e outros dados se necessário)

// --- STUN Servers (para WebRTC) ---
// Usados para ajudar a estabelecer a conexão P2P (Peer-to-Peer) entre os usuários.
// São servidores públicos que ajudam os navegadores a descobrir seus IPs públicos.
const iceServers = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        // Para redes mais restritivas (NATs simétricos), seria necessário um servidor TURN,
        // que atua como um retransmissor e geralmente tem custos associados.
    ]
};

// --- Funções de UI ---

function addMessage(msg, type = 'chat') {
    const p = document.createElement('p');
    p.classList.add('message');
    if (type === 'system') {
        p.classList.add('system-message');
    }
    p.textContent = msg;
    messagesDiv.appendChild(p);
    // Rola para o final para mostrar a mensagem mais recente
    messagesDiv.scrollTop = messagesDiv.scrollHeight; 
}

function showChatScreen() {
    nicknameScreen.style.display = 'none';
    chatScreen.style.display = 'flex';
}

function showCallControls(statusMsg) {
    callStatus.textContent = statusMsg;
    callControls.style.display = 'flex';
    endCallBtn.style.display = 'inline-block';
    muteUnmuteBtn.style.display = 'inline-block';
}

function hideCallControls() {
    callControls.style.display = 'none';
    endCallBtn.style.display = 'none';
    muteUnmuteBtn.style.display = 'none';
    callStatus.textContent = '';
}

function showCallModal(message) {
    incomingCallMessage.textContent = message;
    callModal.style.display = 'flex';
}

function hideCallModal() {
    callModal.style.display = 'none';
}

// Atualiza a lista de usuários na barra lateral
function updateUsersList(users) {
    usersList.innerHTML = ''; // Limpa a lista atual
    usersData = {}; // Limpa o mapa de dados dos usuários

    users.forEach(userFullString => {
        const li = document.createElement('li');
        // A string do usuário vem como "Nickname:socketId (status)"
        let userDisplayName = userFullString;
        let isUserInCall = false;

        // Verifica se o usuário está em chamada e extrai o display name
        if (userFullString.includes(' (em chamada)')) {
            userDisplayName = userFullString.replace(' (em chamada)', '');
            isUserInCall = true;
        }

        const parts = userDisplayName.split(':');
        const nickname = parts[0];
        const socketId = parts.length > 1 ? parts[1] : '';

        usersData[socketId] = { nickname: nickname, inCall: isUserInCall };

        li.innerHTML = `<span>${nickname}</span>`;
        // Armazena o socketId no elemento da lista para facilitar a referência
        li.dataset.socketId = socketId; 
        
        // Adiciona botão de chamada se não for o próprio usuário
        if (socketId !== socket.id) {
            const callBtn = document.createElement('button');
            callBtn.classList.add('call-btn');
            callBtn.textContent = isUserInCall ? 'Em Chamada' : 'Ligar';
            callBtn.disabled = isUserInCall; // Desabilita se o usuário já estiver em chamada
            callBtn.onclick = () => startCall(socketId, nickname);
            li.appendChild(callBtn);
        }
        usersList.appendChild(li);
    });
}


// --- Lógica de Socket.IO ---

// Evento de clique para definir o apelido
setNicknameBtn.addEventListener('click', () => {
    const nickname = nicknameInput.value.trim();
    if (nickname) {
        socket.emit('set nickname', nickname);
    } else {
        nicknameError.textContent = 'Por favor, insira um apelido.';
    }
});

// Resposta do servidor sobre erro no apelido
socket.on('nickname error', (message) => {
    nicknameError.textContent = message;
});

// Resposta do servidor quando o apelido é definido com sucesso
socket.on('nickname set', (nickname) => {
    myNickname = nickname;
    showChatScreen();
    addMessage(`Bem-vindo, ${myNickname}! Você está na sala #${currentRoom}.`, 'system');
});

// Evento de clique para enviar mensagem
sendMessageBtn.addEventListener('click', () => {
    const message = messageInput.value.trim();
    if (message) {
        socket.emit('chat message', message);
        messageInput.value = '';
    }
});

// Envia mensagem ao pressionar Enter no input
messageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        sendMessageBtn.click();
    }
});

// Recebe mensagens do chat do servidor
socket.on('chat message', (msg) => {
    addMessage(msg);
});

// Notificação de usuário entrando na sala
socket.on('user joined', (nickname) => {
    addMessage(`${nickname} entrou na sala.`, 'system');
});

// Notificação de usuário saindo da sala
socket.on('user left', (nickname) => {
    addMessage(`${nickname} saiu da sala.`, 'system');
});

// Atualiza a lista de usuários quando o servidor envia
socket.on('room users', (users) => {
    updateUsersList(users);
});

// Notificação de entrada em uma nova sala
socket.on('room joined', (roomName) => {
    currentRoom = roomName;
    currentRoomNameSpan.textContent = `#${roomName}`;
    messagesDiv.innerHTML = ''; // Limpa mensagens ao mudar de sala
    addMessage(`Você entrou na sala #${roomName}.`, 'system');
});

// --- Lógica de Sala ---
roomList.addEventListener('click', (e) => {
    if (e.target.tagName === 'LI') {
        const newRoom = e.target.dataset.room;
        if (newRoom && newRoom !== currentRoom) {
            socket.emit('join room', newRoom);
            // Atualiza o estado visual da sala ativa
            document.querySelector('.active-room')?.classList.remove('active-room');
            e.target.classList.add('active-room');
        }
    }
});

// Botão para criar/entrar em uma nova sala
joinNewRoomBtn.addEventListener('click', () => {
    // Limpa o nome da sala (apenas letras, números e hífens, minúsculas)
    const roomName = newRoomInput.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, ''); 
    if (roomName && roomName !== currentRoom) {
        socket.emit('join room', roomName);
        // Adiciona a nova sala à lista se ainda não estiver lá
        if (!document.querySelector(`[data-room="${roomName}"]`)) {
            const li = document.createElement('li');
            li.dataset.room = roomName;
            li.textContent = `#${roomName}`;
            roomList.appendChild(li);
        }
        newRoomInput.value = '';
        // Atualiza o destaque da sala ativa
        document.querySelector('.active-room')?.classList.remove('active-room');
        document.querySelector(`[data-room="${roomName}"]`).classList.add('active-room');
    }
});


// --- Lógica de WebRTC (Chamadas de Áudio) ---

// Função para iniciar a chamada
async function startCall(targetSocketId, targetNickname) {
    // Impede iniciar uma chamada se já estiver em uma
    if (callingPeerId) {
        alert('Você já está em uma chamada!');
        return;
    }
    // Impede ligar para si mesmo
    if (targetSocketId === socket.id) {
        alert('Você não pode ligar para si mesmo.');
        return;
    }

    // Atualiza o estado da UI para indicar que a chamada está iniciando
    callingPeerId = targetSocketId;
    showCallControls(`Chamando ${targetNickname}...`);

    try {
        // Pede acesso ao microfone do usuário
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

        // Cria a conexão peer-to-peer (RTCPeerConnection)
        peerConnection = new RTCPeerConnection(iceServers);

        // Adiciona a trilha de áudio local à conexão
        localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

        // Evento que dispara quando a conexão recebe uma trilha de áudio/vídeo do peer remoto
        peerConnection.ontrack = (event) => {
            console.log('Recebendo trilha de áudio remota...');
            const remoteAudio = new Audio(); // Cria um elemento de áudio HTML
            remoteAudio.srcObject = event.streams[0]; // Associa o stream remoto ao elemento
            remoteAudio.play(); // Começa a tocar o áudio remoto
        };

        // Evento para coletar candidatos ICE (informações de rede para estabelecer a conexão)
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                // Envia o candidato ICE para o peer remoto via servidor Socket.IO
                socket.emit('candidate', callingPeerId, event.candidate);
            }
        };

        // Cria a oferta SDP (Session Description Protocol)
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);

        // Envia a oferta para o peer remoto via servidor Socket.IO
        socket.emit('offer', callingPeerId, peerConnection.localDescription);
        
        // Notifica o servidor que esta chamada está sendo iniciada
        socket.emit('start call', callingPeerId);

    } catch (error) {
        console.error('Erro ao iniciar chamada:', error);
        alert('Não foi possível iniciar a chamada. Verifique se seu microfone está conectado e se você permitiu o acesso.');
        endCurrentCall(); // Limpa o estado da chamada em caso de erro
    }
}

// Lida com oferta recebida de outro peer (alguém está nos ligando)
socket.on('offer', async (id, description) => {
    if (callingPeerId) { // Se já estamos em uma chamada ou chamando alguém
        socket.emit('end call', id); // Notifica o outro lado para recusar implicitamente
        return;
    }

    callingPeerId = id; // Define o chamador
    showCallModal(`${usersData[id]?.nickname || id} está te ligando!`); // Exibe o modal de chamada recebida

    peerConnection = new RTCPeerConnection(iceServers);

    // Tenta obter acesso ao microfone local imediatamente
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
    } catch (e) {
        console.warn('Não conseguiu obter stream local antes de aceitar a chamada:', e);
        // Se o usuário não permitir, o stream local será nulo e a chamada poderá falhar.
        // O user precisará aceitar o microfone ao clicar em "Aceitar"
    }

    peerConnection.ontrack = (event) => {
        console.log('Recebendo trilha de áudio remota na oferta...');
        const remoteAudio = new Audio();
        remoteAudio.srcObject = event.streams[0];
        remoteAudio.play();
    };

    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('candidate', callingPeerId, event.candidate);
        }
    };

    await peerConnection.setRemoteDescription(description);
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit('answer', callingPeerId, peerConnection.localDescription);
});

// Lida com resposta recebida (após ter enviado uma oferta)
socket.on('answer', async (id, description) => {
    // Garante que a descrição remota não foi setada antes de adicionar
    if (peerConnection && peerConnection.remoteDescription === null) { 
        await peerConnection.setRemoteDescription(description);
        showCallControls(`Em chamada com ${usersData[id]?.nickname || id}`);
    }
});

// Lida com candidatos ICE recebidos (para ajudar na conexão direta)
socket.on('candidate', async (id, candidate) => {
    try {
        if (peerConnection && candidate) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        }
    } catch (e) {
        console.error('Erro ao adicionar candidato ICE:', e);
        // Erros aqui podem ocorrer se o peer já se desconectou ou a conexão foi fechada.
    }
});

// Notificação do servidor quando a chamada é estabelecida
socket.on('call established', (callerNickname, receiverNickname) => {
    addMessage(`${callerNickname} e ${receiverNickname} iniciaram uma chamada de áudio.`, 'system');
});

// Lida quando a chamada é encerrada por outro peer
socket.on('call ended', (peerId) => {
    if (callingPeerId === peerId) {
        endCurrentCall(); // Encerra a chamada no lado do cliente
        addMessage(`${usersData[peerId]?.nickname || peerId} encerrou a chamada.`, 'system');
    }
});

// Lida com erros de chamada do servidor
socket.on('call error', (message) => {
    alert('Erro na chamada: ' + message);
    endCurrentCall(); // Limpa o estado se houver erro
});


// --- Controles de Chamada (Botões) ---

// Aceitar Chamada
acceptCallBtn.addEventListener('click', async () => {
    hideCallModal(); // Esconde o modal de chamada recebida
    if (peerConnection && callingPeerId) {
        // Se a stream local ainda não foi obtida (ex: permissão negada antes), tenta agora
        if (!localStream) {
            try {
                localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
                localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
            } catch (e) {
                console.error('Falha ao obter microfone ao aceitar chamada:', e);
                alert('Não foi possível acessar seu microfone. A chamada não poderá ser estabelecida.');
                endCurrentCall();
                return;
            }
        }
        // Notifica o servidor que a chamada foi aceita
        socket.emit('accept call', callingPeerId);
        showCallControls(`Em chamada com ${usersData[callingPeerId]?.nickname || callingPeerId}`);
    } else {
        console.error('Estado inválido para aceitar chamada.');
        endCurrentCall();
    }
});


// Recusar Chamada
declineCallBtn.addEventListener('click', () => {
    if (callingPeerId) {
        socket.emit('end call', callingPeerId); // Notifica o chamador que a chamada foi recusada
        endCurrentCall();
    }
    hideCallModal();
});

// Encerrar Chamada (Botão na UI)
endCallBtn.addEventListener('click', () => {
    if (callingPeerId) {
        socket.emit('end call', callingPeerId); // Notifica o servidor e o outro peer
        endCurrentCall(); // Limpa o estado local
    }
});

// Silenciar/Dessilenciar o microfone
muteUnmuteBtn.addEventListener('click', () => {
    if (localStream) {
        isMuted = !isMuted;
        localStream.getAudioTracks()[0].enabled = !isMuted; // Desabilita/habilita a trilha de áudio
        muteUnmuteBtn.textContent = isMuted ? 'Dessilenciar' : 'Silenciar';
        callStatus.textContent = isMuted ? 'Você está silenciado.' : `Em chamada com ${usersData[callingPeerId]?.nickname || 'o peer'}.`;
    }
});

// Função para encerrar e resetar o estado da chamada
function endCurrentCall() {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop()); // Para o microfone
        localStream = null;
    }
    if (peerConnection) {
        peerConnection.close(); // Fecha a conexão WebRTC
        peerConnection = null;
    }
    callingPeerId = null;
    hideCallControls();
    hideCallModal(); // Garante que o modal esteja oculto
    muteUnmuteBtn.textContent = 'Silenciar'; // Reseta texto do botão
    isMuted = false;
}

// --- Outros eventos de Socket.IO ---
// Lida com erros de conexão com o servidor
socket.on('connect_error', (err) => {
    console.error('Erro de conexão com Socket.IO:', err.message);
    addMessage('Erro de conexão com o servidor. Tente recarregar a página.', 'system');
});

// Lida com a desconexão do servidor
socket.on('disconnect', (reason) => {
    console.log('Desconectado do servidor:', reason);
    addMessage('Você foi desconectado do servidor. Tentando reconectar...', 'system');
    endCurrentCall(); // Limpa o estado da chamada ao desconectar
});