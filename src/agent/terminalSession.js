const os = require('os');

let _cwd = os.homedir();

function getCwd() { return _cwd; }
function setCwd(p) { _cwd = p; }

module.exports = { getCwd, setCwd };
