const { RSI, MACD, SMA, EMA, BollingerBands, Stochastic, ATR } = require('technicalindicators');
const binance = require('./config');
const { logMessage } = require('./logger-old');

// Function to calculate RSI
async function calculateRSI() {
  try {
    const bars = await fetchCandlesticks();
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
    const bars = await fetchCandlesticks();
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

// Function to calculate Simple Moving Average (SMA)
async function calculateSMA(period) {
  try {
    const bars = await fetchCandlesticks();
    if (!bars || bars.length === 0) {
      logMessage('No candlestick data available for SMA calculation.');
      return 0;
    }

    const closePrices = bars.map(bar => parseFloat(bar[4]));

    const smaValues = SMA.calculate({
      values: closePrices,
      period
    });
    return smaValues.length > 0 ? smaValues[smaValues.length - 1] : 0;
  } catch (error) {
    logMessage(`Error calculating SMA: ${error.message}`);
    return 0;
  }
}

// Function to calculate Exponential Moving Average (EMA)
async function calculateEMA(period) {
  try {
    const bars = await fetchCandlesticks();
    if (!bars || bars.length === 0) {
      logMessage('No candlestick data available for EMA calculation.');
      return 0;
    }

    const closePrices = bars.map(bar => parseFloat(bar[4]));

    const emaValues = EMA.calculate({
      values: closePrices,
      period
    });
    return emaValues.length > 0 ? emaValues[emaValues.length - 1] : 0;
  } catch (error) {
    logMessage(`Error calculating EMA: ${error.message}`);
    return 0;
  }
}

// Function to calculate Bollinger Bands
async function calculateBollingerBands() {
  try {
    const bars = await fetchCandlesticks();
    if (!bars || bars.length === 0) {
      logMessage('No candlestick data available for Bollinger Bands calculation.');
      return { upper: 0, middle: 0, lower: 0 };
    }

    const closePrices = bars.map(bar => parseFloat(bar[4]));

    const bollingerBands = BollingerBands.calculate({
      period: 20,
      values: closePrices,
      stdDev: 2
    });
    return bollingerBands.length > 0 ? bollingerBands[bollingerBands.length - 1] : { upper: 0, middle: 0, lower: 0 };
  } catch (error) {
    logMessage(`Error calculating Bollinger Bands: ${error.message}`);
    return { upper: 0, middle: 0, lower: 0 };
  }
}

// Function to calculate Stochastic Oscillator
async function calculateStochastic() {
  try {
    const bars = await fetchCandlesticks();
    if (!bars || bars.length === 0) {
      logMessage('No candlestick data available for Stochastic calculation.');
      return { k: 50, d: 50 };
    }

    const highPrices = bars.map(bar => parseFloat(bar[2]));
    const lowPrices = bars.map(bar => parseFloat(bar[3]));
    const closePrices = bars.map(bar => parseFloat(bar[4]));

    const stochasticValues = Stochastic.calculate({
      high: highPrices,
      low: lowPrices,
      close: closePrices,
      period: 14,
      signalPeriod: 3
    });
    return stochasticValues.length > 0 ? stochasticValues[stochasticValues.length - 1] : { k: 50, d: 50 };
  } catch (error) {
    logMessage(`Error calculating Stochastic: ${error.message}`);
    return { k: 50, d: 50 };
  }
}

// Function to calculate Average True Range (ATR)
async function calculateATR() {
  try {
    const bars = await fetchCandlesticks();
    if (!bars || bars.length === 0) {
      logMessage('No candlestick data available for ATR calculation.');
      return 0;
    }

    const highPrices = bars.map(bar => parseFloat(bar[2]));
    const lowPrices = bars.map(bar => parseFloat(bar[3]));
    const closePrices = bars.map(bar => parseFloat(bar[4]));

    const atrValues = ATR.calculate({
      high: highPrices,
      low: lowPrices,
      close: closePrices,
      period: 14
    });
    return atrValues.length > 0 ? atrValues[atrValues.length - 1] : 0;
  } catch (error) {
    logMessage(`Error calculating ATR: ${error.message}`);
    return 0;
  }
}

// Utility function to fetch candlestick data
async function fetchCandlesticks() {
  return new Promise((resolve, reject) => {
    binance.candlesticks('AVAXUSDT', '15m', (error, ticks) => {
      if (error) {
        logMessage(`Failed to fetch candlesticks: ${error.body}`);
        reject(error);
      } else {
        resolve(ticks);
      }
    });
  });
}

module.exports = {
  calculateRSI,
  calculateMACD,
  calculateSMA,
  calculateEMA,
  calculateBollingerBands,
  calculateStochastic,
  calculateATR
};
