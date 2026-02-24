
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
  auth: {
    persistSession: false
  }
});

async function getLogs() {
  console.log('Fetching logs...');
  try {
    const { data, error } = await supabase
      .from('tradingview_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) {
      console.error('Supabase Error:', error);
      return;
    }

    if (!data || data.length === 0) {
      console.log('No logs found.');
      return;
    }

    console.log('Latest Logs:');
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Fetch Error:', err.message);
  }
}

getLogs();
