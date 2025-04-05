const express = require('express');
const { MongoClient } = require('mongodb');
const { addItem, getItems } = require('./menu_data');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017';
const clientMongo = new MongoClient(mongoUri);
let db;

let qrCodeData = null;
let isConnected = false;
let sock;

// Set لتتبع الرسائل المعالجة
const processedMessages = new Set();

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
  
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCodeData = qr;
      console.log('QR Code generated:', qr);
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed:', lastDisconnect?.error, 'Reconnecting:', shouldReconnect);
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    } else if (connection === 'open') {
      isConnected = true;
      qrCodeData = null;
      console.log('Client is ready!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message) return;

    // التحقق من معرف الرسالة
    const messageId = msg.key.id;
    if (processedMessages.has(messageId)) return; // تجاهل الرسالة إذا تمت معالجتها

    // إضافة معرف الرسالة إلى القائمة
    processedMessages.add(messageId);

    // تنظيف القائمة لتجنب التخزين المفرط
    if (processedMessages.size > 1000) {
      processedMessages.clear();
    }

    const message = msg.message.conversation?.toLowerCase();
    if (message === 'المنيو' || message === 'قائمة الطعام') {
      if (!db) {
        await sock.sendMessage(msg.key.remoteJid, { text: 'فشل الاتصال بقاعدة البيانات، يرجى المحاولة لاحقًا.' });
        return;
      }
      const items = await getItems();
      let reply = 'قائمة الطعام:\n';
      const MAX_LENGTH = 4000;
      for (const item of items) {
        const line = `${item.name} - ${item.price} ريال\n`;
        if (reply.length + line.length > MAX_LENGTH) {
          await sock.sendMessage(msg.key.remoteJid, { text: reply });
          reply = line;
        } else {
          reply += line;
        }
      }
      if (reply.length > 0) await sock.sendMessage(msg.key.remoteJid, { text: reply });
    } else {
      if (!db) {
        await sock.sendMessage(msg.key.remoteJid, { text: 'فشل الاتصال بقاعدة البيانات، يرجى المحاولة لاحقًا.' });
        return;
      }
      const defaultResponse = await db.collection('default_responses').findOne({ key: 'default' });
      await sock.sendMessage(msg.key.remoteJid, { text: defaultResponse?.response || 'مرحبًا! أرسل "المنيو" لعرض قائمة الطعام.' });
    }
  });
}

connectToWhatsApp().catch(err => {
  console.error('Failed to initialize WhatsApp client:', err);
});

connectToMongo();

// API Endpoints
app.get('/qr', (req, res) => {
  if (qrCodeData) {
    res.json({ qr: qrCodeData });
  } else if (isConnected) {
    res.json({ qr: null, message: 'Already connected' });
  } else {
    res.status(503).json({ error: 'QR code not generated yet' });
  }
});

app.get('/status', (req, res) => {
  res.json({ connected: isConnected });
});

app.post('/phone-auth', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number required' });
  if (!isConnected) return res.status(503).json({ error: 'WhatsApp client not connected' });

  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not connected' });
    }
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await db.collection('otps').insertOne({ phone, otp, createdAt: new Date() });

    await sock.sendMessage(`${phone}@c.us`, { text: `رمز التحقق الخاص بك: ${otp}` });
    res.json({ message: 'OTP sent via WhatsApp' });
  } catch (err) {
    console.error('Error sending OTP:', err);
    res.status(500).json({ error: 'Failed to send OTP: ' + err.message });
  }
});

app.post('/verify-otp', async (req, res) => {
  const { phone, otp } = req.body;
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not connected' });
    }
    const record = await db.collection('otps').findOne({ phone, otp });
    if (record) {
      await db.collection('otps').deleteOne({ phone, otp });
      isConnected = true;
      qrCodeData = null;
      res.json({ message: 'Verified and connected' });
    } else {
      res.status(400).json({ error: 'Invalid OTP' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/send', async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'Missing to or message' });
  try {
    await sock.sendMessage(`${to}@c.us`, { text: message });
    res.json({ message: 'Message sent' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/default-response', async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: 'Database not connected' });
  }
  const defaultResponse = await db.collection('default_responses').findOne({ key: 'default' });
  res.json({ response: defaultResponse?.response || '' });
});

app.post('/default-response', async (req, res) => {
  const { response } = req.body;
  if (!db) {
    return res.status(503).json({ error: 'Database not connected' });
  }
  await db.collection('default_responses').updateOne(
    { key: 'default' },
    { $set: { response } },
    { upsert: true }
  );
  res.json({ message: 'Default response updated' });
});

app.post('/add-item', async (req, res) => {
  const { name, price, imagePath } = req.body;
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not connected' });
    }
    await addItem(name, price, imagePath);
    res.json({ message: 'Item added' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/messages', async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: 'Database not connected' });
  }
  const messages = await db.collection('messages').find().toArray();
  res.json(messages);
});

app.get('/groups', async (req, res) => {
  try {
    const chats = await sock.groupFetchAllParticipating();
    const groups = Object.values(chats).map(group => ({
      name: group.subject,
      memberCount: group.participants.length,
      participants: group.participants.map(participant => participant.id.split('@')[0])
    }));
    res.json(groups);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/responses', async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: 'Database not connected' });
  }
  const responses = await db.collection('auto_responses').find().toArray();
  res.json(responses);
});

app.post('/add-response', async (req, res) => {
  const { keyword, response } = req.body;
  if (!db) {
    return res.status(503).json({ error: 'Database not connected' });
  }
  await db.collection('auto_responses').insertOne({ keyword, response });
  res.json({ message: 'Response added' });
});

app.delete('/delete-response/:id', async (req, res) => {
  const { id } = req.params;
  if (!db) {
    return res.status(503).json({ error: 'Database not connected' });
  }
  await db.collection('auto_responses').deleteOne({ id: parseInt(id) });
  res.json({ message: 'Response deleted' });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
