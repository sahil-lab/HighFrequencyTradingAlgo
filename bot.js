require('dotenv').config();
const Binance = require('node-binance-api');

const binance = new Binance().options({
  APIKEY: process.env.BINANCE_API_KEY,
  APISECRET: process.env.BINANCE_API_SECRET
});

// Fetch account balance
binance.balance((error, balances) => {
  if (error) {
    console.error(`Failed to fetch balance: ${error.body}`);
  } else {
    console.log(`BTC Balance: ${balances.BTC.available}`);
  }
});

// Fetch current price of BTC/USDT
binance.prices('BTCUSDT', (error, ticker) => {
  if (error) {
    console.error(`Failed to fetch ticker: ${error.body}`);
  } else {
    console.log(`Current BTC/USDT Price: ${ticker.BTCUSDT}`);
  }
});

const buyPriceThreshold = 30000; // Example threshold price to buy
const sellPriceThreshold = 35000; // Example threshold price to sell

function checkPrices() {
  binance.prices('BTCUSDT', (error, ticker) => {
    if (error) {
      console.error(`Failed to fetch ticker: ${error.body}`);
    } else {
      const price = parseFloat(ticker.BTCUSDT);
      console.log(`Current BTC/USDT Price: ${price}`);

      if (price < buyPriceThreshold) {
        console.log('Buying BTC...');
        binance.marketBuy('BTCUSDT', 0.001, (error, response) => {
          if (error) {
            console.error(`Buy order failed: ${error.body}`);
          } else {
            console.log('Buy order executed:', response);
          }
        });
      } else if (price > sellPriceThreshold) {
        console.log('Selling BTC...');
        binance.marketSell('BTCUSDT', 0.001, (error, response) => {
          if (error) {
            console.error(`Sell order failed: ${error.body}`);
          } else {
            console.log('Sell order executed:', response);
          }
        });
      }
    }
  });
}

// Check prices every 10 seconds
setInterval(checkPrices, 10000);
