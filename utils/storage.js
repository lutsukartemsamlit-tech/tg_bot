const fs   = require('fs');
const path = require('path');

const ORDERS_FILE = path.join(__dirname, '../data/orders.json');

// Redis client
let redis = null;
let redisInitialized = false;

function getRedisClient() {
  if (!redisInitialized) {
    if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
      try {
        const { Redis } = require('@upstash/redis');
        redis = new Redis({
          url: process.env.UPSTASH_REDIS_REST_URL,
          token: process.env.UPSTASH_REDIS_REST_TOKEN,
        });
      } catch (e) {
        console.error('Redis init error:', e.message);
      }
    }
    redisInitialized = true;
  }
  return redis;
}

function ensureDataDir() {
  const dataDir = path.join(__dirname, '../data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

// Синхронная версия - читает из файла (для обратной совместимости)
function getOrders() {
  ensureDataDir();
  try {
    if (fs.existsSync(ORDERS_FILE)) {
      const data = fs.readFileSync(ORDERS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('Ошибка чтения заказов:', e);
  }
  return [];
}

// Async версия - читает из Redis, fallback к файлу
async function getOrdersAsync() {
  // Пробуем загрузить из Redis
  try {
    const redisClient = getRedisClient();
    if (redisClient) {
      let orders = await redisClient.get('orders');
      if (orders) {
        if (typeof orders === 'string') {
          orders = JSON.parse(orders);
        }
        if (Array.isArray(orders)) {
          console.log(`📦 Loaded ${orders.length} orders from Redis`);
          return orders;
        }
      }
    }
  } catch (e) {
    console.error('Ошибка чтения заказов из Redis:', e.message);
  }
  
  // Fallback: читаем из файла
  return getOrders();
}

// Синхронная версия - сохраняет в файл (для обратной совместимости)
function saveOrder(order) {
  ensureDataDir();
  try {
    const orders = getOrders();
    // Поддержка обоих форматов: order.id (бот) и order.orderId (mini app)
    const uid = order.id || order.orderId;
    const idx = orders.findIndex(o => (o.id || o.orderId) === uid);
    if (idx >= 0) orders[idx] = order;
    else orders.push(order);
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
    
    // Async сохранение в Redis (без ожидания)
    saveOrderAsync(order).catch(e => console.error('Redis save error:', e.message));
    
    return true;
  } catch (e) {
    console.error('Ошибка сохранения заказа:', e);
    return false;
  }
}

// Async версия - сохраняет в Redis И файл
async function saveOrderAsync(order) {
  const uid = order.id || order.orderId;
  
  // Сохраняем в Redis
  try {
    const redisClient = getRedisClient();
    if (redisClient) {
      const orders = await getOrdersAsync();
      const idx = orders.findIndex(o => (o.id || o.orderId) === uid);
      if (idx >= 0) orders[idx] = order;
      else orders.push(order);
      
      await redisClient.set('orders', JSON.stringify(orders));
      console.log('✅ Order saved to Redis:', uid);
    }
  } catch (e) {
    console.error('Ошибка сохранения заказа в Redis:', e.message);
  }
  
  // Сохраняем в файл
  ensureDataDir();
  try {
    const orders = getOrders();
    const idx = orders.findIndex(o => (o.id || o.orderId) === uid);
    if (idx >= 0) orders[idx] = order;
    else orders.push(order);
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
  } catch (e) {
    console.error('Ошибка сохранения заказа в файл:', e);
  }
}

function clearOrders() {
  ensureDataDir();
  try {
    fs.writeFileSync(ORDERS_FILE, JSON.stringify([], null, 2));
    return true;
  } catch (e) {
    console.error('Ошибка очистки заказов:', e);
    return false;
  }
}

module.exports = { getOrders, saveOrder, clearOrders, getOrdersAsync, saveOrderAsync };
