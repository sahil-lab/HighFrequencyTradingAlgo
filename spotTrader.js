// trading.js - Improved Trading Logic with Real, Fake, Spot, and Futures Trades

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

// Display Profit and Loss
function displayPnL() {
  logMessage(`Total Fake PnL: ${fakePnL.toFixed(2)} USDT`);
  logMessage(`Total Real PnL: ${realPnL.toFixed(2)} USDT`);
  logMessage(`Total Spot PnL: ${spotPnL.toFixed(2)} USDT`);
}

function displayTradeStatus(currentPrice) {
    const timestamp = new Date().toISOString();
    const equivalentTotalBalanceUSDT = (walletBalance * currentPrice).toFixed(2);
    const netPnLSession = (fakePnL + realPnL + spotPnL).toFixed(2);
    const tradeDuration = ((Date.now() - startTime) / 60000).toFixed(2); // in minutes
  
    // Spot Trade Logging
    if (currentSpotTrade) {
      // PNL in USDT
      const spotPnLUSDT = (currentPrice - currentSpotTrade.entryPrice) * currentSpotTrade.amount;
      // PNL in AVAX
      const spotPnLAVAX = spotPnLUSDT / currentPrice;
  
      // Adjusted Amounts
      const adjustedAmountAfterPnLUSDT = currentSpotTrade.entryPrice * (currentSpotTrade.amount + spotPnLAVAX);
      const adjustedAmountAfterPnLAVAX = currentSpotTrade.amount + spotPnLAVAX;
  
      const tradeSummary = spotPnLUSDT >= 0 ? 'Profit detected, monitoring for peak profit.' : 'Loss detected, evaluating further action based on stop loss and price movement.';
      logMessage(`[${timestamp}] [Trade Update]
      - Trade Type: Spot (${currentSpotTrade.type.charAt(0).toUpperCase() + currentSpotTrade.type.slice(1)})
      - Direction: Long
      - Entry Price: ${currentSpotTrade.entryPrice} USDT
      - Current Price: ${currentPrice} USDT
      - Stop Loss: ${currentSpotTrade.stopLoss.toFixed(5)} USDT
      - Peak Profit: ${currentSpotTrade.peakProfit.toFixed(2)} USDT
      - PNL: ${spotPnLUSDT.toFixed(2)} USDT / ${spotPnLAVAX.toFixed(4)} AVAX (${spotPnLUSDT >= 0 ? 'Positive' : 'Negative'})
      - Amount Traded: ${currentSpotTrade.amount.toFixed(2)} AVAX
      - Adjusted Amount After PNL: ${adjustedAmountAfterPnLUSDT.toFixed(2)} USDT / ${adjustedAmountAfterPnLAVAX.toFixed(4)} AVAX
      - Trading Balance Before Trade: ${(walletBalance + currentSpotTrade.amount).toFixed(2)} AVAX
      - Trading Balance After Trade: ${walletBalance.toFixed(2)} AVAX
      - Wallet Balance: ${walletBalance.toFixed(2)} AVAX
      - Total Balance: ${walletBalance.toFixed(2)} AVAX
      - Equivalent Total Balance in USDT: $${equivalentTotalBalanceUSDT}
      - Net PNL (Session): ${netPnLSession} USDT
      - Trade Duration: ${tradeDuration} minutes
      - Trade Start Time: ${new Date(startTime).toISOString()}
      - Current AVAX/USDT Price: ${currentPrice} USDT
      - Live Price Update: ${currentPrice} USDT
      - Trade Summary: ${tradeSummary}
      `);
  
      // Prompt for Selling Spot Trade
      rl.question(`[Action Required]: Do you want to sell the Spot trade at the current price of ${currentPrice} USDT? (yes/no): `, (answer) => {
        if (answer.toLowerCase() === 'yes') {
          handleTradeClosure(currentSpotTrade, currentPrice, "long", currentSpotTrade.type);
        } else {
          logMessage('Continuing with the Spot trade.');
        }
      });
    }
  
    // Futures Trade Logging for Long and Short Positions
    const futuresTrades = [
      { trade: currentLongTrade, type: 'Fake', direction: 'Long' },
      { trade: currentShortTrade, type: 'Fake', direction: 'Short' },
      { trade: currentRealLongTrade, type: 'Real', direction: 'Long' },
      { trade: currentRealShortTrade, type: 'Real', direction: 'Short' },
    ];
  
    futuresTrades.forEach(({ trade, type, direction }) => {
      if (trade) {
        // PNL in USDT
        const pnlUSDT = (direction === 'Long' ? (currentPrice - trade.entryPrice) : (trade.entryPrice - currentPrice)) * trade.amount;
        // PNL in AVAX
        const pnlAVAX = pnlUSDT / currentPrice;
  
        // Adjusted Amounts
        const adjustedAmountAfterPnLUSDT = trade.entryPrice * (trade.amount + pnlAVAX);
        const adjustedAmountAfterPnLAVAX = trade.amount + pnlAVAX;
  
        const tradeSummary = pnlUSDT >= 0 ? 'Profit target close to being hit; monitoring leverage impact.' : 'Loss detected, evaluating further action.';
        const leverage = trade.leverage || '5x'; // Assuming default leverage
  
        logMessage(`[${timestamp}] [Trade Update]
        - Trade Type: Futures (${type})
        - Direction: ${direction}
        - Entry Price: ${trade.entryPrice} USDT
        - Current Price: ${currentPrice} USDT
        - Stop Loss: ${trade.stopLoss.toFixed(2)} USDT
        - Take Profit: ${trade.takeProfit.toFixed(2)} USDT
        - PNL: ${pnlUSDT.toFixed(2)} USDT / ${pnlAVAX.toFixed(4)} AVAX (${pnlUSDT >= 0 ? 'Positive' : 'Negative'})
        - Leverage: ${leverage}
        - Amount Traded: ${trade.amount.toFixed(2)} AVAX
        - Adjusted Amount After PNL: ${adjustedAmountAfterPnLUSDT.toFixed(2)} USDT / ${adjustedAmountAfterPnLAVAX.toFixed(4)} AVAX
        - Trading Balance Before Trade: ${(walletBalance + trade.amount).toFixed(2)} AVAX
        - Trading Balance After Trade: ${walletBalance.toFixed(2)} AVAX
        - Wallet Balance: ${walletBalance.toFixed(2)} AVAX
        - Total Balance: ${walletBalance.toFixed(2)} AVAX
        - Equivalent Total Balance in USDT: $${equivalentTotalBalanceUSDT}
        - Net PNL (Session): ${netPnLSession} USDT
        - Trade Duration: ${tradeDuration} minutes
        - Trade Start Time: ${new Date(startTime).toISOString()}
        - Current AVAX/USDT Price: ${currentPrice} USDT
        - Live Price Update: ${currentPrice} USDT
        - Trade Summary: ${tradeSummary}
        `);
  
        // Prompt for Closing Futures Trade
        rl.question(`[Action Required]: Do you want to close the Futures trade at the current price of ${currentPrice} USDT? (yes/no): `, (answer) => {
          if (answer.toLowerCase() === 'yes') {
            handleTradeClosure(trade, currentPrice, direction.toLowerCase(), type.toLowerCase());
          } else {
            logMessage('Continuing with the Futures trade.');
          }
        });
      }
    });
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
              rl.question(`Enter amount to use for ${tradeMode} ${tradeType} trading (Available: ${(tradeMode === 'real' ? realBalance : fakeBalance)} AVAX): `, (amount) => {
                amount = parseFloat(amount);
                const balance = tradeMode === 'real' ? realBalance : fakeBalance;
                if (amount > balance) {
                  logMessage(`Insufficient ${tradeMode} balance for trade.`);
                } else {
                  walletBalance -= amount;
                  if (tradeType === 'spot') {
                    logMessage(`${tradeMode.charAt(0).toUpperCase() + tradeMode.slice(1)} Spot trade with amount: ${amount.toFixed(2)} AVAX.`);
                    placeSpotTrade(price, amount, tradeMode);
                  } else {
                    const favorableAmount = (2 / 3) * amount;
                    const unfavorableAmount = (1 / 3) * amount;
                    logMessage(`${tradeMode.charAt(0).toUpperCase() + tradeMode.slice(1)} trade with favorable amount of ${favorableAmount.toFixed(2)} AVAX and unfavorable amount of ${unfavorableAmount.toFixed(2)} AVAX.`);
                    placeTrade(price, favorableAmount, 'long', tradeMode);
                    placeTrade(price, unfavorableAmount, 'short', tradeMode);
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
function placeSpotTrade(entryPrice, amount, type) {
  const stopLoss = entryPrice * (1 - stopLossPercentage / 100);
  logMessage(`Placing ${type} Spot trade with amount: ${amount} AVAX at price: ${entryPrice}`);
  const trade = { entryPrice, amount, stopLoss, peakProfit: 0, type, startTime: Date.now() };
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
        handleTradeClosure(trade, currentPrice, 'long', trade.type);
        clearInterval(monitorPriceInterval);
      }
      displayTradeStatus(currentPrice);
    } catch (error) {
      logMessage(`Error fetching live price during ${trade.type} Spot trade: ${error.message}`);
    }
  }, 5000);
}

// Place Trade for Futures
function placeTrade(entryPrice, amount, direction, type) {
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

  const trade = { entryPrice, amount, stopLoss, takeProfit, direction, type, startTime: Date.now(), leverage: '5x' };

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
        handleTradeClosure(trade, currentPrice, trade.direction, trade.type);
        clearInterval(monitorPriceInterval);
      }
      displayTradeStatus(currentPrice);
    } catch (error) {
      logMessage(`Error fetching live price during ${trade.type} trade: ${error.message}`);
    }
  }, 5000);
}

