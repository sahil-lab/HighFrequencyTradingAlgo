// trading.js - Improved Trading Logic with Real, Fake, Spot, and Futures Trades with Fee Integration

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

// Fetch AVAX Price
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
  // (Trade logging code remains the same)
  // ...
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
    const price = await getAvaxPrice();

    // Technical Indicators
    const rsi = await calculateRSI();
    const macd = await calculateMACD();
    const sma = await calculateSMA();
    const ema = await calculateEMA();
    const stochastic = await calculateStochastic();
    const atr = await calculateATR();
    const bollinger = await calculateBollingerBands();

    // Calculate Probability
    let probability = calculateProbability(rsi, macd, sma, ema, stochastic, atr, bollinger);

    // Adjust Probability Based on Time and Cumulative Changes
    const timeElapsed = (Date.now() - startTime) / 1000;
    if (timeElapsed >= 900) {
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
                    await placeSpotTrade(price, amount, tradeMode);
                  } else {
                    const favorableAmount = (2 / 3) * amount;
                    const unfavorableAmount = (1 / 3) * amount;
                    logMessage(`${tradeMode.charAt(0).toUpperCase() + tradeMode.slice(1)} trade with favorable amount of ${favorableAmount.toFixed(2)} AVAX and unfavorable amount of ${unfavorableAmount.toFixed(2)} AVAX.`);
                    await placeTrade(price, favorableAmount, 'long', tradeMode);
                    await placeTrade(price, unfavorableAmount, 'short', tradeMode);
                  }
                  activeTrade = true;
                }
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
  logMessage(`Placing ${type} Spot trade with amount: ${amount} AVAX at price: ${entryPrice}`);
  const trade = { entryPrice, amount, stopLoss, peakProfit: 0, type, startTime: Date.now(), feeRate, entryFee };
  currentSpotTrade = trade;
  monitorSpotPrice(trade);
}

// Monitor Spot Price
function monitorSpotPrice(trade) {
  const monitorPriceInterval = setInterval(async () => {
    try {
      const currentPrice = await getAvaxPrice();
      const currentProfit = (currentPrice - trade.entryPrice) * trade.amount;
      if (currentProfit > trade.peakProfit) {
        trade.peakProfit = currentProfit;
      }
      const maxDrawdownPrice = trade.entryPrice + trade.peakProfit * (1 - maxSpotDrawdownPercentage / 100);
      if (currentPrice <= maxDrawdownPrice || currentPrice <= trade.stopLoss) {
        await handleTradeClosure(trade, currentPrice, 'long', trade.type);
        clearInterval(monitorPriceInterval);
      }
      displayTradeStatus(currentPrice);
    } catch (error) {
      logMessage(`Error fetching live price during ${trade.type} Spot trade: ${error.message}`);
    }
  }, 5000);
}

// Place Trade for Futures
async function placeTrade(entryPrice, amount, direction, type) {
  const feeRates = await getFuturesTradingFee('AVAXUSDT');
  const feeRate = feeRates.takerFee; // Assuming taker orders
  const entryFee = entryPrice * amount * feeRate;

  // Check if balance is sufficient
  const balance = type === 'real' ? realBalance : fakeBalance;
  const initialMargin = (entryPrice * amount) / leverage;
  if ((initialMargin + entryFee) > balance) {
    logMessage(`Insufficient ${type} balance to cover trade and fees.`);
    return;
  }

  // Deduct initial margin and entry fee from balance
  if (type === 'real') {
    realBalance -= (initialMargin + entryFee);
  } else {
    fakeBalance -= (initialMargin + entryFee);
  }

  const stopLoss =
    direction === 'long'
      ? entryPrice * (1 - stopLossPercentage / 100)
      : entryPrice * (1 + stopLossPercentage / 100);
  const takeProfit =
    direction === 'long'
      ? entryPrice * (1 + takeProfitPercentage / 100)
      : entryPrice * (1 - takeProfitPercentage / 100);

  logMessage(`Placing ${type} ${direction} trade with amount: ${amount} AVAX at price: ${entryPrice}`);
  logMessage(`${type.charAt(0).toUpperCase() + type.slice(1)} trade placed with stop loss at ${stopLoss.toFixed(2)} USDT and take profit at ${takeProfit.toFixed(2)} USDT.`);

  const trade = { entryPrice, amount, stopLoss, takeProfit, direction, type, startTime: Date.now(), leverage, feeRate, entryFee };

  if (direction === 'long') {
    type === 'fake' ? (currentLongTrade = trade) : (currentRealLongTrade = trade);
  } else {
    type === 'fake' ? (currentShortTrade = trade) : (currentRealShortTrade = trade);
  }

  monitorPriceMovement(trade);
}

