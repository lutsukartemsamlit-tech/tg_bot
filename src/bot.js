require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
// Принудительно IPv4 (IPv6 может не работать у некоторых провайдеров)
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const TelegramBot = require('node-telegram-bot-api');
const { saveOrder, getOrders, clearOrders } = require('../utils/storage');
const { formatPrice, generateOrderId } = require('../utils/helpers');
const { getReviews, saveReview, deleteReview, getStats, hasRecentReview } = require('../utils/reviews');
const { addProduct } = require('../utils/productManager');

// Redis client для загрузки товаров
let redis = null;
let products = [];
let categories = [];

// Инициализация Redis и загрузка товаров
async function loadProductsFromRedis() {
  try {
    if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
      const { Redis } = require('@upstash/redis');
      redis = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      });
      
      const cachedData = await redis.get('products');
      
      if (cachedData) {
        const parsedData = typeof cachedData === 'string' ? JSON.parse(cachedData) : cachedData;
        
        // Redis хранит только массив products, categories берем из файла
        if (Array.isArray(parsedData)) {
          products = parsedData;
          console.log('✅ Товары загружены из Redis:', products.length);
        } else {
          console.log('⚠️ Неверный формат данных в Redis, загружаем из файла');
          const fileData = require('../data/products');
          products = fileData.products;
          categories = fileData.categories;
        }
      } else {
        console.log('⚠️ Нет данных в Redis, загружаем из файла');
        const fileData = require('../data/products');
        products = fileData.products;
        categories = fileData.categories;
        // Сохраняем в Redis
        await redis.set('products', JSON.stringify(products));
      }
    } else {
      console.log('⚠️ Redis не настроен, загружаем из файла');
      const fileData = require('../data/products');
      products = fileData.products;
      categories = fileData.categories;
    }
  } catch (e) {
    console.error('❌ Ошибка загрузки из Redis:', e);
    const fileData = require('../data/products');
    products = fileData.products;
    categories = fileData.categories;
  }
  
  // Загружаем categories из файла если еще не загружены
  if (categories.length === 0) {
    const fileData = require('../data/products');
    categories = fileData.categories;
  }
}

const token = process.env.BOT_TOKEN;
const adminId = process.env.ADMIN_ID;
const adminIds = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => id.trim()) : [adminId];
const WEBAPP_URL = process.env.WEBAPP_URL || ''; // URL вашего Mini App
const REQUIRED_CHANNEL = process.env.REQUIRED_CHANNEL || ''; // Username или ID канала для обязательной подписки

// Проверка подписки пользователя на канал
// Возвращает true если подписан (или канал не задан / пользователь — админ)
async function isSubscribed(userId) {
  if (!REQUIRED_CHANNEL) return true;
  if (isAdmin(userId)) return true;
  try {
    const member = await bot.getChatMember(
      REQUIRED_CHANNEL.startsWith('-') ? Number(REQUIRED_CHANNEL) : `@${REQUIRED_CHANNEL}`,
      userId
    );
    return ['member', 'administrator', 'creator'].includes(member.status);
  } catch (e) {
    console.error('Ошибка проверки подписки:', e.message);
    // При ошибке (канал недоступен) — пропускаем проверку
    return true;
  }
}

// Показывает сообщение с требованием подписки
function sendSubscribeMessage(chatId) {
  const channelLink = REQUIRED_CHANNEL.startsWith('-')
    ? `https://t.me/c/${REQUIRED_CHANNEL.slice(4)}`
    : `https://t.me/${REQUIRED_CHANNEL}`;

  bot.sendMessage(chatId,
    `👋 Для использования бота необходимо подписаться на наш канал!\n\n` +
    `После подписки нажмите кнопку ниже ⬇️`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📢 Подписаться на канал', url: channelLink }],
          [{ text: '✅ Я подписался', callback_data: 'check_subscription' }]
        ]
      }
    }
  );
}

function isAdmin(userId) {
  return adminIds.includes(userId.toString());
}

if (!token) {
  console.error('Ошибка: BOT_TOKEN не установлен в .env файле');
  process.exit(1);
}

// Настройка бота с ускоренным опросом
const botOptions = { 
  polling: {
    interval: 200,
    params: { timeout: 10 }
  } 
};

const bot = new TelegramBot(token, botOptions);

// Обработка ошибок polling (409 Conflict - нормальная ситуация при перезапуске)
bot.on('polling_error', (error) => {
  // Игнорируем 409 Conflict - это происходит при перезапуске бота
  if (error.code === 'ETELEGRAM' && error.message.includes('409 Conflict')) {
    console.log('⚠️ Polling conflict (бот перезапускается)');
  } else {
    console.error('❌ Polling error:', error.code, error.message);
  }
});

// Загружаем товары из Redis при старте
loadProductsFromRedis().then(() => {
  console.log('✅ Бот запущен, товары загружены');
}).catch(err => {
  console.error('❌ Ошибка загрузки товаров:', err);
});

// Хранилище корзин пользователей
const userCarts = {};

// Хранилище состояний для ввода отзыва: { userId: { step: 'rating'|'text', rating: N, orderId } }
const reviewState = {};

// Хранилище состояний для добавления товара: { userId: { step: 'name'|'price'|'description'|'flavors', data: {...} } }
const addProductState = {};

// Подключаем модуль чата
const chat = require('../utils/chat');

// Главное меню
function buildMainMenu(webappUrl, userId) {
  const rows = [
    ['🛍 Ассортимент', '🛒 Корзина'],
    ['👥 Менеджеры', '⭐ Отзывы']
  ];
  if (webappUrl) {
    const urlWithUserId = userId ? `${webappUrl}?userId=${userId}` : webappUrl;
    rows.push([{ text: '🛒 Открыть магазин', web_app: { url: urlWithUserId } }]);
  }
  return { reply_markup: { keyboard: rows, resize_keyboard: true } };
}

function buildAdminMenu(webappUrl, userId) {
  const rows = [
    ['🛍 Ассортимент', '🛒 Корзина'],
    ['👥 Менеджеры', '⭐ Отзывы'],
    ['⚙️ Админ-панель']
  ];
  if (webappUrl) {
    // Добавляем userId в URL для правильной идентификации
    const urlWithUserId = userId ? `${webappUrl}?userId=${userId}` : webappUrl;
    rows.push([{ text: '🛒 Открыть магазин', web_app: { url: urlWithUserId } }]);
  }
  return { reply_markup: { keyboard: rows, resize_keyboard: true } };
}

// Стартовая команда
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const firstName = msg.from.first_name || 'друг';
  const isAdminUser = isAdmin(userId);

  // Проверка подписки
  if (!(await isSubscribed(userId))) {
    sendSubscribeMessage(chatId);
    return;
  }
  
  // Создаём меню с userId
  const mainMenu  = buildMainMenu(WEBAPP_URL, userId);
  const adminMenu = buildAdminMenu(WEBAPP_URL, userId);
  
  const welcomeText = 
    `Привет, ${firstName}! 👋\n\n` +
    `Добро пожаловать в PuffNow_63! 🏪\n\n` +
    `💨 У нас большой ассортимент вейп-продукции:\n` +
    `• Одноразки/подики\n` +
    `• Жидкости\n` +
    `• Расходники\n` +
    `• Энергетики\n\n` +
    `Выберите действие из меню ниже:`;

  bot.sendPhoto(chatId, 'AgACAgIAAxkBAAIBbGpsZeQTcBF6z6O3yS6CO_2eq75mAALvHWsbFE5hS_nvyP8d07FrAQADAgADeQADPQQ', {
    caption: welcomeText,
    ...(isAdminUser ? adminMenu : mainMenu)
  });
});

// Команда отмены чата с поддержкой
bot.onText(/\/cancel/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const isAdminUser = isAdmin(userId);
  const mainMenuObj = buildMainMenu(WEBAPP_URL, userId);
  const adminMenuObj = buildAdminMenu(WEBAPP_URL, userId);

  // Отмена добавления товара
  if (addProductState[userId]) {
    delete addProductState[userId];
    bot.sendMessage(chatId, '❌ Добавление товара отменено', adminMenuObj);
    return;
  }

  if (chat.isAdminInReplyMode(userId)) {
    chat.clearAdminReplyMode(userId);
    bot.sendMessage(chatId, '❌ Режим ответа отменён', isAdminUser ? adminMenuObj : mainMenuObj);
  } else if (chat.isChatOpen(userId)) {
    chat.closeChat(userId);
    bot.sendMessage(chatId, '❌ Чат с поддержкой закрыт', mainMenuObj);
  } else {
    bot.sendMessage(chatId, 'ℹ️ Нет активного чата для отмены', isAdminUser ? adminMenuObj : mainMenuObj);
  }
});

// Команда для админов - список активных чатов
bot.onText(/\/chats/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!isAdmin(userId)) {
    bot.sendMessage(chatId, '❌ Эта команда доступна только администраторам');
    return;
  }
  
  const activeChats = chat.getAllActiveChats();
  const adminMenuObj = buildAdminMenu(WEBAPP_URL, userId);
  
  if (activeChats.length === 0) {
    bot.sendMessage(chatId, '📭 Нет активных чатов с пользователями', adminMenuObj);
    return;
  }
  
  let message = `💬 *Активные чаты: ${activeChats.length}*\n\n`;
  
  activeChats.forEach((c, index) => {
    const startTime = new Date(c.startedAt).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
    message += `${index + 1}. ${c.firstName} (@${c.username || 'нет'})\n`;
    message += `   📝 ID: \`${c.userId}\`\n`;
    message += `   🕐 Начат: ${startTime}\n`;
    message += `   💬 Сообщений: ${c.messages.length}\n\n`;
  });
  
  const keyboard = activeChats.slice(0, 10).map(c => [{
    text: `💬 ${c.firstName}`,
    callback_data: `reply_${c.userId}`
  }]);
  
  bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: keyboard
    }
  });
});

// Команда для админов - добавить жидкость
bot.onText(/\/add_liquid/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!isAdmin(userId)) {
    bot.sendMessage(chatId, '❌ Эта команда доступна только администраторам');
    return;
  }
  
  // Инициализируем состояние
  addProductState[userId] = {
    step: 'name',
    data: {
      categoryId: 'liquids',
      icon: '💧',
      stock: 50
    }
  };
  
  bot.sendMessage(chatId, 
    '📝 *Добавление жидкости*\n\n' +
    'Введите название жидкости (например: "Annima Love Gold Edition 80мг")\n\n' +
    'Для отмены используйте /cancel',
    { parse_mode: 'Markdown' }
  );
});

// Команда для админов - добавить вкусы к существующей жидкости
bot.onText(/\/add_flavors/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!isAdmin(userId)) {
    bot.sendMessage(chatId, '❌ Эта команда доступна только администраторам');
    return;
  }
  
  // Получаем список жидкостей из загруженных данных (из Redis)
  const liquids = products.filter(p => p.categoryId === 'liquids');
  
  if (liquids.length === 0) {
    bot.sendMessage(chatId, '❌ Нет жидкостей в каталоге');
    return;
  }
  
  // Показываем список жидкостей для выбора
  const keyboard = liquids.slice(0, 20).map(liquid => [{
    text: liquid.name,
    callback_data: `addflavor_${liquid.id}`
  }]);
  
  bot.sendMessage(chatId,
    '💧 *Выберите жидкость для добавления вкусов:*',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: keyboard
      }
    }
  );
});

// Команда для получения file_id фото
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const photo = msg.photo[msg.photo.length - 1];

  // Если админ добавляет фото для нового товара
  if (addProductState[userId] && addProductState[userId].step === 'image') {
    const state = addProductState[userId];
    state.data.image = photo.file_id;
    state.data.location = 'Все точки';

    // Сохраняем товар
    const result = addProduct(state.data);
    
    delete addProductState[userId];

    if (result.success) {
      const summary = 
        `✅ *Товар успешно добавлен!*\n\n` +
        `📦 Название: ${state.data.name}\n` +
        `💰 Цена: ${formatPrice(state.data.price)}\n` +
        `🎨 Вкусов: ${state.data.flavors.length}\n` +
        `🆔 ID: \`${result.product.id}\``;

      bot.sendMessage(chatId, summary, {
        parse_mode: 'Markdown',
        ...buildAdminMenu(WEBAPP_URL, userId)
      });
    } else {
      bot.sendMessage(chatId, `❌ Ошибка сохранения: ${result.error}`, buildAdminMenu(WEBAPP_URL, userId));
    }
    return;
  }

  // Если админ добавляет фото для нового устройства
  if (addProductState[userId] && addProductState[userId].step === 'device_image') {
    const state = addProductState[userId];
    state.data.image = photo.file_id;
    state.data.location = 'Нет данных';

    // Сохраняем устройство
    products.push(state.data);
    if (redis) {
      try {
        await redis.set('products', JSON.stringify({ products, categories }));
        console.log('✅ Устройство с фото сохранено в Redis');
      } catch (e) {
        console.error('❌ Ошибка Redis:', e);
      }
    }

    const summary = `✅ *Устройство добавлено с фото!*\n\n📱 ${state.data.name}\n💰 ${formatPrice(state.data.price)}\n🆔 ID: \`${state.data.id}\``;
    delete addProductState[userId];
    bot.sendMessage(chatId, summary, { parse_mode: 'Markdown', ...buildAdminMenu(WEBAPP_URL, userId) });
    return;
  }

  // Если админ добавляет фото для товара в Расходники
  if (addProductState[userId] && addProductState[userId].step === 'acc_image') {
    const state = addProductState[userId];
    state.data.image = photo.file_id;
    state.data.location = 'Все точки';

    // Сохраняем товар
    products.push(state.data);
    if (redis) {
      try {
        await redis.set('products', JSON.stringify({ products, categories }));
        console.log('✅ Товар (accessories) с фото сохранен в Redis');
      } catch (e) {
        console.error('❌ Ошибка Redis:', e);
      }
    }

    const summary = `✅ *Товар добавлен с фото!*\n\n📍 ${state.data.name}\n💰 ${formatPrice(state.data.price)}\n🎨 Вариантов: ${state.data.flavors.length}\n🆔 ID: \`${state.data.id}\``;
    delete addProductState[userId];
    bot.sendMessage(chatId, summary, { parse_mode: 'Markdown', ...buildAdminMenu(WEBAPP_URL, userId) });
    return;
  }

  // Если админ добавляет фото для линейки (subproduct)
  if (addProductState[userId] && addProductState[userId].step === 'sub_image') {
    const state = addProductState[userId];
    state.data.image = photo.file_id;

    // Добавляем линейку в массив продуктов
    products.push(state.data);

    // Добавляем ID линейки в subProducts родителя
    const parentProduct = products.find(p => p.id === state.data.parentId);
    if (parentProduct) {
      if (!parentProduct.subProducts) {
        parentProduct.subProducts = [];
      }
      parentProduct.subProducts.push(state.data.id);
    }

    // Сохраняем в Redis
    if (redis) {
      try {
        await redis.set('products', JSON.stringify({ products, categories }));
        console.log('✅ Линейка с фото сохранена в Redis');
      } catch (e) {
        console.error('❌ Ошибка Redis:', e);
      }
    }

    const summary = `✅ *Линейка добавлена с фото!*\n\n📍 ${state.data.name}\n💰 ${formatPrice(state.data.price)}\n🎨 Вариантов: ${state.data.flavors.length}\n🆔 ID: \`${state.data.id}\``;
    delete addProductState[userId];
    bot.sendMessage(chatId, summary, { parse_mode: 'Markdown', ...buildAdminMenu(WEBAPP_URL, userId) });
    return;
  }

  // Если админ добавляет фото для жидкости
  if (addProductState[userId] && addProductState[userId].step === 'liquid_image') {
    const state = addProductState[userId];
    state.data.image = photo.file_id;

    // Сохраняем жидкость
    products.push(state.data);
    if (redis) {
      try {
        await redis.set('products', JSON.stringify({ products, categories }));
        console.log('✅ Жидкость с фото сохранена в Redis');
      } catch (e) {
        console.error('❌ Ошибка Redis:', e);
      }
    }

    const summary = `✅ *Жидкость добавлена с фото!*\n\n💧 ${state.data.name}\n💰 ${formatPrice(state.data.price)}\n🎨 Вариантов: ${state.data.flavors.length}\n🆔 ID: \`${state.data.id}\``;
    delete addProductState[userId];
    bot.sendMessage(chatId, summary, { parse_mode: 'Markdown', ...buildAdminMenu(WEBAPP_URL, userId) });
    return;
  }

  // Если пользователь в шаге отправки фото для отзыва
  if (reviewState[userId] && reviewState[userId].step === 'photo') {
    const state = reviewState[userId];
    const firstName = msg.from.first_name || 'Покупатель';
    const reviewId = `r${Date.now()}`;

    saveReview({
      id: reviewId,
      userId,
      firstName,
      username: msg.from.username || null,
      rating: state.rating,
      text: state.text || null,
      photoFileId: photo.file_id,
      orderId: state.orderId || null,
      date: new Date().toISOString()
    });
    delete reviewState[userId];

    bot.sendMessage(chatId,
      `✅ Спасибо за отзыв, ${firstName}! Ваше мнение очень важно для нас 🙏`,
      buildMainMenu(WEBAPP_URL, userId)
    );

    // Уведомляем админов с фото
    const stars = '⭐'.repeat(state.rating);
    const caption =
      `${stars} *Новый отзыв от ${firstName}*${msg.from.username ? ` (@${msg.from.username})` : ''}` +
      (state.text ? `\n\n_${state.text}_` : '');
    adminIds.forEach(id => {
      bot.sendPhoto(id, photo.file_id, {
        caption,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '🗑 Удалить', callback_data: `review_delete_${reviewId}` }]]
        }
      }).catch(() => {});
    });
    return;
  }

  // Дефолтное поведение — показываем file_id (для разработчика)
  bot.sendMessage(chatId,
    `✅ Фото получено!\n\nFile ID:\n\`${photo.file_id}\`\n\nСкопируйте этот ID и отправьте разработчику`,
    { parse_mode: 'Markdown' }
  );
});

