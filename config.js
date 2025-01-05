// config.js - Configuration and Binance Initialization
require('dotenv').config();
const Binance = require('node-binance-api');

const binance = new Binance().options({
  APIKEY: process.env.BINANCE_API_KEY,
  APISECRET: process.env.BINANCE_API_SECRET,
  useServerTime: true, // Fix for timestamp issue
  recvWindow: 60000, // Increase receive window to avoid timing issues
  family: 4 // Set DNS family to IPv4 to avoid ERR_INVALID_ARG_VALUE
});

module.exports = binance;
