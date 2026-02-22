require('dotenv').config(); 
const { Telegraf } = require('telegraf');
const { MongoClient } = require('mongodb');
const express = require('express');

// 1. CONFIGURATION
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const APP_URL = process.env.APP_URL;
const PORT = process.env.PORT || 3000;

const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())) : [];

const bot = new Telegraf(BOT_TOKEN);
const client = new MongoClient(MONGO_URI, { 
    connectTimeoutMS: 60000, 
    socketTimeoutMS: 60000,
    maxIdleTimeMS: 120000,
    maxPoolSize: 10
});
const app = express();

let usersCollection, broadcastLogsCollection, settingsCollection;
let isBroadcasting = false; 

const isAdmin = (id) => ADMIN_IDS.includes(id);

// 2. KEEP RENDER ALIVE
app.get('/', (req, res) => res.send('Afro Bot Engine: ACTIVE'));
app.listen(PORT, () => console.log(`✅ [SYSTEM] Web Server active on port ${PORT}`));

// 3. CONNECT TO DATABASE
async function connectDB() {
    try {
        await client.connect();
        const database = client.db('afro_leaks_db');
        usersCollection = database.collection('users');
        broadcastLogsCollection = database.collection('broadcast_logs');
        settingsCollection = database.collection('settings');
        console.log("✅ [DATABASE] Connected successfully.");
    } catch (e) {
        console.error("❌ [DATABASE] Error:", e);
        setTimeout(connectDB, 5000);
    }
}

// 4. BOT LOGIC - USER REGISTRATION
bot.start(async (ctx) => {
    const userId = ctx.chat.id;
    console.log(`👤 [ACTIVITY] User ${userId} joined.`);
    try {
        await usersCollection.updateOne(
            { chat_id: userId },
            { $set: { username: ctx.from.username || "anonymous", first_name: ctx.from.first_name || "User", last_active: new Date() } },
            { upsert: true }
        );
        const welcomeData = await settingsCollection.findOne({ key: "welcome_config" });
        await ctx.reply(welcomeData?.text || `Welcome ${ctx.from.first_name}! 🔞`, {
            reply_markup: { inline_keyboard: [[{ text: welcomeData?.button || "WATCH", web_app: { url: APP_URL } }]] }
        });
    } catch (err) { console.error(`❌ [ERROR] Start for ${userId}:`, err.message); }
});

// 5. ADMIN COMMANDS
bot.command('admin', (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("Unauthorized.");
    ctx.reply("🛠 **Admin Panel**", {
        reply_markup: {
            inline_keyboard: [
                [{ text: "📊 View Stats", callback_data: "admin_stats" }],
                [{ text: "🔄 Refresh System", callback_data: "admin_refresh" }]
            ]
        }
    });
});

bot.action('admin_stats', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const total = await usersCollection.countDocuments();
    await ctx.answerCbQuery();
    await ctx.reply(`📊 Total Users: ${total}`);
});

bot.action('admin_refresh', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery("Refreshing...");
    ctx.reply(isBroadcasting ? "⚠️ SYSTEM BUSY: BROADCASTING" : "✅ SYSTEM IDLE: READY");
});

bot.command('setwelcome', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("Unauthorized.");
    const input = ctx.message.text.split(' ').slice(1).join(' ');
    if (!input || !input.includes('|')) return ctx.reply("Usage: /setwelcome Text | Button");
    const [text, button] = input.split('|').map(s => s.trim());
    await settingsCollection.updateOne({ key: "welcome_config" }, { $set: { text, button } }, { upsert: true });
    ctx.reply(`✅ Welcome updated!`);
});

bot.command('preview', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("Unauthorized.");
    const fullInput = ctx.message.text.split(' ').slice(1).join(' ');
    if (!fullInput) return ctx.reply("Usage: /preview [Msg/URL] | [Button]");
    const [content, btnLabel] = fullInput.split('|').map(s => s.trim());
    const extra = btnLabel ? { reply_markup: { inline_keyboard: [[{ text: btnLabel, web_app: { url: APP_URL } }]] } } : {};
    const isUrl = content.split(' ')[0].startsWith('http');
    try {
        if (isUrl) {
            const media = content.split(' ')[0];
            const cap = content.split(' ').slice(1).join(' ');
            if (media.match(/\.(mp4|mov|avi)$/i)) await ctx.replyWithVideo(media, { caption: cap, ...extra });
            else await ctx.replyWithPhoto(media, { caption: cap, ...extra });
        } else { await ctx.reply(content, extra); }
    } catch (e) { ctx.reply(`❌ Preview Error: ${e.message}`); }
});