// Обработка документов (если фото отправлено как документ)
bot.on('document', (msg) => {
  const chatId = msg.chat.id;
  if (msg.document.mime_type && msg.document.mime_type.startsWith('image/')) {
    bot.sendMessage(chatId, 
      `✅ Изображение получено!\n\n` +
      `File ID:\n\`${msg.document.file_id}\`\n\n` +
      `Скопируйте этот ID и отправьте разработчику`,
      { parse_mode: 'Markdown' }
    );
  }
});

// Обработка текстовых сообщений
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const userId = msg.from.id;

  if (!text || text.startsWith('/')) return;

  // Проверка подписки
  if (!(await isSubscribed(userId))) {
    sendSubscribeMessage(chatId);
    return;
  }

  // ========== ОБРАБОТКА ДОБАВЛЕНИЯ ТОВАРА (для админов) ==========
  if (addProductState[userId]) {
    const state = addProductState[userId];
    const adminMenuObj = buildAdminMenu(WEBAPP_URL, userId);

    // Если пользователь нажал кнопку меню — сбрасываем режим добавления
    const menuButtons = ['🛍️ Ассортимент', '🛒 Корзина', '📞 Поддержка', '⚪ Главное меню', '⚙️ Админ-панель'];
    if (menuButtons.some(btn => text.includes(btn.split(' ').slice(1).join(' ')))) {
      delete addProductState[userId];
      // state cleared, fall through to normal switch handler
    }

    // Добавление вкусов к существующей жидкости
    if (state.step === 'add_flavors') {
      // Перезагружаем товары из Redis чтобы получить актуальные данные
      await loadProductsFromRedis();
      
      const product = products.find(p => p.id === state.productId);
      if (!product) {
        bot.sendMessage(chatId, '❌ Товар не найден', adminMenuObj);
        delete addProductState[userId];
        return;
      }
      
      const newFlavors = text.split(',').map(f => f.trim()).filter(f => f.length > 0);
      
      if (newFlavors.length === 0) {
        bot.sendMessage(chatId, '❌ Укажите хотя бы один вкус');
        return;
      }
      
      // Добавляем новые вкусы к существующим
      const currentFlavors = product.flavors || [];
      const updatedFlavors = [
        ...currentFlavors,
        ...newFlavors.map(name => ({ name, stock: '', enabled: true }))
      ];
      
      // Обновляем товар в глобальном массиве
      const productIndex = products.findIndex(p => p.id === state.productId);
      if (productIndex !== -1) {
        products[productIndex].flavors = updatedFlavors;
      }
      
      // Сохраняем в Redis
      if (redis) {
        try {
          await redis.set('products', JSON.stringify(products));
          console.log('✅ Товары обновлены в Redis');
        } catch (e) {
          console.error('❌ Ошибка сохранения в Redis:', e);
        }
      }
      
      // Также сохраняем через productManager (для fallback в файл)
      const { updateProduct } = require('../utils/productManager');
      updateProduct(state.productId, { flavors: updatedFlavors });
      
      delete addProductState[userId];
      
      bot.sendMessage(chatId,
        `✅ *Вкусы добавлены!*\n\n` +
        `💧 Жидкость: ${state.productName}\n` +
        `🎨 Добавлено вкусов: ${newFlavors.length}\n` +
        `📊 Всего вкусов: ${updatedFlavors.length}`,
        {
          parse_mode: 'Markdown',
          ...adminMenuObj
        }
      );
      return;
    }

    if (state.step === 'name') {
      state.data.name = text;
      state.step = 'price';
      bot.sendMessage(chatId, 
        `✅ Название: *${text}*\n\n` +
        `Теперь введите цену в рублях (например: 450)`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (state.step === 'price') {
      const price = parseInt(text);
      if (isNaN(price) || price <= 0) {
        bot.sendMessage(chatId, '❌ Неверный формат цены. Введите число (например: 450)');
        return;
      }
      state.data.price = price;
      state.data.cashPrice = price;
      state.step = 'description';
      bot.sendMessage(chatId,
        `✅ Цена: ${formatPrice(price)}\n\n` +
        `Введите описание (например: "Крепкая солевая жидкость\\nНикотин: 80мг\\nОбъём: 30мл")`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (state.step === 'description') {
      state.data.description = text;
      state.step = 'flavors';
      bot.sendMessage(chatId,
        `✅ Описание сохранено\n\n` +
        `Теперь введите вкусы через запятую (например: "Арбуз лед, Манго, Клубника")`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (state.step === 'flavors') {
      const flavors = text.split(',').map(f => f.trim()).filter(f => f.length > 0);
      
      if (flavors.length === 0) {
        bot.sendMessage(chatId, '❌ Укажите хотя бы один вкус');
        return;
      }

      state.data.flavors = flavors.map(name => ({ name, stock: '', enabled: true }));
      state.step = 'image';

      bot.sendMessage(chatId,
        `✅ Добавлено вкусов: ${flavors.length}\n\n` +
        `Теперь отправьте фото товара или нажмите "Пропустить"`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '➡️ Пропустить фото', callback_data: 'skip_product_image' }
            ]]
          }
        }
      );
      return;
    }

    // Добавление нового устройства (одноразки/пода)
    if (state.step === 'device_name') {
      state.data.name = text;
      state.step = 'device_price';
      bot.sendMessage(chatId, 'Введите цену (например: 2500)');
      return;
    }

    if (state.step === 'device_price') {
      const price = parseInt(text);
      if (isNaN(price) || price <= 0) {
        bot.sendMessage(chatId, '✔️ Неверный формат цены');
        return;
      }
      state.data.price = price;
      state.data.cashPrice = price;
      state.data.description = ''; // Описание убрано
      state.step = 'device_type';
      bot.sendMessage(chatId, `✅ Цена: ${formatPrice(price)}\n\nВыберите тип:`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔋 Под', callback_data: 'device_type_pod' }],
            [{ text: '💨 Одноразка', callback_data: 'device_type_disposable' }]
          ]
        }
      });
      return;
    }

    if (state.step === 'device_variants') {
      const variants = text.split('\n').map(v => v.trim()).filter(v => v.length > 0);
      if (variants.length === 0) {
        bot.sendMessage(chatId, '✔️ Укажите хотя бы один вариант');
        return;
      }
      if (state.variantType === 'colors') {
        state.data.colors = variants.map(name => ({ name, enabled: true }));
      } else {
        state.data.flavors = variants.map(name => ({ name, stock: '', enabled: true }));
      }
      const baseId = state.data.name.toLowerCase().replace(/[^a-z0-9\s]/gi, '').trim().replace(/\s+/g, '_').substring(0, 20);
      state.data.id = products.find(p => p.id === baseId) ? `${baseId}_${Date.now().toString(36)}` : baseId;
      state.data.stock = 50;
      state.data.enabled = true;
      
      // Переходим к добавлению фото
      state.step = 'device_image';
      bot.sendMessage(chatId,
        `✅ Добавлено вариантов: ${variants.length}\n\nТеперь отправьте фото устройства или нажмите "Пропустить"`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '➡️ Пропустить фото', callback_data: 'skip_device_image' }
            ]]
          }
        }
      );
      return;
    }

    // Добавление дочерней линейки (например, новая линейка шайб)
    if (state.step === 'sub_name') {
      state.data.name = text;
      state.data.description = ''; // Описание убрано
      state.step = 'sub_flavors';
      bot.sendMessage(chatId, 'Введите варианты/вкусы (каждый с новой строки):\n\nНапример:\nCRANBERRY TEA\nDOUBLE MINT\nENERGY MANGO');
      return;
    }

    if (state.step === 'sub_flavors') {
      const flavors = text.split('\n').map(v => v.trim()).filter(v => v.length > 0);
      if (flavors.length === 0) {
        bot.sendMessage(chatId, '❌ Укажите хотя бы один вариант');
        return;
      }
      state.data.flavors = flavors.map(name => ({ name, stock: '', enabled: true }));
      const baseId = state.data.name.toLowerCase().replace(/[^a-z0-9\s]/gi, '').trim().replace(/\s+/g, '_').substring(0, 20);
      state.data.id = products.find(p => p.id === baseId) ? `${baseId}_${Date.now().toString(36)}` : baseId;
      state.data.stock = 50;
      state.data.enabled = true;
      
      // Переходим к фото
      state.step = 'sub_image';
      bot.sendMessage(chatId,
        `✅ Добавлено вариантов: ${flavors.length}\n\nОтправьте фото линейки или нажмите "Пропустить"`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '➡️ Пропустить фото', callback_data: 'skip_sub_image' }
            ]]
          }
        }
      );
      return;
    }

    // Добавление товара в Расходники (accessories)
    if (state.step === 'acc_name') {
      state.data.name = text;
      state.data.description = ''; // Описание убрано
      state.step = 'acc_price';
      bot.sendMessage(chatId, 'Введите цену (в рублях, например: 150):');
      return;
    }

    if (state.step === 'acc_price') {
      const price = parseFloat(text);
      if (isNaN(price) || price <= 0) {
        bot.sendMessage(chatId, '❌ Неверная цена. Введите число больше 0');
        return;
      }
      state.data.price = price;
      state.data.cashPrice = Math.round(price * 0.9);
      state.step = 'acc_flavors';
      bot.sendMessage(chatId, 'Введите варианты/вкусы (каждый с новой строки):\n\nНапример:\nCRANBERRY TEA\nDOUBLE MINT\nENERGY MANGO');
      return;
    }

    if (state.step === 'acc_flavors') {
      const flavors = text.split('\n').map(v => v.trim()).filter(v => v.length > 0);
      if (flavors.length === 0) {
        bot.sendMessage(chatId, '❌ Укажите хотя бы один вариант');
        return;
      }
      state.data.flavors = flavors.map(name => ({ name, stock: '', enabled: true }));
      const baseId = state.data.name.toLowerCase().replace(/[^a-z0-9\s]/gi, '').trim().replace(/\s+/g, '_').substring(0, 20);
      state.data.id = products.find(p => p.id === baseId) ? `${baseId}_${Date.now().toString(36)}` : baseId;
      state.data.stock = 50;
      state.data.enabled = true;
      
      // Переходим к фото
      state.step = 'acc_image';
      bot.sendMessage(chatId,
        `✅ Добавлено вариантов: ${flavors.length}\n\nОтправьте фото товара или нажмите "Пропустить"`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '➡️ Пропустить фото', callback_data: 'skip_acc_image' }
            ]]
          }
        }
      );
      return;
    }

    // Добавление жидкости (liquids)
    if (state.step === 'liquid_name') {
      state.data.name = text;
      state.data.description = ''; // Описание убрано
      state.step = 'liquid_price';
      bot.sendMessage(chatId, 'Введите цену (в рублях, например: 450):');
      return;
    }

    if (state.step === 'liquid_price') {
      const price = parseFloat(text);
      if (isNaN(price) || price <= 0) {
        bot.sendMessage(chatId, '❌ Неверная цена. Введите число больше 0');
        return;
      }
      state.data.price = price;
      state.data.cashPrice = Math.round(price * 0.9);
      state.step = 'liquid_flavors';
      bot.sendMessage(chatId, 'Введите вкусы (каждый с новой строки):\n\nНапример:\nАрбуз лед\nКлубника\nДыня');
      return;
    }

    if (state.step === 'liquid_flavors') {
      const flavors = text.split('\n').map(v => v.trim()).filter(v => v.length > 0);
      if (flavors.length === 0) {
        bot.sendMessage(chatId, '❌ Укажите хотя бы один вариант');
        return;
      }
      state.data.flavors = flavors.map(name => ({ name, stock: '', enabled: true }));
      const baseId = state.data.name.toLowerCase().replace(/[^a-z0-9\s]/gi, '').trim().replace(/\s+/g, '_').substring(0, 20);
      state.data.id = products.find(p => p.id === baseId) ? `${baseId}_${Date.now().toString(36)}` : baseId;
      state.data.stock = 50;
      state.data.enabled = true;
      state.data.location = 'Все точки';
      
      // Переходим к фото
      state.step = 'liquid_image';
      bot.sendMessage(chatId,
        `✅ Добавлено вариантов: ${flavors.length}\n\nОтправьте фото жидкости или нажмите "Пропустить"`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '➡️ Пропустить фото', callback_data: 'skip_liquid_image' }
            ]]
          }
        }
      );
      return;
    }
  }

  // Если АДМИН в режиме ответа — пересылаем его сообщение пользователю
  if (isAdmin(userId) && chat.isAdminInReplyMode(userId)) {
    const targetUserId = chat.getAdminReplyTarget(userId);
    const targetChat = chat.getChat(targetUserId);
    if (targetChat) {
      bot.sendMessage(targetChat.chatId,
        `👨‍💼 *Менеджер:*\n${text}`,
        {
          parse_mode: 'Markdown',
          reply_markup: { remove_keyboard: true }
        }
      ).catch(() => {});
      
      // Сохраняем в историю
      chat.addMessage(targetUserId, false, text);
      
      const adminMenuForSender = buildAdminMenu(WEBAPP_URL, userId);
      bot.sendMessage(chatId, `✅ Сообщение отправлено пользователю ${targetChat.firstName}`,
        {
          reply_markup: adminMenuForSender.reply_markup
        }
      );
    }
    chat.clearAdminReplyMode(userId);
    return;
  }

  // Если ПОЛЬЗОВАТЕЛЬ в режиме поддержки — пересылаем его сообщение всем админам
  if (chat.isChatOpen(userId) && !isAdmin(userId)) {
    const userChat = chat.getChat(userId);
    
    // Сохраняем в историю
    chat.addMessage(userId, true, text);
    
    adminIds.forEach(adminId => {
      bot.sendMessage(adminId,
        `💬 *${userChat.firstName}* (@${userChat.username || 'нет'})\n📝 ID: \`${userId}\`\n\n${text}`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '✍️ Ответить', callback_data: `reply_${userId}` },
              { text: '📜 История', callback_data: `history_${userId}` }
            ]]
          }
        }
      ).catch(() => {});
    });
    bot.sendMessage(chatId, '✅ Сообщение отправлено менеджеру');
    return;
  }

  // Если пользователь вводит текст отзыва
  if (reviewState[userId] && reviewState[userId].step === 'text') {
    const state = reviewState[userId];
    const firstName = msg.from.first_name || 'Покупатель';

    // Сохраняем текст и переходим к шагу фото
    reviewState[userId].text = text.slice(0, 500);
    reviewState[userId].step = 'photo';

    bot.sendMessage(chatId,
      `📸 Хотите прикрепить фото к отзыву?\n\nОтправьте картинку или нажмите «Пропустить»`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '➡️ Пропустить', callback_data: 'review_skip_photo' },
            { text: '❌ Отмена',     callback_data: 'review_cancel' }
          ]]
        }
      }
    );
    return;
  }

  switch (text) {
    case '🛍 Ассортимент':
      showAssortment(chatId);
      break;
    case '🛒 Корзина':
      showCart(chatId);
      break;
    case '👥 Менеджеры':
      showManagers(chatId);
      break;
    case '⭐ Отзывы':
      showReviews(chatId, userId);
      break;
    case '⚙️ Админ-панель':
      if (isAdmin(userId)) {
        showAdminPanel(chatId);
      }
      break;
    case '❌ Закрыть чат с поддержкой':
      if (chat.isChatOpen(userId)) {
        chat.closeChat(userId);
        const mainMenuObj = buildMainMenu(WEBAPP_URL, userId);
        bot.sendMessage(chatId, '✅ Чат с поддержкой закрыт', mainMenuObj);
      }
      break;
  }
});

