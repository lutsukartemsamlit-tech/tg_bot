// ─── Telegram WebApp init ────────────────────────────────────────────────────
const tg = window.Telegram && window.Telegram.WebApp;
if (tg) { 
  tg.ready(); 
  tg.expand();
  console.log('=== Telegram WebApp initialized ===');
  console.log('Version:', tg.version);
  console.log('Platform:', tg.platform);
  console.log('initData length:', tg.initData ? tg.initData.length : 0);
  console.log('initDataUnsafe:', JSON.stringify(tg.initDataUnsafe, null, 2));
  
  if (tg.initDataUnsafe && tg.initDataUnsafe.user) {
    console.log('User ID:', tg.initDataUnsafe.user.id);
    console.log('Username:', tg.initDataUnsafe.user.username);
    console.log('First name:', tg.initDataUnsafe.user.first_name);
  } else {
    console.log('⚠️ User data not in initDataUnsafe');
  }
} else {
  console.log('⚠️ Telegram WebApp not available');
}

// ─── Генерация стабильного ID для пользователя ───────────────────────────────
function getOrCreateUserId() {
  // ПРИОРИТЕТ 1: User ID из URL параметра (передан ботом)
  const urlParams = new URLSearchParams(window.location.search);
  const urlUserId = urlParams.get('userId');
  
  if (urlUserId) {
    const telegramId = `tg_${urlUserId}`;
    localStorage.setItem('miniapp_user_id', telegramId);
    console.log('✅ Используется User ID из URL:', telegramId);
    return telegramId;
  }
  
  // ПРИОРИТЕТ 2: Telegram User ID из initDataUnsafe (если доступен)
  if (tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.id) {
    const telegramId = `tg_${tg.initDataUnsafe.user.id}`;
    // Всегда обновляем localStorage с актуальным Telegram ID
    localStorage.setItem('miniapp_user_id', telegramId);
    console.log('✅ Используется Telegram ID из initDataUnsafe:', telegramId);
    return telegramId;
  }
  
  // ПРИОРИТЕТ 3: Проверяем был ли сохранен Telegram ID ранее
  let userId = localStorage.getItem('miniapp_user_id');
  
  // Если есть сохраненный Telegram ID (начинается с 'tg_'), используем его
  if (userId && userId.startsWith('tg_')) {
    console.log('✅ Используется сохраненный Telegram ID:', userId);
    return userId;
  }
  
  // Если нет Telegram данных - показываем предупреждение
  console.warn('⚠️ Mini App открыт не через Telegram!');
  console.warn('⚠️ Откройте Mini App из бота для правильной идентификации');
  
  // Возвращаем временный ID с предупреждением
  return 'guest_' + Date.now();
}

// Получаем/создаём ID пользователя
const CURRENT_USER_ID = getOrCreateUserId();
console.log('👤 Текущий User ID:', CURRENT_USER_ID);

// Проверка что пользователь использует Telegram
if (!CURRENT_USER_ID.startsWith('tg_')) {
  console.warn('⚠️ Используется гостевой режим. Некоторые функции могут быть недоступны.');
}

// ─── Белый список администраторов ─────────────────────────────────────────────
// Формат: 'tg_USERID' где USERID - это Telegram User ID
const ADMIN_WHITELIST = [
  'tg_8277531129',
  'tg_8304388891', 
  'tg_1211246636',
  // Добавьте сюда ID других администраторов
];

// Переменные для админ-панели
let isAdmin = false;
let adminUserId = null;
let adminCurrentCategoryId = null;
let adminCurrentProductId = null;

// ─── API Configuration ───────────────────────────────────────────────────────
// Используем относительные пути - все на Vercel
const API_BASE = '';
console.log('API Base URL: relative (Vercel)');

// ─── Auto-refresh configuration ──────────────────────────────────────────────
let autoRefreshTimer = null;
const AUTO_REFRESH_INTERVAL = 30000; // 30 секунд

// Функция автообновления товаров
async function autoRefreshProducts() {
  try {
    const timestamp = Date.now();
    const apiResponse = await fetch(`/api/products?t=${timestamp}`, { 
      cache: 'no-cache',
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      }
    });
    
    if (apiResponse.ok) {
      const apiData = await apiResponse.json();
      if (apiData.success && apiData.products && apiData.products.length > 0) {
        const oldProducts = products;
        products = apiData.products;
        console.log('🔄 Товары обновлены автоматически:', products.length);
        
        // Если открыта детальная страница товара - обновляем её
        if (currentProductId) {
          const currentProduct = products.find(p => p.id === currentProductId);
          const oldProduct = oldProducts.find(p => p.id === currentProductId);
          
          // Проверяем изменились ли вкусы
          if (currentProduct && oldProduct) {
            const oldFlavorsCount = oldProduct.flavors ? oldProduct.flavors.length : 0;
            const newFlavorsCount = currentProduct.flavors ? currentProduct.flavors.length : 0;
            
            if (oldFlavorsCount !== newFlavorsCount) {
              console.log('🔄 Обнаружены изменения вкусов, обновляем страницу товара');
              showDetail(currentProductId);
            }
          }
        }
      }
    }
  } catch (error) {
    console.error('❌ Ошибка автообновления:', error);
  }
}

// Запуск автообновления
function startAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
  }
  autoRefreshTimer = setInterval(autoRefreshProducts, AUTO_REFRESH_INTERVAL);
  console.log('✅ Автообновление запущено (каждые 30 секунд)');
}

// Остановка автообновления
function stopAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
    console.log('⏹ Автообновление остановлено');
  }
}

// ─── Product Data State ──────────────────────────────────────────────────────
let categories = [];
let products = [];

// Встроенные категории как fallback
const FALLBACK_CATEGORIES = [
  { id: "disposable", name: "Одноразки/подики", icon: "❤️‍🔥" },
  { id: "liquids", name: "Жидкости", icon: "💧" },
  { id: "accessories", name: "Расходники", icon: "📍" },
  { id: "energy", name: "Энергетики", icon: "🧃" }
];

// ─── State ───────────────────────────────────────────────────────────────────
let cart = [];
let history = [];
let currentCategoryId = null;
let currentProductId  = null;
let selectedFlavors   = [];

// Данные Telegram пользователя для заказа (заполняются при рендере checkout)
let _orderTgUserId = null;
let _orderTgFirstName = null;
let _orderTgUsername = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fmt(n) { return Number(n).toLocaleString('ru-RU') + ' ₽'; }
function genId() {
  return (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).toUpperCase();
}

function showToast(msg, color) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.style.background = color || '#27ae60';
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

function cartTotal() { return cart.reduce((s, i) => s + i.price * i.qty, 0); }
function cartCount() { return cart.reduce((s, i) => s + i.qty, 0); }

function updateCartBadge() {
  const badge = document.getElementById('cart-badge');
  const n = cartCount();
  badge.textContent = n;
  badge.style.display = n > 0 ? 'flex' : 'none';
}

// ─── Navigation ──────────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  if (id === 'screen-home')     document.querySelector('.nav-btn:nth-child(1)').classList.add('active');
  if (id === 'screen-cart')     document.querySelector('.nav-btn:nth-child(2)').classList.add('active');
  if (id === 'screen-admin')    document.querySelector('.nav-btn:nth-child(3)').classList.add('active');
  // Scroll to top on screen change
  if (el) el.scrollTop = 0;
}

function navigate(screenId, pushHistory) {
  if (pushHistory !== false) {
    const cur = document.querySelector('.screen.active');
    if (cur && cur.id !== screenId) history.push(cur.id);
  }
  showScreen(screenId);
}

function goBack() {
  if (history.length > 0) showScreen(history.pop());
  else showHome();
}

// ─── Home ────────────────────────────────────────────────────────────────────
function showHome() {
  history = [];
  const grid = document.getElementById('categories-grid');
  grid.innerHTML = '';
  
  categories.forEach(cat => {
    const count = products.filter(p => p.categoryId === cat.id && !p.parentId && p.enabled !== false).length;
    const card = document.createElement('div');
    card.className = 'cat-card';
    card.innerHTML = `
      <div class="cat-icon">${cat.icon}</div>
      <div class="cat-name">${cat.name}</div>
      <div class="cat-count">${count} товаров</div>
    `;
    card.onclick = () => showCategory(cat.id);
    grid.appendChild(card);
  });
  navigate('screen-home', false);
}

function showCatalog() {
  showHome();
  setTimeout(() => {
    const g = document.querySelector('.categories-grid');
    if (g) g.scrollIntoView({ behavior: 'smooth' });
  }, 50);
}

