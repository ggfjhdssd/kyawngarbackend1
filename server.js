const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1);

// ==================== CORS & Middleware ====================
app.use(cors({
    origin: ['https://kyawngarfrontend1.vercel.app', 'http://localhost:3000', '*'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'X-Telegram-Init-Data', 'X-Admin-Key', 'X-Referral'],
    credentials: true
}));
app.options('*', cors());
app.use(express.json({ limit: '5mb' }));

// ==================== Helpers ====================
function escapeHTML(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;')
        .replace(/\*/g, '&#42;').replace(/_/g, '&#95;');
}

// ==================== Config Constants ====================
const TASK_COOLDOWN_MS  = 3 * 60 * 1000;
const MINE_RATE         = 300;
const MINE_INTERVAL_MS  = 10 * 60 * 1000;
const MIN_WITHDRAWAL    = 50000;
const INVITE_REWARD     = 2000;
const VALID_TASKS       = ['task1', 'task2', 'task3', 'task4', 'task5'];
const TASK_REWARDS      = { task1: 300, task2: 300, task3: 300, task4: 300, task5: 300 };
const CHANNEL_USERNAME  = '@freeeemoneeeyi';
const CHANNEL_LINK      = 'https://t.me/freeeemoneeeyi';
const APP_URL           = 'https://kyawngarfrontend1.vercel.app';

// ==================== MongoDB ====================
let cachedDb = null;
let connectionPromise = null;

async function connectDB() {
    if (cachedDb && mongoose.connection.readyState === 1) return cachedDb;
    if (connectionPromise) return connectionPromise;
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI not set');
    connectionPromise = mongoose.connect(process.env.MONGODB_URI, {
        serverSelectionTimeoutMS: 30000,
        socketTimeoutMS: 60000,
        maxPoolSize: 5,
        minPoolSize: 1
    }).then(conn => {
        cachedDb = conn;
        connectionPromise = null;
        console.log('✅ MongoDB connected');
        return conn;
    }).catch(err => {
        connectionPromise = null;
        console.error('❌ MongoDB error:', err.message);
        throw err;
    });
    return connectionPromise;
}

