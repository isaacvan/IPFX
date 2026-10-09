/* Private document submission helpers. No document bytes, filenames or paths are logged or persisted. */
(() => {
  'use strict';
  function failure(error) {
    const message=String(error?.message||''),code=String(error?.code||'');
    if (code==='28000'||code==='PGRST301'||/NOT_SIGNED_IN|JWT expired|invalid JWT/i.test(message)) return 'Your session has expired. Sign in again, then submit your documents.';
    if (/KYC_FILE_MISSING/.test(message)) return 'An uploaded file could not be confirmed. Wait a moment and click Continue again; this page keeps your uploads for the retry.';
    if (/KYC_BAD_PATH/.test(message)) return 'These uploads do not match the signed-in account. Refresh the page, sign into the correct account and choose your files again.';
    if (/KYC_BAD_TYPE|KYC_PHOTO_ID_REQUIRED|KYC_DOCUMENTS_REQUIRED/.test(message)) return 'Please select your photo ID front. The ID back is optional; proof of address is not required.';
    if (code==='PGRST202'||code==='42501') return 'Document submission is temporarily unavailable. Your uploads are retained on this page. Please retry or contact support (verification '+code+').';
    const reference=/^[A-Z0-9]{5,10}$/.test(code)?code:/fetch|network|timeout|connection|abort/i.test(message)?'NETWORK':null;
    const ref=reference?' (verification '+reference+')':'';
    return 'Your files uploaded, but submission was not confirmed. Click Continue again; this page will reuse the uploaded files'+ref+'.';
  }
  const transient=e=>['40001','40P01','55P03','57014','53300','08000','08003','08006'].includes(String(e?.code||''))||/fetch|network|timeout|connection|KYC_FILE_MISSING/i.test(String(e?.message||''));
  async function submit(db,documents) {
    for(let attempt=0;attempt<2;attempt++) {
      let result;
      let timer;
      try {
        let request=db.rpc('submit_kyc',{p_documents:documents});
        if(typeof AbortController!=='undefined'&&typeof request.abortSignal==='function') {
          const controller=new AbortController();timer=setTimeout(()=>controller.abort(),12000);request=request.abortSignal(controller.signal);
        }
        result=await request;
      }
      catch(error){result={error};}
      finally{if(timer)clearTimeout(timer);}
      if(!result.error&&['pending','verified'].includes(result.data))return result.data;
      const error=result.error||{message:'Verification status was not confirmed'};
      if(attempt===0&&transient(error)){await new Promise(resolve=>setTimeout(resolve,600));continue;}
      throw new Error(failure(error));
    }
  }
  function expiryProblem(type,noExpiry,date,today=new Date().toISOString().slice(0,10)) {
    if(noExpiry)return type==='national_id'&&!date?null:'The no-expiry option is only for national identity cards with no expiry date printed on them.';
    return /^\d{4}-\d{2}-\d{2}$/.test(date)&&date>=today?null:'Enter a valid, unexpired ID expiry date, or select the no-expiry option for a national identity card.';
  }
  window.IPFXVerification=Object.freeze({submit,failure,expiryProblem});
})();
