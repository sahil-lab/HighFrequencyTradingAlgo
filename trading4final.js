// trading.js - Enhanced Trading Logic with Comprehensive Data Fetching and Live Streaming

const binance = require('./config');
const { logMessage } = require('./logger-old');
const {
  calculateRSI,
  calculateMACD,
  calculateSMA,
  calculateEMA,
  calculateStochastic,
  calculateATR,
  calculateBollingerBands,
} = require('./indicators-old');
const readline = require('readline');
const axios = require('axios');
const WebSocket = require('ws');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Balance and Trade Variables
let fakeBalanceInitialized = false;
let fakeBalance = 0;
let realBalance = 0;
let walletBalance = 0;
let fakePnL = 0;
let realPnL = 0;
let spotPnL = 0;
let startTime = Date.now();
let activeTrade = false;
let currentLongTrade = null;
let currentShortTrade = null;
let currentRealLongTrade = null;
let currentRealShortTrade = null;
let currentSpotTrade = null;
let cumulativeProbabilityChange = 0;

// Trading Parameters
const stopLossPercentage = 1.5; // Stop loss percentage
const takeProfitPercentage = 6; // Take profit percentage
const baseProbability = 75; // Base probability for adjustments
const maxSpotDrawdownPercentage = 2; // Spot trading: Max drawdown from peak profit
const leverage = 5; // Leverage for futures trades

// Timeframe Configuration
let timeframe = '1m'; // Default timeframe
const timeframeMap = {
  '1m': 60000,
  '3m': 180000,
  '5m': 300000,
  '15m': 900000,
  '30m': 1800000,
  '1h': 3600000,
  '2h': 7200000,
  '4h': 14400000,
  '6h': 21600000,
  '8h': 28800000,
  '12h': 43200000,
  '1d': 86400000,
  '3d': 259200000,
  '1w': 604800000,
  '1M': 2592000000,
  '1y': 31536000000, // 1 Year
  '3y': 94608000000, // 3 Years
  '5y': 157680000000, // 5 Years
};
let priceCheckInterval = null;

// Historical Data Storage
let historicalData = []; // Array to store historical OHLC data

// Function to Start Price Check Interval
function startPriceCheckInterval() {
  if (priceCheckInterval) {
    clearInterval(priceCheckInterval);
  }
  const timeframeInMs = timeframeMap[timeframe];
  if (!timeframeInMs) {
    logMessage(`Invalid timeframe selected: ${timeframe}. Defaulting to 1m.`);
    timeframe = '1m';
  }
  const intervalMs = timeframeMap[timeframe] || 60000;
  priceCheckInterval = setInterval(checkPrices, intervalMs);
  logMessage(`Price check interval set to every ${timeframe}.`);
}

// Initialize Price Check Interval
startPriceCheckInterval();

// Function to Sleep (to handle rate limits)
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Fetch AVAX Balance
async function getAvaxBalance() {
  try {
    const balances = await new Promise((resolve, reject) => {
      binance.balance((error, balances) => {
        if (error) {
          logMessage(`Failed to fetch balance using Binance library: ${error.body}`);
          reject(error);
        } else {
          resolve(balances);
        }
      });
    });

    if (balances && balances.AVAX) {
      logMessage(`AVAX Balance (using Binance library): ${balances.AVAX.available}`);
      realBalance = parseFloat(balances.AVAX.available);
      if (!fakeBalanceInitialized) {
        fakeBalance = realBalance; // Synchronize fake balance with real balance only once
        walletBalance = realBalance;
        fakeBalanceInitialized = true;
      }
    } else {
      logMessage('AVAX balance not found using Binance library.');
    }
  } catch (error) {
    logMessage(`Error fetching AVAX balance: ${error.message}`);
  }
}

// Fetch OHLC Data for a Given Timeframe
function getAvaxOHLC(interval = '1m', limit = 60) { // Fetch last 60 periods
  return new Promise((resolve, reject) => {
    binance.candlesticks('AVAXUSDT', interval, (error, ticks) => {
      if (error) {
        logMessage(`Failed to fetch OHLC data: ${error.body}`);
        reject(error);
      } else {
        // Each tick is an array: [Open time, Open, High, Low, Close, Volume, ...]
        const ohlc = ticks.map(tick => ({
          openTime: tick[0],
          open: parseFloat(tick[1]),
          high: parseFloat(tick[2]),
          low: parseFloat(tick[3]),
          close: parseFloat(tick[4]),
          volume: parseFloat(tick[5]),
        }));
        resolve(ohlc);
      }
    }, { limit });
  });
}

