let chart, candleSeries, volumeSeries;

async function initializeDashboard() {
    const chartProperties = {
        width: 1000,
        height: 500,
        timeScale: {
            timeVisible: true,
            secondsVisible: false,
        },
        layout: {
            backgroundColor: '#ffffff',
            textColor: '#333',
        },
        grid: {
            vertLines: { color: '#f0f0f0' },
            horzLines: { color: '#f0f0f0' },
        },
    };

    chart = createChart('price-chart', chartProperties);
    candleSeries = chart.addCandlestickSeries({
        upColor: '#26a69a',
        downColor: '#ef5350',
        borderVisible: false,
        wickUpColor: '#26a69a',
        wickDownColor: '#ef5350'
    });

    volumeSeries = chart.addHistogramSeries({
        color: '#26a69a',
        priceFormat: {
            type: 'volume',
        },
        priceScaleId: '',
        scaleMargins: {
            top: 0.8,
            bottom: 0
        },
    });

    // Start data updates
    updateData();
    setInterval(updateData, 1000);
    const ws = new WebSocket('ws://localhost:8080');
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        updateCharts(data);
        updateStats(data.simulationResults);
        updateTradeHistory(data.simulationResults);
    };
}

async function updateData() {
    try {
        const response = await fetch('/simulation-data');
        const data = await response.json();

        updateCharts(data);
        updateStats(data);
        updateTradeHistory(data);
    } catch (error) {
        console.error('Error updating data:', error);
    }
}

function updateCharts(data) {
    if (data.candles && data.candles.length > 0) {
        candleSeries.setData(data.candles.map(candle => ({
            time: candle.time / 1000, // Convert milliseconds to seconds
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close
        })));

        volumeSeries.setData(data.candles.map(candle => ({
            time: candle.time / 1000,
            value: candle.volume,
            color: candle.close >= candle.open ? '#26a69a' : '#ef5350'
        })));
    }
}

function updateStats(data) {
    const spotStats = document.getElementById('spot-stats');
    const futuresStats = document.getElementById('futures-stats');

    spotStats.innerHTML = generateStatsHTML('Spot', data.spot);
    futuresStats.innerHTML = generateStatsHTML('Futures', data.futures);
}

function generateStatsHTML(type, data) {
    const fakePnL = calculateTotalPnL(data.fake.pnl);
    const realPnL = calculateTotalPnL(data.real.pnl);

    return `
        <h3>${type} Trading</h3>
        <p>Fake Balance: ${formatNumber(data.fake.balance[data.fake.balance.length - 1])} AVAX</p>
        <p>Real Balance: ${formatNumber(data.real.balance[data.real.balance.length - 1])} AVAX</p>
        <p>Fake PnL: ${formatNumber(fakePnL)} USDT</p>
        <p>Real PnL: ${formatNumber(realPnL)} USDT</p>
        <p>Total Trades: ${data.fake.trades.length + data.real.trades.length}</p>
    `;
}

function updateTradeHistory(data) {
    const historyDiv = document.getElementById('trade-history');
    const allTrades = [...data.spot.fake.trades, ...data.spot.real.trades,
    ...data.futures.fake.trades, ...data.futures.real.trades]
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 10);

    historyDiv.innerHTML = `
        <h3>Recent Trades</h3>
        ${allTrades.map(trade => `
            <div class="trade-entry ${trade.pnl >= 0 ? 'profit' : 'loss'}">
                ${new Date(trade.timestamp).toLocaleString()} - 
                ${trade.type} ${trade.tradeMode} trade: 
                PnL: ${formatNumber(trade.pnl)} USDT
                ${trade.direction ? `(${trade.direction.toUpperCase()})` : ''}
            </div>
        `).join('')}
    `;
}

function formatNumber(num) {
    if (num === undefined || num === null) return '0.00';
    return typeof num === 'number' ? num.toFixed(2) : '0.00';
}

function calculateTotalPnL(pnlArray) {
    if (!Array.isArray(pnlArray) || pnlArray.length === 0) return 0;
    return pnlArray.reduce((sum, pnl) => sum + (pnl || 0), 0);
}

// Handle window resize
window.addEventListener('resize', () => {
    if (chart) {
        chart.applyOptions({
            width: document.getElementById('price-chart').clientWidth,
            height: 500
        });
    }
});

// Initialize the dashboard when the document is ready
document.addEventListener('DOMContentLoaded', initializeDashboard);