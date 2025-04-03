const { Client } = require('whatsapp-web.js');
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const { MongoClient } = require('mongodb');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());

// رابط الاتصال بـ MongoDB
const uri = 'mongodb+srv://manohack911:WUWWzhJZc1xmjkTM@cluster0.m2s0sjk.mongodb.net/whatsapp_bot?retryWrites=true&w=majority&appName=Cluster0';
const clientMongo = new MongoClient(uri);

let db;

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

connectToMongo();

const client = new Client({
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium'
  }
});

client.on('qr', (qr) => {
  console.log('QR Code generated:', qr);
  app.get('/qr', (req, res) => res.json({ qr }));
});

client.on('ready', () => {
  console.log('Bot is ready!');
  app.get('/status', (req, res) => res.json({ status: 'connected' }));
});

client.on('disconnected', (reason) => {
  console.log('Disconnected:', reason);
  client.initialize();
  app.get('/status', (req, res) => res.json({ status: 'disconnected' }));
});

client.on('message', async (msg) => {
  const text = msg.body.toLowerCase();
  let reply = null;

  if (text.includes('المنيو') || text.includes('قائمة الطعام')) {
    const items = await db.collection('menu').find().toArray();
    reply = 'قائمة الطعام:\n';
    items.forEach(item => {
      reply += item.name + ' - ' + item.price + ' ريال\n';
    });
  }

  const responses = await db.collection('responses').find().toArray();
  for (const r of responses) {
    if (text.includes(r.keyword.toLowerCase())) {
      reply = r.response;
      break;
    }
  }

  if (!reply) {
    const defaultResponse = await db.collection('default_response').findOne({ key: 'default' });
    reply = defaultResponse ? defaultResponse.response : 'عذرًا، ممكن توضح أكثر؟';
  }

  msg.reply(reply);

  wss.clients.forEach(client => client.send(JSON.stringify({ type: 'message', body: msg.body })));
});

app.post('/send', async (req, res) => {
  const { to, message, mediaUrl, fileUrl } = req.body;
  let status = 'sent';
  try {
    if (fileUrl) {
      await client.sendMessage(to + '@c.us', { media: fileUrl, caption: message });
    } else if (mediaUrl) {
      await client.sendMessage(to + '@c.us', { media: mediaUrl });
    } else {
      await client.sendMessage(to + '@c.us', message);
    }
  } catch (e) {
    status = 'failed';
    console.error('Failed to send message:', e);
  }
  await db.collection('messages').insertOne({
    text: message,
    status: status,
    timestamp: new Date().toISOString(),
  });
  res.send('Message sent');
});

app.get('/messages', async (req, res) => {
  const messages = await db.collection('messages').find().toArray();
  res.json(messages);
});

app.get('/responses', async (req, res) => {
  const responses = await db.collection('responses').find().toArray();
  res.json(responses);
});

app.post('/add-response', async (req, res) => {
  const { keyword, response } = req.body;
  const responses = await db.collection('responses').find().toArray();
  const id = responses.length > 0 ? responses[responses.length - 1].id + 1 : 1;
  await db.collection('responses').insertOne({ id, keyword, response });
  res.send('Response added');
});

app.delete('/delete-response/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  await db.collection('responses').deleteOne({ id });
  res.send('Response deleted');
});

app.get('/default-response', async (req, res) => {
  const defaultResponse = await db.collection('default_response').findOne({ key: 'default' });
  res.json({ response: defaultResponse ? defaultResponse.response : null });
});

app.post('/default-response', async (req, res) => {
  const { response } = req.body;
  await db.collection('default_response').updateOne(
    { key: 'default' },
    { $set: { response } },
    { upsert: true }
  );
  res.send('Default response updated');
});

app.get('/groups', async (req, res) => {
  try {
    const chats = await client.getChats();
    const groups = chats
      .filter(chat => chat.isGroup)
      .map(chat => ({
        id: chat.id._serialized,
        name: chat.name,
        memberCount: chat.groupMetadata?.participants.length || 0,
      }));
    res.json(groups);
  } catch (e) {
    res.status(500).send('Error fetching groups');
  }
});

app.get('/activation', (req, res) => {
  res.json({ activationDate: '2025-06-28T10:59:00Z' });
});

app.post('/logout', (req, res) => {
  client.logout();
  res.send('Logged out');
});

app.post('/add-item', async (req, res) => {
  const { name, price, imagePath } = req.body;
  const items = await db.collection('menu').find().toArray();
  const id = items.length > 0 ? items[items.length - 1].id + 1 : 1;
  await db.collection('menu').insertOne({ id, name, price, imagePath });
  res.send('Item added');
});

app.get('/menu-items', async (req, res) => {
  const items = await db.collection('menu').find().toArray();
  res.json(items);
});

client.initialize().catch(err => console.error('Failed to initialize WhatsApp client:', err));

server.listen(process.env.PORT || 3000, () => console.log('Server running on port', process.env.PORT || 3000));