// Fetch AVAX Price (Close Price of Latest Candlestick)
async function getAvaxPrice() {
  try {
    const ohlc = await getAvaxOHLC(timeframe, 1); // Fetch the latest candlestick
    const latestCandle = ohlc[ohlc.length - 1];
    logMessage(`Current AVAX/USDT Price: ${latestCandle.close}`);
    return latestCandle.close;
  } catch (error) {
    logMessage(`Failed to fetch latest price: ${error.message}`);
    throw error;
  }
}

// Fetch Spot Trading Fee
async function getSpotTradingFee(symbol) {
  try {
    const fees = await binance.tradeFee({ symbol });
    // fees is an array of fee objects
    const feeData = fees.tradeFee.find(fee => fee.symbol === symbol);
    if (feeData) {
      const makerFee = parseFloat(feeData.maker);
      const takerFee = parseFloat(feeData.taker);
      return { makerFee, takerFee };
    } else {
      throw new Error(`Fee data for symbol ${symbol} not found.`);
    }
  } catch (error) {
    logMessage(`Error fetching spot trading fee: ${error.message}`);
    // Default to standard fee rates if fetching fails
    return { makerFee: 0.001, takerFee: 0.001 }; // Example: 0.1%
  }
}

// Fetch Futures Trading Fee
async function getFuturesTradingFee(symbol) {
  try {
    const feeData = await binance.futuresCommissionRate(symbol);
    const makerFee = parseFloat(feeData.makerCommissionRate);
    const takerFee = parseFloat(feeData.takerCommissionRate);
    return { makerFee, takerFee };
  } catch (error) {
    logMessage(`Error fetching futures trading fee: ${error.message}`);
    // Default to standard fee rates if fetching fails
    return { makerFee: 0.0002, takerFee: 0.0004 }; // Example rates
  }
}

// Display Profit and Loss
function displayPnL() {
  logMessage(`Total Fake PnL: ${fakePnL.toFixed(2)} USDT`);
  logMessage(`Total Real PnL: ${realPnL.toFixed(2)} USDT`);
  logMessage(`Total Spot PnL: ${spotPnL.toFixed(2)} USDT`);
}

function displayTradeStatus(currentPrice) {
  // Implement trade status logging or visualization as needed
  logMessage(`Current Price: ${currentPrice} USDT`);
}

// Function to Fetch Comprehensive Historical Data
async function fetchComprehensiveHistoricalData(symbol, interval, startTime, endTime) {
  const limit = 1000; // Max limit per Binance API
  let data = [];
  let currentStartTime = startTime;

  while (currentStartTime < endTime) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${currentStartTime}&endTime=${endTime}&limit=${limit}`;
    try {
      const response = await axios.get(url);
      const fetchedData = response.data;

      if (fetchedData.length === 0) break;

      data = data.concat(fetchedData);

      // Update the currentStartTime to the last fetched candle's close time + 1 ms
      const lastCandle = fetchedData[fetchedData.length - 1];
      currentStartTime = lastCandle[6] + 1;

      // Sleep to respect rate limits
      await sleep(1000); // 1 second
    } catch (error) {
      logMessage(`Error fetching historical data: ${error.message}`);
      await sleep(1000); // Wait before retrying
    }
  }

  return data;
}

// Function to Subscribe to Live Data via WebSocket
function subscribeToLiveData(symbol, interval, onCandleClose) {
  const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@kline_${interval}`);

  ws.on('open', () => {
    logMessage('Connected to Binance WebSocket for live data.');
  });

  ws.on('message', (data) => {
    const parsedData = JSON.parse(data);
    const kline = parsedData.k;
    if (kline.x) { // If the candle is closed
      const candle = {
        openTime: kline.t,
        open: parseFloat(kline.o),
        high: parseFloat(kline.h),
        low: parseFloat(kline.l),
        close: parseFloat(kline.c),
        volume: parseFloat(kline.v),
        closeTime: kline.T,
      };
      logMessage(`Live Candle Closed: ${candle.close}`);
      onCandleClose(candle);
    }
  });

  ws.on('error', (error) => {
    logMessage(`WebSocket error: ${error.message}`);
  });

  ws.on('close', () => {
    logMessage('WebSocket connection closed. Reconnecting...');
    setTimeout(() => subscribeToLiveData(symbol, interval, onCandleClose), 1000); // Reconnect after 1 second
  });
}