// ─── Category ────────────────────────────────────────────────────────────────
function showCategory(catId) {
  currentCategoryId = catId;
  const cat = categories.find(c => c.id === catId);
  document.getElementById('category-title').textContent = `${cat.icon} ${cat.name}`;

  const list = document.getElementById('products-list');
  list.innerHTML = '';

  products
    .filter(p => p.categoryId === catId && !p.parentId && p.enabled !== false)
    .forEach(p => {
      list.appendChild(makeProductCard(p, () => {
        if (p.isParent) showSubProducts(p.id);
        else showDetail(p.id);
      }));
    });

  navigate('screen-products');
}

function makeProductCard(p, onClick) {
  const card = document.createElement('div');
  card.className = 'product-card';

  const thumb = document.createElement('div');
  thumb.className = 'product-thumb';
  if (p.image) {
    const img = document.createElement('img');
    img.alt = p.name;
    
    // Если это Telegram file_id (начинается с "AgAC"), используем API
    if (p.image.startsWith('AgAC')) {
      img.src = `${API_BASE}/api/photo/${encodeURIComponent(p.image)}`;
    } else {
      img.src = p.image;
    }
    
    img.onerror = () => { 
      // Fallback: пробуем placeholder URL
      const placeholderUrl = `https://via.placeholder.com/400x300/1a1a2e/eee?text=${encodeURIComponent(p.name)}`;
      if (img.src !== placeholderUrl) {
        img.src = placeholderUrl;
      } else {
        thumb.textContent = p.icon || '📦'; 
        img.remove();
      }
    };
    thumb.appendChild(img);
  } else {
    thumb.textContent = p.icon || '📦';
  }

  const info = document.createElement('div');
  info.className = 'product-info';
  info.innerHTML = `
    <div class="product-name">${p.name}</div>
    <div class="product-desc">${getProductDesc(p)}</div>
    <div class="product-price">${fmt(p.price)}</div>
  `;

  const arrow = document.createElement('span');
  arrow.className = 'product-arrow';
  arrow.textContent = '›';

  card.appendChild(thumb);
  card.appendChild(info);
  card.appendChild(arrow);
  card.onclick = onClick;
  return card;
}

function getProductDesc(p) {
  if (p.isParent) return 'Несколько линеек';
  if (p.flavors && p.flavors.length) {
    const enabledCount = p.flavors.filter(f => typeof f === 'string' || f.enabled === undefined || f.enabled === true).length;
    return `${enabledCount} вкусов`;
  }
  if (p.colors && p.colors.length) {
    const enabledColors = p.colors.filter(c => typeof c === 'string' || c.enabled === undefined || c.enabled === true);
    return `${enabledColors.length} цветов`;
  }
  if (p.options && p.options.length)  return p.options.join(' · ');
  return '';
}

// ─── Sub-products ─────────────────────────────────────────────────────────────
function showSubProducts(parentId) {
  const parent = products.find(p => p.id === parentId);
  if (!parent) return;
  document.getElementById('parent-title').textContent = parent.name;

  const list = document.getElementById('subproducts-list');
  list.innerHTML = '';

  (parent.subProducts || [])
    .map(id => products.find(p => p.id === id))
    .filter(Boolean)
    .forEach(p => list.appendChild(makeProductCard(p, () => showDetail(p.id))));

  navigate('screen-subproducts');
}

// ─── Product Detail ───────────────────────────────────────────────────────────
function showDetail(productId) {
  currentProductId = productId;
  selectedFlavors = [];
  const p = products.find(x => x.id === productId);
  if (!p) return;

  document.getElementById('detail-title').textContent = p.name;
  const content = document.getElementById('detail-content');
  content.innerHTML = '';

  // Image
  const imgBox = document.createElement('div');
  imgBox.className = 'detail-image';
  if (p.image) {
    const img = document.createElement('img');
    img.alt = p.name;
    
    // Если это Telegram file_id (начинается с "AgAC"), используем API
    if (p.image.startsWith('AgAC')) {
      img.src = `${API_BASE}/api/photo/${encodeURIComponent(p.image)}`;
    } else {
      img.src = p.image;
    }
    
    img.onerror = () => { 
      // Fallback: пробуем placeholder URL
      const placeholderUrl = `https://via.placeholder.com/400x300/1a1a2e/eee?text=${encodeURIComponent(p.name)}`;
      if (img.src !== placeholderUrl) {
        img.src = placeholderUrl;
      } else {
        imgBox.textContent = p.icon || '📦'; 
        img.remove();
      }
    };
    imgBox.appendChild(img);
  } else {
    imgBox.textContent = p.icon || '📦';
  }
  content.appendChild(imgBox);

  // Body
  const body = document.createElement('div');
  body.className = 'detail-body';
  body.innerHTML = `
    <div class="detail-name">${p.name}</div>
    <div class="detail-price">${fmt(p.price)}</div>
  `;

  // ── Flavors ──
  if (p.flavors && p.flavors.length > 0) {
    // Фильтруем только включенные вкусы с сохранением оригинальных индексов
    const enabledFlavorsWithIndex = p.flavors
      .map((f, originalIdx) => ({
        name: typeof f === 'string' ? f : f.name,
        enabled: typeof f === 'string' || f.enabled === undefined || f.enabled === true,
        originalIdx
      }))
      .filter(item => item.enabled);

    // Если нет включенных вкусов - показываем сообщение
    if (enabledFlavorsWithIndex.length === 0) {
      const noFlavorsMsg = document.createElement('div');
      noFlavorsMsg.className = 'flavors-title';
      noFlavorsMsg.style.color = '#e67e22';
      noFlavorsMsg.textContent = '⚠️ Все вкусы временно недоступны';
      body.appendChild(noFlavorsMsg);
      content.appendChild(body);
      return;
    }

    const enabledFlavors = enabledFlavorsWithIndex.map(item => item.name);

    const title = document.createElement('div');
    title.className = 'flavors-title';
    title.textContent = 'Выберите вкус (можно несколько)';
    body.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'flavors-grid';

    enabledFlavorsWithIndex.forEach((item, displayIdx) => {
      const chip = document.createElement('div');
      chip.className = 'flavor-chip';
      chip.textContent = item.name;
      chip.onclick = () => {
        const i = selectedFlavors.indexOf(displayIdx);
        if (i === -1) selectedFlavors.push(displayIdx);
        else selectedFlavors.splice(i, 1);
        chip.classList.toggle('selected', selectedFlavors.includes(displayIdx));
        updateAddBtn(p, enabledFlavors);
      };
      grid.appendChild(chip);
    });
    body.appendChild(grid);

    const btn = document.createElement('button');
    btn.className = 'add-to-cart-btn';
    btn.id = 'add-btn';
    btn.textContent = '🛒 Выберите вкус';
    btn.disabled = true;
    btn.onclick = () => addFlavorsToCart(p, enabledFlavors);
    body.appendChild(btn);
  }
  // ── Colors ──
  else if (p.colors && p.colors.length > 0) {
    // Фильтруем только включённые, извлекаем имена
    const enabledColors = p.colors
      .filter(c => typeof c === 'string' || c.enabled === undefined || c.enabled === true)
      .map(c => typeof c === 'object' ? c.name : c);
    if (enabledColors.length === 0) {
      const msg = document.createElement('div');
      msg.className = 'flavors-title';
      msg.style.color = '#e67e22';
      msg.textContent = '⚠️ Все цвета временно недоступны';
      body.appendChild(msg);
    } else {
      appendVariantSelector(body, p, enabledColors, 'Выберите цвет', '🛒 Выберите цвет');
    }
  }
  // ── Options ──
  else if (p.options && p.options.length > 0) {
    appendVariantSelector(body, p, p.options, 'Выберите вариант', '🛒 Выберите вариант');
  }
  // ── No variants ──
  else {
    const btn = document.createElement('button');
    btn.className = 'add-to-cart-btn';
    btn.textContent = '🛒 Добавить в корзину';
    btn.onclick = () => {
      addCartItem(p.id, p.name, p.price, null);
      showToast('✅ Добавлено в корзину!');
    };
    body.appendChild(btn);
  }

  content.appendChild(body);
  navigate('screen-detail');
}

function appendVariantSelector(body, p, variants, titleText, btnText) {
  const title = document.createElement('div');
  title.className = 'flavors-title';
  title.textContent = titleText;
  body.appendChild(title);

  const list = document.createElement('div');
  list.className = 'options-list';
  variants.forEach((v, idx) => {
    const item = document.createElement('div');
    item.className = 'option-item';
    item.textContent = v;
    item.onclick = () => {
      list.querySelectorAll('.option-item').forEach(el => el.classList.remove('selected'));
      item.classList.add('selected');
      selectedFlavors = [idx];
      updateAddBtn(p, variants);
    };
    list.appendChild(item);
  });
  body.appendChild(list);

  const btn = document.createElement('button');
  btn.className = 'add-to-cart-btn';
  btn.id = 'add-btn';
  btn.textContent = btnText;
  btn.disabled = true;
  btn.onclick = () => addFlavorsToCart(p, variants);
  body.appendChild(btn);
}

