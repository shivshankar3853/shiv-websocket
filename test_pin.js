
const axios = require('axios');

async function testPin() {
  console.log('Testing http://localhost:3000/api/verify-pin...');
  try {
    const response = await axios.post('http://localhost:3000/api/verify-pin', { pin: '123456' });
    console.log('Valid PIN Status:', response.status);
    console.log('Valid PIN Data:', response.data);

    try {
        await axios.post('http://localhost:3000/api/verify-pin', { pin: 'wrong' });
    } catch (err) {
        console.log('Invalid PIN Status (expected 401):', err.response?.status);
        console.log('Invalid PIN Data:', err.response?.data);
    }
  } catch (err) {
    console.error('Fetch Error:', err.response?.data || err.message);
  }
}

testPin();
