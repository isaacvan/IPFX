module.exports = {
  appId: 'com.ipfxcapital.markets',
  productName: 'IPFX Markets',
  directories: {output:'dist',buildResources:'build'},
  files: ['main.cjs','policy.cjs','offline.html','build/icon.png','package.json'],
  asar: true,
  forceCodeSigning: true,
  npmRebuild: false,
  electronFuses: {
    runAsNode:false, enableCookieEncryption:true, enableNodeOptionsEnvironmentVariable:false,
    enableNodeCliInspectArguments:false, enableEmbeddedAsarIntegrityValidation:true, onlyLoadAppFromAsar:true,
    grantFileProtocolExtraPrivileges:false
  },
  win: {target:[{target:'nsis',arch:['x64']}],icon:'build/icon.png',verifyUpdateCodeSignature:true},
  nsis: {oneClick:false,perMachine:false,allowToChangeInstallationDirectory:true,
    createDesktopShortcut:true,createStartMenuShortcut:true,shortcutName:'IPFX Markets',deleteAppDataOnUninstall:false},
  mac: {target:[{target:'dmg',arch:['arm64','x64']}],icon:'build/icon.png',
    category:'public.app-category.finance',hardenedRuntime:true,notarize:true},
  artifactName:'IPFX-Markets-${version}-${os}-${arch}.${ext}',
  publish:null
};