// Показать ассортимент (все товары списком)
function showAssortment(chatId, messageId = null) {
  const keyboard = {
    inline_keyboard: [
      [{ text: '❤️‍🔥 Одноразки/подики', callback_data: 'cat_disposable' }],
      [{ text: '💧 Жидкости', callback_data: 'cat_liquids' }],
      [{ text: '📍 Расходники', callback_data: 'cat_accessories' }],
      [{ text: '🧃 Энергетики', callback_data: 'cat_energy' }]
    ]
  };

  if (messageId) {
    bot.editMessageText('📦 *Выберите категорию:*', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: keyboard
    }).catch(() => {
      // Если было фото — удаляем и отправляем текст
      bot.deleteMessage(chatId, messageId).catch(() => {});
      bot.sendMessage(chatId, '📦 *Выберите категорию:*', {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    });
  } else {
    bot.sendMessage(chatId, '📦 *Выберите категорию:*', {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  }
}

// Показать товары категории (простой список кнопок)
function showCategoryProducts(chatId, categoryId, messageId = null) {
  const category = categories.find(c => c.id === categoryId);
  // Исключаем дочерние продукты (с parentId) из списка категории
  const categoryProducts = products.filter(p => p.categoryId === categoryId && !p.parentId);

  if (categoryProducts.length === 0) {
    const keyboard = [[{ text: '« К категориям', callback_data: 'back_categories' }]];
    
    if (messageId) {
      bot.editMessageText('🤷‍♂️ В этой категории пока нет товаров', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: keyboard }
      }).catch(() => {
        bot.deleteMessage(chatId, messageId).catch(() => {});
        bot.sendMessage(chatId, '🤷‍♂️ В этой категории пока нет товаров', {
          reply_markup: { inline_keyboard: keyboard }
        });
      });
    } else {
      bot.sendMessage(chatId, '🤷‍♂️ В этой категории пока нет товаров', {
        reply_markup: { inline_keyboard: keyboard }
      });
    }
    return;
  }

  const keyboard = [];
  
  categoryProducts.forEach(product => {
    keyboard.push([{ 
      text: `${product.name} - ${formatPrice(product.price)}`.toUpperCase(), 
      callback_data: `view_${product.id}` 
    }]);
  });
  
  keyboard.push([{ text: '« К категориям', callback_data: 'back_categories' }]);

  const text = `*Товары категории ${category.name}:*`;

  if (messageId) {
    // Пробуем editMessageText (если было текстовое сообщение)
    bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    }).catch(() => {
      // Если было фото — удаляем и отправляем текст
      bot.deleteMessage(chatId, messageId).catch(() => {});
      bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
    });
  } else {
    bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
  }
}

// Показать детальную карточку товара
function showProductDetail(chatId, productId, messageId = null, userId = null) {
  const product = products.find(p => p.id === productId);
  
  if (!product) {
    bot.answerCallbackQuery(chatId, { text: '❌ Товар не найден' });
    return;
  }

  // Если это родительский товар — показываем кнопки дочерних линеек
  if (product.isParent && product.subProducts) {
    const subItems = product.subProducts.map(id => products.find(p => p.id === id)).filter(Boolean);
    
    const keyboard = [];
    subItems.forEach(sub => {
      keyboard.push([{ text: sub.name, callback_data: `view_${sub.id}` }]);
    });
    
    // Для админов добавляем кнопку добавления новой линейки
    if (userId && isAdmin(userId)) {
      keyboard.push([{ text: '➕ Добавить линейку', callback_data: `add_subproduct_${product.id}` }]);
    }
    
    keyboard.push([
      { text: '⬅️ Назад', callback_data: `cat_${product.categoryId}` }
    ]);

    const caption = `*${product.name.toUpperCase()}*\n\nВыберите линейку:`;
    
    // Проверяем что image это file_id, а не URL
    const isTelegramFileId = product.image && !product.image.startsWith('http');

    if (isTelegramFileId && messageId) {
      bot.editMessageMedia({
        type: 'photo',
        media: product.image,
        caption: caption,
        parse_mode: 'Markdown'
      }, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: keyboard }
      }).catch(() => {
        bot.deleteMessage(chatId, messageId).catch(() => {});
        bot.sendPhoto(chatId, product.image, {
          caption: caption,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: keyboard }
        });
      });
    } else if (isTelegramFileId) {
      bot.sendPhoto(chatId, product.image, {
        caption: caption,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
    } else {
      // Без фото - только текст
      if (messageId) {
        bot.editMessageText(caption, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: keyboard }
        }).catch(() => {
          bot.deleteMessage(chatId, messageId).catch(() => {});
          bot.sendMessage(chatId, caption, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
          });
        });
      } else {
        bot.sendMessage(chatId, caption, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: keyboard }
        });
      }
    }
    return;
  }

  let caption = `*${product.name.toUpperCase()}*\n\n`;

  // Если есть вкусы с количеством
  if (product.flavors && product.flavors.length > 0) {
    const enabledFlavors = product.flavors.filter(f => {
      if (typeof f === 'object') {
        // Если enabled не определен или true - включен
        return f.enabled === undefined || f.enabled === true;
      }
      return true;
    });

    enabledFlavors.forEach((flavor, index) => {
      const flavorText = typeof flavor === 'string' ? flavor : flavor.name;
      const flavorStock = typeof flavor === 'object' ? flavor.stock : '';
      
      caption += `┃ ${flavorText}${flavorStock ? ` — ${flavorStock}` : ''}\n`;
    });
  }
  // Если есть цвета
  else if (product.colors && product.colors.length > 0) {
    const enabledColors = product.colors.filter(c =>
      typeof c === 'string' || c.enabled === undefined || c.enabled === true
    );
    enabledColors.forEach((color) => {
      const colorName = typeof color === 'object' ? color.name : color;
      caption += `┃ ${colorName}\n`;
    });
  }
  // Если есть опции
  else if (product.options && product.options.length > 0) {
    product.options.forEach((option) => {
      const optionData = typeof option === 'object' ? option : { name: option, enabled: true };
      const isEnabled = optionData.enabled === undefined || optionData.enabled === true;
      if (isEnabled) {
        const name = typeof option === 'object' ? option.name : option;
        caption += `┃ ${name}\n`;
      }
    });
  }

  caption += `\n`;
  
  // Цены - используем price, а не cashPrice
  const price = product.price;
  
  caption += `Цена: ${formatPrice(price)}`;

  const keyboard = [];

  // Кнопка добавить в корзину
  keyboard.push([{ 
    text: '🛒 Добавить в корзину', 
    callback_data: `add_${product.id}` 
  }]);

  keyboard.push([
    { text: '⬅️ Назад', callback_data: product.parentId ? `view_${product.parentId}` : `cat_${product.categoryId}` }
  ]);

  // Если есть изображение - отправляем/редактируем фото
  // ВАЖНО: Telegram bot API может работать только с file_id, не с внешними URL
  // Поэтому проверяем что image это file_id (начинается с букв), а не URL
  const isTelegramFileId = product.image && !product.image.startsWith('http');
  
  if (isTelegramFileId) {
    if (messageId) {
      // Пытаемся редактировать существующее сообщение с фото
      bot.editMessageMedia({
        type: 'photo',
        media: product.image,
        caption: caption,
        parse_mode: 'Markdown'
      }, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: keyboard }
      }).catch((err) => {
        // Если не получилось отредактировать (было текстовое сообщение) - удаляем и отправляем новое
        bot.deleteMessage(chatId, messageId).catch(() => {});
        bot.sendPhoto(chatId, product.image, {
          caption: caption,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: keyboard }
        });
      });
    } else {
      // Отправляем новое фото
      bot.sendPhoto(chatId, product.image, {
        caption: caption,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      }).catch((err) => {
        // Если не удалось отправить фото - отправляем текст
        bot.sendMessage(chatId, caption, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: keyboard }
        });
      });
    }
  } else {
    // Без фото
    if (messageId) {
      // Пробуем editMessageText (если было текстовое сообщение)
      bot.editMessageText(caption, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      }).catch(() => {
        // Было фото — отправляем новое текстовое, потом удаляем старое
        bot.sendMessage(chatId, caption, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: keyboard }
        }).then(() => {
          bot.deleteMessage(chatId, messageId).catch(() => {});
        }).catch(() => {});
      });
    } else {
      bot.sendMessage(chatId, caption, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
    }
  }
}

// Показать корзину
function showCart(chatId) {
  const cart = userCarts[chatId] || [];

  if (cart.length === 0) {
    bot.sendMessage(chatId, '🛒 Ваша корзина пуста', {
      reply_markup: {
        inline_keyboard: [[{ text: '🛍 Перейти в каталог', callback_data: 'categories' }]]
      }
    });
    return;
  }

  let total = 0;
  let message = '🛒 *Ваша корзина:*\n\n';

  cart.forEach((item, index) => {
    const product = products.find(p => p.id === item.productId);
    if (!product) return;
    
    const itemTotal = product.price * item.quantity;
    total += itemTotal;

    message += `${index + 1}. ${product.icon} ${product.name}`;
    if (item.flavor) {
      message += `\n   🎨 ${item.flavor}`;
    }
    message += `\n   ${item.quantity} × ${formatPrice(product.price)} = ${formatPrice(itemTotal)}\n\n`;
  });

  message += `💰 *Итого: ${formatPrice(total)}*`;

  const keyboard = [
    [{ text: '✅ Оформить заказ', callback_data: 'checkout' }],
    [{ text: '🗑 Очистить корзину', callback_data: 'clear_cart' }],
    [{ text: '🛍 Продолжить покупки', callback_data: 'back_categories' }]
  ];

  bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

// Добавить товар в корзину (без вкуса)
function addToCart(queryId, chatId, productId) {
  if (!userCarts[chatId]) {
    userCarts[chatId] = [];
  }

  const product = products.find(p => p.id === productId);
  if (!product || product.stock === 0) {
    bot.answerCallbackQuery(queryId, { text: '❌ Товар недоступен' });
    return;
  }

  const existingItem = userCarts[chatId].find(item => item.productId === productId && !item.flavor);
  if (existingItem) {
    existingItem.quantity++;
  } else {
    userCarts[chatId].push({ productId, quantity: 1, flavor: null });
  }

  bot.answerCallbackQuery(queryId, { 
    text: `✅ ${product.name} добавлен в корзину!`,
    show_alert: false
  });
}

// Показать меню выбора вкуса/цвета/опции
function showFlavorSelection(chatId, productId, messageId, selectedFlavors = []) {
  const product = products.find(p => p.id === productId);
  if (!product) return;

  // Определяем тип вариантов (flavors, colors, options)
  let variants = [];
  let variantType = 'вкус';
  let variantIcon = '🎨';
  
  if (product.flavors) {
    // Фильтруем только enabled вкусы
    const enabledFlavors = product.flavors.filter(f => {
      if (typeof f === 'object') return f.enabled === undefined || f.enabled === true;
      return true;
    });
    variants = enabledFlavors.map(f => typeof f === 'object' ? f.name : f);
    variantType = 'вкус';
    variantIcon = '🎨';
  } else if (product.colors) {
    const enabledColors = product.colors.filter(c =>
      typeof c === 'string' || c.enabled === undefined || c.enabled === true
    );
    variants = enabledColors.map(c => typeof c === 'object' ? c.name : c);
    variantType = 'цвет';
    variantIcon = '🎨';
  } else if (product.options) {
    const enabledOptions = product.options.filter(o => {
      if (typeof o === 'object') return o.enabled === undefined || o.enabled === true;
      return true;
    });
    variants = enabledOptions.map(o => typeof o === 'object' ? o.name : o);
    variantType = 'вариант';
    variantIcon = '⚙️';
  }

  const keyboard = [];

  variants.forEach((variant, index) => {
    const isSelected = selectedFlavors.includes(index);
    keyboard.push([{
      text: `${isSelected ? '✅ ' : ''}${variant}`,
      callback_data: `flavorpick_${product.id}_${index}`
    }]);
  });

  // Кнопка подтвердить
  const hasSelection = selectedFlavors.length > 0;
  keyboard.push([{
    text: hasSelection ? `🛒 Подтвердить (${selectedFlavors.length} шт.)` : '🛒 Подтвердить',
    callback_data: `flavorconfirm_${product.id}`
  }]);
  keyboard.push([{ text: '❌ Отмена', callback_data: `view_${product.id}` }]);

  const selectedNames = selectedFlavors.map(i => variants[i]);

  let text = `${variantIcon} *Выберите ${variantType} для ${product.name}:*\n\n`;
  if (selectedNames.length > 0) {
    text += `Выбрано:\n${selectedNames.map(n => `✅ ${n}`).join('\n')}\n\n`;
  }
  text += `Нажмите на ${variantType} чтобы выбрать/снять выбор`;

  // Сначала пробуем editMessageText (если было текстовое сообщение)
  // Если не вышло (было фото) — удаляем и отправляем новое
  bot.editMessageText(text, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  }).catch(() => {
    // editMessageText не сработало — значит было фото, отправляем новое сообщение
    bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    }).then(newMsg => {
      // Удаляем старое фото-сообщение после отправки нового
      bot.deleteMessage(chatId, messageId).catch(() => {});
    }).catch(err => {
      console.error('showFlavorSelection sendMessage error:', err.message);
    });
  });
}

// Точки самовывоза
const PICKUP_POINTS = [
  { id: 'metro_pobedy', name: '📍 Метро Победы', address: 'Метро Победы' }
];

