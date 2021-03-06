'use strict';

var async = require('async');
var fs = require('fs-extra');
var path = require('path');
var logger = require('../util/logger');
var shell = require('shelljs');
var which = require('which');
var targz = require('tar.gz');
var Decompress = require('decompress');
var fsExt = require('fs-ext');

function CacheDependencyManager (config) {
  this.config = config;
}

// Given a path relative to process' current working directory,
// returns a normalized absolute path
var getAbsolutePath = function (relativePath) {
  return path.resolve(process.cwd(), relativePath);
};

CacheDependencyManager.prototype.cacheLogInfo = function (message) {
  logger.logInfo('[' + this.config.cliName + '] ' + message);
};

CacheDependencyManager.prototype.cacheLogError = function (error) {
  logger.logError('[' + this.config.cliName + '] ' + error);
};


CacheDependencyManager.prototype.installDependencies = function () {
  var error = null;
  var installCommand = this.config.installCommand + ' ' + this.config.installOptions;
  installCommand = installCommand.trim();
  this.cacheLogInfo('running [' + installCommand + ']...');
  if (shell.exec(installCommand).code !== 0) {
    error = 'error running ' + this.config.installCommand;
    this.cacheLogError(error);
  } else {
    this.cacheLogInfo('installed ' + this.config.cliName + ' dependencies, now archiving');
  }
  return error;
};


CacheDependencyManager.prototype.archiveDependencies = function (cacheDirectory, cachePath, callback) {
  var self = this;
  var error = null;
  var installedDirectory = getAbsolutePath(self.config.installDirectory);
  self.cacheLogInfo('archiving dependencies from ' + installedDirectory);

  if (!fs.existsSync(installedDirectory)) {
    self.cacheLogInfo('skipping archive. Install directory does not exist.');
    return callback();
  }

  var tmpCachePath = cachePath + '~';
  // Make sure target file exists is created
  fs.ensureFileSync(tmpCachePath);
  var fd = fs.openSync(tmpCachePath, 'w');
  // Attempts to grab a write-exclusive lock without a timeout.
  fsExt.flockSync(fd, 'ex');

  // Hack to avoid creating an archive if another build is running concurrently.
  if (fs.existsSync(cachePath)) {
    self.cacheLogInfo('skipping archive because target cache file already exists.');
    return callback();
  }

  async.series([
    function(cb) {
      new targz().compress(
        installedDirectory,
        tmpCachePath,
        function onCompressed (compressErr) {
          if (compressErr) {
            error = 'error tar-ing ' + installedDirectory + ': ' + compressErr.message;
            self.cacheLogError(error);
          } else {
            self.cacheLogInfo('installed and archived dependencies');
          }
          // Unlock the file. Should we also delete if tar.gz failed?
          cb(error);
        }
      );
    },
    function(cb) {
      fs.rename(tmpCachePath, cachePath, cb);
    },
    function(cb) {
      fsExt.flock(fd, 'un', cb);
    }
  ], callback);
};

CacheDependencyManager.prototype.extractDependencies = function (cachePath, callback) {
  var self = this;
  var error = null;
  var installDirectory = getAbsolutePath(self.config.installDirectory);

  self.cacheLogInfo('clearing installed dependencies at ' + installDirectory);
  fs.removeSync(installDirectory);
  self.cacheLogInfo('...cleared');
  self.cacheLogInfo('extracting dependencies from ' + cachePath);

  var fd = fs.openSync(cachePath, 'r');
  async.series([
    function(cb) {
      // Attempts to get a read-shared lock without a timeout.
      fsExt.flock(fd, 'sh', cb);
    },
    function(cb) {
      new Decompress()
        .src(cachePath)
        .dest(process.cwd())
        .use(Decompress.targz())
        .run(cb);
    },
    function(cb) {
      fsExt.flock(fd, 'un', cb);
    }
  ], function(err) {
    if (err) {
      error = 'Error extracting ' + cachePath + ': ' + err;
      self.cacheLogError(error);
     } else {
       self.cacheLogInfo('done extracting');
     }

     callback(err);
  });
};


CacheDependencyManager.prototype.loadDependencies = function (callback) {
  var self = this;
  var error = null;

  // Check if config file for dependency manager exists
  if (! fs.existsSync(this.config.configPath)) {
    this.cacheLogInfo('Dependency config file ' + this.config.configPath + ' does not exist. Skipping install');
    callback(null);
    return;
  }
  this.cacheLogInfo('config file exists');

  // Check if package manger CLI is installed
  try {
    which.sync(this.config.cliName);
    this.cacheLogInfo('cli exists');
  }
  catch (e) {
    error = 'Command line tool ' + this.config.cliName + ' not installed';
    this.cacheLogError(error);
    callback(error);
    return;
  }

  // Get hash of dependency config file
  var hash = this.config.getFileHash(this.config.configPath);
  this.cacheLogInfo('hash of ' + this.config.configPath + ': ' + hash);
  // cachePath is absolute path to where local cache of dependencies is located
  var cacheDirectory = path.resolve(this.config.cacheDirectory, this.config.cliName, this.config.getCliVersion());
  var cachePath = path.resolve(cacheDirectory, hash + '.tar.gz');

  // Check if local cache of dependencies exists
  if (!this.config.forceRefresh && fs.existsSync(cachePath)) {
    this.cacheLogInfo('cache exists');

    // Try to extract dependencies
    this.extractDependencies(
      cachePath,
      function onExtracted (extractErr) {
        if (extractErr) {
          error = extractErr;
        }
        callback(error);
      }
    );

  } else { // install dependencies with CLI tool and cache

    // Try to install dependencies using package manager
    error = this.installDependencies();
    if (error !== null) {
      callback(error);
      return;
    }

    // Try to archive newly installed dependencies
    this.archiveDependencies(
      cacheDirectory,
      cachePath,
      function onArchived (archiveError) {
        if (archiveError) {
          error = archiveError;
        }
        callback(error);
      }
    );
  }
};

/**
 * Looks for available package manager configs in cacheDependencyManagers
 * directory. Returns an object with package manager names as keys
 * and absolute paths to configs as values
 *
 * Ex: {
 *  npm: /usr/local/lib/node_modules/npm-cache/cacheDependencyMangers/npmConfig.js,
 *  bower: /usr/local/lib/node_modules/npm-cache/cacheDependencyMangers/bowerConfig.js
 * }
 *
 * @return {Object} availableManagers
 */
CacheDependencyManager.getAvailableManagers = function () {
  if (CacheDependencyManager.managers === undefined) {
    CacheDependencyManager.managers = {};
    var files = fs.readdirSync(__dirname);
    var managerRegex = /(\S+)Config\.js/;
    files.forEach(
      function addAvailableManager (file) {
        var result = managerRegex.exec(file);
        if (result !== null) {
          var managerName = result[1];
          CacheDependencyManager.managers[managerName] = path.join(__dirname, file);
        }
      }
    );
  }
  return CacheDependencyManager.managers;
};

module.exports = CacheDependencyManager;
