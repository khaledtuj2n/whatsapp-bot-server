const express = require('express');
const { MongoClient } = require('mongodb');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
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
  }
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  sock = makeWASocket({ auth: state, printQRInTerminal: true });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      qrCodeData = qr;
      qrcode.generate(qr, { small: true });
      console.log('QR Code generated:', qr);
    }
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed:', lastDisconnect?.error, 'Reconnecting:', shouldReconnect);
      isConnected = false;
      qrCodeData = null;
      if (shouldReconnect) connectToWhatsApp();
    } else if (connection === 'open') {
      isConnected = true;
      qrCodeData = null;
      console.log('WhatsApp client connected');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message) return;
    const message = msg.message.conversation?.toLowerCase();
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
  ws.send(JSON.stringify({ type: 'session', sessionId }));

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

connectToMongo();
connectToWhatsApp();

app.get('/qr', (req, res) => {
  if (qrCodeData) res.json({ qr: qrCodeData });
  else if (isConnected) res.json({ qr: null, message: 'Already connected' });
  else res.status(503).json({ error: 'QR code not generated yet' });
});

app.get('/status', (req, res) => res.json({ connected: isConnected }));

app.post('/send-message', async (req, res) => {
  const { chatId, message } = req.body;
  if (!chatId || !message) return res.status(400).json({ error: 'Missing chatId or message' });
  try {
    const sentCount = await db.collection('sent_messages').countDocuments({ chatId, date: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } });
    if (sentCount >= 5) return res.status(429).json({ error: 'Rate limit exceeded' });
    await sock.sendMessage(`${chatId}@s.whatsapp.net`, { text: message });
    await db.collection('sent_messages').insertOne({ chatId, message, date: new Date() });
    res.json({ message: 'Message sent' });
  } catch (err) {
    console.error('Error sending message:', err);
    res.status(500).json({ error: 'Failed to send message: ' + err.message });
  }
});

app.post('/send-file', async (req, res) => {
  const { chatId, filePath } = req.body;
  if (!chatId || !filePath) return res.status(400).json({ error: 'Missing chatId or filePath' });
  try {
    await sock.sendMessage(`${chatId}@s.whatsapp.net`, { document: { url: filePath }, mimetype: 'application/octet-stream' });
    res.json({ message: 'File sent' });
  } catch (err) {
    console.error('Error sending file:', err);
    res.status(500).json({ error: 'Failed to send file: ' + err.message });
  }
});

app.post('/schedule-message', async (req, res) => {
  const { chatId, message, scheduledTime } = req.body;
  if (!chatId || !message || !scheduledTime) return res.status(400).json({ error: 'Missing chatId, message, or scheduledTime' });
  try {
    const scheduledDate = new Date(scheduledTime);
    const now = new Date();
    if (scheduledDate <= now) return res.status(400).json({ error: 'Scheduled time must be in the future' });

    const delay = scheduledDate.getTime() - now.getTime();
    setTimeout(async () => {
      await sock.sendMessage(`${chatId}@s.whatsapp.net`, { text: message });
      await db.collection('sent_messages').insertOne({ chatId, message, date: new Date() });
    }, delay);

    res.json({ message: 'Message scheduled' });
  } catch (err) {
    console.error('Error scheduling message:', err);
    res.status(500).json({ error: 'Failed to schedule message: ' + err.message });
  }
});

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

app.get('/chats', async (req, res) => {
  try {
    if (!isConnected) return res.status(503).json({ error: 'WhatsApp client not connected' });
    // جلب الشاتات باستخدام sock.chats بدل fetchChats
    const chats = sock.chats.all();
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

app.get('/orders', async (req, res) => {
  try {
    const orders = await db.collection('orders').find().toArray();
    res.json(orders);
  } catch (err) {
    console.error('Error fetching orders:', err);
    res.status(500).json({ error: 'Failed to fetch orders: ' + err.message });
  }
});

app.post('/confirm-order', async (req, res) => {
  const { cart } = req.body;
  try {
    await db.collection('orders').insertOne({ cart, status: 'pending', date: new Date(), timestamp: new Date().toIsoString() });
    res.json({ message: 'Order confirmed' });
  } catch (err) {
    console.error('Error confirming order:', err);
    res.status(500).json({ error: 'Failed to confirm order: ' + err.message });
  }
});

app.post('/send-bulk-message', async (req, res) => {
  const { message, numbers } = req.body;
  if (!message || !numbers || !Array.isArray(numbers)) return res.status(400).json({ error: 'Missing message or numbers' });
  try {
    for (const number of numbers) {
      await sock.sendMessage(`${number.replace('+', '')}@s.whatsapp.net`, { text: message });
    }
    res.json({ message: 'Bulk message sent' });
  } catch (err) {
    console.error('Error sending bulk message:', err);
    res.status(500).json({ error: 'Failed to send bulk message: ' + err.message });
  }
});

app.listen(port, () => console.log(`Server running on port ${port}`));