// Показать выбор точки самовывоза
function showPickupSelection(chatId, messageId) {
  const keyboard = [];

  PICKUP_POINTS.forEach(point => {
    keyboard.push([{
      text: `${point.name}`,
      callback_data: `pickup_${point.id}`
    }]);
  });

  keyboard.push([{ text: '❌ Отмена', callback_data: 'show_cart' }]);

  const text = `🏪 *Выберите точку самовывоза:*\n\n📍 *Метро Победы*`;

  bot.editMessageText(text, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  }).catch(() => {
    bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
  });
}

// Оформление заказа
function checkout(chatId, userId, username, firstName, pickupPoint) {
  const cart = userCarts[chatId] || [];

  if (cart.length === 0) {
    bot.sendMessage(chatId, '❌ Корзина пуста');
    return;
  }

  // Функция для экранирования Markdown спец. символов
  function escapeMarkdown(text) {
    if (!text) return '';
    return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
  }

  let total = 0;
  let orderDetails = '📦 *Новый заказ!*\n\n';

  cart.forEach((item, index) => {
    const product = products.find(p => p.id === item.productId);
    const itemTotal = product.price * item.quantity;
    total += itemTotal;

    orderDetails += `${index + 1}\\. ${escapeMarkdown(product.name)}`;
    if (item.flavor) {
      orderDetails += `\n   🎨 ${escapeMarkdown(item.flavor)}`;
    }
    orderDetails += `\n   ${item.quantity} × ${formatPrice(product.price)} = ${formatPrice(itemTotal)}\n\n`;
  });

  orderDetails += `💰 *Итого: ${formatPrice(total)}*`;

  const orderId = generateOrderId();
  const order = {
    id: orderId,
    userId,
    username: username || 'Не указан',
    firstName: firstName || 'Клиент',
    chatId,
    items: cart,
    total,
    date: new Date().toISOString(),
    status: 'pending'
  };

  saveOrder(order);

  // Уведомление клиенту (тоже используем HTML для надёжности)
  const clientOrderText = `✅ Спасибо за заказ!\n\n` +
    `Номер заказа: <b>#${orderId}</b>\n\n` +
    `📦 <b>Новый заказ!</b>\n\n` +
    cart.map((item, index) => {
      const product = products.find(p => p.id === item.productId);
      const itemTotal = product.price * item.quantity;
      let itemText = `${index + 1}. ${product.name}`;
      if (item.flavor) {
        itemText += `\n   🎨 ${item.flavor}`;
      }
      itemText += `\n   ${item.quantity} × ${formatPrice(product.price)} = ${formatPrice(itemTotal)}`;
      return itemText;
    }).join('\n\n') + '\n\n' +
    `💰 <b>Итого: ${formatPrice(total)}</b>\n\n` +
    `🏪 <b>Точка самовывоза:</b> ${pickupPoint}\n\n` +
    `💳 Оплата при получении наличными, при оплате переводом согласовывать с менеджером\n\n` +
    `Наш менеджер скоро свяжется с вами!`;

  bot.sendMessage(
    chatId,
    clientOrderText,
    { parse_mode: 'HTML' }
  );

  // Уведомление всем администраторам
  // Формируем информацию о клиенте (БЕЗ экранирования - будем использовать HTML)
  let clientInfo = `👤 Клиент: ${firstName || 'Клиент'}`;
  if (username) {
    clientInfo += ` (@${username})`;
  }
  clientInfo += `\n📝 ID: ${userId}`;
  
  // Сообщение админам - используем HTML вместо Markdown для надёжности
  const adminMessage = `📦 <b>Новый заказ!</b>\n\n` +
    cart.map((item, index) => {
      const product = products.find(p => p.id === item.productId);
      const itemTotal = product.price * item.quantity;
      let itemText = `${index + 1}. ${product.name}`;
      if (item.flavor) {
        itemText += `\n   🎨 ${item.flavor}`;
      }
      itemText += `\n   ${item.quantity} × ${formatPrice(product.price)} = ${formatPrice(itemTotal)}`;
      return itemText;
    }).join('\n\n') + '\n\n' +
    `💰 <b>Итого: ${formatPrice(total)}</b>\n\n` +
    `${clientInfo}\n` +
    `🏪 Точка самовывоза: ${pickupPoint}\n` +
    `🆔 Заказ: #${orderId}`;

  // Функция отправки с retry для каждого админа
  async function sendToAdmin(adminId, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await bot.sendMessage(
          adminId,
          adminMessage,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '✅ Подтвердить', callback_data: `confirm_${orderId}` },
                  { text: '❌ Отменить', callback_data: `cancel_${orderId}` }
                ],
                [
                  { text: '🏁 Завершить заказ', callback_data: `complete_${orderId}` }
                ],
                [
                  { text: '💬 Написать клиенту', callback_data: `contact_${userId}` }
                ]
              ]
            }
          }
        );
        console.log(`✅ Заказ ${orderId} отправлен админу ${adminId} (попытка ${attempt})`);
        return true;
      } catch (err) {
        console.error(`❌ Не удалось отправить заказ ${orderId} админу ${adminId} (попытка ${attempt}/${retries}):`, err.message);
        if (attempt < retries) {
          // Ждём перед следующей попыткой (exponential backoff)
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
      }
    }
    return false;
  }

  // Отправляем всем админам параллельно с retry
  Promise.all(adminIds.map(id => sendToAdmin(id)))
    .then(results => {
      const successCount = results.filter(r => r).length;
      console.log(`📊 Заказ ${orderId}: отправлено ${successCount}/${adminIds.length} админам`);
    })
    .catch(err => console.error('❌ Ошибка при отправке заказа админам:', err));

  // Очистить корзину
  userCarts[chatId] = [];
}

// Показать информацию о магазине
function showAbout(chatId) {
  bot.sendMessage(
    chatId,
    `🏪 *PuffNow_63*\n\n` +
    `Мы предлагаем:\n` +
    `💨 Оригинальная продукция\n` +
    `🚚 Быстрая доставка по Омску\n` +
    `💳 Оплата при получении\n` +
    `✅ Гарантия качества\n` +
    `📞 Консультация специалиста\n` +
    `🎁 Бонусы постоянным клиентам\n\n` +
    `⚠️ Помните: вейпинг вреден для здоровья!`,
    { parse_mode: 'Markdown' }
  );
}

// Показать профиль пользователя
function showProfile(chatId, userId, user) {
  const orders = getOrders().filter(o => o.userId === userId);
  const totalOrders = orders.length;
  const completedOrders = orders.filter(o => o.status === 'confirmed').length;
  
  let totalSpent = 0;
  orders.filter(o => o.status === 'confirmed').forEach(order => {
    totalSpent += order.total;
  });

  const username = user.username ? `@${user.username}` : 'не указан';
  const firstName = user.first_name || 'Пользователь';

  bot.sendMessage(
    chatId,
    `👤 *Ваш профиль*\n\n` +
    `Имя: ${firstName}\n` +
    `Username: ${username}\n` +
    `ID: \`${userId}\`\n\n` +
    `📊 *Статистика:*\n` +
    `Всего заказов: ${totalOrders}\n` +
    `Выполнено: ${completedOrders}\n` +
    `Потрачено: ${formatPrice(totalSpent)}\n\n` +
    `🛒 Ваша корзина: /cart`,
    { 
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📦 Мои заказы', callback_data: 'my_orders' }],
          [{ text: '🛒 Корзина', callback_data: 'show_cart' }]
        ]
      }
    }
  );
}

// Показать менеджеров
function showManagers(chatId) {
  bot.sendMessage(
    chatId,
    `👥 *Менеджеры*\n\n` +
    `По всем вопросам пишите нашему менеджеру:\n\n` +
    `👨‍💼 @PuffNow\\_63\n\n` +
    `Нашли баг в боте?\n\n👨‍💼 @neresu`,
    { parse_mode: 'Markdown' }
  );
}

// Показать отзывы
function buildReviewCaption(reviews, stats, page) {
  const total = reviews.length;
  const r = reviews[page];
  const stars = '⭐'.repeat(r.rating);
  const date = new Date(r.date).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const name = r.firstName || 'Покупатель';

  let text = `${stars} *${name}*\n`;
  text += `📅 ${date}\n`;
  if (r.text) text += `\n💬 _${r.text}_\n`;
  text += `\n━━━━━━━━━━━━━━━━━━━━━━\n`;
  text += `⭐ *Отзывы покупателей* · ${'⭐'.repeat(Math.round(stats.avg))} *${stats.avg}* (${total})\n`;
  text += `_${page + 1} из ${total}_`;
  return text;
}

function buildReviewPageKeyboard(reviews, page, hasPurchase) {
  const total = reviews.length;
  const navRow = [];
  if (page > 0)          navRow.push({ text: '⬅️',  callback_data: `review_page_${page - 1}` });
  if (page < total - 1)  navRow.push({ text: '➡️',  callback_data: `review_page_${page + 1}` });

  const keyboard = { inline_keyboard: [] };
  if (navRow.length) keyboard.inline_keyboard.push(navRow);
  if (hasPurchase)   keyboard.inline_keyboard.push([{ text: '✍️ Оставить отзыв', callback_data: 'review_start' }]);
  return keyboard;
}

// Отправить одну карточку отзыва (новым сообщением или заменив старое)
async function sendReviewPage(chatId, reviews, stats, page, hasPurchase, deleteMsgId = null) {
  const r = reviews[page];
  const text = buildReviewCaption(reviews, stats, page);
  const keyboard = buildReviewPageKeyboard(reviews, page, hasPurchase);

  if (deleteMsgId) {
    await bot.deleteMessage(chatId, deleteMsgId).catch(() => {});
  }

  if (r.photoFileId) {
    await bot.sendPhoto(chatId, r.photoFileId, {
      caption: text,
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  } else {
    await bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  }
}

function showReviews(chatId, userId) {
  const reviews = getReviews();
  const stats = getStats();
  const orders = getOrders();
  const hasPurchase = orders.some(o => o.userId === userId && o.status === 'confirmed');

  if (stats.count === 0) {
    let text = `⭐ *Отзывы покупателей*\n\nПока отзывов нет. Будьте первым! 🙌`;
    if (!hasPurchase) text += `\n\n_Оставить отзыв могут только покупатели с подтверждёнными заказами._`;
    const keyboard = { inline_keyboard: hasPurchase ? [[{ text: '✍️ Оставить отзыв', callback_data: 'review_start' }]] : [] };
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
    return;
  }

  sendReviewPage(chatId, reviews, stats, 0, hasPurchase);
}



// Начать сбор отзыва (запрос оценки)
function askReviewRating(chatId, userId, orderId = null) {
  reviewState[userId] = { step: 'rating', orderId };

  const keyboard = {
    inline_keyboard: [[
      { text: '⭐',     callback_data: 'review_rate_1' },
      { text: '⭐⭐',   callback_data: 'review_rate_2' },
      { text: '⭐⭐⭐', callback_data: 'review_rate_3' },
    ], [
      { text: '⭐⭐⭐⭐',   callback_data: 'review_rate_4' },
      { text: '⭐⭐⭐⭐⭐', callback_data: 'review_rate_5' },
    ], [
      { text: '❌ Отмена', callback_data: 'review_cancel' }
    ]]
  };

  bot.sendMessage(chatId,
    `✍️ *Оставить отзыв*\n\nПоставьте оценку нашему магазину:`,
    { parse_mode: 'Markdown', reply_markup: keyboard }
  );
}



// Статистика заказов для админа
function showAdminStats(chatId, messageId = null) {
  const orders = getOrders();

  const total = orders.length;
  const pending   = orders.filter(o => o.status === 'pending').length;
  const confirmed = orders.filter(o => o.status === 'confirmed').length;
  const cancelled = orders.filter(o => o.status === 'cancelled').length;

  const totalRevenue = orders
    .filter(o => o.status === 'confirmed')
    .reduce((sum, o) => sum + (o.total || 0), 0);

  // Заказы за сегодня
  const today = new Date().toDateString();
  const todayOrders = orders.filter(o => new Date(o.date).toDateString() === today);
  const todayRevenue = todayOrders
    .filter(o => o.status === 'confirmed')
    .reduce((sum, o) => sum + (o.total || 0), 0);

  // Последние 5 заказов
  const recent = [...orders]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 5);

  let text = `📊 *Статистика заказов*\n\n`;
  text += `📦 Всего заказов: *${total}*\n`;
  text += `⏳ Ожидают: *${pending}*\n`;
  text += `✅ Подтверждено: *${confirmed}*\n`;
  text += `❌ Отменено: *${cancelled}*\n\n`;
  text += `💰 Выручка (подтв.): *${formatPrice(totalRevenue)}*\n`;
  text += `📅 Сегодня заказов: *${todayOrders.length}* на *${formatPrice(todayRevenue)}*\n`;

  if (recent.length > 0) {
    text += `\n🕐 *Последние заказы:*\n`;
    recent.forEach(o => {
      const statusIcon = o.status === 'confirmed' ? '✅' : o.status === 'cancelled' ? '❌' : '⏳';
      const date = new Date(o.date).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      text += `${statusIcon} #${o.id} — ${formatPrice(o.total)} — @${o.username || 'нет'} (${date})\n`;
    });
  }

  const keyboard = {
    inline_keyboard: [
      [{ text: '🗑 Очистить все заказы', callback_data: 'admin_stats_clear_confirm' }],
      [{ text: '⬅️ Назад', callback_data: 'admin_panel' }]
    ]
  };

  if (messageId) {
    bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: keyboard
    }).catch(() => {
      bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
    });
  } else {
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
  }
}

// Отзывы для админа
function showAdminReviews(chatId, messageId = null, page = 0) {
  const reviews = getReviews();
  const stats = getStats();
  const perPage = 5;
  const totalPages = Math.max(1, Math.ceil(reviews.length / perPage));
  const slice = reviews.slice(page * perPage, page * perPage + perPage);

  let text = `⭐ *Отзывы покупателей*\n`;
  text += `Всего: *${stats.count}* | Средняя оценка: *${stats.avg}*\n\n`;

  if (slice.length === 0) {
    text += '_Отзывов пока нет_';
  } else {
    slice.forEach((r, i) => {
      const stars = '⭐'.repeat(r.rating);
      const date = new Date(r.date).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      const name = r.username ? `@${r.username}` : (r.firstName || 'Покупатель');
      const photoMark = r.photoFileId ? ' 📸' : '';
      text += `${page * perPage + i + 1}. ${stars} *${name}*${photoMark} • ${date}\n`;
      if (r.text) text += `   _${r.text}_\n`;
      text += `\n`;
    });
  }

  // Кнопки удаления + просмотра фото для каждого отзыва на странице
  const deleteButtons = slice.map((r, i) => {
    const row = [{ text: `🗑 Удалить #${page * perPage + i + 1}`, callback_data: `review_delete_${r.id}` }];
    if (r.photoFileId) {
      row.unshift({ text: `📸 Фото #${page * perPage + i + 1}`, callback_data: `review_photo_${r.id}` });
    }
    return row;
  });

  // Пагинация
  const navRow = [];
  if (page > 0)               navRow.push({ text: '⬅️', callback_data: `admin_reviews_page_${page - 1}` });
  if (page < totalPages - 1)  navRow.push({ text: '➡️', callback_data: `admin_reviews_page_${page + 1}` });

  const keyboard = {
    inline_keyboard: [
      ...deleteButtons,
      ...(navRow.length ? [navRow] : []),
      [{ text: '⬅️ Назад', callback_data: 'admin_panel' }]
    ]
  };

  if (messageId) {
    bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: keyboard
    }).catch(() => {
      bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
    });
  } else {
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
  }
}

