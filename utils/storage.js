const fs   = require('fs');
const path = require('path');

const ORDERS_FILE = path.join(__dirname, '../data/orders.json');

// Redis client
let redis = null;
let redisInitialized = false;
let ordersCache = null; // Кэш заказов из Redis

function getRedisClient() {
  if (!redisInitialized) {
    if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
      try {
        const { Redis } = require('@upstash/redis');
        redis = new Redis({
          url: process.env.UPSTASH_REDIS_REST_URL,
          token: process.env.UPSTASH_REDIS_REST_TOKEN,
        });
        console.log('✅ Redis client initialized for orders');
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

// Инициализация при старте - загружаем заказы из Redis в кэш
async function initOrdersCache() {
  try {
    const redisClient = getRedisClient();
    if (redisClient) {
      let orders = await redisClient.get('orders');
      if (orders) {
        if (typeof orders === 'string') {
          orders = JSON.parse(orders);
        }
        if (Array.isArray(orders)) {
          ordersCache = orders;
          console.log(`✅ Orders cache loaded from Redis: ${orders.length} orders`);
          return;
        }
      }
    }
  } catch (e) {
    console.error('❌ Error loading orders cache from Redis:', e.message);
  }
  
  // Fallback: загружаем из файла
  ordersCache = getOrdersFromFile();
  console.log(`📄 Orders cache loaded from file: ${ordersCache.length} orders`);
}

// Обновление кэша из Redis (вызывается перед поиском заказа)
async function refreshOrdersCache() {
  try {
    const redisClient = getRedisClient();
    if (redisClient) {
      let orders = await redisClient.get('orders');
      if (orders) {
        if (typeof orders === 'string') {
          orders = JSON.parse(orders);
        }
        if (Array.isArray(orders)) {
          ordersCache = orders;
          console.log(`🔄 Orders cache refreshed from Redis: ${orders.length} orders`);
          return true;
        }
      }
    }
  } catch (e) {
    console.error('❌ Error refreshing orders cache:', e.message);
  }
  return false;
}

// Чтение из файла
function getOrdersFromFile() {
  ensureDataDir();
  try {
    if (fs.existsSync(ORDERS_FILE)) {
      const data = fs.readFileSync(ORDERS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('Ошибка чтения заказов из файла:', e);
  }
  return [];
}

// Синхронная версия - возвращает из кэша
function getOrders() {
  if (ordersCache) {
    return ordersCache;
  }
  // Если кэш не загружен - читаем из файла
  return getOrdersFromFile();
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
          // Показываем последние 3 для отладки
          if (orders.length > 0) {
            const recent = orders.slice(-3);
            console.log('   Recent orders:', recent.map(o => (o.id || o.orderId) + '(' + o.source + ')').join(', '));
          }
          return orders;
        }
      } else {
        console.log('⚠️ No orders in Redis, falling back to file');
      }
    } else {
      console.log('⚠️ Redis client not available');
    }
  } catch (e) {
    console.error('❌ Error reading orders from Redis:', e.message);
  }
  
  // Fallback: читаем из файла
  console.log('📄 Loading orders from file');
  return getOrders();
}

// Синхронная версия - сохраняет в файл И обновляет кэш
function saveOrder(order) {
  const uid = order.id || order.orderId;
  
  // Обновляем кэш
  if (ordersCache) {
    const idx = ordersCache.findIndex(o => (o.id || o.orderId) === uid);
    if (idx >= 0) ordersCache[idx] = order;
    else ordersCache.push(order);
  }
  
  // Сохраняем в файл
  ensureDataDir();
  try {
    const orders = getOrdersFromFile();
    const idx = orders.findIndex(o => (o.id || o.orderId) === uid);
    if (idx >= 0) orders[idx] = order;
    else orders.push(order);
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
  } catch (e) {
    console.error('Ошибка сохранения заказа в файл:', e);
  }
  
  // Async сохранение в Redis (без ожидания)
  saveOrderAsync(order).catch(e => console.error('Redis save error:', e.message));
  
  return true;
}

// Async версия - сохраняет в Redis И обновляет кэш
async function saveOrderAsync(order) {
  const uid = order.id || order.orderId;
  
  // Обновляем кэш
  if (ordersCache) {
    const idx = ordersCache.findIndex(o => (o.id || o.orderId) === uid);
    if (idx >= 0) ordersCache[idx] = order;
    else ordersCache.push(order);
  }
  
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
      
      // Обновляем кэш с актуальными данными из Redis
      ordersCache = orders;
    }
  } catch (e) {
    console.error('Ошибка сохранения заказа в Redis:', e.message);
  }
  
  // Сохраняем в файл
  ensureDataDir();
  try {
    const orders = getOrdersFromFile();
    const idx = orders.findIndex(o => (o.id || o.orderId) === uid);
    if (idx >= 0) orders[idx] = order;
    else orders.push(order);
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
  } catch (e) {
    console.error('Ошибка сохранения заказа в файл:', e);
  }
}

module.exports = { getOrders, saveOrder, clearOrders, getOrdersAsync, saveOrderAsync, initOrdersCache, refreshOrdersCache };


function clearOrders() {
  ordersCache = [];
  
  // Очищаем Redis
  try {
    const redisClient = getRedisClient();
    if (redisClient) {
      redisClient.set('orders', JSON.stringify([])).then(() => {
        console.log('✅ Orders cleared in Redis');
      }).catch(e => console.error('Redis clear error:', e.message));
    }
  } catch (e) {
    console.error('Ошибка очистки заказов в Redis:', e.message);
  }
  
  // Очищаем файл
  ensureDataDir();
  try {
    fs.writeFileSync(ORDERS_FILE, JSON.stringify([], null, 2));
    return true;
  } catch (e) {
    console.error('Ошибка очистки заказов:', e);
    return false;
  }
}