// Function to Initialize and Merge Historical Data
async function initializeData(symbol, interval, historicalStartTime) {
  const endTime = Date.now();
  logMessage(`Fetching historical data from ${new Date(historicalStartTime).toISOString()} to ${new Date(endTime).toISOString()}`);
  const fetchedHistoricalData = await fetchComprehensiveHistoricalData(symbol, interval, historicalStartTime, endTime);
  historicalData = fetchedHistoricalData.map(candle => ({
    openTime: candle[0],
    open: parseFloat(candle[1]),
    high: parseFloat(candle[2]),
    low: parseFloat(candle[3]),
    close: parseFloat(candle[4]),
    volume: parseFloat(candle[5]),
    closeTime: candle[6],
  }));
  logMessage(`Fetched ${historicalData.length} historical data points.`);
}

// Check Prices and Initiate Trades
async function checkPrices() {
  if (activeTrade) {
    const currentPrice = await getAvaxPrice();
    displayTradeStatus(currentPrice);
    return;
  }

  try {
    await getAvaxBalance();
    const ohlc = historicalData.slice(-14); // Use the last 14 periods for indicators

    // Technical Indicators
    const rsi = await calculateRSI(ohlc);
    const macd = await calculateMACD(ohlc);
    const sma = await calculateSMA(ohlc);
    const ema = await calculateEMA(ohlc);
    const stochastic = await calculateStochastic(ohlc);
    const atr = await calculateATR(ohlc);
    const bollinger = await calculateBollingerBands(ohlc);

    // Calculate Probability
    let probability = calculateProbability(rsi, macd, sma, ema, stochastic, atr, bollinger);

    // Adjust Probability Based on Time and Cumulative Changes
    const timeElapsed = (Date.now() - startTime) / 1000;
    if (timeElapsed >= 900) { // Reset every 15 minutes
      cumulativeProbabilityChange = 0;
      startTime = Date.now();
    } else {
      cumulativeProbabilityChange += Math.abs(probability - baseProbability);
    }
    if (cumulativeProbabilityChange > 20) {
      probability -= 5;
    }

    logMessage(`Adjusted Probability of Success: ${probability.toFixed(2)}%`);

    // Trade Decision Based on Probability
    if (probability >= 70 && probability <= 80) {
      rl.question('Do you want to take this trade? (yes/no): ', (answer) => {
        if (answer.toLowerCase() === 'yes') {
          // Prompt for Timeframe Selection
          rl.question('Select timeframe (1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 8h, 12h, 1d, 3d, 1w, 1M, 1y, 3y, 5y): ', (selectedTimeframe) => {
            // Validate the selectedTimeframe
            if (!timeframeMap[selectedTimeframe]) {
              logMessage('Invalid timeframe selected. Defaulting to 1m.');
              selectedTimeframe = '1m';
            }
            timeframe = selectedTimeframe;
            startPriceCheckInterval(); // Reset interval based on new timeframe

            rl.question('Do you want to trade Futures or Spot? (futures/spot): ', (tradeType) => {
              rl.question('Do you want to place a real or fake trade? (real/fake): ', (tradeMode) => {
                rl.question(`Enter amount to use for ${tradeMode} ${tradeType} trading (Available: ${(tradeMode === 'real' ? realBalance : fakeBalance)} AVAX): `, async (amount) => {
                  amount = parseFloat(amount);
                  const balance = tradeMode === 'real' ? realBalance : fakeBalance;
                  if (amount > balance) {
                    logMessage(`Insufficient ${tradeMode} balance for trade.`);
                  } else {
                    if (tradeType === 'spot') {
                      logMessage(`${tradeMode.charAt(0).toUpperCase() + tradeMode.slice(1)} Spot trade with amount: ${amount.toFixed(2)} AVAX.`);
                      await placeSpotTrade(getLastClosePrice(ohlc), amount, tradeMode); // Use latest close price
                    } else {
                      const favorableAmount = (2 / 3) * amount;
                      const unfavorableAmount = (1 / 3) * amount;
                      logMessage(`${tradeMode.charAt(0).toUpperCase() + tradeMode.slice(1)} trade with favorable amount of ${favorableAmount.toFixed(2)} AVAX and unfavorable amount of ${unfavorableAmount.toFixed(2)} AVAX.`);
                      await placeFavorableTrade(getLastClosePrice(ohlc), favorableAmount, 'long', tradeMode, 'favorable');
                      await placeUnfavorableTrade(getLastClosePrice(ohlc), unfavorableAmount, 'short', tradeMode, 'unfavorable');
                    }
                    activeTrade = true;
                  }
                });
              });
            });
          });
        } else {
          logMessage('Trade skipped.');
        }
      });
    } else {
      logMessage('Probability not in favorable range. Trade skipped.');
    }
  } catch (error) {
    logMessage(`Error checking prices: ${error.message}`);
  }
}

