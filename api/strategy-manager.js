import { db } from 'hatchable';

export const access='user';
export const methods=['GET','POST','DELETE'];

function modelLabel(model){
  if(model==='ST_EMA_RSI_TRANSITION') return 'ST + EMA + RSI Transition';
  if(model==='LEGACY_ADX_RANGE') return 'Option Selling';
  return model || 'Strategy';
}
function safeConfig(v){return v&&typeof v==='object'?v:{};}
function summary(cfg){
  const c=safeConfig(cfg), sc=safeConfig(c.signal_config), bits=[];
  if(c.timeframe)bits.push(c.timeframe);
  if(c.candle_type)bits.push(c.candle_type==='HEIKIN_ASHI'?'Heikin Ashi':'OHLC');
  if(c.signal_model==='ST_EMA_RSI_TRANSITION'){
    bits.push(`ST(${sc.supertrend_period??10},${sc.supertrend_multiplier??2})`);
    bits.push(`EMA(${sc.ema_period??50})`);
    bits.push(`RSI(${sc.rsi_period??14}) ${sc.rsi_short_threshold??40}/${sc.rsi_long_threshold??60}`);
    bits.push(sc.trade_direction||'BOTH');
  }else{
    if(c.adx_period!=null)bits.push(`ADX(${c.adx_period})`);
    if(c.adx_threshold!=null)bits.push(`Entry < ${c.adx_threshold}`);
    if(c.atr_period!=null)bits.push(`ATR(${c.atr_period})`);
  }
  if(c.underlying)bits.push(c.underlying);
  return bits.join(' · ');
}
async function load(uid){
  const q=await db.query(`SELECT s.id strategy_id,s.name strategy_name,s.signal_model,s.underlying,s.timeframe,s.enabled strategy_enabled,
    s.created_at strategy_created_at,s.updated_at strategy_updated_at,v.id version_id,v.version_number,v.status,v.config,v.created_at version_created_at
    FROM strategy_configs s JOIN strategy_versions v ON v.strategy_id=s.id AND v.user_id=s.user_id
    WHERE s.user_id=$1 ORDER BY s.updated_at DESC,v.version_number DESC`,[uid]);
  const groups=new Map();
  for(const r of q.rows){
    if(!groups.has(r.strategy_id)) groups.set(r.strategy_id,{id:r.strategy_id,name:r.strategy_name,signal_model:r.signal_model||'LEGACY_ADX_RANGE',strategy_type:modelLabel(r.signal_model||'LEGACY_ADX_RANGE'),underlying:r.underlying,timeframe:r.timeframe,enabled:r.strategy_enabled,created_at:r.strategy_created_at,updated_at:r.strategy_updated_at,versions:[]});
    const cfg=safeConfig(r.config);
    groups.get(r.strategy_id).versions.push({id:r.version_id,version:r.version_number,status:r.status,created_at:r.version_created_at,summary:summary(cfg),config:cfg});
  }
  return [...groups.values()];
}
async function assertVersion(uid,strategyId,versionId){
  const q=await db.query('SELECT * FROM strategy_versions WHERE id=$1 AND strategy_id=$2 AND user_id=$3 LIMIT 1',[versionId,strategyId,uid]);
  if(!q.rows[0]) throw new Error('strategy version not found');
  return q.rows[0];
}
async function runningRefs(uid,strategyId,versionId){
  const p=await db.query('SELECT COUNT(*)::int count FROM paper_campaigns WHERE user_id=$1 AND strategy_id=$2 AND status IN (\'RUNNING\',\'ACTIVE\') AND ($3::uuid IS NULL OR strategy_version_id=$3)',[uid,strategyId,versionId||null]);
  const l=await db.query('SELECT COUNT(*)::int count FROM live_campaigns WHERE user_id=$1 AND strategy_id=$2 AND status IN (\'RUNNING\',\'ACTIVE\') AND ($3::uuid IS NULL OR strategy_version_id=$3)',[uid,strategyId,versionId||null]);
  return Number(p.rows[0]?.count||0)+Number(l.rows[0]?.count||0);
}
async function journalRefs(uid,strategyId,versionId){
  const q=await db.query('SELECT COUNT(*)::int count FROM trading_journal_entries WHERE user_id=$1 AND strategy_id=$2 AND ($3::uuid IS NULL OR strategy_version_id=$3)',[uid,strategyId,versionId||null]);
  return Number(q.rows[0]?.count||0);
}

