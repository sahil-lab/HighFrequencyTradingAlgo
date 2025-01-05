// tradeSchema.js
const mongoose = require('mongoose');

const tradeSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  entryPrice: { type: String, required: true },
  amount: { type: String, required: true },
  stopLoss: { type: String, required: true },
  takeProfit: { type: String, required: true },
  direction: { type: String, enum: ['long', 'short'], required: true },
  type: { type: String, enum: ['real', 'fake'], required: true },
  outcome: { type: String, enum: ['win', 'loss'], required: false },
  entryTime: { type: Date, required: true },
  exitTime: { type: Date, required: false },
  netPnl: { type: String, required: false },
  allocation: { type: String, enum: ['favorable', 'unfavorable'], required: true },
  isReallocated: { type: Boolean, default: false },
});

module.exports = mongoose.model('Trade', tradeSchema);
