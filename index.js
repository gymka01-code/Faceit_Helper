import 'dotenv/config';
import express   from 'express';
import cors      from 'cors';
import FormData  from 'form-data';

const app    = express();
const PORT   = process.env.PORT   || 3000;
const TOKEN  = process.env.BOT_TOKEN;
const SECRET = process.env.API_SECRET;
const SERVER = process.env.SERVER_URL?.replace(/\/$/, '');

if (!TOKEN)  throw new Error('BOT_TOKEN not set in .env');
if (!SECRET) throw new Error('API_SECRET not set in .env');

app.use(cors());
app.use(express.json({ limit: '20mb' }));

// ─── Хранилище ─────────────────────────────────────────────────────────────

const sessions      = new Map(); // sessionId → { chatId, nickname, boundAt }
const commandQueues = new Map(); // sessionId → [{action, payload, timestamp}]
const settingsStore = new Map(); // sessionId → settings object

const DEFAULT_SETTINGS = {
  notifyMatchFound:    true,
  notifyLobby:         true,
  notifyVeto:          true,
  notifyBanScreenshots: true,
};

function getSettings(sessionId) {
  return { ...DEFAULT_SETTINGS, ...(settingsStore.get(sessionId) || {}) };
}

function saveSettings(sessionId, patch) {
  const current = getSettings(sessionId);
  const updated  = { ...current, ...patch };
  settingsStore.set(sessionId, updated);
  return updated;
}

// ─── Авторизация ───────────────────────────────────────────────────────────

function authMiddleware(req, res, next) {
  if (req.headers['x-api-secret'] !== SECRET)
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
}

// ─── Telegram helpers ──────────────────────────────────────────────────────

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
    method: 'POST', body: form,
  });
  return res.json();
}

async function tgAnswerCallback(id, text = '') {
  return tgRequest('answerCallbackQuery', { callback_query_id: id, text });
}

async function tgEditMessageReplyMarkup(chatId, messageId, replyMarkup) {
  return tgRequest('editMessageReplyMarkup', {
    chat_id: chatId, message_id: messageId, reply_markup: replyMarkup,
  });
}

async function tgEditMessageText(chatId, messageId, text, extra = {}) {
  return tgRequest('editMessageText', {
    chat_id: chatId, message_id: messageId, text, ...extra,
  });
}

// ─── Клавиатура настроек ───────────────────────────────────────────────────

function buildSettingsKeyboard(settings) {
  const on  = (v) => v ? '✅' : '☑️';
  return {
    inline_keyboard: [
      [{ text: `${on(settings.notifyMatchFound)} Матч найден`,    callback_data: 'SETTING:notifyMatchFound' }],
      [{ text: `${on(settings.notifyLobby)} Анализ лобби`,        callback_data: 'SETTING:notifyLobby' }],
      [{ text: `${on(settings.notifyVeto)} Фаза вето`,            callback_data: 'SETTING:notifyVeto' }],
      [{ text: `${on(settings.notifyBanScreenshots)} Скриншоты банов`, callback_data: 'SETTING:notifyBanScreenshots' }],
    ],
  };
}

function buildSettingsText(settings) {
  const s = (v) => v ? 'вкл' : '<b>выкл</b>';
  return [
    '⚙️ <b>Настройки уведомлений</b>',
    '',
    `🎮 Матч найден — ${s(settings.notifyMatchFound)}`,
    `📋 Анализ лобби — ${s(settings.notifyLobby)}`,
    `🗺️ Фаза вето — ${s(settings.notifyVeto)}`,
    `📸 Скриншоты банов — ${s(settings.notifyBanScreenshots)}`,
    '',
    'Нажми на кнопку чтобы переключить:',
  ].join('\n');
}

// ─── Очереди команд ────────────────────────────────────────────────────────

function enqueueCommand(sessionId, command) {
  if (!commandQueues.has(sessionId)) commandQueues.set(sessionId, []);
  const queue  = commandQueues.get(sessionId);
  const cutoff = Date.now() - 5 * 60 * 1000;
  queue.push({ ...command, timestamp: Date.now() });
  commandQueues.set(sessionId, queue.filter(c => c.timestamp > cutoff));
}

function dequeueCommands(sessionId) {
  const queue = commandQueues.get(sessionId) || [];
  commandQueues.set(sessionId, []);
  return queue;
}

