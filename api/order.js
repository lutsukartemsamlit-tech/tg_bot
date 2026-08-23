// Serverless функция для приема заказов
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const orderData = req.body;
    const BOT_TOKEN = process.env.BOT_TOKEN;
    const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',') : [];
    
    // Сохраняем заказ в файл для обработки ботом
    const fs = require('fs');
    const path = require('path');
    const ordersFile = path.join(process.cwd(), 'data', 'orders.json');
    
    let orders = [];
    try {
      if (fs.existsSync(ordersFile)) {
        orders = JSON.parse(fs.readFileSync(ordersFile, 'utf8'));
      }
    } catch (e) {
      console.error('Error reading orders:', e);
    }
    
    // Создаем заказ в формате бота
    const order = {
      orderId: orderData.orderId,
      userId: orderData.userId,
      chatId: orderData.userId, // для мини-апп chatId = userId
      username: orderData.username || 'Не указан',
      firstName: orderData.firstName || 'Клиент',
      items: orderData.items.map(item => ({
        productId: item.id || item.productId,
        quantity: item.qty,
        flavor: item.flavor
      })),
      pickupPoint: orderData.pickupPoint || 'Не указана',
      status: 'pending',
      date: orderData.date || new Date().toISOString()
    };
    
    orders.push(order);
    fs.writeFileSync(ordersFile, JSON.stringify(orders, null, 2));
    
    // Формируем текст заказа
    const formatPrice = n => Number(n).toLocaleString('ru-RU') + ' ₽';
    
    let clientDisplay = orderData.firstName || 'Клиент';
    if (orderData.username) clientDisplay += ` (@${orderData.username})`;
    if (orderData.userId) clientDisplay += `\n📝 ID: \`${orderData.userId}\``;
    
    let orderText = `📦 *Новый заказ!*\n\n`;
    orderData.items.forEach((item, i) => {
      orderText += `${i + 1}. ${item.name}`;
      if (item.flavor) orderText += `\n   🎨 ${item.flavor}`;
      orderText += `\n   ${item.qty} × ${formatPrice(item.price)} = ${formatPrice(item.price * item.qty)}\n\n`;
    });
    
    orderText += `💰 *Итого: ${formatPrice(orderData.total)}*\n\n`;
    if (orderData.pickupPoint) orderText += `🏪 Точка самовывоза: ${orderData.pickupPoint}\n`;
    orderText += `👤 Клиент: ${clientDisplay}\n`;
    orderText += `🆔 Заказ: *#${orderData.orderId}*`;
    
    // Кнопки для админа
    const keyboard = {
      inline_keyboard: [
        [
          { text: '✅ Подтвердить', callback_data: `confirm_${orderData.orderId}` },
          { text: '❌ Отменить',    callback_data: `cancel_${orderData.orderId}` }
        ],
        [
          { text: '🏁 Завершить заказ', callback_data: `complete_${orderData.orderId}` }
        ]
      ]
    };
    
    if (orderData.userId) {
      keyboard.inline_keyboard.push([
        { text: '💬 Написать клиенту', callback_data: `contact_${orderData.userId}` }
      ]);
    }
    
    // Отправляем админам
    const promises = ADMIN_IDS.map(adminId =>
      fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: adminId.trim(),
          text: orderText,
          parse_mode: 'Markdown',
          reply_markup: keyboard
        })
      })
    );
    
    await Promise.all(promises);
    
    res.status(200).json({ ok: true, orderId: orderData.orderId });
  } catch (error) {
    console.error('Order error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
}
