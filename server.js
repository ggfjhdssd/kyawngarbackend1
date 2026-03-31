/**
 * ============================================================
 *  KYAW NGAR MINING BACKEND  —  server.js  (ပြင်ဆင်ထားသောဗားရှင်း)
 *  ✅ Referral: Channel join ပြီးတာနဲ့ ချက်ချင်း 2000 ကျပ်
 *  ✅ Miner purchase: multer screenshot → sendPhoto to Admin
 *  ✅ Admin bot endpoints: addmoney / reducemoney / ban / unban
 * ============================================================
 */

const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
const crypto   = require('crypto');
const multer   = require('multer');
const fetch    = (...a) => import('node-fetch').then(({default: f}) => f(...a));

const app = express();
app.set('trust proxy', 1);

// ── CORS ──────────────────────────────────────────────────────
app.use(cors({
  origin: ['https://kyawngarfrontend1.vercel.app', 'http://localhost:3000', '*'],
  methods: ['GET','POST','PUT','DELETE','OPTIONS','PATCH'],
  allowedHeaders: ['Content-Type','X-Telegram-Init-Data','X-Admin-Key','X-Referral'],
  credentials: true
}));
app.options('*', cors());

// ── Multer (screenshot upload — memory storage) ───────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok = ['image/jpeg','image/jpg','image/png','image/webp','image/gif'];
    if (ok.includes(file.mimetype)) return cb(null, true);
    cb(new Error(`ပုံဖိုင်သာ တင်ခွင့်ရှိသည် (JPG/PNG/WEBP)`), false);
  }
});
const handleMulterErr = (err, req, res, next) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'ပုံဖိုင် 10MB ထက်ကြီးနေသည်' });
  if (err.message?.includes('ပုံဖိုင်')) return res.status(400).json({ error: err.message });
  next(err);
};

app.use(express.json({ limit: '5mb' }));

// ── Helpers ───────────────────────────────────────────────────
function escHTML(s) {
  return String(s||'')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

// ── Constants ─────────────────────────────────────────────────
const TASK_COOLDOWN_MS = 3 * 60 * 1000;
const MINE_RATE        = 1000;
const MINE_INTERVAL_MS = 10 * 60 * 1000;
const MIN_WITHDRAWAL   = 50000;
const INVITE_REWARD    = 2000;
const VALID_TASKS      = ['task1','task2','task3','task4','task5'];
const TASK_REWARDS     = { task1:300, task2:300, task3:300, task4:300, task5:300 };
const CHANNEL_ID       = process.env.CHANNEL_ID    || '@freeeemoneeeyi';
const BOT_URL          = process.env.BOT_URL        || 'http://localhost:3001'; // bot server URL
const SLOT_PRICES      = { 1: 20000, 2: 20000, 3: 20000 };

// ── MongoDB ────────────────────────────────────────────────────
let cachedDb = null, connProm = null;
async function connectDB() {
  if (cachedDb && mongoose.connection.readyState === 1) return cachedDb;
  if (connProm) return connProm;
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI not set');
  connProm = mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 30000, socketTimeoutMS: 60000,
    maxPoolSize: 5, minPoolSize: 1
  }).then(c => { cachedDb = c; connProm = null; console.log('✅ MongoDB connected'); return c; })
    .catch(e => { connProm = null; throw e; });
  return connProm;
}

// ── Schemas ───────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  userId:        { type: Number, required: true, unique: true },
  username:      String,
  firstName:     String,
  balance:       { type: Number, default: 0 },
  referralCode:  { type: String, unique: true, sparse: true },
  referredBy:    { type: Number, default: null },
  inviteCount:   { type: Number, default: 0 },
  taskCooldowns: { type: Map, of: Number, default: {} },
  banned:        { type: Boolean, default: false },
  banReason:     { type: String, default: '' },
  pendingRefCode:{ type: String, default: null },
  createdAt:     { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const minerSchema = new mongoose.Schema({
  userId:      { type: Number, required: true },
  slotIndex:   { type: Number, required: true },
  status:      { type: String, enum: ['pending','active','rejected','stopped'], default: 'pending' },
  grantedByAdmin: { type: Boolean, default: false },
  approvedAt:  { type: Number, default: 0 },
  lastCollect: { type: Number, default: 0 },
  totalEarned: { type: Number, default: 0 },
  createdAt:   { type: Date, default: Date.now }
});
minerSchema.index({ userId: 1, slotIndex: 1 }, { unique: true });
const Miner = mongoose.model('Miner', minerSchema);

const withdrawalSchema = new mongoose.Schema({
  userId:        { type: Number, required: true },
  firstName:     String,
  amount:        { type: Number, required: true },
  method:        { type: String, enum: ['kpay','wavepay'], required: true },
  accountNumber: { type: String, required: true },
  accountName:   String,
  status:        { type: String, enum: ['pending','approved','rejected'], default: 'pending' },
  rejectReason:  String,
  createdAt:     { type: Date, default: Date.now }
});
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);

