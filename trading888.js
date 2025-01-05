// trading.js - Enhanced Trading Logic with Comprehensive Data Fetching, Live Streaming, and MongoDB Integration

require('dotenv').config();

const mongoose = require('mongoose');
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
const inquirer = require('inquirer');
const WebSocket = require('ws');
const Decimal = require('decimal.js');
const Bottleneck = require('bottleneck');

// ===================== MongoDB Setup =====================

mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

const db = mongoose.connection;

db.on('error', (error) => logMessage(`MongoDB connection error: ${error.message}`, 'error'));
db.once('open', () => logMessage('Connected to MongoDB successfully.', 'info'));

const ohlcSchema = new mongoose.Schema({
  symbol: { type: String, required: true, index: true },
  interval: { type: String, required: true, index: true },
  openTime: { type: Date, required: true, index: true },
  open: Number,
  high: Number,
  low: Number,
  close: Number,
  volume: Number,
  closeTime: Date,
});

ohlcSchema.index({ symbol: 1, interval: 1, openTime: 1 });

const OHLC = mongoose.model('OHLC', ohlcSchema);

// ===================== Rate Limiter Setup =====================

const limiter = new Bottleneck({
  minTime: 200,
  maxConcurrent: 1,
});

// ===================== Balance and Trade Variables =====================

let fakeBalanceInitialized = false;
let fakeBalance = new Decimal(0);
let realBalance = new Decimal(0);
let walletBalance = new Decimal(0);
let fakePnL = new Decimal(0);
let realPnL = new Decimal(0);
let spotPnL = new Decimal(0);
let startTime = Date.now();
let activeTrades = [];
let cumulativeProbabilityChange = 0;

// ===================== Trading Parameters =====================

const stopLossPercentage = new Decimal(1.5);
const takeProfitPercentage = new Decimal(6);
const baseProbability = new Decimal(75);
const maxSpotDrawdownPercentage = new Decimal(2);
const leverage = new Decimal(5);

// ===================== Timeframe Configuration =====================

let timeframe = '1m';
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
  '1y': 31536000000,
  '3y': 94608000000,
  '5y': 157680000000,
};
let priceCheckInterval = null;

// ===================== Historical Data Storage =====================

let historicalData = [];

// ===================== Function Definitions =====================

