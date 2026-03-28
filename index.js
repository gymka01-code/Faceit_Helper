/**
 * index.js — FACEIT Telegram Notifier Backend
 *
 * Endpoints:
 *   POST /webhook              — Telegram webhook (принимает апдейты)
 *   POST /api/send             — Расширение → отправить сообщение/фото в TG
 *   GET  /api/poll/:sessionId  — Расширение → получить команды (нажатия кнопок)
 *   GET  /api/status/:sessionId — Расширение → статус привязки
 *   POST /api/setup-webhook    — Один раз: зарегистрировать webhook в Telegram
 */

import 'dotenv/config';
import express        from 'express';
import cors           from 'cors';
import { fetch }      from 'node-fetch';
import FormData       from 'form-data';

const app    = express();
const PORT   = process.env.PORT   || 3000;
const TOKEN  = process.env.BOT_TOKEN;
const SECRET = process.env.API_SECRET;
const SERVER = process.env.SERVER_URL?.replace(/\/$/, '');

if (!TOKEN)  throw new Error('BOT_TOKEN not set in .env');
if (!SECRET) throw new Error('API_SECRET not set in .env');

app.use(cors());
app.use(express.json({ limit: '20mb' }));

// ─── Хранилище (in-memory, можно заменить на Redis/SQLite) ─────────────────

/**
 * sessions: Map<sessionId, { chatId, nickname, boundAt }>
 * Хранит привязки UUID расширения → Telegram chat_id
 */
const sessions = new Map();

/**
 * commandQueues: Map<sessionId, Array<{action, payload, timestamp}>>
 * Очередь команд от Telegram → расширению
 */
const commandQueues = new Map();

// ─── Авторизация расширений ────────────────────────────────────────────────

function authMiddleware(req, res, next) {
  const secret = req.headers['x-api-secret'];
  if (secret !== SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

// ─── Telegram API хелперы ──────────────────────────────────────────────────

async function tgRequest(method, body = {}) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  return res.json();
}

async function tgSendMessage(chatId, text, extra = {}) {
  return tgRequest('sendMessage', { chat_id: chatId, text, ...extra });
}

async function tgSendPhoto(chatId, photoBuffer, caption = '') {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  form.append('photo', photoBuffer, { filename: 'screenshot.png', contentType: 'image/png' });

  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, {
    method: 'POST',
    body:   form,
  });
  return res.json();
}

async function tgAnswerCallback(callbackQueryId, text = '') {
  return tgRequest('answerCallbackQuery', { callback_query_id: callbackQueryId, text });
}

async function tgEditMessageReplyMarkup(chatId, messageId, replyMarkup) {
  return tgRequest('editMessageReplyMarkup', {
    chat_id:      chatId,
    message_id:   messageId,
    reply_markup: replyMarkup,
  });
}

// ─── Очереди команд ────────────────────────────────────────────────────────

function enqueueCommand(sessionId, command) {
  if (!commandQueues.has(sessionId)) {
    commandQueues.set(sessionId, []);
  }
  commandQueues.get(sessionId).push({
    ...command,
    timestamp: Date.now(),
  });

  // Чистим старые команды (> 5 минут)
  const queue = commandQueues.get(sessionId);
  const cutoff = Date.now() - 5 * 60 * 1000;
  commandQueues.set(sessionId, queue.filter(c => c.timestamp > cutoff));
}

function dequeueCommands(sessionId) {
  const queue = commandQueues.get(sessionId) || [];
  commandQueues.set(sessionId, []); // очищаем после получения
  return queue;
}

// ─── Webhook: апдейты от Telegram ─────────────────────────────────────────

