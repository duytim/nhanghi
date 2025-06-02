const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const moment = require("moment");

const app = express();
app.use(cors());
app.use(express.json());

mongoose.connect("mongodb://localhost/hotel_management", { useNewUrlParser: true, useUnifiedTopology: true });

const roomSchema = new mongoose.Schema({
  roomNumber: Number,
  status: { type: String, enum: ["Trống", "Có khách", "Chưa vệ sinh"], default: "Trống" },
  checkInTime: Date,
  extraItems: [{ itemId: String, name: String, quantity: Number }],
  additionalFee: { amount: Number, note: String },
});

const inventorySchema = new mongoose.Schema({
  name: String,
  quantity: Number,
  price: Number,
  importPrice: Number,
});

const transactionSchema = new mongoose.Schema({
  roomId: String,
  checkInTime: Date,
  checkOutTime: Date,
  totalAmount: Number,
  extraItems: [{ itemId: String, name: String, quantity: Number, price: Number }],
  additionalFee: { amount: Number, note: String },
});

const Room = mongoose.model("Room", roomSchema);
const Inventory = mongoose.model("Inventory", inventorySchema);
const Transaction = mongoose.model("Transaction", transactionSchema);

const initializeRooms = async () => {
  const rooms = [];
  for (let floor = 2; floor <= 4; floor++) {
    for (let i = 1; i <= 7; i++) {
      if (i !== 5) {
        rooms.push({ roomNumber: floor * 100 + i, status: "Trống" });
      }
    }
  }
  await Room.deleteMany({});
  await Room.insertMany(rooms);
};

initializeRooms();

app.get("/api/rooms", async (req, res) => {
  const rooms = await Room.find();
  res.json(rooms);
});

app.get("/api/inventory", async (req, res) => {
  const inventory = await Inventory.find();
  res.json(inventory);
});

app.post("/api/inventory/import", async (req, res) => {
  const items = req.body;
  for (const item of items) {
    await Inventory.findOneAndUpdate(
      { name: item["Tên SP"] },
      { $set: { quantity: item["Số lượng"], importPrice: item["Giá nhập"] } },
      { upsert: true }
    );
  }
  res.json({ success: true });
});

app.post("/api/inventory/price", async (req, res) => {
  const { itemId, price } = req.body;
  await Inventory.findByIdAndUpdate(itemId, { price });
  res.json({ success: true });
});

app.post("/api/checkin", async (req, res) => {
  const { roomId, checkInTime, extraItems, additionalFee } = req.body;
  await Room.findByIdAndUpdate(roomId, { status: "Có khách", checkInTime, extraItems, additionalFee });
  for (const item of extraItems) {
    await Inventory.findByIdAndUpdate(item.id, { $inc: { quantity: -item.quantity } });
  }
  res.json({ success: true });
});

app.post("/api/checkout", async (req, res) => {
  const { roomId } = req.body;
  const room = await Room.findById(roomId);
  const checkInTime = moment(room.checkInTime);
  const checkOutTime = moment();
  const durationHours = Math.ceil(checkOutTime.diff(checkInTime, "minutes") / 15) * 0.25;
  let totalAmount = 0;

  if (checkOutTime.hour() >= 22 || checkInTime.hour() <= 4) {
    totalAmount = 200000;
  } else {
    totalAmount = 90000 + Math.max(0, durationHours - 1) * 20000;
  }

  for (const item of room.extraItems) {
    const inventoryItem = await Inventory.findById(item.itemId);
    totalAmount += item.quantity * (inventoryItem.price || 0);
  }
  totalAmount += room.additionalFee.amount || 0;

  await Transaction.create({
    roomId,
    checkInTime,
    checkOutTime,
    totalAmount,
    extraItems: room.extraItems,
    additionalFee: room.additionalFee,
  });

  await Room.findByIdAndUpdate(roomId, {
    status: "Chưa vệ sinh",
    checkInTime: null,
    extraItems: [],
    additionalFee: { amount: 0, note: "" },
  });

  res.json({ success: true });
});

app.get("/api/reports", async (req, res) => {
  const daily = await Transaction.aggregate([
    { $match: { checkOutTime: { $gte: moment().startOf("day").toDate() } } },
    { $group: { _id: null, total: { $sum: "$totalAmount" } } },
  ]);

  const weekly = await Transaction.aggregate([
    { $match: { checkOutTime: { $gte: moment().startOf("week").toDate() } } },
    { $group: { _id: null, total: { $sum: "$totalAmount" } } },
  ]);

  const monthly = await Transaction.aggregate([
    { $match: { checkOutTime: { $gte: moment().startOf("month").toDate() } } },
    { $group: { _id: null, total: { $sum: "$totalAmount" } } },
  ]);

  res.json({
    daily: daily[0]?.total || 0,
    weekly: weekly[0]?.total || 0,
    monthly: monthly[0]?.total || 0,
  });
});

app.listen(3000, () => console.log("Server running on port 3000"));
