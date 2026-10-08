export type ReviewAlert = { key: string; category: string; person_id: string | null; severity?: string };
export function solutionOptions(a: ReviewAlert): Array<{kind:string;label:string;help:string}> {
 const options=[{kind:'recheck',label:'Refresh checks',help:'Reruns the alert scan; it does not repair a stopped service or retry a broker order.'}];
 if(a.person_id) options.unshift({kind:'review_model',label:'Review trader and routing',help:'Open performance and the existing model controls. No model changes until you explicitly save one.'});
 if(a.severity==='good')return options;
 if(a.key.startsWith('rules:team-pause:')) options.unshift({kind:'resume',label:'Remove team entry pause',help:'Requires a review reason. Failed challenges, investigation holds and monthly lockouts stay in force.'});
 else if(a.person_id) {
  options.unshift({kind:'pause',label:'Pause new trades',help:'Blocks new entries across this person’s accounts and cancels resting orders. Existing positions can still close.'});
  if(['rules','trader'].includes(a.category)) options.unshift({kind:'warn',label:'Send strict warning',help:'Saves a warning in IPFX Markets. Automatic stop-loss strikes remain separate and are not counted twice.'});
 }
 if(a.key.startsWith('rules:similarity:')) {
  for(const option of options){if(option.kind==='warn')option.label='Warn first trader';if(option.kind==='pause')option.label='Pause first trader';}
  options.unshift({kind:'pause_pair',label:'Pause both traders for review',help:'Block new entries and cancel resting orders for both matched people. Existing positions can still close. This does not declare them guilty.'});
  options.push({kind:'clear_similarity',label:'Mark evidence reviewed',help:'Record why the evidence needs no further action. New matching trades can reopen the review.'});
 }
 if(['system','book','money'].includes(a.category)) options.unshift({kind:'halt_books',label:'Halt new book risk',help:'Stops new copied risk. Existing positions still close; this does not stop the trader’s challenge.'});
 if(a.category==='money')options.unshift({kind:'review_treasury',label:'Open reserves and payout review',help:'Review actual reserves, payout obligations and sponsorships in Treasury. This does not invent a balance or send a payment.'});
 if(a.category==='system'||a.category==='book')options.push({kind:'review_operations',label:'Open operational review',help:'Inspect health, connections and existing operational controls. Unknown broker orders must be reconciled before any retry.'});
 return options;
}
