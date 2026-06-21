// ================================================================
// 729flux Dashboard — Vercel Serverless API
// รองรับ multi-channel, organic analytics, auto-sync
// ================================================================

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const API_KEY = process.env.GOOGLE_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: "Missing GOOGLE_API_KEY" });

  // Support multiple channels via query param: ?channels=ID1,ID2,ID3
  // or single: ?sheetId=ID  (backward compat)
  const channelParam = req.query.channels || req.query.sheetId || process.env.SHEET_ID || "";
  const SHEET_NAME   = process.env.SHEET_NAME || "น้องจดจิ";
  const channelIds   = channelParam.split(",").map(s => s.trim()).filter(Boolean);

  if (!channelIds.length) return res.status(400).json({ error: "No sheet ID provided" });

  try {
    // Fetch all channels in parallel
    const channelDataArr = await Promise.all(
      channelIds.map((id, idx) => fetchChannel(id, SHEET_NAME, API_KEY, idx))
    );

    // Merge or return individually
    const combined = mergeChannels(channelDataArr);

    res.setHeader("Cache-Control", "s-maxage=180, stale-while-revalidate=60");
    return res.status(200).json({
      lastUpdated: new Date().toISOString(),
      channels: channelDataArr,   // per-channel data
      combined,                   // merged across all channels
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}

// ────────────────────────────────────────────────────────────
// FETCH ONE CHANNEL
// ────────────────────────────────────────────────────────────
async function fetchChannel(sheetId, sheetName, apiKey, idx) {
  const range = encodeURIComponent(`${sheetName}!A:X`);
  const url   = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?key=${apiKey}`;

  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Sheet ${sheetId}: ${resp.status} — ${body.slice(0, 200)}`);
  }
  const json = await resp.json();
  const rows = json.values || [];
  if (rows.length < 2) return emptyChannel(sheetId, idx);

  const headers = rows[0];
  const data    = rows.slice(1);

  // Flexible column finder
  const ci = name => headers.indexOf(name);
  // ci2: like ci, but tries multiple possible header spellings and returns the first match found.
  // This protects against typos in the source Sheet (e.g. "ชั่วโฒง" vs "ชั่วโมง").
  const ci2 = (...names) => {
    for (const n of names) {
      const idx = headers.indexOf(n);
      if (idx !== -1) return idx;
    }
    return -1;
  };
  const col = {
    date:    ci("วันที่"),
    time:    ci("เวลา"),
    host:    ci("ผู้รายงาน"),
    channel: ci("ชื่อช่อง"),
    session: ci("Session ID"),
    gmv:     ci("ยอดขาย"),
    orders:  ci("คำสั่งซื้อ"),
    cart:    ci("รถเข็น"),
    gmvHr:   ci("ยอดขายเพิ่มต่อชั่วโมง"),
    ordHr:   ci("คำสั่งซื้อเพิ่มต่อชั่วโมง"),
    cartHr:  ci("รถเข็นเพิ่มต่อชั่วโมง"),
    adHr:    ci("แอดกินต่อชั่วโมง"),
    // "ROAS ต่อชั่วโมง" is the correct spelling, but the live Sheet has a typo:
    // "ROAS ต่อชั่วโฒง" (โฒง instead of โมง). Try both so either spelling works.
    roasHr:  ci2("ROAS ต่อชั่วโมง", "ROAS ต่อชั่วโฒง"),
    hour:    ci("ชม.(0-23)"),
    adGmv:   ci("ยอด Ad/ชม."),
    orgGmv:  ci("ยอด Organic/ชม."),
    orgPct:  ci("% Organic"),
  };

  const channelName = data.find(r => r[col.channel])?.[col.channel] || `ช่อง ${idx + 1}`;

  const parsed = data
    .filter(r => r[col.date] && r[col.session])
    .map(r => ({
      date:    fmtDate(r[col.date]),
      host:    clean(r[col.host]),
      session: clean(r[col.session]),
      gmv:     num(r[col.gmv]),
      gmvHr:   num(r[col.gmvHr]),
      ordHr:   num(r[col.ordHr]),
      cartHr:  num(r[col.cartHr]),
      adHr:    num(r[col.adHr]),
      roasHr:  num(r[col.roasHr]),
      hour:    Math.round(num(r[col.hour])),
      adGmv:   num(r[col.adGmv]),
      orgGmv:  num(r[col.orgGmv]),
      orgPct:  num(r[col.orgPct]),
    }));

  return {
    sheetId,
    channelName,
    monthly:  buildMonthly(parsed),
    hourly:   buildHourly(parsed),
    hosts:    buildHosts(parsed),
    daily:    buildDaily(parsed),
    campaign: buildCampaign(parsed),
    organic:  buildOrganic(parsed),
  };
}

