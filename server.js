// HERBALINN 运营工作台 - deploy trigger
const express = require('express');
const { createClient } = require('@libsql/client');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const TURSO_URL = process.env.TURSO_URL || 'file:herbalinn.db';
const TURSO_TOKEN = process.env.TURSO_TOKEN || '';

const client = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

async function initDB() {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
      display_name TEXT NOT NULL, role TEXT NOT NULL
    )
  `);
  await client.execute(`CREATE TABLE IF NOT EXISTS contents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_no TEXT UNIQUE NOT NULL, topic_no TEXT, topic_title TEXT,
    platform TEXT, format TEXT, copy TEXT,
    status TEXT DEFAULT '待发布', publish_time TEXT,
    exposure INTEGER DEFAULT 0, engagement INTEGER DEFAULT 0,
    dms INTEGER DEFAULT 0, leads INTEGER DEFAULT 0,
    violation TEXT, executor TEXT,
    created_at TEXT, updated_at TEXT
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_no TEXT UNIQUE NOT NULL, name TEXT, contact TEXT, city TEXT,
    source_channel TEXT, utm_tag TEXT, source_content_no TEXT,
    need_type TEXT, stage TEXT DEFAULT '新线索', tags TEXT, handler TEXT,
    created_at TEXT, updated_at TEXT
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS followups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    followup_no TEXT UNIQUE NOT NULL, customer_no TEXT,
    followup_time TEXT, method TEXT, diagnosis TEXT,
    objection TEXT, objection_detail TEXT,
    next_action TEXT, script_ref TEXT,
    next_followup_time TEXT, follower TEXT, result TEXT,
    created_at TEXT
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS platforms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform_no TEXT UNIQUE NOT NULL,
    name TEXT,
    platform_type TEXT DEFAULT '海外直邮',
    channel_level TEXT,
    progress TEXT DEFAULT '待跟进',
    handler TEXT,
    official_url TEXT,
    info_gap TEXT,
    next_action TEXT,
    deadline TEXT,
    created_at TEXT
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no TEXT UNIQUE NOT NULL, customer_no TEXT,
    product_type TEXT, quantity INTEGER DEFAULT 1,
    amount REAL DEFAULT 0, pay_status TEXT DEFAULT '待支付',
    pay_time TEXT, delivery_status TEXT DEFAULT '待发货',
    rebuy_count INTEGER DEFAULT 0, created_at TEXT
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS funnels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    week TEXT, date_range TEXT,
    publishes INTEGER DEFAULT 0, leads INTEGER DEFAULT 0,
    diagnosed INTEGER DEFAULT 0, sales_talks INTEGER DEFAULT 0,
    first_orders INTEGER DEFAULT 0, monthly_cards INTEGER DEFAULT 0,
    rebuys INTEGER DEFAULT 0,
    lead_to_diag_rate REAL, diag_to_pay_rate REAL,
    pay_to_card_rate REAL, cac REAL,
    auto_save_hours REAL, auto_error_rate REAL,
    status TEXT DEFAULT '黄', created_at TEXT
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT, message TEXT, related_id TEXT,
    created_by TEXT DEFAULT 'system', created_at TEXT
  )`);

  // Init users
  const initUsers = [
    ['chendanqian','hl2026','陈丹千','founder'],
    ['amy','hl2026','Amy','ops'],
    ['xiaoliao','hl2026','小廖','growth'],
    ['zhangcheng','hl2026','张成','tech'],
    ['zhuqi','hl2026','朱琦','content'],
    ['xiaojing','hl2026','小静','service'],
  ];
  for (const u of initUsers) {
    const r = await client.execute({sql:'SELECT id FROM users WHERE username=?',args:[u[0]]});
    if (!r.rows.length) await client.execute({sql:'INSERT INTO users (username,password,display_name,role) VALUES (?,?,?,?)',args:u});
  }
  console.log('Turso database ready');
}

// Helpers
function getUser(req) {
  const name = decodeURIComponent((req.headers['x-user-display'] || '访客').replace(/[\n\r<>]/g,''));
  const phone = (req.headers['x-user-phone'] || '').replace(/[\n\r<>]/g,'');
  return phone ? `${name}(${phone.slice(-4)})` : name;
}

async function logActivity(type, message, relatedId, user) {
  const now = new Date().toISOString().replace('T',' ').slice(0,19);
  await client.execute({sql:'INSERT INTO activity_log (type,message,related_id,created_by,created_at) VALUES (?,?,?,?,?)',args:[type,message,String(relatedId||''),user||'system',now]});
}

const PREFIX={content:'CT',customer:'CU',followup:'FU',order:'OR'};
function generateNo(prefix) { const now=new Date(); const dd=String(now.getDate()).padStart(2,'0'),hh=String(now.getHours()).padStart(2,'0'),mm=String(now.getMinutes()).padStart(2,'0'),ss=String(now.getSeconds()).padStart(2,'0'); return prefix+'-'+dd+hh+mm+ss; }



async function getCols(table) {
  const r = await client.execute(`PRAGMA table_info(${table})`);
  return r.rows.map(c => c.name);
}

async function checkAutoFlow(event, id, data, user) {
  const now = new Date().toISOString().replace('T',' ').slice(0,19);
  if (event==='customer_stage_change'&&data.stage==='已诊断') {
    await logActivity('auto_flow', `客户 ${data.customer_no} 进入"已诊断"，建议创建跟进`, String(id), 'system');
  }
  if (event==='followup_won'&&data.customer_no) {
    const c = (await client.execute({sql:'SELECT * FROM customers WHERE customer_no=?',args:[data.customer_no]})).rows[0];
    if (c&&c.stage!=='已购5L'&&c.stage!=='月卡') {
      await client.execute({sql:"UPDATE customers SET stage='待体验' WHERE customer_no=?",args:[data.customer_no]});
      await logActivity('auto_flow', `客户 ${data.customer_no} 跟进成交→"待体验"`, String(id), 'system');
    }
  }
  if (event==='order_paid'&&data.customer_no) {
    const ns = (data.product_type||'').includes('月卡')?'月卡':'已购5L';
    await client.execute({sql:'UPDATE customers SET stage=? WHERE customer_no=?',args:[ns,data.customer_no]});
    await logActivity('auto_flow', `客户 ${data.customer_no} 支付成功→"${ns}"`, String(id), 'system');
  }
}

// Init & start
initDB().then(() => {
  app.use(express.json({limit:'5mb'}));
  app.use(express.static(path.join(__dirname,'public')));

  const tables = ['contents','customers','followups','orders','funnels','platforms'];
  tables.forEach(t => {
    const singular = t.replace(/s$/,'');
    const noKey = `${singular}_no`;
    
    app.get(`/api/${t}`, async (req,res) => {
      const r = await client.execute(`SELECT * FROM ${t} ORDER BY created_at DESC`);
      res.json(r.rows);
    });
    
    app.get(`/api/${t}/:id`, async (req,res) => {
      const r = await client.execute({sql:`SELECT * FROM ${t} WHERE id=?`,args:[req.params.id]});
      r.rows[0] ? res.json(r.rows[0]) : res.status(404).json({error:'未找到'});
    });
    
    app.post(`/api/${t}`, async (req,res) => {
      const user = getUser(req);
      const now = new Date().toISOString().replace('T',' ').slice(0,19);
      const cols = (await getCols(t)).filter(c => c!=='id'&&c!=='created_at'&&c!=='updated_at');
      
      if (!req.body[noKey]) {
        const cnt = (await client.execute(`SELECT COUNT(*) as c FROM ${t} WHERE ${noKey} LIKE '${singular.toUpperCase()}-%'`)).rows[0].c;
        req.body[noKey] = generateNo(singular, seq);
      }
      
      const allCols = [...cols];
      if (!allCols.includes('created_at')) { allCols.push('created_at'); }
      const ph = allCols.map(()=>'?').join(',');
      const vals = allCols.map(c => c==='created_at'?now:(req.body[c]!==undefined?req.body[c]:null));
      
      try {
        await client.execute({sql:`INSERT INTO ${t} (${allCols.join(',')}) VALUES (${ph})`,args:vals});
        const r = (await client.execute(`SELECT last_insert_rowid()`)).rows[0]['last_insert_rowid()'];
        
        if (t==='customers'&&req.body.stage) await checkAutoFlow('customer_stage_change', r, req.body, user);
        if (t==='followups'&&req.body.result==='已成交') await checkAutoFlow('followup_won', r, req.body, user);
        if (t==='orders'&&req.body.pay_status==='已支付') await checkAutoFlow('order_paid', r, req.body, user);
        
        await logActivity('create', `${user} 创建${singular}: ${req.body[noKey]||r}`, String(r), user);
        res.json({ok:true, id:r});
      } catch(e) { res.status(400).json({error:e.message}); }
    });
    
    app.put(`/api/${t}/:id`, async (req,res) => {
      const user = getUser(req);
      const cols = (await getCols(t)).filter(c => c!=='id'&&c!=='created_at'&&c!=='updated_at');
      const sets = cols.map(c=>`${c}=?`).join(',');
      const vals = cols.map(c => req.body[c]!==undefined?req.body[c]:null);
      
      try {
        if (t==='customers'&&req.body.stage) {
          const old = (await client.execute({sql:'SELECT stage FROM customers WHERE id=?',args:[req.params.id]})).rows[0];
          if (old&&old.stage!==req.body.stage) await checkAutoFlow('customer_stage_change', req.params.id, req.body, user);
        }
        vals.push(req.params.id);
        await client.execute({sql:`UPDATE ${t} SET ${sets} WHERE id=?`,args:vals});
        await logActivity('update', `${user} 更新${singular} #${req.params.id}`, req.params.id, user);
        res.json({ok:true});
      } catch(e) { res.status(400).json({error:e.message}); }
    });
    
    app.delete(`/api/${t}/:id`, async (req,res) => {
      const user = getUser(req);
      await client.execute({sql:`DELETE FROM ${t} WHERE id=?`,args:[req.params.id]});
      await logActivity('delete', `${user} 删除${singular} #${req.params.id}`, req.params.id, user);
      res.json({ok:true});
    });
  });

  // Auto-funnel
  app.get('/api/funnel-auto', async (req,res) => {
    const today = new Date().toISOString().slice(0,10);
    const d60 = new Date(Date.now()-60*86400000).toISOString().slice(0,10);
    
    const publishes = (await client.execute({sql:`SELECT COUNT(*) as c FROM contents WHERE publish_time>=? AND status='已发布'`,args:[d60]})).rows[0].c||0;
    const leads = (await client.execute({sql:`SELECT COUNT(*) as c FROM customers WHERE created_at>=?`,args:[d60]})).rows[0].c||0;
    const diagnosed = (await client.execute({sql:`SELECT COUNT(*) as c FROM customers WHERE stage NOT IN ('新线索','流失') AND updated_at>=?`,args:[d60]})).rows[0].c||0;
    const salesTalks = (await client.execute({sql:`SELECT COUNT(*) as c FROM followups WHERE followup_time>=?`,args:[d60]})).rows[0].c||0;
    const firstOrders = (await client.execute({sql:`SELECT COUNT(*) as c FROM orders WHERE created_at>=? AND pay_status='已支付'`,args:[d60]})).rows[0].c||0;
    const monthlyCards = (await client.execute({sql:`SELECT COUNT(*) as c FROM orders WHERE created_at>=? AND product_type='月卡' AND pay_status='已支付'`,args:[d60]})).rows[0].c||0;
    
    const topContents = (await client.execute(`SELECT content_no,topic_title,platform,leads,engagement FROM contents WHERE leads>0 ORDER BY leads DESC LIMIT 8`)).rows;
    const sourceBreakdown = (await client.execute(`SELECT source_channel,COUNT(*) as c FROM customers WHERE source_channel IS NOT NULL AND source_channel!='' GROUP BY source_channel ORDER BY c DESC`)).rows;
    
    const newLeads = (await client.execute(`SELECT COUNT(*) as c FROM customers WHERE stage='新线索'`)).rows[0].c||0;
    const inPipeline = (await client.execute(`SELECT COUNT(*) as c FROM customers WHERE stage IN ('已诊断','待体验','体验后跟进')`)).rows[0].c||0;
    const bought = (await client.execute(`SELECT COUNT(*) as c FROM customers WHERE stage IN ('已购5L','月卡')`)).rows[0].c||0;
    const total = (await client.execute(`SELECT COUNT(*) as c FROM customers`)).rows[0].c||0;
    
    res.json({
      period: `近60天 (${d60} ~ ${today})`,
      publishes, leads, diagnosed, salesTalks, firstOrders, monthlyCards,
      topContents, sourceBreakdown,
      pipeline: { newLeads, inPipeline, bought, total,
        leadToPipeline: newLeads>0?((inPipeline+bought)/newLeads*100).toFixed(1):0,
        pipelineToBuy: (inPipeline+bought)>0?(bought/(inPipeline+bought)*100).toFixed(1):0,
        overallConversion: total>0?(bought/total*100).toFixed(1):0
      }
    });
  });

  // Backup & restore
  app.get('/api/backup', async (req,res) => {
    const bkTables = ['contents','customers','followups','orders','funnels','activity_log'];
    const backup = {};
    for (const t of bkTables) { backup[t] = (await client.execute(`SELECT * FROM ${t}`)).rows; }
    backup._exportedAt = new Date().toISOString();
    backup._recordCount = bkTables.reduce((s,t)=>s+backup[t].length,0);
    res.json(backup);
  });

  app.post('/api/restore', async (req,res) => {
    const user = getUser(req);
    const bkTables = ['contents','customers','followups','orders','funnels','activity_log'];
    let restored = 0;
    try {
      for (const t of bkTables) {
        if (req.body[t] && Array.isArray(req.body[t])) {
          await client.execute(`DELETE FROM ${t}`);
          const cols = (await getCols(t)).filter(c => c!=='id');
          for (const row of req.body[t]) {
            const keys = cols.filter(c => row[c] !== undefined);
            if (keys.length) {
              const ph = keys.map(()=>'?').join(',');
              const vals = keys.map(c => row[c]);
              await client.execute({sql:`INSERT INTO ${t} (${keys.join(',')}) VALUES (${ph})`,args:vals});
              restored++;
            }
          }
        }
      }
      await logActivity('restore', `${user} 恢复了 ${restored} 条数据`, 'backup', user);
      res.json({ok:true, restored});
    } catch(e) { res.status(400).json({error:e.message}); }
  });

  // Stats
  app.get('/api/stats', async (req,res) => {
    const today = new Date().toISOString().slice(0,10);
    const now = new Date(Date.now()+8*3600000).toISOString().slice(0,19);
    const leadCount = (await client.execute(`SELECT COUNT(*) as c FROM customers`)).rows[0].c;
    const orderCount = (await client.execute(`SELECT COUNT(*) as c FROM orders WHERE pay_status='已支付'`)).rows[0].c;
    const monthCardCount = (await client.execute(`SELECT COUNT(*) as c FROM orders WHERE product_type='月卡' AND pay_status='已支付'`)).rows[0].c;
const overdueCount = (await client.execute("SELECT COUNT(*) as c FROM followups WHERE result NOT IN ('已成交','已流失') AND next_followup_time IS NOT NULL AND next_followup_time < '" + now + "'")).rows[0].c;
    const noFollowupCount = (await client.execute(`SELECT COUNT(*) as c FROM customers WHERE stage='新线索' AND customer_no NOT IN (SELECT DISTINCT customer_no FROM followups)`)).rows[0].c;
    const stageDist = (await client.execute(`SELECT stage,COUNT(*) as c FROM customers GROUP BY stage`)).rows;
    const converted = (await client.execute(`SELECT COUNT(*) as c FROM customers WHERE stage IN ('已购5L','月卡')`)).rows[0].c;
    const conversionRate = leadCount>0?(converted/leadCount*100).toFixed(1):0;
    const recentActivity = (await client.execute(`SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 20`)).rows;
    res.json({leadCount,orderCount,monthCardCount,overdueCount,noFollowupCount,stageDist,conversionRate,recentActivity});
  });

  // Alerts
