// trading.js - Enhanced Trading Logic with Retry Mechanisms and Weighted Base Probability

require('dotenv').config();

const mongoose = require('mongoose');
const binance = require('./config'); // Ensure this is correctly configured
const logger = require('./logger'); // Updated to use the enhanced logger
const {
  calculateRSI,
  calculateMACD,
  calculateSMA,
  calculateEMA,
  calculateStochastic,
  calculateATR,
  calculateBollingerBands,
} = require('./indicators'); // Updated indicators
const inquirer = require('inquirer');
const WebSocket = require('ws');
const Decimal = require('decimal.js');
const Bottleneck = require('bottleneck');
const Trade = require('./tradeSchema'); // Ensure this path is correct
const { Mutex } = require('async-mutex'); // For synchronization

// ===================== MongoDB Setup =====================

mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

const db = mongoose.connection;

db.on('error', (error) => logger.error(`MongoDB connection error: ${error.message}`));
db.once('open', () => logger.info('Connected to MongoDB successfully.'));

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

// ===================== Mutex Setup for Synchronization =====================

const activeTradesMutex = new Mutex();

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
let cumulativeProbabilityChange = new Decimal(0);

// ===================== Trading Parameters =====================

const stopLossPercentage = new Decimal(1.5);
const takeProfitPercentage = new Decimal(6);
const defaultBaseProbability = new Decimal(75); // Fallback value
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

// ===================== Retry Mechanism =====================

/**
 * Generic function to retry an asynchronous operation with exponential backoff.
 * @param {Function} operation - The async operation to retry.
 * @param {number} retries - Number of retry attempts.
 * @param {number} delay - Initial delay in milliseconds.
 * @returns {Promise<any>}
 */
async function retryOperation(operation, retries = 3, delay = 1000) {
  try {
    return await operation();
  } catch (error) {
    if (retries <= 0) {
      throw error;
    }
    logger.warn(`Operation failed: ${error.message}. Retrying in ${delay}ms... (${retries} retries left)`);
    await sleep(delay);
    return retryOperation(operation, retries - 1, delay * 2); // Exponential backoff
  }
}

