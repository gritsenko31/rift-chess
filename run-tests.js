#!/usr/bin/env node
/* Runs tests.js under Node with the same source files the browser loads. */
'use strict';
var fs = require('fs'), path = require('path'), vm = require('vm');
var ctx = { console: console, setTimeout: setTimeout, clearTimeout: clearTimeout, Promise: Promise, Date: Date, Math: Math, JSON: JSON };
vm.createContext(ctx);
['rules.js', 'ai.js', 'game.js', 'tests.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), ctx, { filename: f });
});
var failed = 0;
ctx.RiftTests.run(function (r) {
  if (!r.ok) failed++;
  console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + ' (' + r.ms + ' ms)' + (r.note ? ' [' + r.note + ']' : '') + (r.ok ? '' : '\n     ' + r.error));
}).then(function (results) {
  console.log('\n' + (results.length - failed) + '/' + results.length + ' tests passed');
  process.exit(failed ? 1 : 0);
});