function startPriceCheckInterval() {
  if (priceCheckInterval) {
    clearInterval(priceCheckInterval);
  }
  const timeframeInMs = timeframeMap[timeframe];
  if (!timeframeInMs) {
    logMessage(`Invalid timeframe selected: ${timeframe}. Defaulting to 1m.`, 'warning');
    timeframe = '1m';
  }
  const intervalMs = timeframeMap[timeframe] || 60000;
  priceCheckInterval = setInterval(() => {
    checkPrices().catch((error) => {
      logMessage(`Error in price check interval: ${error.message}`, 'error');
    });
  }, intervalMs);
  logMessage(`Price check interval set to every ${timeframe}.`, 'info');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getAvaxBalance() {
  try {
    const balances = await limiter.schedule(() =>
      new Promise((resolve, reject) => {
        binance.balance((error, balances) => {
          if (error) {
            logMessage(`Failed to fetch balance using Binance library: ${error.body}`, 'error');
            return reject(error);
          }
          resolve(balances);
        });
      })
    );

    if (balances && balances.AVAX) {
      logMessage(`AVAX Balance (using Binance library): ${balances.AVAX.available}`, 'info');
      realBalance = new Decimal(balances.AVAX.available);
      if (!fakeBalanceInitialized) {
        fakeBalance = realBalance;
        walletBalance = realBalance;
        fakeBalanceInitialized = true;
      }
    } else {
      logMessage('AVAX balance not found using Binance library.', 'warning');
    }
  } catch (error) {
    logMessage(`Error fetching AVAX balance: ${error.message}`, 'error');
  }
}

async function getAvaxOHLC(interval = '1m', limit = 60) {
  try {
    const ticks = await limiter.schedule(() =>
      new Promise((resolve, reject) => {
        binance.candlesticks('AVAXUSDT', interval, (error, ticks) => {
          if (error) {
            logMessage(`Failed to fetch OHLC data: ${error.body}`, 'error');
            return reject(error);
          }
          resolve(ticks);
        }, { limit });
      })
    );

    const ohlc = ticks.map((tick) => ({
      symbol: 'AVAXUSDT',
      interval: interval,
      openTime: new Date(tick[0]),
      open: parseFloat(tick[1]),
      high: parseFloat(tick[2]),
      low: parseFloat(tick[3]),
      close: parseFloat(tick[4]),
      volume: parseFloat(tick[5]),
      closeTime: new Date(tick[6]),
    }));

    await Promise.all(
      ohlc.map((candle) =>
        OHLC.findOneAndUpdate(
          { symbol: candle.symbol, interval: candle.interval, openTime: candle.openTime },
          candle,
          { upsert: true, new: true }
        )
      )
    );

    logMessage(`Saved ${ohlc.length} candles to MongoDB.`, 'info');
    return ohlc;
  } catch (error) {
    logMessage(`Error fetching OHLC data: ${error.message}`, 'error');
    throw error;
  }
}

async function getAvaxPrice() {
  try {
    const ohlc = await getAvaxOHLC(timeframe, 1);
    const latestCandle = ohlc[ohlc.length - 1];
    logMessage(`Current AVAX/USDT Price: ${latestCandle.close}`, 'info');
    return latestCandle.close;
  } catch (error) {
    logMessage(`Failed to fetch latest price: ${error.message}`, 'error');
    throw error;
  }
}

async function getSpotTradingFee(symbol) {
  try {
    const fees = await limiter.schedule(() =>
      new Promise((resolve, reject) => {
        binance.tradeFee({ symbol }, (error, fees) => {
          if (error) {
            logMessage(`Failed to fetch spot trading fee: ${error.body}`, 'error');
            return reject(error);
          }
          resolve(fees);
        });
      })
    );

    const feeData = fees.find((fee) => fee.symbol === symbol);
    if (feeData) {
      const makerFee = new Decimal(feeData.maker);
      const takerFee = new Decimal(feeData.taker);
      return { makerFee, takerFee };
    } else {
      throw new Error(`Fee data for symbol ${symbol} not found.`);
    }
  } catch (error) {
    logMessage(`Error fetching spot trading fee: ${error.message}. Using default fees.`, 'warning');
    return { makerFee: new Decimal(0.001), takerFee: new Decimal(0.001) };
  }
}

async function getFuturesTradingFee(symbol) {
  try {
    const feeData = await limiter.schedule(() =>
      binance.futuresCommissionRate(symbol)
    );

    const makerFee = new Decimal(feeData.makerCommissionRate);
    const takerFee = new Decimal(feeData.takerCommissionRate);
    return { makerFee, takerFee };
  } catch (error) {
    logMessage(`Error fetching futures trading fee: ${error.message}. Using default fees.`, 'warning');
    return { makerFee: new Decimal(0.0002), takerFee: new Decimal(0.0004) };
  }
}

function displayPnL() {
  logMessage(`Total Fake PnL: ${fakePnL.toFixed(2)} USDT`, 'info');
  logMessage(`Total Real PnL: ${realPnL.toFixed(2)} USDT`, 'info');
  logMessage(`Total Spot PnL: ${spotPnL.toFixed(2)} USDT`, 'info');
}

function displayTradeStatus(currentPrice) {
  logMessage(`Current Price: ${currentPrice} USDT`, 'info');
}

async function fetchHistoricalDataFromDB(symbol, interval, startTime, endTime) {
  try {
    const data = await OHLC.find({
      symbol: symbol,
      interval: interval,
      openTime: { $gte: new Date(startTime), $lte: new Date(endTime) },
    }).sort({ openTime: 1 }).exec();

    return data.map((candle) => ({
      openTime: candle.openTime.getTime(),
      open: new Decimal(candle.open),
      high: new Decimal(candle.high),
      low: new Decimal(candle.low),
      close: new Decimal(candle.close),
      volume: new Decimal(candle.volume),
      closeTime: candle.closeTime.getTime(),
    }));
  } catch (error) {
    logMessage(`Error fetching historical data from DB: ${error.message}`, 'error');
    throw error;
  }
}

async function saveHistoricalDataToDB(symbol, interval, candles) {
  try {
    const ohlc = candles.map((candle) => ({
      symbol: symbol,
      interval: interval,
      openTime: new Date(candle.openTime),
      open: parseFloat(candle.open),
      high: parseFloat(candle.high),
      low: parseFloat(candle.low),
      close: parseFloat(candle.close),
      volume: parseFloat(candle.volume),
      closeTime: new Date(candle.closeTime),
    }));

    await Promise.all(
      ohlc.map((candle) =>
        OHLC.findOneAndUpdate(
          { symbol: candle.symbol, interval: candle.interval, openTime: candle.openTime },
          candle,
          { upsert: true, new: true }
        )
      )
    );

    logMessage(`Saved ${ohlc.length} candles to MongoDB.`, 'info');
  } catch (error) {
    logMessage(`Error saving historical data to DB: ${error.message}`, 'error');
  }
}

async function initializeData(symbol, interval, historicalStartTime) {
  const endTime = Date.now();
  logMessage(`Fetching historical data from ${new Date(historicalStartTime).toISOString()} to ${new Date(endTime).toISOString()}`, 'info');

  let fetchedHistoricalData = await fetchHistoricalDataFromDB(symbol, interval, historicalStartTime, endTime);

  if (fetchedHistoricalData.length === 0) {
    logMessage('No historical data found in DB. Fetching from Binance API.', 'warning');
    fetchedHistoricalData = await getAvaxOHLC(interval, 1000);
    await saveHistoricalDataToDB(symbol, interval, fetchedHistoricalData);
  } else {
    logMessage(`Fetched ${fetchedHistoricalData.length} historical data points from DB.`, 'info');
    const latestCandleTime = fetchedHistoricalData[fetchedHistoricalData.length - 1].closeTime;
    const newCandles = await getAvaxOHLC(interval, 1000);
    const filteredNewCandles = newCandles.filter((candle) => candle.closeTime > latestCandleTime);
    if (filteredNewCandles.length > 0) {
      await saveHistoricalDataToDB(symbol, interval, filteredNewCandles);
      fetchedHistoricalData = fetchedHistoricalData.concat(
        filteredNewCandles.map((candle) => ({
          openTime: candle.openTime,
          open: new Decimal(candle.open),
          high: new Decimal(candle.high),
          low: new Decimal(candle.low),
          close: new Decimal(candle.close),
          volume: new Decimal(candle.volume),
          closeTime: candle.closeTime,
        }))
      );
      logMessage(`Added ${filteredNewCandles.length} new candles to historical data.`, 'info');
    } else {
      logMessage('No new candles to add.', 'info');
    }
  }

  historicalData = fetchedHistoricalData;
  validateHistoricalData(historicalData);
}

function validateHistoricalData(data) {
  for (let i = 1; i < data.length; i++) {
    const expectedOpenTime = data[i - 1].closeTime + 1;
    if (data[i].openTime !== expectedOpenTime) {
      logMessage(`Data gap detected between ${new Date(data[i - 1].closeTime).toISOString()} and ${new Date(data[i].openTime).toISOString()}.`, 'warning');
    }
  }
}

function subscribeToLiveData(symbol, interval, onCandleClose, retryCount = 0) {
  const maxRetries = 5;
  const backoffTime = Math.min(1000 * 2 ** retryCount, 30000);

  const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@kline_${interval}`);

  ws.on('open', () => {
    logMessage('Connected to Binance WebSocket for live data.', 'info');
    retryCount = 0;
  });

  ws.on('message', async (data) => {
    try {
      const parsedData = JSON.parse(data);
      const kline = parsedData.k;
      if (kline && typeof kline.c === 'string' && kline.x) {
        const candle = {
          symbol: symbol,
          interval: interval,
          openTime: new Date(kline.t).getTime(),
          open: new Decimal(kline.o),
          high: new Decimal(kline.h),
          low: new Decimal(kline.l),
          close: new Decimal(kline.c),
          volume: new Decimal(kline.v),
          closeTime: new Date(kline.T).getTime(),
        };
        logMessage(`Live Candle Closed: ${candle.close.toFixed(2)} USDT`, 'info');
        onCandleClose(candle);

        await limiter.schedule(() =>
          OHLC.findOneAndUpdate(
            { symbol: candle.symbol, interval: candle.interval, openTime: new Date(candle.openTime) },
            {
              symbol: candle.symbol,
              interval: candle.interval,
              openTime: new Date(candle.openTime),
              open: parseFloat(candle.open),
              high: parseFloat(candle.high),
              low: parseFloat(candle.low),
              close: parseFloat(candle.close),
              volume: parseFloat(candle.volume),
              closeTime: new Date(candle.closeTime),
            },
            { upsert: true, new: true }
          )
        );
        logMessage('Live candle saved to MongoDB.', 'info');
      }
    } catch (error) {
      logMessage(`Error handling live candle: ${error.message}`, 'error');
    }
  });

  ws.on('error', (error) => {
    logMessage(`WebSocket error: ${error.message}`, 'error');
    ws.close();
  });

  ws.on('close', () => {
    if (retryCount < maxRetries) {
      logMessage(`WebSocket connection closed. Reconnecting in ${backoffTime / 1000} seconds...`, 'warning');
      setTimeout(() => subscribeToLiveData(symbol, interval, onCandleClose, retryCount + 1), backoffTime);
    } else {
      logMessage('Max WebSocket reconnection attempts reached. Exiting...', 'error');
      process.exit(1);
    }
  });
}

async function monitorActiveTrades() {
  for (const trade of activeTrades) {
    try {
      const currentPrice = await getAvaxPrice();

      let currentProfit = new Decimal(0);
      if (trade.direction === 'long') {
        currentProfit = currentPrice.minus(trade.entryPrice).times(trade.amount).times(trade.leverage || 1);
      } else {
        currentProfit = trade.entryPrice.minus(currentPrice).times(trade.amount).times(trade.leverage || 1);
      }

      if (currentProfit.greaterThan(trade.peakProfit)) {
        trade.peakProfit = currentProfit;
        trade.peakPrice = currentPrice;
      }

      const allowedDrawdown = trade.peakPrice.times(maxSpotDrawdownPercentage).dividedBy(100);
      const maxDrawdownPrice = trade.direction === 'long'
        ? trade.peakPrice.minus(allowedDrawdown)
        : trade.peakPrice.plus(allowedDrawdown);

      if ((trade.direction === 'long' && currentPrice.greaterThanOrEqualTo(trade.takeProfit)) ||
          (trade.direction === 'short' && currentPrice.lessThanOrEqualTo(trade.takeProfit))) {
        await handleTradeClosure(trade, currentPrice);
        continue;
      }

      const stopLossHit = (trade.direction === 'long' && (currentPrice.lessThanOrEqualTo(maxDrawdownPrice) || currentPrice.lessThanOrEqualTo(trade.stopLoss))) ||
                          (trade.direction === 'short' && (currentPrice.greaterThanOrEqualTo(maxDrawdownPrice) || currentPrice.greaterThanOrEqualTo(trade.stopLoss)));

      if (stopLossHit) {
        await handleTradeClosure(trade, currentPrice);
      }

      displayTradeStatus(currentPrice);
    } catch (error) {
      logMessage(`Error monitoring trade: ${error.message}`, 'error');
    }
  }
}

async function checkPrices() {
  try {
    await getAvaxBalance();
    const ohlc = historicalData.slice(-14);

    if (ohlc.length < 14) {
      logMessage('Not enough historical data to calculate indicators. Skipping this cycle.', 'warning');
      return;
    }

    const rsi = await calculateRSI(ohlc);
    const macd = await calculateMACD(ohlc);
    const sma = await calculateSMA(ohlc);
    const ema = await calculateEMA(ohlc);
    const stochastic = await calculateStochastic(ohlc);
    const atr = await calculateATR(ohlc);
    const bollinger = await calculateBollingerBands(ohlc);

    let probability = calculateProbability(rsi, macd, sma, ema, stochastic, atr, bollinger);

    const timeElapsed = (Date.now() - startTime) / 1000;
    if (timeElapsed >= 900) {
      cumulativeProbabilityChange = 0;
      startTime = Date.now();
    } else {
      cumulativeProbabilityChange += Decimal.abs(probability.minus(baseProbability)).toNumber();
    }
    if (cumulativeProbabilityChange > 20) {
      probability = probability.minus(5);
    }

    logMessage(`Adjusted Probability of Success: ${probability.toFixed(2)}%`, 'info');

    if (probability.greaterThanOrEqualTo(70) && probability.lessThanOrEqualTo(80)) {
      const answers = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'takeTrade',
          message: 'Do you want to take this trade?',
          default: false,
        },
      ]);

      if (answers.takeTrade) {
        const timeframeAnswer = await inquirer.prompt([
          {
            type: 'list',
            name: 'selectedTimeframe',
            message: 'Select timeframe:',
            choices: Object.keys(timeframeMap),
            default: '1m',
          },
        ]);

        const selectedTimeframe = timeframeAnswer.selectedTimeframe;
        if (!timeframeMap[selectedTimeframe]) {
          logMessage('Invalid timeframe selected. Defaulting to 1m.', 'warning');
          timeframe = '1m';
        } else {
          timeframe = selectedTimeframe;
        }
        startPriceCheckInterval();

        const tradeTypeAnswer = await inquirer.prompt([
          {
            type: 'list',
            name: 'tradeType',
            message: 'Do you want to trade Futures or Spot?',
            choices: ['futures', 'spot'],
            default: 'futures',
          },
        ]);

        const tradeModeAnswer = await inquirer.prompt([
          {
            type: 'list',
            name: 'tradeMode',
            message: 'Do you want to place a real or fake trade?',
            choices: ['real', 'fake'],
            default: 'fake',
          },
        ]);

        const amountAnswer = await inquirer.prompt([
          {
            type: 'input',
            name: 'amount',
            message: `Enter amount to use for ${tradeModeAnswer.tradeMode} ${tradeTypeAnswer.tradeType} trading (Available: ${(tradeModeAnswer.tradeMode === 'real' ? realBalance.toFixed(2) : fakeBalance.toFixed(2))} AVAX):`,
            validate: (input) => {
              const amount = parseFloat(input);
              if (isNaN(amount) || amount <= 0) {
                return 'Please enter a valid positive number.';
              }
              const balance = tradeModeAnswer.tradeMode === 'real' ? realBalance : fakeBalance;
              if (amount > balance.toNumber()) {
                return `Insufficient ${tradeModeAnswer.tradeMode} balance for trade.`;
              }
              return true;
            },
            filter: (input) => parseFloat(input),
          },
        ]);

        const amount = new Decimal(amountAnswer.amount);
        const tradeType = tradeTypeAnswer.tradeType;
        const tradeMode = tradeModeAnswer.tradeMode;

        if (tradeType === 'spot') {
          logMessage(`${capitalizeFirstLetter(tradeMode)} Spot trade with amount: ${amount.toFixed(2)} AVAX.`, 'info');
          await placeSpotTrade(getLastClosePrice(ohlc), amount, tradeMode);
        } else {
          const favorableAmount = amount.times(new Decimal(2).dividedBy(3));
          const unfavorableAmount = amount.times(new Decimal(1).dividedBy(3));
          logMessage(`${capitalizeFirstLetter(tradeMode)} Futures trade with favorable amount of ${favorableAmount.toFixed(2)} AVAX and unfavorable amount of ${unfavorableAmount.toFixed(2)} AVAX.`, 'info');
          await placeFutureTrade(getLastClosePrice(ohlc), favorableAmount, 'long', tradeMode, 'favorable');
          await placeFutureTrade(getLastClosePrice(ohlc), unfavorableAmount, 'short', tradeMode, 'unfavorable');
        }

        activeTrades = activeTrades.filter((trade) => trade !== null);
      } else {
        logMessage('Trade skipped as per user input.', 'info');
      }
    } else {
      logMessage('Probability not in favorable range. Trade skipped.', 'info');
    }
  } catch (error) {
    logMessage(`Error checking prices: ${error.message}`, 'error');
  }
}

function capitalizeFirstLetter(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function getLastClosePrice(ohlc) {
  return ohlc[ohlc.length - 1].close;
}

async function placeSpotTrade(entryPrice, amount, type) {
  try {
    const feeRates = await getSpotTradingFee('AVAXUSDT');
    const feeRate = feeRates.takerFee;
    const entryFee = entryPrice.times(amount).times(feeRate);

    const totalCost = entryPrice.times(amount).plus(entryFee);
    const balance = type === 'real' ? realBalance : fakeBalance;

    if (totalCost.greaterThan(balance)) {
      logMessage(`Insufficient ${type} balance to cover trade and fees.`, 'error');
      return;
    }

    if (type === 'real') {
      realBalance = realBalance.minus(totalCost);
    } else {
      fakeBalance = fakeBalance.minus(totalCost);
    }
    walletBalance = walletBalance.minus(amount);

    const stopLoss = entryPrice.times(new Decimal(1).minus(stopLossPercentage.dividedBy(100)));
    const takeProfit = entryPrice.times(new Decimal(1).plus(takeProfitPercentage.dividedBy(100)));

    logMessage(`Placing ${type} Spot trade with amount: ${amount.toFixed(2)} AVAX at price: ${entryPrice.toFixed(2)} USDT.`, 'info');
    logMessage(`${capitalizeFirstLetter(type)} trade placed with stop loss at ${stopLoss.toFixed(2)} USDT and take profit at ${takeProfit.toFixed(2)} USDT.`, 'info');

    // Place Spot Order on Binance
    const orderType = 'MARKET';
    const side = 'BUY'; // Adjust based on direction if needed
    const quantity = amount.toNumber();

    const order = await limiter.schedule(() =>
      new Promise((resolve, reject) => {
        binance.buy('AVAXUSDT', quantity, null, { type: orderType }, (error, response) => {
          if (error) {
            logMessage(`Failed to place Spot order: ${error.body}`, 'error');
            return reject(error);
          }
          resolve(response);
        });
      })
    );

    logMessage(`Spot Order placed: ${JSON.stringify(order)}`, 'info');

    const trade = {
      id: generateTradeId(),
      entryPrice,
      amount,
      stopLoss,
      takeProfit,
      peakProfit: new Decimal(0),
      peakPrice: entryPrice,
      type,
      direction: 'long',
      startTime: Date.now(),
      leverage: new Decimal(1),
      feeRate,
      entryFee,
      allocation: 'favorable',
      isReallocated: false,
    };

    activeTrades.push(trade);
    monitorTrade(trade);
  } catch (error) {
    logMessage(`Error placing Spot trade: ${error.message}`, 'error');
  }
}

async function placeFutureTrade(entryPrice, amount, direction, type, allocation = 'favorable') {
  try {
    const feeRates = type === 'spot' ? await getSpotTradingFee('AVAXUSDT') : await getFuturesTradingFee('AVAXUSDT');
    const feeRate = feeRates.takerFee;
    const entryFee = entryPrice.times(amount).times(feeRate);

    const initialMargin = type === 'futures' ? entryPrice.times(amount).dividedBy(leverage) : new Decimal(0);

    const balance = type === 'real' ? realBalance : fakeBalance;
    const totalCost = initialMargin.plus(entryFee);
    if (type === 'futures' && totalCost.greaterThan(balance)) {
      logMessage(`Insufficient ${type} balance to cover trade and fees.`, 'error');
      return;
    }
    if (type === 'spot' && entryPrice.times(amount).plus(entryFee).greaterThan(balance)) {
      logMessage(`Insufficient ${type} balance to cover trade and fees.`, 'error');
      return;
    }

    if (type === 'real') {
      realBalance = type === 'futures' ? realBalance.minus(totalCost) : realBalance.minus(entryPrice.times(amount).plus(entryFee));
    } else {
      fakeBalance = type === 'futures' ? fakeBalance.minus(totalCost) : fakeBalance.minus(entryPrice.times(amount).plus(entryFee));
    }

    const stopLoss = direction === 'long'
      ? entryPrice.times(new Decimal(1).minus(stopLossPercentage.dividedBy(100)))
      : entryPrice.times(new Decimal(1).plus(stopLossPercentage.dividedBy(100)));
    const takeProfit = direction === 'long'
      ? entryPrice.times(new Decimal(1).plus(takeProfitPercentage.dividedBy(100)))
      : entryPrice.times(new Decimal(1).minus(takeProfitPercentage.dividedBy(100)));

    logMessage(`Placing ${type} ${direction} trade with amount: ${amount.toFixed(2)} AVAX at price: ${entryPrice.toFixed(2)} USDT.`, 'info');
    logMessage(`${capitalizeFirstLetter(type)} trade placed with stop loss at ${stopLoss.toFixed(2)} USDT and take profit at ${takeProfit.toFixed(2)} USDT.`, 'info');

    // Place Futures Order on Binance
    const orderSide = direction === 'long' ? 'BUY' : 'SELL';
    const orderType = 'MARKET';
    const quantity = amount.toNumber();

    const order = await limiter.schedule(() =>
      new Promise((resolve, reject) => {
        binance.futuresOrder(orderSide, 'AVAXUSDT', quantity, null, { type: orderType }, (error, response) => {
          if (error) {
            logMessage(`Failed to place Futures order: ${error.body}`, 'error');
            return reject(error);
          }
          resolve(response);
        });
      })
    );

    logMessage(`Futures Order placed: ${JSON.stringify(order)}`, 'info');

    const tradeObj = {
      id: generateTradeId(),
      entryPrice,
      amount,
      stopLoss,
      takeProfit,
      peakProfit: new Decimal(0),
      peakPrice: entryPrice,
      type,
      direction,
      startTime: Date.now(),
      leverage: type === 'futures' ? leverage : new Decimal(1),
      feeRate,
      entryFee,
      allocation,
      isReallocated: false,
    };

    activeTrades.push(tradeObj);
    monitorTrade(tradeObj);
  } catch (error) {
    logMessage(`Error placing Futures trade: ${error.message}`, 'error');
  }
}

function monitorTrade(trade) {
  // Monitoring is handled centrally in monitorActiveTrades
}

async function handleTradeClosure(trade, currentPrice) {
  try {
    let feeRates;
    if (trade.type === 'spot') {
      feeRates = await getSpotTradingFee('AVAXUSDT');
    } else {
      feeRates = await getFuturesTradingFee('AVAXUSDT');
    }
    const feeRate = feeRates.takerFee;
    const exitFee = new Decimal(currentPrice).times(trade.amount).times(feeRate);

    const grossPnl = trade.direction === 'long'
      ? new Decimal(currentPrice).minus(trade.entryPrice).times(trade.amount).times(trade.leverage)
      : trade.entryPrice.minus(new Decimal(currentPrice)).times(trade.amount).times(trade.leverage);
    const netPnl = grossPnl.minus(trade.entryFee).minus(exitFee);

    const isFavorable = trade.allocation === 'favorable';
    const isUnfavorable = trade.allocation === 'unfavorable';

    if (netPnl.isNegative() && isUnfavorable && !trade.isReallocated) {
      const reallocateAmount = trade.amount;
      logMessage(`Unfavorable trade closed with loss. Reallocating ${reallocateAmount.toFixed(2)} AVAX into favorable direction.`, 'warning');

      const newDirection = trade.direction === 'long' ? 'short' : 'long';

      await placeFutureTrade(new Decimal(currentPrice), reallocateAmount, newDirection, trade.type, 'favorable');

      trade.isReallocated = true;
    }

    logMessage(`${capitalizeFirstLetter(trade.type)} ${trade.direction.toUpperCase()} Trade closed with ${netPnl.greaterThanOrEqualTo(0) ? 'profit' : 'loss'}: ${netPnl.toFixed(2)} USDT.`, 'info');

    if (trade.type === 'fake') {
      fakeBalance = fakeBalance.plus(netPnl).plus(trade.amount);
      fakePnL = fakePnL.plus(netPnl);
    } else if (trade.type === 'real') {
      realBalance = realBalance.plus(netPnl).plus(trade.amount);
      realPnL = realPnL.plus(netPnl);
    } else {
      spotPnL = spotPnL.plus(netPnl);
      walletBalance = walletBalance.plus(trade.amount);
      if (trade.type === 'real') {
        realBalance = realBalance.plus(trade.entryPrice.times(trade.amount));
      } else {
        fakeBalance = fakeBalance.plus(trade.entryPrice.times(trade.amount));
      }
    }

    activeTrades = activeTrades.filter((t) => t.id !== trade.id);

    if (activeTrades.length === 0) {
      finalizeTrade();
    }
  } catch (error) {
    logMessage(`Error handling trade closure: ${error.message}`, 'error');
  }
}

function finalizeTrade() {
  displayPnL();
  inquirer.prompt([
    {
      type: 'confirm',
      name: 'placeAnother',
      message: 'Do you want to place another trade?',
      default: false,
    },
  ]).then((answers) => {
    if (answers.placeAnother) {
      checkPrices().catch((error) => {
        logMessage(`Error initiating new trade: ${error.message}`, 'error');
      });
    } else {
      logMessage('Trade session ended.', 'info');
      gracefulShutdown();
    }
  });
}

function calculateProbability(rsi, macd, sma, ema, stochastic, atr, bollinger) {
  let probability = baseProbability;

  if (rsi.lessThan(30)) {
    probability = probability.plus(new Decimal(10));
  } else if (rsi.greaterThan(70)) {
    probability = probability.minus(new Decimal(10));
  }

  if (macd.histogram > 0) {
    probability = probability.plus(new Decimal(5));
  } else if (macd.histogram < 0) {
    probability = probability.minus(new Decimal(5));
  }

  if (sma.greaterThan(ema)) {
    probability = probability.plus(new Decimal(5));
  } else {
    probability = probability.minus(new Decimal(5));
  }

  if (stochastic.k.lessThan(20) && stochastic.d.lessThan(20)) {
    probability = probability.plus(new Decimal(10));
  } else if (stochastic.k.greaterThan(80) && stochastic.d.greaterThan(80)) {
    probability = probability.minus(new Decimal(10));
  }

  if (atr.greaterThan(new Decimal(0.5))) {
    probability = probability.minus(new Decimal(5));
  }

  if (bollinger.price.lessThan(bollinger.lower)) {
    probability = probability.plus(new Decimal(5));
  } else if (bollinger.price.greaterThan(bollinger.upper)) {
    probability = probability.minus(new Decimal(5));
  }

  if (probability.lessThan(0)) probability = new Decimal(0);
  if (probability.greaterThan(100)) probability = new Decimal(100);

  return probability;
}

function gracefulShutdown() {
  logMessage('Shutting down gracefully...', 'info');

  mongoose.connection.close(false, () => {
    logMessage('MongoDB connection closed.', 'info');
    process.exit(0);
  });

  if (priceCheckInterval) {
    clearInterval(priceCheckInterval);
  }
}

function generateTradeId() {
  return `trade_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
}

function aggregateCandleData(candles, targetInterval) {
  const aggregatedCandles = [];
  let tempCandle = null;
  let count = 0;

  candles.forEach((candle) => {
    if (!tempCandle) {
      tempCandle = { ...candle };
    }
    tempCandle.high = Decimal.max(tempCandle.high, candle.high);
    tempCandle.low = Decimal.min(tempCandle.low, candle.low);
    tempCandle.close = candle.close;
    tempCandle.volume = tempCandle.volume.plus(candle.volume);
    count++;

    if (count === targetInterval) {
      aggregatedCandles.push({ ...tempCandle });
      tempCandle = null;
      count = 0;
    }
  });

  return aggregatedCandles;
}

process.on('SIGINT', () => {
  logMessage('Received SIGINT. Initiating graceful shutdown...', 'info');
  gracefulShutdown();
});

process.on('SIGTERM', () => {
  logMessage('Received SIGTERM. Initiating graceful shutdown...', 'info');
  gracefulShutdown();
});

function onLiveCandleClose(candle) {
  historicalData.push({
    openTime: candle.openTime,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    closeTime: candle.closeTime,
  });

  if (historicalData.length > 1000) {
    historicalData.shift();
  }

  monitorActiveTrades().catch((error) => {
    logMessage(`Error in monitoring active trades: ${error.message}`, 'error');
  });
}

async function monitorActiveTrades() {
  for (const trade of activeTrades) {
    try {
      const currentPrice = await getAvaxPrice();

      let currentProfit = new Decimal(0);
      if (trade.direction === 'long') {
        currentProfit = currentPrice.minus(trade.entryPrice).times(trade.amount).times(trade.leverage || 1);
      } else {
        currentProfit = trade.entryPrice.minus(currentPrice).times(trade.amount).times(trade.leverage || 1);
      }

      if (currentProfit.greaterThan(trade.peakProfit)) {
        trade.peakProfit = currentProfit;
        trade.peakPrice = currentPrice;
      }

      const allowedDrawdown = trade.peakPrice.times(maxSpotDrawdownPercentage).dividedBy(100);
      const maxDrawdownPrice = trade.direction === 'long'
        ? trade.peakPrice.minus(allowedDrawdown)
        : trade.peakPrice.plus(allowedDrawdown);

      if ((trade.direction === 'long' && currentPrice.greaterThanOrEqualTo(trade.takeProfit)) ||
          (trade.direction === 'short' && currentPrice.lessThanOrEqualTo(trade.takeProfit))) {
        await handleTradeClosure(trade, currentPrice);
        continue;
      }

      const stopLossHit = (trade.direction === 'long' && (currentPrice.lessThanOrEqualTo(maxDrawdownPrice) || currentPrice.lessThanOrEqualTo(trade.stopLoss))) ||
                          (trade.direction === 'short' && (currentPrice.greaterThanOrEqualTo(maxDrawdownPrice) || currentPrice.greaterThanOrEqualTo(trade.stopLoss)));

      if (stopLossHit) {
        await handleTradeClosure(trade, currentPrice);
      }

      displayTradeStatus(currentPrice);
    } catch (error) {
      logMessage(`Error monitoring trade: ${error.message}`, 'error');
    }
  }
}

(async () => {
  try {
    const symbol = 'AVAXUSDT';
    const interval = '1m';
    const historicalStartTime = new Date('2020-09-15T00:00:00Z').getTime();

    await initializeData(symbol, interval, historicalStartTime);

    subscribeToLiveData(symbol, interval, onLiveCandleClose);
  } catch (error) {
    logMessage(`Initialization Error: ${error.message}`, 'error');
    gracefulShutdown();
  }
})();

module.exports = {
  getAvaxBalance,
  getAvaxPrice,
  checkPrices,
  calculateProbability,
  placeSpotTrade,
  placeFutureTrade,
};
