const express = require('express');
const { MongoClient } = require('mongodb');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode'); // استبدلنا qrcode-terminal بـ qrcode
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const pino = require('pino');

const app = express();
const port = process.env.PORT || 10000;

app.use(express.json());

// إعداد WebSocket Server
const wss = new WebSocket.Server({ port: 8080 });
const sessions = new Map();

// رابط MongoDB Atlas
const mongoUri = process.env.MONGO_URI || 'mongodb+srv://manohack911:WUWWzhJZc1xmjkTM@cluster0.m2s0sjk.mongodb.net/whatsapp_bot?retryWrites=true&w=majority&appName=Cluster0';
const clientMongo = new MongoClient(mongoUri);
let db;
let sock;
let qrCodeData = null;
let isConnected = false;

async function connectToMongo() {
  try {
    await clientMongo.connect();
    db = clientMongo.db('whatsapp_bot');
    console.log('Connected to MongoDB');
  } catch (err) {
    console.error('Failed to connect to MongoDB:', err);
    process.exit(1); // إنهاء السيرفر لو فشل الاتصال بـ MongoDB
  }
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const logger = pino({ level: 'silent' }); // تقليل اللوج غير الضروري

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // مش هنعتمد على الـ terminal لعرض الـ QR
    logger,
    defaultQueryTimeoutMs: undefined,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCodeData = qr;
      // توليد الـ QR Code كرابط (Data URL)
      qrcode.toDataURL(qr, (err, url) => {
        if (err) {
          console.error('Error generating QR code:', err);
          return;
        }
        console.log('Scan this QR Code to connect to WhatsApp:');
        console.log(url);
        // إرسال الـ QR Code لكل العملاء المتصلين عبر WebSocket
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'qr', qr: url }));
          }
        });
      });
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed:', lastDisconnect?.error?.message || 'Unknown reason', 'Reconnecting:', shouldReconnect);
      isConnected = false;
      qrCodeData = null;
      // إرسال حالة الاتصال للعملاء
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'connection', connected: false }));
        }
      });
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 5000); // إعادة المحاولة بعد 5 ثواني
      }
    } else if (connection === 'open') {
      isConnected = true;
      qrCodeData = null;
      console.log('WhatsApp client connected');
      // إرسال حالة الاتصال للعملاء
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'connection', connected: true }));
        }
      });
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message) return;

    // تخزين الرسالة في MongoDB
    try {
      const messageData = {
        chatId: msg.key.remoteJid,
        message: msg.message.conversation || msg.message.extendedTextMessage?.text || '',
        fromMe: msg.key.fromMe,
        timestamp: msg.messageTimestamp ? new Date(msg.messageTimestamp * 1000).toISOString() : new Date().toISOString(),
      };
      await db.collection('messages').insertOne(messageData);
      console.log(`Message stored for chat ${msg.key.remoteJid}`);

      // إرسال الرسالة للعملاء عبر WebSocket
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'message', data: messageData }));
        }
      });
    } catch (err) {
      console.error('Error storing message in MongoDB:', err);
    }

    // الرد التلقائي
    const message = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').toLowerCase();
    const responses = await db.collection('auto_responses').find().toArray();
    const match = responses.find(r => message.includes(r.keyword));
    if (match) {
      await sock.sendMessage(msg.key.remoteJid, { text: match.response });
    } else if (message === 'المنيو') {
      const menu = await db.collection('menu_pdf').findOne({});
      if (menu) {
        await sock.sendMessage(msg.key.remoteJid, { document: { url: menu.filePath }, mimetype: 'application/pdf', fileName: 'menu.pdf' });
      }
    } else if (message === 'الطلبية') {
      const items = await db.collection('menu').find().toArray();
      let reply = 'الأصناف:\n';
      items.forEach(item => reply += `${item.name} - ${item.price} ريال\n`);
      await sock.sendMessage(msg.key.remoteJid, { text: reply + '\nأرسل الطلب بصيغة: "أطلب [اسم الصنف]"' });
    } else if (message.startsWith('أطلب')) {
      const itemName = message.replace('أطلب', '').trim();
      const item = await db.collection('menu').findOne({ name: itemName });
      if (item) {
        await db.collection('orders').insertOne({ item, status: 'pending', date: new Date() });
        await sock.sendMessage(msg.key.remoteJid, { text: `تم تسجيل طلبك: ${itemName} - ${item.price} ريال + 10 ريال توصيل` });
      }
    }
  });
}