// ────────────────────────────────────────────────────────────
// ORGANIC ANALYTICS — core new feature
// ────────────────────────────────────────────────────────────
function buildOrganic(rows) {
  // Per-month organic metrics
  const byMonth = {};
  rows.forEach(r => {
    if (!r.date) return;
    const m = r.date.slice(0, 7);
    if (!byMonth[m]) byMonth[m] = { orgSum: 0, adSum: 0, totalSales: 0, orgCount: 0, orgPctArr: [] };
    const g = byMonth[m];
    g.orgSum    += r.orgGmv;
    g.adSum     += r.adGmv;
    g.totalSales += r.gmvHr;
    if (r.orgGmv > 0 || r.adGmv > 0) g.orgCount++;
    if (r.orgPct > 0) g.orgPctArr.push(r.orgPct);
  });

  const MONTHS = {"01":"ม.ค.","02":"ก.พ.","03":"มี.ค.","04":"เม.ย.","05":"พ.ค.","06":"มิ.ย.","07":"ก.ค.","08":"ส.ค.","09":"ก.ย.","10":"ต.ค.","11":"พ.ย.","12":"ธ.ค."};
  const monthly = Object.keys(byMonth).sort().map(m => {
    const g = byMonth[m];
    const totalTracked = g.orgSum + g.adSum;
    const orgPct = totalTracked > 0 ? Math.round(g.orgSum / totalTracked * 100) : (g.orgPctArr.length ? Math.round(g.orgPctArr.reduce((a,b)=>a+b,0)/g.orgPctArr.length) : 0);
    return {
      month: m,
      label: MONTHS[m.slice(5,7)] || m,
      orgGmv:  Math.round(g.orgSum),
      adGmv:   Math.round(g.adSum),
      total:   Math.round(g.totalSales),
      orgPct,
      adPct:   100 - orgPct,
    };
  });

  // "ช่องติด" score — trending organic %
  // ถ้า organic % เพิ่มขึ้นต่อเนื่อง = ช่องกำลังติด
  let channelHealthScore = 0;
  let healthLabel = "ยังไม่มีข้อมูล organic";
  let healthColor = "gray";

  if (monthly.length >= 2) {
    const last  = monthly[monthly.length - 1];
    const prev  = monthly[monthly.length - 2];
    const trend = last.orgPct - prev.orgPct;
    const avg   = monthly.reduce((s, m) => s + m.orgPct, 0) / monthly.length;
    channelHealthScore = Math.min(100, Math.round(avg + trend * 2));
    if (channelHealthScore >= 60) { healthLabel = "ช่องกำลังติด 🔥 organic เพิ่มขึ้น"; healthColor = "green"; }
    else if (channelHealthScore >= 35) { healthLabel = "กำลังเติบโต ต้องดู trend ต่อ"; healthColor = "gold"; }
    else { healthLabel = "ยังพึ่ง paid มาก — ต้องสร้าง organic"; healthColor = "orange"; }
  }

  // Hourly organic breakdown
  const hourly = [];
  for (let h = 0; h < 24; h++) {
    const hrs = rows.filter(r => r.hour === h && (r.orgGmv > 0 || r.adGmv > 0));
    if (!hrs.length) { hourly.push({ hour: h, avgOrg: 0, avgAd: 0, orgPct: 0 }); continue; }
    const avgOrg = Math.round(hrs.reduce((s,r)=>s+r.orgGmv,0)/hrs.length);
    const avgAd  = Math.round(hrs.reduce((s,r)=>s+r.adGmv,0)/hrs.length);
    const tot    = avgOrg + avgAd;
    hourly.push({ hour: h, avgOrg, avgAd, orgPct: tot > 0 ? Math.round(avgOrg/tot*100) : 0 });
  }

  return { monthly, hourly, channelHealthScore, healthLabel, healthColor };
}

