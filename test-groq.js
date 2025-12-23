// test-groq.js
require('dotenv').config();
const axios = require('axios');

async function testGroq() {
  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: 'Hello, are you working?' }],
        temperature: 0.7,
        max_tokens: 100
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('✅ Groq is working!');
    console.log('Response:', response.data.choices[0].message.content);
  } catch (error) {
    console.error('❌ Groq error:', error.response?.data || error.message);
  }
}

testGroq();