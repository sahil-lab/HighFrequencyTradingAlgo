const { Builder, By, until } = require('selenium-webdriver');
const firefox = require('selenium-webdriver/firefox');

(async function example() {
    // Set Firefox options
    let options = new firefox.Options();
    options.headless = true; // Enable headless mode

    let driver = await new Builder()
        .forBrowser('firefox')
        .setFirefoxOptions(options)
        .build();

    try {
        await driver.get('https://coinmarketcap.com');
        console.log('Page loaded successfully');
        await driver.sleep(5000); // Wait a bit to visually confirm
    } finally {
        await driver.quit();
    }
})();
