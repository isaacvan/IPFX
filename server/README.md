# IPFX Market Data Server

Real-time cryptocurrency market data WebSocket server for IPFX Capital.

## Features

- **Live Price Feeds**: Real-time trade data from Binance
- **Historical Data**: OHLCV candles for charting
- **Multi-Symbol Support**: BTC, ETH, and other major pairs
- **Auto-Reconnection**: Resilient connection handling
- **Efficient Resource Management**: Only connects to requested markets

## Quick Start

### 1. Install Dependencies

```bash
cd server
npm install
```

### 2. Start the Server

```bash
npm start
```

The server will start on `ws://localhost:8080`

For development with auto-restart:
```bash
npm run dev
```

### 3. Open the Frontend

Open `market-data.html` in your browser or serve it:

```bash
# From project root
npx serve .
```

Then visit: `http://localhost:3000/market-data.html`

## Architecture

```
Browser ←→ WebSocket Server ←→ Binance WebSocket API
         (localhost:8080)      (stream.binance.com)
```

### Data Flow

1. **Client connects** → Server sends available symbols
2. **Client subscribes** to symbol → Server:
   - Connects to Binance for that symbol (if not already connected)
   - Fetches historical data (100 candles)
   - Sends historical data to client
3. **Live trades** → Server broadcasts to all subscribed clients
4. **Client disconnects** → Server closes unused market connections

## API Reference

### Client → Server Messages

#### Subscribe to Symbol
```json
{
  "type": "subscribe",
  "symbol": "BTCUSDT",
  "interval": "1m",
  "limit": 100
}
```

#### Unsubscribe
```json
{
  "type": "unsubscribe",
  "symbol": "BTCUSDT"
}
```

#### Ping
```json
{
  "type": "ping"
}
```

### Server → Client Messages

#### Connection Established
```json
{
  "type": "connected",
  "message": "Connected to IPFX Market Data Server",
  "availableSymbols": ["BTCUSDT", "ETHUSDT", ...]
}
```

#### Historical Data
```json
{
  "type": "historical",
  "symbol": "BTCUSDT",
  "data": [
    {
      "timestamp": 1704672000000,
      "open": 42000.50,
      "high": 42100.00,
      "low": 41950.00,
      "close": 42050.00,
      "volume": 150.25
    },
    ...
  ]
}
```

#### Live Trade
```json
{
  "type": "trade",
  "data": {
    "symbol": "BTCUSDT",
    "price": 42050.00,
    "quantity": 0.15,
    "timestamp": 1704672060000,
    "isBuyerMaker": false
  }
}
```

#### Error
```json
{
  "type": "error",
  "message": "Symbol INVALID not supported"
}
```

## Configuration

Edit `server.js` to customize:

### Add More Symbols
```javascript
const MARKETS = {
  crypto: {
    provider: 'binance',
    symbols: ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'ADAUSDT'], // Add here
    wsUrl: (symbol) => `wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@trade`
  }
};
```

### Change Port
```javascript
const PORT = 8080; // Change to your preferred port
```

### Adjust Historical Data Limits
```javascript
async function fetchHistoricalData(symbol, interval = '1m', limit = 100) {
  // Change limit parameter default value
}
```

## Adding Forex Support

To add forex data, you'll need a forex data provider (most require API keys):

### Example with OANDA
```javascript
const MARKETS = {
  crypto: { /* existing config */ },
  forex: {
    provider: 'oanda',
    apiKey: process.env.OANDA_API_KEY,
    symbols: ['EUR_USD', 'GBP_USD', 'USD_JPY'],
    wsUrl: (symbol) => `wss://stream-fxpractice.oanda.com/v3/accounts/${accountId}/pricing/stream`
  }
};
```

**Popular Forex Data Providers:**
- OANDA (free practice account)
- Interactive Brokers
- FXCM
- Twelve Data
- Alpha Vantage

## Production Deployment

### Environment Variables
```bash
# .env file
PORT=8080
NODE_ENV=production
BINANCE_API_KEY=your_key_here  # For private endpoints
```

### Security Considerations
- Add rate limiting
- Implement authentication
- Use WSS (WebSocket Secure) with SSL certificates
- Whitelist allowed origins
- Monitor connection limits

### Hosting Options
- **Heroku**: Easy deployment with WebSocket support
- **Railway**: Modern platform with great DX
- **AWS EC2/ECS**: Full control and scalability
- **DigitalOcean App Platform**: Simple and affordable

### Example: Deploy to Railway
```bash
# Install Railway CLI
npm i -g @railway/cli

# Login and deploy
railway login
railway init
railway up
```

## Monitoring

The server logs all major events:
- ✅ Successful connections
- 📡 New market data connections
- 👤 Client connections/disconnections
- ❌ Errors and connection issues

## Troubleshooting

### "Connection refused" error
- Ensure the server is running (`npm start`)
- Check the port (default: 8080)
- Verify WebSocket URL in `market-data.html` matches server port

### No data appearing
- Open browser console (F12) to check for errors
- Verify Binance API is accessible (try visiting https://api.binance.com/api/v3/ping)
- Check if firewall is blocking WebSocket connections

### High memory usage
- Reduce `MAX_TRADES` in frontend
- Limit number of subscribed symbols
- Reduce historical data limit

## Next Steps

1. **Add More Markets**: Forex, stocks, commodities
2. **Advanced Charts**: Integrate TradingView Lightweight Charts
3. **Technical Indicators**: RSI, MACD, Moving Averages
4. **User Accounts**: Save watchlists and preferences
5. **Alerts**: Price alerts and notifications
6. **Paper Trading**: Simulate trading with virtual accounts
7. **Order Book**: Show bid/ask depth
8. **Market Depth Chart**: Visualize liquidity

## Resources

- [Binance API Docs](https://binance-docs.github.io/apidocs/spot/en/)
- [WebSocket MDN Docs](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket)
- [Node.js ws Library](https://github.com/websockets/ws)

## License

Proprietary - IPFX Capital