// Админ-панель
function showAdminPanel(chatId, messageId = null) {
  const keyboard = [
    [{ text: '📦 Управление товарами', callback_data: 'admin_products' }],
    [{ text: '📊 Статистика заказов',  callback_data: 'admin_stats' }],
    [{ text: '⭐ Отзывы',              callback_data: 'admin_reviews' }],
    [{ text: '🏠 Главное меню',        callback_data: 'main_menu' }]
  ];

  const text = '⚙️ *Админ-панель*\n\nВыберите действие:';

  if (messageId) {
    bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    }).catch(() => {
      bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
    });
  } else {
    bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
  }
}

// Управление товарами - выбор категории
function showAdminProducts(chatId, messageId = null) {
  const keyboard = [
    [{ text: '💧 Жидкости', callback_data: 'admin_cat_liquids' }],
    [{ text: '❤️‍🔥 Одноразки/подики', callback_data: 'admin_cat_disposable' }],
    [{ text: '📍 Расходники', callback_data: 'admin_cat_accessories' }],
    [{ text: '🧃 Энергетики', callback_data: 'admin_cat_energy' }],
    [{ text: '⬅️ Назад', callback_data: 'admin_panel' }]
  ];

  const text = '📦 *Управление товарами*\n\nВыберите категорию:';

  if (messageId) {
    bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
  } else {
    bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
  }
}

// Список товаров категории для админа
function showAdminCategoryProducts(chatId, categoryId, messageId = null) {
  const category = categories.find(c => c.id === categoryId);
  // Исключаем дочерние продукты (с parentId) из списка категории
  const categoryProducts = products.filter(p => p.categoryId === categoryId && !p.parentId);

  const keyboard = [];
  
  categoryProducts.forEach(product => {
    const stockIcon = product.enabled === false ? '❌' : '✅';
    keyboard.push([{ 
      text: `${stockIcon} ${product.name}`, 
      callback_data: `admin_product_${product.id}` 
    }]);
  });
  
  if (categoryId === 'disposable') {
    keyboard.push([{ text: '➕ Добавить устройство', callback_data: 'add_device_start' }]);
  }
  if (categoryId === 'liquids') {
    keyboard.push([{ text: '➕ Добавить жидкость', callback_data: 'add_liquid_start' }]);
  }
  if (categoryId === 'accessories') {
    keyboard.push([{ text: '➕ Добавить товар', callback_data: 'add_accessory_start' }]);
  }

  keyboard.push([{ text: '⬅️ Назад', callback_data: 'admin_products' }]);

  const text = `📦 *${category.name}*\n\nВыберите товар для управления:`;

  bot.editMessageText(text, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

// Управление конкретным товаром
function showAdminProductDetail(chatId, productId, messageId = null) {
  const product = products.find(p => p.id === productId);
  
  if (!product) return;

  let text = `📦 *${product.name}*\n\n`;
  text += `💰 Цена: ${formatPrice(product.price)}\n\n`;

  // Если есть цвета - показываем их
  if (product.colors && product.colors.length > 0) {
    const enabledCount = product.colors.filter(c =>
      typeof c === 'string' || c.enabled === undefined || c.enabled === true
    ).length;
    const total = product.colors.length;
    text += `*Цвета (${enabledCount} / ${total} активно):*\n`;
    product.colors.slice(0, 8).forEach((color) => {
      const colorName = typeof color === 'object' ? color.name : color;
      const isEnabled = typeof color === 'object' ? (color.enabled === undefined || color.enabled === true) : true;
      text += `${isEnabled ? '✅' : '❌'} ${colorName}\n`;
    });
    if (product.colors.length > 8) {
      text += `... и ещё ${product.colors.length - 8}\n`;
    }
  }
  // Если есть вкусы - показываем их статус
  else if (product.flavors && product.flavors.length > 0) {
    text += `*Вкусы:*\n`;
    product.flavors.forEach((flavor, index) => {
      const flavorData = typeof flavor === 'object' ? flavor : { name: flavor, stock: '', enabled: true };
      const isEnabled = flavorData.enabled === undefined || flavorData.enabled === true;
      const status = isEnabled ? '✅' : '❌';
      text += `${status} ${flavorData.name}`;
      if (flavorData.stock) text += ` — ${flavorData.stock}`;
      text += `\n`;
    });
  }

  // Если это родительский продукт (isParent) - показываем дочерние линейки
  if (product.isParent && product.subProducts && product.subProducts.length > 0) {
    text += `\n*Линейки:*\n`;
    product.subProducts.forEach(subId => {
      const subProduct = products.find(p => p.id === subId);
      if (subProduct) {
        const status = subProduct.enabled === false ? '❌' : '✅';
        text += `${status} ${subProduct.name}\n`;
      }
    });
  }

  const keyboard = [];

  // Для родительских продуктов: кнопки управления дочерними линейками
  if (product.isParent && product.subProducts && product.subProducts.length > 0) {
    product.subProducts.forEach(subId => {
      const subProduct = products.find(p => p.id === subId);
      if (subProduct) {
        keyboard.push([{ 
          text: `📦 ${subProduct.name}`, 
          callback_data: `admin_product_${subProduct.id}` 
        }]);
      }
    });
    // Кнопка добавления новой линейки
    keyboard.push([{ text: '➕ Добавить линейку', callback_data: `add_subproduct_${product.id}` }]);
  }

  // Кнопки управления цветами
  if (product.colors && product.colors.length > 0) {
    keyboard.push([{ text: '🎨 Управление цветами', callback_data: `admin_flavors_${product.id}` }]);
  }
  // Кнопки управления вкусами
  else if (product.flavors && product.flavors.length > 0) {
    keyboard.push([{ text: '🎨 Управление вкусами', callback_data: `admin_flavors_${product.id}` }]);
  }

  // Кнопки управления вариантами (options — например 0.4/0.6/0.8 Ом)
  if (product.options && product.options.length > 0) {
    keyboard.push([{ text: '⚙️ Управление вариантами', callback_data: `admin_options_${product.id}` }]);
  }

  // Кнопка вкл/выкл для товаров без вкусов/цветов (простые товары с полем enabled)
  if (!product.flavors && !product.colors && product.enabled !== undefined) {
    const isOn = product.enabled;
    keyboard.push([{
      text: isOn ? '🔴 Выключить товар' : '🟢 Включить товар',
      callback_data: `admin_producttoggle_${product.id}`
    }]);
  }

  keyboard.push([
    { text: '🗑️ Удалить товар', callback_data: `admin_delete_product_${product.id}` },
    { text: '⬅️ Назад', callback_data: `admin_cat_${product.categoryId}` }
  ]);

  bot.editMessageText(text, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

// Управление вкусами товара
function showAdminFlavors(chatId, productId, messageId = null) {
  const product = products.find(p => p.id === productId);
  
  if (!product) return;

  // Обработка цветов — кнопки с toggle (как у вкусов)
  if (product.colors && product.colors.length > 0) {
    let text = `🎨 *Управление цветами: ${product.name}*\n\n`;
    text += `Нажмите на цвет чтобы включить/выключить его в магазине:\n\n`;

    const keyboard = [];

    product.colors.forEach((color, index) => {
      const colorName = typeof color === 'object' ? color.name : color;
      const isEnabled = typeof color === 'object' ? (color.enabled === undefined || color.enabled === true) : true;
      const status = isEnabled ? '✅' : '❌';

      text += `${status} ${colorName}\n`;

      keyboard.push([{
        text: `${status} ${colorName}`,
        callback_data: `admin_colortoggle_${product.id}_${index}`
      }]);
    });

    keyboard.push([{ text: '⬅️ Назад', callback_data: `admin_product_${product.id}` }]);

    if (messageId) {
      bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      }).catch(() => {
        bot.deleteMessage(chatId, messageId).catch(() => {});
        bot.sendMessage(chatId, text, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: keyboard }
        });
      });
    } else {
      bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
    }
    return;
  }

  // Обработка вкусов
  if (!product.flavors) return;

  let text = `🎨 *Управление вкусами: ${product.name}*\n\n`;
  text += `Нажмите на вкус чтобы включить/выключить его в магазине:\n\n`;

  const keyboard = [];

  product.flavors.forEach((flavor, index) => {
    const flavorData = typeof flavor === 'object' ? flavor : { name: flavor, stock: '', enabled: true };
    // Если enabled не определен или true - считаем включенным
    const isEnabled = flavorData.enabled === undefined || flavorData.enabled === true;
    const status = isEnabled ? '✅' : '❌';
    const buttonText = `${status} ${flavorData.name}`;
    
    text += `${status} ${flavorData.name}`;
    if (flavorData.stock) text += ` — ${flavorData.stock}`;
    text += `\n`;

    // Кнопка вкл/выкл + кнопка удаления рядом
    keyboard.push([
      { 
        text: buttonText, 
        callback_data: `admin_toggle_${product.id}_${index}` 
      },
      {
        text: '🗑️',
        callback_data: `admin_deleteflavor_${product.id}_${index}`
      }
    ]);
  });

  // Кнопка "Отключить все" только для жидкостей
  if (product.categoryId === 'liquids') {
    keyboard.push([{ text: '🚫 Отключить все', callback_data: `admin_disableall_${product.id}` }]);
    keyboard.push([{ text: '➕ Добавить вкусы', callback_data: `admin_addflavors_${product.id}` }]);
  }

  keyboard.push([{ text: '⬅️ Назад', callback_data: `admin_product_${product.id}` }]);

  if (messageId) {
    bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    }).catch(() => {
      // editMessageText не сработало — удаляем старое и отправляем новое
      bot.deleteMessage(chatId, messageId).catch(() => {});
      bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
    });
  } else {
    bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
  }
}

// Управление вариантами товара (options — 0.4/0.6/0.8 Ом и т.п.)
function showAdminOptions(chatId, productId, messageId = null) {
  const product = products.find(p => p.id === productId);
  if (!product || !product.options) return;

  let text = `⚙️ *Варианты: ${product.name}*\n\n`;
  text += `Нажмите на вариант чтобы включить/выключить его в магазине:\n\n`;

  const keyboard = [];

  product.options.forEach((option, index) => {
    const optionData = typeof option === 'object' ? option : { name: option, enabled: true };
    const isEnabled = optionData.enabled === undefined || optionData.enabled === true;
    const status = isEnabled ? '✅' : '❌';
    const optionName = typeof option === 'object' ? option.name : option;

    text += `${status} ${optionName}\n`;

    keyboard.push([{
      text: `${status} ${optionName}`,
      callback_data: `admin_optiontoggle_${product.id}_${index}`
    }]);
  });

  keyboard.push([{ text: '⬅️ Назад', callback_data: `admin_product_${product.id}` }]);

  if (messageId) {
    bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    }).catch(() => {
      bot.editMessageReplyMarkup({ inline_keyboard: keyboard }, {
        chat_id: chatId,
        message_id: messageId
      }).catch(() => {});
    });
  } else {
    bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
  }
}

// Включить/выключить товар целиком (для простых товаров без вкусов/цветов)
function toggleProduct(productId) {
  const product = products.find(p => p.id === productId);
  if (!product) return false;

  product.enabled = product.enabled === false ? true : false;

  try {
    const fs = require('fs');
    const path = require('path');
    const contentJs = '// Категории товаров\nconst categories = ' + JSON.stringify(categories, null, 2) + ';\n\n// Товары\nconst products = ' + JSON.stringify(products, null, 2) + ';\n\nmodule.exports = { products, categories };\n';
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'products.js'), contentJs, 'utf8');
    console.log(`✅ Товар ${productId} теперь ${product.enabled ? 'включён' : 'выключен'}`);
  } catch(e) { console.error('Save error:', e.message); }

  return true;
}

// Отключить все вкусы у продукта
function disableAllFlavors(productId) {
  const product = products.find(p => p.id === productId);
  if (!product || !product.flavors) return false;

  product.flavors.forEach((flavor, index) => {
    if (typeof flavor === 'object') {
      flavor.enabled = false;
    } else {
      product.flavors[index] = { name: flavor, stock: '', enabled: false };
    }
  });

  // Сохраняем в файл
  try {
    const fs = require('fs');
    const path = require('path');
    const contentJs = '// Категории товаров\nconst categories = ' + JSON.stringify(categories, null, 2) + ';\n\n// Товары\nconst products = ' + JSON.stringify(products, null, 2) + ';\n\nmodule.exports = { products, categories };\n';
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'products.js'), contentJs, 'utf8');
    console.log(`✅ Все вкусы отключены: ${productId}`);
  } catch(e) { console.error('Save products error:', e.message); }

  return true;
}

// Переключить вариант (вкл/выкл)
function toggleOption(productId, optionIndex) {
  const product = products.find(p => p.id === productId);
  if (!product || !product.options || isNaN(optionIndex) || product.options[optionIndex] === undefined) return false;

  const option = product.options[optionIndex];
  if (typeof option === 'object') {
    option.enabled = !(option.enabled === undefined || option.enabled === true);
  } else {
    // Конвертируем строку в объект
    product.options[optionIndex] = {
      name: option,
      enabled: false // первый тогл — выключаем
    };
  }

  // Сохраняем в data/products.js
  try {
    const fs = require('fs');
    const path = require('path');
    const contentJs = '// Категории товаров\nconst categories = ' + JSON.stringify(categories, null, 2) + ';\n\n// Товары\nconst products = ' + JSON.stringify(products, null, 2) + ';\n\nmodule.exports = { products, categories };\n';
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'products.js'), contentJs, 'utf8');
    console.log(`✅ Сохранено: ${productId}, вариант ${optionIndex}`);
  } catch(e) { console.error('Save options error:', e.message); }

  return true;
}

// Переключить вкус (вкл/выкл)
function toggleFlavor(productId, flavorIndex) {
  const product = products.find(p => p.id === productId);
  
  if (!product || !product.flavors || isNaN(flavorIndex) || !product.flavors[flavorIndex]) return false;

  const flavor = product.flavors[flavorIndex];
  
  if (typeof flavor === 'object') {
    // Переключаем enabled
    if (flavor.enabled === undefined || flavor.enabled === true) {
      flavor.enabled = false;
    } else {
      flavor.enabled = true;
    }
  } else {
    // Конвертируем строку в объект
    product.flavors[flavorIndex] = {
      name: flavor,
      stock: '',
      enabled: false
    };
  }

  // Сохраняем в файл data/products.js (только для бота)
  try {
    const fs = require('fs');
    const path = require('path');
    
    const contentJs = '// Категории товаров\nconst categories = ' + JSON.stringify(categories, null, 2) + ';\n\n// Товары\nconst products = ' + JSON.stringify(products, null, 2) + ';\n\nmodule.exports = { products, categories };\n';
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'products.js'), contentJs, 'utf8');
    
    console.log(`✅ Сохранено в боте: ${productId}, вкус ${flavorIndex}`);
  } catch(e) { console.error('Save products error:', e.message); }
  
  // Синхронизируем с Redis в фоне (не блокируем)
  if (redis) {
    redis.set('products', JSON.stringify({ products, categories }))
      .then(() => console.log('✅ Redis обновлён после toggle вкуса'))
      .catch(e => console.error('❌ Ошибка Redis при toggle:', e.message));
  }

  return true;
}

// Удалить вкус и синхронизировать с Redis
async function deleteFlavor(productId, flavorIndex) {
  const product = products.find(p => p.id === productId);
  if (!product || !product.flavors || isNaN(flavorIndex) || !product.flavors[flavorIndex]) {
    return { success: false, error: 'Вкус не найден' };
  }

  const deletedFlavor = product.flavors.splice(flavorIndex, 1)[0];
  const deletedFlavorName = typeof deletedFlavor === 'string' ? deletedFlavor : deletedFlavor.name;

  // Сохраняем в файл data/products.js
  try {
    const fs = require('fs');
    const path = require('path');
    const contentJs = '// Категории товаров\nconst categories = ' + JSON.stringify(categories, null, 2) + ';\n\n// Товары\nconst products = ' + JSON.stringify(products, null, 2) + ';\n\nmodule.exports = { products, categories };\n';
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'products.js'), contentJs, 'utf8');
    console.log(`✅ Вкус "${deletedFlavorName}" удалён из файла`);
  } catch(e) { console.error('Save products error:', e.message); }

  // Синхронизируем с Redis (для Mini App)
  if (redis) {
    try {
      const dataToSave = {
        products: products,
        categories: categories
      };
      await redis.set('products', JSON.stringify(dataToSave));
      console.log(`✅ Redis обновлён после удаления вкуса "${deletedFlavorName}"`);
    } catch(e) {
      console.error('❌ Ошибка сохранения в Redis:', e.message);
    }
  }

  return { success: true, deletedFlavor: deletedFlavorName };
}

