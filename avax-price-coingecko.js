const axios = require('axios');

async function getAvaxPrice() {
  try {
    const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=avalanche-2&vs_currencies=usd');
    const price = response.data['avalanche-2'].usd;
    console.log(`Current price of AVAX: $${price}`);
  } catch (error) {
    console.error('Error fetching AVAX price:', error.message);
  }
}

getAvaxPrice();
