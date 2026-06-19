export default async function handler(req, res) {
  const { sheetId } = req.query;
  
  if (!sheetId) {
    return res.status(400).json({ error: 'sheetId is required' });
  }
  
  const apiKey = process.env.GOOGLE_API_KEY;
  const sheetName = process.env.SHEET_NAME || 'Sheet1';
  
  if (!apiKey) {
    return res.status(500).json({ error: 'GOOGLE_API_KEY not configured' });
  }
  
  try {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(sheetName)}?key=${apiKey}`;
    
    const response = await fetch(url);
    
    if (!response.ok) {
      const errBody = await response.text();
      return res.status(response.status).json({ 
        error: `Google Sheets API error: ${response.status}`,
        details: errBody
      });
    }
    
    const json = await response.json();
    const rows = json.values || [];
    
    if (rows.length === 0) {
      return res.status(200).json({ data: [], total: 0 });
    }
    
    // First row = headers
    const headers = rows[0];
    const data = rows.slice(1).map(row => {
      const obj = {};
      headers.forEach((header, i) => {
        obj[header] = row[i] || '';
      });
      return obj;
    });
    
    res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate');
    return res.status(200).json({ data, total: data.length, headers });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