// ────────────────────────────────────────────────────────────
// STANDARD AGGREGATORS
// ────────────────────────────────────────────────────────────
function buildMonthly(rows) {
  const map = {};
  const MONTHS = {"01":"ม.ค.","02":"ก.พ.","03":"มี.ค.","04":"เม.ย.","05":"พ.ค.","06":"มิ.ย.","07":"ก.ค.","08":"ส.ค.","09":"ก.ย.","10":"ต.ค.","11":"พ.ย.","12":"ธ.ค."};
  rows.forEach(r => {
    if (!r.date) return;
    const m = r.date.slice(0,7);
    if (!map[m]) map[m] = { sessions: new Set(), gmvHr:0, ordHr:0, cartHr:0, adHr:0, roasArr:[], gmvBySess:{} };
    const g = map[m];
    g.sessions.add(r.session);
    g.gmvHr  += r.gmvHr;  g.ordHr  += r.ordHr;
    g.cartHr += r.cartHr; g.adHr   += r.adHr;
    if (r.roasHr > 0) g.roasArr.push(r.roasHr);
    g.gmvBySess[r.session] = Math.max(g.gmvBySess[r.session]||0, r.gmv);
  });
  return Object.keys(map).sort().map(m => {
    const g = map[m];
    const sales = Object.values(g.gmvBySess).reduce((s,v)=>s+v,0);
    return {
      month: m, label: MONTHS[m.slice(5,7)]||m,
      sales, gmvHr: g.gmvHr,
      orders: Math.round(g.ordHr), cart: Math.round(g.cartHr),
      adSpend: Math.round(g.adHr),
      roas: g.roasArr.length ? +(g.roasArr.reduce((a,b)=>a+b,0)/g.roasArr.length).toFixed(1) : 0,
      sessions: g.sessions.size,
    };
  });
}

function buildHourly(rows) {
  const map = {};
  for (let h=0;h<24;h++) map[h]={salesSum:0,adSum:0,roasSum:0,roasCount:0,count:0};
  rows.forEach(r => {
    const h = r.hour;
    if (h<0||h>23) return;
    map[h].count++; map[h].salesSum += r.gmvHr; map[h].adSum += r.adHr;
    if (r.roasHr>0){map[h].roasSum+=r.roasHr; map[h].roasCount++;}
  });
  return Array.from({length:24},(_,h)=>({
    hour:h,
    avgSales: map[h].count ? Math.round(map[h].salesSum/map[h].count) : 0,
    avgAd:    map[h].count ? +(map[h].adSum/map[h].count).toFixed(1) : 0,
    avgRoas:  map[h].roasCount ? +(map[h].roasSum/map[h].roasCount).toFixed(1) : 0,
  }));
}

function buildHosts(rows) {
  // Overall totals (all-time)
  const overall = buildHostsForRows(rows);

  // Per-month breakdown — needed so the dashboard can filter "host ranking" by a single month
  const byMonth = {};
  rows.forEach(r => {
    if (!r.date) return;
    const m = r.date.slice(0, 7);
    if (!byMonth[m]) byMonth[m] = [];
    byMonth[m].push(r);
  });
  const monthly = Object.keys(byMonth).sort().map(m => ({
    month: m,
    hosts: buildHostsForRows(byMonth[m]),
  }));

  return { all: overall, byMonth: monthly };
}

function buildHostsForRows(rows) {
  const map = {};
  rows.forEach(r => {
    const n = r.host||"ไม่ระบุ";
    if (!map[n]) map[n]={name:n,sales:0,orders:0,cart:0,hours:0,sessions:new Set()};
    map[n].sales+=r.gmvHr; map[n].orders+=r.ordHr; map[n].cart+=r.cartHr;
    map[n].sessions.add(r.session);
    if (r.gmvHr>0||r.hour>=0) map[n].hours++;
  });
  return Object.values(map)
    .map(h=>({...h,sessions:h.sessions.size,avgPerHour:h.hours?Math.round(h.sales/h.hours):0}))
    .sort((a,b)=>b.sales-a.sales);
}

function buildDaily(rows) {
  const map = {};
  rows.forEach(r => {
    if (!r.date) return;
    if (!map[r.date]) map[r.date]={date:r.date,sales:0,orders:0,ad:0};
    map[r.date].sales+=r.gmvHr; map[r.date].orders+=r.ordHr; map[r.date].ad+=r.adHr;
  });
  return Object.values(map).sort((a,b)=>a.date.localeCompare(b.date));
}

