// indicators.js - Refactored Indicator Calculations Accepting External Data
const Decimal = require('decimal.js'); // Make sure to require Decimal.js at the top
const {  MACD, SMA, EMA, BollingerBands, Stochastic, ATR } = require('technicalindicators');
const { logMessage } = require('./logger'); // Updated to use the enhanced logger

/**
 * Calculate Relative Strength Index (RSI)
 * @param {Array} ohlc - Array of candlestick objects
 * @param {number} period - RSI period (default: 14)
 * @returns {Decimal} - Latest RSI value as a Decimal instance
 */
 function calculateRSI(ohlc, period = 14) {
  try {
    if (!ohlc || ohlc.length < period) {
      logger.warn('Insufficient candlestick data for RSI calculation.');
      return new Decimal(50); // Return as Decimal
    }

    const closePrices = ohlc.map((candle) => candle.close.toNumber()); // Convert Decimal to Number

    const rsiValues = RSI.calculate({
      values: closePrices,
      period,
    });

    const latestRSI = rsiValues.length > 0 ? rsiValues[rsiValues.length - 1] : 50;
    return new Decimal(latestRSI); // Convert to Decimal
  } catch (error) {
    logger.error(`Error calculating RSI: ${error.message}`);
    return new Decimal(50); // Return as Decimal
  }
}

/**
 * Calculate Moving Average Convergence Divergence (MACD)
 * @param {Array} ohlc - Array of candlestick objects
 * @param {number} fastPeriod - MACD fast period (default: 12)
 * @param {number} slowPeriod - MACD slow period (default: 26)
 * @param {number} signalPeriod - MACD signal period (default: 9)
 * @returns {Object} - Latest MACD, signal, and histogram values or defaults
 */
function calculateMACD(ohlc, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  try {
    if (!ohlc || ohlc.length < slowPeriod) {
      logMessage('Insufficient candlestick data for MACD calculation.');
      return { MACD: 0, signal: 0, histogram: 0 };
    }

    const closePrices = ohlc.map(candle => parseFloat(candle.close));

    const macdValues = MACD.calculate({
      values: closePrices,
      fastPeriod,
      slowPeriod,
      signalPeriod,
      SimpleMAOscillator: false,
      SimpleMASignal: false
    });

    const latestMACD = macdValues.length > 0 ? macdValues[macdValues.length - 1] : { MACD: 0, signal: 0, histogram: 0 };
    return latestMACD;
  } catch (error) {
    logMessage(`Error calculating MACD: ${error.message}`);
    return { MACD: 0, signal: 0, histogram: 0 };
  }
}

/**
 * Calculate Simple Moving Average (SMA)
 * @param {Array} ohlc - Array of candlestick objects
 * @param {number} period - SMA period (default: 14)
 * @returns {number} - Latest SMA value or default
 */
function calculateSMA(ohlc, period = 14) {
  try {
    if (!ohlc || ohlc.length < period) {
      logMessage('Insufficient candlestick data for SMA calculation.');
      return 0;
    }

    const closePrices = ohlc.map(candle => parseFloat(candle.close));

    const smaValues = SMA.calculate({
      values: closePrices,
      period
    });

    const latestSMA = smaValues.length > 0 ? smaValues[smaValues.length - 1] : 0;
    return latestSMA;
  } catch (error) {
    logMessage(`Error calculating SMA: ${error.message}`);
    return 0;
  }
}

/**
 * Calculate Exponential Moving Average (EMA)
 * @param {Array} ohlc - Array of candlestick objects
 * @param {number} period - EMA period (default: 14)
 * @returns {number} - Latest EMA value or default
 */
function calculateEMA(ohlc, period = 14) {
  try {
    if (!ohlc || ohlc.length < period) {
      logMessage('Insufficient candlestick data for EMA calculation.');
      return 0;
    }

    const closePrices = ohlc.map(candle => parseFloat(candle.close));

    const emaValues = EMA.calculate({
      values: closePrices,
      period
    });

    const latestEMA = emaValues.length > 0 ? emaValues[emaValues.length - 1] : 0;
    return latestEMA;
  } catch (error) {
    logMessage(`Error calculating EMA: ${error.message}`);
    return 0;
  }
}

/**
 * Calculate Bollinger Bands
 * @param {Array} ohlc - Array of candlestick objects
 * @param {number} period - Bollinger Bands period (default: 20)
 * @param {number} stdDev - Standard deviation multiplier (default: 2)
 * @returns {Object} - Latest Bollinger Bands values or defaults
 */
function calculateBollingerBands(ohlc, period = 20, stdDev = 2) {
  try {
    if (!ohlc || ohlc.length < period) {
      logMessage('Insufficient candlestick data for Bollinger Bands calculation.');
      return { upper: 0, middle: 0, lower: 0 };
    }

    const closePrices = ohlc.map(candle => parseFloat(candle.close));

    const bollingerBands = BollingerBands.calculate({
      period,
      values: closePrices,
      stdDev
    });

    const latestBands = bollingerBands.length > 0 ? bollingerBands[bollingerBands.length - 1] : { upper: 0, middle: 0, lower: 0 };
    return latestBands;
  } catch (error) {
    logMessage(`Error calculating Bollinger Bands: ${error.message}`);
    return { upper: 0, middle: 0, lower: 0 };
  }
}

/**
 * Calculate Stochastic Oscillator
 * @param {Array} ohlc - Array of candlestick objects
 * @param {number} period - Stochastic period (default: 14)
 * @param {number} signalPeriod - Stochastic signal period (default: 3)
 * @returns {Object} - Latest Stochastic K and D values or defaults
 */
function calculateStochastic(ohlc, period = 14, signalPeriod = 3) {
  try {
    if (!ohlc || ohlc.length < period) {
      logMessage('Insufficient candlestick data for Stochastic Oscillator calculation.');
      return { k: 50, d: 50 };
    }

    const highPrices = ohlc.map(candle => parseFloat(candle.high));
    const lowPrices = ohlc.map(candle => parseFloat(candle.low));
    const closePrices = ohlc.map(candle => parseFloat(candle.close));

    const stochasticValues = Stochastic.calculate({
      high: highPrices,
      low: lowPrices,
      close: closePrices,
      period,
      signalPeriod
    });

    const latestStochastic = stochasticValues.length > 0 ? stochasticValues[stochasticValues.length - 1] : { k: 50, d: 50 };
    return latestStochastic;
  } catch (error) {
    logMessage(`Error calculating Stochastic Oscillator: ${error.message}`);
    return { k: 50, d: 50 };
  }
}

/**
 * Calculate Average True Range (ATR)
 * @param {Array} ohlc - Array of candlestick objects
 * @param {number} period - ATR period (default: 14)
 * @returns {number} - Latest ATR value or default
 */
function calculateATR(ohlc, period = 14) {
  try {
    if (!ohlc || ohlc.length < period) {
      logMessage('Insufficient candlestick data for ATR calculation.');
      return 0;
    }

    const highPrices = ohlc.map(candle => parseFloat(candle.high));
    const lowPrices = ohlc.map(candle => parseFloat(candle.low));
    const closePrices = ohlc.map(candle => parseFloat(candle.close));

    const atrValues = ATR.calculate({
      high: highPrices,
      low: lowPrices,
      close: closePrices,
      period
    });

    const latestATR = atrValues.length > 0 ? atrValues[atrValues.length - 1] : 0;
    return latestATR;
  } catch (error) {
    logMessage(`Error calculating ATR: ${error.message}`);
    return 0;
  }
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