const inviteSchema = new mongoose.Schema({
  inviterId:   { type: Number, required: true },
  inviteeId:   { type: Number, required: true, unique: true },
  inviteeName: String,
  reward:      { type: Number, default: INVITE_REWARD },
  createdAt:   { type: Date, default: Date.now }
});
const Invite = mongoose.model('Invite', inviteSchema);

// ── Telegram Bot API calls ────────────────────────────────────
async function botReq(method, params) {
  if (!process.env.BOT_TOKEN) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    const j = await r.json();
    if (!j.ok) console.warn(`botReq ${method}:`, JSON.stringify(j));
    return j;
  } catch (e) { console.warn('botReq error:', e.message); return null; }
}

async function sendTg(userId, text, extra = {}) {
  return botReq('sendMessage', { chat_id: userId, text, parse_mode: 'HTML', ...extra });
}

async function notifyAdmin(text) {
  if (!process.env.ADMIN_ID) return;
  return sendTg(process.env.ADMIN_ID, text);
}

async function notifyUser(userId, text) {
  return sendTg(userId, text);
}

// ── Call bot server to send photo to admin ────────────────────
async function sendPhotoToAdmin(userId, firstName, minerId, slotIndex, screenshotBuffer) {
  try {
    // Use Bot server's /send-miner-photo endpoint
    const base64 = screenshotBuffer.toString('base64');
    const r = await fetch(`${BOT_URL}/send-miner-photo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId, firstName, minerId,
        slotIndex, amount: SLOT_PRICES[slotIndex] || 0,
        screenshotBase64: base64
      }),
      timeout: 15000
    });
    const j = await r.json();
    return j.success;
  } catch (e) {
    console.warn('sendPhotoToAdmin error:', e.message);
    // Fallback: send text to admin
    await notifyAdmin(
      `⛏️ <b>Miner Purchase Request (No Photo)</b>\n` +
      `👤 ${escHTML(firstName)} (${userId})\n` +
      `🔢 Slot: #${slotIndex}\n` +
      `🛒 Miner ID: ${minerId}\n\n` +
      `✅ /approve_miner_${minerId}\n❌ /reject_miner_${minerId}`
    );
    return false;
  }
}

// ── isChannelMember ───────────────────────────────────────────
async function isChannelMember(userId) {
  try {
    const r = await botReq('getChatMember', { chat_id: CHANNEL_ID, user_id: userId });
    return ['member','administrator','creator'].includes(r?.result?.status);
  } catch { return false; }
}

// ── Parse Telegram initData ────────────────────────────────────
function parseTgUser(initData) {
  if (!initData) return null;
  try {
    const p = new URLSearchParams(initData);
    const u = p.get('user');
    return u ? JSON.parse(decodeURIComponent(u)) : null;
  } catch { return null; }
}

