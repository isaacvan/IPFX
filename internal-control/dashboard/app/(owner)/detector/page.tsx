import { createServiceClient, requireOwner } from "@lib/supabase-server";

export const dynamic = "force-dynamic";
const pct = (v:number|null|undefined,d=0) => v===null || v===undefined || !Number.isFinite(Number(v)) ? "Not measured" : `${(Number(v)*100).toFixed(d)}%`;
const bps = (v:number|null) => v===null ? "Not measured" : `${Number(v).toFixed(2)} bp`;
function Badge({value}:{value:string}) {
  const danger=value==="RISK_NO_GO"||value==="LIVE_REVIEW_REQUIRED";
  const potential=value==="HIGH_POTENTIAL"||value==="SHADOW_UNCALIBRATED";
  return <span style={{display:"inline-flex",padding:"3px 8px",borderRadius:5,fontSize:11,fontWeight:750,
    color:danger?"#fca5a5":potential?"#fde68a":"#86efac",
    border:`1px solid ${danger?"#7f1d1d":potential?"#78350f":"#14532d"}`,
    background:danger?"#2a1114":potential?"#2a2110":"#10251d"}}>{value.replaceAll("_"," ")}</span>;
}

export default async function TraderDetectorPage() {
  await requireOwner();
  const db=createServiceClient();
  const freshness=new Date(Date.now()-15*60000).toISOString();
  const [alerts,assessments,potentialCount,confirmedCount,liveCount,queueCount,policies,runs]=await Promise.all([
    db.from("trader_detector_alerts").select("id,trading_account_id,alert_type,severity,body,status,created_at").order("created_at",{ascending:false}).limit(50),
    db.from("trader_detector_assessments").select("id,trading_account_id,state,probability_status,probability_edge_positive,calibrated_future_probability,lower_90_bps,independent_idea_count,effective_sample_size,active_trading_days,data_quality,copyability_score,created_at").order("created_at",{ascending:false}).limit(50),
    db.from('trader_detector_states').select('*',{head:true,count:'exact'}).eq('state','HIGH_POTENTIAL').eq('data_status','OK').gte('last_checked_at',freshness),
    db.from('trader_detector_states').select('*',{head:true,count:'exact'}).eq('state','PROFITABILITY_CONFIRMED').eq('data_status','OK').gte('last_checked_at',freshness),
    db.from('trader_detector_states').select('*',{head:true,count:'exact'}).eq('state','LIVE_REVIEW_REQUIRED').eq('data_status','OK').gte('last_checked_at',freshness),
    db.from('trader_detector_alerts').select('*',{head:true,count:'exact'}).in('status',['pending','processing','failed']),
    db.from("trader_detector_policy_versions").select("challenge_type,version,status,validation_reference").in("status",["SHADOW_UNCALIBRATED","VALIDATED"]).order("challenge_type"),
    db.from("trader_detector_run_log").select("status,accounts_seen,assessments_written,alerts_queued,started_at,worker_version").order("started_at",{ascending:false}).limit(10),
  ]);
  const failed=[alerts,assessments,potentialCount,confirmedCount,liveCount,queueCount,policies,runs].some(r=>r.error);
  const alertRows=alerts.data??[], rows=assessments.data??[];
  const counts:Record<string,number|null>={HIGH_POTENTIAL:potentialCount.count,PROFITABILITY_CONFIRMED:confirmedCount.count,LIVE_REVIEW_REQUIRED:liveCount.count};
  const count=(state:string)=>counts[state]??'Unavailable';
  const queuedAlerts=queueCount.count??'Unavailable';
  return <div style={{maxWidth:1240,margin:"0 auto"}}>
    <header style={{display:"flex",justifyContent:"space-between",gap:20,marginBottom:24}}><div>
      <div className="label">OWNER-ONLY DECISION SUPPORT</div><h1 style={{margin:"6px 0"}}>Challenge Trader Detector</h1>
      <p style={{margin:0,color:"var(--label)",maxWidth:760}}>Challenge-specific evidence gates for Infinity, Traditional, Futures, and PAC. Alerts recommend human review only; they cannot deny payouts or enable live copying.</p>
    </div><Badge value="LIVE LOCKED"/></header>
    {failed&&<div className="panel" role="alert" style={{borderColor:"#7f1d1d",color:"#fca5a5",marginBottom:18}}>One or more detector datasets could not be read. No fallback values were substituted.</div>}
    <section className="card-grid" style={{marginBottom:20}}>
      <div className="stat-card" style={{"--accent-color":"#f59e0b"} as React.CSSProperties}><div className="label">HIGH POTENTIAL</div><div className="stat-value">{count("HIGH_POTENTIAL")}</div><div className="stat-sub">Provisional; may be uncalibrated</div></div>
      <div className="stat-card" style={{"--accent-color":"#2ebe86"} as React.CSSProperties}><div className="label">CONFIRMED</div><div className="stat-value">{count("PROFITABILITY_CONFIRMED")}</div><div className="stat-sub">Validated policy required</div></div>
      <div className="stat-card" style={{"--accent-color":"#e45555"} as React.CSSProperties}><div className="label">LIVE REVIEWS</div><div className="stat-value">{count("LIVE_REVIEW_REQUIRED")}</div><div className="stat-sub">Human approval required</div></div>
      <div className="stat-card"><div className="label">QUEUED ALERTS</div><div className="stat-value">{queuedAlerts}</div><div className="stat-sub">Sensitive evidence stays internal</div></div>
    </section>
    <section className="panel" style={{marginBottom:18}}><h2 style={{marginTop:0}}>Policy safety status</h2><table><thead><tr><th>Challenge</th><th>Version</th><th>Status</th><th>Validation</th></tr></thead><tbody>
      {(policies.data??[]).map(p=><tr key={`${p.challenge_type}-${p.version}`}><td>{p.challenge_type}</td><td>v{p.version}</td><td><Badge value={p.status}/></td><td>{p.validation_reference??"Not prospectively validated"}</td></tr>)}
    </tbody></table>{!policies.error&&!policies.data?.length&&<p style={{color:"var(--label)"}}>No detector policies installed.</p>}</section>
    <section className="panel" style={{marginBottom:18}}><h2 style={{marginTop:0}}>Alert queue</h2><div style={{overflowX:"auto"}}><table><thead><tr><th>Time</th><th>Account</th><th>Alert</th><th>Severity</th><th>Status</th><th>Explanation</th></tr></thead><tbody>
      {alertRows.map(a=><tr key={a.id}><td>{new Date(a.created_at).toLocaleString("en-GB")}</td><td><code>{a.trading_account_id}</code></td><td>{a.alert_type.replaceAll("_"," ")}</td><td>{a.severity}</td><td>{a.status}</td><td>{a.body}</td></tr>)}
      {!alerts.error&&!alertRows.length&&<tr><td colSpan={6}>No detector alerts have been generated.</td></tr>}
    </tbody></table></div></section>
    <p style={{color:'var(--label)'}}>Summary counts include successful scans from the last 15 minutes. The table below is historical evidence, including earlier states. Alert delivery is internal.</p>
    <section className="panel" style={{marginBottom:18}}><h2 style={{marginTop:0}}>Latest historical assessments</h2><div style={{overflowX:"auto"}}><table><thead><tr><th>Account</th><th>State at assessment</th><th>Validated future forecast</th><th>Lower daily edge</th><th>Ideas / effective days</th><th>Days</th><th>Data</th><th>Copyability</th><th>As of</th></tr></thead><tbody>
      {rows.map(r=><tr key={r.id}><td><code>{r.trading_account_id}</code></td><td><Badge value={r.state}/></td><td>{pct(r.calibrated_future_probability,1)}<br/><small>Descriptive daily score: {pct(r.probability_edge_positive,1)} (uncalibrated)</small></td><td>{bps(r.lower_90_bps)}</td><td>{r.independent_idea_count} / {Number(r.effective_sample_size).toFixed(1)}</td><td>{r.active_trading_days}</td><td>{pct(r.data_quality)}</td><td>{pct(r.copyability_score)}</td><td>{new Date(r.created_at).toLocaleString("en-GB")}</td></tr>)}
      {!assessments.error&&!rows.length&&<tr><td colSpan={9}>No assessments have been generated.</td></tr>}
    </tbody></table></div></section>
    <section className="panel"><h2 style={{marginTop:0}}>Worker health</h2><table><thead><tr><th>Started</th><th>Status</th><th>Accounts</th><th>Assessments</th><th>Alerts</th><th>Version</th></tr></thead><tbody>
      {(runs.data??[]).map((r,i)=><tr key={`${r.started_at}-${i}`}><td>{new Date(r.started_at).toLocaleString("en-GB")}</td><td>{r.status}</td><td>{r.accounts_seen}</td><td>{r.assessments_written}</td><td>{r.alerts_queued}</td><td>{r.worker_version}</td></tr>)}
    </tbody></table></section>
  </div>;
}
