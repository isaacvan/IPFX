import fs from 'node:fs';import path from 'node:path';
// Only pending account checks are saved. No prices, user tokens or broker credentials enter this journal.
export function riskJournal(file) {
  const dir=path.dirname(file);fs.mkdirSync(dir,{recursive:true,mode:0o700});
  return {
    load(){
      if(!fs.existsSync(file))return [];
      const data=JSON.parse(fs.readFileSync(file,'utf8'));
      if(!Array.isArray(data)||data.length>20000)throw Error('RISK_JOURNAL_INVALID');
      for(const row of data)if(!/^[0-9a-f-]{36}$/i.test(row.id)||typeof row.reason!=='string'||!Number.isFinite(row.firstAt))throw Error('RISK_JOURNAL_INVALID');
      return data;
    },
    save(queue,jobs){
      const rows=[...queue].map(([id,reason])=>({id,reason,firstAt:jobs.get(id)?.firstAt??Date.now()}));
      const temporary=file+'.tmp',fd=fs.openSync(temporary,'w',0o600);
      try{fs.writeFileSync(fd,JSON.stringify(rows));fs.fsyncSync(fd);}finally{fs.closeSync(fd)}
      fs.renameSync(temporary,file);
    },
  };
}