// ==================== Schemas ====================
const userSchema = new mongoose.Schema({
    userId:           { type: Number, required: true, unique: true },
    username:         String,
    firstName:        String,
    balance:          { type: Number, default: 0 },
    referralCode:     { type: String, unique: true, sparse: true },
    referredBy:       { type: Number, default: null },
    inviteCount:      { type: Number, default: 0 },
    taskCooldowns:    { type: Map, of: Number, default: {} },
    banned:           { type: Boolean, default: false },
    pendingRefCode:   { type: String, default: null },  // persisted referral code while user joins channel
    createdAt:        { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const minerSchema = new mongoose.Schema({
    userId:      { type: Number, required: true },
    slotIndex:   { type: Number, required: true },
    status:      { type: String, enum: ['pending', 'active', 'rejected', 'stopped'], default: 'pending' },
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
    method:        { type: String, enum: ['kpay', 'wavepay'], required: true },
    accountNumber: { type: String, required: true },
    accountName:   String,
    status:        { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
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

// ==================== Bot Helpers ====================
// pendingStartParams removed — now persisted in User.pendingRefCode (DB-backed, survives restarts)

async function botRequest(method, params) {
    if (!process.env.BOT_TOKEN) return null;
    try {
        const r = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });
        const json = await r.json();
        if (!json.ok) console.warn(`botRequest ${method} failed:`, JSON.stringify(json));
        return json;
    } catch (e) {
        console.warn('botRequest error:', e.message);
        return null;
    }
}

async function isChannelMember(userId) {
    try {
        const res = await botRequest('getChatMember', {
            chat_id: CHANNEL_USERNAME,
            user_id: userId
        });
        if (!res || !res.ok) return false;
        const status = res.result?.status;
        return ['member', 'administrator', 'creator'].includes(status);
    } catch (e) {
        console.warn('isChannelMember error:', e.message);
        return false;
    }
}

async function sendChannelJoinMsg(chatId, firstName) {
    return botRequest('sendMessage', {
        chat_id: chatId,
        text:
            `မင်္ဂလာပါ <b>${escapeHTML(firstName)}</b> ✋\n\n` +
            `🚫 App ကိုသုံးရန် ကျွန်ုပ်တို့၏ Channel ကို အရင် <b>Join</b> ဖြစ်ရပါမည်!\n\n` +
            `👇 အောက်က ခလုတ်နှိပ်ပြီး Channel Join ပြုလုပ်ပါ၊ ပြီးရင် ✅ ခလုတ်နှိပ်ပါ`,
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{ text: '📢 Channel Join မည်', url: CHANNEL_LINK }],
                [{ text: '✅ Join ပြီးပြီ — ဆက်သွားမည်', callback_data: 'check_join' }]
            ]
        }
    });
}

async function sendWelcomeMsg(chatId, firstName, startParam) {
    const appUrl = startParam ? `${APP_URL}?startapp=${startParam}` : APP_URL;
    return botRequest('sendMessage', {
        chat_id: chatId,
        text:
            `မင်္ဂလာပါ <b>${escapeHTML(firstName)}</b> ခင်ဗျာ! 🙏\n` +
            `<b>Kyaw Ngar Mining</b> မှ ကြိုဆိုပါတယ်။\n\n` +
            `ကျွန်ုပ်တို့၏ Mini App တွင် အောက်ပါတို့ကို လုပ်ဆောင်ပြီး ငွေရှာနိုင်ပါသည်\n` +
            `──────────────────\n` +
            `⛏️ <b>Miner ဝယ်ယူခြင်း:</b> ၁၀ မိနစ်လျှင် ၃၀၀ ကျပ် နှုန်းဖြင့် အလိုအလျောက် ငွေရှာပေးမည်\n\n` +
            `📺 <b>Tasks:</b> ကြော်ငြာကြည့်ပြီး တစ်ကြိမ်လျှင် ၃၀၀ ကျပ် ရယူပါ။\n\n` +
            `👥 <b>Referral:</b> သူငယ်ချင်းကို ဖိတ်ခေါ်ပြီး တစ်ယောက်လျှင် ၂၀၀၀ ကျပ် လက်ဆောင်ရယူပါ။\n\n` +
            `💸 <b>Withdraw:</b> အနည်းဆုံး ၅၀,၀၀၀ ကျပ် ပြည့်ပါက KPay / WavePay ဖြင့် ထုတ်ယူနိုင်ပါသည်\n` +
            `──────────────────\n` +
            `အောက်က "<b>Open App</b>" ခလုတ်ကိုနှိပ်ပြီး အခုပဲ စတင်လိုက်ပါ။ 👇`,
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [[
                { text: '🚀 Open App', web_app: { url: appUrl } }
            ]]
        }
    });
}

async function notifyAdmin(text) {
    if (!process.env.BOT_TOKEN || !process.env.ADMIN_ID) return;
    return botRequest('sendMessage', { chat_id: process.env.ADMIN_ID, text, parse_mode: 'HTML' });
}

async function notifyUser(userId, text) {
    if (!process.env.BOT_TOKEN) return;
    return botRequest('sendMessage', { chat_id: userId, text });
}

// ==================== Parse Telegram InitData ====================
function parseTelegramUser(initData) {
    if (!initData) return null;
    try {
        const p = new URLSearchParams(initData);
        const userStr = p.get('user');
        if (!userStr) return null;
        return JSON.parse(decodeURIComponent(userStr));
    } catch { return null; }
}