function updateAddBtn(p, variants) {
  const btn = document.getElementById('add-btn');
  if (!btn) return;
  if (selectedFlavors.length > 0) {
    btn.disabled = false;
    btn.textContent = (p.flavors && selectedFlavors.length > 1)
      ? `🛒 Добавить ${selectedFlavors.length} вкуса`
      : '🛒 Добавить в корзину';
  } else {
    btn.disabled = true;
    btn.textContent = p.colors ? '🛒 Выберите цвет'
                    : p.options ? '🛒 Выберите вариант'
                    : '🛒 Выберите вкус';
  }
}

function addFlavorsToCart(p, variants) {
  if (selectedFlavors.length === 0) {
    showToast('⚠️ Выберите хотя бы один вариант', '#e67e22');
    return;
  }
  selectedFlavors.forEach(idx => addCartItem(p.id, p.name, p.price, variants[idx]));
  showToast(`✅ Добавлено: ${selectedFlavors.length} шт.`);
  selectedFlavors = [];
  document.querySelectorAll('.flavor-chip.selected, .option-item.selected')
    .forEach(el => el.classList.remove('selected'));
  const btn = document.getElementById('add-btn');
  if (btn) { btn.disabled = true; btn.textContent = '🛒 Выберите вкус'; }
}

// ─── Cart ─────────────────────────────────────────────────────────────────────
function addCartItem(productId, name, price, flavor) {
  const key = productId + (flavor || '');
  const existing = cart.find(i => i.productId + (i.flavor || '') === key);
  if (existing) existing.qty++;
  else cart.push({ productId, name, price, flavor: flavor || null, qty: 1 });
  updateCartBadge();
}

function showCart() {
  navigate('screen-cart');
  renderCart();
}

function renderCart() {
  const content = document.getElementById('cart-content');
  content.innerHTML = '';

  if (cart.length === 0) {
    content.innerHTML = `
      <div class="cart-empty">
        <div class="cart-empty-icon">🛒</div>
        <p>Корзина пуста</p>
        <p style="margin-top:8px"><a onclick="showHome()" style="cursor:pointer">Перейти в каталог →</a></p>
      </div>`;
    return;
  }

  const itemsDiv = document.createElement('div');
  itemsDiv.className = 'cart-items';

  cart.forEach((item, idx) => {
    const el = document.createElement('div');
    el.className = 'cart-item';
    el.innerHTML = `
      <div class="cart-item-info">
        <div class="cart-item-name">${item.name}</div>
        ${item.flavor ? `<div class="cart-item-flavor">🎨 ${item.flavor}</div>` : ''}
        <div class="cart-item-price">${fmt(item.price * item.qty)}</div>
      </div>
      <div class="cart-qty">
        <button class="qty-btn" onclick="changeQty(${idx}, -1)">−</button>
        <span class="qty-num">${item.qty}</span>
        <button class="qty-btn" onclick="changeQty(${idx}, +1)">+</button>
      </div>
    `;
    itemsDiv.appendChild(el);
  });

  const footer = document.createElement('div');
  footer.className = 'cart-footer';
  footer.innerHTML = `
    <div class="cart-total">Итого: <span>${fmt(cartTotal())}</span></div>
    <button class="checkout-btn" onclick="showCheckout()">✅ Оформить заказ</button>
  `;

  content.appendChild(itemsDiv);
  content.appendChild(footer);
}

function changeQty(idx, delta) {
  cart[idx].qty += delta;
  if (cart[idx].qty <= 0) cart.splice(idx, 1);
  updateCartBadge();
  renderCart();
}

// ─── Checkout ─────────────────────────────────────────────────────────────────
// Точки самовывоза
const PICKUP_POINTS = [
  { id: 'metro_pobedy', name: '📍 Метро Победы', address: 'Метро Победы' }
];

let selectedPickupPoint = null;

function showCheckout() {
  selectedPickupPoint = null;
  navigate('screen-checkout');
  renderCheckout();
}

function renderCheckout() {
  const content = document.getElementById('checkout-content');
  content.innerHTML = '';

  const form = document.createElement('div');
  form.className = 'checkout-form';

  // Order summary
  const summary = document.createElement('div');
  summary.className = 'order-summary';
  let html = `<div class="order-summary-title">📦 Ваш заказ</div>`;
  cart.forEach(item => {
    html += `
      <div class="order-summary-item">
        <span>${item.name}${item.flavor ? ` (${item.flavor})` : ''} × ${item.qty}</span>
        <span>${fmt(item.price * item.qty)}</span>
      </div>`;
  });
  html += `<div class="order-summary-total"><span>Итого</span><span>${fmt(cartTotal())}</span></div>`;
  summary.innerHTML = html;
  form.appendChild(summary);

  // --- Выбор точки самовывоза ---
  const pickupLabel = document.createElement('div');
  pickupLabel.className = 'form-label';
  pickupLabel.textContent = '🏪 Точка самовывоза';
  form.appendChild(pickupLabel);

  const pickupList = document.createElement('div');
  pickupList.className = 'pickup-list';
  PICKUP_POINTS.forEach(point => {
    const pickupItem = document.createElement('div');
    pickupItem.className = 'pickup-item';
    pickupItem.innerHTML = `
      <span class="pickup-icon">${point.name.split(' ')[0]}</span>
      <span class="pickup-name">${point.name.replace(/📍\s*/, '')}</span>
    `;
    pickupItem.onclick = () => {
      pickupList.querySelectorAll('.pickup-item').forEach(el => el.classList.remove('selected'));
      pickupItem.classList.add('selected');
      selectedPickupPoint = point;
    };
    // Выбираем первую точку по умолчанию
    if (!selectedPickupPoint) {
      pickupItem.classList.add('selected');
      selectedPickupPoint = point;
    }
    pickupList.appendChild(pickupItem);
  });
  form.appendChild(pickupList);

  // Получаем данные пользователя из Telegram
  const tgUser = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
  const tgUsername = tgUser && tgUser.username ? '@' + tgUser.username : '';
  const tgFirstName = tgUser ? (tgUser.first_name || '') : '';
  const tgUserId = tgUser ? tgUser.id : null;

  // Сохраняем для submitOrder
  _orderTgUserId = tgUserId;
  _orderTgFirstName = tgFirstName;
  _orderTgUsername = tgUsername;

  // Показываем лучшее что есть: username или имя
  const tgProfileValue = tgUsername || tgFirstName;

  // --- Сначала чекбокс "взять из профиля" ---
  const checkRow = document.createElement('label');
  checkRow.className = 'checkout-check-row';
  checkRow.id = 'check-row';
  // Галочка активна по умолчанию если есть хоть какие-то данные из Telegram
  const isChecked = !!tgProfileValue;
  checkRow.innerHTML = `
    <span class="custom-checkbox ${isChecked ? 'checked' : ''}" id="custom-cb"></span>
    <input type="checkbox" id="check-profile" class="checkout-checkbox-hidden" ${isChecked ? 'checked' : ''}>
    <span class="checkout-check-label">Взять из профиля Telegram</span>
  `;
  form.appendChild(checkRow);

  // --- Потом поле ввода ---
  const usernameLabel = document.createElement('div');
  usernameLabel.className = 'form-label';
  usernameLabel.textContent = tgUsername ? 'Ваш Telegram username' : 'Ваше имя / username';
  form.appendChild(usernameLabel);

  const usernameInput = document.createElement('input');
  usernameInput.type = 'text';
  usernameInput.className = 'form-input';
  usernameInput.id = 'input-username';
  usernameInput.placeholder = '@username или имя';
  usernameInput.value = isChecked ? tgProfileValue : '';
  usernameInput.disabled = isChecked;
  form.appendChild(usernameInput);

  // Submit button
  const submitBtn = document.createElement('button');
  submitBtn.className = 'submit-btn';
  submitBtn.textContent = 'Отправить заказ менеджеру';
  submitBtn.onclick = submitOrder;
  form.appendChild(submitBtn);

  content.appendChild(form);

  // Логика кастомного чекбокса
  const cb = document.getElementById('check-profile');
  const customCb = document.getElementById('custom-cb');
  const inp = document.getElementById('input-username');

  checkRow.addEventListener('click', (e) => {
    e.preventDefault();
    cb.checked = !cb.checked;
    if (cb.checked) {
      customCb.classList.add('checked');
      inp.value = tgProfileValue;
      inp.disabled = true;
    } else {
      customCb.classList.remove('checked');
      inp.disabled = false;
      inp.value = '';
      inp.focus();
    }
  });
}