// ─── Webhook ───────────────────────────────────────────────────────────────

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  if (update.callback_query) await handleCallbackQuery(update.callback_query);
  else if (update.message)   await handleMessage(update.message);
});

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text   = msg.text || '';

  if (text.startsWith('/start')) {
    const sessionId = text.split(' ')[1];
    if (sessionId && sessionId.length > 10) {
      sessions.set(sessionId, {
        chatId,
        nickname: msg.from.first_name || msg.from.username || 'User',
        boundAt:  Date.now(),
      });
      await tgSendMessage(chatId,
        `✅ <b>FACEIT Notifier подключён!</b>\n\nТеперь уведомления о матчах будут приходить сюда.\n\n/settings — настройки уведомлений\n/help — список команд`,
        { parse_mode: 'HTML' });
      return;
    }
    await tgSendMessage(chatId,
      `👋 Привет! Я FACEIT Notifier.\n\nЧтобы привязать расширение:\n1. Установи расширение в браузер\n2. Нажми кнопку "Подключить Telegram"\n\n/help — список команд`,
      { parse_mode: 'HTML' });
    return;
  }

  if (text === '/help') {
    await tgSendMessage(chatId,
      `📖 <b>Команды</b>\n\n/settings — настройки уведомлений\n/status — статус подключения\n/unbind — отвязать расширение\n/help — эта справка`,
      { parse_mode: 'HTML' });
    return;
  }

  if (text === '/settings') {
    const entry = [...sessions.entries()].find(([, v]) => v.chatId === chatId);
    if (!entry) {
      await tgSendMessage(chatId, '❌ Расширение не привязано.');
      return;
    }
    const [sessionId] = entry;
    const settings = getSettings(sessionId);
    await tgSendMessage(chatId, buildSettingsText(settings), {
      parse_mode:   'HTML',
      reply_markup: JSON.stringify(buildSettingsKeyboard(settings)),
    });
    return;
  }

  if (text === '/status') {
    const entry = [...sessions.entries()].find(([, v]) => v.chatId === chatId);
    if (entry) {
      const [sessionId, data] = entry;
      const boundDate = new Date(data.boundAt).toLocaleString('ru-RU');
      await tgSendMessage(chatId,
        `✅ <b>Подключено</b>\nSession: <code>${sessionId.slice(0, 8)}…</code>\nПривязано: ${boundDate}`,
        { parse_mode: 'HTML' });
    } else {
      await tgSendMessage(chatId, '❌ Расширение не привязано.');
    }
    return;
  }

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
  const data      = cq.data;

  await tgAnswerCallback(cq.id);

  const entry = [...sessions.entries()].find(([, v]) => v.chatId === chatId);
  if (!entry) {
    await tgSendMessage(chatId, '❌ Расширение не привязано.');
    return;
  }

  const [sessionId] = entry;

  // Переключение настройки
  if (data.startsWith('SETTING:')) {
    const key      = data.split(':')[1];
    const current  = getSettings(sessionId);
    const updated  = saveSettings(sessionId, { [key]: !current[key] });

    // Обновляем сообщение с настройками
    try {
      await tgEditMessageText(chatId, messageId, buildSettingsText(updated), {
        parse_mode:   'HTML',
        reply_markup: JSON.stringify(buildSettingsKeyboard(updated)),
      });
    } catch (_) {}

    // Посылаем команду расширению обновить настройки
    enqueueCommand(sessionId, { action: 'SETTINGS_UPDATED', payload: JSON.stringify(updated) });
    return;
  }

  // Остальные команды
  const [action, payload] = data.split(':', 2);
  enqueueCommand(sessionId, { action, payload });

  const shouldRemoveButtons = ['ACCEPT_MATCH', 'BAN_MAP', 'BAN_SERVER', 'PICK_MAP'].includes(action);
  if (shouldRemoveButtons) {
    try { await tgEditMessageReplyMarkup(chatId, messageId, { inline_keyboard: [] }); } catch (_) {}
  }

  const confirmMessages = {
    ACCEPT_MATCH: '⏳ Принимаю матч...',
    BAN_MAP:      `⏳ Баню карту ${payload}...`,
    BAN_SERVER:   `⏳ Баню сервер ${payload}...`,
    PICK_MAP:     `⏳ Пикаю карту ${payload}...`,
    OPEN_ROOM:    '🔗 Открываю комнату в браузере...',
  };
  const confirmText = confirmMessages[action];
  if (confirmText) await tgSendMessage(chatId, confirmText);
}

// ─── API: send ──────────────────────────────────────────────────────────────

app.post('/api/send', authMiddleware, async (req, res) => {
  const { sessionId, type, text, photo, caption, keyboard } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });

  try {
    let result;
    if (type === 'photo' && photo) {
      result = await tgSendPhoto(session.chatId, Buffer.from(photo, 'base64'), caption || '');
    } else {
      const extra = { parse_mode: 'HTML' };
      if (keyboard) extra.reply_markup = JSON.stringify(keyboard);
      result = await tgSendMessage(session.chatId, text, extra);
    }
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── API: poll ──────────────────────────────────────────────────────────────

app.get('/api/poll/:sessionId', authMiddleware, (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (!session) return res.json({ ok: true, bound: false, commands: [], settings: DEFAULT_SETTINGS });

  const commands = dequeueCommands(sessionId);
  const settings = getSettings(sessionId);
  res.json({ ok: true, bound: true, commands, settings });
});

// ─── API: status ────────────────────────────────────────────────────────────

app.get('/api/status/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  res.json({ ok: true, bound: !!session, boundAt: session?.boundAt || null });
});

// ─── API: settings ──────────────────────────────────────────────────────────

app.get('/api/settings/:sessionId', authMiddleware, (req, res) => {
  res.json({ ok: true, settings: getSettings(req.params.sessionId) });
});

app.post('/api/settings/:sessionId', authMiddleware, (req, res) => {
  const updated = saveSettings(req.params.sessionId, req.body);
  res.json({ ok: true, settings: updated });
});

// ─── API: setup-webhook ─────────────────────────────────────────────────────

app.post('/api/setup-webhook', async (req, res) => {
  if (req.headers['x-api-secret'] !== SECRET) return res.status(401).json({ ok: false });
  const result = await tgRequest('setWebhook', {
    url: `${SERVER}/webhook`,
    allowed_updates: ['message', 'callback_query'],
  });
  console.log('[Server] Webhook setup:', result);
  res.json(result);
});

// ─── Health ─────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.json({ ok: true, sessions: sessions.size }));

app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
});