// Helper Function to Get Last Close Price from OHLC Data
function getLastClosePrice(ohlc) {
  return ohlc[ohlc.length - 1].close;
}

// Place Spot Trade
async function placeSpotTrade(entryPrice, amount, type) {
  const feeRates = await getSpotTradingFee('AVAXUSDT');
  const feeRate = feeRates.takerFee; // Assuming taker orders
  const entryFee = entryPrice * amount * feeRate;

  // Check if balance is sufficient
  const balance = type === 'real' ? realBalance : fakeBalance;
  if ((entryPrice * amount + entryFee) > balance) {
    logMessage(`Insufficient ${type} balance to cover trade and fees.`);
    return;
  }

  // Deduct total cost from balance
  if (type === 'real') {
    realBalance -= (entryPrice * amount + entryFee);
  } else {
    fakeBalance -= (entryPrice * amount + entryFee);
  }
  walletBalance -= amount;

  const stopLoss = entryPrice * (1 - stopLossPercentage / 100);
  const takeProfit = entryPrice * (1 + takeProfitPercentage / 100); // Add take profit

  logMessage(`Placing ${type} Spot trade with amount: ${amount.toFixed(2)} AVAX at price: ${entryPrice}`);
  const trade = { 
    entryPrice, 
    amount, 
    stopLoss, 
    takeProfit, // Include take profit
    peakProfit: 0, 
    peakPrice: entryPrice, // Initialize peak price
    type, 
    startTime: Date.now(), 
    feeRate, 
    entryFee,
    allocation: 'favorable', // Spot trades are favorable
    isReallocated: false,
  };
  currentSpotTrade = trade;
  monitorTrade(trade);
}

