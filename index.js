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

let usersCollection;
let broadcastLogsCollection;
let settingsCollection;
let isBroadcasting = false; 

const isAdmin = (id) => ADMIN_IDS.includes(id);

// 2. KEEP RENDER ALIVE
app.get('/', (req, res) => res.send('Afro Bot is Online!'));
app.listen(PORT, () => console.log(`✅ [SERVER] Web Server active on port ${PORT}`));

// 3. CONNECT TO DATABASE
async function connectDB() {
    try {
        await client.connect();
        const database = client.db('afro_leaks_db');
        usersCollection = database.collection('users');
        broadcastLogsCollection = database.collection('broadcast_logs');
        settingsCollection = database.collection('settings');
        console.log("✅ [DATABASE] Connection successful.");
    } catch (e) {
        console.error("❌ [DATABASE ERROR]:", e);
        setTimeout(connectDB, 5000);
    }
}

// 4. USER REGISTRATION
bot.start(async (ctx) => {
    const userId = ctx.chat.id;
    console.log(`👤 [ACTIVITY] /start triggered by ${userId}`);
    try {
        await usersCollection.updateOne(
            { chat_id: userId },
            { $set: { username: ctx.from.username || "anonymous", first_name: ctx.from.first_name || "User", last_active: new Date() } },
            { upsert: true }
        );
        const welcomeData = await settingsCollection.findOne({ key: "welcome_config" });
        await ctx.reply(welcomeData?.text || `Welcome ${ctx.from.first_name}!`, {
            reply_markup: { inline_keyboard: [[{ text: welcomeData?.button || "ENTER", web_app: { url: APP_URL } }]] }
        });
    } catch (err) {
        console.error(`❌ [USER ERROR] Start failed for ${userId}:`, err.message);
    }
});

// 5. ADMIN COMMANDS
bot.command('admin', (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    console.log(`🔑 [ADMIN] Access by ${ctx.from.id}`);
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
    const total = await usersCollection.countDocuments();
    console.log(`📊 [ACTIVITY] Stats requested. Total users: ${total}`);
    await ctx.answerCbQuery();
    await ctx.reply(`📊 Total Users: ${total}`);
});

bot.action('admin_help', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    await ctx.reply("📢 /setwelcome | /preview | /send");
});

bot.action('admin_refresh', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    console.log(`🔄 [ACTIVITY] Refresh clicked. Broadcast Status: ${isBroadcasting}`);
    await ctx.answerCbQuery();
    ctx.reply(isBroadcasting ? "⚠️ BROADCAST RUNNING" : "✅ SYSTEM READY");
});

bot.command('setwelcome', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const input = ctx.message.text.split(' ').slice(1).join(' ');
    if (!input.includes('|')) return ctx.reply("Format: Text | Button");
    const [text, button] = input.split('|').map(s => s.trim());
    await settingsCollection.updateOne({ key: "welcome_config" }, { $set: { text, button } }, { upsert: true });
    ctx.reply("✅ Welcome updated.");
});

bot.command('preview', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const fullInput = ctx.message.text.split(' ').slice(1).join(' ');
    const [content, btnLabel] = fullInput.split('|').map(s => s.trim());
    const extra = btnLabel ? { reply_markup: { inline_keyboard: [[{ text: btnLabel, web_app: { url: APP_URL } }]] } } : {};
    const args = content.split(' ');
    const isUrl = args[0].startsWith('http');
    try {
        if (isUrl) {
            if (args[0].match(/\.(mp4|mov|avi)$/i)) await ctx.replyWithVideo(args[0], { caption: args.slice(1).join(' '), ...extra });
            else await ctx.replyWithPhoto(args[0], { caption: args.slice(1).join(' '), ...extra });
        } else { await ctx.reply(content, extra); }
    } catch (e) { console.error(`❌ [PREVIEW ERROR]:`, e.message); ctx.reply(`Error: ${e.message}`); }
});

// 6. REPAIRED BROADCAST ENGINE WITH FULL LOGGING
bot.command('send', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    if (isBroadcasting) return ctx.reply("⚠️ Already broadcasting!");

    const fullInput = ctx.message.text.split(' ').slice(1).join(' ');
    if (!fullInput.includes('|')) return ctx.reply("Format: Content | Button");

    const [content, btnLabel] = fullInput.split('|').map(s => s.trim());
    const extra = btnLabel ? { reply_markup: { inline_keyboard: [[{ text: btnLabel, web_app: { url: APP_URL } }]] } } : {};
    
    const isUrl = content.split(' ')[0].startsWith('http');
    const media = isUrl ? content.split(' ')[0] : null;
    const cap = isUrl ? content.split(' ').slice(1).join(' ') : content;

    const totalUsers = await usersCollection.countDocuments();
    isBroadcasting = true;
    console.log(`🚀 [BROADCAST START] Target: ${totalUsers} users.`);
    ctx.reply(`🚀 Broadcasting to ${totalUsers} users...`);

    (async () => {
        let successCount = 0;
        let errorCount = 0;
        const cursor = usersCollection.find({});

        try {
            while (await cursor.hasNext()) {
                const user = await cursor.next();
                console.log(`📡 [ATTEMPT] Sending to ${user.chat_id}...`);

                try {
                    let sent;
                    if (isUrl) {
                        if (media.match(/\.(mp4|mov|avi)$/i)) sent = await bot.telegram.sendVideo(user.chat_id, media, { caption: cap, ...extra });
                        else sent = await bot.telegram.sendPhoto(user.chat_id, media, { caption: cap, ...extra });
                    } else {
                        sent = await bot.telegram.sendMessage(user.chat_id, cap, extra);
                    }
                    
                    successCount++;
                    console.log(`✅ [SUCCESS] Sent to ${user.chat_id} (${successCount}/${totalUsers})`);
                    broadcastLogsCollection.insertOne({ chat_id: user.chat_id, message_id: sent.message_id, sent_at: new Date() }).catch(()=>{});
                } catch (err) {
                    errorCount++;
                    console.error(`❌ [SEND ERROR] User ${user.chat_id}: ${err.message}`);
                    if (err.response?.error_code === 403) {
                        console.log(`🗑 [DATABASE] Removing blocked user ${user.chat_id}`);
                        await usersCollection.deleteOne({ chat_id: user.chat_id }).catch(()=>{});
                    }
                }

                // Batch pause logic only triggers if you actually have 150+ users
                if (successCount + errorCount >= 150 && (successCount + errorCount) % 150 === 0) {
                    console.log(`⏳ [PAUSE] 150 reached. Sleeping 30s...`);
                    await new Promise(r => setTimeout(r, 30000));
                }
                
                // 200ms sleep so the bot stays "awake" for other commands
                await new Promise(r => setTimeout(r, 200));
            }
        } catch (fatal) {
            console.error(`🔴 [FATAL ERROR] Broadcast crashed:`, fatal.message);
        } finally {
            isBroadcasting = false;
            console.log(`✅ [BROADCAST FINISHED] Total: ${totalUsers} | Success: ${successCount} | Errors: ${errorCount}`);
            bot.telegram.sendMessage(ctx.from.id, `✅ Broadcast Done.\nSuccess: ${successCount}\nErrors: ${errorCount}`).catch(()=>{});
        }
    })();
});

// 7. STARTUP & GLOBAL CATCH
connectDB().then(() => {
    bot.launch({ dropPendingUpdates: true });
    console.log("🚀 [SYSTEM] Bot is live.");
});

process.on('unhandledRejection', (e) => console.error('🔴 [REJECTION]:', e));
process.on('uncaughtException', (e) => console.error('🔴 [EXCEPTION]:', e));