app.get('/api/alerts', async (req,res) => {
    const alerts = [];
    const today = new Date().toISOString().slice(0,10);
    const now = new Date(Date.now()+8*3600000).toISOString().slice(0,19);
    const d3 = new Date(Date.now()-3*86400000).toISOString().slice(0,10);
    try {
      const q1 = "SELECT f.followup_no,f.customer_no,f.followup_time,f.next_followup_time,f.result,f.id,COALESCE(c.name,f.customer_no) as cn FROM followups f LEFT JOIN customers c ON f.customer_no=c.customer_no WHERE f.result NOT IN ('已成交','已流失') AND f.next_followup_time IS NOT NULL AND f.next_followup_time < '" + now + "'";
      const overdue = (await client.execute(q1)).rows || [];
      overdue.forEach(f => alerts.push({type:'overdue', level:'danger', title:'逾期未跟进', detail: f.cn + ' 上次' + (f.followup_time||'') + ' 下次' + (f.next_followup_time||''), relatedId: f.id}));
    } catch(e) { console.log('Alert1 err:', e.message); }
    try {
      const q2 = "SELECT customer_no,name,created_at,id FROM customers WHERE stage='新线索' AND created_at < '" + d3 + "' AND customer_no NOT IN (SELECT DISTINCT customer_no FROM followups)";
      const nofu = (await client.execute(q2)).rows || [];
      nofu.forEach(c => alerts.push({type:'no_followup', level:'warning', title:'超3天未跟进', detail: (c.name||c.customer_no) + ' ' + ((c.created_at||'').slice(0,10)) + ' 入库，尚未首次跟进', relatedId: c.id}));
    } catch(e) { console.log('Alert2 err:', e.message); }
    res.json(alerts);
  });


  // Report
  app.get('/api/report/:type', async (req,res) => {
    const today = new Date().toISOString().slice(0,10);
    const ds = req.params.type==='weekly'?new Date(Date.now()-7*86400000).toISOString().slice(0,10):today;
    const publishes = (await client.execute({sql:`SELECT COUNT(*) as c FROM contents WHERE publish_time>=? AND publish_time<=? AND status='已发布'`,args:[ds,today+' 23:59:59']})).rows[0]?.c||0;
    const newLeads = (await client.execute({sql:`SELECT COUNT(*) as c FROM customers WHERE created_at>=? AND created_at<=?`,args:[ds,today+' 23:59:59']})).rows[0]?.c||0;
    const diagnosed = (await client.execute({sql:`SELECT COUNT(*) as c FROM customers WHERE stage NOT IN ('新线索','流失') AND updated_at>=? AND updated_at<=?`,args:[ds,today+' 23:59:59']})).rows[0]?.c||0;
    const talks = (await client.execute({sql:`SELECT COUNT(*) as c FROM followups WHERE followup_time>=? AND followup_time<=?`,args:[ds,today+' 23:59:59']})).rows[0]?.c||0;
    const orders = (await client.execute({sql:`SELECT COUNT(*) as c FROM orders WHERE created_at>=? AND created_at<=? AND pay_status='已支付'`,args:[ds,today+' 23:59:59']})).rows[0]?.c||0;
    const monthlyCards = (await client.execute({sql:`SELECT COUNT(*) as c FROM orders WHERE created_at>=? AND created_at<=? AND product_type='月卡' AND pay_status='已支付'`,args:[ds,today+' 23:59:59']})).rows[0]?.c||0;
    res.json({period:req.params.type==='daily'?'今日':'近7天',dateRange:`${ds} ~ ${today}`, publishes,newLeads,diagnosed,talks,orders,monthlyCards});
  });

  app.get('/api/activity-log', async (req,res) => {
    res.json((await client.execute(`SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 50`)).rows);
  });

  app.listen(PORT, () => console.log(`HERBALINN on port ${PORT}, Turso: ${TURSO_URL}`));
});