// Переключить цвет (вкл/выкл)
function toggleColor(productId, colorIndex) {
  const product = products.find(p => p.id === productId);
  if (!product || !product.colors || isNaN(colorIndex) || product.colors[colorIndex] === undefined) return false;

  const color = product.colors[colorIndex];

  if (typeof color === 'object') {
    color.enabled = !(color.enabled === undefined || color.enabled === true);
  } else {
    // Конвертируем строку в объект
    product.colors[colorIndex] = {
      name: color,
      enabled: false // первый тогл — выключаем
    };
  }

  // Сохраняем в data/products.js
  try {
    const fs = require('fs');
    const path = require('path');
    const contentJs = '// Категории товаров\nconst categories = ' + JSON.stringify(categories, null, 2) + ';\n\n// Товары\nconst products = ' + JSON.stringify(products, null, 2) + ';\n\nmodule.exports = { products, categories };\n';
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'products.js'), contentJs, 'utf8');
    console.log(`✅ Сохранено: ${productId}, цвет ${colorIndex}`);
  } catch(e) { console.error('Save colors error:', e.message); }

  return true;
}

// Показать заказы пользователя
function showUserOrders(chatId, userId) {
  const orders = getOrders().filter(o => o.userId === userId);

  if (orders.length === 0) {
    bot.sendMessage(chatId, '📦 У вас пока нет заказов');
    return;
  }

  let message = '📦 *Ваши заказы:*\n\n';

  orders.forEach(order => {
    const status = order.status === 'confirmed' ? '✅' : order.status === 'cancelled' ? '❌' : '⏳';
    message += `${status} Заказ #${order.id}\n`;
    message += `💰 Сумма: ${formatPrice(order.total)}\n`;
    message += `📅 Дата: ${new Date(order.date).toLocaleString('ru-RU')}\n\n`;
  });

  bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
}

