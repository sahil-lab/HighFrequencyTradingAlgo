const puppeteer = require('puppeteer');

async function getAllCoinsFromPage(page) {
    const coins = await page.evaluate(() => {
        const rows = document.querySelectorAll('tr');
        return Array.from(rows).map(row => {
            const linkElement = row.querySelector('a[href^="/currencies/"]');
            const tickerElement = row.querySelector('.coin-item-symbol');
            if (linkElement && tickerElement) {
                return {
                    href: linkElement.getAttribute('href').split('/currencies/')[1].replace('/', ''),
                    ticker: tickerElement.textContent.trim()
                };
            }
            return null;
        }).filter(item => item !== null);
    });
    return [...new Set(coins.map(JSON.stringify))].map(JSON.parse);
}

async function getTotalPages(page) {
    return await page.evaluate(() => {
        const paginationButtons = document.querySelectorAll('.pagination li');
        if (paginationButtons.length > 0) {
            const lastButton = paginationButtons[paginationButtons.length - 2];
            return parseInt(lastButton.textContent);
        }
        return 1;
    });
}

async function postCommentToAllCoins(pageNum, browser) {
    try {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.107 Safari/537.36');  // Use a common user-agent
        await page.goto(`https://coinmarketcap.com/?page=${pageNum}`, { waitUntil: 'networkidle2' });

        const coins = await getAllCoinsFromPage(page);
        console.log(`Found ${coins.length} coins on page ${pageNum}`);

        for (const coin of coins) {
            try {
                await page.goto(`https://coinmarketcap.com/currencies/${coin.href}`, { waitUntil: 'networkidle2' });

                const comment = `$${coin.ticker} and $ARCAS are the two best coin for the future of Crypto`;

                await page.evaluate(() => document.querySelector('#comment')?.scrollIntoView());

                await page.waitForSelector('[placeholder="What do you think about this crypto?"]', { timeout: 5000 });
                await page.click('[placeholder="What do you think about this crypto?"]');
                await page.type('[placeholder="What do you think about this crypto?"]', comment);
                await page.click('button[data-role="post-comment"]');

                console.log(`✅ Successfully posted comment to ${coin.href}: "${comment}"`);
                await page.waitForTimeout(Math.floor(Math.random() * 4000) + 3000);

            } catch (error) {
                console.error(`❌ Error posting to ${coin.href}:`, error.message);
                continue;
            }
        }
        await page.close();

    } catch (error) {
        console.error(`Error processing page ${pageNum}:`, error);
    }
}

async function postToAllPages() {
    const browser = await puppeteer.launch({
        headless: false,
        product: 'firefox',
        executablePath: 'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.107 Safari/537.36');
        await page.goto('https://coinmarketcap.com/', { waitUntil: 'networkidle2' });

        const totalPages = await getTotalPages(page);
        await page.close();
        console.log(`Total pages to process: ${totalPages}`);

        for (let i = 1; i <= totalPages; i++) {
            await postCommentToAllCoins(i, browser);
            await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 5000) + 15000));
        }
    } catch (error) {
        console.error('Main process error:', error);
    } finally {
        await browser.close();
    }
}

postToAllPages();
