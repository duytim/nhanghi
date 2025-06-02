const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const multer = require('multer');
const xlsx = require('xlsx');
const app = express();
const port = process.env.PORT || 3000;

// Phục vụ file tĩnh từ thư mục public
app.use(express.static(path.join(__dirname, '..', 'public')));

// Tuyến đường gốc để trả về index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'), (err) => {
    if (err) {
      console.error('Lỗi khi gửi index.html:', err);
      res.status(404).json({ error: 'Không tìm thấy trang' });
    }
  });
});

// Middleware để xử lý JSON
app.use(express.json());

// Kết nối MongoDB Atlas
mongoose.connect('mongodb+srv://duytim1994:duytim123@nhanghi.qyjrygr.mongodb.net/?retryWrites=true&w=majority&appName=Nhanghi');

// Định nghĩa schema
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
  surcharge: { amount: Number, note: String },
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

// Khởi tạo danh sách phòng
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

// Khởi tạo giá mặc định
const initializePrices = async () => {
  await Price.deleteMany({});
  await Price.create({ firstHour: 90000, extraHour: 20000, overnight: 200000 });
};

// Khởi tạo dữ liệu khi kết nối MongoDB
mongoose.connection.once('open', () => {
  console.log('Connected to MongoDB');
  initializeRooms();
  initializePrices();
});

// Cấu hình multer để xử lý upload file Excel
const upload = multer({ dest: 'uploads/' });

// API lấy danh sách phòng
app.get('/api/rooms', async (req, res) => {
  try {
    const rooms = await Room.find();
    res.json(rooms);
  } catch (error) {
    console.error('Lỗi khi lấy danh sách phòng:', error);
    res.status(500).json({ error: 'Lỗi khi lấy danh sách phòng' });
  }
});

// API lấy danh sách kho
app.get('/api/inventory', async (req, res) => {
  try {
    const inventory = await Inventory.find();
    res.json(inventory);
  } catch (error) {
    console.error('Lỗi khi lấy danh sách kho:', error);
    res.status(500).json({ error: 'Lỗi khi lấy danh sách kho' });
  }
});

// API cập nhật giá bán sản phẩm
app.post('/api/inventory/price', async (req, res) => {
  try {
    const { id, salePrice } = req.body;
    await Inventory.findByIdAndUpdate(id, { salePrice });
    res.json({ success: true });
  } catch (error) {
    console.error('Lỗi khi cập nhật giá sản phẩm:', error);
    res.status(500).json({ error: 'Lỗi khi cập nhật giá sản phẩm' });
  }
});

// API check-in
app.post('/api/checkin', async (req, res) => {
  try {
    const { roomId, items, checkInTime } = req.body;
    await Room.findByIdAndUpdate(roomId, { status: 'occupied', checkInTime, items });
    res.json({ success: true });
  } catch (error) {
    console.error('Lỗi khi check-in:', error);
    res.status(500).json({ error: 'Lỗi khi check-in' });
  }
});

// API check-out
app.post('/api/checkout', async (req, res) => {
  try {
    const { roomId, surcharge } = req.body;
    const room = await Room.findById(roomId);
    const prices = await Price.findOne();
    const checkInTime = new Date(room.checkInTime);
    const checkOutTime = new Date();
    const hours = Math.ceil((checkOutTime - checkInTime) / (1000 * 60 * 15)) / 4; // Làm tròn 15 phút
    let total = hours <= 1 ? prices.firstHour : prices.firstHour + (hours - 1) * prices.extraHour;

    // Kiểm tra nếu là nghỉ qua đêm
    if (checkOutTime.getHours() >= 22 || checkInTime.getHours() < 10) {
      total = prices.overnight;
    }

    // Tính tổng tiền từ các mặt hàng
    const itemsTotal = await Promise.all(
      room.items.map(async (item) => {
        const inventoryItem = await Inventory.findById(item.itemId);
        if (!inventoryItem.salePrice) {
          throw new Error(`Mặt hàng ${inventoryItem.name} chưa có giá bán`);
        }
        await Inventory.findByIdAndUpdate(item.itemId, {
          $inc: { quantity: -item.quantity },
        });
        return inventoryItem.salePrice * item.quantity;
      })
    );

    total += itemsTotal.reduce((sum, val) => sum + val, 0) + (surcharge?.amount || 0);

    // Lưu giao dịch
    await Transaction.create({
      roomId,
      checkInTime,
      checkOutTime,
      total,
      items: room.items,
      surcharge,
    });

    // Cập nhật trạng thái phòng
    await Room.findByIdAndUpdate(roomId, { status: 'dirty', checkInTime: null, items: [] });
    res.json({ success: true, total });
  } catch (error) {
    console.error('Lỗi khi check-out:', error);
    res.status(500).json({ error: error.message });
  }
});

// API cập nhật giá
app.post('/api/prices', async (req, res) => {
  try {
    await Price.findOneAndUpdate({}, req.body, { upsert: true });
    res.json({ success: true });
  } catch (error) {
    console.error('Lỗi khi cập nhật giá:', error);
    res.status(500).json({ error: 'Lỗi khi cập nhật giá' });
  }
});

// API nhập kho từ Excel
app.post('/api/inventory/import', upload.single('file'), async (req, res) => {
  try {
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
  } catch (error) {
    console.error('Lỗi khi nhập kho:', error);
    res.status(500).json({ error: 'Lỗi khi nhập kho' });
  }
});

// API báo cáo thu chi
app.get('/api/reports', async (req, res) => {
  try {
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
  } catch (error) {
    console.error('Lỗi khi tạo báo cáo:', error);
    res.status(500).json({ error: 'Lỗi khi tạo báo cáo' });
  }
});

// API kiểm tra sức khỏe server
app.get('/health', (req, res) => {
  res.json({ status: 'Server is running' });
});

// Khởi động server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
