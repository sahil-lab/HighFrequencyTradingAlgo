require('dotenv').config();
const Binance = require('node-binance-api');
const axios = require('axios');
const crypto = require('crypto');

const binance = new Binance().options({
  APIKEY: process.env.BINANCE_API_KEY,
  APISECRET: process.env.BINANCE_API_SECRET
});

// Function to get AVAX balance using Binance library
function getAvaxBalanceWithBinanceLib() {
  binance.balance((error, balances) => {
    if (error) {
      console.error(`Failed to fetch balance using Binance library: ${error.body}`);
    } else {
      if (balances && balances.AVAX) {
        console.log(`AVAX Balance (using Binance library): ${balances.AVAX.available}`);
      } else {
        console.log('AVAX balance not found using Binance library.');
      }
    }
  });
}

// Function to get AVAX balance using Axios with signature
async function getAccountBalanceWithAxios() {
  try {
    // Create timestamp
    const timestamp = Date.now();

    // Create query string and signature
    const queryString = `timestamp=${timestamp}`;
    const signature = crypto.createHmac('sha256', binance.getOption('APISECRET')).update(queryString).digest('hex');

    // Make the request to Binance API
    const response = await axios({
      method: 'GET',
      url: `https://api.binance.com/api/v3/account?${queryString}&signature=${signature}`,
      headers: {
        'X-MBX-APIKEY': binance.getOption('APIKEY')
      }
    });

    // Extract AVAX balance from response
    if (response.data.balances) {
      const avaxBalance = response.data.balances.find(b => b.asset === 'AVAX');
      console.log(`AVAX Balance (using Axios): ${avaxBalance ? avaxBalance.free : '0'}`);
    } else {
      console.log('Unable to find balance information using Axios.');
    }
  } catch (error) {
    console.error('Failed to fetch balance using Axios:', error.response ? error.response.data : error.message);
  }
}

// Fetch current price of AVAX/USDT
function getAvaxPrice() {
  binance.prices('AVAXUSDT', (error, ticker) => {
    if (error) {
      console.error(`Failed to fetch ticker: ${error.body}`);
    } else {
      console.log(`Current AVAX/USDT Price: ${ticker.AVAXUSDT}`);
    }
  });
}

const buyPriceThreshold = 10; // Example threshold price to buy
const sellPriceThreshold = 15; // Example threshold price to sell

function checkPrices() {
  binance.prices('AVAXUSDT', (error, ticker) => {
    if (error) {
      console.error(`Failed to fetch ticker: ${error.body}`);
    } else {
      const price = parseFloat(ticker.AVAXUSDT);
      console.log(`Current AVAX/USDT Price: ${price}`);

      if (price < buyPriceThreshold) {
        console.log('Buying AVAX...');
        binance.marketBuy('AVAXUSDT', 1, (error, response) => { // Buying 1 AVAX as an example
          if (error) {
            console.error(`Buy order failed: ${error.body}`);
          } else {
            console.log('Buy order executed:', response);
          }
        });
      } else if (price > sellPriceThreshold) {
        console.log('Selling AVAX...');
        binance.marketSell('AVAXUSDT', 1, (error, response) => { // Selling 1 AVAX as an example
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

// Optimize to only check prices if the balance fetching succeeds
async function runBot() {
  // Fetch balance using both methods to ensure data consistency
  await getAccountBalanceWithAxios();
  getAvaxBalanceWithBinanceLib();

  // Fetch the current price and check thresholds
  setInterval(() => {
    getAvaxPrice();
    checkPrices();
  }, 10000);
}

runBot();