// Handle Trade Closure
function handleTradeClosure(trade, currentPrice, direction, type) {
  const pnl = (direction === 'long' ? currentPrice - trade.entryPrice : trade.entryPrice - currentPrice) * trade.amount;

  if (pnl < 0) {
    // Adjust Opposite Trade Amount to Cover Losses
    const oppositeTrade = type === 'fake' ? (direction === 'long' ? currentShortTrade : currentLongTrade) : (direction === 'long' ? currentRealShortTrade : currentRealLongTrade);
    if (oppositeTrade) {
      oppositeTrade.amount += Math.abs(pnl / oppositeTrade.entryPrice) + oppositeTrade.entryPrice * 0.06;
      logMessage(`Adjusted ${type} ${oppositeTrade.direction} trade amount to ${oppositeTrade.amount.toFixed(2)} AVAX to cover losses and aim for 6% profit.`);
    }
  }

  logMessage(`${type.charAt(0).toUpperCase() + type.slice(1)} ${direction.toUpperCase()} Trade closed with ${pnl >= 0 ? 'profit' : 'loss'}: ${pnl.toFixed(2)} USDT.`);

  if (type === 'fake') {
    fakeBalance += pnl;
    fakePnL += pnl;
  } else if (type === 'real') {
    realBalance += pnl;
    realPnL += pnl;
  } else {
    spotPnL += pnl;
    walletBalance += pnl / currentPrice; // Adjust wallet balance in AVAX
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