// Monitor Price Movement for Futures
function monitorPriceMovement(trade) {
  const monitorPriceInterval = setInterval(async () => {
    try {
      const currentPrice = await getAvaxPrice();
      if (
        (trade.direction === 'long' && (currentPrice >= trade.takeProfit || currentPrice <= trade.stopLoss)) ||
        (trade.direction === 'short' && (currentPrice <= trade.takeProfit || currentPrice >= trade.stopLoss))
      ) {
        await handleTradeClosure(trade, currentPrice, trade.direction, trade.type);
        clearInterval(monitorPriceInterval);
      }
      displayTradeStatus(currentPrice);
    } catch (error) {
      logMessage(`Error fetching live price during ${trade.type} trade: ${error.message}`);
    }
  }, 5000);
}

// Handle Trade Closure
async function handleTradeClosure(trade, currentPrice, direction, type) {
  // Fetch fee rates
  let feeRates;
  if (type === 'spot') {
    feeRates = await getSpotTradingFee('AVAXUSDT');
  } else {
    feeRates = await getFuturesTradingFee('AVAXUSDT');
  }
  const feeRate = feeRates.takerFee; // Assuming taker orders
  const exitFee = currentPrice * trade.amount * feeRate;

  // Calculate gross and net PnL
  const grossPnl = (direction === 'long' ? currentPrice - trade.entryPrice : trade.entryPrice - currentPrice) * trade.amount * (trade.leverage || 1);
  const netPnl = grossPnl - trade.entryFee - exitFee;

  if (netPnl < 0) {
    // Adjust Opposite Trade Amount to Cover Losses (Risky Strategy)
    const oppositeTrade = type === 'fake' ? (direction === 'long' ? currentShortTrade : currentLongTrade) : (direction === 'long' ? currentRealShortTrade : currentRealLongTrade);
    if (oppositeTrade) {
      // Implement risk limits to prevent excessive trade sizes
      const maxTradeAmount = (type === 'real' ? realBalance : fakeBalance) * 0.1; // Example: Max 10% of balance
      const additionalAmount = Math.min(Math.abs(netPnl / oppositeTrade.entryPrice) + oppositeTrade.entryPrice * 0.06, maxTradeAmount);
      oppositeTrade.amount += additionalAmount;
      logMessage(`Adjusted ${type} ${oppositeTrade.direction} trade amount to ${oppositeTrade.amount.toFixed(2)} AVAX to cover losses and aim for 6% profit.`);
    }
  }

  logMessage(`${type.charAt(0).toUpperCase() + type.slice(1)} ${direction.toUpperCase()} Trade closed with ${netPnl >= 0 ? 'profit' : 'loss'}: ${netPnl.toFixed(2)} USDT.`);

  // Update balances with net PnL
  if (type === 'fake') {
    fakeBalance += netPnl + ((trade.entryPrice * trade.amount) / (trade.leverage || 1));
    fakePnL += netPnl;
  } else if (type === 'real') {
    realBalance += netPnl + ((trade.entryPrice * trade.amount) / (trade.leverage || 1));
    realPnL += netPnl;
  } else {
    spotPnL += netPnl;
    walletBalance += trade.amount; // Add back the amount of AVAX
    if (type === 'real') {
      realBalance += trade.entryPrice * trade.amount;
    } else {
      fakeBalance += trade.entryPrice * trade.amount;
    }
  }

  // Reset Trades
  if (type === 'fake') {
    direction === 'long' ? (currentLongTrade = null) : (currentShortTrade = null);
  } else if (type === 'real') {
    direction === 'long' ? (currentRealLongTrade = null) : (currentRealShortTrade = null);
  } else {
    currentSpotTrade = null;
  }

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

// Set Interval to Check Prices Periodically
setInterval(checkPrices, 10000);

// Export Functions for External Use
module.exports = {
  getAvaxBalance,
  getAvaxPrice,
  checkPrices,
  placeTrade,
  calculateProbability,
  placeSpotTrade,
};