// Place Favorable Trade (Long or Short)
async function placeFavorableTrade(entryPrice, amount, direction, type, allocation = 'favorable') {
  const feeRates = type === 'spot' ? await getSpotTradingFee('AVAXUSDT') : await getFuturesTradingFee('AVAXUSDT');
  const feeRate = feeRates.takerFee;
  const entryFee = entryPrice * amount * feeRate;

  // Calculate initial margin for futures
  const initialMargin = type === 'futures' ? (entryPrice * amount) / leverage : 0;

  // Check if balance is sufficient
  const balance = type === 'real' ? realBalance : fakeBalance;
  if (type === 'futures' && (initialMargin + entryFee) > balance) {
    logMessage(`Insufficient ${type} balance to cover trade and fees.`);
    return;
  }
  if (type === 'spot' && (entryPrice * amount + entryFee) > balance) {
    logMessage(`Insufficient ${type} balance to cover trade and fees.`);
    return;
  }

  // Deduct from balance
  if (type === 'real') {
    if (type === 'futures') {
      realBalance -= (initialMargin + entryFee);
    } else {
      realBalance -= (entryPrice * amount + entryFee);
    }
  } else {
    if (type === 'futures') {
      fakeBalance -= (initialMargin + entryFee);
    } else {
      fakeBalance -= (entryPrice * amount + entryFee);
    }
  }

  const stopLoss = direction === 'long'
    ? entryPrice * (1 - stopLossPercentage / 100)
    : entryPrice * (1 + stopLossPercentage / 100);
  const takeProfit = direction === 'long'
    ? entryPrice * (1 + takeProfitPercentage / 100)
    : entryPrice * (1 - takeProfitPercentage / 100);

  logMessage(`Placing ${type} ${direction} trade with amount: ${amount.toFixed(2)} AVAX at price: ${entryPrice}`);
  logMessage(`${type.charAt(0).toUpperCase() + type.slice(1)} trade placed with stop loss at ${stopLoss.toFixed(2)} USDT and take profit at ${takeProfit.toFixed(2)} USDT.`);

  const tradeObj = { 
    entryPrice, 
    amount, 
    stopLoss, 
    takeProfit, 
    peakProfit: 0, 
    peakPrice: entryPrice, 
    type, 
    direction, 
    startTime: Date.now(), 
    leverage, 
    feeRate, 
    entryFee,
    allocation, // 'favorable'
    isReallocated: false, // Initial trade
  };

  if (direction === 'long') {
    type === 'fake' ? (currentLongTrade = tradeObj) : (currentRealLongTrade = tradeObj);
  } else {
    type === 'fake' ? (currentShortTrade = tradeObj) : (currentRealShortTrade = tradeObj);
  }

  monitorTrade(tradeObj);
}

// Place Unfavorable Trade (Long or Short)
async function placeUnfavorableTrade(entryPrice, amount, direction, type, allocation = 'unfavorable') {
  const feeRates = type === 'spot' ? await getSpotTradingFee('AVAXUSDT') : await getFuturesTradingFee('AVAXUSDT');
  const feeRate = feeRates.takerFee;
  const entryFee = entryPrice * amount * feeRate;

  // Calculate initial margin for futures
  const initialMargin = type === 'futures' ? (entryPrice * amount) / leverage : 0;

  // Check if balance is sufficient
  const balance = type === 'real' ? realBalance : fakeBalance;
  if (type === 'futures' && (initialMargin + entryFee) > balance) {
    logMessage(`Insufficient ${type} balance to cover trade and fees.`);
    return;
  }
  if (type === 'spot' && (entryPrice * amount + entryFee) > balance) {
    logMessage(`Insufficient ${type} balance to cover trade and fees.`);
    return;
  }

  // Deduct from balance
  if (type === 'real') {
    if (type === 'futures') {
      realBalance -= (initialMargin + entryFee);
    } else {
      realBalance -= (entryPrice * amount + entryFee);
    }
  } else {
    if (type === 'futures') {
      fakeBalance -= (initialMargin + entryFee);
    } else {
      fakeBalance -= (entryPrice * amount + entryFee);
    }
  }

  const stopLoss = direction === 'long'
    ? entryPrice * (1 - stopLossPercentage / 100)
    : entryPrice * (1 + stopLossPercentage / 100);
  const takeProfit = direction === 'long'
    ? entryPrice * (1 + takeProfitPercentage / 100)
    : entryPrice * (1 - takeProfitPercentage / 100);

  logMessage(`Placing ${type} ${direction} trade with amount: ${amount.toFixed(2)} AVAX at price: ${entryPrice}`);
  logMessage(`${type.charAt(0).toUpperCase() + type.slice(1)} trade placed with stop loss at ${stopLoss.toFixed(2)} USDT and take profit at ${takeProfit.toFixed(2)} USDT.`);

  const tradeObj = { 
    entryPrice, 
    amount, 
    stopLoss, 
    takeProfit, 
    peakProfit: 0, 
    peakPrice: entryPrice, 
    type, 
    direction, 
    startTime: Date.now(), 
    leverage, 
    feeRate, 
    entryFee,
    allocation, // 'unfavorable'
    isReallocated: false, // Initial trade
  };

  if (direction === 'long') {
    type === 'fake' ? (currentLongTrade = tradeObj) : (currentRealLongTrade = tradeObj);
  } else {
    type === 'fake' ? (currentShortTrade = tradeObj) : (currentRealShortTrade = tradeObj);
  }

  monitorTrade(tradeObj);
}

