const axios = require('axios');

async function getAvaxPrice() {
  try {
    const response = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=AVAXUSDT');
    const price = response.data.price;
    console.log(`Current price of AVAX/USDT: $${price}`);
  } catch (error) {
    console.error('Error fetching AVAX price:', error.message);
  }
}

getAvaxPrice();
