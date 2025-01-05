// File: avax-balance.js

require('dotenv').config();
const { Avalanche } = require("avalanche");

// Load the AVAX address from the .env file
const avaxAddress = process.env.AVAX_ADDRESS;

// Set up the Avalanche connection
const ip = "api.avax.network"; // Mainnet endpoint
const port = 443; // Standard port for HTTPS
const protocol = "https";
const networkID = 1; // Mainnet Network ID

const avalanche = new Avalanche(ip, port, protocol, networkID);
const xchain = avalanche.XChain(); // AVAX X-Chain API

// Function to get AVAX balance
async function getAvaxBalance() {
  try {
    const balance = await xchain.getBalance(avaxAddress, "AVAX");
    const balanceInAvax = balance.balance / Math.pow(10, 9); // Convert from nAVAX to AVAX
    console.log(`Balance of ${avaxAddress}: ${balanceInAvax} AVAX`);
  } catch (err) {
    console.error("Failed to fetch balance:", err.message);
  }
}

// Execute the function to get the balance
getAvaxBalance();