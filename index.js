require('dotenv').config(); 
const { Telegraf } = require('telegraf');
const { MongoClient } = require('mongodb');
const express = require('express');

// 1. CONFIGURATION
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const APP_URL = process.env.APP_URL;
const PORT = process.env.PORT || 3000;

// MULTI-ADMIN SETUP: Converts "123,456" from env into [123, 456]
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())) : [];

const bot = new Telegraf(BOT_TOKEN);
const client = new MongoClient(MONGO_URI);
const app = express();

let usersCollection;
let broadcastLogsCollection;
let settingsCollection;

// Helper to check if a user is an admin
const isAdmin = (id) => ADMIN_IDS.includes(id);

// 2. KEEP RENDER ALIVE
app.get('/', (req, res) => res.send('Afro Bot is Online!'));
app.listen(PORT, () => console.log(`✅ Port ${PORT} opened.`));

// 3. CONNECT TO DATABASE
async function connectDB() {
    try {
        await client.connect();
        const database = client.db('afro_leaks_db');
        usersCollection = database.collection('users');
        broadcastLogsCollection = database.collection('broadcast_logs');
        settingsCollection = database.collection('settings');
        console.log("✅ Connected to MongoDB");
    } catch (e) {
        console.error("❌ MongoDB Error:", e);
    }
}

// 4. BOT LOGIC - USER REGISTRATION
bot.start(async (ctx) => {
    const userId = ctx.chat.id;
    try {
        await usersCollection.updateOne(
            { chat_id: userId },
            { 
                $set: { 
                    username: ctx.from.username || "anonymous",
                    first_name: ctx.from.first_name || "User",
                    last_active: new Date()
                } 
            },
            { upsert: true }
        );

        const welcomeData = await settingsCollection.findOne({ key: "welcome_config" });
        const msgText = welcomeData?.text || `Welcome ${ctx.from.first_name} to Afro Leakers! 🔞`;
        const btnText = welcomeData?.button || "WATCH LEAKS 🔞";

        await ctx.reply(msgText, {
            reply_markup: {
                inline_keyboard: [[{ text: btnText, web_app: { url: APP_URL } }]]
            }
        });
    } catch (err) {
        console.error("❌ Start Error:", err.message);
    }
});

// 5. ADMIN COMMANDS (Checks against ADMIN_IDS array)
bot.command('admin', (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("Unauthorized.");
    ctx.reply("🛠 **Admin Panel**", {
        reply_markup: {
            inline_keyboard: [
                [{ text: "📊 View Stats", callback_data: "admin_stats" }],
                [{ text: "👁 Preview Info", callback_data: "admin_help" }],
                [{ text: "🔄 Refresh System", callback_data: "admin_refresh" }]
            ]
        }
    });
});

bot.action('admin_stats', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    try {
        const totalUsers = await usersCollection.countDocuments();
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const activeUsers = await usersCollection.countDocuments({ last_active: { $gte: twentyFourHoursAgo } });
        await ctx.answerCbQuery();
        await ctx.reply(`📊 **Stats**\n\nTotal: ${totalUsers}\nActive (24h): ${activeUsers}`);
    } catch (e) { console.log(e); }
});

bot.action('admin_help', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    await ctx.reply("📢 **Guide:**\n\n/setwelcome [Text] | [Btn]\n/preview [URL] | [Btn]\n/send [URL] | [Btn]");
});

bot.action('admin_refresh', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery("Refreshing...");
    ctx.reply("✅ Connection stable.");
});

bot.command('setwelcome', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("Unauthorized.");
    const input = ctx.message.text.split(' ').slice(1).join(' ');
    if (!input || !input.includes('|')) return ctx.reply("Usage: /setwelcome Text | Button");

    const [text, button] = input.split('|').map(s => s.trim());
    await settingsCollection.updateOne(
        { key: "welcome_config" },
        { $set: { text, button } },
        { upsert: true }
    );
    ctx.reply(`✅ Welcome updated!`);
});

bot.command('stats', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("Unauthorized.");
    const totalUsers = await usersCollection.countDocuments();
    ctx.reply(`📊 Total Subscribers: ${totalUsers}`);
});

bot.command('preview', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("Unauthorized.");
    const fullInput = ctx.message.text.split(' ').slice(1).join(' ');
    if (!fullInput) return ctx.reply("Usage: /preview [Msg/URL] | [Button]");

    const [content, btnLabel] = fullInput.split('|').map(s => s.trim());
    const extra = btnLabel ? { reply_markup: { inline_keyboard: [[{ text: btnLabel, web_app: { url: APP_URL } }]] } } : {};
    
    const args = content.split(' ');
    const isUrl = args[0].startsWith('http');

    try {
        if (isUrl) {
            const media = args[0];
            const cap = args.slice(1).join(' ');
            if (media.match(/\.(mp4|mov|avi)$/i)) await ctx.replyWithVideo(media, { caption: cap, ...extra });
            else await ctx.replyWithPhoto(media, { caption: cap, ...extra });
        } else {
            await ctx.reply(content, extra);
        }
    } catch (e) { ctx.reply(`❌ Error: ${e.message}`); }
});

bot.command('send', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("Unauthorized.");
    const fullInput = ctx.message.text.split(' ').slice(1).join(' ');
    if (!fullInput) return ctx.reply("Usage: /send [Msg/URL] | [Button]");

    const [content, btnLabel] = fullInput.split('|').map(s => s.trim());
    const extra = btnLabel ? { reply_markup: { inline_keyboard: [[{ text: btnLabel, web_app: { url: APP_URL } }]] } } : {};
    
    const args = content.split(' ');
    const isUrl = args[0].startsWith('http');
    const media = isUrl ? args[0] : null;
    const cap = isUrl ? args.slice(1).join(' ') : content;

    const allUsers = await usersCollection.find({}).toArray();
    ctx.reply(`🚀 Broadcasting to ${allUsers.length} users...`);

    let count = 0;
    for (const user of allUsers) {
        try {
            let sent;
            if (isUrl) {
                if (media.match(/\.(mp4|mov|avi)$/i)) sent = await bot.telegram.sendVideo(user.chat_id, media, { caption: cap, ...extra });
                else sent = await bot.telegram.sendPhoto(user.chat_id, media, { caption: cap, ...extra });
            } else {
                sent = await bot.telegram.sendMessage(user.chat_id, cap, extra);
            }
            await broadcastLogsCollection.insertOne({ broadcast_id: "last", chat_id: user.chat_id, message_id: sent.message_id, sent_at: new Date() });
            count++;
            await new Promise(r => setTimeout(r, 50));
        } catch (err) {
            if (err.response?.error_code === 403) await usersCollection.deleteOne({ chat_id: user.chat_id });
        }
    }
    ctx.reply(`✅ Sent to ${count} users.`);
});

bot.command('deleteall', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("Unauthorized.");
    const logs = await broadcastLogsCollection.find({ broadcast_id: "last" }).toArray();
    for (const log of logs) {
        try { await bot.telegram.deleteMessage(log.chat_id, log.message_id); } catch (e) {}
    }
    await broadcastLogsCollection.deleteMany({ broadcast_id: "last" });
    ctx.reply("✨ Wiped.");
});

// 8. STARTUP
connectDB().then(() => {
    bot.launch({ dropPendingUpdates: true });
    console.log("🚀 Bot is live with Multi-Admin support!");
});

process.on('unhandledRejection', (r) => console.log('Rejection:', r));
process.on('uncaughtException', (e) => console.log('Exception:', e));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));