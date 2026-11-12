// The app reuses the desktop's conversation reducers from ../src-ui/src/shared.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const shared = path.resolve(__dirname, '../src-ui/src/shared');
config.watchFolders = [shared];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')];
module.exports = config;
