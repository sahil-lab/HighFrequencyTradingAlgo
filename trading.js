// trading.js - Updated Trading Logic
const binance = require('./config');
const { logMessage } = require('./logger');
const { calculateRSI, calculateMACD } = require('./indicators');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

let fakeBalanceInitialized = false;
let fakeBalance = 0;
let realBalance = 0;
let walletBalance = 0;
let fakePnL = 0;
let startTime = Date.now();
let activeTrade = false;
let currentLongTrade = null;
let currentShortTrade = null;

const stopLossPercentage = 1.5; // Stop loss percentage
const takeProfitPercentage = 6; // Take profit percentage

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

function displayPnL() {
  const totalPnL = fakePnL; 
  logMessage(`Total PnL: ${totalPnL.toFixed(2)} USDT`);
}

function displayTradeStatus(currentPrice) {
  if (currentLongTrade) {
    const longPnL = (currentPrice - currentLongTrade.entryPrice) * currentLongTrade.amount;
    const longTotalBalance = walletBalance - currentLongTrade.amount + longPnL;
    logMessage(`[Trade Update] Long Trade - Entry Price: ${currentLongTrade.entryPrice}, Stop Loss: ${currentLongTrade.stopLoss}, Take Profit: ${currentLongTrade.takeProfit}, PNL = ${longPnL.toFixed(2)}, Current Total balance = ${longTotalBalance.toFixed(2)} AVAX, Long trade with amount: ${currentLongTrade.amount.toFixed(2)}, Current AVAX/USDT Price: ${currentPrice.toFixed(2)}, Live price update: ${currentPrice.toFixed(2)} USDT`);
  }

  if (currentShortTrade) {
    const shortPnL = (currentShortTrade.entryPrice - currentPrice) * currentShortTrade.amount;
    const shortTotalBalance = walletBalance - currentShortTrade.amount + shortPnL;
    logMessage(`[Trade Update] Short Trade - Entry Price: ${currentShortTrade.entryPrice}, Stop Loss: ${currentShortTrade.stopLoss}, Take Profit: ${currentShortTrade.takeProfit}, PNL = ${shortPnL.toFixed(2)}, Current Total balance = ${shortTotalBalance.toFixed(2)} AVAX, Short trade with amount: ${currentShortTrade.amount.toFixed(2)}, Current AVAX/USDT Price: ${currentPrice.toFixed(2)}, Live price update: ${currentPrice.toFixed(2)} USDT`);
  }

  logMessage(`Current Trading Balance: ${fakeBalance.toFixed(2)} AVAX, Wallet Balance: ${(walletBalance - (currentLongTrade?.amount || 0) - (currentShortTrade?.amount || 0)).toFixed(2)} AVAX, Total Balance: ${(walletBalance + fakePnL).toFixed(2)} AVAX`);
}

async function checkPrices() {
  if (activeTrade) {
    const currentPrice = await getAvaxPrice();
    displayTradeStatus(currentPrice);
    return;
  }

  try {
    await getAvaxBalance();
    const price = await getAvaxPrice();

    const rsi = await calculateRSI();
    const macd = await calculateMACD();
    const probability = calculateProbability(rsi, macd);
    logMessage(`Calculated Probability of Success: ${probability.toFixed(2)}%`);

    if (probability >= 70 && probability <= 80) {
      rl.question('Do you want to take this trade? (yes/no): ', (answer) => {
        if (answer.toLowerCase() === 'yes') {
          rl.question('Do you want to place a real or fake trade? (real/fake): ', (tradeType) => {
            if (tradeType.toLowerCase() === 'fake') {
              rl.question(`Enter amount to use for fake trading (Available: ${fakeBalance} AVAX): `, (amount) => {
                amount = parseFloat(amount);
                if (amount > fakeBalance) {
                  logMessage('Insufficient fake balance for trade.');
                } else {
                  walletBalance -= amount;
                  const favorableAmount = (2 / 3) * amount;
                  const unfavorableAmount = (1 / 3) * amount;
                  logMessage(`Simulated trade with favorable (long) amount of ${favorableAmount.toFixed(2)} AVAX and unfavorable (short) amount of ${unfavorableAmount.toFixed(2)} AVAX.`);
                  placeFakeTrade(price, favorableAmount, "long");
                  placeFakeTrade(price, unfavorableAmount, "short");
                  activeTrade = true;
                }
              });
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

function placeFakeTrade(entryPrice, amount, direction) {
  const stopLoss = direction === "long" ? entryPrice * (1 - stopLossPercentage / 100) : entryPrice * (1 + stopLossPercentage / 100);
  const takeProfit = direction === "long" ? entryPrice * (1 + takeProfitPercentage / 100) : entryPrice * (1 - takeProfitPercentage / 100);

  logMessage(`Placing fake ${direction} trade with amount: ${amount} AVAX at price: ${entryPrice}`);
  logMessage(`Fake trade placed with stop loss at ${stopLoss.toFixed(2)} USDT and take profit at ${takeProfit.toFixed(2)} USDT.`);

  if (direction === "long") {
    currentLongTrade = { entryPrice, amount, stopLoss, takeProfit, direction };
  } else {
    currentShortTrade = { entryPrice, amount, stopLoss, takeProfit, direction };
  }

  const monitorPriceMovement = setInterval(async () => {
    try {
      const currentPrice = await getAvaxPrice();
      logMessage(`Live price update: ${currentPrice.toFixed(2)} USDT`);

      if (currentLongTrade && (currentPrice >= currentLongTrade.takeProfit || currentPrice <= currentLongTrade.stopLoss)) {
        handleTradeClosure(currentLongTrade, currentPrice, "long");
        currentLongTrade = null;
      }

      if (currentShortTrade && (currentPrice <= currentShortTrade.takeProfit || currentPrice >= currentShortTrade.stopLoss)) {
        handleTradeClosure(currentShortTrade, currentPrice, "short");
        currentShortTrade = null;
      }

      displayTradeStatus(currentPrice);

    } catch (error) {
      logMessage(`Error fetching live price during fake trade: ${error.message}`);
    }
  }, 5000);
}

function handleTradeClosure(trade, currentPrice, type) {
  const pnl = (type === "long" ? (currentPrice - trade.entryPrice) : (trade.entryPrice - currentPrice)) * trade.amount;

  // Adjust opposite trade amount to cover losses + 6% profit
  if (type === "long" && pnl < 0 && currentShortTrade) {
    currentShortTrade.amount = Math.abs(pnl / currentShortTrade.entryPrice) + (currentShortTrade.entryPrice * 0.06);
  } else if (type === "short" && pnl < 0 && currentLongTrade) {
    currentLongTrade.amount = Math.abs(pnl / currentLongTrade.entryPrice) + (currentLongTrade.entryPrice * 0.06);
  }

  logMessage(`${type.toUpperCase()} Trade closed with ${pnl >= 0 ? 'profit' : 'loss'}: ${pnl.toFixed(2)} USDT. Adjusted balance and PnL.`);
  fakeBalance += pnl;
  fakePnL += pnl;

  finalizeTrade();
}

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

function calculateProbability(rsi, macd) {
  let probability = 65;

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

  return probability;
}

setInterval(checkPrices, 10000);

module.exports = { getAvaxBalance, getAvaxPrice, checkPrices, placeFakeTrade, calculateProbability };