// Обработка callback запросов
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const userId = query.from.id;
  const username = query.from.username;

  // Обработка кнопки "Я подписался" — проверяем без блокировки
  if (data === 'check_subscription') {
    if (await isSubscribed(userId)) {
      bot.answerCallbackQuery(query.id, { text: '✅ Подписка подтверждена!' });
      // Удаляем сообщение с просьбой подписаться и запускаем /start
      bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      const firstName = (query.from.first_name || 'друг').replace(/[*_`\[\]()~>#+=|{}.!\\-]/g, '\\$&');
      const isAdminUser = isAdmin(userId);
      const mainMenu  = buildMainMenu(WEBAPP_URL, userId);
      const adminMenu = buildAdminMenu(WEBAPP_URL, userId);
      const welcomeText =
        `Привет, ${firstName}! 👋\n\n` +
        `Добро пожаловать в PuffNow_63! 🏪\n\n` +
        `💨 У нас большой ассортимент вейп-продукции:\n` +
        `• Одноразки/подики\n` +
        `• Жидкости\n` +
        `• Расходники\n` +
        `• Энергетики\n\n` +
        `Выберите действие из меню ниже:`;
      bot.sendPhoto(chatId, 'AgACAgIAAxkBAAIBbGpsZeQTcBF6z6O3yS6CO_2eq75mAALvHWsbFE5hS_nvyP8d07FrAQADAgADeQADPQQ', {
        caption: welcomeText,
        ...(isAdminUser ? adminMenu : mainMenu)
      });
    } else {
      bot.answerCallbackQuery(query.id, { text: '❌ Вы ещё не подписались на канал!', show_alert: true });
    }
    return;
  }

  // Пропустить добавление фото товара
  if (data === 'skip_product_image') {
    if (addProductState[userId] && addProductState[userId].step === 'image') {
      const state = addProductState[userId];
      state.data.location = 'Все точки';

      // Сохраняем товар без фото
      const result = addProduct(state.data);
      
      delete addProductState[userId];

      if (result.success) {
        const summary = 
          `✅ *Товар успешно добавлен!*\n\n` +
          `📦 Название: ${state.data.name}\n` +
          `💰 Цена: ${formatPrice(state.data.price)}\n` +
          `🎨 Вкусов: ${state.data.flavors.length}\n` +
          `🆔 ID: \`${result.product.id}\``;

        bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
        bot.sendMessage(chatId, summary, {
          parse_mode: 'Markdown',
          ...buildAdminMenu(WEBAPP_URL, userId)
        });
      } else {
        bot.answerCallbackQuery(query.id, { text: `❌ ${result.error}`, show_alert: true });
      }
    }
    return;
  }

  // Пропустить добавление фото устройства
  if (data === 'skip_device_image') {
    if (addProductState[userId] && addProductState[userId].step === 'device_image') {
      const state = addProductState[userId];
      state.data.location = 'Нет данных';

      // Сохраняем устройство без фото
      products.push(state.data);
      if (redis) {
        try {
          await redis.set('products', JSON.stringify({ products, categories }));
        } catch (e) {
          console.error('❌ Ошибка Redis:', e);
        }
      }
      
      delete addProductState[userId];

      const summary = `✅ *Устройство добавлено!*\n\n📱 ${state.data.name}\n💰 ${formatPrice(state.data.price)}\n🆔 ID: \`${state.data.id}\``;
      bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      bot.sendMessage(chatId, summary, { parse_mode: 'Markdown', ...buildAdminMenu(WEBAPP_URL, userId) });
    }
    return;
  }

  // Пропустить добавление фото товара в Расходники
  if (data === 'skip_acc_image') {
    if (addProductState[userId] && addProductState[userId].step === 'acc_image') {
      const state = addProductState[userId];
      state.data.location = 'Все точки';

      // Сохраняем товар без фото
      products.push(state.data);
      if (redis) {
        try {
          await redis.set('products', JSON.stringify({ products, categories }));
        } catch (e) {
          console.error('❌ Ошибка Redis:', e);
        }
      }
      
      delete addProductState[userId];

      const summary = `✅ *Товар добавлен!*\n\n📍 ${state.data.name}\n💰 ${formatPrice(state.data.price)}\n🎨 Вариантов: ${state.data.flavors.length}\n🆔 ID: \`${state.data.id}\``;
      bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      bot.sendMessage(chatId, summary, { parse_mode: 'Markdown', ...buildAdminMenu(WEBAPP_URL, userId) });
    }
    return;
  }

  // Пропустить добавление фото линейки
  if (data === 'skip_sub_image') {
    if (addProductState[userId] && addProductState[userId].step === 'sub_image') {
      const state = addProductState[userId];

      // Добавляем линейку без фото
      products.push(state.data);

      // Добавляем ID линейки в subProducts родителя
      const parentProduct = products.find(p => p.id === state.data.parentId);
      if (parentProduct) {
        if (!parentProduct.subProducts) {
          parentProduct.subProducts = [];
        }
        parentProduct.subProducts.push(state.data.id);
      }

      // Сохраняем в Redis
      if (redis) {
        try {
          await redis.set('products', JSON.stringify({ products, categories }));
        } catch (e) {
          console.error('❌ Ошибка Redis:', e);
        }
      }
      
      delete addProductState[userId];

      const summary = `✅ *Линейка добавлена!*\n\n📍 ${state.data.name}\n💰 ${formatPrice(state.data.price)}\n🎨 Вариантов: ${state.data.flavors.length}\n🆔 ID: \`${state.data.id}\``;
      bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      bot.sendMessage(chatId, summary, { parse_mode: 'Markdown', ...buildAdminMenu(WEBAPP_URL, userId) });
    }
    return;
  }

  // Пропустить добавление фото жидкости
  if (data === 'skip_liquid_image') {
    if (addProductState[userId] && addProductState[userId].step === 'liquid_image') {
      const state = addProductState[userId];

      // Сохраняем жидкость без фото
      products.push(state.data);
      if (redis) {
        try {
          await redis.set('products', JSON.stringify({ products, categories }));
        } catch (e) {
          console.error('❌ Ошибка Redis:', e);
        }
      }
      
      delete addProductState[userId];

      const summary = `✅ *Жидкость добавлена!*\n\n💧 ${state.data.name}\n💰 ${formatPrice(state.data.price)}\n🎨 Вариантов: ${state.data.flavors.length}\n🆔 ID: \`${state.data.id}\``;
      bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
      bot.sendMessage(chatId, summary, { parse_mode: 'Markdown', ...buildAdminMenu(WEBAPP_URL, userId) });
    }
    return;
  }

  // Выбор жидкости для добавления вкусов
  if (data.startsWith('addflavor_')) {
    const productId = data.replace('addflavor_', '');
    const product = products.find(p => p.id === productId);
    
    if (!product) {
      bot.answerCallbackQuery(query.id, { text: '❌ Товар не найден', show_alert: true });
      return;
    }
    
    // Инициализируем состояние для добавления вкусов
    addProductState[userId] = {
      step: 'add_flavors',
      productId: productId,
      productName: product.name
    };
    
    bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
    bot.sendMessage(chatId,
      `💧 *${product.name}*\n\n` +
      `Введите новые вкусы через запятую (например: "Манго лед, Клубника, Дыня")\n\n` +
      `Для отмены используйте /cancel`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Для всех остальных callback — проверяем подписку
  if (!(await isSubscribed(userId))) {
    bot.answerCallbackQuery(query.id);
    sendSubscribeMessage(chatId);
    return;
  }

  if (data === 'main_menu') {
    const mainMenuObj = buildMainMenu(WEBAPP_URL, userId);
    bot.editMessageText('Главное меню:', {
      chat_id: chatId,
      message_id: query.message.message_id,
      reply_markup: mainMenuObj.reply_markup
    }).catch(() => {
      bot.sendMessage(chatId, 'Главное меню:', mainMenuObj);
    });
    bot.answerCallbackQuery(query.id);
  } else if (data === 'categories' || data === 'back_categories') {
    showAssortment(chatId, query.message.message_id);
    bot.answerCallbackQuery(query.id);
  } else if (data.startsWith('cat_')) {
    const categoryId = data.replace('cat_', '');
    showCategoryProducts(chatId, categoryId, query.message.message_id);
    bot.answerCallbackQuery(query.id);
  } else if (data.startsWith('reply_')) {
    const targetUserId = parseInt(data.replace('reply_', ''));
    const targetChat = chat.getChat(targetUserId);
    if (targetChat) {
      chat.setAdminReplyMode(userId, targetUserId);
      bot.answerCallbackQuery(query.id, { text: '✍️ Введите ответ в чат' });
      bot.sendMessage(chatId,
        `✍️ *Ответ пользователю:*\n👤 ${targetChat.firstName} (@${targetChat.username || 'нет'})\n📝 ID: \`${targetUserId}\`\n\nНапишите сообщение или /cancel для отмены`,
        { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
      );
    } else {
      bot.answerCallbackQuery(query.id, { text: '❌ Пользователь закрыл чат' });
    }
  } else if (data.startsWith('history_')) {
    const targetUserId = parseInt(data.replace('history_', ''));
    const targetChat = chat.getChat(targetUserId);
    if (targetChat) {
      const messages = chat.getMessages(targetUserId, 10);
      let historyText = `📜 *История чата*\n👤 ${targetChat.firstName} (@${targetChat.username || 'нет'})\n\n`;
      
      if (messages.length === 0) {
        historyText += 'Сообщений пока нет';
      } else {
        messages.forEach(msg => {
          const time = new Date(msg.timestamp).toLocaleString('ru-RU', { 
            hour: '2-digit', 
            minute: '2-digit' 
          });
          const icon = msg.from === 'user' ? '👤' : '👨‍💼';
          historyText += `${icon} _${time}_\n${msg.text}\n\n`;
        });
      }
      
      bot.sendMessage(chatId, historyText, { 
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '✍️ Ответить', callback_data: `reply_${targetUserId}` }
          ]]
        }
      });
      bot.answerCallbackQuery(query.id);
    } else {
      bot.answerCallbackQuery(query.id, { text: '❌ Чат не найден' });
    }

  } else if (data === 'show_cart') {
    showCart(chatId);
    bot.answerCallbackQuery(query.id);
  } else if (data === 'admin_panel') {
    showAdminPanel(chatId, query.message.message_id);
    bot.answerCallbackQuery(query.id);
  } else if (data === 'admin_products') {
    showAdminProducts(chatId, query.message.message_id);
    bot.answerCallbackQuery(query.id);
  } else if (data === 'admin_stats') {
    showAdminStats(chatId, query.message.message_id);
    bot.answerCallbackQuery(query.id);
  } else if (data === 'admin_reviews') {
    if (!isAdmin(userId)) { bot.answerCallbackQuery(query.id, { text: '❌ Доступ запрещён' }); return; }
    showAdminReviews(chatId, query.message.message_id, 0);
    bot.answerCallbackQuery(query.id);
  } else if (data.startsWith('admin_reviews_page_')) {
    if (!isAdmin(userId)) { bot.answerCallbackQuery(query.id, { text: '❌ Доступ запрещён' }); return; }
    const page = parseInt(data.replace('admin_reviews_page_', '')) || 0;
    showAdminReviews(chatId, query.message.message_id, page);
    bot.answerCallbackQuery(query.id);
  } else if (data === 'admin_stats_clear_confirm') {
    // Показываем подтверждение очистки
    const text = `⚠️ *ВНИМАНИЕ!*\n\nВы уверены, что хотите удалить *все заказы*?\n\nЭто действие нельзя отменить!`;
    const keyboard = {
      inline_keyboard: [
        [
          { text: '✅ Да, удалить всё', callback_data: 'admin_stats_clear_do' },
          { text: '❌ Отмена', callback_data: 'admin_stats' }
        ]
      ]
    };
    bot.editMessageText(text, {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: 'Markdown',
      reply_markup: keyboard
    }).catch(() => {});
    bot.answerCallbackQuery(query.id);
  } else if (data === 'admin_stats_clear_do') {
    // Выполняем очистку
    clearOrders();
    bot.answerCallbackQuery(query.id, { text: '✅ Все заказы удалены', show_alert: true });
    // Возвращаемся к статистике
    showAdminStats(chatId, query.message.message_id);
  } else if (data === 'add_device_start') {
    addProductState[userId] = { step: 'device_name', data: { categoryId: 'disposable' } };
    bot.editMessageText('➕ *Добавление устройства*\n\nВведите название:\n_Например: XROS 7_', { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' });
    // Убираем клавиатуру админа на время добавления
    bot.sendMessage(chatId, 'Введите данные или нажмите /cancel для отмены', { reply_markup: { remove_keyboard: true } });
    bot.answerCallbackQuery(query.id);
  } else if (data === 'add_accessory_start') {
    addProductState[userId] = { step: 'acc_name', data: { categoryId: 'accessories', icon: '📍' } };
    bot.editMessageText('➕ *Добавление товара*\n\nВведите название:\n_Например: Шайбы IceBerg_', { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' });
    bot.sendMessage(chatId, 'Введите данные или /cancel для отмены', { reply_markup: { remove_keyboard: true } });
    bot.answerCallbackQuery(query.id);
  } else if (data === 'add_liquid_start') {
    addProductState[userId] = { step: 'liquid_name', data: { categoryId: 'liquids', icon: '💧' } };
    bot.editMessageText('➕ *Добавление жидкости*\n\nВведите название:\n_Например: Злая монашка HARD 70мг_', { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' });
    bot.sendMessage(chatId, 'Введите данные или /cancel для отмены', { reply_markup: { remove_keyboard: true } });
    bot.answerCallbackQuery(query.id);
  } else if (data.startsWith('add_subproduct_')) {
    const parentId = data.replace('add_subproduct_', '');
    const parentProduct = products.find(p => p.id === parentId);
    if (!parentProduct) {
      bot.answerCallbackQuery(query.id, { text: '❌ Родительский товар не найден' });
      return;
    }
    addProductState[userId] = { 
      step: 'sub_name', 
      data: { 
        categoryId: parentProduct.categoryId, 
        icon: parentProduct.icon,
        parentId: parentId,
        price: parentProduct.price,
        cashPrice: parentProduct.cashPrice
      } 
    };
    bot.editMessageText(`➕ *Добавление линейки к "${parentProduct.name}"*\n\nВведите название линейки:\n_Например: IceBerg Ultra 150мг_`, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' });
    bot.sendMessage(chatId, 'Введите данные или /cancel для отмены', { reply_markup: { remove_keyboard: true } });
    bot.answerCallbackQuery(query.id);
  } else if (data === 'device_type_pod') {
    const st = addProductState[userId];
    if (st && st.step === 'device_type') {
      st.variantType = 'colors'; st.step = 'device_variants';
      bot.deleteMessage(chatId, query.message.message_id).catch(()=>{});
      bot.sendMessage(chatId, '🔋 Под выбран.\nВведите цвета — каждый с новой строки:\nBlack\nWhite\nBlue');
    }
    bot.answerCallbackQuery(query.id);
  } else if (data === 'device_type_disposable') {
    const st = addProductState[userId];
    if (st && st.step === 'device_type') {
      st.variantType = 'flavors'; st.step = 'device_variants';
      bot.deleteMessage(chatId, query.message.message_id).catch(()=>{});
      bot.sendMessage(chatId, '💨 Одноразка выбрана.\nВведите вкусы — каждый с новой строки:\nАрбуз лед\nМанго');
    }
    bot.answerCallbackQuery(query.id);
  } else if (data.startsWith('admin_delete_product_')) {
    const productId = data.replace('admin_delete_product_', '');
    const product = products.find(p => p.id === productId);
    if (!product) { bot.answerCallbackQuery(query.id, { text: '❌ Товар не найден' }); return; }
    const categoryId = product.categoryId;
    const idx = products.findIndex(p => p.id === productId);
    products.splice(idx, 1);
    // Save to Redis
    if (redis) { try { await redis.set('products', JSON.stringify({ products, categories })); } catch(e) { console.error(e); } }
    // Save to file
    try {
      const _fs = require('fs'), _path = require('path');
      const js = 'const categories = ' + JSON.stringify(categories, null, 2) + ';\n\nconst products = ' + JSON.stringify(products, null, 2) + ';\n\nmodule.exports = { products, categories };\n';
      _fs.writeFileSync(_path.join(__dirname, '..', 'data', 'products.js'), js, 'utf8');
    } catch(e) { console.error(e); }
    bot.answerCallbackQuery(query.id, { text: `✅ ${product.name} удалён`, show_alert: true });
    showAdminCategoryProducts(chatId, categoryId, query.message.message_id);
  } else if (data.startsWith('admin_cat_')) {
    const categoryId = data.replace('admin_cat_', '');
    showAdminCategoryProducts(chatId, categoryId, query.message.message_id);
    bot.answerCallbackQuery(query.id);
  } else if (data.startsWith('admin_product_')) {
    const productId = data.replace('admin_product_', '');
    showAdminProductDetail(chatId, productId, query.message.message_id);
    bot.answerCallbackQuery(query.id);
  } else if (data.startsWith('admin_options_')) {
    const productId = data.replace('admin_options_', '');
    showAdminOptions(chatId, productId, query.message.message_id);
    bot.answerCallbackQuery(query.id);
  } else if (data.startsWith('admin_producttoggle_')) {
    const productId = data.replace('admin_producttoggle_', '');
    if (toggleProduct(productId)) {
      const product = products.find(p => p.id === productId);
      showAdminProductDetail(chatId, productId, query.message.message_id);
      bot.answerCallbackQuery(query.id, { text: product.enabled ? '🟢 Товар включён' : '🔴 Товар выключен' });
    } else {
      bot.answerCallbackQuery(query.id, { text: '❌ Ошибка' });
    }
  } else if (data.startsWith('admin_optiontoggle_')) {
    try {
      const toggleData = data.replace('admin_optiontoggle_', '');
      // Находим индекс - это всё что после последнего _
      const parts = toggleData.split('_');
      const optionIndex = parseInt(parts[parts.length - 1]);
      // productId - это всё, кроме последнего элемента
      const productId = parts.slice(0, -1).join('_');
      
      if (toggleOption(productId, optionIndex)) {
        showAdminOptions(chatId, productId, query.message.message_id);
        bot.answerCallbackQuery(query.id, { text: '✅ Статус изменён' });
      } else {
        bot.answerCallbackQuery(query.id, { text: '❌ Ошибка' });
      }
    } catch (err) {
      bot.answerCallbackQuery(query.id, { text: '❌ Ошибка: ' + err.message });
    }
  } else if (data.startsWith('admin_colortoggle_')) {
    try {
      const toggleData = data.replace('admin_colortoggle_', '');
      // Находим индекс - это всё что после последнего _
      const parts = toggleData.split('_');
      const colorIndex = parseInt(parts[parts.length - 1]);
      // productId - это всё, кроме последнего элемента
      const productId = parts.slice(0, -1).join('_');
      
      if (toggleColor(productId, colorIndex)) {
        showAdminFlavors(chatId, productId, query.message.message_id);
        bot.answerCallbackQuery(query.id, { text: '✅ Статус изменён' });
      } else {
        bot.answerCallbackQuery(query.id, { text: '❌ Ошибка' });
      }
    } catch (err) {
      bot.answerCallbackQuery(query.id, { text: '❌ Ошибка: ' + err.message });
    }
  } else if (data.startsWith('admin_flavors_')) {
    const productId = data.replace('admin_flavors_', '');
    showAdminFlavors(chatId, productId, query.message.message_id);
    bot.answerCallbackQuery(query.id);
  } else if (data.startsWith('admin_disableall_')) {
    const productId = data.replace('admin_disableall_', '');
    if (disableAllFlavors(productId)) {
      showAdminFlavors(chatId, productId, query.message.message_id);
      bot.answerCallbackQuery(query.id, { text: '🚫 Все вкусы отключены' });
    } else {
      bot.answerCallbackQuery(query.id, { text: '❌ Ошибка' });
    }
  } else if (data.startsWith('admin_addflavors_')) {
    // Кнопка "Добавить вкусы" из админ-панели
    const productId = data.replace('admin_addflavors_', '');
    const product = products.find(p => p.id === productId);
    
    if (!product) {
      bot.answerCallbackQuery(query.id, { text: '❌ Товар не найден', show_alert: true });
      return;
    }
    
    // Инициализируем состояние для добавления вкусов
    addProductState[userId] = {
      step: 'add_flavors',
      productId: productId,
      productName: product.name
    };
    
    bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
    bot.sendMessage(chatId,
      `💧 *${product.name}*\n\n` +
      `Введите новые вкусы через запятую (например: "Манго лед, Клубника, Дыня")\n\n` +
      `Для отмены используйте /cancel`,
      { parse_mode: 'Markdown' }
    );
    bot.answerCallbackQuery(query.id);
  } else if (data.startsWith('admin_toggle_')) {
    try {
      const toggleData = data.replace('admin_toggle_', '');
      // Находим индекс - это всё что после последнего _
      const parts = toggleData.split('_');
      const flavorIndex = parseInt(parts[parts.length - 1]);
      // productId - это всё, кроме последнего элемента
      const productId = parts.slice(0, -1).join('_');
      
      console.log('Toggle flavor:', productId, flavorIndex);
      
      if (toggleFlavor(productId, flavorIndex)) {
        showAdminFlavors(chatId, productId, query.message.message_id);
        bot.answerCallbackQuery(query.id, { text: '✅ Статус изменен' });
      } else {
        bot.answerCallbackQuery(query.id, { text: '❌ Ошибка' });
      }
    } catch (err) {
      console.error('Error toggling flavor:', err);
      bot.answerCallbackQuery(query.id, { text: '❌ Ошибка: ' + err.message });
    }
  } else if (data.startsWith('admin_deleteflavor_')) {
    try {
      const deleteData = data.replace('admin_deleteflavor_', '');
      // Находим индекс - это всё что после последнего _
      const parts = deleteData.split('_');
      const flavorIndex = parseInt(parts[parts.length - 1]);
      // productId - это всё, кроме последнего элемента
      const productId = parts.slice(0, -1).join('_');
      
      console.log('Delete flavor:', productId, flavorIndex);
      
      const result = await deleteFlavor(productId, flavorIndex);
      if (result.success) {
        showAdminFlavors(chatId, productId, query.message.message_id);
        bot.answerCallbackQuery(query.id, { text: `✅ Вкус "${result.deletedFlavor}" удалён` });
      } else {
        bot.answerCallbackQuery(query.id, { text: '❌ Ошибка удаления' });
      }
    } catch (err) {
      console.error('Error deleting flavor:', err);
      bot.answerCallbackQuery(query.id, { text: '❌ Ошибка: ' + err.message });
    }
  } else if (data === 'my_orders') {
    showUserOrders(chatId, userId);
    bot.answerCallbackQuery(query.id);
  } else if (data.startsWith('view_')) {
    const productId = data.replace('view_', '');
    showProductDetail(chatId, productId, query.message.message_id, userId);
    bot.answerCallbackQuery(query.id);
  } else if (data.startsWith('add_')) {
    const productId = data.replace('add_', '');
    const product = products.find(p => p.id === productId);
    
    // Если у товара есть вкусы, цвета или опции — показываем выбор
    if (product && (product.flavors || product.colors || product.options)) {
      // Сбрасываем предыдущий выбор
      userCarts[`flavors_${chatId}_${productId}`] = [];
      showFlavorSelection(chatId, productId, query.message.message_id, []);
      bot.answerCallbackQuery(query.id);
    } else {
      // Без вариантов — сразу добавляем
      addToCart(query.id, chatId, productId);
    }
  } else if (data.startsWith('flavorpick_')) {
    // Выбор/снятие вкуса
    const pickData = data.replace('flavorpick_', '');
    // Находим индекс - это всё что после последнего _
    const parts = pickData.split('_');
    const flavorIndex = parseInt(parts[parts.length - 1]);
    // productId - это всё, кроме последнего элемента
    const productId = parts.slice(0, -1).join('_');
    
    const key = `flavors_${chatId}_${productId}`;
    if (!userCarts[key]) userCarts[key] = [];
    
    const idx = userCarts[key].indexOf(flavorIndex);
    if (idx === -1) {
      userCarts[key].push(flavorIndex); // добавить
    } else {
      userCarts[key].splice(idx, 1); // убрать
    }
    
    showFlavorSelection(chatId, productId, query.message.message_id, userCarts[key]);
    bot.answerCallbackQuery(query.id);

  } else if (data.startsWith('flavorconfirm_')) {
    const productId = data.replace('flavorconfirm_', '');
    const key = `flavors_${chatId}_${productId}`;
    const selectedIndexes = userCarts[key] || [];
    const product = products.find(p => p.id === productId);

    if (!product) {
      bot.answerCallbackQuery(query.id, { text: '❌ Товар не найден' });
      return;
    }

    if (selectedIndexes.length === 0) {
      bot.answerCallbackQuery(query.id, { text: '⚠️ Выберите хотя бы один вариант!', show_alert: true });
      return;
    }

    // Определяем тип вариантов и получаем список
    let variants = [];
    if (product.flavors) {
      const enabledFlavors = product.flavors.filter(f => {
        if (typeof f === 'object') return f.enabled === undefined || f.enabled === true;
        return true;
      });
      variants = enabledFlavors.map(f => typeof f === 'object' ? f.name : f);
    } else if (product.colors) {
      const enabledColors = product.colors.filter(c =>
        typeof c === 'string' || c.enabled === undefined || c.enabled === true
      );
      variants = enabledColors.map(c => typeof c === 'object' ? c.name : c);
    } else if (product.options) {
      variants = product.options;
    }

    if (!userCarts[chatId]) userCarts[chatId] = [];

    // Добавляем каждый выбранный вариант отдельной позицией
    selectedIndexes.forEach(i => {
      const variantName = variants[i];
      
      const existing = userCarts[chatId].find(item => item.productId === productId && item.flavor === variantName);
      if (existing) {
        existing.quantity++;
      } else {
        userCarts[chatId].push({ productId, quantity: 1, flavor: variantName });
      }
    });

    // Очищаем временный выбор
    delete userCarts[key];

    bot.answerCallbackQuery(query.id, { 
      text: `✅ Добавлено в корзину: ${selectedIndexes.length} вариант(ов)!`,
      show_alert: false
    });

    // Возвращаемся к карточке товара
    showProductDetail(chatId, productId, query.message.message_id, userId);

  } else if (data === 'clear_cart') {
    userCarts[chatId] = [];
    bot.answerCallbackQuery(query.id, { text: '🗑 Корзина очищена' });
    bot.editMessageText('🛒 Корзина пуста', {
      chat_id: chatId,
      message_id: query.message.message_id
    });
  } else if (data === 'checkout') {
    showPickupSelection(chatId, query.message.message_id);
    bot.answerCallbackQuery(query.id);
  } else if (data.startsWith('pickup_')) {
    const pointId = data.replace('pickup_', '');
    const point = PICKUP_POINTS.find(p => p.id === pointId);
    if (!point) {
      bot.answerCallbackQuery(query.id, { text: '❌ Точка не найдена' });
      return;
    }
    const firstName = query.from.first_name || 'Клиент';
    checkout(chatId, userId, username, firstName, point.address);
    bot.answerCallbackQuery(query.id);
  } else if (data.startsWith('complete_')) {
    // Завершить заказ — выключить купленные вкусы в ассортименте
    if (!isAdmin(userId)) {
      bot.answerCallbackQuery(query.id, { text: '❌ Доступ запрещен' });
      return;
    }

    const orderId = data.replace('complete_', '');
    const orders = getOrders();
    // Поддержка обоих форматов: order.id (бот) и order.orderId (mini app)
    const order = orders.find(o => (o.id || o.orderId) === orderId);

    if (!order) {
      bot.answerCallbackQuery(query.id, { text: '❌ Заказ не найден', show_alert: true });
      return;
    }

    // Выключаем вкусы для каждого товара в заказе
    const disabledFlavors = [];
    const orderItems = order.items || [];

    for (const item of orderItems) {
      if (!item.flavor) continue; // товар без вкуса — пропускаем

      const product = products.find(p => p.id === item.productId);
      if (!product || !product.flavors) continue;

      // Ищем вкус по имени
      const flavorIndex = product.flavors.findIndex(f => {
        const name = typeof f === 'string' ? f : f.name;
        return name === item.flavor;
      });

      if (flavorIndex !== -1) {
        const flavor = product.flavors[flavorIndex];
        if (typeof flavor === 'object') {
          flavor.enabled = false;
        } else {
          product.flavors[flavorIndex] = { name: flavor, stock: '', enabled: false };
        }
        disabledFlavors.push(`${product.name} — ${item.flavor}`);
        console.log(`✅ Вкус выключен: ${product.name} / ${item.flavor}`);
      }
    }

    // Сохраняем в файл
    try {
      const fs = require('fs');
      const path = require('path');
      const contentJs = '// Категории товаров\nconst categories = ' + JSON.stringify(categories, null, 2) + ';\n\n// Товары\nconst products = ' + JSON.stringify(products, null, 2) + ';\n\nmodule.exports = { products, categories };\n';
      fs.writeFileSync(path.join(__dirname, '..', 'data', 'products.js'), contentJs, 'utf8');
    } catch(e) { console.error('Save products error:', e.message); }

    // Синхронизируем с Redis
    if (redis) {
      redis.set('products', JSON.stringify({ products, categories }))
        .then(() => console.log('✅ Redis обновлён после завершения заказа'))
        .catch(e => console.error('❌ Ошибка Redis:', e.message));
    }

    // Обновляем статус заказа
    order.status = 'completed';
    saveOrder(order);

    const disabledText = disabledFlavors.length > 0
      ? `\n\n🔴 Выключено вкусов: ${disabledFlavors.length}\n${disabledFlavors.map(f => `• ${f}`).join('\n')}`
      : '\n\n(товары без вкусов — ничего не выключено)';

    bot.answerCallbackQuery(query.id, { text: `🏁 Заказ завершён!${disabledFlavors.length > 0 ? ` Выключено: ${disabledFlavors.length} вкусов` : ''}`, show_alert: true });

    // Обновляем сообщение
    const originalText = query.message.text || query.message.caption || '';
    bot.editMessageText(
      `${originalText}\n\n🏁 <b>ЗАКАЗ ЗАВЕРШЁН</b>${disabledText}`,
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML'
      }
    ).catch(() => {});

    // Отправляем запрос отзыва клиенту после завершения заказа
    const clientChatId = order.chatId || order.userId;
    const clientUserId = order.userId;
    if (clientChatId && clientUserId && !hasRecentReview(clientUserId)) {
      setTimeout(() => {
        bot.sendMessage(
          clientChatId,
          `🎉 Ваш заказ #${orderId} завершён!\n\nБудем рады, если вы оставите отзыв о вашем заказе — это займёт меньше минуты и очень поможет нам стать лучше 🙏`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '⭐',     callback_data: 'review_rate_1' },
                  { text: '⭐⭐',   callback_data: 'review_rate_2' },
                  { text: '⭐⭐⭐', callback_data: 'review_rate_3' },
                ],
                [
                  { text: '⭐⭐⭐⭐',   callback_data: 'review_rate_4' },
                  { text: '⭐⭐⭐⭐⭐', callback_data: 'review_rate_5' },
                ],
                [
                  { text: '✖️ Не сейчас', callback_data: 'review_cancel' }
                ]
              ]
            }
          }
        ).then(() => {
          // Инициализируем состояние отзыва для этого пользователя
          reviewState[clientUserId] = { step: 'rating', orderId };
        }).catch(err => console.error('Ошибка запроса отзыва:', err.message));
      }, 3000); // задержка чтобы сообщение пришло после уведомления
    }

  } else if (data.startsWith('confirm_') || data.startsWith('cancel_')) {
    if (!isAdmin(userId)) {
      bot.answerCallbackQuery(query.id, { text: '❌ Доступ запрещен' });
      return;
    }

    const orderId = data.split('_')[1];
    const action = data.startsWith('confirm_') ? 'confirmed' : 'cancelled';
    const orders = getOrders();
    // Поддержка обоих форматов: order.id (бот) и order.orderId (mini app)
    const order = orders.find(o => (o.id || o.orderId) === orderId);

    if (!order) {
      bot.answerCallbackQuery(query.id, { text: '❌ Заказ не найден', show_alert: true });
      return;
    }

    order.status = action;
    saveOrder(order);

    const statusText = action === 'confirmed' ? '✅ подтвержден' : '❌ отменен';
    bot.answerCallbackQuery(query.id, { text: `Заказ ${statusText}` });

    // При подтверждении оставляем кнопку "Завершить", при отмене — убираем все кнопки
    const editOptions = {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: 'Markdown'
    };

    if (action === 'confirmed') {
      editOptions.reply_markup = {
        inline_keyboard: [
          [{ text: '🏁 Завершить заказ', callback_data: `complete_${orderId}` }],
          [{ text: '💬 Написать клиенту', callback_data: `contact_${order.userId}` }]
        ]
      };
    }

    bot.editMessageText(
      `${query.message.text}\n\n*Статус: ${statusText.toUpperCase()}*`,
      editOptions
    ).catch(() => {});

    // Уведомить клиента - используем chatId или userId
    const clientChatId = order.chatId || order.userId;
    if (clientChatId) {
      bot.sendMessage(
        clientChatId,
        `Ваш заказ #${orderId} ${statusText}!`
      ).catch(err => console.error('Ошибка уведомления клиента:', err.message));
    }
  } else if (data.startsWith('contact_')) {
    if (!isAdmin(userId)) {
      bot.answerCallbackQuery(query.id, { text: '❌ Доступ запрещен' });
      return;
    }
    
    const clientUserId = parseInt(data.replace('contact_', ''));
    
    // Ищем заказ, чтобы получить chatId клиента
    const orders = getOrders();
    // Ищем любой заказ этого пользователя (по любому полю userId)
    const clientOrder = orders.reverse().find(o => {
      const orderId = o.userId || (o.chatId && parseInt(o.chatId));
      return orderId === clientUserId;
    });
    
    if (!clientOrder) {
      bot.answerCallbackQuery(query.id, { text: '❌ Не удалось найти клиента. Возможно заказ еще не сохранен.', show_alert: true });
      return;
    }
    
    // Получаем chatId клиента
    const clientChatId = clientOrder.chatId || clientOrder.userId;
    if (!clientChatId) {
      bot.answerCallbackQuery(query.id, { text: '❌ Не удалось определить chat ID клиента', show_alert: true });
      return;
    }
    
    // Открываем чат с клиентом
    const clientFirstName = clientOrder.firstName || 'Клиент';
    const clientUsername = clientOrder.username !== 'Не указан' && clientOrder.username ? clientOrder.username : '';
    
    chat.openChat(clientUserId, clientChatId, clientUsername, clientFirstName);
    // Убираем клавиатуру у пользователя пока чат активен
    bot.sendMessage(clientChatId,
      '💬 Менеджер начал с вами чат. Напишите сообщение.',
      { reply_markup: { keyboard: [['❌ Закрыть чат с поддержкой']], resize_keyboard: true } }
    ).catch(err => console.error('Ошибка отправки уведомления клиенту:', err.message));
    
    chat.setAdminReplyMode(userId, clientUserId);
    
    bot.answerCallbackQuery(query.id, { text: '💬 Введите сообщение клиенту' });
    bot.sendMessage(chatId, 
      `💬 *Режим ответа клиенту активирован*\n\n` +
      `Клиент: ${clientFirstName}${clientUsername ? ` (${clientUsername})` : ''}\n` +
      `ID: \`${clientUserId}\`\n\n` +
      `Введите ваше сообщение, и оно будет отправлено клиенту.\n\n` +
      `Для отмены используйте /cancel`,
      { parse_mode: 'Markdown' }
    );

  // ─── Отзывы ───────────────────────────────────────────────────────────────
  } else if (data.startsWith('review_page_')) {
    const page = parseInt(data.replace('review_page_', ''), 10);
    const reviews = getReviews();
    const stats = getStats();
    const orders = getOrders();
    const hasPurchase = orders.some(o => o.userId === userId && o.status === 'confirmed');

    if (reviews.length === 0 || page < 0 || page >= reviews.length) {
      bot.answerCallbackQuery(query.id);
      return;
    }

    bot.answerCallbackQuery(query.id);
    await sendReviewPage(chatId, reviews, stats, page, hasPurchase, query.message.message_id);

  } else if (data === 'review_start') {
    const orders = getOrders();
    const hasPurchase = orders.some(o => o.userId === userId && o.status === 'confirmed');
    if (!hasPurchase) {
      bot.answerCallbackQuery(query.id, {
        text: '❌ Оставить отзыв могут только покупатели с подтверждёнными заказами',
        show_alert: true
      });
      return;
    }
    askReviewRating(chatId, userId);
    bot.answerCallbackQuery(query.id);

  } else if (data.startsWith('review_rate_')) {
    const rating = parseInt(data.replace('review_rate_', ''));
    if (!reviewState[userId]) reviewState[userId] = {};
    reviewState[userId].rating = rating;
    reviewState[userId].step = 'text';

    const stars = '⭐'.repeat(rating);
    bot.editMessageText(
      `${stars} Оценка ${rating}/5 принята!\n\nТеперь напишите короткий отзыв о вашем опыте:\n_(или нажмите «Пропустить»)_`,
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '➡️ Пропустить', callback_data: 'review_skip' },
            { text: '❌ Отмена',     callback_data: 'review_cancel' }
          ]]
        }
      }
    );
    bot.answerCallbackQuery(query.id);

  } else if (data === 'review_skip') {
    // Пропустить текст — переходим к шагу фото
    if (!reviewState[userId]) reviewState[userId] = {};
    reviewState[userId].step = 'photo';

    bot.editMessageText(
      `📸 Хотите прикрепить фото к отзыву?\n\nОтправьте картинку или нажмите «Пропустить»`,
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        reply_markup: {
          inline_keyboard: [[
            { text: '➡️ Пропустить', callback_data: 'review_skip_photo' },
            { text: '❌ Отмена',     callback_data: 'review_cancel' }
          ]]
        }
      }
    );
    bot.answerCallbackQuery(query.id);

  } else if (data === 'review_skip_photo') {
    // Сохраняем отзыв без фото
    if (reviewState[userId] && reviewState[userId].rating) {
      const state = reviewState[userId];
      const firstName = query.from.first_name || 'Покупатель';
      const reviewId = `r${Date.now()}`;
      saveReview({
        id: reviewId,
        userId,
        firstName,
        username: query.from.username || null,
        rating: state.rating,
        text: state.text || null,
        photoFileId: null,
        orderId: state.orderId || null,
        date: new Date().toISOString()
      });
      delete reviewState[userId];

      bot.editMessageText(
        `✅ Спасибо за отзыв, ${firstName}! 🙏`,
        { chat_id: chatId, message_id: query.message.message_id }
      );

      // Уведомляем админов
      const stars = '⭐'.repeat(state.rating);
      const notifText =
        `${stars} *Новый отзыв от ${firstName}*${query.from.username ? ` (@${query.from.username})` : ''}` +
        (state.text ? `\n\n_${state.text}_` : '\n_(без текста)_');
      adminIds.forEach(id => {
        bot.sendMessage(id, notifText, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '🗑 Удалить', callback_data: `review_delete_${reviewId}` }]]
          }
        }).catch(() => {});
      });
    }
    bot.answerCallbackQuery(query.id);

  } else if (data === 'review_cancel') {
    delete reviewState[userId];
    bot.editMessageText('❌ Отзыв отменён', {
      chat_id: chatId,
      message_id: query.message.message_id
    });
    bot.answerCallbackQuery(query.id);

  } else if (data.startsWith('review_delete_')) {
    if (!isAdmin(userId)) {
      bot.answerCallbackQuery(query.id, { text: '❌ Доступ запрещён' });
      return;
    }
    const reviewId = data.replace('review_delete_', '');
    const deleted = deleteReview(reviewId);
    bot.answerCallbackQuery(query.id, { text: deleted ? '🗑 Отзыв удалён' : '❌ Отзыв не найден', show_alert: true });
    if (deleted) {
      bot.editMessageText(
        `🗑 _Отзыв удалён_`,
        { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' }
      ).catch(() => {});
    }

  } else if (data.startsWith('review_photo_')) {
    if (!isAdmin(userId)) {
      bot.answerCallbackQuery(query.id, { text: '❌ Доступ запрещён' });
      return;
    }
    const reviewId = data.replace('review_photo_', '');
    const reviews = getReviews();
    const review = reviews.find(r => r.id === reviewId);
    if (review && review.photoFileId) {
      const stars = '⭐'.repeat(review.rating);
      const name = review.username ? `@${review.username}` : (review.firstName || 'Покупатель');
      bot.sendPhoto(chatId, review.photoFileId, {
        caption: `${stars} *${name}*${review.text ? `\n_${review.text}_` : ''}`,
        parse_mode: 'Markdown'
      });
      bot.answerCallbackQuery(query.id);
    } else {
      bot.answerCallbackQuery(query.id, { text: '❌ Фото не найдено', show_alert: true });
    }
  }
});

