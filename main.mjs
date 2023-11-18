// Dependencies
import chalk from "chalk";
import dotenv from "dotenv";
import Taapi from "taapi";
import { exec } from "child_process";

dotenv.config();

function logger(level, message) {
  const timestamp = new Date().toISOString();
  let color = chalk.hex("#15B5B0");
  if (level == "error") {
    color = chalk.red;
  } else if (level == "warn") {
    color = chalk.hex("#FFA500");
  } else if (level == "finance") {
    color = chalk.hex("#3EAB76");
  } else if (level == "finance-profit") {
    color = chalk.hex("#FF00DD");
  }
  console.log(color(`${timestamp} - ${message}`));
}

function sendTelegramMessage(message) {
  exec(`telegram-send "${message}"`, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error: ${error.message}`);
      return;
    }
    if (stderr) {
      console.error(`Stderr: ${stderr}`);
      return;
    }
    // console.log(`Stdout: ${stdout}`);
  });
}

// Dynamically import the ES Module '@ln-markets/api'
async function loadModules() {
  // Function to validate the presence of required environment variables
  function validateEnvVariables() {
    const requiredEnv = [
      "LNM_API_KEY",
      "LNM_API_SECRET",
      "LNM_PASSPHRASE",
      "TAAPI_API_KEY",
    ];
    const missingEnv = requiredEnv.filter((envVar) => !process.env[envVar]);

    if (missingEnv.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missingEnv.join(", ")}`
      );
    }
  }

  // Validate environment variables before creating Taapi client
  validateEnvVariables();

  const { createRestClient, createWebsocketClient } = await import(
    "@ln-markets/api"
  );
  // Configuration
  const apiConfig = {
    key: process.env.LNM_API_KEY,
    secret: process.env.LNM_API_SECRET,
    passphrase: process.env.LNM_PASSPHRASE,
  };
  const taapiClient = new Taapi.default(process.env.TAAPI_API_KEY);

  // RestClient Initialization
  const restClient = createRestClient(apiConfig);

  // Retry
  let retryCount = 0;
  const maxRetries = 5;

  // Trading State
  let lastTradeTime = 0;
  let lastPrice = null;
  let indexPrice = null;
  const fetchInterval = 60000;
  let lastCalledTime = Date.now() - fetchInterval;
  let lastTradeLogicCall = 0;
  let rsiData = [];
  let lastTickDirection = '';
  const period = 15;
  const tradeLogicCooldown = 60 * 1000;

  const canMakeTrade = () => Date.now() - lastTradeTime > 1000;

  function calculateMovingAverage(data, period) {
    let movingAverages = [];
    for (let i = period - 1; i < data.length; i++) {
      let sum = 0;
      for (let j = 0; j < period; j++) {
        if (isNaN(data[i - j])) {
          logger("error", `Non-numeric data encountered: ${data[i - j]}`);
          return NaN; // Or handle this case as appropriate
        }
        sum += data[i - j];
      }
      let average = sum / period;
      movingAverages.push(average);
    }
    // logger('debug', `Calculated moving averages: ${movingAverages}`);
    return movingAverages.length > 0
      ? movingAverages[movingAverages.length - 1]
      : NaN;
  }

  function addRsiSample(sample) {
    if (rsiData.length > 15) {
      // Remove the oldest sample to make room for the new one
      rsiData.shift();
    }
    // Add the new RSI sample
    rsiData.push(sample);
  }

  async function fetchRSI(timeframe) {
    const currentTime = Date.now();
    if (currentTime - lastCalledTime < 15000) {
      return Promise.reject("RSI call is on cooldown");
    }
    try {
      // Call the RSI function and update the last called time
      const rsiResponse = await taapiClient.getIndicator(
        "rsi",
        "BTC/USDT",
        timeframe
      );
      lastCalledTime = currentTime;
      return rsiResponse;
    } catch (error) {
      console.error(`Failed to fetch RSI: ${error.message}`);
      return Promise.reject(error);
    }
  }

  async function fetchBbands(timeframe) {
    const currentTime = Date.now();
    if (currentTime - lastCalledTime < 15000) {
      return Promise.reject("RSI call is on cooldown");
    }
    try {
      // Call the RSI function and update the last called time
      const bbandsResponse = await taapiClient.getIndicator(
        "bbands",
        "BTC/USDT",
        timeframe
      );
      lastCalledTime = currentTime;
      return bbandsResponse;
    } catch (error) {
      console.error(`Failed to fetch Bbands: ${error.message}`);
      return Promise.reject(error);
    }
  }

  async function fetchUltosc(timeframe) {
    const currentTime = Date.now();
    if (currentTime - lastCalledTime < 15000) {
      return Promise.reject("Ultosc call is on cooldown");
    }
    try {
      const ultoscResponse = await taapiClient.getIndicator(
        "ultosc",
        "BTC/USDT",
        timeframe
      );
      lastCalledTime = currentTime;
      return ultoscResponse;
    } catch (error) {
      console.error(`Failed to fetch ultosc: ${error.message}`);
      return Promise.reject(error);
    }
  }

  async function fetchStddev(timeframe) {
    const currentTime = Date.now();
    if (currentTime - lastCalledTime < 15000) {
      return Promise.reject("Stddev call is on cooldown");
    }
    try {
      const stddevResponse = await taapiClient.getIndicator(
        "stddev",
        "BTC/USDT",
        timeframe
      );
      lastCalledTime = currentTime;
      return stddevResponse;
    } catch (error) {
      console.error(`Failed to fetch stddev: ${error.message}`);
      return Promise.reject(error);
    }
  }

  async function fetchMacd(timeframe) {
    const currentTime = Date.now();
    if (currentTime - lastCalledTime < 15000) {
      return Promise.reject("Macd call is on cooldown");
    }
    try {
      const macdResponse = await taapiClient.getIndicator(
        "macd",
        "BTC/USDT",
        timeframe
      );
      lastCalledTime = currentTime;
      return macdResponse;
    } catch (error) {
      console.error(`Failed to fetch macd: ${error.message}`);
      return Promise.reject(error);
    }
  }

  function shouldCallTradeLogic() {
    const now = Date.now();
    return now - lastTradeLogicCall >= tradeLogicCooldown;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Trading logic
  async function tradeLogic() {
    if (!canMakeTrade()) {
      logger(
        "error",
        "Trade not possible: Cooling down period has not elapsed."
      );
      return;
    }
    if (lastPrice === null || indexPrice === null) {
      return;
    }
    // Fetch positions
    let totalSellExposure = 0;
    let totalBuyExposure = 0;
    try {
      let runningPositions = await restClient.futuresGetTrades({
        type: "running",
      });
      // Calculate total exposure for both sides
      let profitableSells = 0;
      let profitableBuys = 0;
      let sellPl = 0;
      let buyPl = 0;
      let changedPos = false;
      runningPositions.forEach((position) => {
        if (position.side === "s") {
          totalSellExposure += position.quantity;
          if (position.pl > 20) {
            logger(
              "finance-profit",
              `CLOSING SHORT POSITION ${JSON.stringify(position)}`
            );
            restClient.futuresCloseTrade(position.id);
            profitableSells += 2;
            sendTelegramMessage(
              `Closed profitable short on LNM: fee ${position.opening_fee}, price ${position.price}, pl ${position.pl}`
            );
            changedPos = true;
          } else if (position.pl < -19) {
            logger(
              "error",
              `CLOSING SHORT POSITION AT LOSS ${JSON.stringify(position)}`
            );
            restClient.futuresCloseTrade(position.id);
            sendTelegramMessage(
              `Closed short at a loss on LNM: fee ${position.opening_fee}, price ${position.price}, pl ${position.pl}`
            );
            changedPos = true;
          }
        } else if (position.side === "b") {
          totalBuyExposure += position.quantity;
          if (position.pl > 20) {
            logger(
              "finance-profit",
              `CLOSING LONG POSITION ${JSON.stringify(position)}`
            );
            restClient.futuresCloseTrade(position.id);
            profitableBuys += 2;
            sendTelegramMessage(
              `Closed profitable long on LNM: fee ${position.opening_fee}, price ${position.price}, pl ${position.pl}`
            );
            changedPos = true;
          } else if (position.pl < -19) {
            logger(
              "error",
              `CLOSING LONG POSITION AT LOSS ${JSON.stringify(position)}`
            );
            restClient.futuresCloseTrade(position.id);
            sendTelegramMessage(
              `Closed long at a loss on LNM: fee ${position.opening_fee}, price ${position.price}, pl ${position.pl}`
            );
            changedPos = true;
          }
        }
      });
      // Reread positions
      if (changedPos) {
        totalSellExposure = 0;
        totalBuyExposure = 0;
        await sleep(1000);
        runningPositions = await restClient.futuresGetTrades({
          type: "running",
        });
        runningPositions.forEach((position) => {
          if (position.side === "s") {
            totalSellExposure += position.quantity;
            sellPl += position.pl;
          } else if (position.side === "b") {
            totalBuyExposure += position.quantity;
            buyPl += position.pl;
          }
        });
      }
      logger(
        "info",
        `Profitable sells: $${profitableSells} (exp $${totalSellExposure} pl ${sellPl} sats), profitable buys: $${profitableBuys} (exp $${totalBuyExposure} pl ${buyPl} sats)`
      );
      // logger('info', `Sell exposure: $${totalSellExposure}, Buy exposure: $${totalBuyExposure}, Position: $${totalBuyExposure-totalSellExposure}`);
    } catch (error) {
      logger("error", `Fetching positions failed: ${JSON.stringify(error)}`);
      logger(error.stack);
    }
    logger("info", `Last tick direction: ${lastTickDirection}, price ${lastPrice}`);
    try {
      let action = "none";
      let rsi = await fetchRSI("15m");
      await sleep(15000);
      let bbands = await fetchBbands("15m");
      await sleep(15000);
      // let ultosc = await fetchUltosc('15m');
      // await sleep(15000);
      let adjustedSellRsiThreshold = 75;
      let adjustedBuyRsiThreshold = 45;
      addRsiSample(rsi.value);
      // Keep consuming RSI samples until we have `period` number of samples
      // logger('finance', rsiData);
      // logger('finance', `Ultosc: ${ultosc.value}`);
      if (rsiData.length >= period) {
        // Get moving average and print calculated thresholds
        const movingAverageRSI = Number(
          calculateMovingAverage(rsiData, period)
        );
        logger("finance", `RSI_movAvg: ${movingAverageRSI}`);
        logger(
          "finance",
          `RSI_mBuy: ${movingAverageRSI - 2}, RSI_mSell: ${
            movingAverageRSI + 10
          }`
        );
        adjustedSellRsiThreshold = movingAverageRSI + 10;
        adjustedBuyRsiThreshold = movingAverageRSI - 2;
      } else {
        return;
      }
      logger(
        "finance",
        `RSI: ${rsi.value}, Bands: ${bbands.valueLowerBand} / ${bbands.valueUpperBand}`
      );
      logger("finance", `Price ${lastPrice}, Index price ${indexPrice}`);
      if (totalSellExposure > 19 || totalBuyExposure > 19) {
        // logger('info', 'Exposure on one side is greater than $9, returning early.');
        return;
      }
      let sellPriceThreshold = bbands.valueLowerBand * 1.03;
      let buyPriceThreshold = bbands.valueUpperBand * 0.9960;
      logger(
        "info",
        `Sell thresh $${sellPriceThreshold}, Buy thresh $${buyPriceThreshold}`
      );
      // Check for sell conditions
      if (
        rsi.value >= adjustedSellRsiThreshold &&
        lastPrice > sellPriceThreshold
      ) {
        action = "sell";
        logger(
          "warn",
          `Condition met for selling: RSI ${rsi.value} is above ${adjustedSellRsiThreshold} and price is 3% higher than Bollinger Lower Band. Attempting to sell at ${lastPrice}.`
        );
        await restClient.futuresNewTrade({
          side: "s",
          type: "m",
          leverage: 1,
          quantity: 2,
        });
        sendTelegramMessage(`Shorted on LNM at ${lastPrice}`);
      } else if (
        rsi.value <= adjustedBuyRsiThreshold &&
        lastPrice < buyPriceThreshold
      ) {
        action = "buy";
        logger(
          "warn",
          `Condition met for buying: RSI ${rsi.value} is below ${adjustedBuyRsiThreshold} and price is 0.40% lower than Bollinger Higher Band. Attempting to buy at ${lastPrice}.`
        );
        await restClient.futuresNewTrade({
          side: "b",
          type: "m",
          leverage: 1,
          quantity: 2,
        });
        sendTelegramMessage(`Longed on LNM at ${lastPrice}`);
      }
      // Update the timestamp of the last trade
      lastTradeTime = Date.now();
      if (action !== "none") {
        logger("finance", `Trade action executed: ${action}`);
      }
    } catch (error) {
      const errorLog = {
        message: error.message,
        stack: error.stack,
        name: error.name,
      };
      logger("error", `Trade execution failed: ${errorLog.message}`);
      logger("error", errorLog.stack);
      const errorDetails = JSON.stringify(
        error,
        Object.getOwnPropertyNames(error)
      );
      logger("error", `Error details: ${errorDetails}`);
    }
  }

  // WebSocket client for live data
  async function setupWebSocket() {
    logger("info", "Setting up websocket");
    try {
      const wsClient = await createWebsocketClient(apiConfig);
      await wsClient.publicSubscribe([
        "futures:btc_usd:last-price",
        "futures:btc_usd:index",
      ]);
      logger("info", "Subscribed to websocket topics");
      wsClient.ws.on("futures:btc_usd:last-price", (data) => {
        // logger("info", `Received price data: ${JSON.stringify(data, null, 2)}`);
        if (data?.lastPrice !== undefined) {
          lastPrice = data.lastPrice;
          lastTickDirection = data.lastTickDirection;
          // console.log(`Updated last price: ${lastPrice}`);
          if (shouldCallTradeLogic()) {
            tradeLogic();
            lastTradeLogicCall = Date.now();
          }
        } else {
          logger("error", "Last price data is undefined in the received data");
        }
      });
      wsClient.ws.on("futures:btc_usd:index", (data) => {
        // logger("info", `Received index data: ${JSON.stringify(data, null, 2)}`);
        if (data?.index !== undefined) {
          indexPrice = data.index;
          if (shouldCallTradeLogic()) {
            tradeLogic();
            lastTradeLogicCall = Date.now();
          }
        } else {
          logger("error", "Index price data is undefined in the received data");
        }
      });
      wsClient.ws.on("open", () => (retryCount = 0));
      wsClient.ws.on("close", () => {
        logger("info", "WebSocket closed");
        if (retryCount < maxRetries) {
          let delay = Math.min(1000 * 2 ** retryCount, 30000);
          logger("info", "Reconnecting websocket");
          setTimeout(setupWebSocket, delay);
          retryCount++;
        } else {
          logger("error", "Max retries reached for reconnect");
        }
      });
      wsClient.ws.on("error", (error) =>
        console.error(`WebSocket error: ${error.message}`)
      );
    } catch (error) {
      logger("error", `WebSocket setup failed: ${error.message}`);
    }
  }
  setupWebSocket();
}

loadModules().catch(console.error);
