const { Client } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const { MongoClient } = require('mongodb');
const { addItem, getItems } = require('./menu_data'); // تغيير الاسم من menu إلى menu_data
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017';
const clientMongo = new MongoClient(mongoUri, {
  reconnectTries: Number.MAX_VALUE,
  reconnectInterval: 1000,
});
let db;

const client = new Client({
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
});

let qrCodeData = null;
let isConnected = false;

async function connectToMongo() {
  try {
    await clientMongo.connect();
    db = clientMongo.db('whatsapp_bot');
    console.log('Connected to MongoDB');
  } catch (err) {
    console.error('Failed to connect to MongoDB:', err);
    process.exit(1);
  }
}

client.on('qr', (qr) => {
  qrCodeData = qr;
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  isConnected = true;
  qrCodeData = null;
  console.log('Client is ready!');
});

client.on('message', async (msg) => {
  const message = msg.body.toLowerCase();
  if (message === 'المنيو' || message === 'قائمة الطعام') {
    const items = await getItems();
    let reply = 'قائمة الطعام:\n';
    const MAX_LENGTH = 4000;
    for (const item of items) {
      const line = `${item.name} - ${item.price} ريال\n`;
      if (reply.length + line.length > MAX_LENGTH) {
        await msg.reply(reply);
        reply = line;
      } else {
        reply += line;
      }
    }
    if (reply.length > 0) await msg.reply(reply);
  } else {
    const defaultResponse = await db.collection('default_responses').findOne({ key: 'default' });
    await msg.reply(defaultResponse?.response || 'مرحبًا! أرسل "المنيو" لعرض قائمة الطعام.');
  }
});

client.initialize();
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
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await db.collection('otps').insertOne({ phone, otp, createdAt: new Date() });

    // إرسال رمز التحقق عبر WhatsApp
    await client.sendMessage(`${phone}@c.us`, `رمز التحقق الخاص بك: ${otp}`);
    res.json({ message: 'OTP sent via WhatsApp' });
  } catch (err) {
    console.error('Error sending OTP:', err);
    res.status(500).json({ error: 'Failed to send OTP: ' + err.message });
  }
});

app.post('/verify-otp', async (req, res) => {
  const { phone, otp } = req.body;
  try {
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
    await client.sendMessage(`${to}@c.us`, message);
    res.json({ message: 'Message sent' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/default-response', async (req, res) => {
  const defaultResponse = await db.collection('default_responses').findOne({ key: 'default' });
  res.json({ response: defaultResponse?.response || '' });
});

app.post('/default-response', async (req, res) => {
  const { response } = req.body;
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
    await addItem(name, price, imagePath);
    res.json({ message: 'Item added' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/messages', async (req, res) => {
  const messages = await db.collection('messages').find().toArray();
  res.json(messages);
});

app.get('/groups', async (req, res) => {
  try {
    const chats = await client.getChats();
    const groups = chats.filter(chat => chat.isGroup).map(group => ({
      name: group.name,
      memberCount: group.participants.length
    }));
    res.json(groups);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/responses', async (req, res) => {
  const responses = await db.collection('auto_responses').find().toArray();
  res.json(responses);
});

app.post('/add-response', async (req, res) => {
  const { keyword, response } = req.body;
  await db.collection('auto_responses').insertOne({ keyword, response });
  res.json({ message: 'Response added' });
});

app.delete('/delete-response/:id', async (req, res) => {
  const { id } = req.params;
  await db.collection('auto_responses').deleteOne({ id: parseInt(id) });
  res.json({ message: 'Response deleted' });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
