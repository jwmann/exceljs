/**
 * Copyright (c) 2015-2017 Guyon Roche
 * LICENCE: MIT - please refer to LICENCE file included with this module
 * or https://github.com/guyonroche/exceljs/blob/master/LICENSE
 */

'use strict';

var events = require('events');
var PromishLib = require('./promish');

var utils = require('./utils');

// =============================================================================
// FlowControl - Used to slow down streaming to manageable speed
// Implements a subset of Stream.Duplex: pipe() and write()
var FlowControl = module.exports = function(options) {
  this.options = options = options || {};

  // Buffer queue
  this.queue = [];

  // Consumer streams
  this.pipes = [];

  // Down-stream flow-control instances
  this.children = [];

  // Up-stream flow-control instances
  this.parent = options.parent;

  // Ensure we don't flush more than once at a time
  this.flushing = false;

  // determine timeout for flow control delays
  if (options.gc) {
    var gc = options.gc;
    if (gc.getTimeout) {
      this.getTimeout = gc.getTimeout;
    } else {
      // heap size below which we don't bother delaying
      var threshold = gc.threshold !== undefined ? gc.threshold : 150000000;
      // convert from heapsize to ms timeout
      var divisor = gc.divisor !== undefined ? gc.divisor : 500000;
      this.getTimeout = function() {
        var memory = process.memoryUsage();
        var heapSize = memory.heapTotal;
        return (heapSize < threshold) ? 0 : Math.floor(heapSize / divisor);
      };
    }
  } else {
    this.getTimeout = null;
  }
};

utils.inherits(FlowControl, events.EventEmitter, {
  get name() {
    return [
      'FlowControl',
      this.parent ? 'Child' : 'Root',
      this.corked ? 'corked' : 'open'
    ].join(' ');
  },
  get corked() {
    // We remain corked while we have children and at least one has data to consume
    return (this.children.length > 0) &&
      this.children.some(function(child) { return child.queue && child.queue.length; });
  },
  get stem() {
    // the decision to stem the incoming data depends on whether the children are corked
    // and how many buffers we have backed up
    return this.corked || !this.queue || (this.queue.length > 2);
  },

  _write: function(dst, data, encoding) {
    // Write to a single destination and return a promise

    return new PromishLib.Promish(function(resolve, reject) {
      dst.write(data, encoding, function(error) {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  },

  _pipe: function(chunk) {
    // Write chunk to all pipes. A chunk with no data is the end
    var promises = [];
    this.pipes.forEach(pipe => {
      if (chunk.data) {
        if (pipe.sync) {
          pipe.stream.write(chunk.data, chunk.encoding);
        } else {
          promises.push(this._write(pipe.stream, chunk.data, chunk.encoding));
        }
      } else {
        pipe.stream.end();
      }
    });
    if (!promises.length) {
      promises.push(PromishLib.Promish.resolve());
    }
    return PromishLib.Promish.all(promises)
      .then(function() {
        try {
          chunk.callback();
        } catch (e) {
          // quietly ignore
        }
      });
  },
  _animate: function() {
    var count = 0;
    var seq = ['|', '/', '-', '\\'];
    var cr = '\u001b[0G'; // was '\033[0G'
    return setInterval(function() {
      process.stdout.write(seq[count++ % 4] + cr);
    }, 100);
  },
  _delay: function() {
    // in certain situations it may be useful to delay processing (e.g. for GC)
    var timeout = this.getTimeout && this.getTimeout();
    if (timeout) {
      return new PromishLib.Promish(resolve => {
        var anime = this._animate();
        setTimeout(() => {
          clearInterval(anime);
          resolve();
        }, timeout);
      });
    }
    return PromishLib.Promish.resolve();
  },

  _flush: function() {
    // If/while not corked and we have buffers to send, send them
    if (this.queue && !this.flushing && !this.corked) {
      if (this.queue.length) {
        this.flushing = true;
        this._delay()
          .then(() => this._pipe(this.queue.shift()))
          .then(() => {
            setImmediate(() => {
              this.flushing = false;
              this._flush();
            });
          });
      }

      if (!this.stem) {
        // Signal up-stream that we're ready for more data
        this.emit('drain');
      }
    }
  },

  write: function(data, encoding, callback) {
    // Called by up-stream pipe
    if (encoding instanceof Function) {
      callback = encoding;
      encoding = 'utf8';
    }
    callback = callback || utils.nop;

    if (!this.queue) {
      throw new Error('Cannot write to stream after end');
    }

    // Always queue chunks and then flush
    this.queue.push({
      data: data,
      encoding: encoding,
      callback: callback
    });
    this._flush();

    // restrict further incoming data if we have backed up buffers or
    // the children are still busy
    var stemFlow = this.corked || (this.queue.length > 3);
    return !stemFlow;
  },

  end: function() {
    // Signal from up-stream
    this.queue.push({
      callback: () => {
        this.queue = null;
        this.emit('finish');
      }
    });
    this._flush();
  },

  pipe: function(stream, options) {
    options = options || {};

    // some streams don't call callbacks
    var sync = options.sync || false;

    this.pipes.push({
      stream: stream,
      sync: sync
    });
  },
  unpipe: function(stream) {
    this.pipes = this.pipes.filter(function(pipe) {
      return pipe.stream !== stream;
    });
  },

  createChild: function() {
    // Create a down-stream flow-control
    var options = Object.assign({parent: this}, this.options);
    var child = new FlowControl(options);
    this.children.push(child);

    child.on('drain', () => {
      // a child is ready for more
      this._flush();
    });

    child.on('finish', () => {
      // One child has finished its stream. Remove it and continue
      this.children = this.children.filter(item => item !== child);
      this._flush();
    });

    return child;
  }
});