function submitOrder() {
  const usernameInput = document.getElementById('input-username');
  const cb = document.getElementById('check-profile');
  const username = usernameInput ? usernameInput.value.trim() : '';

  // Если галочка снята — поле не может быть пустым
  if (!cb || !cb.checked) {
    if (!username) {
      showToast('Введите ваш Telegram username', '#e67e22');
      if (usernameInput) usernameInput.focus();
      return;
    }
  }

  // Собираем данные о пользователе из Telegram
  const tgUser = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
  const tgUserId = tgUser ? tgUser.id
                 : (CURRENT_USER_ID && CURRENT_USER_ID.startsWith('tg_')
                    ? parseInt(CURRENT_USER_ID.replace('tg_', ''))
                    : null);
  const tgFirstName = tgUser ? (tgUser.first_name || '') : _orderTgFirstName;
  const tgUsernameVal = tgUser && tgUser.username ? '@' + tgUser.username : _orderTgUsername;
  const tgInitData = tg && tg.initData ? tg.initData : null;

  // Проверяем что userId есть
  if (!tgUserId) {
    showToast('❌ Ошибка: не удалось определить пользователя. Откройте Mini App из Telegram бота.', '#e74c3c');
    if (btn) { btn.disabled = false; btn.textContent = 'Отправить заказ менеджеру'; }
    return;
  }

  const orderId = genId();
  const orderData = {
    orderId,
    username: username || tgUsernameVal || tgFirstName || 'Не указан',
    userId: tgUserId,
    firstName: tgFirstName || 'Клиент',
    tgInitData,
    pickupPoint: selectedPickupPoint ? selectedPickupPoint.address : 'Метро Победы',
    items: cart.map(i => ({
      id: i.productId,
      productId: i.productId,
      name: i.name,
      flavor: i.flavor,
      qty: i.qty,
      price: i.price
    })),
    total: cartTotal(),
    date: new Date().toISOString()
  };

  const btn = document.querySelector('.submit-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Отправляем...'; }

  console.log('📤 Отправка заказа:', orderData);

  // Всегда отправляем через API — tg.sendData не работает при открытии через web_app URL
  fetch(`${API_BASE}/api/order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(orderData)
  })
    .then(r => r.json())
    .then((result) => { 
      console.log('✅ Заказ отправлен:', result);
      cart = []; 
      updateCartBadge(); 
      showSuccess(orderId); 
    })
    .catch(err => {
      console.error('❌ Order error:', err);
      if (btn) { btn.disabled = false; btn.textContent = 'Отправить заказ менеджеру'; }
      showToast('Ошибка отправки. Попробуйте еще раз.', '#e74c3c');
    });
}

function showSuccess(orderId) {
  const content = document.getElementById('checkout-content');
  content.innerHTML = `
    <div class="success-screen">
      <div class="success-icon">🎉</div>
      <h2>Заказ принят!</h2>
      <div class="success-order-id">#${orderId}</div>
      <p>Менеджер свяжется с вами в ближайшее время.<br>Оплата при получении наличными, при оплате переводом согласовывать с менеджером</p>
      <button class="success-home-btn" onclick="showHome()">🏠 На главную</button>
    </div>`;
  showScreen('screen-checkout');
}

// ─── Load Products ────────────────────────────────────────────────────────────
async function fetchProducts() {
  showLoadingIndicator();
  console.log('🔄 Fetching products...');
  
  categories = FALLBACK_CATEGORIES;
  
  // Сначала загружаем из API (Redis) — там актуальные данные с изменениями
  try {
    console.log('Trying /api/products (Redis)');
    // Добавляем timestamp чтобы обойти кэш Telegram WebApp
    const timestamp = Date.now();
    const apiResponse = await fetch(`/api/products?t=${timestamp}`, { 
      cache: 'no-cache',
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      }
    });
    
    if (apiResponse.ok) {
      const apiData = await apiResponse.json();
      // Проверяем наличие products (success может быть true или undefined)
      if (apiData.products && Array.isArray(apiData.products) && apiData.products.length > 0) {
        // ВАЖНО: всегда используем fallback для категорий если их нет
        if (apiData.categories && Array.isArray(apiData.categories) && apiData.categories.length > 0) {
          categories = apiData.categories;
        } else {
          categories = FALLBACK_CATEGORIES;
          console.log('⚠️ Категории не найдены в API, используется fallback');
        }
        products = apiData.products;
        console.log('✅ Loaded from Redis API:', products.length, 'products');
        console.log('📂 Categories:', categories.length);
        console.log('Источник данных:', apiData.source || 'unknown');
        hideLoadingIndicator();
        return true;
      }
    }
    throw new Error('API returned no products');
    
  } catch (error) {
    console.error('❌ API failed, trying static file:', error);
    
    // Fallback — статический products.json
    try {
      console.log('Trying /products.json (fallback)');
      const response = await fetch('/products.json', {
        cache: 'no-cache',
        headers: { 'Accept': 'application/json' }
      });
      
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      
      const data = await response.json();
      
      if (data.categories && data.categories.length > 0) categories = data.categories;
      if (data.products && data.products.length > 0) {
        products = data.products;
        console.log('✅ Loaded from static file:', products.length, 'products');
        hideLoadingIndicator();
        return true;
      }
    } catch (fileError) {
      console.error('❌ Static file also failed:', fileError);
    }
    
    hideLoadingIndicator();
    
    // Если хоть категории есть - считаем успехом
    if (categories.length > 0) {
      showToast('⚠️ Товары не загружены, показаны только категории', '#e67e22');
      return true;
    }
    
    showToast('❌ Не удалось загрузить данные', '#e74c3c');
    return false;
  }
}

function showLoadingIndicator() {
  let loader = document.getElementById('loading-indicator');
  if (loader) return;
  loader = document.createElement('div');
  loader.id = 'loading-indicator';
  loader.className = 'loading-indicator';
  loader.innerHTML = '<div class="spinner"></div><p>Загрузка товаров...</p>';
  document.body.appendChild(loader);
}

function hideLoadingIndicator() {
  const loader = document.getElementById('loading-indicator');
  if (loader) loader.remove();
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
(async function init() {
  // Проверяем права администратора
  checkAdminAccess();
  
  const loaded = await fetchProducts();
  if (loaded) {
    showHome();
    updateCartBadge();
    // Запускаем автообновление товаров
    startAutoRefresh();
  } else {
    showScreen('screen-home');
    const grid = document.getElementById('categories-grid');
    if (grid) {
      grid.innerHTML = `
        <div class="error-message">
          <div class="error-icon">⚠️</div>
          <p>Не удалось загрузить товары</p>
          <button class="retry-btn" onclick="location.reload()">🔄 Обновить</button>
        </div>`;
    }
    updateCartBadge();
  }
})();


// ═══════════════════════════════════════════════════════════════════════════
// АДМИН-ПАНЕЛЬ
// ═══════════════════════════════════════════════════════════════════════════

// Проверяем является ли пользователь админом
function checkAdminAccess() {
  console.log('🔍 Checking admin access...');
  console.log('Current User ID:', CURRENT_USER_ID);
  console.log('Admin Whitelist:', ADMIN_WHITELIST);
  
  const adminBtn = document.getElementById('admin-nav-btn');
  
  // Проверяем наличие в белом списке
  if (ADMIN_WHITELIST.includes(CURRENT_USER_ID)) {
    isAdmin = true;
    adminUserId = CURRENT_USER_ID;
    
    if (adminBtn) {
      adminBtn.style.display = 'flex';
    }
    
    console.log('✅ Пользователь имеет права админа');
    // Не показываем toast для админа
  } else {
    isAdmin = false;
    
    if (adminBtn) {
      adminBtn.style.display = 'none';
    }
    
    console.log('ℹ️ Обычный пользователь');
    console.log('💡 Чтобы получить доступ к админке, добавьте ваш ID в белый список:');
    console.log(`   ADMIN_WHITELIST = [..., '${CURRENT_USER_ID}']`);
  }
}

function showAdminScreen() {
  navigate('screen-admin');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const adminBtn = document.getElementById('admin-nav-btn');
  if (adminBtn) adminBtn.classList.add('active');
  
  console.log('showAdminScreen called');
  console.log('User ID:', CURRENT_USER_ID);
  console.log('Is Admin:', isAdmin);
  
  // Проверяем права
  if (!isAdmin) {
    showToast(`❌ Доступ запрещен\nВаш ID: ${CURRENT_USER_ID}`, '#e74c3c');
    console.log('💡 Для получения доступа добавьте ID в ADMIN_WHITELIST');
    setTimeout(() => showHome(), 2000);
    return;
  }
  
  showAdminMain();
}

function showAdminMain() {
  document.getElementById('admin-main').style.display = 'block';
  document.getElementById('admin-products').style.display = 'none';
  document.getElementById('admin-flavors').style.display = 'none';
  
  // Debug info для администратора
  console.log('showAdminMain called');
  console.log('Current User ID:', adminUserId);
  console.log('Is Admin:', isAdmin);
  console.log('Categories count:', categories.length);
  console.log('Products count:', products.length);
  console.log('Telegram data:', tg ? {
    version: tg.version,
    platform: tg.platform,
    userId: tg.initDataUnsafe?.user?.id,
    username: tg.initDataUnsafe?.user?.username
  } : 'not available');
  
  const grid = document.getElementById('admin-categories');
  if (!grid) {
    console.error('❌ admin-categories element not found!');
    showToast('❌ Ошибка: элемент admin-categories не найден', '#e74c3c');
    return;
  }
  
  grid.innerHTML = '';
  
  // Добавляем кнопку обновления данных
  const refreshCard = document.createElement('div');
  refreshCard.className = 'cat-card';
  refreshCard.style.background = 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)';
  refreshCard.innerHTML = `
    <div class="cat-icon">🔄</div>
    <div class="cat-name">Обновить</div>
    <div class="cat-count">Синхронизация с Redis</div>
  `;
  refreshCard.onclick = async () => {
    // Предотвращаем повторные клики
    if (refreshCard.dataset.loading === 'true') {
      console.log('⏳ Уже обновляется...');
      return;
    }
    
    refreshCard.dataset.loading = 'true';
    refreshCard.style.opacity = '0.6';
    refreshCard.style.pointerEvents = 'none';
    const icon = refreshCard.querySelector('.cat-icon');
    icon.style.animation = 'spin 1s linear infinite';
    
    showToast('🔄 Обновление данных...', '#3498db');
    
    try {
      const timestamp = Date.now();
      const apiResponse = await fetch(`/api/products?t=${timestamp}`, { 
        cache: 'no-cache',
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        }
      });
      
      if (apiResponse.ok) {
        const apiData = await apiResponse.json();
        console.log('📦 Получен ответ от API:', apiData);
        
        // Проверяем наличие products (success может быть true или undefined)
        if (apiData.products && Array.isArray(apiData.products) && apiData.products.length > 0) {
          const oldProductsCount = products.length;
          const oldCategoriesCount = categories.length;
          
          // ВАЖНО: всегда используем fallback для категорий если их нет
          if (apiData.categories && Array.isArray(apiData.categories) && apiData.categories.length > 0) {
            categories = apiData.categories;
            console.log('✅ Категории загружены из API:', categories.length);
          } else {
            categories = FALLBACK_CATEGORIES;
            console.log('⚠️ Категории не найдены в API, используется fallback:', categories.length);
          }
          
          products = apiData.products;
          
          console.log('✅ Обновлено из Redis:', products.length, 'товаров');
          console.log('📂 Категорий:', categories.length);
          console.log('Источник данных:', apiData.source || 'unknown');
          console.log('Было товаров:', oldProductsCount, '→ Стало:', products.length);
          console.log('Было категорий:', oldCategoriesCount, '→ Стало:', categories.length);
          
          // Проверяем первый товар для отладки
          if (products.length > 0) {
            console.log('Пример первого товара:', {
              id: products[0].id,
              name: products[0].name,
              categoryId: products[0].categoryId,
              enabled: products[0].enabled
            });
          }
          
          // Показываем детальную информацию
          showToast(`✅ Товаров: ${products.length}, Категорий: ${categories.length}`, '#22c55e');
          
          // Перерисовываем админ-панель - НЕ вызываем showAdminMain рекурсивно
          // Просто обновляем категории на месте
          console.log('🔄 Обновление карточек категорий...');
          
          // Удаляем ВСЕ карточки кроме кнопки обновления и диагностики
          const allCards = Array.from(grid.children);
          console.log('Всего карточек перед удалением:', allCards.length);
          
          // Считаем сколько категорий реально есть товаров
          let categoriesWithProducts = 0;
          categories.forEach(cat => {
            const count = products.filter(p => p.categoryId === cat.id && !p.parentId && p.enabled !== false).length;
            if (count > 0) categoriesWithProducts++;
          });
          
          console.log('Категорий с товарами:', categoriesWithProducts);
          
          allCards.forEach((card, idx) => {
            const icon = card.querySelector('.cat-icon')?.textContent;
            console.log(`Карточка ${idx}:`, icon);
            
            // Удаляем все кроме кнопок "Обновить" (🔄) и "Диагностика" (🔍)
            if (icon !== '🔄' && icon !== '🔍') {
              console.log('Удаляем карточку:', icon);
              card.remove();
            }
          });
          
          // Добавляем обновлённые категории
          console.log('Добавляем категории:', categories.length);
          
          if (categories.length === 0) {
            showToast('⚠️ Нет категорий для отображения', '#e67e22');
          }
          
          categories.forEach((cat, index) => {
            const count = products.filter(p => p.categoryId === cat.id && !p.parentId && p.enabled !== false).length;
            console.log(`Категория ${index + 1}: ${cat.name} (${cat.icon}) - ${count} товаров`);
            
            const card = document.createElement('div');
            card.className = 'cat-card';
            card.innerHTML = `
              <div class="cat-icon">${cat.icon}</div>
              <div class="cat-name">${cat.name}</div>
              <div class="cat-count">${count} товаров</div>
            `;
            card.onclick = () => showAdminCategory(cat.id);
            grid.appendChild(card);
          });
          
          console.log('✅ Категории обновлены. Всего карточек:', grid.children.length);
          
          // Показываем ещё один toast с результатом
          setTimeout(() => {
            showToast(`📦 Добавлено ${categories.length} категорий`, '#3498db');
          }, 2000);
        } else {
          console.error('❌ Неверный формат данных:', apiData);
          throw new Error('Нет товаров в ответе API');
        }
      } else {
        const errorText = await apiResponse.text();
        console.error('❌ Ошибка HTTP:', apiResponse.status, errorText);
        throw new Error(`HTTP ${apiResponse.status}: ${errorText.substring(0, 100)}`);
      }
    } catch (error) {
      console.error('❌ Ошибка обновления:', error);
      showToast(`❌ ${error.message}`, '#e74c3c');
    } finally {
      refreshCard.dataset.loading = 'false';
      refreshCard.style.opacity = '1';
      refreshCard.style.pointerEvents = 'auto';
      icon.style.animation = '';
    }
  };
  grid.appendChild(refreshCard);
  
  // Добавляем карточку с диагностикой
  const debugCard = document.createElement('div');
  debugCard.className = 'cat-card';
  debugCard.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
  debugCard.innerHTML = `
    <div class="cat-icon">🔍</div>
    <div class="cat-name">Диагностика</div>
    <div class="cat-count">User ID: ${adminUserId || 'unknown'}</div>
  `;
  debugCard.onclick = () => {
    let debugInfo = '=== DEBUG INFO ===\n\n';
    debugInfo += `User ID: ${CURRENT_USER_ID}\n`;
    debugInfo += `Is Admin: ${isAdmin}\n`;
    debugInfo += `Admin Whitelist: ${ADMIN_WHITELIST.join(', ')}\n`;
    debugInfo += `Categories: ${categories.length}\n`;
    debugInfo += `Products: ${products.length}\n\n`;
    
    if (tg) {
      debugInfo += `Telegram WebApp:\n`;
      debugInfo += `- Version: ${tg.version}\n`;
      debugInfo += `- Platform: ${tg.platform}\n`;
      debugInfo += `- initData: ${tg.initData ? 'available' : 'not available'}\n`;
      debugInfo += `- initDataUnsafe: ${JSON.stringify(tg.initDataUnsafe, null, 2)}\n`;
    } else {
      debugInfo += `Telegram WebApp: not available\n`;
    }
    
    debugInfo += `\n💡 Чтобы получить доступ к админке, добавьте ваш ID:\nADMIN_WHITELIST = [..., '${CURRENT_USER_ID}']`;
    
    alert(debugInfo);
    console.log(debugInfo);
  };
  grid.appendChild(debugCard);
  
  console.log('Adding category cards...');
  categories.forEach((cat, index) => {
    console.log(`Adding category ${index + 1}:`, cat.name);
    const count = products.filter(p => p.categoryId === cat.id && !p.parentId && p.enabled !== false).length;
    const card = document.createElement('div');
    card.className = 'cat-card';
    card.innerHTML = `
      <div class="cat-icon">${cat.icon}</div>
      <div class="cat-name">${cat.name}</div>
      <div class="cat-count">${count} товаров</div>
    `;
    card.onclick = () => showAdminCategory(cat.id);
    grid.appendChild(card);
  });
  console.log('✅ Admin main screen rendered with', categories.length, 'categories');
}

function showAdminCategory(catId) {
  adminCurrentCategoryId = catId;
  const cat = categories.find(c => c.id === catId);
  document.getElementById('admin-category-title').textContent = `${cat.icon} ${cat.name}`;

  document.getElementById('admin-main').style.display = 'none';
  document.getElementById('admin-products').style.display = 'block';
  document.getElementById('admin-flavors').style.display = 'none';

  const list = document.getElementById('admin-products-list');
  list.innerHTML = '';

  products
    .filter(p => p.categoryId === catId && !p.parentId)
    .forEach(p => {
      const card = document.createElement('div');
      card.className = 'product-card';
      card.style.position = 'relative';

      const thumb = document.createElement('div');
      thumb.className = 'product-thumb';
      thumb.textContent = p.icon || '📦';

      const info = document.createElement('div');
      info.className = 'product-info';

      let statusText = '';
      if (p.isParent) {
        statusText = 'Несколько линеек';
      } else if (p.flavors && p.flavors.length) {
        const enabled = p.flavors.filter(f =>
          typeof f === 'string' || f.enabled === undefined || f.enabled === true
        ).length;
        statusText = `${enabled} / ${p.flavors.length} вкусов`;
      } else if (p.colors && p.colors.length) {
        const enabled = p.colors.filter(c =>
          typeof c === 'string' || c.enabled === undefined || c.enabled === true
        ).length;
        statusText = `${enabled} / ${p.colors.length} цветов`;
      }

      const isProductEnabled = p.enabled !== false;

      info.innerHTML = `
        <div class="product-name" style="color:${isProductEnabled ? '#ecf0f1' : '#888'}">${p.name}</div>
        <div class="product-desc">${statusText}</div>
      `;

      // Переключатель вкл/выкл
      const toggle = document.createElement('div');
      toggle.className = `admin-toggle ${isProductEnabled ? 'on' : 'off'}`;
      toggle.innerHTML = isProductEnabled ? '✅' : '❌';
      toggle.title = isProductEnabled ? 'Включён — нажмите чтобы выключить' : 'Выключен — нажмите чтобы включить';
      toggle.onclick = (e) => {
        e.stopPropagation();
        toggleProductAdmin(p.id, !isProductEnabled);
      };

      card.appendChild(thumb);
      card.appendChild(info);
      card.appendChild(toggle);
      card.onclick = () => {
        if (p.isParent) showAdminSubProducts(p.id);
        else showAdminFlavors(p.id);
      };
      list.appendChild(card);
    });

  // Кнопка "Добавить товар"
  const addCard = document.createElement('div');
  addCard.className = 'product-card';
  addCard.style.background = 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)';
  addCard.style.cursor = 'pointer';
  addCard.innerHTML = `
    <div class="product-thumb">➕</div>
    <div class="product-info">
      <div class="product-name">Добавить новый товар</div>
      <div class="product-desc">Создать ${cat.name.toLowerCase()}</div>
    </div>
  `;
  addCard.onclick = () => showAddProductForm(catId);
  list.appendChild(addCard);
}

function showAdminSubProducts(parentId) {
  const parent = products.find(p => p.id === parentId);
  if (!parent) return;
  
  adminCurrentProductId = parentId;
  document.getElementById('admin-product-title').textContent = parent.name;
  
  document.getElementById('admin-main').style.display = 'none';
  document.getElementById('admin-products').style.display = 'none';
  document.getElementById('admin-flavors').style.display = 'block';
  
  const content = document.getElementById('admin-flavors-content');
  content.innerHTML = '';
  
  const list = document.createElement('div');
  list.className = 'products-list';
  
  (parent.subProducts || [])
    .map(id => products.find(p => p.id === id))
    .filter(Boolean)
    .forEach(p => {
      const card = document.createElement('div');
      card.className = 'product-card';
      
      const thumb = document.createElement('div');
      thumb.className = 'product-thumb';
      thumb.textContent = p.icon || '📦';
      
      const info = document.createElement('div');
      info.className = 'product-info';
      
      let statusText = '';
      if (p.flavors && p.flavors.length) {
        const enabled = p.flavors.filter(f => 
          typeof f === 'string' || f.enabled === undefined || f.enabled === true
        ).length;
        statusText = `${enabled} / ${p.flavors.length} вкусов`;
      }
      
      info.innerHTML = `
        <div class="product-name">${p.name}</div>
        <div class="product-desc">${statusText}</div>
      `;
      
      const arrow = document.createElement('span');
      arrow.className = 'product-arrow';
      arrow.textContent = '›';
      
      card.appendChild(thumb);
      card.appendChild(info);
      card.appendChild(arrow);
      card.onclick = () => showAdminFlavors(p.id);
      list.appendChild(card);
    });
  
  content.appendChild(list);
}

function showAdminFlavors(productId) {
  const product = products.find(p => p.id === productId);
  if (!product) return;
  
  adminCurrentProductId = productId;
  document.getElementById('admin-product-title').textContent = product.name;
  
  document.getElementById('admin-main').style.display = 'none';
  document.getElementById('admin-products').style.display = 'none';
  document.getElementById('admin-flavors').style.display = 'block';
  
  const content = document.getElementById('admin-flavors-content');
  content.innerHTML = '';

  // ── Colors ──────────────────────────────────────────────────────────────
  if (product.colors && product.colors.length > 0) {
    const title = document.createElement('div');
    title.className = 'flavors-title';
    title.textContent = 'Нажмите на цвет чтобы вкл/выкл:';
    title.style.padding = '20px';
    content.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'flavors-grid';
    grid.style.padding = '0 20px 20px 20px';

    product.colors.forEach((color, index) => {
      const colorName = typeof color === 'string' ? color : color.name;
      const isEnabled = typeof color === 'string' ? true : (color.enabled === undefined || color.enabled === true);

      const chip = document.createElement('div');
      chip.className = 'flavor-chip';
      if (isEnabled) chip.classList.add('selected');
      chip.textContent = `${isEnabled ? '✅' : '❌'} ${colorName}`;
      chip.onclick = () => toggleColorAdmin(productId, index, !isEnabled);
      grid.appendChild(chip);
    });

    content.appendChild(grid);
    return;
  }

  // ── Flavors ──────────────────────────────────────────────────────────────
  if (!product.flavors || product.flavors.length === 0) {
    content.innerHTML = '<div style="padding: 20px; text-align: center; color: #999;">У этого товара нет вкусов</div>';
    return;
  }
  
  const title = document.createElement('div');
  title.className = 'flavors-title';
  title.textContent = 'Нажмите на вкус чтобы вкл/выкл:';
  title.style.padding = '20px';
  content.appendChild(title);
  
  // Кнопка добавления вкуса
  const addBtn = document.createElement('button');
  addBtn.className = 'add-flavor-btn';
  addBtn.style.cssText = `
    margin: 0 20px 20px 20px;
    padding: 12px 20px;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border: none;
    border-radius: 12px;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    width: calc(100% - 40px);
    box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3);
    transition: all 0.3s ease;
  `;
  addBtn.textContent = '➕ Добавить вкус';
  addBtn.onclick = () => showAddFlavorDialog(productId);
  addBtn.onmouseover = function() { this.style.transform = 'translateY(-2px)'; this.style.boxShadow = '0 6px 16px rgba(102, 126, 234, 0.4)'; };
  addBtn.onmouseout = function() { this.style.transform = 'translateY(0)'; this.style.boxShadow = '0 4px 12px rgba(102, 126, 234, 0.3)'; };
  content.appendChild(addBtn);
  
  const grid = document.createElement('div');
  grid.className = 'flavors-grid';
  grid.style.padding = '0 20px 20px 20px';
  
  product.flavors.forEach((flavor, index) => {
    const flavorName = typeof flavor === 'string' ? flavor : flavor.name;
    const isEnabled = typeof flavor === 'string' ? true : (flavor.enabled === undefined || flavor.enabled === true);
    
    const chip = document.createElement('div');
    chip.className = 'flavor-chip';
    if (isEnabled) chip.classList.add('selected');
    chip.style.position = 'relative';
    chip.textContent = `${isEnabled ? '✅' : '❌'} ${flavorName}`;
    chip.onclick = () => toggleFlavorAdmin(productId, index, !isEnabled);
    
    // Долгое нажатие для удаления
    let pressTimer;
    chip.onmousedown = chip.ontouchstart = (e) => {
      pressTimer = setTimeout(() => {
        e.preventDefault();
        showDeleteFlavorDialog(productId, index, flavorName);
      }, 800); // 800ms долгое нажатие
    };
    chip.onmouseup = chip.onmouseleave = chip.ontouchend = chip.ontouchcancel = () => {
      clearTimeout(pressTimer);
    };
    
    grid.appendChild(chip);
  });
  
  content.appendChild(grid);
}

// Показать диалог добавления вкуса
function showAddFlavorDialog(productId) {
  const dialog = document.createElement('div');
  dialog.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    padding: 20px;
  `;
  
  const box = document.createElement('div');
  box.style.cssText = `
    background: #1a1a2e;
    border-radius: 16px;
    padding: 24px;
    max-width: 400px;
    width: 100%;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  `;
  
  const title = document.createElement('div');
  title.textContent = 'Добавить новые вкусы';
  title.style.cssText = `
    font-size: 18px;
    font-weight: 600;
    color: white;
    margin-bottom: 16px;
  `;
  box.appendChild(title);
  
  const info = document.createElement('div');
  info.textContent = 'Введите вкусы через запятую:';
  info.style.cssText = `
    font-size: 14px;
    color: #aaa;
    margin-bottom: 12px;
  `;
  box.appendChild(info);
  
  const input = document.createElement('textarea');
  input.placeholder = 'Например: Манго лед, Клубника, Дыня';
  input.style.cssText = `
    width: 100%;
    min-height: 80px;
    padding: 12px;
    background: #16213e;
    border: 1px solid #0f3460;
    border-radius: 8px;
    color: white;
    font-size: 14px;
    resize: vertical;
    margin-bottom: 16px;
    font-family: inherit;
  `;
  box.appendChild(input);
  
  const buttons = document.createElement('div');
  buttons.style.cssText = `
    display: flex;
    gap: 12px;
  `;
  
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Отмена';
  cancelBtn.style.cssText = `
    flex: 1;
    padding: 12px;
    background: #333;
    color: white;
    border: none;
    border-radius: 8px;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
  `;
  cancelBtn.onclick = () => dialog.remove();
  buttons.appendChild(cancelBtn);
  
  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Добавить';
  saveBtn.style.cssText = `
    flex: 1;
    padding: 12px;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border: none;
    border-radius: 8px;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
  `;
  saveBtn.onclick = async () => {
    const flavorsText = input.value.trim();
    if (!flavorsText) {
      showToast('❌ Введите хотя бы один вкус', '#e74c3c');
      return;
    }
    
    const newFlavors = flavorsText.split(',').map(f => f.trim()).filter(f => f.length > 0);
    if (newFlavors.length === 0) {
      showToast('❌ Введите хотя бы один вкус', '#e74c3c');
      return;
    }
    
    dialog.remove();
    await addFlavorsToProduct(productId, newFlavors);
  };
  buttons.appendChild(saveBtn);
  
  box.appendChild(buttons);
  dialog.appendChild(box);
  document.body.appendChild(dialog);
  
  input.focus();
}

