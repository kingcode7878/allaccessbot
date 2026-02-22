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
app.listen(PORT, () => console.log(`✅ Web Server: Port ${PORT} opened.`));

// 3. CONNECT TO DATABASE
async function connectDB() {
    try {
        await client.connect();
        const database = client.db('afro_leaks_db');
        usersCollection = database.collection('users');
        broadcastLogsCollection = database.collection('broadcast_logs');
        settingsCollection = database.collection('settings');
        console.log("✅ Database: Connected successfully to MongoDB.");
    } catch (e) {
        console.error("❌ Database Error:", e);
        setTimeout(connectDB, 5000);
    }
}

// 4. BOT LOGIC - USER REGISTRATION
bot.start(async (ctx) => {
    const userId = ctx.chat.id;
    console.log(`👤 Activity: User ${userId} (${ctx.from.username || 'no-username'}) joined.`);
    
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
        const msgText = welcomeData?.text || `Welcome ${ctx.from.first_name} to Xclusive Premium! 🔞`;
        const btnText = welcomeData?.button || "WATCH LEAKS 🔞";

        await ctx.reply(msgText, {
            reply_markup: {
                inline_keyboard: [[{ text: btnText, web_app: { url: APP_URL } }]]
            }
        });
    } catch (err) {
        console.error(`❌ Activity: Start Error for ${userId}:`, err.message);
    }
});

// 5. ADMIN COMMANDS
bot.command('admin', (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("Unauthorized.");
    console.log(`🔑 Admin: ${ctx.from.id} accessed admin panel.`);
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
        console.log(`📊 Activity: Stats requested by ${ctx.from.id}. Total ${totalUsers}, Active ${activeUsers}.`);
        await ctx.answerCbQuery();
        await ctx.reply(`📊 **Stats**\n\nTotal: ${totalUsers}\nActive (24h): ${activeUsers}`);
    } catch (e) { console.error("❌ Activity: Stats Error:", e); }
});

bot.action('admin_help', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    await ctx.reply("📢 **Guide:**\n\n/setwelcome [Text] | [Btn]\n/preview [URL] | [Btn]\n/send [URL] | [Btn]");
});

bot.action('admin_refresh', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    console.log(`🔄 Activity: Refresh triggered by ${ctx.from.id}`);
    await ctx.answerCbQuery("Refreshing...");
    ctx.reply(isBroadcasting ? "⚠️ System Busy: Broadcast in progress." : "✅ Connection stable.");
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
    console.log(`✅ Activity: Welcome updated by ${ctx.from.id}`);
    ctx.reply(`✅ Welcome updated!`);
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
    } catch (e) { 
        console.error(`❌ Activity: Preview Error by ${ctx.from.id}:`, e.message);
        ctx.reply(`❌ Preview Error: ${e.message}`); 
    }
});

// 6. BROADCAST WITH 100% ACTIVITY & ERROR LOGGING
bot.command('send', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("Unauthorized.");
    if (isBroadcasting) return ctx.reply("⚠️ Error: A broadcast is already in progress.");

    const fullInput = ctx.message.text.split(' ').slice(1).join(' ');
    if (!fullInput) return ctx.reply("Usage: /send [Msg/URL] | [Button]");

    const [content, btnLabel] = fullInput.split('|').map(s => s.trim());
    const extra = btnLabel ? { reply_markup: { inline_keyboard: [[{ text: btnLabel, web_app: { url: APP_URL } }]] } } : {};
    
    const args = content.split(' ');
    const isUrl = args[0].startsWith('http');
    const media = isUrl ? args[0] : null;
    const cap = isUrl ? args.slice(1).join(' ') : content;

    const progressDoc = await settingsCollection.findOne({ key: "broadcast_progress" });
    const startFrom = progressDoc ? progressDoc.last_index : 0;
    const totalUsers = await usersCollection.countDocuments();

    isBroadcasting = true;
    ctx.reply(`🚀 Broadcasting to ${totalUsers} users...`);
    console.log(`🚀 Activity: Broadcast started by ${ctx.from.id}. Target: ${totalUsers}. Resuming from: ${startFrom}`);

    (async () => {
        const userCursor = usersCollection.find({}).project({ chat_id: 1 }).skip(startFrom);
        let count = startFrom;

        while (await userCursor.hasNext()) {
            const user = await userCursor.next();

            // LOG EVERY ATTEMPT
            if (count > startFrom && count % 150 === 0) {
                console.log(`⏳ Activity: Batch pause reached at ${count}. Saving progress...`);
                await settingsCollection.updateOne({ key: "broadcast_progress" }, { $set: { last_index: count } }, { upsert: true });
                await new Promise(r => setTimeout(r, 30000));
                console.log(`▶️ Activity: Resume after 30s pause.`);
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
                
                // LOG SUCCESS
                count++;
                console.log(`📡 Activity: [${count}/${totalUsers}] SUCCESS: Sent to ${user.chat_id}`);
                
                await new Promise(r => setTimeout(r, 150));
            } catch (err) {
                // LOG ERROR
                count++;
                console.error(`❌ Activity: [${count}/${totalUsers}] FAILED: User ${user.chat_id} | Error: ${err.message}`);
                
                if (err.response?.error_code === 403) {
                    console.log(`🗑 Activity: Removing blocked user ${user.chat_id} from database.`);
                    usersCollection.deleteOne({ chat_id: user.chat_id }).catch(()=>{});
                }
            }
        }
        
        isBroadcasting = false;
        await settingsCollection.deleteOne({ key: "broadcast_progress" });
        console.log(`✅ Activity: Broadcast completed. Total processed: ${count}`);
        bot.telegram.sendMessage(ctx.from.id, `✅ Broadcast complete. Processed ${count} users.`);
    })();
});

bot.command('deleteall', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("Unauthorized.");
    if (isBroadcasting) return ctx.reply("⚠️ Cannot delete while broadcasting.");
    console.log(`🧹 Activity: ${ctx.from.id} triggered /deleteall`);
    
    const logs = await broadcastLogsCollection.find({ broadcast_id: "last" }).toArray();
    for (const log of logs) {
        try { 
            await bot.telegram.deleteMessage(log.chat_id, log.message_id); 
            console.log(`🗑 Activity: Deleted message for ${log.chat_id}`);
        } catch (e) {
            console.error(`❌ Activity: Delete failed for ${log.chat_id}: ${e.message}`);
        }
    }
    await broadcastLogsCollection.deleteMany({ broadcast_id: "last" });
    ctx.reply("✨ Wiped.");
});

// 8. STARTUP
connectDB().then(() => {
    bot.launch({ dropPendingUpdates: true });
    console.log("🚀 Activity: Bot is live and listening for commands.");
});

process.on('unhandledRejection', (r) => { 
    console.error('🔴 Activity: Critical Rejection:', r); 
    isBroadcasting = false; 
});
process.on('uncaughtException', (e) => { 
    console.error('🔴 Activity: Critical Exception:', e); 
    isBroadcasting = false; 
});
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));