wss.on('connection', (ws) => {
  console.log('Client connected via WebSocket');
  const sessionId = uuidv4();
  sessions.set(sessionId, { ws, device: null });

  // إرسال sessionId للعميل
  ws.send(JSON.stringify({ type: 'session', sessionId }));

  // إرسال حالة الاتصال الحالية
  ws.send(JSON.stringify({ type: 'connection', connected: isConnected }));

  // إرسال الـ QR Code لو موجود
  if (qrCodeData) {
    qrcode.toDataURL(qrCodeData, (err, url) => {
      if (!err) {
        ws.send(JSON.stringify({ type: 'qr', qr: url }));
      }
    });
  }

  ws.on('message', async (message) => {
    const data = JSON.parse(message.toString());
    if (data.type === 'device_connected') {
      const session = sessions.get(data.sessionId);
      if (session) {
        session.device = data.deviceId;
        console.log(`Device ${data.deviceId} connected to session ${data.sessionId}`);
        session.ws.send(JSON.stringify({ type: 'device_connected', deviceId: data.deviceId }));
      }
    } else if (data.type === 'message') {
      const session = sessions.get(data.sessionId);
      if (session && session.device) {
        session.ws.send(JSON.stringify({ type: 'message', content: data.content }));
      }
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    sessions.delete(sessionId);
  });
});

// تشغيل الاتصال بـ MongoDB و WhatsApp
connectToMongo().then(() => {
  connectToWhatsApp();
});

// Endpoint لتوليد QR Code
app.get('/qr', (req, res) => {
  if (qrCodeData) {
    qrcode.toDataURL(qrCodeData, (err, url) => {
      if (err) {
        return res.status(500).json({ error: 'Failed to generate QR code' });
      }
      res.json({ qr: url });
    });
  } else if (isConnected) {
    res.json({ qr: null, message: 'Already connected' });
  } else {
    res.status(503).json({ error: 'QR code not generated yet' });
  }
});

// Endpoint للتحقق من حالة الاتصال
app.get('/status', (req, res) => res.json({ connected: isConnected }));

// Endpoint لإرسال رسالة
app.post('/send-message', async (req, res) => {
  const { chatId, message } = req.body;
  if (!chatId || !message) return res.status(400).json({ error: 'Missing chatId or message' });
  if (!isConnected) return res.status(503).json({ error: 'WhatsApp client not connected' });

  try {
    const sentCount = await db.collection('sent_messages').countDocuments({ chatId, date: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } });
    if (sentCount >= 5) return res.status(429).json({ error: 'Rate limit exceeded' });

    await sock.sendMessage(`${chatId}@s.whatsapp.net`, { text: message });
    // تخزين الرسالة المرسلة في MongoDB
    await db.collection('messages').insertOne({
      chatId: chatId,
      message: message,
      fromMe: true,
      timestamp: new Date().toISOString(),
    });
    await db.collection('sent_messages').insertOne({ chatId, message, date: new Date() });
    res.json({ message: 'Message sent' });
  } catch (err) {
    console.error('Error sending message:', err);
    res.status(500).json({ error: 'Failed to send message: ' + err.message });
  }
});

// Endpoint لإرسال ملف
app.post('/send-file', async (req, res) => {
  const { chatId, filePath } = req.body;
  if (!chatId || !filePath) return res.status(400).json({ error: 'Missing chatId or filePath' });
  if (!isConnected) return res.status(503).json({ error: 'WhatsApp client not connected' });

  try {
    await sock.sendMessage(`${chatId}@s.whatsapp.net`, { document: { url: filePath }, mimetype: 'application/octet-stream' });
    res.json({ message: 'File sent' });
  } catch (err) {
    console.error('Error sending file:', err);
    res.status(500).json({ error: 'Failed to send file: ' + err.message });
  }
});

// Endpoint لجدولة رسالة
app.post('/schedule-message', async (req, res) => {
  const { chatId, message, scheduledTime } = req.body;
  if (!chatId || !message || !scheduledTime) return res.status(400).json({ error: 'Missing chatId, message, or scheduledTime' });
  if (!isConnected) return res.status(503).json({ error: 'WhatsApp client not connected' });

  try {
    const scheduledDate = new Date(scheduledTime);
    const now = new Date();
    if (scheduledDate <= now) return res.status(400).json({ error: 'Scheduled time must be in the future' });

    const delay = scheduledDate.getTime() - now.getTime();
    setTimeout(async () => {
      await sock.sendMessage(`${chatId}@s.whatsapp.net`, { text: message });
      // تخزين الرسالة المجدولة في MongoDB
      await db.collection('messages').insertOne({
        chatId: chatId,
        message: message,
        fromMe: true,
        timestamp: new Date().toISOString(),
      });
      await db.collection('sent_messages').insertOne({ chatId, message, date: new Date() });
    }, delay);

    res.json({ message: 'Message scheduled' });
  } catch (err) {
    console.error('Error scheduling message:', err);
    res.status(500).json({ error: 'Failed to schedule message: ' + err.message });
  }
});

