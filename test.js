require('dotenv').config();
const { Telegraf } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);

// Test the connection
async function testConnection() {
  try {
    console.log('Testing bot token...');
    const me = await bot.telegram.getMe();
    console.log('✅ Success! Bot username:', me.username);
    console.log('Bot ID:', me.id);
    console.log('Bot name:', me.first_name);
    
    // Test sending a message
    console.log('\nTesting message send...');
    // Replace CHAT_ID with your actual Telegram user ID
    // You can get it by messaging @userinfobot on Telegram
    // await bot.telegram.sendMessage(CHAT_ID, 'Test message from bot!');
    // console.log('✅ Message sent successfully!');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Connection failed:', error.message);
    console.log('\nTroubleshooting:');
    console.log('1. Check BOT_TOKEN in .env file');
    console.log('2. Try: curl -I https://api.telegram.org');
    console.log('3. Check firewall/proxy settings');
    console.log('4. Try using a VPN');
    process.exit(1);
  }
}

testConnection();