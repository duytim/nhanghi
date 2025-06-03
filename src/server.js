const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const ExcelJS = require('exceljs');
const path = require('path');
const { Server } = require('socket.io');
const http = require('http');
const Joi = require('joi');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ['http://localhost:3000', 'https://your-production-domain.com'], // Thay bằng domain thực tế khi triển khai
    methods: ['GET', 'POST'],
  }
});

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Middleware kiểm tra kết nối MongoDB
const checkMongoConnection = async (req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ error: 'Mất kết nối với cơ sở dữ liệu' });
  }
  next();
};
app.use(checkMongoConnection);

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/nhanghi', {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

// MongoDB Schemas
const RoomSchema = new mongoose.Schema({
  number: String,
  floor: String,
  status: { type: String, enum: ['vacant', 'occupied', 'dirty'], default: 'vacant' },
  type: { type: String, enum: ['hourly', 'overnight'], default: null },
  checkInTime: Date,
  cccd: String,
  fullName: String,
  items: [{ itemId: mongoose.Schema.Types.ObjectId, quantity: Number }]
});

const InventorySchema = new mongoose.Schema({
  name: String,
  quantity: Number,
  purchasePrice: Number,
  salePrice: Number
});

const PriceSchema = new mongoose.Schema({
  type: String,
  value: Number
});

const TransactionSchema = new mongoose.Schema({
  roomId: mongoose.Schema.Types.ObjectId,
  checkInTime: Date,
  checkOutTime: Date,
  total: Number,
  type: String,
  items: [{ itemId: mongoose.Schema.Types.ObjectId, quantity: Number }],
  surcharge: { amount: Number, note: String }
});

const Room = mongoose.model('Room', RoomSchema);
const Inventory = mongoose.model('Inventory', InventorySchema);
const Price = mongoose.model('Price', PriceSchema);
const Transaction = mongoose.model('Transaction', TransactionSchema);

// Multer Config với giới hạn kích thước
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 } // Giới hạn 5MB
});

// Input Validation Schemas
const checkInSchema = Joi.object({
  roomId: Joi.string().required(),
  items: Joi.array().items(Joi.object({
    itemId: Joi.string().required(),
    quantity: Joi.number().integer().min(0).required()
  })).required(),
  checkInTime: Joi.date().required(),
  type: Joi.string().valid('hourly', 'overnight').required(),
  cccd: Joi.string().when('type', { is: 'overnight', then: Joi.required(), otherwise: Joi.allow('') }),
  fullName: Joi.string().when('type', { is: 'overnight', then: Joi.required(), otherwise: Joi.allow('') })
});

const checkOutSchema = Joi.object({
  roomId: Joi.string().required(),
  surcharge: Joi.object({
    amount: Joi.number().min(0).required(),
    note: Joi.string().allow('')
  }).required()
});

const priceSchema = Joi.object({
  firstHour: Joi.number().min(0).required(),
  extraHour: Joi.number().min(0).required(),
  overnight: Joi.number().min(0).required()
});

const inventorySchema = Joi.object({
  name: Joi.string().required(),
  quantity: Joi.number().integer().min(0).required(),
  purchasePrice: Joi.number().min(0).required(),
  salePrice: Joi.number().min(0).allow(null)
});

// WebSocket
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.on('disconnect', (reason) => {
    console.log(`Client disconnected: ${socket.id}, reason: ${reason}`);
  });
  socket.on('error', (error) => {
    console.error('WebSocket error:', error);
    socket.emit('error', { message: 'Lỗi kết nối WebSocket, đang thử lại...' });
  });
});

// Emit updates mỗi 10 phút
setInterval(async () => {
  try {
    const [rooms, inventoryItems] = await Promise.all([Room.find().lean(), Inventory.find().lean()]);
    io.emit('roomUpdate', { rooms });
    io.emit('inventoryUpdate', inventoryItems);
  } catch (error) {
    console.error('Error emitting updates:', error);
  }
}, 600000);

// API: Get rooms
app.get('/api/rooms', async (req, res) => {
  try {
    const rooms = await Room.find().lean();
    res.status(200).json(rooms);
  } catch (error) {
    console.error('Error fetching rooms:', error);
    res.status(500).json({ error: 'Lỗi server' });
  }
});

// API: Get inventory
app.get('/api/inventory', async (req, res) => {
  try {
    const inventory = await Inventory.find().lean();
    res.status(200).json(inventory);
  } catch (error) {
    console.error('Error fetching inventory:', error);
    res.status(500).json({ error: 'Lỗi server' });
  }
});