/**
 * Sleep for a specified duration.
 * @param {number} ms - Milliseconds to sleep.
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ===================== Function Definitions =====================

function startPriceCheckInterval() {
  if (priceCheckInterval) {
    clearInterval(priceCheckInterval);
  }
  const timeframeInMs = timeframeMap[timeframe];
  if (!timeframeInMs) {
    logger.warn(`Invalid timeframe selected: ${timeframe}. Defaulting to 1m.`);
    timeframe = '1m';
  }
  const intervalMs = timeframeMap[timeframe] || 60000;
  priceCheckInterval = setInterval(() => {
    checkPrices().catch((error) => {
      logger.error(`Error in price check interval: ${error.message}`);
    });
  }, intervalMs);
  logger.info(`Price check interval set to every ${timeframe}.`);
}

async function getAvaxBalance() {
  try {
    const balances = await retryOperation(() =>
      limiter.schedule(() =>
        new Promise((resolve, reject) => {
          binance.balance((error, balances) => {
            if (error) {
              return reject(new Error(`Binance API Error: ${error.body}`));
            }
            resolve(balances);
          });
        })
      )
    );

    if (balances && balances.AVAX) {
      logger.info(`AVAX Balance (using Binance library): ${balances.AVAX.available}`);
      realBalance = new Decimal(balances.AVAX.available);
      if (!fakeBalanceInitialized) {
        fakeBalance = realBalance;
        walletBalance = realBalance;
        fakeBalanceInitialized = true;
        logger.info('Initialized fakeBalance and walletBalance with realBalance.');
      }
    } else {
      logger.warn('AVAX balance not found using Binance library.');
    }
  } catch (error) {
    logger.error(`Error fetching AVAX balance: ${error.message}`);
  }
}

async function getAvaxOHLC(interval = '1m', limit = 60) {
  try {
    const ticks = await retryOperation(() =>
      limiter.schedule(() =>
        new Promise((resolve, reject) => {
          binance.candlesticks('AVAXUSDT', interval, (error, ticks) => {
            if (error) {
              return reject(new Error(`Binance API Error: ${error.body}`));
            }
            resolve(ticks);
          }, { limit });
        })
      )
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
        retryOperation(() =>
          OHLC.findOneAndUpdate(
            { symbol: candle.symbol, interval: candle.interval, openTime: candle.openTime },
            candle,
            { upsert: true, new: true }
          )
        )
      )
    );

    logger.info(`Saved ${ohlc.length} candles to MongoDB.`);
    return ohlc;
  } catch (error) {
    logger.error(`Error fetching OHLC data: ${error.message}`);
    throw error;
  }
}

async function getAvaxPrice() {
  try {
    const ohlc = await getAvaxOHLC(timeframe, 1);
    const latestCandle = ohlc[ohlc.length - 1];
    logger.info(`Current AVAX/USDT Price: ${latestCandle.close}`);
    return new Decimal(latestCandle.close);
  } catch (error) {
    logger.error(`Failed to fetch latest price: ${error.message}`);
    throw error;
  }
}

async function getSpotTradingFee(symbol) {
  try {
    const fees = await retryOperation(() =>
      limiter.schedule(() =>
        new Promise((resolve, reject) => {
          binance.tradeFee({ symbol }, (error, fees) => {
            if (error) {
              return reject(new Error(`Binance API Error: ${error.body}`));
            }
            resolve(fees);
          });
        })
      )
    );

    const feeData = fees.find((fee) => fee.symbol === symbol);
    if (feeData) {
      const makerFee = new Decimal(feeData.maker);
      const takerFee = new Decimal(feeData.taker);
      logger.debug(`Spot Fees - Maker: ${makerFee.toFixed(6)}, Taker: ${takerFee.toFixed(6)}`);
      return { makerFee, takerFee };
    } else {
      throw new Error(`Fee data for symbol ${symbol} not found.`);
    }
  } catch (error) {
    logger.warn(`Error fetching spot trading fee: ${error.message}. Using default fees.`);
    return { makerFee: new Decimal(0.001), takerFee: new Decimal(0.001) };
  }
}

async function getFuturesTradingFee(symbol) {
  try {
    const feeData = await retryOperation(() =>
      limiter.schedule(() => binance.futuresCommissionRate(symbol))
    );

    const makerFee = new Decimal(feeData.makerCommissionRate);
    const takerFee = new Decimal(feeData.takerCommissionRate);
    logger.debug(`Futures Fees - Maker: ${makerFee.toFixed(6)}, Taker: ${takerFee.toFixed(6)}`);
    return { makerFee, takerFee };
  } catch (error) {
    logger.warn(`Error fetching futures trading fee: ${error.message}. Using default fees.`);
    return { makerFee: new Decimal(0.0002), takerFee: new Decimal(0.0004) };
  }
}

function displayPnL() {
  logger.info(`Total Fake PnL: ${fakePnL.toFixed(2)} USDT`);
  logger.info(`Total Real PnL: ${realPnL.toFixed(2)} USDT`);
  logger.info(`Total Spot PnL: ${spotPnL.toFixed(2)} USDT`);
}

function displayTradeStatus(currentPrice) {
  logger.info(`Current Price: ${currentPrice.toFixed(2)} USDT`);
}

async function fetchHistoricalDataFromDB(symbol, interval, startTime, endTime) {
  try {
    const data = await retryOperation(() =>
      OHLC.find({
        symbol: symbol,
        interval: interval,
        openTime: { $gte: new Date(startTime), $lte: new Date(endTime) },
      }).sort({ openTime: 1 }).exec()
    );

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
    logger.error(`Error fetching historical data from DB: ${error.message}`);
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
        retryOperation(() =>
          OHLC.findOneAndUpdate(
            { symbol: candle.symbol, interval: candle.interval, openTime: candle.openTime },
            candle,
            { upsert: true, new: true }
          )
        )
      )
    );

    logger.info(`Saved ${ohlc.length} candles to MongoDB.`);
  } catch (error) {
    logger.error(`Error saving historical data to DB: ${error.message}`);
  }
}

async function initializeData(symbol, interval, historicalStartTime) {
  const endTime = Date.now();
  logger.info(`Fetching historical data from ${new Date(historicalStartTime).toISOString()} to ${new Date(endTime).toISOString()}`);

  let fetchedHistoricalData = await fetchHistoricalDataFromDB(symbol, interval, historicalStartTime, endTime);

  if (fetchedHistoricalData.length === 0) {
    logger.warn('No historical data found in DB. Fetching from Binance API.');
    fetchedHistoricalData = await getAvaxOHLC(interval, 1000);
    await saveHistoricalDataToDB(symbol, interval, fetchedHistoricalData);
  } else {
    logger.info(`Fetched ${fetchedHistoricalData.length} historical data points from DB.`);
    const latestCandleTime = fetchedHistoricalData[fetchedHistoricalData.length - 1].closeTime;
    const newCandles = await getAvaxOHLC(interval, 1000);
    const filteredNewCandles = newCandles.filter((candle) => candle.closeTime.getTime() > latestCandleTime);
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
      logger.info(`Added ${filteredNewCandles.length} new candles to historical data.`);
    } else {
      logger.info('No new candles to add.');
    }
  }

  historicalData = fetchedHistoricalData;
  validateHistoricalData(historicalData, interval);
}

function validateHistoricalData(data, interval) {
  const expectedGap = timeframeMap[interval] || 60000; // Default to 1m if interval not found
  for (let i = 1; i < data.length; i++) {
    const expectedOpenTime = data[i - 1].closeTime + expectedGap;
    if (data[i].openTime !== expectedOpenTime) {
      logger.warn(`Data gap detected between ${new Date(data[i - 1].closeTime).toISOString()} and ${new Date(data[i].openTime).toISOString()}. Expected gap: ${expectedGap}ms`);
    }
  }
}

function subscribeToLiveData(symbol, interval, onCandleClose, retryCount = 0) {
  const maxRetries = 5;
  const backoffTime = Math.min(1000 * 2 ** retryCount, 30000);

  const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@kline_${interval}`);

  ws.on('open', () => {
    logger.info('Connected to Binance WebSocket for live data.');
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
        logger.info(`Live Candle Closed: ${candle.close.toFixed(2)} USDT`);
        onCandleClose(candle);

        await retryOperation(() =>
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
        logger.info('Live candle saved to MongoDB.');
      }
    } catch (error) {
      logger.error(`Error handling live candle: ${error.message}`);
    }
  });

  ws.on('error', (error) => {
    logger.error(`WebSocket error: ${error.message}`);
    ws.close();
  });

  ws.on('close', () => {
    if (retryCount < maxRetries) {
      logger.warn(`WebSocket connection closed. Reconnecting in ${backoffTime / 1000} seconds...`);
      setTimeout(() => subscribeToLiveData(symbol, interval, onCandleClose, retryCount + 1), backoffTime);
    } else {
      logger.error('Max WebSocket reconnection attempts reached. Exiting...');
      gracefulShutdown();
    }
  });
}

async function monitorActiveTrades() {
  const release = await activeTradesMutex.acquire();
  try {
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
          logger.debug(`Trade ${trade.id}: New peak profit of ${trade.peakProfit.toFixed(2)} USDT at price ${trade.peakPrice.toFixed(2)} USDT.`);
        }

        const allowedDrawdown = trade.peakPrice.times(maxSpotDrawdownPercentage).dividedBy(100);
        const maxDrawdownPrice = trade.direction === 'long'
          ? trade.peakPrice.minus(allowedDrawdown)
          : trade.peakPrice.plus(allowedDrawdown);

        if ((trade.direction === 'long' && currentPrice.greaterThanOrEqualTo(trade.takeProfit)) ||
            (trade.direction === 'short' && currentPrice.lessThanOrEqualTo(trade.takeProfit))) {
          logger.info(`Trade ${trade.id}: Take profit reached.`);
          await handleTradeClosure(trade, currentPrice);
          continue;
        }

        const stopLossHit = (trade.direction === 'long' && (currentPrice.lessThanOrEqualTo(maxDrawdownPrice) || currentPrice.lessThanOrEqualTo(trade.stopLoss))) ||
                            (trade.direction === 'short' && (currentPrice.greaterThanOrEqualTo(maxDrawdownPrice) || currentPrice.greaterThanOrEqualTo(trade.stopLoss)));

        if (stopLossHit) {
          logger.info(`Trade ${trade.id}: Stop loss hit.`);
          await handleTradeClosure(trade, currentPrice);
        }

        displayTradeStatus(currentPrice);
      } catch (error) {
        logger.error(`Error monitoring trade ${trade.id}: ${error.message}`);
      }
    }
  } finally {
    release();
  }
}

async function calculateBaseProbability(windowSize = 100, alpha = 0.1) {
  try {
    const recentTrades = await Trade.find().sort({ exitTime: -1 }).limit(windowSize).exec();
    const totalRecentTrades = recentTrades.length;
    if (totalRecentTrades === 0) {
      logger.warn('No recent trades found. Using default base probability.');
      return defaultBaseProbability; // Default if no data
    }

    let weightedSum = new Decimal(0);
    let weightTotal = new Decimal(0);

    recentTrades.forEach((trade, index) => {
      const weight = new Decimal(alpha).times(new Decimal(1 - alpha).pow(index));
      if (trade.outcome === 'win') {
        weightedSum = weightedSum.plus(weight);
      }
      weightTotal = weightTotal.plus(weight);
      logger.debug(`Trade ${trade.id}: Outcome=${trade.outcome}, Weight=${weight.toFixed(4)}`);
    });

    const weightedWinRate = weightTotal.isZero() ? new Decimal(0) : weightedSum.dividedBy(weightTotal).times(100);
    logger.info(`Calculated weighted base probability: ${weightedWinRate.toFixed(2)}% based on ${totalRecentTrades} recent trades.`);
    return weightedWinRate;
  } catch (error) {
    logger.error(`Error calculating base probability: ${error.message}`);
    return defaultBaseProbability; // Fallback to default
  }
}

async function checkPrices() {
  try {
    await getAvaxBalance();
    const maxPeriod = Math.max(14, 26, 20); // RSI=14, MACD=26, Bollinger Bands=20
    const ohlc = historicalData.slice(-maxPeriod);

    if (ohlc.length < maxPeriod) {
      logger.warn(`Not enough historical data to calculate indicators. Required: ${maxPeriod}, Available: ${ohlc.length}. Skipping this cycle.`);
      return;
    }

    logger.debug('Calculating technical indicators.');
    const rsi = await calculateRSI(ohlc);
    const macd = await calculateMACD(ohlc);
    const sma = await calculateSMA(ohlc);
    const ema = await calculateEMA(ohlc);
    const stochastic = await calculateStochastic(ohlc);
    const atr = await calculateATR(ohlc);
    const bollinger = await calculateBollingerBands(ohlc);
    logger.debug('Technical indicators calculated.');

    const dynamicBaseProbability = await calculateBaseProbability(); // Get from historical data

    logger.debug(`Dynamic base probability: ${dynamicBaseProbability.toFixed(2)}%`);
    let probability = calculateProbability(rsi, macd, sma, ema, stochastic, atr, bollinger, dynamicBaseProbability);

    logger.debug(`Probability after indicators: ${probability.toFixed(2)}%`);

    const timeElapsed = (Date.now() - startTime) / 1000;
    if (timeElapsed >= 900) { // 15 minutes
      cumulativeProbabilityChange = new Decimal(0);
      startTime = Date.now();
      logger.debug('Resetting cumulative probability change after 15 minutes.');
    } else {
      cumulativeProbabilityChange = cumulativeProbabilityChange.plus(probability.minus(dynamicBaseProbability).abs());
      logger.debug(`Cumulative probability change: ${cumulativeProbabilityChange.toFixed(2)}`);
    }

    if (cumulativeProbabilityChange.greaterThan(20)) {
      probability = probability.minus(new Decimal(5));
      logger.warn('Cumulative probability change exceeded 20. Reducing probability by 5%.');
    }

    logger.info(`Adjusted Probability of Success: ${probability.toFixed(2)}%`);

    if (probability.greaterThanOrEqualTo(70) && probability.lessThanOrEqualTo(80)) {
      logger.info('Probability within favorable range (70%-80%). Prompting for trade decision.');
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
          logger.warn('Invalid timeframe selected. Defaulting to 1m.');
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
            filter: (input) => new Decimal(parseFloat(input)),
          },
        ]);

        const amount = amountAnswer.amount;
        const tradeType = tradeTypeAnswer.tradeType;
        const tradeMode = tradeModeAnswer.tradeMode;

        if (tradeType === 'spot') {
          logger.info(`${capitalizeFirstLetter(tradeMode)} Spot trade with amount: ${amount.toFixed(2)} AVAX.`);
          await placeSpotTrade(getLastClosePrice(ohlc), amount, tradeMode, 'long'); // Default direction to 'long'
        } else {
          const favorableAmount = amount.times(new Decimal(2).dividedBy(3));
          const unfavorableAmount = amount.times(new Decimal(1).dividedBy(3));
          logger.info(`${capitalizeFirstLetter(tradeMode)} Futures trade with favorable amount of ${favorableAmount.toFixed(2)} AVAX and unfavorable amount of ${unfavorableAmount.toFixed(2)} AVAX.`);
          await placeFutureTrade(getLastClosePrice(ohlc), favorableAmount, 'long', tradeMode, 'favorable');
          await placeFutureTrade(getLastClosePrice(ohlc), unfavorableAmount, 'short', tradeMode, 'unfavorable');
        }

        activeTrades = activeTrades.filter((trade) => trade !== null);
      } else {
        logger.info('Trade skipped as per user input.');
      }
    } else {
      logger.info('Probability not in favorable range. Trade skipped.');
    }
  } catch (error) {
    logger.error(`Error checking prices: ${error.message}`);
  }
}

function capitalizeFirstLetter(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function getLastClosePrice(ohlc) {
  return ohlc[ohlc.length - 1].close;
}

async function placeSpotTrade(entryPrice, amount, type, direction = 'long') {
  try {
    const feeRates = await getSpotTradingFee('AVAXUSDT');
    const feeRate = feeRates.takerFee;
    const entryFee = entryPrice.times(amount).times(feeRate);

    const totalCost = entryPrice.times(amount).plus(entryFee);
    const balance = type === 'real' ? realBalance : fakeBalance;

    if (totalCost.greaterThan(balance)) {
      logger.error(`Insufficient ${type} balance to cover trade and fees.`);
      return;
    }

    if (type === 'real') {
      realBalance = realBalance.minus(totalCost);
      logger.debug(`Real balance after trade: ${realBalance.toFixed(2)} AVAX`);
    } else {
      fakeBalance = fakeBalance.minus(totalCost);
      logger.debug(`Fake balance after trade: ${fakeBalance.toFixed(2)} AVAX`);
    }
    walletBalance = walletBalance.minus(amount);
    logger.debug(`Wallet balance after trade: ${walletBalance.toFixed(2)} AVAX`);

    const stopLoss = entryPrice.times(new Decimal(1).minus(stopLossPercentage.dividedBy(100)));
    const takeProfit = entryPrice.times(new Decimal(1).plus(takeProfitPercentage.dividedBy(100)));

    logger.info(`Placing ${type} Spot trade with amount: ${amount.toFixed(2)} AVAX at price: ${entryPrice.toFixed(2)} USDT.`);
    logger.info(`${capitalizeFirstLetter(type)} trade placed with stop loss at ${stopLoss.toFixed(2)} USDT and take profit at ${takeProfit.toFixed(2)} USDT.`);

    // Place Spot Order on Binance
    const orderType = 'MARKET';
    const side = direction === 'long' ? 'BUY' : 'SELL';
    const quantity = amount.toNumber();

    const order = await retryOperation(() =>
      limiter.schedule(() =>
        new Promise((resolve, reject) => {
          binance.order(side, 'AVAXUSDT', quantity, null, { type: orderType }, (error, response) => {
            if (error) {
              return reject(new Error(`Binance API Error: ${error.body}`));
            }
            resolve(response);
          });
        })
      )
    );

    logger.info(`Spot Order placed: ${JSON.stringify(order)}`);

    const trade = {
      id: generateTradeId(),
      entryPrice,
      amount,
      stopLoss,
      takeProfit,
      peakProfit: new Decimal(0),
      peakPrice: entryPrice,
      type,
      tradeMode: type,
      direction: direction === 'long' ? 'long' : 'short',
      startTime: Date.now(),
      leverage: new Decimal(1),
      feeRate,
      entryFee,
      allocation: 'favorable',
      isReallocated: false,
    };

    activeTrades.push(trade);
    logger.debug(`Trade ${trade.id} added to active trades.`);
  } catch (error) {
    logger.error(`Error placing Spot trade: ${error.message}`);
  }
}

async function placeFutureTrade(entryPrice, amount, direction, type, allocation = 'favorable') {
  try {
    const feeRates = type === 'futures' ? await getFuturesTradingFee('AVAXUSDT') : await getSpotTradingFee('AVAXUSDT');
    const feeRate = feeRates.takerFee;
    const entryFee = entryPrice.times(amount).times(feeRate);

    const initialMargin = type === 'futures' ? entryPrice.times(amount).dividedBy(leverage) : new Decimal(0);

    const balance = type === 'real' ? realBalance : fakeBalance;
    const totalCost = type === 'futures' ? initialMargin.plus(entryFee) : entryPrice.times(amount).plus(entryFee);
    if (totalCost.greaterThan(balance)) {
      logger.error(`Insufficient ${type} balance to cover trade and fees.`);
      return;
    }

    if (type === 'real') {
      realBalance = realBalance.minus(totalCost);
      logger.debug(`Real balance after trade: ${realBalance.toFixed(2)} AVAX`);
    } else {
      fakeBalance = fakeBalance.minus(totalCost);
      logger.debug(`Fake balance after trade: ${fakeBalance.toFixed(2)} AVAX`);
    }

    const stopLoss = direction === 'long'
      ? entryPrice.times(new Decimal(1).minus(stopLossPercentage.dividedBy(100)))
      : entryPrice.times(new Decimal(1).plus(stopLossPercentage.dividedBy(100)));
    const takeProfit = direction === 'long'
      ? entryPrice.times(new Decimal(1).plus(takeProfitPercentage.dividedBy(100)))
      : entryPrice.times(new Decimal(1).minus(takeProfitPercentage.dividedBy(100)));

    logger.info(`Placing ${type} ${direction} trade with amount: ${amount.toFixed(2)} AVAX at price: ${entryPrice.toFixed(2)} USDT.`);
    logger.info(`${capitalizeFirstLetter(type)} trade placed with stop loss at ${stopLoss.toFixed(2)} USDT and take profit at ${takeProfit.toFixed(2)} USDT.`);

    // Place Futures Order on Binance
    const orderSide = direction === 'long' ? 'BUY' : 'SELL';
    const orderType = 'MARKET';
    const quantity = amount.toNumber();

    const order = await retryOperation(() =>
      limiter.schedule(() =>
        new Promise((resolve, reject) => {
          binance.futuresOrder(orderSide, 'AVAXUSDT', quantity, null, { type: orderType }, (error, response) => {
            if (error) {
              return reject(new Error(`Binance API Error: ${error.body}`));
            }
            resolve(response);
          });
        })
      )
    );

    logger.info(`Futures Order placed: ${JSON.stringify(order)}`);

    const tradeObj = {
      id: generateTradeId(),
      entryPrice,
      amount,
      stopLoss,
      takeProfit,
      peakProfit: new Decimal(0),
      peakPrice: entryPrice,
      type,
      tradeMode: type,
      direction: direction === 'long' ? 'long' : 'short',
      startTime: Date.now(),
      leverage: type === 'futures' ? leverage : new Decimal(1),
      feeRate,
      entryFee,
      allocation,
      isReallocated: false,
    };

    activeTrades.push(tradeObj);
    logger.debug(`Trade ${tradeObj.id} added to active trades.`);
  } catch (error) {
    logger.error(`Error placing Futures trade: ${error.message}`);
  }
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
    const exitFee = currentPrice.times(trade.amount).times(feeRate);

    const grossPnl = trade.direction === 'long'
      ? currentPrice.minus(trade.entryPrice).times(trade.amount).times(trade.leverage)
      : trade.entryPrice.minus(currentPrice).times(trade.amount).times(trade.leverage);
    const netPnl = grossPnl.minus(trade.entryFee).minus(exitFee);

    const isFavorable = trade.allocation === 'favorable';
    const isUnfavorable = trade.allocation === 'unfavorable';

    if (netPnl.isNegative() && isUnfavorable && !trade.isReallocated) {
      const reallocateAmount = trade.amount;
      logger.warn(`Unfavorable trade ${trade.id} closed with loss. Reallocating ${reallocateAmount.toFixed(2)} AVAX into favorable direction.`);

      const newDirection = trade.direction === 'long' ? 'short' : 'long';

      await placeFutureTrade(currentPrice, reallocateAmount, newDirection, trade.type, 'favorable');

      trade.isReallocated = true;
    }

    logger.info(`${capitalizeFirstLetter(trade.type)} ${trade.direction.toUpperCase()} Trade ${trade.id} closed with ${netPnl.greaterThanOrEqualTo(0) ? 'profit' : 'loss'}: ${netPnl.toFixed(2)} USDT.`);

    // Record the outcome
    const outcome = netPnl.greaterThanOrEqualTo(0) ? 'win' : 'loss';

    // Save trade to DB with retry
    await retryOperation(() =>
      Trade.create({
        id: trade.id,
        entryPrice: trade.entryPrice.toNumber(),
        amount: trade.amount.toNumber(),
        stopLoss: trade.stopLoss.toNumber(),
        takeProfit: trade.takeProfit.toNumber(),
        direction: trade.direction,
        type: trade.type,
        outcome: outcome,
        entryTime: new Date(trade.startTime),
        exitTime: new Date(),
        netPnl: netPnl.toNumber(),
        allocation: trade.allocation,
        isReallocated: trade.isReallocated,
      })
    );

    logger.info(`Trade ${trade.id} recorded in database with outcome: ${outcome}.`);

    if (trade.type === 'fake') {
      fakeBalance = fakeBalance.plus(netPnl).plus(trade.amount);
      fakePnL = fakePnL.plus(netPnl);
      logger.debug(`Fake balance updated to ${fakeBalance.toFixed(2)} AVAX and fakePnL to ${fakePnL.toFixed(2)} USDT.`);
    } else if (trade.type === 'real') {
      realBalance = realBalance.plus(netPnl).plus(trade.amount);
      realPnL = realPnL.plus(netPnl);
      logger.debug(`Real balance updated to ${realBalance.toFixed(2)} AVAX and realPnL to ${realPnL.toFixed(2)} USDT.`);
    } else {
      spotPnL = spotPnL.plus(netPnl);
      walletBalance = walletBalance.plus(trade.amount);
      if (trade.type === 'real') {
        realBalance = realBalance.plus(trade.entryPrice.times(trade.amount));
        logger.debug(`Real balance updated to ${realBalance.toFixed(2)} AVAX.`);
      } else {
        fakeBalance = fakeBalance.plus(trade.entryPrice.times(trade.amount));
        logger.debug(`Fake balance updated to ${fakeBalance.toFixed(2)} AVAX.`);
      }
      logger.debug(`SpotPnL updated to ${spotPnL.toFixed(2)} USDT and walletBalance to ${walletBalance.toFixed(2)} AVAX.`);
    }

    activeTrades = activeTrades.filter((t) => t.id !== trade.id);
    logger.debug(`Trade ${trade.id} removed from active trades.`);

    if (activeTrades.length === 0) {
      finalizeTrade();
    }
  } catch (error) {
    logger.error(`Error handling trade closure: ${error.message}`);
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
      logger.info('User opted to place another trade.');
      checkPrices().catch((error) => {
        logger.error(`Error initiating new trade: ${error.message}`);
      });
    } else {
      logger.info('Trade session ended by user.');
      gracefulShutdown();
    }
  });
}

function calculateProbability(rsi, macd, sma, ema, stochastic, atr, bollinger, baseProbability) {
  let probability = baseProbability;

  // Detailed logging of indicator values
  logger.debug(`RSI: ${rsi.toFixed(2)}`);
  logger.debug(`MACD Histogram: ${macd.histogram.toFixed(2)}`);
  logger.debug(`SMA: ${sma.toFixed(2)}, EMA: ${ema.toFixed(2)}`);
  logger.debug(`Stochastic K: ${stochastic.k.toFixed(2)}, Stochastic D: ${stochastic.d.toFixed(2)}`);
  logger.debug(`ATR: ${atr.toFixed(2)}`);
  logger.debug(`Bollinger Bands - Price: ${bollinger.price.toFixed(2)}, Lower: ${bollinger.lower.toFixed(2)}, Upper: ${bollinger.upper.toFixed(2)}`);
  logger.debug(`Base Probability: ${baseProbability.toFixed(2)}%`);

  if (rsi.lessThan(30)) {
    probability = probability.plus(new Decimal(10));
    logger.debug('RSI < 30: Increasing probability by 10%.');
  } else if (rsi.greaterThan(70)) {
    probability = probability.minus(new Decimal(10));
    logger.debug('RSI > 70: Decreasing probability by 10%.');
  }

  if (macd.histogram.greaterThan(0)) {
    probability = probability.plus(new Decimal(5));
    logger.debug('MACD Histogram > 0: Increasing probability by 5%.');
  } else if (macd.histogram.lessThan(0)) {
    probability = probability.minus(new Decimal(5));
    logger.debug('MACD Histogram < 0: Decreasing probability by 5%.');
  }

  if (sma.greaterThan(ema)) {
    probability = probability.plus(new Decimal(5));
    logger.debug('SMA > EMA: Increasing probability by 5%.');
  } else {
    probability = probability.minus(new Decimal(5));
    logger.debug('SMA <= EMA: Decreasing probability by 5%.');
  }

  if (stochastic.k.lessThan(20) && stochastic.d.lessThan(20)) {
    probability = probability.plus(new Decimal(10));
    logger.debug('Stochastic K and D < 20: Increasing probability by 10%.');
  } else if (stochastic.k.greaterThan(80) && stochastic.d.greaterThan(80)) {
    probability = probability.minus(new Decimal(10));
    logger.debug('Stochastic K and D > 80: Decreasing probability by 10%.');
  }

  if (atr.greaterThan(new Decimal(0.5))) {
    probability = probability.minus(new Decimal(5));
    logger.debug('ATR > 0.5: Decreasing probability by 5%.');
  }

  if (bollinger.price.lessThan(bollinger.lower)) {
    probability = probability.plus(new Decimal(5));
    logger.debug('Price < Bollinger Lower Band: Increasing probability by 5%.');
  } else if (bollinger.price.greaterThan(bollinger.upper)) {
    probability = probability.minus(new Decimal(5));
    logger.debug('Price > Bollinger Upper Band: Decreasing probability by 5%.');
  }

  // Clamp probability between 0 and 100
  if (probability.lessThan(0)) {
    probability = new Decimal(0);
    logger.debug('Probability clamped to 0%.');
  }
  if (probability.greaterThan(100)) {
    probability = new Decimal(100);
    logger.debug('Probability clamped to 100%.');
  }

  logger.debug(`Final Calculated Probability: ${probability.toFixed(2)}%`);
  return probability;
}

function gracefulShutdown() {
  logger.info('Shutting down gracefully...');

  if (priceCheckInterval) {
    clearInterval(priceCheckInterval);
    logger.info('Price check interval cleared.');
  }

  mongoose.connection.close(false, () => {
    logger.info('MongoDB connection closed.');
    process.exit(0);
  });
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
  logger.info('Received SIGINT. Initiating graceful shutdown...');
  gracefulShutdown();
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM. Initiating graceful shutdown...');
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
    logger.debug('Historical data exceeded 1000 candles. Oldest candle removed.');
  }

  monitorActiveTrades().catch((error) => {
    logger.error(`Error in monitoring active trades: ${error.message}`);
  });
}

(async () => {
  try {
    const symbol = 'AVAXUSDT';
    const interval = '1m';
    const historicalStartTime = new Date('2020-09-15T00:00:00Z').getTime();

    await initializeData(symbol, interval, historicalStartTime);

    subscribeToLiveData(symbol, interval, onLiveCandleClose);
  } catch (error) {
    logger.error(`Initialization Error: ${error.message}`);
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
