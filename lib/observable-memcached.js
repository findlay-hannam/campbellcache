const logger = require('binford-slf4j').getLogger('observable-memcached.js');
const MemcachedClient = require('memcached');
const Rx = require('rxjs');
const CacheItem = require('./cacheitem');
const NoOpMetricRecorder = require('./noopmetricsrecorder');
const Timer = require('./timer');
const CacheMetricStrings = require('./cachemetricstrings');


function getOrDefault(val,defaultVal) {
    return (typeof val !== 'undefined') ? val : defaultVal;
}

function ObservableMemcached(enabled, hosts, opts) {
    const options = opts || {};
    options.memcached = options.memcached || {};
    this.metricsRecorder = options.metricsrecorder || new NoOpMetricRecorder();
    // If no hosts, cannot be enabled
    if(hosts && hosts.length>0) {
        this.enabled = enabled;
    } else {
        this.enabled = false;
    }
    // only create client if hosts is set as enabled
    if(enabled) {
        this.client = new MemcachedClient(
            hosts,
            {
                timeout: options.memcached.timeout || 2500,
                poolSize: options.memcached.poolSize || 10,
                retries: options.memcached.retries || 0,
                reconnect: options.memcached.reconnect || 120000,
                retry: options.memcached.retry || 30000,
                idle: options.memcached.idle || 60000,
                maxValue: options.memcached.maxValue || 1048576,
                remove: getOrDefault(options.memcached.remove,false),
                keyCompression: getOrDefault(options.memcached.keyCompression,false),
                retries: options.memcached.retries || 0,
                minTimeout: options.memcached.minTimeout || 5000,
                maxTimeout: options.memcached.maxTimeout || 10000,
                factor: options.memcached.factor || 3,
                randomize: getOrDefault(options.memcached.randomize,false),
                debug: getOrDefault(options.memcached.debug,false),
            }
        )
    }

    this.stopClient = function() {
        try {
            this.client.end();
            logger.debug("Shutdown old client");
        } catch(err) {
            logger.warn("Exception encounter attempting to close memcached client {0}",err);
        }
    }

    return this;
}

ObservableMemcached.prototype.isAvailable = function() {
    return this.enabled;
}

ObservableMemcached.prototype.set = function(key,value,ttl,observable) {
    if(this.enabled) {
        logger.debug('Cache Enabled');
        this.client.set(key,value,ttl, function(err) {
            if(err) {
                logger.warn("Unable to write value for key: {0}, into cache {1}",key,err);
            }
            if(observable) {
                observable.next(new CacheItem(key,value,false));
            }
        })
    } else {
        if(observable) {
            observable.next(new CacheItem(key,value,false));
        }
    }
}


ObservableMemcached.prototype.del = function(key) {
    if(this.enabled) {
        const memcachedClient = this.client;
        var obsy = new Rx.Observable.create(function(observer) {
            memcachedClient.del(key, function (err) {
                if(err) {
                    logger.warn("unable to remove key: {0} from memcached",key);
                    observer.next(false);
                } else {
                    observer.next(true);
                }
                observer.complete();
            });
        });

        return obsy.take(1).shareReplay(1);
    } else {
        return new Rx.Observable.of(false);
    }
}

ObservableMemcached.prototype.get = function(key) {
    var client = this.client;
    if(this.enabled) {
        logger.debug("Cache is enabled");
        const timer = new Timer();
        const metricRecorder = this.metricsRecorder;
        var obsy = new Rx.Observable.create((observer) => {;
            client.get(key,function(err,data) {
                if(err) {
                    metricRecorder.logCacheMiss(key,CacheMetricStrings.CACHE_TYPE_DISTRIBUTED_CACHE);
                    observer.next(new CacheItem(key,null,false));
                } else {
                    if(data) {
                        metricRecorder.logCacheHit(key,CacheMetricStrings.CACHE_TYPE_DISTRIBUTED_CACHE);
                        observer.next(new CacheItem(key,data,true));
                    } else {
                        metricRecorder.logCacheMiss(key,CacheMetricStrings.CACHE_TYPE_DISTRIBUTED_CACHE);
                        observer.next(new CacheItem(key,null,false));
                    }
                }
                metricRecorder.incrementCounter(CacheMetricStrings.CACHE_TYPE_DISTRIBUTED_CACHE);
                metricRecorder.setDuration(CacheMetricStrings.CACHE_TYPE_DISTRIBUTED_CACHE,timer.inspect());
                observer.complete();
            });
        });
        return obsy.take(1).shareReplay(1);
    } else {
        logger.warn("Cache is disabled");
        this.metricsRecorder.logCacheMiss(key,CacheMetricStrings.CACHE_TYPE_DISTRIBUTED_CACHE);
        return new Rx.Observable.of(new CacheItem(key,null,false)).take(1);
    }
}

/**
 * This will remove everything in your cache.. Are you sure you want to do this?
 */
ObservableMemcached.prototype.flush = function(cb) {
    var callback = () => {};
    if(cb) {
        callback = cb;
    }
    if(this.client) {
        this.client.flush(callback);
    }
}

ObservableMemcached.prototype.shutdown = function(gracePeriodTTL) {
    if(this.client) {
        var grace_ttl = gracePeriodTTL;
        if(arguments.length == 0 || (typeof gracePeriodTTL == 'undefined')) {
            grace_ttl = 1000;
        }
        if(grace_ttl>0) {
            setTimeout(() => {
                this.stopClient();
            },gracePeriodTTL);
        } else {
            this.stopClient();
        }
    }
    this.enabled = false;
}


ObservableMemcached.prototype.setMetricsRecorder = function(metricsRecorder) {
    this.metricsRecorder = metricsRecorder;
}

module.exports = ObservableMemcached;


