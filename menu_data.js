const { MongoClient } = require('mongodb');

const uri = process.env.MONGO_URI || 'mongodb+srv://manohack911:WUWWzhJZc1xmjkTM@cluster0.m2s0sjk.mongodb.net/whatsapp_bot?retryWrites=true&w=majority&appName=Cluster0';
const clientMongo = new MongoClient(uri); // إزالة الخيارات غير المدعومة

let db;

async function connectToMongo() {
  try {
    await clientMongo.connect();
    db = clientMongo.db('whatsapp_bot');
    console.log('Connected to MongoDB for menu');
  } catch (err) {
    console.error('Failed to connect to MongoDB for menu:', err);
    process.exit(1);
  }
}

const addItem = async (name, price, imagePath) => {
  await connectToMongo();
  const items = await db.collection('menu').find().toArray();
  const id = items.length > 0 ? items[items.length - 1].id + 1 : 1;
  await db.collection('menu').insertOne({ id, name, price, imagePath });
};

const getItems = async () => {
  await connectToMongo();
  const items = await db.collection('menu').find().toArray();
  return items;
};

module.exports = { addItem, getItems };
