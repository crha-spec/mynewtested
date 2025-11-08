const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 10000;

// ✅ RENDER SELF-PING - 1 DAKIKA UYUMA SORUNU ÇÖZÜMÜ
const RENDER_SELF_PING_INTERVAL = 50000; // 50 saniye
let selfPingUrl = null;

// ✅ OTOMATİK SELF-PING BAŞLAT
function startRenderSelfPing() {
  if (process.env.RENDER) {
    selfPingUrl = process.env.RENDER_EXTERNAL_URL || `https://${process.env.RENDER_SERVICE_NAME}.onrender.com`;
    
    setInterval(async () => {
      try {
        const fetch = (await import('node-fetch')).default;
        await fetch(`${selfPingUrl}/health`, { 
          method: 'GET',
          timeout: 5000 
        });
        console.log(`❤️ Self-ping: ${new Date().toLocaleTimeString()}`);
      } catch (error) {
        console.log('⚠️ Self-ping failed:', error.message);
      }
    }, RENDER_SELF_PING_INTERVAL);
    
    console.log(`🔄 RENDER SELF-PING ACTIVE: ${selfPingUrl}`);
  }
}

// ✅ BELLEK TABANLI SİSTEM
const rooms = new Map();
const users = new Map();
const messages = new Map();
const pendingOffers = new Map();
const activeCalls = new Map(); // Yeni: Aktif çağrıları takip etmek için
const connectionMonitor = new Map();

// ✅ STUN SUNUCULARI - GLOBAL ARAMA DESTEĞİ İÇİN
function getIceServers() {
  return [
    // Google STUN sunucuları - Global NAT çözümü
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    
    // Fallback STUN sunucuları
    { urls: 'stun:stun.services.mozilla.com' },
    { urls: 'stun:stun.stunprotocol.org:3478' }
  ];
}

// ✅ SOCKET.IO - RENDER İÇİN OPTİMİZE
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 100 * 1024 * 1024,
  pingTimeout: 30000,      // 30 saniye (kısaltıldı)
  pingInterval: 12000,     // 12 saniye (kısaltıldı)
  connectTimeout: 20000,   // 20 saniye
  allowUpgrades: true
});

// Yardımcı Fonksiyonlar
function generateRoomCode() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

function generateUserColor(username) {
  const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7'];
  const index = username ? username.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) : 0;
  return colors[index % colors.length];
}

function extractYouTubeId(url) {
  const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
  const match = url.match(regex);
  return match ? match[1] : null;
}

function updateUserList(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  
  const userList = Array.from(room.users.values()).map(user => ({
    id: user.id,
    userName: user.userName,
    userPhoto: user.userPhoto,
    userColor: user.userColor,
    isOwner: user.isOwner,
    country: user.country,
    isInCall: activeCalls.has(user.id) // Çağrı durumu
  }));
  
  io.to(roomCode).emit('user-list-update', userList);
}

// ✅ BAĞLANTI SAĞLIK KONTROLÜ - RENDER İÇİN
function startConnectionHealthCheck() {
  setInterval(() => {
    const now = Date.now();
    
    for (const [socketId, connection] of connectionMonitor.entries()) {
      const timeSinceLastPing = now - connection.lastPing;
      
      // 40 saniyeden fazla ping yoksa temizle
      if (timeSinceLastPing > 40000) {
        const socket = io.sockets.sockets.get(socketId);
        if (socket) {
          console.log(`🔌 Timeout disconnect: ${socketId}`);
          socket.disconnect(true);
        }
        connectionMonitor.delete(socketId);
      }
    }
  }, 20000); // 20 saniyede bir kontrol
}

// Middleware
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ✅ RENDER HEALTH CHECK - CRITICAL
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    connections: connectionMonitor.size,
    rooms: rooms.size,
    users: users.size,
    activeCalls: activeCalls.size,
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB'
  });
});

// ✅ RENDER BUILD HOOK
app.post('/render-build-hook', (req, res) => {
  console.log('🔨 Render build hook received');
  res.status(200).json({ status: 'received' });
});