// Показать диалог удаления вкуса
function showDeleteFlavorDialog(productId, flavorIndex, flavorName) {
  const dialog = document.createElement('div');
  dialog.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    padding: 20px;
  `;
  
  const box = document.createElement('div');
  box.style.cssText = `
    background: #1a1a2e;
    border-radius: 16px;
    padding: 24px;
    max-width: 400px;
    width: 100%;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  `;
  
  const title = document.createElement('div');
  title.textContent = '🗑️ Удалить вкус?';
  title.style.cssText = `
    font-size: 18px;
    font-weight: 600;
    color: white;
    margin-bottom: 16px;
  `;
  box.appendChild(title);
  
  const info = document.createElement('div');
  info.textContent = `Вы уверены что хотите удалить "${flavorName}"?`;
  info.style.cssText = `
    font-size: 14px;
    color: #aaa;
    margin-bottom: 16px;
  `;
  box.appendChild(info);
  
  const buttons = document.createElement('div');
  buttons.style.cssText = `
    display: flex;
    gap: 12px;
  `;
  
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Отмена';
  cancelBtn.style.cssText = `
    flex: 1;
    padding: 12px;
    background: #333;
    color: white;
    border: none;
    border-radius: 8px;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
  `;
  cancelBtn.onclick = () => dialog.remove();
  buttons.appendChild(cancelBtn);
  
  const deleteBtn = document.createElement('button');
  deleteBtn.textContent = 'Удалить';
  deleteBtn.style.cssText = `
    flex: 1;
    padding: 12px;
    background: linear-gradient(135deg, #e74c3c 0%, #c0392b 100%);
    color: white;
    border: none;
    border-radius: 8px;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
  `;
  deleteBtn.onclick = async () => {
    dialog.remove();
    await deleteFlavorFromProduct(productId, flavorIndex, flavorName);
  };
  buttons.appendChild(deleteBtn);
  
  box.appendChild(buttons);
  dialog.appendChild(box);
  document.body.appendChild(dialog);
}

// Удалить вкус из товара
async function deleteFlavorFromProduct(productId, flavorIndex, flavorName) {
  try {
    showToast('⏳ Удаление вкуса...', '#3498db');
    
    const response = await fetch(`${API_BASE}/api/admin/delete-flavor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, flavorIndex })
    });
    
    const data = await response.json();
    
    if (data.success) {
      showToast(`✅ Вкус "${flavorName}" удалён`, '#27ae60');
      
      // Обновляем локальные данные
      try {
        const timestamp = Date.now();
        const refreshResponse = await fetch(`${API_BASE}/api/products?t=${timestamp}`, { 
          cache: 'no-cache',
          headers: {
            'Cache-Control': 'no-cache, no-store, must-revalidate'
          }
        });
        if (refreshResponse.ok) {
          const refreshData = await refreshResponse.json();
          if (refreshData.success && refreshData.products) {
            products = refreshData.products;
          }
        }
      } catch (e) { console.error('Refresh error:', e); }
      showAdminFlavors(productId);
    } else {
      showToast(`❌ ${data.error}`, '#e74c3c');
    }
  } catch (error) {
    console.error('Delete flavor error:', error);
    showToast('❌ Ошибка удаления вкуса', '#e74c3c');
  }
}

