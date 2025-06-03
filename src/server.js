const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const multer = require('multer');
const xlsx = require('xlsx');
const { Server } = require('socket.io');
const http = require('http');
const fs = require('fs');
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT || 3000;

// Serve static files from public directory
app.use(express.static(path.join(__dirname, '..', 'public')));

// Serve index.html for root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'), (err) => {
    if (err) {
      console.error('Error sending index.html:', err);
      res.status(404).json({ error: 'Không tìm thấy trang' });
    }
  });
});

app.use(express.json());

// Connect to MongoDB Atlas
mongoose.connect('mongodb+srv://duytim1994:duytim123@nhanghi.qyjrygr.mongodb.net/?retryWrites=true&w=majority&appName=Nhanghi');

// Define schemas
const roomSchema = new mongoose.Schema({
  number: String,
  floor: String,
  status: { type: String, enum: ['vacant', 'occupied', 'dirty'], default: 'vacant' },
  checkInTime: Date,
  items: [{ itemId: String, quantity: Number }],
  type: { type: String, enum: ['hourly', 'overnight'], default: 'hourly' },
  cccd: String,
  fullName: String,
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
  surcharge: { amount: Number, note: String },
  type: String,
  cccd: String,
  fullName: String,
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

// Initialize rooms
const initializeRooms = async () => {
  const rooms = [];
  for (let floor of ['2', '3', '4']) {
    for (let i = 1; i <= 7; i++) {
      if (i !== 4) {
        rooms.push({ number: `${floor}0${i}`, floor, status: 'vacant' });
      }
    }
  }
  await Room.deleteMany({});
  await Room.insertMany(rooms);
};

// Initialize default prices
const initializePrices = async () => {
  await Price.deleteMany({});
  await Price.create({ firstHour: 90000, extraHour: 20000, overnight: 200000 });
};

// Initialize data on MongoDB connection
mongoose.connection.once('open', () => {
  console.log('Connected to MongoDB');
  initializeRooms();
  initializePrices();
});

// WebSocket for real-time updates
io.on('connection', (socket) => {
  console.log('Client connected');
  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// Emit updates to all clients
const emitUpdates = async () => {
  try {
    const [rooms, inventory] = await Promise.all([
      Room.find(),
      Inventory.find(),
    ]);
    io.emit('roomUpdate', rooms);
    io.emit('inventoryUpdate', inventory);
  } catch (error) {
    console.error('Error emitting updates:', error);
  }
};

// Configure multer for Excel uploads
const upload = multer({ dest: 'uploads/' });

// API to get rooms
app.get('/api/rooms', async (req, res) => {
  try {
    const rooms = await Room.find();
    res.status(200).json(rooms);
  } catch (error) {
    console.error('Error fetching rooms:', error);
    res.status(500).json({ error: 'Lỗi khi lấy danh sách phòng' });
  }
});

// API to get inventory
app.get('/api/inventory', async (req, res) => {
  try {
    const inventory = await Inventory.find();
    res.status(200).json(inventory);
  } catch (error) {
    console.error('Error fetching inventory:', error);
    res.status(500).json({ error: 'Lỗi khi lấy danh sách kho' });
  }
});

// API to update or add inventory item
app.post('/api/inventory/price', async (req, res) => {
  try {
    const { id, name, quantity, purchasePrice, salePrice } = req.body;
    if (id) {
      // Update sale price
      if (salePrice === undefined) {
        throw new Error('Giá bán là bắt buộc để cập nhật');
      }
      await Inventory.findByIdAndUpdate(id, { salePrice: salePrice || 0 });
    } else {
      // Add or update item
      if (!name || !name.trim()) {
        throw new Error('Tên sản phẩm là bắt buộc');
      }
      if (quantity === undefined || quantity < 0) {
        throw new Error('Số lượng phải lớn hơn hoặc bằng 0');
      }
      if (purchasePrice === undefined || purchasePrice < 0) {
        throw new Error('Giá nhập phải lớn hơn hoặc bằng 0');
      }
      await Inventory.findOneAndUpdate(
        { name: name.trim() },
        {
          $set: {
            purchasePrice: purchasePrice || 0,
            salePrice: salePrice || 0,
          },
          $inc: { quantity: quantity || 0 },
        },
        { upsert: true }
      );
    }
    await emitUpdates();
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error updating inventory:', error);
    res.status(400).json({ error: error.message });
  }
});

// API for bulk inventory import
app.post('/api/inventory/bulk', async (req, res) => {
  try {
    const items = req.body;
    for (const item of items) {
      if (!item.name || !item.name.trim()) {
        throw new Error('Tên sản phẩm là bắt buộc');
      }
      if (item.quantity < 0) {
        throw new Error('Số lượng phải lớn hơn hoặc bằng 0');
      }
      if (item.purchasePrice < 0) {
        throw new Error('Giá nhập phải lớn hơn hoặc bằng 0');
      }
      await Inventory.findOneAndUpdate(
        { name: item.name.trim() },
        {
          $set: {
            purchasePrice: item.purchasePrice || 0,
            salePrice: item.salePrice || 0,
          },
          $inc: { quantity: item.quantity || 0 },
        },
        { upsert: true }
      );
    }
    await emitUpdates();
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error processing bulk inventory:', error);
    res.status(400).json({ error: error.message });
  }
});

// API for check-in
app.post('/api/checkin', async (req, res) => {
  try {
    const { roomId, items, checkInTime, type, cccd, fullName } = req.body;
    for (const item of items) {
      const inventoryItem = await Inventory.findById(item.itemId);
      if (!inventoryItem || inventoryItem.quantity < item.quantity) {
        throw new Error(`Sản phẩm ${inventoryItem?.name || 'Không xác định'} không đủ số lượng`);
      }
      await Inventory.findByIdAndUpdate(item.itemId, {
        $inc: { quantity: -item.quantity },
      });
    }
    await Room.findByIdAndUpdate(roomId, {
      status: 'occupied',
      checkInTime,
      items,
      type,
      cccd: type === 'overnight' ? cccd : null,
      fullName: type === 'overnight' ? fullName : null,
    });
    await emitUpdates();
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error checking in:', error);
    res.status(500).json({ error: error.message });
  }
});

// API for check-out
app.post('/api/checkout', async (req, res) => {
  try {
    const { roomId, surcharge } = req.body;
    const room = await Room.findById(roomId);
    if (!room) {
      throw new Error('Phòng không tồn tại');
    }
    const prices = await Price.findOne();
    const checkInTime = new Date(room.checkInTime);
    const checkOutTime = new Date();
    const hours = Math.ceil((checkOutTime - checkInTime) / (1000 * 60 * 15)) / 4; // Round to 15-minute intervals
    let total = room.type === 'overnight' ? prices.overnight :
                hours <= 1 ? prices.firstHour : prices.firstHour + (hours - 1) * prices.extraHour;

    const itemsTotal = await Promise.all(
      room.items.map(async (item) => {
        const inventoryItem = await Inventory.findById(item.itemId);
        if (!inventoryItem.salePrice) {
          throw new Error(`Sản phẩm ${inventoryItem.name} chưa có giá bán`);
        }
        return inventoryItem.salePrice * item.quantity;
      })
    );

    total += itemsTotal.reduce((sum, val) => sum + val, 0) + (surcharge?.amount || 0);

    const transaction = await Transaction.create({
      roomId,
      checkInTime,
      checkOutTime,
      total,
      items: room.items,
      surcharge,
      type: room.type,
      cccd: room.cccd,
      fullName: room.fullName,
    });

    await Room.findByIdAndUpdate(roomId, {
      status: 'dirty',
      checkInTime: null,
      items: [],
      type: null,
      cccd: null,
      fullName: null,
    });

    await emitUpdates();
    res.status(200).json({
      success: true,
      total,
      checkInTime,
      checkOutTime,
      hoursUsed: hours,
      items: room.items,
    });
  } catch (error) {
    console.error('Error checking out:', error);
    res.status(500).json({ error: error.message });
  }
});

// API to undo check-out
app.post('/api/undo-checkout', async (req, res) => {
  try {
    const { roomId } = req.body;
    const transaction = await Transaction.findOne({ roomId }).sort({ checkOutTime: -1 });
    if (!transaction) {
      throw new Error('Không tìm thấy giao dịch để hoàn tác');
    }
    await Room.findByIdAndUpdate(roomId, {
      status: 'occupied',
      checkInTime: transaction.checkInTime,
      items: transaction.items,
      type: transaction.type,
      cccd: transaction.cccd,
      fullName: transaction.fullName,
    });
    for (const item of transaction.items) {
      await Inventory.findByIdAndUpdate(item.itemId, {
        $inc: { quantity: item.quantity },
      });
    }
    await Transaction.deleteOne({ _id: transaction._id });
    await emitUpdates();
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error undoing checkout:', error);
    res.status(400).json({ error: error.message });
  }
});

// API to clean room
app.post('/api/clean-room', async (req, res) => {
  try {
    const { roomId } = req.body;
    await Room.findByIdAndUpdate(roomId, { status: 'vacant' });
    await emitUpdates();
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error cleaning room:', error);
    res.status(500).json({ error: 'Lỗi khi dọn phòng' });
  }
});

// API to update prices
app.post('/api/prices', async (req, res) => {
  try {
    await Price.findOneAndUpdate({}, req.body, { upsert: true });
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error updating prices:', error);
    res.status(500).json({ error: 'Lỗi khi cập nhật giá' });
  }
});

// API to import inventory from Excel
app.post('/api/inventory/import', upload.single('file'), async (req, res) => {
  try {
    const workbook = xlsx.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = xlsx.utils.sheet_to_json(sheet);
    for (const item of data) {
      if (!item['Tên SP'] || item['Số lượng'] === undefined || item['Giá nhập'] === undefined) {
        throw new Error('File Excel thiếu cột Tên SP, Số lượng hoặc Giá nhập');
      }
      if (typeof item['Số lượng'] !== 'number' || item['Số lượng'] < 0) {
        throw new Error(`Số lượng không hợp lệ cho sản phẩm ${item['Tên SP']}`);
      }
      if (typeof item['Giá nhập'] !== 'number' || item['Giá nhập'] < 0) {
        throw new Error(`Giá nhập không hợp lệ cho sản phẩm ${item['Tên SP']}`);
      }
      await Inventory.findOneAndUpdate(
        { name: item['Tên SP'] },
        { $set: { purchasePrice: item['Giá nhập'] }, $inc: { quantity: item['Số lượng'] } },
        { upsert: true }
      );
    }
    await emitUpdates();
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error importing inventory:', error);
    res.status(500).json({ error: error.message });
  } finally {
    // Clean up uploaded file
    if (req.file && req.file.path) {
      fs.unlink(req.file.path, (err) => {
        if (err) console.error('Error deleting uploaded file:', err);
      });
    }
  }
});

// API to get transactions
app.get('/api/transactions', async (req, res) => {
  try {
    const transactions = await Transaction.find().sort({ checkOutTime: -1 });
    res.status(200).json(transactions);
  } catch (error) {
    console.error('Error fetching transactions:', error);
    res.status(500).json({ error: 'Lỗi khi lấy giao dịch' });
  }
});

// API for reports
app.get('/api/reports', async (req, res) => {
  try {
    const now = new Date();
    const startOfDay = new Date(now.setHours(0, 0, 0, 0));
    const startOfWeek = new Date(now.setDate(now.getDate() - now.getDay()));
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [daily, weekly, monthly] = await Promise.all([
      Transaction.aggregate([
        { $match: { checkOutTime: { $gte: startOfDay } } },
        { $group: { _id: null, total: { $sum: '$total' } } },
      ]),
      Transaction.aggregate([
        { $match: { checkOutTime: { $gte: startOfWeek } } },
        { $group: { _id: null, total: { $sum: '$total' } } },
      ]),
      Transaction.aggregate([
        { $match: { checkOutTime: { $gte: startOfMonth } } },
        { $group: { _id: null, total: { $sum: '$total' } } },
      ]),
    ]);

    res.status(200).json({
      daily: daily[0]?.total || 0,
      weekly: weekly[0]?.total || 0,
      monthly: monthly[0]?.total || 0,
    });
  } catch (error) {
    console.error('Error generating reports:', error);
    res.status(500).json({ error: 'Lỗi khi tạo báo cáo' });
  }
});

// Health check API
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'Server is running' });
});

// Start server
server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
