require('dotenv').config();
const Binance = require('node-binance-api');
const axios = require('axios');
const crypto = require('crypto');
const readline = require('readline');
const fs = require('fs');
const { RSI, MACD } = require('technicalindicators');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Create a write stream for logging
const logStream = fs.createWriteStream('bot.log', { flags: 'a' });

function logMessage(message) {
  const timestamp = new Date().toISOString();
  const log = `[${timestamp}] ${message}`;
  console.log(log);
  logStream.write(log + '\n');
}

const binance = new Binance().options({
  APIKEY: process.env.BINANCE_API_KEY,
  APISECRET: process.env.BINANCE_API_SECRET,
  useServerTime: true, // Fix for timestamp issue
  recvWindow: 60000, // Increase receive window to avoid timing issues
  family: 4 // Set DNS family to IPv4 to avoid ERR_INVALID_ARG_VALUE
});

let fakeBalance = 0;
let realBalance = 0;
let fakePnL = 0;
let realPnL = 0;
let cumulativeProbabilityChange = 0;
let startTime = Date.now();

// Function to get AVAX balance using Binance library
function getAvaxBalanceWithBinanceLib() {
  return new Promise((resolve, reject) => {
    binance.balance((error, balances) => {
      if (error) {
        logMessage(`Failed to fetch balance using Binance library: ${error.body}`);
        reject(error);
      } else {
        if (balances && balances.AVAX) {
          logMessage(`AVAX Balance (using Binance library): ${balances.AVAX.available}`);
          realBalance = parseFloat(balances.AVAX.available);
          resolve(realBalance);
        } else {
          logMessage('AVAX balance not found using Binance library.');
          resolve(0);
        }
      }
    });
  });
}

// Function to get AVAX balance using Axios with signature
async function getAccountBalanceWithAxios() {
  try {
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}`;
    const signature = crypto.createHmac('sha256', binance.getOption('APISECRET')).update(queryString).digest('hex');

    const response = await axios({
      method: 'GET',
      url: `https://api.binance.com/api/v3/account?${queryString}&signature=${signature}`,
      headers: {
        'X-MBX-APIKEY': binance.getOption('APIKEY')
      }
    });

    if (response.data.balances) {
      const avaxBalance = response.data.balances.find(b => b.asset === 'AVAX');
      logMessage(`AVAX Balance (using Axios): ${avaxBalance ? avaxBalance.free : '0'}`);
      return parseFloat(avaxBalance ? avaxBalance.free : '0');
    } else {
      logMessage('Unable to find balance information using Axios.');
      return 0;
    }
  } catch (error) {
    logMessage(`Failed to fetch balance using Axios: ${error.response ? JSON.stringify(error.response.data) : error.message}`);
    return 0;
  }
}

// Fetch current price of AVAX/USDT
function getAvaxPrice() {
  return new Promise((resolve, reject) => {
    binance.prices('AVAXUSDT', (error, ticker) => {
      if (error) {
        logMessage(`Failed to fetch ticker: ${error.body}`);
        reject(error);
      } else {
        logMessage(`Current AVAX/USDT Price: ${ticker.AVAXUSDT}`);
        resolve(parseFloat(ticker.AVAXUSDT));
      }
    });
  });
}

const stopLossPercentage = 1.5; // Stop loss percentage
const takeProfitPercentage = 6; // Take profit percentage