// Добавить вкусы к товару
async function addFlavorsToProduct(productId, newFlavors) {
  try {
    showToast('⏳ Добавление вкусов...', '#3498db');
    
    const response = await fetch(`${API_BASE}/api/admin/add-flavors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, flavors: newFlavors })
    });
    
    const data = await response.json();
    
    if (data.success) {
      showToast(`✅ Добавлено вкусов: ${newFlavors.length}`, '#27ae60');
      
      // Обновляем локальные данные
      try {
        const timestamp = Date.now();
        const refreshResponse = await fetch(`${API_BASE}/api/products?t=${timestamp}`, { 
          cache: 'no-cache',
          headers: {
            'Cache-Control': 'no-cache, no-store, must-revalidate'
          }
        });
        if (refreshResponse.ok) {
          const refreshData = await refreshResponse.json();
          if (refreshData.success && refreshData.products) {
            products = refreshData.products;
          }
        }
      } catch (e) { console.error('Refresh error:', e); }
      showAdminFlavors(productId);
    } else {
      showToast(`❌ ${data.error}`, '#e74c3c');
    }
  } catch (error) {
    console.error('Add flavors error:', error);
    showToast('❌ Ошибка добавления вкусов', '#e74c3c');
  }
}

async function toggleFlavorAdmin(productId, flavorIndex, enabled) {
  try {
    if (!products || products.length === 0) {
      showToast('❌ Товары не загружены', '#e74c3c');
      return;
    }
    
    const product = products.find(p => p.id === productId);
    if (!product) {
      showToast('❌ Товар не найден', '#e74c3c');
      return;
    }
    
    const response = await fetch(`${API_BASE}/api/admin/update-product`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        productId, 
        flavorIndex, 
        enabled,
        userId: CURRENT_USER_ID  // Используем сгенерированный ID
      })
    });
    
    const data = await response.json();
    
    if (data.success) {
      showToast(`✅ ${enabled ? 'Включено' : 'Выключено'}`);
      
      // Обновляем локальные данные из Redis через API
      try {
        const timestamp = Date.now();
        const refreshResponse = await fetch(`${API_BASE}/api/products?t=${timestamp}`, {
          cache: 'no-cache',
          headers: {
            'Cache-Control': 'no-cache, no-store, must-revalidate'
          }
        });
        if (refreshResponse.ok) {
          const refreshData = await refreshResponse.json();
          if (refreshData.success && refreshData.products) {
            products = refreshData.products;
            categories = refreshData.categories || categories;
            console.log('✅ Data refreshed from Redis');
          }
        }
      } catch (refreshError) {
        console.error('Refresh error:', refreshError);
      }
      
      // Перерисовываем экран с обновленными данными
      showAdminFlavors(productId);
    } else {
      showToast(`❌ ${data.error}`, '#e74c3c');
      if (data.hint) {
        console.log('💡', data.hint);
      }
    }
  } catch (error) {
    console.error('Toggle error:', error);
    showToast('❌ Ошибка обновления', '#e74c3c');
  }
}

async function toggleColorAdmin(productId, colorIndex, enabled) {
  try {
    const response = await fetch(`${API_BASE}/api/admin/update-product`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId,
        colorIndex,
        enabled,
        userId: CURRENT_USER_ID
      })
    });

    const data = await response.json();

    if (data.success) {
      showToast(`${enabled ? '✅ Включено' : '❌ Выключено'}`);
      try {
        const timestamp = Date.now();
        const refreshResponse = await fetch(`${API_BASE}/api/products?t=${timestamp}`, { 
          cache: 'no-cache',
          headers: {
            'Cache-Control': 'no-cache, no-store, must-revalidate'
          }
        });
        if (refreshResponse.ok) {
          const refreshData = await refreshResponse.json();
          if (refreshData.success && refreshData.products) {
            products = refreshData.products;
            categories = refreshData.categories || categories;
          }
        }
      } catch (e) { console.error('Refresh error:', e); }
      showAdminFlavors(productId);
    } else {
      showToast(`❌ ${data.error}`, '#e74c3c');
    }
  } catch (error) {
    console.error('Toggle color error:', error);
    showToast('❌ Ошибка обновления', '#e74c3c');
  }
}

async function toggleProductAdmin(productId, enabled) {
  try {
    const response = await fetch(`${API_BASE}/api/admin/update-product`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId,
        productEnabled: enabled,
        userId: CURRENT_USER_ID
      })
    });

    const data = await response.json();

    if (data.success) {
      showToast(enabled ? '✅ Товар включён' : '❌ Товар выключен', enabled ? '#27ae60' : '#e74c3c');
      // Обновляем локальные данные
      try {
        const timestamp = Date.now();
        const refreshResponse = await fetch(`${API_BASE}/api/products?t=${timestamp}`, { 
          cache: 'no-cache',
          headers: {
            'Cache-Control': 'no-cache, no-store, must-revalidate'
          }
        });
        if (refreshResponse.ok) {
          const refreshData = await refreshResponse.json();
          if (refreshData.success && refreshData.products) {
            products = refreshData.products;
            categories = refreshData.categories || categories;
          }
        }
      } catch (e) { console.error('Refresh error:', e); }
      showAdminCategory(adminCurrentCategoryId);
    } else {
      showToast(`❌ ${data.error}`, '#e74c3c');
    }
  } catch (error) {
    console.error('Toggle product error:', error);
    showToast('❌ Ошибка обновления', '#e74c3c');
  }
}

function goBackAdmin() {
  const product = products.find(p => p.id === adminCurrentProductId);
  if (product && product.parentId) {
    showAdminSubProducts(product.parentId);
  } else {
    showAdminCategory(adminCurrentCategoryId);
  }
}


// Показать форму добавления нового товара
function showAddProductForm(categoryId) {
  const cat = categories.find(c => c.id === categoryId);
  
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(10, 14, 39, 0.95);
    backdrop-filter: blur(10px);
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
    overflow-y: auto;
  `;

  const form = document.createElement('div');
  form.style.cssText = `
    background: linear-gradient(135deg, rgba(30, 35, 60, 0.95) 0%, rgba(20, 25, 50, 0.95) 100%);
    border: 1px solid rgba(102, 126, 234, 0.3);
    border-radius: 20px;
    padding: 24px;
    max-width: 500px;
    width: 100%;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  `;

  form.innerHTML = `
    <h2 style="margin: 0 0 20px 0; color: #fff; font-size: 20px;">
      ➕ Добавить ${cat.name.toLowerCase()}
    </h2>
    
    <div style="margin-bottom: 16px;">
      <label style="display: block; margin-bottom: 6px; color: #8f9bba; font-size: 13px; font-weight: 600;">
        Название товара *
      </label>
      <input type="text" id="add-product-name" placeholder="Например: Vaporesso XROS 7" 
        style="width: 100%; padding: 12px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; color: #fff; font-size: 15px; outline: none;" />
    </div>

    <div style="margin-bottom: 16px;">
      <label style="display: block; margin-bottom: 6px; color: #8f9bba; font-size: 13px; font-weight: 600;">
        Описание
      </label>
      <textarea id="add-product-desc" placeholder="Характеристики товара" rows="3"
        style="width: 100%; padding: 12px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; color: #fff; font-size: 15px; outline: none; resize: vertical;"></textarea>
    </div>

    <div style="margin-bottom: 16px;">
      <label style="display: block; margin-bottom: 6px; color: #8f9bba; font-size: 13px; font-weight: 600;">
        Цена (₽) *
      </label>
      <input type="number" id="add-product-price" placeholder="1500" 
        style="width: 100%; padding: 12px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; color: #fff; font-size: 15px; outline: none;" />
    </div>

    <div style="margin-bottom: 16px;">
      <label style="display: block; margin-bottom: 6px; color: #8f9bba; font-size: 13px; font-weight: 600;">
        Тип вариантов
      </label>
      <select id="add-product-variant-type" 
        style="width: 100%; padding: 12px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; color: #fff; font-size: 15px; outline: none;">
        <option value="colors">🎨 Цвета (для подов)</option>
        <option value="flavors">💧 Вкусы (для одноразок/жидкостей)</option>
        <option value="none">Без вариантов</option>
      </select>
    </div>

    <div style="margin-bottom: 16px;">
      <label style="display: block; margin-bottom: 6px; color: #8f9bba; font-size: 13px; font-weight: 600;">
        Варианты (цвета/вкусы) — каждый с новой строки
      </label>
      <textarea id="add-product-variants" placeholder="Black&#10;White&#10;Blue" rows="4"
        style="width: 100%; padding: 12px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; color: #fff; font-size: 15px; outline: none; resize: vertical;"></textarea>
    </div>

    <div style="display: flex; gap: 12px;">
      <button id="add-product-cancel" 
        style="flex: 1; padding: 14px; background: rgba(239, 68, 68, 0.2); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 12px; color: #ef4444; font-size: 15px; font-weight: 600; cursor: pointer;">
        Отмена
      </button>
      <button id="add-product-submit" 
        style="flex: 1; padding: 14px; background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%); border: none; border-radius: 12px; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; box-shadow: 0 4px 12px rgba(34, 197, 94, 0.4);">
        ➕ Добавить
      </button>
    </div>
  `;

  overlay.appendChild(form);
  document.body.appendChild(overlay);

  // Обработчики
  document.getElementById('add-product-cancel').onclick = () => overlay.remove();
  
  document.getElementById('add-product-submit').onclick = async () => {
    const name = document.getElementById('add-product-name').value.trim();
    const description = document.getElementById('add-product-desc').value.trim();
    const price = Number(document.getElementById('add-product-price').value);
    const variantType = document.getElementById('add-product-variant-type').value;
    const variantsText = document.getElementById('add-product-variants').value;

    if (!name) {
      showToast('⚠️ Введите название товара', '#e67e22');
      return;
    }
    if (!price || price <= 0) {
      showToast('⚠️ Укажите корректную цену', '#e67e22');
      return;
    }

    const variants = variantsText
      .split('\n')
      .map(v => v.trim())
      .filter(v => v.length > 0);

    const submitBtn = document.getElementById('add-product-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = '⏳ Добавление...';

    try {
      const response = await fetch(`${API_BASE}/api/admin/add-product`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          description,
          price,
          categoryId,
          variantType: variantType === 'none' ? null : variantType,
          variants: variantType === 'none' ? [] : variants
        })
      });

      const result = await response.json();

      if (result.success) {
        showToast(`✅ Товар "${name}" добавлен!`, '#22c55e');
        overlay.remove();
        
        // Обновляем список товаров
        await autoRefreshProducts();
        showAdminCategory(categoryId);
      } else {
        showToast(`❌ Ошибка: ${result.error}`, '#e74c3c');
        submitBtn.disabled = false;
        submitBtn.textContent = '➕ Добавить';
      }
    } catch (error) {
      console.error('Add product error:', error);
      showToast('❌ Ошибка при добавлении товара', '#e74c3c');
      submitBtn.disabled = false;
      submitBtn.textContent = '➕ Добавить';
    }
  };
}
