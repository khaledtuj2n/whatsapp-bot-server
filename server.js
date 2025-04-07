const express = require('express');
const { MongoClient } = require('mongodb');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

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
      console.log('QR Code generated');
    }
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed:', lastDisconnect?.error, 'Reconnecting:', shouldReconnect);
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

connectToMongo();
connectToWhatsApp();

app.get('/qr', (req, res) => {
  if (qrCodeData) res.json({ qr: qrCodeData });
  else if (isConnected) res.json({ qr: null, message: 'Already connected' });
  else res.status(503).json({ error: 'QR code not generated yet' });
});

app.get('/status', (req, res) => res.json({ connected: isConnected }));

app.post('/send', async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'Missing to or message' });
  try {
    const sentCount = await db.collection('sent_messages').countDocuments({ to, date: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } });
    if (sentCount >= 5) return res.status(429).json({ error: 'Rate limit exceeded' });
    await sock.sendMessage(`${to}@c.us`, { text: message });
    await db.collection('sent_messages').insertOne({ to, message, date: new Date() });
    res.json({ message: 'Message sent' });
  } catch (err) {
    console.error('Error sending message:', err);
    res.status(500).json({ error: 'Failed to send message: ' + err.message });
  }
});

app.get('/chats', async (req, res) => {
  try {
    if (!isConnected) return res.status(503).json({ error: 'WhatsApp client not connected' });
    const chats = await sock.fetchChats(); // استخدام fetchChats بدلاً من chatFetchAll
    const formattedChats = chats.map(chat => ({
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

app.get('/messages/:chatId', async (req, res) => {
  const { chatId } = req.params;
  try {
    const messages = await db.collection('messages').find({ chatId }).toArray();
    res.json(messages);
  } catch (err) {
    console.error('Error fetching messages:', err);
    res.status(500).json({ error: 'Failed to fetch messages: ' + err.message });
  }
});

app.get('/group-numbers', async (req, res) => {
  try {
    const chats = await sock.groupFetchAllParticipating();
    const numbers = Object.values(chats).flatMap(group => group.participants.map(p => p.id.split('@')[0]));
    res.json(numbers);
  } catch (err) {
    console.error('Error fetching group numbers:', err);
    res.status(500).json({ error: 'Failed to fetch group numbers: ' + err.message });
  }
});

app.post('/confirm-order', async (req, res) => {
  const { cart } = req.body;
  try {
    await db.collection('orders').insertOne({ cart, status: 'pending', date: new Date() });
    res.json({ message: 'Order confirmed' });
  } catch (err) {
    console.error('Error confirming order:', err);
    res.status(500).json({ error: 'Failed to confirm order: ' + err.message });
  }
});

app.listen(port, () => console.log(`Server running on port ${port}`));