// Unified Monitor Function for Both Long and Short Trades
function monitorTrade(trade) {
  const monitorInterval = setInterval(async () => {
    try {
      const currentPrice = await getAvaxPrice();

      // Update Peak Profit and Peak Price
      let currentProfit = 0;
      if (trade.direction === 'long') {
        currentProfit = (currentPrice - trade.entryPrice) * trade.amount;
      } else {
        currentProfit = (trade.entryPrice - currentPrice) * trade.amount;
      }

      if (currentProfit > trade.peakProfit) {
        trade.peakProfit = currentProfit;
        trade.peakPrice = currentPrice;
      }

      // Calculate Allowed Drawdown
      const allowedDrawdown = trade.peakPrice * maxSpotDrawdownPercentage / 100;
      const maxDrawdownPrice = trade.direction === 'long' ? trade.peakPrice - allowedDrawdown : trade.peakPrice + allowedDrawdown;

      // Check Take Profit
      if ((trade.direction === 'long' && currentPrice >= trade.takeProfit) ||
          (trade.direction === 'short' && currentPrice <= trade.takeProfit)) {
        await handleTradeClosure(trade, currentPrice);
        clearInterval(monitorInterval);
        return;
      }

      // Check Trailing Stop and Stop Loss
      const stopLossHit = (trade.direction === 'long' && (currentPrice <= maxDrawdownPrice || currentPrice <= trade.stopLoss)) ||
                          (trade.direction === 'short' && (currentPrice >= maxDrawdownPrice || currentPrice >= trade.stopLoss));

      if (stopLossHit) {
        await handleTradeClosure(trade, currentPrice);
        clearInterval(monitorInterval);
      }

      displayTradeStatus(currentPrice);
    } catch (error) {
      logMessage(`Error monitoring trade: ${error.message}`);
    }
  }, 5000); // Check every 5 seconds
}

// Handle Trade Closure
async function handleTradeClosure(trade, currentPrice) {
  // Fetch fee rates
  let feeRates;
  if (trade.type === 'spot') {
    feeRates = await getSpotTradingFee('AVAXUSDT');
  } else {
    feeRates = await getFuturesTradingFee('AVAXUSDT');
  }
  const feeRate = feeRates.takerFee; // Assuming taker orders
  const exitFee = currentPrice * trade.amount * feeRate;

  // Calculate gross and net PnL
  const grossPnl = (trade.direction === 'long' ? currentPrice - trade.entryPrice : trade.entryPrice - currentPrice) * trade.amount * (trade.leverage || 1);
  const netPnl = grossPnl - trade.entryFee - exitFee;

  // Determine if trade was favorable or unfavorable
  const isFavorable = trade.allocation === 'favorable';
  const isUnfavorable = trade.allocation === 'unfavorable';

  if (netPnl < 0 && isUnfavorable && !trade.isReallocated) {
    // Reallocate the lost amount into the favorable direction
    const reallocateAmount = trade.amount;
    logMessage(`Unfavorable trade closed with loss. Reallocating ${reallocateAmount.toFixed(2)} AVAX into favorable direction.`);

    // Determine the opposite direction for reallocation
    const newDirection = trade.direction === 'long' ? 'short' : 'long';

    // Place a new favorable trade with the reallocated amount
    await placeFavorableTrade(currentPrice, reallocateAmount, newDirection, trade.type, 'favorable');

    // Mark this trade as reallocated to prevent infinite loops
    trade.isReallocated = true;
  }

  logMessage(`${trade.type.charAt(0).toUpperCase() + trade.type.slice(1)} ${trade.direction.toUpperCase()} Trade closed with ${netPnl >= 0 ? 'profit' : 'loss'}: ${netPnl.toFixed(2)} USDT.`);

  // Update balances with net PnL
  if (trade.type === 'fake') {
    fakeBalance += netPnl + ((trade.entryPrice * trade.amount) / (trade.leverage || 1));
    fakePnL += netPnl;
  } else if (trade.type === 'real') {
    realBalance += netPnl + ((trade.entryPrice * trade.amount) / (trade.leverage || 1));
    realPnL += netPnl;
  } else {
    spotPnL += netPnl;
    walletBalance += trade.amount; // Add back the amount of AVAX
    if (trade.type === 'real') {
      realBalance += trade.entryPrice * trade.amount;
    } else {
      fakeBalance += trade.entryPrice * trade.amount;
    }
  }

  // Reset Trades
  if (trade.type === 'fake') {
    trade.direction === 'long' ? (currentLongTrade = null) : (currentShortTrade = null);
  } else if (trade.type === 'real') {
    trade.direction === 'long' ? (currentRealLongTrade = null) : (currentRealShortTrade = null);
  } else {
    currentSpotTrade = null;
  }

  // Finalize if no active trades
  if (!currentLongTrade && !currentShortTrade && !currentRealLongTrade && !currentRealShortTrade && !currentSpotTrade) {
    finalizeTrade();
  }
}