// ==================== Auth Middleware ====================
async function authMiddleware(req, res, next) {
    try {
        await connectDB();
        const initData  = req.headers['x-telegram-init-data'] || '';
        const tgUser    = parseTelegramUser(initData);
        const isDev     = process.env.NODE_ENV === 'development';
        if (!tgUser && !isDev) return res.status(401).json({ error: 'Unauthorized' });

        const userId    = tgUser?.id        || 999999;
        const firstName = tgUser?.first_name || 'TestUser';
        const username  = tgUser?.username   || 'testuser';

        let user = await User.findOne({ userId });
        if (!user) {
            const refCode  = req.headers['x-referral'] || '';
            let referredBy = null;
            if (refCode) {
                const refUser = await User.findOne({ referralCode: refCode });
                if (refUser && refUser.userId !== userId) {
                    referredBy = refUser.userId;
                    refUser.balance    += INVITE_REWARD;
                    refUser.inviteCount += 1;
                    await refUser.save();
                    await Invite.create({ inviterId: refUser.userId, inviteeId: userId, inviteeName: firstName });
                    notifyUser(refUser.userId,
                        `🎉 ${firstName} သည် သင့် referral link မှ ဝင်ရောက်လာပါပြီ!\n` +
                        `💰 သင် ${INVITE_REWARD.toLocaleString()} ကျပ် ရရှိပါပြီ!\n` +
                        `👥 စုစုပေါင်း ဖိတ်ကြားထားသူ: ${refUser.inviteCount} ယောက်`
                    ).catch(() => {});
                }
            }
            const referralCode = crypto.randomBytes(5).toString('hex');
            user = await User.create({ userId, username, firstName, referralCode, referredBy });
        }

        if (user.banned) return res.status(403).json({ error: 'Banned' });
        req.tgUser = { id: userId, firstName, username };
        req.user   = user;
        next();
    } catch (err) {
        console.error('Auth error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
}

// ==================== Admin Middleware ====================
async function adminMiddleware(req, res, next) {
    await connectDB();
    const key = req.headers['x-admin-key'];
    if (!key || key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
    next();
}

// ==================== Compute Pending Earnings ====================
function computePendingEarnings(miner) {
    if (miner.status !== 'active' || !miner.lastCollect) return 0;
    const elapsed   = Date.now() - miner.lastCollect;
    const intervals = Math.floor(elapsed / MINE_INTERVAL_MS);
    return intervals * MINE_RATE;
}

// ==================== HEALTH ====================
app.get('/api/health', (req, res) => res.json({
    status: 'ok',
    time: new Date().toISOString(),
    env: {
        mongoUri: !!process.env.MONGODB_URI,
        botToken: !!process.env.BOT_TOKEN,
        adminId:  !!process.env.ADMIN_ID,
        adminKey: !!process.env.ADMIN_KEY
    }
}));

// ==================== TELEGRAM BOT WEBHOOK ====================
app.post('/api/bot', async (req, res) => {
    res.sendStatus(200); // Ack immediately — Telegram requires fast response
    const update = req.body;
    if (!update) return;

    console.log('Bot update:', JSON.stringify(update).substring(0, 300));

    try {
        await connectDB();

        // ── Callback query (inline button) ──
        if (update.callback_query) {
            const cb        = update.callback_query;
            const chatId    = cb.message?.chat?.id;
            const userId    = cb.from?.id;
            const firstName = cb.from?.first_name || 'User';

            await botRequest('answerCallbackQuery', { callback_query_id: cb.id });

            if (cb.data === 'check_join') {
                const joined = await isChannelMember(userId);
                if (joined) {
                    await botRequest('deleteMessage', {
                        chat_id: chatId,
                        message_id: cb.message.message_id
                    }).catch(() => {});
                    // Retrieve saved referral code from DB
                    let savedParam = '';
                    try {
                        const savedUser = await User.findOne({ userId });
                        savedParam = savedUser?.pendingRefCode || '';
                        if (savedUser && savedUser.pendingRefCode) {
                            savedUser.pendingRefCode = null;
                            await savedUser.save();
                        }
                    } catch (e) {}

                    // Award referral if applicable
                    if (savedParam) {
                        try {
                            const existing = await User.findOne({ userId });
                            if (!existing || !existing.referredBy) {
                                const refUser = await User.findOne({ referralCode: savedParam });
                                if (refUser && refUser.userId !== userId) {
                                    const alreadyInvited = await Invite.findOne({ inviteeId: userId });
                                    if (!alreadyInvited) {
                                        refUser.balance    += INVITE_REWARD;
                                        refUser.inviteCount += 1;
                                        await refUser.save();
                                        await Invite.create({ inviterId: refUser.userId, inviteeId: userId, inviteeName: firstName });
                                        if (existing) { existing.referredBy = refUser.userId; await existing.save(); }
                                        notifyUser(refUser.userId,
                                            `🎉 ${firstName} သည် သင့် referral link မှ ဝင်ရောက်လာပါပြီ!\n` +
                                            `💰 သင် ${INVITE_REWARD.toLocaleString()} ကျပ် ရရှိပါပြီ!\n` +
                                            `👥 စုစုပေါင်း ဖိတ်ကြားထားသူ: ${refUser.inviteCount} ယောက်`
                                        ).catch(() => {});
                                    }
                                }
                            }
                        } catch (e) { console.warn('Referral award error:', e.message); }
                    }
                    await sendWelcomeMsg(chatId, firstName, savedParam);
                } else {
                    await botRequest('answerCallbackQuery', {
                        callback_query_id: cb.id,
                        text: '❌ Channel ကို Join မလုပ်ရသေးပါ! Join လုပ်ပြီးမှ ထပ်နှိပ်ပါ။',
                        show_alert: true
                    });
                }
            }
            return;
        }

        const msg = update.message;
        if (!msg) return;

        const chatId    = msg.chat?.id;
        const userId    = msg.from?.id;
        const firstName = msg.from?.first_name || 'User';
        const text      = msg.text || '';

        // ── Photo (miner payment screenshot) ──
        if (msg.photo) {
            const photoId = msg.photo[msg.photo.length - 1].file_id;
            if (process.env.ADMIN_ID) {
                await botRequest('sendPhoto', {
                    chat_id: process.env.ADMIN_ID,
                    photo: photoId,
                    caption:
                        `📸 <b>Miner ငွေပေးချေမှု Screenshot</b>\n` +
                        `👤 User: <b>${escapeHTML(firstName)}</b> (${userId})\n` +
                        `📝 Caption: ${escapeHTML(msg.caption || '-')}`,
                    parse_mode: 'HTML'
                });
            }
            await botRequest('sendMessage', {
                chat_id: chatId,
                text:
                    `✅ Screenshot ကို Admin ထံ ပေးပို့ပြီးပါပြီ!\n` +
                    `⏳ Admin စစ်ဆေးပြီးနောက် မိုင်နာ activate လုပ်ပေးပါမည်။\n` +
                    `(ပုံမှန်အားဖြင့် ၃၀ မိနစ် - ၁ နာရီ ကြာနိုင်ပါသည်)`
            });
            return;
        }

        // ── /start command ──
        if (text.startsWith('/start')) {
            const parts      = text.split(' ');
            const startParam = parts[1] || '';

            const joined = await isChannelMember(userId);
            if (!joined) {
                // Persist referral code to DB (survives server restarts)
                try {
                    await User.updateOne(
                        { userId },
                        { $setOnInsert: { userId, firstName, username: msg.from?.username || '', referralCode: require('crypto').randomBytes(5).toString('hex') },
                          $set: { pendingRefCode: startParam || null } },
                        { upsert: true }
                    );
                } catch (e) { console.warn('Save pendingRefCode error:', e.message); }
                await sendChannelJoinMsg(chatId, firstName);
            } else {
                // Handle referral — check startParam OR saved pendingRefCode from DB
                let refCodeToUse = startParam;
                if (!refCodeToUse) {
                    try {
                        const savedUser = await User.findOne({ userId });
                        refCodeToUse = savedUser?.pendingRefCode || '';
                        if (savedUser && savedUser.pendingRefCode) {
                            savedUser.pendingRefCode = null;
                            await savedUser.save();
                        }
                    } catch (e) {}
                }
                if (refCodeToUse) {
                    try {
                        const existing = await User.findOne({ userId });
                        if (!existing || !existing.referredBy) {
                            const refUser = await User.findOne({ referralCode: refCodeToUse });
                            if (refUser && refUser.userId !== userId) {
                                const alreadyInvited = await Invite.findOne({ inviteeId: userId });
                                if (!alreadyInvited) {
                                    refUser.balance    += INVITE_REWARD;
                                    refUser.inviteCount += 1;
                                    await refUser.save();
                                    await Invite.create({ inviterId: refUser.userId, inviteeId: userId, inviteeName: firstName });
                                    if (existing) { existing.referredBy = refUser.userId; await existing.save(); }
                                    notifyUser(refUser.userId,
                                        `🎉 ${firstName} သည် သင့် referral link မှ ဝင်ရောက်လာပါပြီ!\n` +
                                        `💰 သင် ${INVITE_REWARD.toLocaleString()} ကျပ် ရရှိပါပြီ!\n` +
                                        `👥 စုစုပေါင်း ဖိတ်ကြားထားသူ: ${refUser.inviteCount} ယောက်`
                                    ).catch(() => {});
                                }
                            }
                        }
                    } catch (e) { console.warn('Referral via bot error:', e.message); }
                }
                await sendWelcomeMsg(chatId, firstName, refCodeToUse || startParam);
            }
            return;
        }

        // ── Admin commands ──
        if (process.env.ADMIN_ID && chatId.toString() === process.env.ADMIN_ID.toString()) {

            if (text.startsWith('/approve_miner_')) {
                const minerId = text.replace('/approve_miner_', '').trim();
                try {
                    const miner = await Miner.findById(minerId);
                    if (!miner) { await botRequest('sendMessage', { chat_id: chatId, text: '❌ Miner မတွေ့ပါ' }); return; }
                    miner.status = 'active'; miner.approvedAt = Date.now(); miner.lastCollect = Date.now();
                    await miner.save();
                    await notifyUser(miner.userId, `✅ သင့်မိုင်နာ #${miner.slotIndex} ကို admin ခွင့်ပြုပြီးပါပြီ!\nယခု 10 မိနစ်တိုင်း 300 ကျပ် ရရှိမည်။`);
                    await botRequest('sendMessage', { chat_id: chatId, text: `✅ Miner #${miner.slotIndex} (User: ${miner.userId}) ခွင့်ပြုပြီး` });
                } catch (e) { await botRequest('sendMessage', { chat_id: chatId, text: '❌ Error: ' + e.message }); }
                return;
            }

            if (text.startsWith('/reject_miner_')) {
                const minerId = text.replace('/reject_miner_', '').trim();
                try {
                    const miner = await Miner.findById(minerId);
                    if (!miner) { await botRequest('sendMessage', { chat_id: chatId, text: '❌ Miner မတွေ့ပါ' }); return; }
                    miner.status = 'rejected'; await miner.save();
                    await notifyUser(miner.userId, `❌ သင့်မိုင်နာ #${miner.slotIndex} တောင်းဆိုမှု ငြင်းဆန်ခံရပါသည်။`);
                    await botRequest('sendMessage', { chat_id: chatId, text: `❌ Miner #${miner.slotIndex} ငြင်းဆန်ပြီး` });
                } catch (e) { await botRequest('sendMessage', { chat_id: chatId, text: '❌ Error: ' + e.message }); }
                return;
            }

            if (text.startsWith('/approve_wd_')) {
                const wdId = text.replace('/approve_wd_', '').trim();
                try {
                    const w = await Withdrawal.findById(wdId);
                    if (!w || w.status !== 'pending') { await botRequest('sendMessage', { chat_id: chatId, text: '❌ မတွေ့ပါ သို့မဟုတ် ပြီးပြီ' }); return; }
                    w.status = 'approved'; await w.save();
                    await notifyUser(w.userId, `✅ သင့်ငွေထုတ်မှု ${w.amount.toLocaleString()} MMK ကို admin ခွင့်ပြုပြီးပါပြီ!`);
                    await botRequest('sendMessage', { chat_id: chatId, text: `✅ Withdrawal ${w.amount.toLocaleString()} MMK ခွင့်ပြုပြီး` });
                } catch (e) { await botRequest('sendMessage', { chat_id: chatId, text: '❌ Error: ' + e.message }); }
                return;
            }

            if (text.startsWith('/reject_wd_')) {
                const wdId = text.replace('/reject_wd_', '').trim();
                try {
                    const w = await Withdrawal.findById(wdId);
                    if (!w || w.status !== 'pending') { await botRequest('sendMessage', { chat_id: chatId, text: '❌ မတွေ့ပါ သို့မဟုတ် ပြီးပြီ' }); return; }
                    const user = await User.findOne({ userId: w.userId });
                    if (user) { user.balance += w.amount; await user.save(); }
                    w.status = 'rejected'; w.rejectReason = ''; await w.save();
                    await notifyUser(w.userId, `❌ သင့်ငွေထုတ်မှု ${w.amount.toLocaleString()} MMK ငြင်းဆန်ခံရပါသည်။ ငွေကိုပြန်ထည့်ပေးပါပြီ။`);
                    await botRequest('sendMessage', { chat_id: chatId, text: `❌ Withdrawal ${w.amount.toLocaleString()} MMK ငြင်းဆန်ပြီး (Refunded)` });
                } catch (e) { await botRequest('sendMessage', { chat_id: chatId, text: '❌ Error: ' + e.message }); }
                return;
            }
        }

    } catch (e) {
        console.error('Bot webhook error:', e.message, e.stack);
    }
});

// ==================== USER ====================
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
                id:          m._id,
                slotIndex:   m.slotIndex,
                status:      m.status,
                approvedAt:  m.approvedAt,
                lastCollect: m.lastCollect,
                totalEarned: m.totalEarned,
                pendingEarn: computePendingEarnings(m)
            }))
        });
    } catch (err) {
        console.error('GET /api/user error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== MINERS ====================
app.post('/api/miners/purchase', authMiddleware, async (req, res) => {
    try {
        const { slotIndex } = req.body;
        if (![1, 2, 3].includes(Number(slotIndex))) return res.status(400).json({ error: 'Invalid slot' });

        const existing = await Miner.findOne({ userId: req.user.userId, slotIndex: Number(slotIndex) });
        if (existing && existing.status !== 'rejected') {
            return res.status(400).json({ error: 'Slot already purchased or pending' });
        }

        let miner;
        if (existing && existing.status === 'rejected') {
            existing.status = 'pending'; existing.createdAt = new Date();
            await existing.save(); miner = existing;
        } else {
            miner = await Miner.create({ userId: req.user.userId, slotIndex: Number(slotIndex) });
        }

        const user = req.user;
        await notifyAdmin(
            `⛏️ <b>မိုင်နာဝယ်ယူမည်</b>\n` +
            `👤 User: ${escapeHTML(user.firstName)} (${user.userId})\n` +
            `🔢 Slot: #${slotIndex}\n\n` +
            `✅ Approve: /approve_miner_${miner._id}\n` +
            `❌ Reject: /reject_miner_${miner._id}`
        );

        res.json({ success: true, miner: { id: miner._id, slotIndex, status: 'pending' } });
    } catch (err) {
        console.error('POST /api/miners/purchase error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

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
    } catch (err) {
        console.error('POST /api/miners/collect error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== ADMIN — Miners ====================
app.post('/api/admin/miners/:minerId/approve', adminMiddleware, async (req, res) => {
    try {
        const miner = await Miner.findById(req.params.minerId);
        if (!miner) return res.status(404).json({ error: 'Miner not found' });
        miner.status = 'active'; miner.approvedAt = Date.now(); miner.lastCollect = Date.now();
        await miner.save();
        await notifyUser(miner.userId, `✅ သင့်မိုင်နာ #${miner.slotIndex} ကို admin ခွင့်ပြုပြီးပါပြီ!\nယခု 10 မိနစ်တိုင်း 300 ကျပ် ရရှိမည်။`);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/miners/:minerId/reject', adminMiddleware, async (req, res) => {
    try {
        const miner = await Miner.findById(req.params.minerId);
        if (!miner) return res.status(404).json({ error: 'Miner not found' });
        miner.status = 'rejected'; await miner.save();
        await notifyUser(miner.userId, `❌ သင့်မိုင်နာ #${miner.slotIndex} တောင်းဆိုမှု ငြင်းဆန်ခံရပါသည်။`);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ==================== TASKS ====================
app.post('/api/tasks/claim', authMiddleware, async (req, res) => {
    try {
        const { taskId } = req.body;
        if (!VALID_TASKS.includes(taskId)) return res.status(400).json({ error: 'Invalid taskId' });

        const now       = Date.now();
        const lastClaim = req.user.taskCooldowns?.get?.(taskId) || 0;
        if (now - lastClaim < TASK_COOLDOWN_MS) {
            const remaining = TASK_COOLDOWN_MS - (now - lastClaim);
            return res.status(400).json({ error: 'Cooldown active', remaining });
        }

        const reward = TASK_REWARDS[taskId] || 300;
        req.user.balance += reward;
        if (!req.user.taskCooldowns) req.user.taskCooldowns = new Map();
        req.user.taskCooldowns.set(taskId, now);
        req.user.markModified('taskCooldowns');
        await req.user.save();
        res.json({ success: true, earned: reward, newBalance: req.user.balance });
    } catch (err) {
        console.error('POST /api/tasks/claim error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/tasks/status', authMiddleware, async (req, res) => {
    try {
        const now = Date.now(); const result = {};
        for (const tid of VALID_TASKS) {
            const last      = req.user.taskCooldowns?.get?.(tid) || 0;
            const remaining = Math.max(0, TASK_COOLDOWN_MS - (now - last));
            result[tid]     = { remaining, canClaim: remaining === 0 };
        }
        res.json({ tasks: result });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ==================== WITHDRAWAL ====================
app.post('/api/withdraw', authMiddleware, async (req, res) => {
    try {
        const { amount, method, accountNumber, accountName } = req.body;
        const amt = Number(amount);
        if (isNaN(amt) || amt < MIN_WITHDRAWAL) return res.status(400).json({ error: `အနည်းဆုံး ${MIN_WITHDRAWAL.toLocaleString()} MMK ရှိမှ ထုတ်နိုင်သည်` });
        if (!['kpay', 'wavepay'].includes(method)) return res.status(400).json({ error: 'Invalid payment method' });
        if (!accountNumber) return res.status(400).json({ error: 'Account number required' });
        if (req.user.balance < amt) return res.status(400).json({ error: 'လက်ကျန်ငွေ မလောက်ပါ' });

        req.user.balance -= amt; await req.user.save();
        const w = await Withdrawal.create({
            userId: req.user.userId, firstName: req.user.firstName,
            amount: amt, method, accountNumber, accountName, status: 'pending'
        });

        const methodLabel = method === 'kpay' ? 'KBZ Pay' : 'Wave Pay';
        await notifyAdmin(
            `💸 <b>ငွေထုတ်တောင်းဆိုမှု</b>\n` +
            `👤 ${escapeHTML(req.user.firstName)} (${req.user.userId})\n` +
            `💰 ${amt.toLocaleString()} MMK\n` +
            `🏦 ${methodLabel}: ${escapeHTML(accountNumber)}\n` +
            `👤 ${escapeHTML(accountName || '-')}\n\n` +
            `✅ /approve_wd_${w._id}\n❌ /reject_wd_${w._id}`
        );
        res.json({ success: true, newBalance: req.user.balance, withdrawalId: w._id });
    } catch (err) {
        console.error('POST /api/withdraw error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== INVITES ====================
app.get('/api/invites', authMiddleware, async (req, res) => {
    try {
        const invites = await Invite.find({ inviterId: req.user.userId }).sort({ createdAt: -1 }).limit(100);
        res.json({
            count:   req.user.inviteCount,
            invites: invites.map(i => ({ name: i.inviteeName, reward: i.reward, date: i.createdAt }))
        });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ==================== ADMIN — Withdrawals ====================
app.post('/api/admin/withdrawals/:id/approve', adminMiddleware, async (req, res) => {
    try {
        const w = await Withdrawal.findById(req.params.id);
        if (!w) return res.status(404).json({ error: 'Not found' });
        if (w.status !== 'pending') return res.status(400).json({ error: 'Already processed' });
        w.status = 'approved'; await w.save();
        await notifyUser(w.userId, `✅ သင့်ငွေထုတ်မှု ${w.amount.toLocaleString()} MMK ကို admin ခွင့်ပြုပြီးပါပြီ!`);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/withdrawals/:id/reject', adminMiddleware, async (req, res) => {
    try {
        const { reason } = req.body;
        const w = await Withdrawal.findById(req.params.id);
        if (!w) return res.status(404).json({ error: 'Not found' });
        if (w.status !== 'pending') return res.status(400).json({ error: 'Already processed' });
        const user = await User.findOne({ userId: w.userId });
        if (user) { user.balance += w.amount; await user.save(); }
        w.status = 'rejected'; w.rejectReason = reason || ''; await w.save();
        await notifyUser(w.userId, `❌ သင့်ငွေထုတ်မှု ${w.amount.toLocaleString()} MMK ငြင်းဆန်ခံရပါသည်။ ${reason ? '('+reason+')' : ''} ငွေကိုပြန်ထည့်ပေးပါပြီ။`);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ==================== ADMIN — Stats / Users / Ban ====================
app.get('/api/admin/stats', adminMiddleware, async (req, res) => {
    try {
        await connectDB();
        const [totalUsers, totalMiners, pendingWithdrawals, allWithdrawals] = await Promise.all([
            User.countDocuments(),
            Miner.countDocuments({ status: 'active' }),
            Withdrawal.countDocuments({ status: 'pending' }),
            Withdrawal.find({ status: 'pending' }).sort({ createdAt: -1 }).limit(50)
        ]);
        const pendingMiners = await Miner.find({ status: 'pending' }).sort({ createdAt: -1 }).limit(20);
        res.json({ totalUsers, activeMiners: totalMiners, pendingWithdrawals, withdrawals: allWithdrawals, pendingMiners });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/users', adminMiddleware, async (req, res) => {
    try {
        await connectDB();
        const users = await User.find().sort({ createdAt: -1 }).limit(100).select('-taskCooldowns');
        res.json({ users });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/users/:userId/ban', adminMiddleware, async (req, res) => {
    try {
        await connectDB();
        const user = await User.findOne({ userId: Number(req.params.userId) });
        if (!user) return res.status(404).json({ error: 'User not found' });
        user.banned = !user.banned; await user.save();
        res.json({ success: true, banned: user.banned });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ==================== START ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Kyawngar backend running on port ${PORT}`));

module.exports = app;
