import { db } from 'hatchable';

export const access='user';
export const methods=['GET'];

export default async function(req,res){
  const uid=req.user.id;
  const [c,e,b,a]=await Promise.all([
    db.query("SELECT id,status,last_status,last_reason,last_cycle_at,updated_at,recovery_required,mode FROM live_campaigns WHERE user_id=$1 ORDER BY started_at DESC LIMIT 1",[uid]),
    db.query("SELECT armed,enabled FROM live_execution_configs WHERE user_id=$1 LIMIT 1",[uid]),
    db.query("SELECT status,expires_at FROM broker_connections WHERE user_id=$1 LIMIT 1",[uid]),
    db.query("SELECT created_at,details FROM audit_events WHERE user_id=$1 AND event_type='LIVE_SUPERVISOR_RUN' ORDER BY created_at DESC LIMIT 1",[uid])
  ]);
  const campaign=c.rows[0]||null,exec=e.rows[0]||{},broker=b.rows[0]||null,run=a.rows[0]||null;
  const brokerOk=broker?.status==='CONNECTED'&&(!broker.expires_at||new Date(broker.expires_at).getTime()>Date.now());
  const armed=!!exec.armed&&exec.enabled!==false;
  const background=!!campaign&&campaign.status==='RUNNING'&&armed&&brokerOk&&!campaign.recovery_required;
  const lastRun=run?.created_at||null;
  const nextRun=background&&lastRun?new Date(new Date(lastRun).getTime()+5*60*1000).toISOString():null;
  return res.json({ok:true,background_active:background,last_supervisor_run:lastRun,next_expected_run:nextRun,campaign,execution:{armed,enabled:exec.enabled!==false},broker:{connected:brokerOk,status:broker?.status||'DISCONNECTED',expires_at:broker?.expires_at||null},recovery_required:!!campaign?.recovery_required});
}