// API: Get transactions
app.get('/api/transactions', async (req, res) => {
  try {
    const transactions = await Transaction.find().sort({ checkOutTime: -1 }).lean();
    console.log(`Fetched ${transactions.length} transactions`);
    res.status(200).json(transactions);
  } catch (error) {
    console.error('Error fetching transactions:', error);
    res.status(500).json({ error: 'Lỗi tải giao dịch' });
  }
});

// API: Get reports
app.get('/api/reports', async (req, res) => {
  try {
    const now = new Date();
    const daily = await Transaction.aggregate([
      { $match: { checkOutTime: { $gte: new Date(now.getFullYear(), now.getMonth(), now.getDate()) } } },
      { $group: { _id: null, total: { $sum: '$total' } } }
    ]);
    const weekly = await Transaction.aggregate([
      { $match: { checkOutTime: { $gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) } } },
      { $group: { _id: null, total: { $sum: '$total' } } }
    ]);
    const monthly = await Transaction.aggregate([
      { $match: { checkOutTime: { $gte: new Date(now.getFullYear(), now.getMonth(), 1) } } },
      { $group: { _id: null, total: { $sum: '$total' } } }
    ]);

    res.status(200).json({
      daily: daily[0]?.total || 0,
      weekly: weekly[0]?.total || 0,
      monthly: monthly[0]?.total || 0
    });
  } catch (error) {
    console.error('Error fetching reports:', error);
    res.status(500).json({ error: 'Lỗi báo cáo' });
  }
});

// API: Check-in
app.post('/api/checkin', async (req, res) => {
  try {
    const { error } = checkInSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const { roomId, items, checkInTime, type, cccd, fullName } = req.body;
      const room = await Room.findById(roomId).session(session);
      if (!room || room.status !== 'vacant') {
        throw new Error('Phòng không hợp lệ hoặc đã được sử dụng');
      }

      room.status = 'occupied';
      room.checkInTime = new Date(checkInTime);
      room.type = type;
      room.cccd = cccd;
      room.fullName = fullName;
      room.items = items;

      for (const item of items) {
        const inventoryItem = await Inventory.findById(item.itemId).session(session);
        if (!inventoryItem || inventoryItem.quantity < item.quantity) {
          throw new Error(`Không đủ sản phẩm: ${inventoryItem?.name || item.itemId}`);
        }
        inventoryItem.quantity -= item.quantity;
        await inventoryItem.save({ session });
      }

      await room.save({ session });
      await session.commitTransaction();
      res.status(200).json({ status: 'Check-in success' });
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  } catch (error) {
    console.error('Error checking-in:', error);
    res.status(400).json({ error: error.message });
  }
});

// API: Check-out
app.post('/api/checkout', async (req, res) => {
  try {
    const { error } = checkOutSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const { roomId, surcharge } = req.body;
      const room = await Room.findById(roomId).session(session);
      if (!room || room.status !== 'occupied') {
        throw new Error('Phòng không hợp lệ hoặc chưa được sử dụng');
      }

      const prices = await Price.find().session(session);
      const priceMap = prices.reduce((acc, p) => {
        acc[p.type] = p.value;
        return acc;
      }, {});

      const checkInTime = new Date(room.checkInTime);
      const checkOutTime = new Date();
      const hoursUsed = Math.ceil((checkOutTime.getTime() - checkInTime.getTime()) / (1000 * 60 * 60));

      let total = 0;
      if (room.type === 'hourly') {
        total = priceMap.firstHour + (hoursUsed - 1) * priceMap.extraHour;
      } else {
        total = priceMap.overnight;
      }

      for (const item of room.items) {
        const inventoryItem = await Inventory.findById(item.itemId).session(session);
        if (inventoryItem) {
          total += inventoryItem.salePrice * item.quantity;
        }
      }

      total += surcharge.amount || 0;

      const transaction = new Transaction({
        roomId: room._id,
        checkInTime: room.checkInTime,
        checkOutTime,
        total,
        type: room.type,
        items: room.items,
        surcharge
      });

      await transaction.save({ session });
      room.status = 'dirty';
      room.checkInTime = null;
      room.type = null;
      room.cccd = null;
      room.fullName = null;
      room.items = [];
      await room.save({ session });

      await session.commitTransaction();
      res.status(200).json({
        total,
        checkInTime,
        checkOutTime,
        hoursUsed,
        items: room.items
      });
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  } catch (error) {
    console.error('Error checking-out:', error);
    res.status(400).json({ error: error.message });
  }
});

