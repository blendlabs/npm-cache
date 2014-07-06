#! /usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');
var shell = require('shelljs');
var parser = require('nomnom');
var async = require('async');

var logger = require('./util/logger');
var CacheDependencyManager = require('./cacheDependencyManagers/baseCacheDependencyManager');

if (! shell.which('tar')) {
  logger.logError('tar command-line tool not found. exiting...');
  return;
}

// npm-cache command handlers

// main method for installing specified dependencies
var installDependencies = function (opts) {
  logger.logInfo('using ' + opts.cacheDirectory + ' as cache directory');
  if (! fs.existsSync(opts.cacheDirectory)) {
    // create directory if it doesn't exist
    shell.mkdir('-p', opts.cacheDirectory);
    logger.logInfo('creating cache directory');
  }

  var availableManagers = {
    npm: './cacheDependencyManagers/npmConfig.js',
    bower: './cacheDependencyManagers/bowerConfig.js',
    composer: './cacheDependencyManagers/composerConfig.js'
  };
  var defaultManagers = Object.keys(availableManagers);

  // Parse args for which dependency managers to install
  var specifiedManagers;
  if (opts._.length === 1) { // no managers specified, install everything!
    specifiedManagers = defaultManagers;
  } else {
    specifiedManagers = opts._;
  }

  var loadTasks = [];
  specifiedManagers.forEach(function (dependencyManagerName) {
    if (dependencyManagerName in availableManagers) {
      logger.logInfo('installing ' + dependencyManagerName + ' dependencies');
      var config = require(availableManagers[dependencyManagerName]);
      var manager = new CacheDependencyManager(config);
      loadTasks.push(
        function (callback) {
          manager.loadDependencies(opts.cacheDirectory, callback);
        }
      );
    }
  });

  async.parallel(loadTasks,
    function onInstalled (error) {
      if (error === undefined) {
        logger.logInfo('successfully installed all dependencies');
        process.exit(0);
      } else {
        logger.logError('error installing dependencies');
        process.exit(1);
      }
    }
  );
};


parser.command('install')
  .callback(installDependencies)
  .option('cacheDirectory', {
    default: path.resolve(process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE, '.package_cache'),
    abbr: 'c',
    help: 'directory where dependencies will be cached'
  })
  .help('install specified dependencies');


var examples = [
  'Examples:',
  '\tnpm-cache install\t# try to install npm, bower, and composer components',
  '\tnpm-cache install bower\t# install only bower components',
  '\tnpm-cache install bower npm\t# install bower and npm components',
  '\tnpm-cache install bower --cacheDirectory /home/cache/\t# install bower components using /home/cache as cache directory'
];

parser.help(examples.join('\n'));

parser.parse();
