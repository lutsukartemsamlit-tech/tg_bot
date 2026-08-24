#!/usr/bin/env node
/**
 * Скрипт быстрого бэкапа проекта
 * Использование: node backup.js
 */

const fs = require('fs');
const path = require('path');
const { Redis } = require('@upstash/redis');
require('dotenv').config();

const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
const backupDir = `backup_${timestamp}`;

console.log('📦 СОЗДАНИЕ БЭКАПА');
console.log('='.repeat(60));
console.log('');

// Создаем директорию
if (!fs.existsSync(backupDir)) {
  fs.mkdirSync(backupDir, { recursive: true });
}

// Файлы для копирования
const filesToBackup = [
  'data/products.js',
  'data/orders.json',
  'data/chats.json',
  'data/reviews.json',
  'miniapp/products.json',
  'src/bot.js',
  'utils/storage.js',
  'utils/helpers.js',
  'utils/productManager.js',
  'utils/reviews.js',
  'miniapp/api/order.js',
  'miniapp/api/products.js',
  'miniapp/app.js',
  'package.json',
  '.env.example',
  'vercel.json',
  'miniapp/vercel.json'
];

console.log('1️⃣ Копирование файлов...');
let copiedFiles = 0;
filesToBackup.forEach(file => {
  if (fs.existsSync(file)) {
    const destDir = path.join(backupDir, path.dirname(file));
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    fs.copyFileSync(file, path.join(backupDir, file));
    copiedFiles++;
  }
});
console.log(`   ✅ Скопировано: ${copiedFiles} файлов`);
console.log('');

// Экспорт из Redis
console.log('2️⃣ Экспорт из Redis...');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

Promise.all([
  redis.get('products'),
  redis.get('orders')
]).then(([products, orders]) => {
  
  // Products
  if (products) {
    const productsData = typeof products === 'string' ? JSON.parse(products) : products;
    const productsArray = Array.isArray(productsData) ? productsData : (productsData.products || []);
    
    fs.writeFileSync(
      path.join(backupDir, 'redis_products_backup.json'),
      JSON.stringify(productsData, null, 2)
    );
    console.log(`   ✅ Products: ${productsArray.length} товаров`);
  }
  
  // Orders
  if (orders) {
    const ordersData = typeof orders === 'string' ? JSON.parse(orders) : orders;
    const ordersArray = Array.isArray(ordersData) ? ordersData : [];
    
    fs.writeFileSync(
      path.join(backupDir, 'redis_orders_backup.json'),
      JSON.stringify(ordersData, null, 2)
    );
    console.log(`   ✅ Orders: ${ordersArray.length} заказов`);
  }
  
  console.log('');
  console.log('3️⃣ Создание README...');
  
  const productsCount = products ? (Array.isArray(products) ? products.length : (products.products?.length || 'N/A')) : 0;
  const ordersCount = orders ? (Array.isArray(orders) ? orders.length : 0) : 0;
  
  const readme = `# Бэкап проекта Puff_Now63

Дата создания: ${new Date().toLocaleString('ru-RU')}

## Быстрое восстановление:

### Товары (Redis):
\`\`\`bash
node -e "
const { Redis } = require('@upstash/redis');
require('dotenv').config();
const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
const products = require('./redis_products_backup.json');
redis.set('products', JSON.stringify(products)).then(() => console.log('✅ Товары восстановлены'));
"
\`\`\`

### Заказы (Redis):
\`\`\`bash
node -e "
const { Redis } = require('@upstash/redis');
require('dotenv').config();
const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
const orders = require('./redis_orders_backup.json');
redis.set('orders', JSON.stringify(orders)).then(() => console.log('✅ Заказы восстановлены'));
"
\`\`\`

## Содержимое:

- **Код:** ${copiedFiles} файлов
- **Товары:** ${productsCount} товаров (Redis)
- **Заказы:** ${ordersCount} заказов (Redis)
- **Данные:** orders.json, chats.json, reviews.json

## Файлы:

### Исходный код:
- src/bot.js - основной бот
- utils/*.js - утилиты
- miniapp/app.js - клиентское приложение
- miniapp/api/*.js - API endpoints

### Данные:
- redis_products_backup.json - товары из Redis
- redis_orders_backup.json - заказы из Redis
- data/*.json - локальные данные

### Конфигурация:
- package.json - зависимости
- vercel.json - настройки Vercel

---

**Создан автоматически через:** \`node backup.js\`
`;

  fs.writeFileSync(path.join(backupDir, 'README.md'), readme);
  console.log('   ✅ README.md');
  console.log('');
  
  console.log('='.repeat(60));
  console.log(`✅ БЭКАП СОЗДАН: ${backupDir}`);
  console.log('='.repeat(60));
  console.log('');
  console.log('📁 Содержимое:');
  console.log(`   • ${copiedFiles} файлов кода`);
  console.log(`   • ${productsCount} товаров`);
  console.log(`   • ${ordersCount} заказов`);
  console.log('');
  console.log('💡 Скопируйте папку в безопасное место!');
  
}).catch(err => {
  console.error('❌ Ошибка:', err.message);
  process.exit(1);
});
