import { WebSocketServer, WebSocket } from 'ws';
import fetch from 'node-fetch';

const PORT = 8080;
const wss = new WebSocketServer({ port: PORT });

// Track connections to market data providers
const marketConnections = new Map();
const clientSubscriptions = new Map();

console.log(`🚀 IPFX Market Data Server running on ws://localhost:${PORT}`);

// Available markets and symbols
const MARKETS = {
  crypto: {
    provider: 'binance',
    symbols: ['BTCUSDT', 'ETHUSDT', 'EURUSDT', 'GBPUSDT'],
    wsUrl: (symbol) => `wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@trade`
  }
};

/**
 * Connect to market data provider and relay to clients
 */
function connectToMarket(symbol, market = 'crypto') {
  const marketConfig = MARKETS[market];
  const wsUrl = marketConfig.wsUrl(symbol);

  if (marketConnections.has(symbol)) {
    console.log(`📊 Already connected to ${symbol}`);
    return;
  }

  console.log(`📡 Connecting to ${symbol}...`);

  const ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log(`✅ Connected to ${symbol}`);
  });

  ws.on('message', (data) => {
    try {
      const trade = JSON.parse(data.toString());

      // Normalize data format
      const normalizedData = {
        symbol: symbol,
        price: parseFloat(trade.p),
        quantity: parseFloat(trade.q),
        timestamp: trade.T,
        isBuyerMaker: trade.m
      };

      // Broadcast to all subscribed clients
      broadcastToSubscribers(symbol, normalizedData);
    } catch (error) {
      console.error(`❌ Error parsing ${symbol} data:`, error.message);
    }
  });

  ws.on('error', (error) => {
    console.error(`❌ ${symbol} connection error:`, error.message);
  });

  ws.on('close', () => {
    console.log(`🔌 Disconnected from ${symbol}`);
    marketConnections.delete(symbol);

    // Reconnect if there are still subscribers
    if (getSubscriberCount(symbol) > 0) {
      setTimeout(() => connectToMarket(symbol, market), 5000);
    }
  });

  marketConnections.set(symbol, ws);
}

/**
 * Broadcast data to all clients subscribed to a symbol
 */
function broadcastToSubscribers(symbol, data) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      const subscriptions = clientSubscriptions.get(client);
      if (subscriptions && subscriptions.has(symbol)) {
        client.send(JSON.stringify({
          type: 'trade',
          data: data
        }));
      }
    }
  });
}

/**
 * Count active subscribers for a symbol
 */
function getSubscriberCount(symbol) {
  let count = 0;
  clientSubscriptions.forEach((subs) => {
    if (subs.has(symbol)) count++;
  });
  return count;
}

/**
 * Fetch historical candle data (OHLCV)
 */
async function fetchHistoricalData(symbol, interval = '1m', limit = 100) {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const response = await fetch(url);
    const data = await response.json();

    return data.map(candle => ({
      timestamp: candle[0],
      open: parseFloat(candle[1]),
      high: parseFloat(candle[2]),
      low: parseFloat(candle[3]),
      close: parseFloat(candle[4]),
      volume: parseFloat(candle[5])
    }));
  } catch (error) {
    console.error('❌ Error fetching historical data:', error.message);
    return [];
  }
}

// Handle client connections
wss.on('connection', (ws) => {
  console.log('👤 New client connected');
  clientSubscriptions.set(ws, new Set());

  // Send welcome message
  ws.send(JSON.stringify({
    type: 'connected',
    message: 'Connected to IPFX Market Data Server',
    availableSymbols: MARKETS.crypto.symbols
  }));

  ws.on('message', async (message) => {
    try {
      const msg = JSON.parse(message.toString());

      switch (msg.type) {
        case 'subscribe':
          const symbol = msg.symbol.toUpperCase();
          const subscriptions = clientSubscriptions.get(ws);

          if (!MARKETS.crypto.symbols.includes(symbol)) {
            ws.send(JSON.stringify({
              type: 'error',
              message: `Symbol ${symbol} not supported`
            }));
            return;
          }

          subscriptions.add(symbol);
          console.log(`📈 Client subscribed to ${symbol}`);

          // Connect to market if not already connected
          if (!marketConnections.has(symbol)) {
            connectToMarket(symbol);
          }

          // Send historical data
          const historical = await fetchHistoricalData(symbol, msg.interval || '1m', msg.limit || 100);
          ws.send(JSON.stringify({
            type: 'historical',
            symbol: symbol,
            data: historical
          }));

          break;

        case 'unsubscribe':
          const unsub = msg.symbol.toUpperCase();
          const subs = clientSubscriptions.get(ws);
          subs.delete(unsub);
          console.log(`📉 Client unsubscribed from ${unsub}`);

          // Disconnect from market if no more subscribers
          if (getSubscriberCount(unsub) === 0) {
            const marketWs = marketConnections.get(unsub);
            if (marketWs) {
              marketWs.close();
              marketConnections.delete(unsub);
            }
          }
          break;

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;

        default:
          ws.send(JSON.stringify({
            type: 'error',
            message: `Unknown message type: ${msg.type}`
          }));
      }
    } catch (error) {
      console.error('❌ Error handling message:', error.message);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid message format'
      }));
    }
  });

  ws.on('close', () => {
    console.log('👋 Client disconnected');
    const subscriptions = clientSubscriptions.get(ws);

    // Clean up subscriptions
    if (subscriptions) {
      subscriptions.forEach((symbol) => {
        if (getSubscriberCount(symbol) === 0) {
          const marketWs = marketConnections.get(symbol);
          if (marketWs) {
            marketWs.close();
            marketConnections.delete(symbol);
          }
        }
      });
    }

    clientSubscriptions.delete(ws);
  });

  ws.on('error', (error) => {
    console.error('❌ Client connection error:', error.message);
  });
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down gracefully...');

  // Close all market connections
  marketConnections.forEach((ws) => ws.close());

  // Close server
  wss.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});