// Finalize Trade and Ask for Next Action
function finalizeTrade() {
  activeTrade = false;
  displayPnL();
  rl.question('Do you want to place another trade? (yes/no): ', (answer) => {
    if (answer.toLowerCase() === 'yes') {
      checkPrices();
    } else {
      logMessage('Trade session ended.');
      rl.close();
    }
  });
}

// Calculate Probability Based on Technical Indicators
function calculateProbability(rsi, macd, sma, ema, stochastic, atr, bollinger) {
  let probability = baseProbability;

  if (rsi < 30) {
    probability += 10;
  } else if (rsi > 70) {
    probability -= 10;
  }

  if (macd.histogram > 0) {
    probability += 5;
  } else if (macd.histogram < 0) {
    probability -= 5;
  }

  if (sma > ema) {
    probability += 5;
  } else {
    probability -= 5;
  }

  if (stochastic.k < 20 && stochastic.d < 20) {
    probability += 10;
  } else if (stochastic.k > 80 && stochastic.d > 80) {
    probability -= 10;
  }

  if (atr > 0.5) {
    probability -= 5;
  }

  if (bollinger.price < bollinger.lower) {
    probability += 5;
  } else if (bollinger.price > bollinger.upper) {
    probability -= 5;
  }

  return probability;
}

// Function to Handle Incoming Live Candles
function onLiveCandleClose(candle) {
  // Add live candle to historical data
  historicalData.push(candle);

  // Optionally, remove oldest data point to maintain a fixed window
  // For example, keep the last 1000 candles
  if (historicalData.length > 1000) {
    historicalData.shift();
  }

  // Proceed to check prices and possibly initiate trades
  checkPrices();
}

// Function to Aggregate Data for Extended Timeframes (1y, 3y, 5y)
function aggregateCandleData(candles, targetInterval) {
  const aggregatedCandles = [];
  let tempCandle = null;
  let count = 0;

  candles.forEach(candle => {
    if (!tempCandle) {
      tempCandle = { ...candle };
    }
    tempCandle.high = Math.max(tempCandle.high, candle.high);
    tempCandle.low = Math.min(tempCandle.low, candle.low);
    tempCandle.close = candle.close;
    tempCandle.volume += candle.volume;
    count++;

    if (count === targetInterval) {
      aggregatedCandles.push({ ...tempCandle });
      tempCandle = null;
      count = 0;
    }
  });

  return aggregatedCandles;
}

// Initialize and Start the Trading Bot
(async () => {
  const symbol = 'AVAXUSDT';
  const interval = '1m';
  const historicalStartTime = new Date('2020-09-15T00:00:00Z').getTime(); // AVAX Launch Date Approximation

  // Initialize Data
  await initializeData(symbol, interval, historicalStartTime);

  // Aggregate Data for Extended Timeframes if selected
  // Example for 1y:
  /*
  const oneYearCandles = aggregateCandleData(historicalData, 525600); // 525600 minutes in a year
  */

  // Subscribe to Live Data
  subscribeToLiveData(symbol, interval, onLiveCandleClose);
})();
// Export Functions for External Use
module.exports = {
  getAvaxBalance,
  getAvaxPrice,
  checkPrices,
  placeTrade, // Deprecated: use placeFavorableTrade and placeUnfavorableTrade instead
  calculateProbability,
  placeSpotTrade,
};