async function checkPrices() {
  try {
    const price = await getAvaxPrice();

    // Calculate probability based on market data (e.g., RSI, MACD, moving averages)
    const rsi = await calculateRSI();
    const macd = await calculateMACD();
    const probability = calculateProbability(rsi, macd); // Probability calculation based on multiple indicators
    logMessage(`Calculated Probability of Success: ${probability.toFixed(2)}%`);

    // Update cumulative probability change
    const timeElapsed = (Date.now() - startTime) / 1000; // Time elapsed in seconds
    if (timeElapsed >= 900) { // Reset every 15 minutes
      cumulativeProbabilityChange = 0;
      startTime = Date.now();
    } else {
      cumulativeProbabilityChange += Math.abs(probability - 75); // Assuming 75% as the base probability
    }

    if (probability >= 70 && probability <= 80) {
      rl.question('Do you want to take this trade? (yes/no): ', (answer) => {
        if (answer.toLowerCase() === 'yes') {
          rl.question('Do you want to place a real or fake trade? (real/fake): ', (tradeType) => {
            if (tradeType.toLowerCase() === 'fake') {
              fakeBalance = realBalance; // Copy real balance to fake balance
              rl.question(`Enter amount to use for fake trading (Available: ${fakeBalance} AVAX): `, (amount) => {
                amount = parseFloat(amount);
                if (amount > fakeBalance) {
                  logMessage('Insufficient fake balance for trade.');
                } else {
                  logMessage(`Simulated trade with fake balance of ${amount} AVAX.`);
                  placeFakeTrade(price, amount);
                }
              });
            } else if (tradeType.toLowerCase() === 'real') {
              rl.question('Enter amount to use for real trading: ', (amount) => {
                amount = parseFloat(amount);
                if (amount > realBalance) {
                  logMessage('Insufficient real balance for real trade.');
                } else {
                  placeRealTrade(price, amount);
                }
              });
            } else {
              logMessage('Invalid trade type.');
            }
          });
        } else {
          logMessage('Trade skipped.');
        }
      });
    }
  } catch (error) {
    logMessage(`Error checking prices: ${error.message}`);
  }
}

function placeFakeTrade(entryPrice, amount) {
  logMessage(`Placing fake trade with amount: ${amount} AVAX at price: ${entryPrice}`);
  const stopLoss = entryPrice * (1 - stopLossPercentage / 100);
  const takeProfit = entryPrice * (1 + takeProfitPercentage / 100);
  logMessage(`Fake trade placed with stop loss at ${stopLoss.toFixed(2)} USDT and take profit at ${takeProfit.toFixed(2)} USDT.`);

  // Simulate price movement using live data
  const monitorPriceMovement = setInterval(async () => {
    try {
      const currentPrice = await getAvaxPrice();
      logMessage(`Live price update: ${currentPrice.toFixed(2)} USDT`);

      if (currentPrice >= takeProfit) {
        const profit = (takeProfit - entryPrice) * amount;
        fakeBalance += profit;
        fakePnL += profit;
        logMessage(`Fake trade closed with profit: ${profit.toFixed(2)} USDT. Total fake balance: ${fakeBalance.toFixed(2)} AVAX. Total fake PnL: ${fakePnL.toFixed(2)} USDT.`);
        clearInterval(monitorPriceMovement);
      } else if (currentPrice <= stopLoss) {
        const loss = (entryPrice - stopLoss) * amount;
        fakeBalance -= loss;
        fakePnL -= loss;
        logMessage(`Fake trade closed with loss: ${loss.toFixed(2)} USDT. Total fake balance: ${fakeBalance.toFixed(2)} AVAX. Total fake PnL: ${fakePnL.toFixed(2)} USDT.`);
        clearInterval(monitorPriceMovement);
      }
    } catch (error) {
      logMessage(`Error fetching live price during fake trade: ${error.message}`);
    }
  }, 5000); // Check live price every 5 seconds
}

function placeRealTrade(entryPrice, amount) {
  logMessage(`Placing real trade with amount: ${amount} AVAX at price: ${entryPrice}`);
  const stopLoss = entryPrice * (1 - stopLossPercentage / 100);
  const takeProfit = entryPrice * (1 + takeProfitPercentage / 100);
  logMessage(`Real trade placed with stop loss at ${stopLoss.toFixed(2)} USDT and take profit at ${takeProfit.toFixed(2)} USDT.`);

  // Execute real trade using Binance API (This part is commented out for safety)
  // binance.marketBuy('AVAXUSDT', amount, (error, response) => {
  //   if (error) {
  //     logMessage(`Buy order failed: ${error.body}`);
  //   } else {
  //     logMessage(`Buy order successful: ${JSON.stringify(response)}`);
  //     monitorRealPriceMovement(entryPrice, amount, stopLoss, takeProfit);
  //   }
  // });
}

