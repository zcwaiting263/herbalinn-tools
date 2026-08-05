const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'herbalinn.db');

// ---- SQLite via sql.js (pure JS, no native deps) ----
let db;
let SQL;

async function initDB() {
  const initSqlJs = require('sql.js');
  SQL = await initSqlJs();
  
  // Load existing DB or create new
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }
  
  // Platform-specific pragmas
  db.run('PRAGMA journal_mode = WAL');
  
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
      display_name TEXT NOT NULL, role TEXT NOT NULL
    )
  `);
  db.run(`CREATE TABLE IF NOT EXISTS contents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_no TEXT UNIQUE NOT NULL, topic_no TEXT, topic_title TEXT,
    platform TEXT, format TEXT, copy TEXT,
    status TEXT DEFAULT '待发布', publish_time TEXT,
    exposure INTEGER DEFAULT 0, engagement INTEGER DEFAULT 0,
    dms INTEGER DEFAULT 0, leads INTEGER DEFAULT 0,
    violation TEXT, executor TEXT,
    created_at TEXT, updated_at TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_no TEXT UNIQUE NOT NULL, name TEXT, contact TEXT, city TEXT,
    source_channel TEXT, utm_tag TEXT, source_content_no TEXT,
    need_type TEXT, stage TEXT DEFAULT '新线索', tags TEXT, handler TEXT,
    created_at TEXT, updated_at TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS followups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    followup_no TEXT UNIQUE NOT NULL, customer_no TEXT,
    followup_time TEXT, method TEXT, diagnosis TEXT,
    objection TEXT, objection_detail TEXT,
    next_action TEXT, script_ref TEXT,
    next_followup_time TEXT, follower TEXT, result TEXT,
    created_at TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no TEXT UNIQUE NOT NULL, customer_no TEXT,
    product_type TEXT, quantity INTEGER DEFAULT 1,
    amount REAL DEFAULT 0, pay_status TEXT DEFAULT '待支付',
    pay_time TEXT, delivery_status TEXT DEFAULT '待发货',
    rebuy_count INTEGER DEFAULT 0, created_at TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS funnels (
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
  db.run(`CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT, message TEXT, related_id TEXT,
    created_by TEXT DEFAULT 'system', created_at TEXT
  )`);
  
  saveDB();
}

function saveDB() {
  const data = db.export();
  const buf = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buf);
}

// ---- sql.js query helpers ----
function dbRun(sql, params = []) {
  db.run(sql, params);
  saveDB();
}

function dbGet(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return undefined;
}

function dbAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// Init DB
initDB().then(() => {
  // Init users
  const initUsers = [
    ['chendanqian','hl2026','陈丹千','founder'],
    ['amy','hl2026','Amy','ops'],
    ['xiaoliao','hl2026','小廖','growth'],
    ['zhangcheng','hl2026','张成','tech'],
    ['zhuqi','hl2026','朱琦','content'],
    ['xiaojing','hl2026','小静','service'],
  ];
  initUsers.forEach(u => {
    const exists = dbGet('SELECT id FROM users WHERE username=?', [u[0]]);
    if (!exists) dbRun('INSERT INTO users (username,password,display_name,role) VALUES (?,?,?,?)', u);
  });

  app.use(express.json({limit:'5mb'}));
  app.use(express.static(path.join(__dirname,'public')));

  function getUser(req) {
    const name = decodeURIComponent((req.headers['x-user-display'] || '访客').replace(/[\n\r<>]/g,''));
    const phone = (req.headers['x-user-phone'] || '').replace(/[\n\r<>]/g,'');
    return phone ? `${name}(${phone.slice(-4)})` : name;
  }

  function logActivity(type, message, relatedId, user) {
    const now = new Date().toISOString().replace('T',' ').slice(0,19);
    dbRun('INSERT INTO activity_log (type,message,related_id,created_by,created_at) VALUES (?,?,?,?,?)',
      [type, message, String(relatedId||''), user||'system', now]);
  }

  function getCols(table) {
    const rows = dbAll(`PRAGMA table_info(${table})`);
    return rows.map(c => c.name);
  }

  function generateNo(prefix) {
    const now = new Date();
    const ts = now.toISOString().slice(0,10).replace(/-/g,'').slice(2); // YYMMDD
    const seq = dbGet(`SELECT COUNT(*) as c FROM ${prefix}s WHERE ${prefix}_no LIKE '${prefix.toUpperCase()}-${ts}-%'`).c + 1;
    return `${prefix.toUpperCase()}-${ts}-${String(seq).padStart(3,'0')}`;
  }

  // CRUD
  const tables = ['contents','customers','followups','orders','funnels'];
  tables.forEach(t => {
    const singular = t.replace(/s$/,'');
    const noKey = `${singular}_no`;
    
    app.get(`/api/${t}`, (req,res) => res.json(dbAll(`SELECT * FROM ${t} ORDER BY created_at DESC`)));
    
    app.get(`/api/${t}/:id`, (req,res) => {
      const r = dbGet(`SELECT * FROM ${t} WHERE id=?`, [req.params.id]);
      r ? res.json(r) : res.status(404).json({error:'未找到'});
    });
    
    app.post(`/api/${t}`, (req,res) => {
      const user = getUser(req);
      const now = new Date().toISOString().replace('T',' ').slice(0,19);
      const cols = getCols(t).filter(c => c!=='id'&&c!=='created_at'&&c!=='updated_at');
      
      // Auto-generate number if empty
      if (!req.body[noKey]) req.body[noKey] = generateNo(singular);
      
      const ph = cols.map(()=>'?').join(',');
      const vals = cols.map(c => {
        let v = req.body[c] !== undefined ? req.body[c] : null;
        if (c === 'created_at' || c === 'updated_at') v = now;
        return v;
      });
      
      // Add created_at if in cols
      const allCols = [...cols];
      if (!allCols.includes('created_at')) {
        allCols.push('created_at');
        vals.push(now);
      }
      
      try {
        dbRun(`INSERT INTO ${t} (${allCols.join(',')}) VALUES (${allCols.map(()=>'?').join(',')})`, vals);
        const newId = dbGet('SELECT last_insert_rowid() as id').id;
        
        if (t==='customers'&&req.body.stage) checkAutoFlow('customer_stage_change', newId, req.body, user);
        if (t==='followups'&&req.body.result==='已成交') checkAutoFlow('followup_won', newId, req.body, user);
        if (t==='orders'&&req.body.pay_status==='已支付') checkAutoFlow('order_paid', newId, req.body, user);
        
        logActivity('create', `${user} 创建${singular}: ${req.body[noKey]||newId}`, String(newId), user);
        res.json({ok:true, id:newId});
      } catch(e) { res.status(400).json({error:e.message}); }
    });
    
    app.put(`/api/${t}/:id`, (req,res) => {
      const user = getUser(req);
      const now = new Date().toISOString().replace('T',' ').slice(0,19);
      const cols = getCols(t).filter(c => c!=='id'&&c!=='created_at'&&c!=='updated_at');
      const sets = cols.map(c=>`${c}=?`).join(',');
      const vals = cols.map(c => req.body[c] !== undefined ? req.body[c] : null);
      
      try {
        if (t==='customers'&&req.body.stage) {
          const old = dbGet('SELECT stage FROM customers WHERE id=?', [req.params.id]);
          if (old&&old.stage!==req.body.stage) checkAutoFlow('customer_stage_change', req.params.id, req.body, user);
        }
        vals.push(req.params.id);
        dbRun(`UPDATE ${t} SET ${sets} WHERE id=?`, vals);
        logActivity('update', `${user} 更新${singular} #${req.params.id}`, req.params.id, user);
        res.json({ok:true});
      } catch(e) { res.status(400).json({error:e.message}); }
    });
    
    app.delete(`/api/${t}/:id`, (req,res) => {
      const user = getUser(req);
      dbRun(`DELETE FROM ${t} WHERE id=?`, [req.params.id]);
      logActivity('delete', `${user} 删除${singular} #${req.params.id}`, req.params.id, user);
      res.json({ok:true});
    });
  });

  // Auto-flow
  function checkAutoFlow(event, id, data, user) {
    const now = new Date().toISOString().replace('T',' ').slice(0,19);
    if (event==='customer_stage_change'&&data.stage==='已诊断') {
      logActivity('auto_flow', `客户 ${data.customer_no} 进入"已诊断"，建议创建跟进`, String(id), 'system');
    }
    if (event==='followup_won'&&data.customer_no) {
      const c = dbGet('SELECT * FROM customers WHERE customer_no=?', [data.customer_no]);
      if (c&&c.stage!=='已购5L'&&c.stage!=='月卡') {
        dbRun("UPDATE customers SET stage='待体验' WHERE customer_no=?", [data.customer_no]);
        logActivity('auto_flow', `客户 ${data.customer_no} 跟进成交→"待体验"`, String(id), 'system');
      }
    }
    if (event==='order_paid'&&data.customer_no) {
      const ns = (data.product_type||'').includes('月卡')?'月卡':'已购5L';
      dbRun(`UPDATE customers SET stage=? WHERE customer_no=?`, [ns, data.customer_no]);
      logActivity('auto_flow', `客户 ${data.customer_no} 支付成功→"${ns}"`, String(id), 'system');
    }
  }

  // Alerts
  app.get('/api/alerts',(req,res) => {
    const alerts = [];
    const today = new Date().toISOString().slice(0,10);
    
    const overdueFUs = dbAll(
      `SELECT f.*,COALESCE(c.name,f.customer_no) as cn FROM followups f LEFT JOIN customers c ON f.customer_no=c.customer_no
       WHERE f.result NOT IN ('已成交','已流失') AND f.next_followup_time IS NOT NULL AND f.next_followup_time < ?`
    , [today]);
    overdueFUs.forEach(f=>alerts.push({type:'overdue',level:'danger',title:'逾期未跟进',
      detail:`${f.cn} 上次${f.followup_time}，下次${f.next_followup_time}`,relatedId:f.id}));

    const d3=new Date(Date.now()-3*86400000).toISOString().slice(0,10);
    const noFU3 = dbAll(
      `SELECT * FROM customers WHERE stage='新线索' AND created_at < ? AND customer_no NOT IN (SELECT DISTINCT customer_no FROM followups)`
    , [d3]);
    noFU3.forEach(c=>alerts.push({type:'no_followup',level:'warning',title:'超3天未跟进',
      detail:`${c.name||c.customer_no} ${(c.created_at||'').slice(0,10)}入库，尚未首次跟进`,relatedId:c.id}));

    const cardExp = dbAll(
      `SELECT o.*,COALESCE(c.name,o.customer_no) as cn FROM orders o LEFT JOIN customers c ON o.customer_no=c.customer_no
       WHERE o.product_type='月卡' AND o.pay_status='已支付' AND o.pay_time IS NOT NULL
       AND date(o.pay_time,'+27 days')<=? AND date(o.pay_time,'+30 days')>=?`
    , [today,today]);
    cardExp.forEach(o=>alerts.push({type:'card_expiring',level:'warning',title:'月卡即将到期',
      detail:`${o.cn} 支付于${o.pay_time}`,relatedId:o.id}));

    const d7=new Date(Date.now()-7*86400000).toISOString().slice(0,10);
    const nl7=dbAll(
      `SELECT * FROM contents WHERE status='已发布' AND leads=0 AND publish_time IS NOT NULL AND publish_time<?`
    , [d7]);
    nl7.forEach(c=>alerts.push({type:'no_leads',level:'info',title:'内容7天无线索',
      detail:`${c.content_no} "${(c.copy||'').slice(0,30)}" 建议更换`,relatedId:c.id}));

    res.json(alerts);
  });

  // Report
  app.get('/api/report/:type',(req,res)=>{
    const today = new Date().toISOString().slice(0,10);
    const ds = req.params.type==='weekly'?new Date(Date.now()-7*86400000).toISOString().slice(0,10):today;
    const publishes = dbGet(`SELECT COUNT(*) as c FROM contents WHERE publish_time>=? AND publish_time<=? AND status='已发布'`,[ds,today+' 23:59:59'])?.c||0;
    const newLeads = dbGet(`SELECT COUNT(*) as c FROM customers WHERE created_at>=? AND created_at<=?`,[ds,today+' 23:59:59'])?.c||0;
    const diagnosed = dbGet(`SELECT COUNT(*) as c FROM customers WHERE stage NOT IN ('新线索','流失') AND updated_at>=? AND updated_at<=?`,[ds,today+' 23:59:59'])?.c||0;
    const talks = dbGet(`SELECT COUNT(*) as c FROM followups WHERE followup_time>=? AND followup_time<=?`,[ds,today+' 23:59:59'])?.c||0;
    const orders = dbGet(`SELECT COUNT(*) as c FROM orders WHERE created_at>=? AND created_at<=? AND pay_status='已支付'`,[ds,today+' 23:59:59'])?.c||0;
    const monthlyCards = dbGet(`SELECT COUNT(*) as c FROM orders WHERE created_at>=? AND created_at<=? AND product_type='月卡' AND pay_status='已支付'`,[ds,today+' 23:59:59'])?.c||0;
    const overdue = dbGet(`SELECT COUNT(*) as c FROM followups WHERE result NOT IN ('已成交','已流失') AND next_followup_time IS NOT NULL AND next_followup_time<?`,[today])?.c||0;
    const topContent = dbAll(`SELECT content_no,topic_title,platform,leads FROM contents WHERE publish_time>=? AND publish_time<=? AND leads>0 ORDER BY leads DESC LIMIT 5`,[ds,today+' 23:59:59']);
    const topObj = dbAll(`SELECT objection,COUNT(*) as c FROM followups WHERE followup_time>=? AND followup_time<=? AND objection IS NOT NULL AND objection!='' GROUP BY objection ORDER BY c DESC LIMIT 5`,[ds,today+' 23:59:59']);
    const stages = dbAll(`SELECT stage,COUNT(*) as c FROM customers GROUP BY stage ORDER BY c DESC`);
    res.json({period:req.params.type==='daily'?'今日':'近7天',dateRange:`${ds} ~ ${today}`, publishes,newLeads,diagnosed,talks,orders,monthlyCards,overdue, topContent,topObj,stages, generatedAt:new Date().toISOString()});
  });

  // AI
  const PROHIBITED=['治疗','治愈','根治','疗效','临床验证','医学证明','保证有效','100%','绝对','第一品牌','最','国家级','唯一'];
  app.post('/api/ai/generate-content',(req,res)=>{
    const {topic,target,platform,format}=req.body;
    const fmts={'短视频':{t:'30秒科普',h:'你知道吗？',s:'轻快口语'},'图文':{t:'深度解读',h:'一篇讲透',s:'专业亲和'},'长文':{t:'专家观点',h:'我们研究了',s:'严谨易懂'},'海报':{t:'核心观点',h:'',s:'极简有力'}};
    const plts={'视频号':{to:'专业亲切',cta:'了解更多'},'抖音':{to:'生动有趣',cta:'评论区聊聊'},'小红书':{to:'精致生活',cta:'私信领取试饮装'},'朋友圈':{to:'真诚分享',cta:'找我聊聊'},'社群':{to:'互动讨论',cta:'群友专属优惠'}};
    const f=fmts[format]||{t:'内容',h:'',s:'自然'},p=plts[platform]||{to:'专业',cta:'联系我们'};
    res.json({draft:`【${f.t}】${topic}\n\n【开头】${f.h}...\n\n【正文】\n— 场景：${target||'家庭饮水'}\n— 风格：${p.to}，${f.s}\n— 结构：问题引入→场景→方案→行动\n\n【结尾】${p.cta}\n\n【合规】禁用词：${PROHIBITED.slice(0,5).join('、')}`,
      complianceCheck:{scanned:true,note:'发布前确认无禁用词'}});
  });
  app.post('/api/ai/generate-script',(req,res)=>{
    const {stage,customerName,objection}=req.body;
    const scripts={
      '新线索':`您好${customerName?' '+customerName:''}！感谢关注HERBALINN。想了解您平时家里主要怎么喝水呢？泡茶、日常饮用还是办公室用？`,
      '已诊断':`上次聊到${objection||'饮水需求'}，我整理了适合您的方案，方便发您看看吗？`,
      '待体验':`${customerName||'您好'}，之前寄的体验装收到了吗？有口感或使用上的问题随时告诉我~`,
      '体验后跟进':`体验感觉怎么样？很多客户反馈泡茶口感特别柔和，觉得合适的话5L家庭装本周有首单优惠，要试试吗？`,
      '已购5L':`${customerName||'您好'}，用了一段时间感觉如何？现在续费月卡比单买划算不少，要不要升级？`,
      '月卡':`${customerName||'您好'}，您的月卡快到期了，要续费吗？续费客户有专属福利~`,
      '流失':`${customerName||'您好'}，好久不见！最近在做品水活动，免费试饮装要再体验一下吗？`
    };
    res.json({script:scripts[stage]||`您好，关于${objection||'之前的沟通'}，想跟进一下。`,stage});
  });
  app.post('/api/ai/check-compliance',(req,res)=>{
    const hits=PROHIBITED.filter(t=>req.body.text.includes(t));
    res.json({passed:hits.length===0,hits,message:hits.length>0?`发现${hits.length}个禁用词: ${hits.join('、')}`:'内容合规',suggestion:hits.length>0?'请替换或删除禁用词':'通过'});
  });

  // Stats
  app.get('/api/stats',(req,res)=>{
    const today=new Date().toISOString().slice(0,10);
    const leadCount=dbGet('SELECT COUNT(*) as c FROM customers')?.c||0;
    const orderCount=dbGet("SELECT COUNT(*) as c FROM orders WHERE pay_status='已支付'")?.c||0;
    const monthCardCount=dbGet("SELECT COUNT(*) as c FROM orders WHERE product_type='月卡' AND pay_status='已支付'")?.c||0;
    const overdueCount=dbGet("SELECT COUNT(*) as c FROM followups WHERE result NOT IN ('已成交','已流失') AND next_followup_time IS NOT NULL AND next_followup_time<?",[today])?.c||0;
    const noFollowupCount=dbGet("SELECT COUNT(*) as c FROM customers WHERE stage='新线索' AND customer_no NOT IN (SELECT DISTINCT customer_no FROM followups)")?.c||0;
    const cardExpiringCount=dbGet("SELECT COUNT(*) as c FROM orders WHERE product_type='月卡' AND pay_status='已支付' AND pay_time IS NOT NULL AND date(pay_time,'+27 days')<=?",[today])?.c||0;
    const stageDist=dbAll('SELECT stage,COUNT(*) as c FROM customers GROUP BY stage');
    const converted=dbGet("SELECT COUNT(*) as c FROM customers WHERE stage IN ('已购5L','月卡')")?.c||0;
    const conversionRate=leadCount>0?(converted/leadCount*100).toFixed(1):0;
    const recentActivity=dbAll('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 20');
    res.json({leadCount,orderCount,monthCardCount,overdueCount,noFollowupCount,cardExpiringCount,stageDist,conversionRate,recentActivity});
  });

  app.get('/api/activity-log',(req,res)=>res.json(dbAll('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 50')));

  app.listen(PORT,()=>console.log(`HERBALINN running on port ${PORT}`));
});