function buildCampaign(rows) {
  const DOUBLE=new Set(["04-04","05-05","06-06","07-07","08-08","09-09","10-10","11-11","12-12"]);
  const PAYDAY=new Set(["04-25","05-25","06-25","07-25"]);
  const MID=new Set(["04-15","05-15","06-15","07-15"]);
  const cats={
    double_day:{label:"Double Day",total:0,days:{}},
    payday:{label:"Payday (25)",total:0,days:{}},
    midmonth:{label:"Midmonth (15)",total:0,days:{}},
    end_month:{label:"ปลายเดือน 28-31",total:0,days:{}},
    normal:{label:"วันปกติ",total:0,days:{}},
  };
  buildDaily(rows).forEach(d => {
    const mmdd=d.date.slice(5); const dd=parseInt(d.date.slice(8));
    let key="normal";
    if(DOUBLE.has(mmdd)) key="double_day";
    else if(PAYDAY.has(mmdd)) key="payday";
    else if(MID.has(mmdd)) key="midmonth";
    else if(dd>=28) key="end_month";
    cats[key].days[d.date]=(cats[key].days[d.date]||0)+d.sales;
    cats[key].total+=d.sales;
  });
  const normalAvg=Object.keys(cats.normal.days).length?cats.normal.total/Object.keys(cats.normal.days).length:1;
  return Object.values(cats).map(c=>{
    const count=Object.keys(c.days).length;
    const avgPerDay=count?Math.round(c.total/count):0;
    return{label:c.label,count,total:Math.round(c.total),avgPerDay,vsNormal:normalAvg>0?Math.round((avgPerDay/normalAvg-1)*100):0};
  });
}