export default async function(req,res){
  const uid=req.user.id;
  if(req.method==='GET') return res.json({strategies:await load(uid)});

  const body=req.body||{};
  const strategyId=String(body.strategy_id||req.query?.strategy_id||'');
  const versionId=String(body.version_id||req.query?.version_id||'');

  if(req.method==='POST'){
    const action=String(body.action||'').toUpperCase();
    if(!strategyId||!versionId) return res.status(400).json({error:'strategy_id and version_id required'});
    const source=await assertVersion(uid,strategyId,versionId);
    const cfg=safeConfig(source.config);
    if(action==='VALIDATE_VERSION'){
      const errors=[];
      const candles=['OHLC','HEIKIN_ASHI'], timeframes=['3m','5m','15m','30m','1h'], underlyings=['NIFTY 50','BANK NIFTY','SENSEX','BANKEX'];
      if(!underlyings.includes(cfg.underlying)) errors.push('Unsupported underlying');
      if(!timeframes.includes(cfg.timeframe)) errors.push('Unsupported timeframe');
      if(!candles.includes(cfg.candle_type)) errors.push('Unsupported candle type');
      if(!/^([01]\\d|2[0-3]):[0-5]\\d$/.test(cfg.start_time||'')) errors.push('Invalid start time');
      if(!cfg.overnight_exposure && cfg.square_off!=='15:15') errors.push('Intraday strategies must use the global 15:15 IST square-off.');
      if(cfg.overnight_exposure && cfg.square_off!=null) errors.push('Positional strategies must not have an intraday square-off.');
      if(cfg.signal_model==='ST_EMA_RSI_TRANSITION'){
        const sc=safeConfig(cfg.signal_config);
        if(!['BOTH','LONG_ONLY','SHORT_ONLY'].includes(String(sc.trade_direction||'BOTH'))) errors.push('Trade direction must be BOTH, LONG_ONLY or SHORT_ONLY.');
        if(!Array.isArray(sc.long_legs)||!sc.long_legs.length) errors.push('At least one Long / BUY leg is required.');
        if(!Array.isArray(sc.short_legs)||!sc.short_legs.length) errors.push('At least one Short / SELL leg is required.');
        if(Number(sc.supertrend_period)<2) errors.push('Supertrend period must be >= 2.');
        if(!(Number(sc.supertrend_multiplier)>0)) errors.push('Supertrend multiplier must be positive.');
        if(Number(sc.ema_period)<2) errors.push('EMA period must be >= 2.');
        if(Number(sc.rsi_period)<2) errors.push('RSI period must be >= 2.');
        if(!(Number(sc.rsi_long_threshold)>Number(sc.rsi_short_threshold))) errors.push('BUY RSI threshold must be above SELL RSI threshold.');
      } else {
        if(Number(cfg.adx_period)<2) errors.push('ADX period must be >= 2');
        if(Number(cfg.atr_period)<2) errors.push('ATR period must be >= 2');
        if(!(Number(cfg.atr_multiplier)>0)) errors.push('ATR multiplier must be positive');
        const legs=Array.isArray(cfg.leg_config)?cfg.leg_config:[];
        if(legs.length<2) errors.push('Option Selling strategy requires at least two legs.');
        legs.forEach((l,i)=>{
          if(!['CE','PE'].includes(l.option_type)) errors.push(`Leg ${i+1}: option type must be CE or PE`);
          if(!['BUY','SELL'].includes(l.side)) errors.push(`Leg ${i+1}: side must be BUY or SELL`);
          if(!(Number(l.quantity)>0)) errors.push(`Leg ${i+1}: quantity must be positive`);
        });
      }
      const valid=!errors.length;
      await db.query('UPDATE strategy_versions SET status=$1 WHERE id=$2 AND strategy_id=$3 AND user_id=$4',[valid?'VALIDATED':'DRAFT',versionId,strategyId,uid]);
      await db.query('INSERT INTO audit_events(user_id,event_type,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5)',[uid,valid?'STRATEGY_VERSION_VALIDATED':'STRATEGY_VERSION_VALIDATION_FAILED','strategy_version',versionId,JSON.stringify({strategy_id:strategyId,version:source.version_number,errors})]);
      return res.json({valid,status:valid?'VALIDATED':'DRAFT',errors,version:source.version_number,version_id:versionId});
    }
    if(action==='DUPLICATE_VERSION'){
      const next=await db.query('SELECT COALESCE(MAX(version_number),0)+1 version FROM strategy_versions WHERE strategy_id=$1 AND user_id=$2',[strategyId,uid]);
      const nextVersion=Number(next.rows[0].version);
      const copy=JSON.parse(JSON.stringify(cfg));
      if(body.name) copy.name=String(body.name).trim().slice(0,120);
      const inserted=await db.query('INSERT INTO strategy_versions(strategy_id,user_id,version_number,status,config) VALUES($1,$2,$3,$4,$5) RETURNING id,version_number,status,created_at',[strategyId,uid,nextVersion,'DRAFT',JSON.stringify(copy)]);
      await db.query('UPDATE strategy_configs SET version=$1,updated_at=now() WHERE id=$2 AND user_id=$3',[nextVersion,strategyId,uid]);
      await db.query('INSERT INTO audit_events(user_id,event_type,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5)',[uid,'STRATEGY_VERSION_DUPLICATED','strategy',strategyId,JSON.stringify({source_version:source.version_number,new_version:nextVersion})]);
      return res.status(201).json({version:inserted.rows[0],config:copy});
    }
    if(action==='ARCHIVE_VERSION'){
      const refs=await runningRefs(uid,strategyId,versionId);
      if(refs) return res.status(409).json({error:'Cannot archive a version used by a running campaign.',running_campaigns:refs});
      await db.query('UPDATE strategy_versions SET status=\'ARCHIVED\' WHERE id=$1 AND strategy_id=$2 AND user_id=$3',[versionId,strategyId,uid]);
      await db.query('INSERT INTO audit_events(user_id,event_type,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5)',[uid,'STRATEGY_VERSION_ARCHIVED','strategy_version',versionId,JSON.stringify({strategy_id:strategyId,version:source.version_number})]);
      return res.json({ok:true,status:'ARCHIVED'});
    }
    if(action==='RESTORE_VERSION'){
      if(!['ARCHIVED','DRAFT'].includes(String(source.status).toUpperCase())) return res.status(409).json({error:'Only ARCHIVED or DRAFT versions can be restored to DRAFT.'});
      await db.query('UPDATE strategy_versions SET status=\'DRAFT\' WHERE id=$1 AND strategy_id=$2 AND user_id=$3',[versionId,strategyId,uid]);
      return res.json({ok:true,status:'DRAFT'});
    }
    return res.status(400).json({error:'unsupported manager action'});
  }

  if(req.method==='DELETE'){
    if(!strategyId) return res.status(400).json({error:'strategy_id required'});
    if(versionId){
      const source=await assertVersion(uid,strategyId,versionId);
      const running=await runningRefs(uid,strategyId,versionId);
      if(running) return res.status(409).json({error:'Cannot delete a version used by a running campaign. Stop the campaign first.',running_campaigns:running});
      const journal=await journalRefs(uid,strategyId,versionId);
      if(journal) return res.status(409).json({error:'Cannot permanently delete this version because trading journal records reference it. Archive it instead.',journal_records:journal});
      await db.query('DELETE FROM strategy_versions WHERE id=$1 AND strategy_id=$2 AND user_id=$3',[versionId,strategyId,uid]);
      await db.query('INSERT INTO audit_events(user_id,event_type,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5)',[uid,'STRATEGY_VERSION_DELETED','strategy_version',versionId,JSON.stringify({strategy_id:strategyId,version:source.version_number})]);
      return res.json({ok:true,deleted:'version'});
    }
    const running=await runningRefs(uid,strategyId,null);
    if(running) return res.status(409).json({error:'Cannot delete this strategy while a Paper or Live campaign is running.',running_campaigns:running});
    const journal=await journalRefs(uid,strategyId,null);
    if(journal) return res.status(409).json({error:'Cannot permanently delete this strategy because trading journal records reference it. Archive its versions instead.',journal_records:journal});
    await db.query('DELETE FROM strategy_versions WHERE strategy_id=$1 AND user_id=$2',[strategyId,uid]);
    await db.query('DELETE FROM strategy_configs WHERE id=$1 AND user_id=$2',[strategyId,uid]);
    await db.query('INSERT INTO audit_events(user_id,event_type,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5)',[uid,'STRATEGY_DELETED','strategy',strategyId,JSON.stringify({})]);
    return res.json({ok:true,deleted:'strategy'});
  }
  return res.status(405).json({error:'method not allowed'});
}