// ── Auth Middleware ───────────────────────────────────────────
async function authMiddleware(req, res, next) {
  try {
    await connectDB();
    const initData  = req.headers['x-telegram-init-data'] || '';
    const tgUser    = parseTgUser(initData);
    const isDev     = process.env.NODE_ENV === 'development';
    if (!tgUser && !isDev) return res.status(401).json({ error: 'Unauthorized' });

    const userId    = tgUser?.id        || 999999;
    const firstName = tgUser?.first_name || 'TestUser';
    const username  = tgUser?.username   || 'testuser';

    let user = await User.findOne({ userId });
    if (!user) {
      const refCode = crypto.randomBytes(5).toString('hex');
      user = await User.create({ userId, username, firstName, referralCode: refCode });
    }

    if (user.banned) return res.status(403).json({ error: 'Account ပိတ်ထားပါသည်', reason: user.banReason });
    req.tgUser = { id: userId, firstName, username };
    req.user   = user;
    next();
  } catch (e) {
    console.error('Auth error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
}

// ── Admin Middleware ──────────────────────────────────────────
async function adminMiddleware(req, res, next) {
  await connectDB();
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  next();
}

// ── computePendingEarnings ────────────────────────────────────
function computePendingEarnings(miner) {
  if (miner.status !== 'active' || !miner.lastCollect) return 0;
  const elapsed   = Date.now() - miner.lastCollect;
  const intervals = Math.floor(elapsed / MINE_INTERVAL_MS);
  return intervals * MINE_RATE;
}

// ============================================================
//  HEALTH
// ============================================================
app.get('/api/health', (_req, res) => res.json({
  status: 'ok', time: new Date().toISOString(),
  env: { mongoUri: !!process.env.MONGODB_URI, botToken: !!process.env.BOT_TOKEN }
}));

// ============================================================
//  BOT WEBHOOK  (Telegram webhook fallback if needed)
// ============================================================
app.post('/api/bot', async (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  if (!update) return;

  try {
    await connectDB();

    // ── Callback query ──────────────────────────────────────
    if (update.callback_query) {
      const cb        = update.callback_query;
      const chatId    = cb.message?.chat?.id;
      const userId    = cb.from?.id;
      const firstName = cb.from?.first_name || 'User';
      const data      = cb.data || '';

      await botReq('answerCallbackQuery', { callback_query_id: cb.id });

      // Channel join check (legacy webhook fallback)
      if (data === 'check_join') {
        const joined = await isChannelMember(userId);
        if (!joined) {
          await botReq('answerCallbackQuery', {
            callback_query_id: cb.id,
            text: '❌ Channel ကို Join မလုပ်ရသေးပါ!',
            show_alert: true
          });
          return;
        }
        botReq('deleteMessage', { chat_id: chatId, message_id: cb.message.message_id }).catch(() => {});

        let savedParam = '';
        try {
          const su = await User.findOne({ userId });
          savedParam = su?.pendingRefCode || '';
          if (su?.pendingRefCode) { su.pendingRefCode = null; await su.save(); }
        } catch {}

        if (savedParam) {
          await _processReferral(userId, firstName, savedParam);
        }
      }
      return;
    }

    const msg       = update.message;
    if (!msg) return;
    const chatId    = msg.chat?.id;
    const userId    = msg.from?.id;
    const firstName = msg.from?.first_name || 'User';
    const text      = msg.text || '';

    // ── Admin commands via webhook ──────────────────────────
    const ADMIN_ID = parseInt(process.env.ADMIN_ID);
    if (chatId === ADMIN_ID || chatId?.toString() === process.env.ADMIN_ID) {
      if (text.startsWith('/approve_miner_')) {
        const minerId = text.replace('/approve_miner_','').trim();
        await _approveMiner(minerId, ADMIN_ID);
        return;
      }
      if (text.startsWith('/reject_miner_')) {
        const minerId = text.replace('/reject_miner_','').trim();
        await _rejectMiner(minerId, ADMIN_ID);
        return;
      }
      if (text.startsWith('/approve_wd_')) {
        const wdId = text.replace('/approve_wd_','').trim();
        try {
          const w = await Withdrawal.findById(wdId);
          if (!w || w.status !== 'pending') { botReq('sendMessage',{chat_id:ADMIN_ID,text:'❌ မတွေ့ပါ'}); return; }
          w.status = 'approved'; await w.save();
          notifyUser(w.userId, `✅ ငွေထုတ်မှု ${w.amount.toLocaleString()} ကျပ် ခွင့်ပြုပြီးပါပြီ!`);
          botReq('sendMessage',{chat_id:ADMIN_ID,text:`✅ WD ခွင့်ပြုပြီး`});
        } catch {}
        return;
      }
      if (text.startsWith('/reject_wd_')) {
        const wdId = text.replace('/reject_wd_','').trim();
        try {
          const w = await Withdrawal.findById(wdId);
          if (!w || w.status !== 'pending') { botReq('sendMessage',{chat_id:ADMIN_ID,text:'❌ မတွေ့ပါ'}); return; }
          const u = await User.findOne({ userId: w.userId });
          if (u) { u.balance += w.amount; await u.save(); }
          w.status = 'rejected'; await w.save();
          notifyUser(w.userId, `❌ ငွေထုတ်မှု ငြင်းဆန်ခံရပါသည်။ ငွေ ${w.amount.toLocaleString()} ကျပ် ပြန်ထည့်ပြီး`);
          botReq('sendMessage',{chat_id:ADMIN_ID,text:`❌ WD ငြင်းဆန်ပြီး (Refunded)`});
        } catch {}
        return;
      }
    }

    // ── /start ──────────────────────────────────────────────
    if (text.startsWith('/start')) {
      const startParam = text.split(' ')[1] || '';
      const joined     = await isChannelMember(userId);

      if (!joined) {
        try {
          await User.updateOne({ userId },
            { $setOnInsert: { userId, firstName, username: msg.from?.username||'', referralCode: crypto.randomBytes(5).toString('hex') },
              $set: { pendingRefCode: startParam || null } },
            { upsert: true }
          );
        } catch {}
        await botReq('sendMessage', { chat_id: chatId,
          text: `မင်္ဂလာပါ <b>${escHTML(firstName)}</b>\n\nApp ကို အသုံးပြုရန် Channel ကို အရင် Join ဖြစ်ရပါမည်!`,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [
            [{ text: '📢 Channel Join မည်', url: process.env.CHANNEL_LINK || 'https://t.me/freeeemoneeeyi' }],
            [{ text: '✅ Join ပြီးပြီ', callback_data: 'check_join' }]
          ]}
        });
        return;
      }

      if (startParam) await _processReferral(userId, firstName, startParam);

      const appUrl = startParam ? `${process.env.WEB_APP_URL}?startapp=${startParam}` : process.env.WEB_APP_URL;
      botReq('sendMessage', { chat_id: chatId,
        text: `မင်္ဂလာပါ <b>${escHTML(firstName)}</b> ခင်ဗျာ! 🙏\nKyaw Ngar Mining မှ ကြိုဆိုပါတယ်။`,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🚀 Open App', web_app: { url: appUrl } }]] }
      });
    }

  } catch (e) {
    console.error('Webhook error:', e.message);
  }
});

// ── Internal: process referral award ─────────────────────────
async function _processReferral(inviteeId, inviteeName, refCode) {
  try {
    if (!refCode) return null;
    const refUser = await User.findOne({ referralCode: refCode });
    if (!refUser || refUser.userId === inviteeId) return null;

    const alreadyInvited = await Invite.findOne({ inviteeId });
    if (alreadyInvited) return null;

    refUser.balance    += INVITE_REWARD;
    refUser.inviteCount += 1;
    await refUser.save();

    const invitee = await User.findOne({ userId: inviteeId });
    if (invitee && !invitee.referredBy) {
      invitee.referredBy = refUser.userId; await invitee.save();
    }

    await Invite.create({ inviterId: refUser.userId, inviteeId, inviteeName, reward: INVITE_REWARD });

    // Notify referrer
    notifyUser(refUser.userId,
      `🎉 <b>သင်၏ Link မှတစ်ဆင့် ဝင်ရောက်လာသောကြောင့် ${INVITE_REWARD.toLocaleString()} ကျပ် ရရှိပါသည်</b>\n\n` +
      `👤 <b>${escHTML(inviteeName)}</b> သည် သင့် referral link မှ ဝင်ရောက်လာပါပြီ!\n` +
      `💰 ${INVITE_REWARD.toLocaleString()} ကျပ် ချက်ချင်းထည့်သွင်းပြီးပါပြီ!\n` +
      `👥 စုစုပေါင်း: ${refUser.inviteCount} ယောက်`
    ).catch(() => {});

    return refUser;
  } catch (e) {
    console.warn('_processReferral error:', e.message);
    return null;
  }
}

// ── Internal: approve/reject miner ────────────────────────────
async function _approveMiner(minerId, adminChatId) {
  try {
    const miner = await Miner.findById(minerId);
    if (!miner) { botReq('sendMessage',{chat_id:adminChatId,text:'❌ Miner မတွေ့ပါ'}); return; }
    miner.status = 'active'; miner.approvedAt = Date.now(); miner.lastCollect = Date.now();
    await miner.save();
    notifyUser(miner.userId,
      `✅ <b>Miner #${miner.slotIndex} Activate ပြုလုပ်ပြီးပါပြီ!</b>\n` +
      `Admin မှ confirm ပေးပါပြီ\nယခု ၁၀ မိနစ်တိုင်း 1,000 ကျပ် ⛏️💰`
    );
    botReq('sendMessage',{chat_id:adminChatId,text:`✅ Miner #${miner.slotIndex} ခွင့်ပြုပြီး (User: ${miner.userId})`});
  } catch (e) { botReq('sendMessage',{chat_id:adminChatId,text:'❌ Error: '+e.message}); }
}

async function _rejectMiner(minerId, adminChatId) {
  try {
    const miner = await Miner.findById(minerId);
    if (!miner) { botReq('sendMessage',{chat_id:adminChatId,text:'❌ Miner မတွေ့ပါ'}); return; }
    miner.status = 'rejected'; await miner.save();
    notifyUser(miner.userId,
      `❌ <b>Miner #${miner.slotIndex} ငြင်းဆန်ခံရပါသည်</b>\nScreenshot မှန်ကန်မှု စစ်ဆေးပြီး ထပ်မံ တင်ပေးပါ`
    );
    botReq('sendMessage',{chat_id:adminChatId,text:`❌ Miner #${miner.slotIndex} ငြင်းဆန်ပြီး`});
  } catch (e) { botReq('sendMessage',{chat_id:adminChatId,text:'❌ Error: '+e.message}); }
}

// ============================================================
//  BOT-SIDE ENDPOINTS (Bot server calls these)
// ============================================================

// Referral award — bot calls this when user clicks "Joined ✅"
app.post('/api/bot/referral-award', async (req, res) => {
  try {
    await connectDB();
    const { inviteeId, inviteeName, refCode } = req.body;
    if (!inviteeId || !refCode) return res.status(400).json({ error: 'Missing fields' });

    const refUser = await User.findOne({ referralCode: refCode });
    if (!refUser || refUser.userId === inviteeId) {
      return res.json({ success: false, reason: 'Invalid referral or self-referral' });
    }

    const alreadyInvited = await Invite.findOne({ inviteeId });
    if (alreadyInvited) {
      return res.json({ success: false, reason: 'Already invited' });
    }

    refUser.balance    += INVITE_REWARD;
    refUser.inviteCount += 1;
    await refUser.save();

    const invitee = await User.findOne({ userId: inviteeId });
    if (invitee && !invitee.referredBy) {
      invitee.referredBy = refUser.userId; await invitee.save();
    }

    await Invite.create({ inviterId: refUser.userId, inviteeId, inviteeName, reward: INVITE_REWARD });

    res.json({
      success: true,
      referrerId: refUser.userId,
      reward: INVITE_REWARD,
      newBalance: refUser.balance
    });
  } catch (e) {
    console.error('/api/bot/referral-award error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Save pending referral code (before channel join)
app.post('/api/bot/save-pending-ref', async (req, res) => {
  try {
    await connectDB();
    const { userId, firstName, username, refCode } = req.body;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    await User.updateOne({ userId },
      { $setOnInsert: {
          userId, firstName: firstName || '', username: username || '',
          referralCode: crypto.randomBytes(5).toString('hex')
        },
        $set: { pendingRefCode: refCode || null }
      },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get pending referral code
app.get('/api/bot/pending-ref/:userId', async (req, res) => {
  try {
    await connectDB();
    const user = await User.findOne({ userId: parseInt(req.params.userId) }).select('pendingRefCode');
    res.json({ refCode: user?.pendingRefCode || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Clear pending referral code
app.post('/api/bot/clear-pending-ref', async (req, res) => {
  try {
    await connectDB();
    await User.updateOne({ userId: req.body.userId }, { $set: { pendingRefCode: null } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
//  ADMIN BOT COMMANDS  (Bot calls these — no auth key needed
//   because only bot server calls them from localhost/internal)
// ============================================================
const botAdminRouter = express.Router();
// Shared secret for bot→backend calls
const BOT_INTERNAL_KEY = process.env.BOT_INTERNAL_KEY || 'kyawngar_internal_bot_key';

botAdminRouter.use((req, res, next) => {
  const key = req.headers['x-bot-key'] || req.body?.botKey;
  if (key !== BOT_INTERNAL_KEY && process.env.NODE_ENV !== 'development') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
});

// Approve miner (from bot inline button callback)
botAdminRouter.post('/miners/approve', async (req, res) => {
  try {
    await connectDB();
    const { minerId } = req.body;
    const miner = await Miner.findById(minerId);
    if (!miner) return res.status(404).json({ error: 'Miner not found' });
    miner.status = 'active'; miner.approvedAt = Date.now(); miner.lastCollect = Date.now();
    await miner.save();
    res.json({ success: true, slotIndex: miner.slotIndex, userId: miner.userId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Reject miner
botAdminRouter.post('/miners/reject', async (req, res) => {
  try {
    await connectDB();
    const { minerId } = req.body;
    const miner = await Miner.findById(minerId);
    if (!miner) return res.status(404).json({ error: 'Miner not found' });
    miner.status = 'rejected'; await miner.save();
    res.json({ success: true, slotIndex: miner.slotIndex, userId: miner.userId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// /addmoney
botAdminRouter.post('/addmoney', async (req, res) => {
  try {
    await connectDB();
    const { userId, amount } = req.body;
    if (!userId || !amount || isNaN(amount)) return res.status(400).json({ error: 'Invalid params' });
    const user = await User.findOneAndUpdate(
      { userId: Number(userId) },
      { $inc: { balance: Number(amount) } },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, newBalance: user.balance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// /reducemoney
botAdminRouter.post('/reducemoney', async (req, res) => {
  try {
    await connectDB();
    const { userId, amount } = req.body;
    if (!userId || !amount || isNaN(amount)) return res.status(400).json({ error: 'Invalid params' });
    const user = await User.findOne({ userId: Number(userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.balance < Number(amount)) return res.status(400).json({ error: 'Insufficient balance' });
    user.balance -= Number(amount); await user.save();
    res.json({ success: true, newBalance: user.balance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// /ban
botAdminRouter.post('/ban', async (req, res) => {
  try {
    await connectDB();
    const { userId, reason } = req.body;
    const user = await User.findOneAndUpdate(
      { userId: Number(userId) },
      { $set: { banned: true, banReason: reason || 'Admin စစ်ဆေး' } },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// /unban
botAdminRouter.post('/unban', async (req, res) => {
  try {
    await connectDB();
    const { userId } = req.body;
    const user = await User.findOneAndUpdate(
      { userId: Number(userId) },
      { $set: { banned: false, banReason: '' } },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// /userinfo
botAdminRouter.get('/userinfo/:userId', async (req, res) => {
  try {
    await connectDB();
    const user   = await User.findOne({ userId: Number(req.params.userId) }).select('-taskCooldowns');
    if (!user) return res.status(404).json({ error: 'Not found' });
    const activeMiners = await Miner.countDocuments({ userId: user.userId, status: 'active' });
    res.json({ success: true, user: { ...user.toObject(), activeMiners } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// /giveminer — Grant miner to user without payment (admin command)
botAdminRouter.post('/giveminer', async (req, res) => {
  try {
    await connectDB();
    const { userId, slotIndex } = req.body;
    if (!userId || ![1,2,3].includes(Number(slotIndex))) {
      return res.status(400).json({ error: 'Invalid params. slotIndex must be 1,2,3' });
    }

    // Check existing
    const existing = await Miner.findOne({ userId: Number(userId), slotIndex: Number(slotIndex) });
    if (existing && existing.status === 'active') {
      return res.status(400).json({ error: 'Miner already active for this slot' });
    }

    let miner;
    if (existing) {
      existing.status = 'active';
      existing.approvedAt = Date.now();
      existing.lastCollect = Date.now();
      existing.grantedByAdmin = true;
      await existing.save();
      miner = existing;
    } else {
      miner = await Miner.create({
        userId: Number(userId),
        slotIndex: Number(slotIndex),
        status: 'active',
        approvedAt: Date.now(),
        lastCollect: Date.now(),
        grantedByAdmin: true
      });
    }
    res.json({ success: true, minerId: miner._id, slotIndex: miner.slotIndex });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// /revokeminer — Revoke miner from user (admin command)
botAdminRouter.post('/revokeminer', async (req, res) => {
  try {
    await connectDB();
    const { userId, slotIndex } = req.body;
    if (!userId || ![1,2,3].includes(Number(slotIndex))) {
      return res.status(400).json({ error: 'Invalid params' });
    }
    const miner = await Miner.findOneAndUpdate(
      { userId: Number(userId), slotIndex: Number(slotIndex) },
      { $set: { status: 'stopped' } },
      { new: true }
    );
    if (!miner) return res.status(404).json({ error: 'Miner not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use('/api/admin/bot', botAdminRouter);

// ============================================================
//  USER
// ============================================================
app.get('/api/user', authMiddleware, async (req, res) => {
  try {
    const user   = req.user;
    const miners = await Miner.find({ userId: user.userId }).sort({ slotIndex: 1 });
    let liveEarnings = 0;
    for (const m of miners) liveEarnings += computePendingEarnings(m);

    const now = Date.now();
    const taskStatus = {};
    for (const tid of VALID_TASKS) {
      const last      = user.taskCooldowns?.get?.(tid) || 0;
      const remaining = Math.max(0, TASK_COOLDOWN_MS - (now - last));
      taskStatus[tid] = { remaining, canClaim: remaining === 0 };
    }

    res.json({
      userId:       user.userId,
      username:     user.username,
      firstName:    user.firstName,
      balance:      user.balance,
      liveEarnings,
      inviteCount:  user.inviteCount,
      referralCode: user.referralCode,
      taskStatus,
      miners: miners.map(m => ({
        id: m._id, slotIndex: m.slotIndex, status: m.status,
        approvedAt: m.approvedAt, lastCollect: m.lastCollect,
        totalEarned: m.totalEarned, pendingEarn: computePendingEarnings(m)
      }))
    });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ============================================================
//  MINERS — Purchase with Screenshot Upload
// ============================================================
app.post('/api/miners/purchase',
  authMiddleware,
  (req, res, next) => { upload.single('screenshot')(req, res, err => { if (err) return handleMulterErr(err, req, res, next); next(); }); },
  async (req, res) => {
    try {
      const slotIndex = Number(req.body.slotIndex);
      if (![1,2,3].includes(slotIndex)) return res.status(400).json({ error: 'Invalid slot' });
      if (!req.file) return res.status(400).json({ error: 'Screenshot ပုံ ပေးပို့ပါ' });

      const user = req.user;

      // Check existing
      const existing = await Miner.findOne({ userId: user.userId, slotIndex });
      if (existing && existing.status !== 'rejected') {
        return res.status(400).json({ error: 'ဒီ Slot ကို ဝယ်ပြီးသားဖြစ်သည် သို့မဟုတ် Pending ဖြစ်နေသည်' });
      }

      // Create/restore miner record
      let miner;
      if (existing?.status === 'rejected') {
        existing.status = 'pending'; existing.createdAt = new Date();
        await existing.save(); miner = existing;
      } else {
        miner = await Miner.create({ userId: user.userId, slotIndex });
      }

      // Send screenshot + approve/reject buttons to Admin via Bot server
      const photoSent = await sendPhotoToAdmin(
        user.userId, user.firstName, miner._id.toString(),
        slotIndex, req.file.buffer
      );

      // Notify user to wait
      notifyUser(user.userId,
        `⏳ <b>Miner #${slotIndex} — ဝယ်ယူမှု လက်ခံပြီးပါပြီ!</b>\n\n` +
        `Screenshot ကို Admin ထံ ${photoSent ? 'တိုက်ရိုက်' : ''} ပို့ပြီးပါပြီ\n` +
        `မကြာမီ Admin စစ်ဆေးပြီး Activate ပေးပါမည် 🙏`
      ).catch(() => {});

      res.json({
        success: true,
        miner: { id: miner._id, slotIndex, status: 'pending' },
        message: 'Screenshot Admin ထံ ပို့ပြီးပါပြီ။ စစ်ဆေးပြီး Activate ပေးပါမည်'
      });
    } catch (e) {
      console.error('Purchase error:', e.message);
      res.status(500).json({ error: 'Server error: ' + e.message });
    }
  }
);

app.post('/api/miners/collect', authMiddleware, async (req, res) => {
  try {
    const miners = await Miner.find({ userId: req.user.userId, status: 'active' });
    let totalEarned = 0;
    for (const miner of miners) {
      const elapsed   = Date.now() - miner.lastCollect;
      const intervals = Math.floor(elapsed / MINE_INTERVAL_MS);
      if (intervals > 0) {
        const earned      = intervals * MINE_RATE;
        totalEarned      += earned;
        miner.totalEarned += earned;
        miner.lastCollect  = miner.lastCollect + intervals * MINE_INTERVAL_MS;
        await miner.save();
      }
    }
    if (totalEarned > 0) { req.user.balance += totalEarned; await req.user.save(); }
    res.json({ success: true, earned: totalEarned, newBalance: req.user.balance });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ============================================================
//  ADMIN — Miners (REST API)
// ============================================================
app.post('/api/admin/miners/:minerId/approve', adminMiddleware, async (req, res) => {
  try {
    const miner = await Miner.findById(req.params.minerId);
    if (!miner) return res.status(404).json({ error: 'Miner not found' });
    miner.status = 'active'; miner.approvedAt = Date.now(); miner.lastCollect = Date.now();
    await miner.save();
    notifyUser(miner.userId,
      `✅ <b>Miner #${miner.slotIndex} Activate ပြုလုပ်ပြီးပါပြီ!</b>\nယခု ၁၀ မိနစ်တိုင်း 1,000 ကျပ် ⛏️💰`
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/miners/:minerId/reject', adminMiddleware, async (req, res) => {
  try {
    const miner = await Miner.findById(req.params.minerId);
    if (!miner) return res.status(404).json({ error: 'Miner not found' });
    miner.status = 'rejected'; await miner.save();
    notifyUser(miner.userId,
      `❌ <b>Miner #${miner.slotIndex} ငြင်းဆန်ခံရပါသည်</b>\nScreenshot ပြန်စစ်ဆေးပြီး တင်ပေးပါ`
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ============================================================
//  TASKS
// ============================================================
app.post('/api/tasks/claim', authMiddleware, async (req, res) => {
  try {
    const { taskId } = req.body;
    if (!VALID_TASKS.includes(taskId)) return res.status(400).json({ error: 'Invalid taskId' });

    const now       = Date.now();
    const lastClaim = req.user.taskCooldowns?.get?.(taskId) || 0;
    if (now - lastClaim < TASK_COOLDOWN_MS) {
      return res.status(400).json({ error: 'Cooldown active', remaining: TASK_COOLDOWN_MS-(now-lastClaim) });
    }

    const reward = TASK_REWARDS[taskId] || 300;
    req.user.balance += reward;
    if (!req.user.taskCooldowns) req.user.taskCooldowns = new Map();
    req.user.taskCooldowns.set(taskId, now);
    req.user.markModified('taskCooldowns');
    await req.user.save();
    res.json({ success: true, earned: reward, newBalance: req.user.balance });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ============================================================
//  WITHDRAWAL
// ============================================================
app.post('/api/withdraw', authMiddleware, async (req, res) => {
  try {
    const { amount, method, accountNumber, accountName } = req.body;
    const amt = Number(amount);
    if (isNaN(amt) || amt < MIN_WITHDRAWAL)
      return res.status(400).json({ error: `အနည်းဆုံး ${MIN_WITHDRAWAL.toLocaleString()} ကျပ် ရှိမှ ထုတ်နိုင်သည်` });
    if (!['kpay','wavepay'].includes(method)) return res.status(400).json({ error: 'Invalid method' });
    if (!accountNumber) return res.status(400).json({ error: 'Account number required' });
    if (req.user.balance < amt) return res.status(400).json({ error: 'လက်ကျန်ငွေ မလောက်ပါ' });

    req.user.balance -= amt; await req.user.save();
    const w = await Withdrawal.create({
      userId: req.user.userId, firstName: req.user.firstName,
      amount: amt, method, accountNumber, accountName, status: 'pending'
    });

    const mLabel = method === 'kpay' ? 'KBZ Pay' : 'Wave Pay';
    notifyAdmin(
      `💸 <b>ငွေထုတ်တောင်းဆိုမှု</b>\n` +
      `👤 ${escHTML(req.user.firstName)} (${req.user.userId})\n` +
      `💰 ${amt.toLocaleString()} ကျပ်\n` +
      `🏦 ${mLabel}: ${escHTML(accountNumber)}\n` +
      `👤 ${escHTML(accountName||'-')}\n\n` +
      `✅ /approve_wd_${w._id}\n❌ /reject_wd_${w._id}`
    );
    res.json({ success: true, newBalance: req.user.balance, withdrawalId: w._id });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ============================================================
//  INVITES
// ============================================================
app.get('/api/invites', authMiddleware, async (req, res) => {
  try {
    const invites = await Invite.find({ inviterId: req.user.userId }).sort({ createdAt: -1 }).limit(100);
    res.json({
      count: req.user.inviteCount,
      invites: invites.map(i => ({ name: i.inviteeName, reward: i.reward, date: i.createdAt }))
    });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ============================================================
//  ADMIN — Stats / Users
// ============================================================
app.get('/api/admin/stats', adminMiddleware, async (req, res) => {
  try {
    await connectDB();
    const [totalUsers, totalMiners, pendingWithdrawals, pendingMiners] = await Promise.all([
      User.countDocuments(),
      Miner.countDocuments({ status: 'active' }),
      Withdrawal.countDocuments({ status: 'pending' }),
      Miner.find({ status: 'pending' }).sort({ createdAt: -1 }).limit(20)
    ]);
    res.json({ totalUsers, activeMiners: totalMiners, pendingWithdrawals, pendingMiners });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/users', adminMiddleware, async (req, res) => {
  try {
    await connectDB();
    const users = await User.find().sort({ createdAt: -1 }).limit(200).select('-taskCooldowns');
    res.json({ users });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/users/:userId/ban', adminMiddleware, async (req, res) => {
  try {
    await connectDB();
    const user = await User.findOne({ userId: Number(req.params.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.banned = !user.banned; await user.save();
    res.json({ success: true, banned: user.banned });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Withdrawal actions
app.post('/api/admin/withdrawals/:id/approve', adminMiddleware, async (req, res) => {
  try {
    const w = await Withdrawal.findById(req.params.id);
    if (!w || w.status !== 'pending') return res.status(400).json({ error: 'Already processed' });
    w.status = 'approved'; await w.save();
    notifyUser(w.userId, `✅ ငွေထုတ်မှု ${w.amount.toLocaleString()} ကျပ် ခွင့်ပြုပြီးပါပြီ!`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/withdrawals/:id/reject', adminMiddleware, async (req, res) => {
  try {
    const { reason } = req.body;
    const w = await Withdrawal.findById(req.params.id);
    if (!w || w.status !== 'pending') return res.status(400).json({ error: 'Already processed' });
    const user = await User.findOne({ userId: w.userId });
    if (user) { user.balance += w.amount; await user.save(); }
    w.status = 'rejected'; w.rejectReason = reason || ''; await w.save();
    notifyUser(w.userId, `❌ ငွေထုတ်မှု ငြင်းဆန်ခံရပါသည်${reason?' ('+reason+')':''}။ ငွေပြန်ထည့်ပြီး`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Error Handler ─────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('Express error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Kyawngar backend running on port ${PORT}`));

module.exports = app;
