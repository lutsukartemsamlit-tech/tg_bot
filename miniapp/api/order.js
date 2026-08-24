export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const orderData = req.body;
    const BOT_TOKEN = process.env.BOT_TOKEN;
    const ADMIN_IDS = process.env.ADMIN_IDS
      ? process.env.ADMIN_IDS.split(',').map(id => id.trim())
      : (process.env.ADMIN_ID ? [process.env.ADMIN_ID.trim()] : []);

    if (!BOT_TOKEN) {
      console.error('❌ BOT_TOKEN not configured');
      return res.status(500).json({ ok: false, error: 'BOT_TOKEN not configured' });
    }

    if (ADMIN_IDS.length === 0) {
      console.error('❌ No admin IDs configured');
      return res.status(500).json({ ok: false, error: 'No admin IDs configured' });
    }

    let { orderId, username, userId, firstName, items, total, pickupPoint } = orderData;

    console.log('📦 Order received:', JSON.stringify({ orderId, username, userId, firstName, itemsCount: items?.length, total }));

    // ВАЖНО: Сохраняем заказ в Redis (Vercel serverless = readonly filesystem)
    try {
      const { Redis } = await import('@upstash/redis');
      
      if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
        throw new Error('Redis not configured');
      }
      
      const redis = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      });
      
      // Создаем объект заказа
      const order = {
        orderId: orderId,
        id: orderId, // Для совместимости с ботом
        userId: userId,
        username: username,
        firstName: firstName,
        items: items,
        total: total,
        pickupPoint: pickupPoint,
        source: 'miniapp_api',
        status: 'pending',
        date: new Date().toISOString()
      };
      
      // Читаем текущие заказы из Redis
      let orders = await redis.get('orders') || [];
      if (typeof orders === 'string') {
        orders = JSON.parse(orders);
      }
      if (!Array.isArray(orders)) {
        orders = [];
      }
      
      // Добавляем новый заказ
      orders.push(order);
      
      // Сохраняем обратно в Redis
      await redis.set('orders', JSON.stringify(orders));
      
      console.log('✅ Order saved to Redis');
    } catch (saveError) {
      console.error('❌ Failed to save order:', saveError.message);
      // Продолжаем выполнение даже если не удалось сохранить
    }

    // Если есть userId но нет имени/username — пробуем достать через Bot API
    if (userId && (!username || !firstName)) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 секунд timeout
        
        const chatResp = await fetch(
          `https://api.telegram.org/bot${BOT_TOKEN}/getChat?chat_id=${userId}`,
          { signal: controller.signal }
        );
        clearTimeout(timeoutId);
        
        const chatData = await chatResp.json();
        if (chatData.ok && chatData.result) {
          const u = chatData.result;
          if (!firstName) firstName = u.first_name || '';
          if (!username && u.username) username = u.username;
          console.log('✅ Got user from getChat:', { firstName, username });
        }
      } catch (e) {
        console.error('⚠️ getChat error:', e.message);
      }
    }

    const formatPrice = n => Number(n).toLocaleString('ru-RU') + ' ₽';

    // Формируем строку клиента
    let clientDisplay = firstName || 'Клиент';
    if (username) clientDisplay += ` (@${username})`;
    if (userId) clientDisplay += `\n📝 ID: \`${userId}\``;

    // Текст уведомления для админа
    let adminText = `📦 *Новый заказ!*\n\n`;
    (items || []).forEach((item, i) => {
      adminText += `${i + 1}. ${item.name}`;
      if (item.flavor) adminText += `\n   🎨 ${item.flavor}`;
      adminText += `\n   ${item.qty} × ${formatPrice(item.price)} = ${formatPrice(item.price * item.qty)}\n\n`;
    });
    adminText += `💰 *Итого: ${formatPrice(total)}*\n\n`;
    if (pickupPoint) adminText += `🏪 Точка самовывоза: ${pickupPoint}\n`;
    adminText += `👤 Клиент: ${clientDisplay}\n`;
    adminText += `🆔 Заказ: *#${orderId}*`;

    // Кнопки для админа
    const keyboard = {
      inline_keyboard: [
        [
          { text: '✅ Подтвердить', callback_data: `confirm_${orderId}` },
          { text: '❌ Отменить',    callback_data: `cancel_${orderId}` }
        ],
        [
          { text: '🏁 Завершить заказ', callback_data: `complete_${orderId}` }
        ]
      ]
    };

    if (userId) {
      keyboard.inline_keyboard.push([
        { text: '💬 Написать клиенту', callback_data: `contact_${userId}` }
      ]);
    }

    // Функция отправки с retry
    async function sendToAdmin(adminId, retries = 3) {
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 секунд timeout
          
          const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: adminId,
              text: adminText,
              parse_mode: 'Markdown',
              reply_markup: keyboard
            }),
            signal: controller.signal
          });
          
          clearTimeout(timeoutId);
          const result = await response.json();
          
          if (result.ok) {
            console.log(`✅ Sent to admin ${adminId} (attempt ${attempt})`);
            return { adminId, ok: true, attempt };
          } else {
            console.error(`❌ Failed to send to admin ${adminId} (attempt ${attempt}):`, result.description);
            if (attempt < retries) {
              await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); // exponential backoff
            } else {
              return { adminId, ok: false, error: result.description, attempt };
            }
          }
        } catch (error) {
          console.error(`❌ Error sending to admin ${adminId} (attempt ${attempt}):`, error.message);
          if (attempt < retries) {
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
          } else {
            return { adminId, ok: false, error: error.message, attempt };
          }
        }
      }
    }

    // Отправляем всем админам с retry
    const results = await Promise.all(
      ADMIN_IDS.map(adminId => sendToAdmin(adminId))
    );

    const successCount = results.filter(r => r.ok).length;
    const failedAdmins = results.filter(r => !r.ok);

    console.log(`📊 Sent to ${successCount}/${ADMIN_IDS.length} admins`);
    if (failedAdmins.length > 0) {
      console.error('❌ Failed admins:', failedAdmins);
    }

    // Если хотя бы одному админу отправилось - считаем успехом
    if (successCount > 0) {
      return res.status(200).json({ ok: true, orderId, sent: successCount, total: ADMIN_IDS.length });
    } else {
      return res.status(500).json({ ok: false, error: 'Failed to send to any admin', results });
    }
  } catch (error) {
    console.error('❌ Order handler error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
}