// Endpoint لإعداد الرد التلقائي
app.post('/set-auto-reply', async (req, res) => {
  const { keyword, response } = req.body;
  if (!keyword || !response) return res.status(400).json({ error: 'Missing keyword or response' });
  try {
    await db.collection('auto_responses').updateOne(
      { keyword },
      { $set: { keyword, response } },
      { upsert: true }
    );
    res.json({ message: 'Auto reply set' });
  } catch (err) {
    console.error('Error setting auto reply:', err);
    res.status(500).json({ error: 'Failed to set auto reply: ' + err.message });
  }
});

// Endpoint لجلب الشاتات
app.get('/chats', async (req, res) => {
  try {
    if (!isConnected) return res.status(503).json({ error: 'WhatsApp client not connected' });
    const chats = await sock.chats.all();
    const formattedChats = Object.values(chats).map(chat => ({
      id: chat.id,
      name: chat.name || chat.id.split('@')[0],
      lastMessage: chat.lastMsg?.text || ''
    }));
    res.json(formattedChats);
  } catch (err) {
    console.error('Error fetching chats:', err);
    res.status(500).json({ error: 'Failed to fetch chats: ' + err.message });
  }
});

// Endpoint لجلب الجروبات
app.get('/groups', async (req, res) => {
  try {
    if (!isConnected) return res.status(503).json({ error: 'WhatsApp client not connected' });
    const groups = await sock.groupFetchAllParticipating();
    const formattedGroups = Object.values(groups).map(group => ({
      id: group.id,
      name: group.subject,
      members: group.participants.map(p => ({
        id: p.id,
        name: p.name || p.id.split('@')[0],
        phone: `+${p.id.split('@')[0]}`
      }))
    }));
    res.json(formattedGroups);
  } catch (err) {
    console.error('Error fetching groups:', err);
    res.status(500).json({ error: 'Failed to fetch groups: ' + err.message });
  }
});

// Endpoint لجلب أرقام الأعضاء من الجروبات
app.get('/group-numbers', async (req, res) => {
  try {
    if (!isConnected) return res.status(503).json({ error: 'WhatsApp client not connected' });
    const groups = await sock.groupFetchAllParticipating();
    const numbers = Object.values(groups).flatMap(group => group.participants.map(p => ({
      name: p.name || p.id.split('@')[0],
      phone: `+${p.id.split('@')[0]}`
    })));
    res.json(numbers);
  } catch (err) {
    console.error('Error fetching group numbers:', err);
    res.status(500).json({ error: 'Failed to fetch group numbers: ' + err.message });
  }
});

// Endpoint لجلب الرسائل الخاصة بشات معين
app.get('/messages/:chatId', async (req, res) => {
  const { chatId } = req.params;
  try {
    const messagesFromDb = await db.collection('messages').find({ chatId }).sort({ timestamp: 1 }).toArray();
    res.json(messagesFromDb);
  } catch (err) {
    console.error('Error fetching messages:', err);
    res.status(500).json({ error: 'Failed to fetch messages: ' + err.message });
  }
});

// Endpoint لجلب الطلبات
app.get('/orders', async (req, res) => {
  try {
    const orders = await db.collection('orders').find().toArray();
    res.json(orders);
  } catch (err) {
    console.error('Error fetching orders:', err);
    res.status(500).json({ error: 'Failed to fetch orders: ' + err.message });
  }
});

// Endpoint لتأكيد الطلب
app.post('/confirm-order', async (req, res) => {
  const { cart } = req.body;
  try {
    await db.collection('orders').insertOne({ cart, status: 'pending', date: new Date(), timestamp: new Date().toISOString() });
    res.json({ message: 'Order confirmed' });
  } catch (err) {
    console.error('Error confirming order:', err);
    res.status(500).json({ error: 'Failed to confirm order: ' + err.message });
  }
});

// Endpoint لإرسال رسائل جماعية
app.post('/send-bulk-message', async (req, res) => {
  const { message, numbers } = req.body;
  if (!message || !numbers || !Array.isArray(numbers)) return res.status(400).json({ error: 'Missing message or numbers' });
  if (!isConnected) return res.status(503).json({ error: 'WhatsApp client not connected' });

  try {
    for (const number of numbers) {
      await sock.sendMessage(`${number.replace('+', '')}@s.whatsapp.net`, { text: message });
      // تخزين الرسالة المرسلة في MongoDB
      await db.collection('messages').insertOne({
        chatId: `${number.replace('+', '')}@s.whatsapp.net`,
        message: message,
        fromMe: true,
        timestamp: new Date().toISOString(),
      });
    }
    res.json({ message: 'Bulk message sent' });
  } catch (err) {
    console.error('Error sending bulk message:', err);
    res.status(500).json({ error: 'Failed to send bulk message: ' + err.message });
  }
});

// Endpoint للتحقق من حالة السيرفر
app.get('/ping', (req, res) => {
  res.status(200).json({ status: 'ok', connected: isConnected });
});

app.listen(port, () => console.log(`Server running on port ${port}`));