// API: Clean room
app.post('/api/clean-room', async (req, res) => {
  try {
    const { roomId } = req.body;
    const room = await Room.findById(roomId);
    if (!room || room.status !== 'dirty') {
      throw new Error('Phòng không ở trạng thái cần dọn');
    }
    room.status = 'vacant';
    await room.save();
    res.status(200).json({ status: 'success' });
  } catch (error) {
    console.error('Error cleaning room:', error);
    res.status(400).json({ error: error.message });
  }
});

// API: Update prices
app.post('/api/prices', async (req, res) => {
  try {
    const { error } = priceSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const { firstHour, extraHour, overnight } = req.body;
    await Promise.all([
      Price.updateOne({ type: 'firstHour' }, { value: firstHour }, { upsert: true }),
      Price.updateOne({ type: 'extraHour' }, { value: extraHour }, { upsert: true }),
      Price.updateOne({ type: 'overnight' }, { value: overnight }, { upsert: true })
    ]);
    res.status(200).json({ status: 'success' });
  } catch (error) {
    console.error('Error updating prices:', error);
    res.status(400).json({ error: 'Lỗi cập nhật giá' });
  }
});

// API: Update inventory price
app.post('/api/inventory/price', async (req, res) => {
  try {
    const { error } = inventorySchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const { name, id, quantity, purchasePrice, salePrice } = req.body;
    if (id) {
      await Inventory.updateOne({ _id: id }, { salePrice });
    } else {
      const newItem = new Inventory({
        name,
        quantity,
        purchasePrice,
        salePrice
      });
      await newItem.save();
    }
    res.status(200).json({ status: 'success' });
  } catch (error) {
    console.error('Error updating inventory price:', error);
    res.status(400).json({ error: 'Lỗi cập nhật kho' });
  }
});

// API: Bulk inventory update
app.post('/api/inventory/bulk', async (req, res) => {
  try {
    const items = req.body;
    for (const item of items) {
      const { error } = inventorySchema.validate(item);
      if (error) return res.status(400).json({ error: error.details[0].message });

      const { name, quantity, purchasePrice, salePrice } = item;
      await Inventory.updateOne(
        { name },
        { $inc: { quantity }, purchasePrice, salePrice },
        { upsert: true }
      );
    }
    res.status(200).json({ status: 'success' });
  } catch (error) {
    console.error('Error updating bulk inventory:', error);
    res.status(400).json({ error: 'Lỗi nhập kho hàng loạt' });
  }
});

// API: Import inventory from Excel
app.post('/api/inventory/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      throw new Error('No file uploaded');
    }
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);
    const worksheet = workbook.worksheets[0];
    const items = [];

    worksheet.eachRow((row, rowIndex) => {
      if (rowIndex === 1) return; // Skip header
      items.push({
        name: row.getCell(1).value?.toString(),
        quantity: Number(row.getCell(2).value) || 0,
        purchasePrice: Number(row.getCell(3).value) || 0,
      });
    });

    for (const item of items) {
      const { error } = inventorySchema.validate(item);
      if (error) return res.status(400).json({ error: error.details[0].message });

      await Inventory.updateOne(
        { name: item.name },
        { $inc: { quantity: item.quantity }, purchasePrice: item.purchasePrice },
        { upsert: true }
      );
    }

    res.status(200).json({ status: 'success' });
  } catch (error) {
    console.error('Error importing inventory:', error);
    res.status(400).json({ error: error.message || 'Lỗi nhập file Excel' });
  }
});

// API: Undo checkout
app.post('/api/undo-checkout', async (req, res) => {
  try {
    const { roomId } = req.body;
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const room = await Room.findById(roomId).session(session);
      const lastTransaction = await Transaction.findOne({ roomId }).sort({ checkOutTime: -1 }).session(session);

      if (!room || !lastTransaction) {
        throw new Error('Không tìm thấy giao dịch hoặc phòng hợp lệ');
      }

      room.status = 'occupied';
      room.checkInTime = lastTransaction.checkInTime;
      room.type = lastTransaction.type;
      room.items = lastTransaction.items;
      await room.save({ session });

      for (const item of lastTransaction.items) {
        await Inventory.findByIdAndUpdate(item.itemId, { $inc: { quantity: item.quantity } }, { session });
      }

      await Transaction.deleteOne({ _id: lastTransaction._id }, { session });
      await session.commitTransaction();
      res.status(200).json({ status: 'success' });
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  } catch (error) {
    console.error('Error undoing checkout:', error);
    res.status(400).json({ error: error.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'OK' });
});

// Start server
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