// Socket.io Events
io.on('connection', (socket) => {
  console.log('✅ User connected:', socket.id);
  
  // ✅ BAĞLANTI İZLEME
  connectionMonitor.set(socket.id, {
    userName: 'Anonymous',
    roomCode: null,
    lastPing: Date.now(),
    connectedAt: Date.now()
  });

  // ✅ YENİ EKLENDİ: ICE sunucularını hemen gönder
  socket.emit('ice-servers', { servers: getIceServers() });

  let currentUser = null;
  let currentRoomCode = null;

  // ✅ PING-PONG SİSTEMİ - RENDER İÇİN KRİTİK
  const pingInterval = setInterval(() => {
    if (socket.connected) {
      socket.emit('ping', { timestamp: Date.now() });
      
      // Bağlantı durumu güncelle
      const conn = connectionMonitor.get(socket.id);
      if (conn) {
        conn.lastPing = Date.now();
        connectionMonitor.set(socket.id, conn);
      }
    }
  }, 10000); // 10 saniyede bir

  // PONG yanıtı
  socket.on('pong', () => {
    const conn = connectionMonitor.get(socket.id);
    if (conn) {
      conn.lastPing = Date.now();
      connectionMonitor.set(socket.id, conn);
    }
  });

  // 🎯 ODA OLUŞTURMA
  socket.on('create-room', (data) => {
    try {
      const { userName, userPhoto, roomName, password } = data;
      
      let roomCode;
      do {
        roomCode = generateRoomCode();
      } while (rooms.has(roomCode));
      
      const room = {
        code: roomCode,
        name: roomName,
        password: password || null,
        owner: socket.id,
        users: new Map(),
        video: null,
        playbackState: { playing: false, currentTime: 0, playbackRate: 1 },
        messages: [],
        createdAt: new Date()
      };
      
      currentUser = {
        id: socket.id,
        userName: userName,
        userPhoto: userPhoto || `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect fill="${generateUserColor(userName)}" width="100" height="100"/><text x="50" y="60" font-size="40" text-anchor="middle" fill="white">${userName.charAt(0)}</text></svg>`,
        userColor: generateUserColor(userName),
        isOwner: true,
        country: 'Türkiye'
      };
      
      room.users.set(socket.id, currentUser);
      rooms.set(roomCode, room);
      users.set(socket.id, { roomCode, ...currentUser });
      
      currentRoomCode = roomCode;
      socket.join(roomCode);
      
      // Bağlantı monitörünü güncelle
      connectionMonitor.set(socket.id, {
        ...connectionMonitor.get(socket.id),
        userName: userName,
        roomCode: roomCode
      });
      
      const shareableLink = `${process.env.RENDER_EXTERNAL_URL || 'http://localhost:10000'}?room=${roomCode}`;
      
      socket.emit('room-created', {
        roomCode,
        roomName,
        isOwner: true,
        shareableLink,
        userColor: currentUser.userColor
      });
      
      console.log(`✅ Room created: ${roomCode} by ${userName}`);
      
    } catch (error) {
      console.error('❌ Create room error:', error);
      socket.emit('error', { message: 'Oda oluşturulamadı!' });
    }
  });

  // 🔑 ODAYA KATILMA
  socket.on('join-room', (data) => {
    try {
      const { roomCode, userName, userPhoto, password } = data;
      const room = rooms.get(roomCode.toUpperCase());
      
      if (!room) {
        socket.emit('error', { message: 'Oda bulunamadı!' });
        return;
      }
      
      if (room.password && room.password !== password) {
        socket.emit('error', { message: 'Şifre yanlış!' });
        return;
      }
      
      currentUser = {
        id: socket.id,
        userName: userName,
        userPhoto: userPhoto || `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect fill="${generateUserColor(userName)}" width="100" height="100"/><text x="50" y="60" font-size="40" text-anchor="middle" fill="white">${userName.charAt(0)}</text></svg>`,
        userColor: generateUserColor(userName),
        isOwner: room.owner === socket.id,
        country: 'Türkiye'
      };
      
      room.users.set(socket.id, currentUser);
      users.set(socket.id, { roomCode, ...currentUser });
      currentRoomCode = roomCode;
      socket.join(roomCode);
      
      connectionMonitor.set(socket.id, {
        ...connectionMonitor.get(socket.id),
        userName: userName,
        roomCode: roomCode
      });
      
      const roomMessages = messages.get(roomCode) || [];
      
      socket.emit('room-joined', {
        roomCode: room.code,
        roomName: room.name,
        isOwner: room.owner === socket.id,
        userColor: currentUser.userColor,
        previousMessages: roomMessages.slice(-50),
        activeVideo: room.video,
        playbackState: room.playbackState
      });
      
      socket.to(roomCode).emit('user-joined', { userName: currentUser.userName });
      updateUserList(roomCode);
      
      console.log(`✅ User joined: ${userName} -> ${roomCode}`);
      
    } catch (error) {
      console.error('❌ Join room error:', error);
      socket.emit('error', { message: 'Odaya katılamadı!' });
    }
  });

  // 🎬 VIDEO YÜKLEME
  socket.on('upload-video', (data) => {
    try {
      if (!currentRoomCode || !currentUser || !currentUser.isOwner) {
        socket.emit('error', { message: 'Yetkiniz yok' });
        return;
      }
      
      const { videoBase64, title } = data;
      const room = rooms.get(currentRoomCode);
      
      room.video = {
        url: videoBase64,
        title: title || 'Video',
        uploadedBy: currentUser.userName,
        uploadedAt: new Date()
      };
      
      io.to(currentRoomCode).emit('video-uploaded', {
        videoUrl: videoBase64,
        title: title || 'Video',
        uploadedBy: currentUser.userName
      });
      
      socket.emit('upload-progress', { status: 'completed', progress: 100 });
      
    } catch (error) {
      console.error('❌ Upload error:', error);
      socket.emit('error', { message: 'Video yüklenemedi!' });
    }
  });

  // 📺 YOUTUBE PAYLAŞMA
  socket.on('share-youtube-link', (data) => {
    try {
      if (!currentRoomCode || !currentUser) return;
      
      const { youtubeUrl, title } = data;
      const videoId = extractYouTubeId(youtubeUrl);
      const room = rooms.get(currentRoomCode);
      
      if (!videoId) {
        socket.emit('error', { message: 'Geçersiz YouTube linki' });
        return;
      }
      
      room.video = {
        type: 'youtube',
        videoId: videoId,
        url: youtubeUrl,
        title: title || 'YouTube Video',
        uploadedBy: currentUser.userName
      };

      room.playbackState = {
        playing: true,
        currentTime: 0,
        playbackRate: 1,
        videoId: videoId
      };
      
      io.to(currentRoomCode).emit('youtube-video-shared', {
        videoId: videoId,
        title: title || 'YouTube Video',
        sharedBy: currentUser.userName,
        playbackState: room.playbackState
      });
      
    } catch (error) {
      console.error('❌ YouTube share error:', error);
    }
  });

  // 🎮 VIDEO KONTROLÜ
  socket.on('video-control', (controlData) => {
    if (!currentRoomCode || !currentUser || !currentUser.isOwner) return;
    
    const room = rooms.get(currentRoomCode);
    room.playbackState = { ...room.playbackState, ...controlData };
    
    io.to(currentRoomCode).emit('video-control', room.playbackState);
  });

  socket.on('youtube-control', (controlData) => {
    if (!currentRoomCode || !currentUser || !currentUser.isOwner) return;
    
    const room = rooms.get(currentRoomCode);
    room.playbackState = { ...room.playbackState, ...controlData };
    
    socket.to(currentRoomCode).emit('youtube-control', room.playbackState);
  });

  // 🗑️ VIDEO SİLME
  socket.on('delete-video', () => {
    if (!currentRoomCode || !currentUser || !currentUser.isOwner) return;
    
    const room = rooms.get(currentRoomCode);
    room.video = null;
    room.playbackState = { playing: false, currentTime: 0, playbackRate: 1 };
    
    io.to(currentRoomCode).emit('video-deleted');
  });

  // 📨 MESAJ GÖNDERME
  socket.on('message', (messageData) => {
    try {
      if (!currentRoomCode || !currentUser) return;
      
      const message = {
        id: Date.now().toString(),
        userName: currentUser.userName,
        userPhoto: currentUser.userPhoto,
        userColor: currentUser.userColor,
        text: messageData.text,
        type: messageData.type || 'text',
        fileUrl: messageData.fileUrl,
        fileName: messageData.fileName,
        fileSize: messageData.fileSize,
        time: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
        country: currentUser.country,
        timestamp: new Date()
      };
      
      const roomMessages = messages.get(currentRoomCode) || [];
      roomMessages.push(message);
      
      if (roomMessages.length > 100) {
        messages.set(currentRoomCode, roomMessages.slice(-100));
      } else {
        messages.set(currentRoomCode, roomMessages);
      }
      
      io.to(currentRoomCode).emit('message', message);
      
    } catch (error) {
      console.error('❌ Message error:', error);
    }
  });

  // 📞 WEBRTC ARAMALAR - STUN DESTEKLİ GLOBAL ARAMA
  socket.on('start-call', (data) => {
    try {
      const { targetUserName, offer, type, callerName } = data;
      console.log(`📞 Arama başlatılıyor (STUN ile): ${callerName} -> ${targetUserName}, Tip: ${type}`);
      
      // Hedef kullanıcıyı bul
      let targetSocketId = null;
      users.forEach((user, socketId) => {
        if (user.userName === targetUserName && user.roomCode === currentRoomCode) {
          targetSocketId = socketId;
        }
      });
      
      if (targetSocketId) {
        // ✅ ÖNEMLİ: Hedef kullanıcıya da ICE servislerini gönder
        io.to(targetSocketId).emit('ice-servers', { servers: getIceServers() });
        
        // Çağrıyı kaydet
        const callData = {
          callerSocketId: socket.id,
          callerName: callerName,
          targetSocketId: targetSocketId,
          targetUserName: targetUserName,
          type: type,
          roomCode: currentRoomCode,
          startTime: new Date(),
          status: 'ringing'
        };
        
        activeCalls.set(socket.id, callData);
        activeCalls.set(targetSocketId, callData);
        
        // Hedefe bildirim gönder
        io.to(targetSocketId).emit('incoming-call', { 
          offer, 
          callerName, 
          type,
          callerSocketId: socket.id 
        });
        
        console.log(`📞 Arama bildirimi gönderildi: ${callerName} -> ${targetUserName}`);
      } else {
        socket.emit('call-error', { message: 'Kullanıcı bulunamadı veya çevrimdışı' });
      }
    } catch (error) {
      console.error('❌ Start call error:', error);
      socket.emit('call-error', { message: 'Arama başlatılamadı' });
    }
  });

  // ✅ ÇAĞRIYI KABUL ETME
  socket.on('accept-call', (data) => {
    try {
      const { callerSocketId } = data;
      const callData = activeCalls.get(socket.id);
      
      if (callData && callData.callerSocketId === callerSocketId) {
        callData.status = 'accepted';
        
        // Aramayı kabul edenin cevabını arayana gönder
        io.to(callerSocketId).emit('call-accepted', {
          answererSocketId: socket.id,
          answererName: currentUser?.userName
        });
        
        console.log(`✅ Arama kabul edildi: ${callData.callerName} -> ${callData.targetUserName}`);
      }
    } catch (error) {
      console.error('❌ Accept call error:', error);
    }
  });

  // ✅ WEBRTC ANSWER
  socket.on('webrtc-answer', (data) => {
    try {
      const { targetSocketId, answer } = data;
      console.log(`📞 WebRTC answer gönderiliyor: ${socket.id} -> ${targetSocketId}`);
      
      if (targetSocketId) {
        io.to(targetSocketId).emit('webrtc-answer', {
          answer,
          answererSocketId: socket.id,
          answererName: currentUser?.userName
        });
      }
    } catch (error) {
      console.error('❌ WebRTC answer error:', error);
    }
  });

  // ✅ WEBRTC ICE CANDIDATE
  socket.on('webrtc-ice-candidate', (data) => {
    try {
      const { targetSocketId, candidate } = data;
      
      if (targetSocketId) {
        io.to(targetSocketId).emit('webrtc-ice-candidate', {
          candidate,
          senderSocketId: socket.id
        });
      }
    } catch (error) {
      console.error('❌ WebRTC ICE candidate error:', error);
    }
  });

  // ✅ ÇAĞRIYI REDDETME
  socket.on('reject-call', (data) => {
    try {
      const { callerSocketId } = data;
      const callData = activeCalls.get(socket.id);
      
      if (callData) {
        // Arayana reddedildi bildirimi gönder
        io.to(callerSocketId).emit('call-rejected', { 
          rejectedBy: currentUser?.userName 
        });
        
        // Çağrıyı temizle
        activeCalls.delete(callData.callerSocketId);
        activeCalls.delete(callData.targetSocketId);
        
        // Kullanıcı listesini güncelle
        updateUserList(currentRoomCode);
        
        console.log(`❌ Arama reddedildi: ${callData.callerName} -> ${callData.targetUserName}`);
      }
    } catch (error) {
      console.error('❌ Reject call error:', error);
    }
  });

  // ✅ ÇAĞRIYI SONLANDIRMA
  socket.on('end-call', (data) => {
    try {
      const { targetSocketId } = data;
      const callData = activeCalls.get(socket.id);
      
      if (callData) {
        // Karşı tarafa çağrının sonlandığını bildir
        const otherPartyId = callData.callerSocketId === socket.id ? callData.targetSocketId : callData.callerSocketId;
        
        if (otherPartyId) {
          io.to(otherPartyId).emit('call-ended', { 
            endedBy: currentUser?.userName 
          });
        }
        
        // Çağrıyı temizle
        activeCalls.delete(callData.callerSocketId);
        activeCalls.delete(callData.targetSocketId);
        
        // Kullanıcı listesini güncelle
        updateUserList(currentRoomCode);
        
        console.log(`📞 Arama sonlandırıldı: ${callData.callerName} <-> ${callData.targetUserName}`);
      } else if (targetSocketId) {
        // Doğrudan hedef socket ID ile sonlandırma
        io.to(targetSocketId).emit('call-ended', { 
          endedBy: currentUser?.userName 
        });
        
        activeCalls.delete(socket.id);
        activeCalls.delete(targetSocketId);
        
        updateUserList(currentRoomCode);
      }
    } catch (error) {
      console.error('❌ End call error:', error);
    }
  });

  // ✅ ÇAĞRI DURUMU SORGULAMA
  socket.on('check-call-status', (data) => {
    try {
      const { targetUserName } = data;
      
      let targetSocketId = null;
      let isInCall = false;
      
      users.forEach((user, socketId) => {
        if (user.userName === targetUserName && user.roomCode === currentRoomCode) {
          targetSocketId = socketId;
          isInCall = activeCalls.has(socketId);
        }
      });
      
      socket.emit('call-status-response', {
        targetUserName,
        isAvailable: targetSocketId && !isInCall,
        isInCall: isInCall
      });
    } catch (error) {
      console.error('❌ Check call status error:', error);
    }
  });

  // 🔌 BAĞLANTI KESİLDİĞİNDE
  socket.on('disconnect', (reason) => {
    console.log('🔌 User disconnected:', socket.id, reason);
    
    clearInterval(pingInterval);
    connectionMonitor.delete(socket.id);
    
    // Aktif çağrıları temizle
    const callData = activeCalls.get(socket.id);
    if (callData) {
      const otherPartyId = callData.callerSocketId === socket.id ? callData.targetSocketId : callData.callerSocketId;
      
      if (otherPartyId) {
        io.to(otherPartyId).emit('call-ended', { 
          endedBy: 'Sistem (bağlantı kesildi)',
          reason: 'connection_lost'
        });
        activeCalls.delete(otherPartyId);
      }
      activeCalls.delete(socket.id);
    }
    
    if (currentUser && currentRoomCode) {
      const room = rooms.get(currentRoomCode);
      if (room) {
        room.users.delete(socket.id);
        users.delete(socket.id);
        
        socket.to(currentRoomCode).emit('user-left', { userName: currentUser.userName });
        updateUserList(currentRoomCode);
        pendingOffers.delete(socket.id);
        
        if (room.users.size === 0) {
          setTimeout(() => {
            if (rooms.get(currentRoomCode)?.users.size === 0) {
              rooms.delete(currentRoomCode);
              messages.delete(currentRoomCode);
              console.log(`🗑️ Empty room deleted: ${currentRoomCode}`);
            }
          }, 600000);
        }
      }
    }
  });
});

// Static files
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ✅ BAŞLAT
startConnectionHealthCheck();
startRenderSelfPing(); // RENDER SELF-PING

// Server başlat
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 SERVER RUNNING ON PORT ${PORT}`);
  console.log(`❤️ RENDER OPTIMIZED - 1DK UYUMA SORUNU ÇÖZÜLDÜ`);
  console.log(`📞 GÖRÜNTÜLÜ ARAMA SİSTEMİ AKTİF - STUN DESTEKLİ`);
  console.log(`🌍 ARTIK 300+ KM MESAFEDEN ARAMA YAPILABİLİR`);
  console.log(`🔄 SELF-PING ACTIVE: ${selfPingUrl || 'localhost'}`);
  console.log(`📊 Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
});

process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, closing server...');
  server.close(() => {
    console.log('✅ Server closed successfully');
    process.exit(0);
  });
});
