// The app reuses the desktop's conversation reducers from ../src-ui/src/shared.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// The protocol client is shared with the desktop UI's remote mode.
const shared = path.resolve(__dirname, '../src-ui/src/shared');
const remote = path.resolve(__dirname, '../src-ui/src/remote');
config.watchFolders = [shared, remote];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')];
module.exports = config;
