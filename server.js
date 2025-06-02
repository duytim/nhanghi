const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const xlsx = require('xlsx');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

mongoose.connect('mongodb+srv://duytim1994:duytim123@nhanghi.qyjrygr.mongodb.net/?retryWrites=true&w=majority&appName=Nhanghi', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

const roomSchema = new mongoose.Schema({
  number: String,
  floor: String,
  status: { type: String, enum: ['vacant', 'occupied', 'dirty'], default: 'vacant' },
  checkInTime: Date,
  items: [{ itemId: String, quantity: Number }],
});

const inventorySchema = new mongoose.Schema({
  name: String,
  quantity: Number,
  purchasePrice: Number,
  salePrice: Number,
});

const transactionSchema = new mongoose.Schema({
  roomId: String,
  checkInTime: Date,
  checkOutTime: Date,
  total: Number,
  items: [{ itemId: String, quantity: Number }],
});

const priceSchema = new mongoose.Schema({
  firstHour: Number,
  extraHour: Number,
  overnight: Number,
});

const Room = mongoose.model('Room', roomSchema);
const Inventory = mongoose.model('Inventory', inventorySchema);
const Transaction = mongoose.model('Transaction', transactionSchema);
const Price = mongoose.model('Price', priceSchema);

const initializeRooms = async () => {
  const rooms = [];
  for (let floor of ['2', '3', '4']) {
    for (let i = 1; i <= 7; i++) {
      if (i !== 5) {
        rooms.push({ number: `${floor}0${i}`, floor, status: 'vacant' });
      }
    }
  }
  await Room.deleteMany({});
  await Room.insertMany(rooms);
};

const initializePrices = async () => {
  await Price.deleteMany({});
  await Price.create({ firstHour: 90000, extraHour: 20000, overnight: 200000 });
};

mongoose.connection.once('open', () => {
  initializeRooms();
  initializePrices();
});

const upload = multer({ dest: 'uploads/' });

app.get('/api/rooms', async (req, res) => {
  const rooms = await Room.find();
  res.json(rooms);
});

app.get('/api/inventory', async (req, res) => {
  const inventory = await Inventory.find();
  res.json(inventory);
});

app.post('/api/checkin', async (req, res) => {
  const { roomId, items, checkInTime } = req.body;
  await Room.findByIdAndUpdate(roomId, { status: 'occupied', checkInTime, items });
  res.json({ success: true });
});

app.post('/api/checkout', async (req, res) => {
  const { roomId } = req.body;
  const room = await Room.findById(roomId);
  const prices = await Price.findOne();
  const checkInTime = new Date(room.checkInTime);
  const checkOutTime = new Date();
  const hours = Math.ceil((checkOutTime - checkInTime) / (1000 * 60 * 15)) / 4; // Round to 15 minutes
  let total = hours <= 1 ? prices.firstHour : prices.firstHour + (hours - 1) * prices.extraHour;

  if (checkOutTime.getHours() >= 22 || checkInTime.getHours() < 10) {
    total = prices.overnight;
  }

  const itemsTotal = await Promise.all(
    room.items.map(async (item) => {
      const inventoryItem = await Inventory.findById(item.itemId);
      return (inventoryItem.salePrice || 0) * item.quantity;
    })
  );

  total += itemsTotal.reduce((sum, val) => sum + val, 0);

  await Transaction.create({ roomId, checkInTime, checkOutTime, total, items: room.items });
  await Room.findByIdAndUpdate(roomId, { status: 'dirty', checkInTime: null, items: [] });
  res.json({ success: true, total });
});

app.post('/api/prices', async (req, res) => {
  await Price.findOneAndUpdate({}, req.body, { upsert: true });
  res.json({ success: true });
});

app.post('/api/inventory/import', upload.single('file'), async (req, res) => {
  const workbook = xlsx.readFile(req.file.path);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = xlsx.utils.sheet_to_json(sheet);
  for (const item of data) {
    await Inventory.findOneAndUpdate(
      { name: item['Tên SP'] },
      { name: item['Tên SP'], quantity: item['Số lượng'], purchasePrice: item['Giá nhập'] },
      { upsert: true }
    );
  }
  res.json({ success: true });
});

app.get('/api/reports', async (req, res) => {
  const now = new Date();
  const startOfDay = new Date(now.setHours(0, 0, 0, 0));
  const startOfWeek = new Date(now.setDate(now.getDate() - now.getDay()));
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const daily = await Transaction.aggregate([
    { $match: { checkOutTime: { $gte: startOfDay } } },
    { $group: { _id: null, total: { $sum: '$total' } } },
  ]);

  const weekly = await Transaction.aggregate([
    { $match: { checkOutTime: { $gte: startOfWeek } } },
    { $group: { _id: null, total: { $sum: '$total' } } },
  ]);

  const monthly = await Transaction.aggregate([
    { $match: { checkOutTime: { $gte: startOfMonth } } },
    { $group: { _id: null, total: { $sum: '$total' } } },
  ]);

  res.json({
    daily: daily[0]?.total || 0,
    weekly: weekly[0]?.total || 0,
    monthly: monthly[0]?.total || 0,
  });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
