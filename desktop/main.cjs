'use strict';
const {app,BrowserWindow,Menu,dialog,session,shell,screen} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {ORIGIN,ENTRY,trustedNavigation,exportAllowed,windowBounds} = require('./policy.cjs');
app.enableSandbox();
app.setAppUserModelId('com.ipfxcapital.markets');
let win, quitting = false, closePrompt = false, reloadPrompt = false, navigationTimer;
let entry = ENTRY;
const testMode = !app.isPackaged && process.env.NODE_ENV === 'test';
if (testMode && process.env.IPFX_DESKTOP_TEST_URL) {
  const candidate = new URL(process.env.IPFX_DESKTOP_TEST_URL);
  if (candidate.protocol !== 'http:' || candidate.hostname !== '127.0.0.1' || !candidate.port || candidate.username || candidate.password)
    throw new Error('Test origin must be loopback');
  entry = candidate.href;
  if (process.env.IPFX_DESKTOP_TEST_PROFILE) app.setPath('userData',process.env.IPFX_DESKTOP_TEST_PROFILE);
}
const origin = new URL(entry).origin;
const offline = path.join(__dirname,'offline.html');
const offlineURL = pathToFileURL(offline).href;
function readBounds() {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'),'window.json'),'utf8'));
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  }
  catch { return {}; }
}
function saveBounds() {
  if (!win || win.isDestroyed()) return;
  try { fs.writeFileSync(path.join(app.getPath('userData'),'window.json'),
    JSON.stringify({...win.getNormalBounds(),maximized:win.isMaximized()})); } catch {}
}
function showOffline() {
  clearTimeout(navigationTimer);
  if (win && !win.isDestroyed()) win.loadFile(offline).catch(()=>win.show());
}
function loadEntry(url = entry) {
  if (!win || win.isDestroyed() || !trustedNavigation(url,origin)) return;
  clearTimeout(navigationTimer);
  navigationTimer = setTimeout(showOffline,25000);
  win.loadURL(url).catch(showOffline);
}
async function requestQuit() {
  if (closePrompt || quitting) return;
  closePrompt = true;
  const result = await dialog.showMessageBox(win,{
    type:'question',title:'Close IPFX Markets?',buttons:['Keep Open','Close App'],defaultId:0,cancelId:0,
    message:'Closing the app does not close your positions.',
    detail:'This action sends no orders. Manage your positions before closing the application.'
  });
  closePrompt = false;
  if (result.response === 1) {saveBounds();quitting=true;app.quit();}
}
async function reload() {
  if (reloadPrompt || closePrompt || quitting || !win || win.isDestroyed()) return;
  reloadPrompt = true;
  try {
    const result = await dialog.showMessageBox(win,{type:'question',buttons:['Cancel','Reload'],defaultId:0,cancelId:0,
      message:'Reload IPFX Markets?',detail:'Reloading interrupts this view but does not close positions or cancel orders.'});
    if (result.response===1) loadEntry();
  } finally { reloadPrompt = false; }
}
function createWindow() {
  const state = readBounds();
  const bounds = windowBounds(state,screen.getPrimaryDisplay().workArea);
  win = new BrowserWindow({...bounds,minWidth:Math.min(800,bounds.width),minHeight:Math.min(600,bounds.height),
    title:'IPFX Markets',backgroundColor:'#0a0a0c',show:false,icon:path.join(__dirname,'build/icon.png'),
    webPreferences:{partition:'persist:ipfx-markets',nodeIntegration:false,nodeIntegrationInWorker:false,
      nodeIntegrationInSubFrames:false,contextIsolation:true,sandbox:true,webSecurity:true,
      allowRunningInsecureContent:false,webviewTag:false,devTools:!app.isPackaged,
      backgroundThrottling:true,spellcheck:false}
  });
  if (state.maximized) win.maximize();
  win.once('ready-to-show',()=>{if(app.isPackaged || process.env.NODE_ENV!=='test') win.show();});
  win.on('close',event=>{if(!quitting){event.preventDefault();requestQuit();}});
  win.on('closed',()=>{clearTimeout(navigationTimer);win=null;});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-attach-webview',event=>event.preventDefault());
  const navigation = (event,url) => {
    if (url===offlineURL) return;
    if (!trustedNavigation(url,origin)) event.preventDefault();
  };
  win.webContents.on('will-navigate',navigation);
  win.webContents.on('will-redirect',(event,url,_inPlace,isMainFrame)=>{
    if(isMainFrame) navigation(event,url);
  });
  win.webContents.on('did-finish-load',()=>clearTimeout(navigationTimer));
  win.webContents.on('did-fail-load',(_event,code,_description,url,isMainFrame)=>{
    if(isMainFrame && code!==-3 && url!==offlineURL) showOffline();
  });
  win.webContents.on('render-process-gone',showOffline);
  win.webContents.on('page-title-updated',event=>{event.preventDefault();win.setTitle('IPFX Markets');});
  win.webContents.on('before-input-event',(event,input)=>{
    if(input.type!=='keyDown' || input.isAutoRepeat) return;
    if((input.control||input.meta)&&input.key.toLowerCase()==='r'){event.preventDefault();reload();}
    if(input.key==='F5'){event.preventDefault();reload();}
  });
  loadEntry();
}
if (!testMode && !app.requestSingleInstanceLock()) app.quit();
else {
  if (!testMode) app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.show();win.focus();}});
  app.on('certificate-error',(event,_contents,_url,_error,_cert,callback)=>{event.preventDefault();callback(false);});
  app.on('before-quit',event=>{if(!quitting&&win&&!win.isDestroyed()){event.preventDefault();requestQuit();}});
  app.whenReady().then(()=>{
    const storage = session.fromPartition('persist:ipfx-markets');
    storage.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    storage.setPermissionCheckHandler(()=>false);
    storage.on('will-download',(event,item,contents)=>{
      const name = item.getFilename();
      if(!win || contents!==win.webContents || !exportAllowed(item.getURL(),name,origin)){event.preventDefault();return;}
      item.setSaveDialogOptions({title:'Export from IPFX Markets',defaultPath:path.join(app.getPath('downloads'),name)});
    });
    const platformMenu = process.platform==='darwin' ? [{label:'IPFX Markets',submenu:[
      {role:'about'},{type:'separator'},{role:'hide'},{role:'hideOthers'},{role:'unhide'},
      {type:'separator'},{label:'Quit IPFX Markets',accelerator:'Command+Q',click:requestQuit}
    ]}] : [];
    app.setAboutPanelOptions({applicationName:'IPFX Markets',applicationVersion:app.getVersion(),
      copyright:'IPFX Capital',credits:'Preview client. Internet connection required.'});
    Menu.setApplicationMenu(Menu.buildFromTemplate([...platformMenu,
      {label:'Markets',submenu:[
        {label:'Open Markets',click:()=>loadEntry()},
        {label:'Account Dashboard',click:()=>loadEntry(origin+'/dashboard.html')},
        {label:'Sign In',click:()=>loadEntry(origin+'/login.html')},
        {type:'separator'},{label:'Reload Connection',click:reload},
        ...(process.platform!=='darwin'?[{label:'Exit',click:requestQuit}]:[])
      ]},
      {role:'editMenu'},
      {label:'View',submenu:[{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{type:'separator'},{role:'togglefullscreen'}]},
      {label:'Help',submenu:[
        {label:'Open Web Platform',click:()=>shell.openExternal(ENTRY)},
        {label:'Downloads & Releases',click:()=>shell.openExternal(ORIGIN+'/downloads.html')},
        {label:'Contact Support',click:()=>shell.openExternal(ORIGIN+'/contact.html')},
        {label:'About IPFX Markets',click:()=>app.showAboutPanel()}
      ]}
    ]));
    createWindow();
    app.on('activate',()=>{if(!win)createWindow();else win.show();});
  });
}