app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // быстро отвечаем Telegram

  const update = req.body;

  // Обработка callback_query (нажатие inline-кнопки)
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
    return;
  }

  // Обработка сообщений
  if (update.message) {
    await handleMessage(update.message);
  }
});

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text   = msg.text || '';

  // /start <sessionId> — привязка расширения
  if (text.startsWith('/start')) {
    const parts     = text.split(' ');
    const sessionId = parts[1];

    if (sessionId && sessionId.length > 10) {
      // Привязываем session к этому chat_id
      sessions.set(sessionId, {
        chatId,
        nickname: msg.from.first_name || msg.from.username || 'User',
        boundAt:  Date.now(),
      });

      await tgSendMessage(chatId,
        `✅ <b>FACEIT Notifier подключён!</b>\n\nТеперь уведомления о матчах будут приходить сюда.\n\n/help — список команд`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    // /start без кода — просто приветствие
    await tgSendMessage(chatId,
      `👋 Привет! Я FACEIT Notifier.\n\nЧтобы привязать расширение:\n1. Установи расширение в браузер\n2. Нажми кнопку "Подключить Telegram"\n\n/help — список команд`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  // /help
  if (text === '/help') {
    await tgSendMessage(chatId,
      `📖 <b>Команды</b>\n\n/status — статус подключения\n/unbind — отвязать расширение\n/help — эта справка`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  // /status
  if (text === '/status') {
    // Ищем session по chat_id
    const entry = [...sessions.entries()].find(([, v]) => v.chatId === chatId);
    if (entry) {
      const [sessionId, data] = entry;
      const boundDate = new Date(data.boundAt).toLocaleString('ru-RU');
      await tgSendMessage(chatId,
        `✅ <b>Подключено</b>\nSession: <code>${sessionId.slice(0, 8)}…</code>\nПривязано: ${boundDate}`,
        { parse_mode: 'HTML' }
      );
    } else {
      await tgSendMessage(chatId, '❌ Расширение не привязано. Установи расширение и нажми "Подключить Telegram".');
    }
    return;
  }

  // /unbind
  if (text === '/unbind') {
    const entry = [...sessions.entries()].find(([, v]) => v.chatId === chatId);
    if (entry) {
      sessions.delete(entry[0]);
      await tgSendMessage(chatId, '✅ Расширение отвязано.');
    } else {
      await tgSendMessage(chatId, 'Нет привязанного расширения.');
    }
  }
}

async function handleCallbackQuery(cq) {
  const chatId    = cq.message.chat.id;
  const messageId = cq.message.message_id;
  const data      = cq.data; // "action:payload"

  await tgAnswerCallback(cq.id);

  // Находим session по chat_id
  const entry = [...sessions.entries()].find(([, v]) => v.chatId === chatId);
  if (!entry) {
    await tgSendMessage(chatId, '❌ Расширение не привязано или не запущено.');
    return;
  }

  const [sessionId] = entry;
  const [action, payload] = data.split(':', 2);

  // Кладём команду в очередь для расширения
  enqueueCommand(sessionId, { action, payload });

  // Убираем кнопки у сообщения чтобы не нажали дважды
  const shouldRemoveButtons = ['ACCEPT_MATCH', 'BAN_MAP', 'BAN_SERVER', 'PICK_MAP'].includes(action);
  if (shouldRemoveButtons) {
    try {
      await tgEditMessageReplyMarkup(chatId, messageId, { inline_keyboard: [] });
    } catch (_) {}
  }

  // Подтверждение пользователю
  const confirmMessages = {
    ACCEPT_MATCH: '⏳ Принимаю матч...',
    BAN_MAP:      `⏳ Баню карту ${payload}...`,
    BAN_SERVER:   `⏳ Баню сервер ${payload}...`,
    PICK_MAP:     `⏳ Пикаю карту ${payload}...`,
    OPEN_ROOM:    '🔗 Открываю комнату в браузере...',
  };

  const confirmText = confirmMessages[action];
  if (confirmText) {
    await tgSendMessage(chatId, confirmText);
  }
}

// ─── API: Расширение → отправить сообщение ─────────────────────────────────

app.post('/api/send', authMiddleware, async (req, res) => {
  const { sessionId, type, text, photo, caption, keyboard } = req.body;

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ ok: false, error: 'Session not found or not bound' });
  }

  const { chatId } = session;

  try {
    let result;

    if (type === 'photo' && photo) {
      // photo — base64 строка
      const buffer = Buffer.from(photo, 'base64');
      result = await tgSendPhoto(chatId, buffer, caption || '');
    } else {
      // Текстовое сообщение
      const extra = { parse_mode: 'HTML' };
      if (keyboard) extra.reply_markup = JSON.stringify(keyboard);
      result = await tgSendMessage(chatId, text, extra);
    }

    res.json({ ok: true, result });
  } catch (e) {
    console.error('[Server] Send error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── API: Расширение → получить команды ───────────────────────────────────

app.get('/api/poll/:sessionId', authMiddleware, (req, res) => {
  const { sessionId } = req.params;

  const session = sessions.get(sessionId);
  if (!session) {
    return res.json({ ok: true, bound: false, commands: [] });
  }

  const commands = dequeueCommands(sessionId);
  res.json({ ok: true, bound: true, commands });
});

// ─── API: Расширение → статус привязки ────────────────────────────────────

app.get('/api/status/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  res.json({
    ok:    true,
    bound: !!session,
    boundAt: session?.boundAt || null,
  });
});

// ─── Регистрация webhook ───────────────────────────────────────────────────

app.post('/api/setup-webhook', async (req, res) => {
  const secret = req.headers['x-api-secret'];
  if (secret !== SECRET) return res.status(401).json({ ok: false });

  const webhookUrl = `${SERVER}/webhook`;
  const result = await tgRequest('setWebhook', {
    url:             webhookUrl,
    allowed_updates: ['message', 'callback_query'],
  });

  console.log('[Server] Webhook setup:', result);
  res.json(result);
});

// ─── Health check ──────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ ok: true, sessions: sessions.size });
});

// ─── Старт ────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
  console.log(`[Server] Set webhook: POST ${SERVER}/api/setup-webhook`);
});