// 6. STABILIZED BROADCAST ENGINE
bot.command('send', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("Unauthorized.");
    if (isBroadcasting) return ctx.reply("⚠️ Error: A broadcast is already in progress.");

    const fullInput = ctx.message.text.split(' ').slice(1).join(' ');
    if (!fullInput) return ctx.reply("Usage: /send [Msg/URL] | [Button]");

    const [content, btnLabel] = fullInput.split('|').map(s => s.trim());
    const extra = btnLabel ? { reply_markup: { inline_keyboard: [[{ text: btnLabel, web_app: { url: APP_URL } }]] } } : {};
    const isUrl = content.split(' ')[0].startsWith('http');
    const media = isUrl ? content.split(' ')[0] : null;
    const cap = isUrl ? content.split(' ').slice(1).join(' ') : content;

    const totalUsers = await usersCollection.countDocuments();
    const progressDoc = await settingsCollection.findOne({ key: "broadcast_progress" });
    const startFrom = progressDoc ? progressDoc.last_index : 0;

    isBroadcasting = true;
    ctx.reply(`🚀 Broadcasting to ${totalUsers} users...`);
    console.log(`🚀 [BROADCAST] Start by ${ctx.from.id}. Target: ${totalUsers}.`);

    (async () => {
        try {
            const userCursor = usersCollection.find({}).project({ chat_id: 1 }).skip(startFrom);
            let count = startFrom;

            while (await userCursor.hasNext()) {
                const user = await userCursor.next();

                if (count > startFrom && count % 150 === 0) {
                    console.log(`⏳ [SYSTEM] Saving progress at index ${count}...`);
                    await settingsCollection.updateOne({ key: "broadcast_progress" }, { $set: { last_index: count } }, { upsert: true });
                    await new Promise(r => setTimeout(r, 20000));
                }

                try {
                    let sent;
                    if (isUrl) {
                        if (media.match(/\.(mp4|mov|avi)$/i)) sent = await bot.telegram.sendVideo(user.chat_id, media, { caption: cap, ...extra });
                        else sent = await bot.telegram.sendPhoto(user.chat_id, media, { caption: cap, ...extra });
                    } else {
                        sent = await bot.telegram.sendMessage(user.chat_id, cap, extra);
                    }
                    
                    broadcastLogsCollection.insertOne({ broadcast_id: "last", chat_id: user.chat_id, message_id: sent.message_id, sent_at: new Date() }).catch(()=>{});
                    
                    // EVERY ACTION LOGGED INDIVIDUALLY
                    console.log(`📡 [${count + 1}/${totalUsers}] SUCCESS: Sent to ${user.chat_id}`);
                } catch (err) {
                    console.error(`❌ [${count + 1}/${totalUsers}] FAILED: User ${user.chat_id} | Error: ${err.message}`);
                    if (err.response?.error_code === 403) {
                        console.log(`🗑 [CLEANUP] Removing blocked user: ${user.chat_id}`);
                        usersCollection.deleteOne({ chat_id: user.chat_id }).catch(()=>{});
                    }
                }
                count++;
                // CRITICAL: 100ms breathing room keeps the bot responsive
                await new Promise(r => setTimeout(r, 100)); 
            }
            await settingsCollection.deleteOne({ key: "broadcast_progress" });
            console.log(`✅ [BROADCAST] Finished successfully.`);
        } catch (fatal) {
            console.error(`🔴 [FATAL] Broadcast loop error:`, fatal.message);
        } finally {
            // CRITICAL: Unlocks the bot even if the loop fails
            isBroadcasting = false; 
            console.log(`🔄 [SYSTEM] Engine Unlocked.`);
            bot.telegram.sendMessage(ctx.from.id, `✅ Broadcast complete. Processed ${totalUsers} users.`);
        }
    })();
});

bot.command('deleteall', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("Unauthorized.");
    if (isBroadcasting) return ctx.reply("⚠️ Cannot delete while broadcasting.");
    const logs = await broadcastLogsCollection.find({ broadcast_id: "last" }).toArray();
    for (const log of logs) { try { await bot.telegram.deleteMessage(log.chat_id, log.message_id); } catch (e) {} }
    await broadcastLogsCollection.deleteMany({ broadcast_id: "last" });
    ctx.reply("✨ Wiped.");
});

// 8. STARTUP & GLOBAL LOGGING
connectDB().then(() => {
    bot.launch({ dropPendingUpdates: true });
    console.log("🚀 [SYSTEM] Bot is live and logging 100% activity.");
});

process.on('unhandledRejection', (r) => { console.error('🔴 [CRITICAL] Rejection:', r); isBroadcasting = false; });
process.on('uncaughtException', (e) => { console.error('🔴 [CRITICAL] Exception:', e); isBroadcasting = false; });