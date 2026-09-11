const config = require('./builder.cjs');
module.exports = {...config, forceCodeSigning:false,
  artifactName:'IPFX-Markets-UNSIGNED-PREVIEW-${version}-${os}-${arch}.${ext}',
  mac:{...config.mac,identity:null,notarize:false}};