function monitorRealPriceMovement(entryPrice, amount, stopLoss, takeProfit) {
  const monitorPriceMovement = setInterval(async () => {
    try {
      const currentPrice = await getAvaxPrice();
      logMessage(`Live price update: ${currentPrice.toFixed(2)} USDT`);

      if (currentPrice >= takeProfit) {
        const profit = (takeProfit - entryPrice) * amount;
        realBalance += profit;
        realPnL += profit;
        logMessage(`Real trade closed with profit: ${profit.toFixed(2)} USDT. Total real balance: ${realBalance.toFixed(2)} AVAX. Total real PnL: ${realPnL.toFixed(2)} USDT.`);
        clearInterval(monitorPriceMovement);
      } else if (currentPrice <= stopLoss) {
        const loss = (entryPrice - stopLoss) * amount;
        realBalance -= loss;
        realPnL -= loss;
        logMessage(`Real trade closed with loss: ${loss.toFixed(2)} USDT. Total real balance: ${realBalance.toFixed(2)} AVAX. Total real PnL: ${realPnL.toFixed(2)} USDT.`);
        clearInterval(monitorPriceMovement);
      }
    } catch (error) {
      logMessage(`Error fetching live price during real trade: ${error.message}`);
    }
  }, 5000); // Check live price every 5 seconds
}

// Function to calculate RSI
async function calculateRSI() {
    try {
      const bars = await new Promise((resolve, reject) => {
        binance.candlesticks('AVAXUSDT', '15m', (error, ticks, symbol) => {
          if (error) {
            logMessage(`Failed to fetch candlesticks for RSI calculation: ${error.body}`);
            reject(error);
          } else {
            resolve(ticks);
          }
        });
      });
  
      if (!bars || bars.length === 0) {
        logMessage('No candlestick data available for RSI calculation.');
        return 50; // Default value if no data available
      }
  
      const closePrices = bars.map(bar => parseFloat(bar[4]));
  
      const rsiValues = RSI.calculate({
        values: closePrices,
        period: 14
      });
      return rsiValues.length > 0 ? rsiValues[rsiValues.length - 1] : 50;
    } catch (error) {
      logMessage(`Error calculating RSI: ${error.message}`);
      return 50;
    }
  }
  
  // Function to calculate MACD
  async function calculateMACD() {
    try {
      const bars = await new Promise((resolve, reject) => {
        binance.candlesticks('AVAXUSDT', '15m', (error, ticks, symbol) => {
          if (error) {
            logMessage(`Failed to fetch candlesticks for MACD calculation: ${error.body}`);
            reject(error);
          } else {
            resolve(ticks);
          }
        });
      });
  
      if (!bars || bars.length === 0) {
        logMessage('No candlestick data available for MACD calculation.');
        return { MACD: 0, signal: 0, histogram: 0 }; // Default values if no data available
      }
  
      const closePrices = bars.map(bar => parseFloat(bar[4]));
  
      const macdValues = MACD.calculate({
        values: closePrices,
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
        SimpleMAOscillator: false,
        SimpleMASignal: false
      });
      return macdValues.length > 0 ? macdValues[macdValues.length - 1] : { MACD: 0, signal: 0, histogram: 0 };
    } catch (error) {
      logMessage(`Error calculating MACD: ${error.message}`);
      return { MACD: 0, signal: 0, histogram: 0 };
    }
  }

  // Function to calculate probability based on indicators
function calculateProbability(rsi, macd) {
    let probability = 65; // Start with a base probability
  
    if (rsi < 30) {
      probability += 10; // Higher probability for a long position
    } else if (rsi > 70) {
      probability -= 10; // Higher probability for a short position
    }
  
    if (macd.histogram > 0) {
      probability += 5; // Favoring long position
    } else if (macd.histogram < 0) {
      probability -= 5; // Favoring short position
    }
  
    return probability;
  }
  
  
  // Update the bot to start running every 10 seconds
  setInterval(checkPrices, 10000);