// ─── Обработка заказов из Mini App ──────────────────────────────────────────
bot.on('message', (msg) => {
  if (!msg.web_app_data) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username;
  const firstName = msg.from.first_name || 'Клиент';

  let orderData;
  try {
    orderData = JSON.parse(msg.web_app_data.data);
  } catch (e) {
    bot.sendMessage(chatId, '❌ Ошибка обработки заказа');
    return;
  }

  const { orderId, username: orderUsername, items, total, pickupPoint } = orderData;

  // Сохраняем заказ
  const order = {
    id: orderId,
    userId,
    username: orderUsername || username || 'Не указан',
    firstName: firstName,
    chatId,
    items,
    total,
    pickupPoint: pickupPoint || 'Не указана',
    date: new Date().toISOString(),
    status: 'pending',
    source: 'miniapp'
  };
  saveOrder(order);

  // Подтверждение клиенту
  let confirmText = `✅ Заказ принят!\n\nНомер заказа: *#${orderId}*\n\n`;
  items.forEach((item, i) => {
    confirmText += `${i + 1}. ${item.name}`;
    if (item.flavor) confirmText += ` — ${item.flavor}`;
    confirmText += `\n   ${item.qty} × ${formatPrice(item.price)} = ${formatPrice(item.price * item.qty)}\n`;
  });
  confirmText += `\n💰 *Итого: ${formatPrice(total)}*\n`;
  if (pickupPoint) confirmText += `🏪 *Точка самовывоза:* ${pickupPoint}\n`;
  confirmText += `\n`;
  if (orderUsername) confirmText += `👤 Username: ${orderUsername}\n`;
  confirmText += `💵 Оплата при получении наличными, при оплате переводом согласовывать с менеджером\nМенеджер свяжется с вами!`;

  bot.sendMessage(chatId, confirmText, { parse_mode: 'Markdown' });

  // Уведомление администраторам
  let adminText = `📱 *Новый заказ из Mini App!*\n\n`;
  adminText += `🆔 Заказ: #${orderId}\n`;
  
  // Формируем информацию о клиенте
  adminText += `👤 Клиент: ${firstName}`;
  if (username) {
    adminText += ` (@${username})`;
  }
  adminText += `\n📝 ID: \`${userId}\`\n`;
  
  if (orderUsername && orderUsername !== '@' + username) adminText += `📝 Указал username: ${orderUsername}\n`;
  if (pickupPoint) adminText += `🏪 Точка самовывоза: ${pickupPoint}\n`;
  adminText += `\n`;

  items.forEach((item, i) => {
    adminText += `${i + 1}. ${item.name}`;
    if (item.flavor) adminText += ` (${item.flavor})`;
    adminText += ` × ${item.qty} = ${formatPrice(item.price * item.qty)}\n`;
  });

  adminText += `\n💰 *Итого: ${formatPrice(total)}*`;

  adminIds.forEach(id => {
    bot.sendMessage(id, adminText, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Подтвердить', callback_data: `confirm_${orderId}` },
            { text: '❌ Отменить',    callback_data: `cancel_${orderId}` }
          ],
          [
            { text: '🏁 Завершить заказ', callback_data: `complete_${orderId}` }
          ],
          [
            { text: '💬 Написать клиенту', callback_data: `contact_${userId}` }
          ]
        ]
      }
    }).catch(err => console.log(`❌ Не удалось уведомить админа ${id}:`, err.message));
  });
});

console.log('🤖 Бот запущен!');