// ────────────────────────────────────────────────────────────
// MULTI-CHANNEL MERGE
// ────────────────────────────────────────────────────────────
function mergeChannels(channels) {
  if (!channels.length) return emptyChannel("combined", 0);
  if (channels.length === 1) return channels[0];

  // Merge monthly: sum same month across channels
  const monthMap = {};
  channels.forEach(ch => {
    (ch.monthly||[]).forEach(m => {
      if (!monthMap[m.month]) monthMap[m.month] = {...m, sales:0, gmvHr:0, orders:0, cart:0, adSpend:0, sessions:0, roasArr:[]};
      monthMap[m.month].sales    += m.sales;
      monthMap[m.month].gmvHr   += m.gmvHr;
      monthMap[m.month].orders  += m.orders;
      monthMap[m.month].cart    += m.cart;
      monthMap[m.month].adSpend += m.adSpend;
      monthMap[m.month].sessions += m.sessions;
      if (m.roas > 0) monthMap[m.month].roasArr.push(m.roas);
    });
  });
  const monthly = Object.keys(monthMap).sort().map(k => {
    const m = monthMap[k];
    return {...m, roas: m.roasArr.length ? +(m.roasArr.reduce((a,b)=>a+b,0)/m.roasArr.length).toFixed(1) : 0};
  });

  // Merge hourly: average avgSales
  const hourly = Array.from({length:24},(_,h) => {
    const hrs = channels.map(ch => (ch.hourly||[])[h]||{avgSales:0,avgAd:0,avgRoas:0});
    return {
      hour: h,
      avgSales: Math.round(hrs.reduce((s,x)=>s+x.avgSales,0)/hrs.length),
      avgAd:    +(hrs.reduce((s,x)=>s+x.avgAd,0)/hrs.length).toFixed(1),
      avgRoas:  +(hrs.filter(x=>x.avgRoas>0).reduce((s,x)=>s+x.avgRoas,0)/Math.max(hrs.filter(x=>x.avgRoas>0).length,1)).toFixed(1),
    };
  });

  // Merge hosts: combine "all" totals across channels
  const hostMap = {};
  channels.forEach(ch => {
    const chHosts = (ch.hosts && ch.hosts.all) || [];
    chHosts.forEach(h => {
      if (!hostMap[h.name]) hostMap[h.name] = {...h, sales:0, orders:0, cart:0, hours:0, sessions:0};
      hostMap[h.name].sales   += h.sales;
      hostMap[h.name].orders  += h.orders;
      hostMap[h.name].hours   += h.hours;
      hostMap[h.name].sessions += h.sessions;
    });
  });
  const hostsAll = Object.values(hostMap)
    .map(h=>({...h, avgPerHour: h.hours?Math.round(h.sales/h.hours):0}))
    .sort((a,b)=>b.sales-a.sales);

  // Merge hosts: combine per-month breakdown across channels
  const hostMonthMap = {};
  channels.forEach(ch => {
    const chByMonth = (ch.hosts && ch.hosts.byMonth) || [];
    chByMonth.forEach(mEntry => {
      if (!hostMonthMap[mEntry.month]) hostMonthMap[mEntry.month] = {};
      mEntry.hosts.forEach(h => {
        const bucket = hostMonthMap[mEntry.month];
        if (!bucket[h.name]) bucket[h.name] = {...h, sales:0, orders:0, cart:0, hours:0, sessions:0};
        bucket[h.name].sales   += h.sales;
        bucket[h.name].orders  += h.orders;
        bucket[h.name].hours   += h.hours;
        bucket[h.name].sessions += h.sessions;
      });
    });
  });
  const hostsByMonth = Object.keys(hostMonthMap).sort().map(m => ({
    month: m,
    hosts: Object.values(hostMonthMap[m])
      .map(h=>({...h, avgPerHour: h.hours?Math.round(h.sales/h.hours):0}))
      .sort((a,b)=>b.sales-a.sales),
  }));

  const hosts = { all: hostsAll, byMonth: hostsByMonth };

  // Merge daily
  const dayMap = {};
  channels.forEach(ch => {
    (ch.daily||[]).forEach(d => {
      if (!dayMap[d.date]) dayMap[d.date]={...d,sales:0,orders:0,ad:0};
      dayMap[d.date].sales  += d.sales;
      dayMap[d.date].orders += d.orders;
      dayMap[d.date].ad     += d.ad;
    });
  });
  const daily = Object.values(dayMap).sort((a,b)=>a.date.localeCompare(b.date));

  // Merge organic
  const orgMonthMap = {};
  channels.forEach(ch => {
    (ch.organic?.monthly||[]).forEach(m => {
      if (!orgMonthMap[m.month]) orgMonthMap[m.month]={...m,orgGmv:0,adGmv:0,total:0,orgPctArr:[]};
      orgMonthMap[m.month].orgGmv += m.orgGmv;
      orgMonthMap[m.month].adGmv  += m.adGmv;
      orgMonthMap[m.month].total  += m.total;
      if(m.orgPct>0) orgMonthMap[m.month].orgPctArr.push(m.orgPct);
    });
  });
  const orgMonthly = Object.values(orgMonthMap).sort((a,b)=>a.month.localeCompare(b.month)).map(m=>{
    const tot=m.orgGmv+m.adGmv;
    const orgPct = tot>0?Math.round(m.orgGmv/tot*100):(m.orgPctArr.length?Math.round(m.orgPctArr.reduce((a,b)=>a+b,0)/m.orgPctArr.length):0);
    return{...m,orgPct,adPct:100-orgPct};
  });

  const avgHealth = channels.reduce((s,ch)=>s+(ch.organic?.channelHealthScore||0),0)/channels.length;
  const organic = {
    monthly: orgMonthly,
    channelHealthScore: Math.round(avgHealth),
    healthLabel: avgHealth>=60?"รวมทุกช่อง: กำลังติด 🔥":avgHealth>=35?"รวมทุกช่อง: กำลังเติบโต":"รวมทุกช่อง: ต้องสร้าง organic",
    healthColor: avgHealth>=60?"green":avgHealth>=35?"gold":"orange",
  };

  return { channelName:"รวมทุกช่อง", monthly, hourly, hosts, daily, organic, campaign: channels[0].campaign };
}

// ────────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────────
function num(v){if(v==null||v==="")return 0;const n=parseFloat(String(v).replace(/,/g,""));return isNaN(n)?0:n;}
function clean(v){return String(v||"").trim();}
function fmtDate(v){if(!v)return"";const m=String(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);if(m)return`${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;return v;}
function emptyChannel(id,idx){return{sheetId:id,channelName:`ช่อง ${idx+1}`,monthly:[],hourly:[],hosts:{all:[],byMonth:[]},daily:[],campaign:[],organic:{monthly:[],hourly:[],channelHealthScore:0,healthLabel:"ไม่มีข้อมูล",healthColor:"gray"}};}
