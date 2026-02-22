---
description: Repository Information Overview
alwaysApply: true
---

# Trading Application Information

## Summary
A Node.js-based algorithmic trading application that integrates with the Upstox stock trading API. The system features a TradingView webhook server for automated trade execution with risk management, a real-time stock price dashboard, and comprehensive market data streaming capabilities.

## Structure
- **Root**: Main Express backend server (server.js) handling TradingView webhooks and Upstox API integration
- **frontend/**: Real-time stock dashboard with WebSocket-based live price updates
- **instruments/**: NSE (National Stock Exchange) instrument master data file
- **.github/**: CI/CD and workflow configurations
- **.zencoder/**: Code generation and analysis rules
- **.zenflow/**: Workflow automation configurations

## Language & Runtime
**Language**: JavaScript (Node.js)  
**Runtime**: Node.js (CommonJS)  
**Package Manager**: npm  
**Build System**: Node.js runtime (no compilation step)

## Dependencies
**Main Dependencies**:
- **express** (v5.2.1): Web framework for HTTP server and REST API
- **axios** (v1.13.5): HTTP client for API requests to Upstox
- **socket.io** (v4.8.3): Real-time bidirectional communication for live stock data
- **upstox-js-sdk** (v2.21.0): Official SDK for Upstox API integration
- **protobufjs** (v8.0.0): Protocol buffer support for Upstox streaming
- **dotenv** (v17.3.1): Environment variable management
- **csv-parser** (v3.2.0): CSV parsing utility
- **ws** (v8.19.0): WebSocket client library

## Build & Installation
```bash
npm install
```

## Main Entry Points
**Backend Server**: `server.js`
- Port: 5000 (configurable via PORT env variable)
- Handles TradingView webhook signals at `/webhook/tradingview`
- OAuth login/callback at `/auth/login` and `/auth/callback`
- Health check at `/`

**Frontend Server**: `frontend/frontend.js`
- Port: 5000
- Real-time stock price dashboard at `/`
- Streams live market data for 10 major NSE stocks (RELIANCE, TCS, INFY, HDFCBANK, ICICIBANK, SBIN, BHARTIARTL, KOTAKBANK, LT, AXISBANK)
- WebSocket-based push updates to connected clients

**Data Source**: `instruments/NSE.json`
- 54.91 MB file containing NSE instrument master with trading symbols and tokens

## Configuration
**Environment Variables** (`.env`):
- `PORT`: Server port (default: 5000)
- `WEBHOOK_SECRET`: TradingView webhook authentication token
- `UPSTOX_CLIENT_ID`: OAuth client ID for Upstox API
- `UPSTOX_CLIENT_SECRET`: OAuth client secret
- `UPSTOX_REDIRECT_URI`: OAuth callback redirect URL
- `MAX_CAPITAL_PER_TRADE`: Maximum capital per trade (default: 10000)
- `MAX_TOTAL_POSITIONS`: Maximum concurrent positions (default: 5)
- `MAX_QUANTITY_PER_TRADE`: Maximum quantity per trade (default: 100)

## Key Features
- **Webhook Integration**: Accepts trading signals from TradingView
- **Risk Management**: Position limits, capital limits, quantity validation
- **Duplicate Signal Detection**: Prevents duplicate orders within 60-second window
- **Token Refresh**: Automatic Upstox OAuth token refresh (23-hour expiry)
- **Real-Time Streaming**: Market data streaming via Upstox WebSocket (LTPC mode)
- **Market Data Access**: LTP (Last Traded Price), net change, percentage change
- **Order Placement**: MARKET orders via Upstox API with position checking

## Testing
No dedicated test framework configured. Default test command returns error. Testing would require:
- Manual webhook testing via HTTP requests
- Integration testing with Upstox sandbox environment
- Frontend visual testing via browser
