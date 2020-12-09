#!/usr/bin/env node

'use strict';

var path = require('path');
var semver = require('semver');
var request = require('request-promise-native');
var express = require('express');
var Router = require('express-promise-router');
var level = require('level');
var crypto = require('crypto');
var mkdirp = require('mkdirp');
var proxy = require('express-http-proxy');
var compression = require('compression');
var favicon = require('serve-favicon');
var serveStatic = require('serve-static');
var then = require('then-levelup');
var http = require('http');
var https = require('https');

var Logger = require('./logger');
var util = require('./util');
var pkg = require('./../package.json');
var findVersion = require('./find-version');
var pouchServerLite = require('./pouchdb-server-lite');

module.exports = (options, callback) => {
    var FAT_REMOTE = options.remote;
    var SKIM_REMOTE = options.remoteSkim;
    var port = options.port;
    var pouchPort = options.pouchPort;
    var localBase = options.url.replace(/:5080$/, ':' + port); // port is configurable
    var directory = path.resolve(options.directory);
    var logger = new Logger(Logger.getLevel(options.logLevel));
    mkdirp.sync(directory);
    var startingTimeout = 1000;

    const keepAliveOptions = {
        keepAlive: true,
    };
    http.globalAgent = new http.Agent(keepAliveOptions);
    https.globalAgent = new https.Agent(keepAliveOptions);
      

    logger.code('Welcome!');
    logger.code('To start using local-npm, just run: ');
    logger.code(`   $ npm set registry ${localBase}`);
    logger.code('To switch back, you can run: ');
    logger.code(`   $ npm set registry ${FAT_REMOTE}`);
    logger.code(`options: ${JSON.stringify(options)}`);

    var backoff = 1.1;
    var app = express();
    const router = Router();
    app.use(router);
    var PouchDB = pouchServerLite(options).PouchDB;

    var skimRemote = new PouchDB(SKIM_REMOTE);
    var skimLocal = new PouchDB('skimdb', {
        auto_compaction: true
    });
    var db = then(level(path.resolve(directory, 'binarydb')));

    logger.code('\nA simple npm-like UI is available here');
    logger.code(`http://127.0.0.1:${port}/_browse`);

    router.use(util.request(logger));
    router.use(compression());
    router.use(favicon(path.resolve(__dirname, '..', 'dist', 'favicon.ico')));
    router.use(serveStatic(path.resolve(__dirname, '..', 'dist')));
    router.use('/_browse', serveStatic(path.resolve(__dirname, '..', 'dist')));
    router.use('/_browse*', serveStatic(path.resolve(__dirname, '..', 'dist')));

    router.get('/_skimdb', redirectToSkimdb);
    router.get('/_skimdb*', redirectToSkimdb);
    router.get('/-/*', proxy(FAT_REMOTE, {
        limit: Infinity
    }));
    // Security checks - Always Proxy (don't have locally)
    router.post('/-/*', proxy(FAT_REMOTE, {
        limit: Infinity
    }));
    router.get('/', async (req, res) => {
        var resp = await Promise.all([skimLocal.info(), getCountAsync()]);
        res.json({
            'local-npm': 'welcome',
            version: pkg.version,
            db: resp[0],
            tarballs: resp[1]
        });
    });


    //
    // utils
    //
    async function redirectToSkimdb(req, res) {
        var skimUrl = 'http://localhost:' + pouchPort + '/skimdb';
        try {
            await request.get(req.originalUrl.replace(/^\/_skimdb/, skimUrl))
                .pipe(res);
        } catch(err) {
            logger.error("couldn't proxy to skimdb");
            logger.error(err);
        }
    }

    function massageMetadata(urlBase, doc) {
        var name = doc.name;
        var versions = Object.keys(doc.versions);
        for (var i = 0, len = versions.length; i < len; i++) {
            var version = versions[i];
            if (!semver.valid(version)) {
                // apparently some npm modules like handlebars
                // have invalid semver ranges, and npm deletes them
                // on-the-fly
                delete doc.versions[version];
            } else {
                doc.versions[version].dist.tarball = urlBase + '/' + 'tarballs/' + name + '/' + version + '.tgz';
                doc.versions[version].dist.info = urlBase + '/' + name + '/' + version;
            }
        }
        return doc;
    }

    function sendBinary(res, buffer) {
        res.set('content-type', 'application/octet-stream');
        res.set('content-length', buffer.length);
        return res.send(buffer);
    }

    function cacheResponse(res, etag) {
        // do this to be more like registry.npmjs.com. not sure if it
        // actually has a benefit, though
        res.set('ETag', '"' + etag + '"');
        res.set('Cache-Control', 'max-age=300');
    }

    async function getDocumentAsync(name) {
        try {
            // If we have the package data locally, return it
            return await skimLocal.get(name);
        } catch (err) {
            // Local skim doesn't have the data
        }

        // If we get here, we don't have the metadata locally
        var doc;
        try {
            doc = await skimRemote.get(name)
        } catch (err) {
            // Failed fetching metadata from skim remote
        }

        // Try to get metadata from fat remote
        // We don't catch this if it fails, let it bubble up, we give up
        if (doc === undefined) {
            const url = `${FAT_REMOTE}/${name}`;

            var response = await request(url, {
                followRedirect: false,
                // Prevent 404 from throwing
                simple: false,
                json: true,
                resolveWithFullResponse: true,
            });

            // Make data available to outter
            doc = response.json;
        }

        // We have metadata from skim remote or fat remote
        // Update local skim db with that data, then return
        delete doc['_rev'];
        await skimLocal.post(doc);
        return await skimLocal.get(name);
    }

    function shutdown() {
        // `sync` can be undefined if you start the process while offline and
        // then immediately Ctrl-C it before you go online
        if (sync) {
            // close gracefully
            sync.cancel();
        }

        Promise.all([
            db.close(),
            skimLocal.close()
        ]).catch(null).then(() => {
            process.exit();
        });
    }

    async function getTarLocationAsync(dist) {
        if (dist.info) {
            const response = await request(dist.info,  {
                followRedirect: false,
                // Do throw on 404
                simple: true,
                json: true,
                resolveWithFullResponse: true,
            });
            return response.json.dist.tarball;
        } else {
            return dist.tarball;
        }
    }

    async function downloadTarAsync(id, tarball) {
        const options = {
            encoding: null,
            followRedirect: false,
            // Throw on 404
            simple: true,
            json: false,
            resolveWithFullResponse: true,
        };
        const response = await request(tarball, options);
        const body =  response.body;
        await db.put(id, body);
        return body;
    }

    //
    // actual server logic
    //
    router.get('/:name/:version', async (req, res) => {
        try {
            const name = req.params.name;
            const version = req.params.version;

            const doc = await getDocumentAsync(name);
            var packageMetadata = massageMetadata(localBase, doc);
            var versionMetadata = findVersion(packageMetadata, version);
            if (versionMetadata) {
                cacheResponse(res, doc._rev);
                res.json(versionMetadata);
            } else {
                res.status(404).json({
                    error: 'version not found: ' + version
                });
            }
        } catch (error) {
            logger.error('unexpected exception in /:name/:version')
            logger.error(error);
            res.status(500).json({
                error
            });
        }
    });

    router.get('/:name', async (req, res) => {
        try {
            const name = req.params.name;
            const doc = await getDocumentAsync(name)
            res.json(massageMetadata(localBase, doc));
        } catch(error) {
            logger.error('unexpected exception in /:name')
            logger.error(error);
            res.status(500).json({
                error
            });
        }
    });

    // allow support for scoped packages
    // Scoped must go before unscoped
    router.get('/tarballs/:user/:package/:version.tgz', scopedPackageRoute);
    router.get('/:user/:package/-/:version.tgz', scopedPackageRoute);
    // router.get('/:user/:package/:version.tgz', scopedPackageRoute);

    async function scopedPackageRoute(req, res) {
        var userName = req.params.user;
        var pkgName = req.params.package;
        var pkgVersion = req.params.version.replace(`${pkgName}-`, '');
        var fullName = `${userName}/${pkgName}`;
        // If the package is '-' then don't send it for the metadata
        // request
        if (pkgName === '-') fullName = userName;
        var id = `${userName}/${pkgName}/${pkgVersion}`;

        const doc = await getDocumentAsync(fullName);
        await GetTarLocallyOrRemotelyAsync(res, doc, id, pkgName, pkgVersion);
    }

    async function GetTarLocallyOrRemotelyAsync(res, doc, id, pkgName, pkgVersion) {
        var hash = crypto.createHash('sha1');

        try {
            var dist = doc.versions[pkgVersion].dist;
            let buffer;

            try {
                // Try to get from local binarydb 
                buffer = await db.get(id, {
                    asBuffer: true,
                    valueEncoding: 'binary'
                });

                if (buffer === undefined || buffer.length === 0) {
                    throw new Error(`downloading ${pkgName}-${pkgVersion}`)
                }

                // Check hash and return local file
                hash.update(buffer);
                const localSha = hash.digest('hex');
                if (dist.shasum !== localSha) {
                    logger.warn(`stored hash doesn't match expected: ${dist.shasum} vs ${localSha}`, pkgName, pkgVersion);
                    // Throw so we re-download remotely
                    throw new Error(`redownloading ${pkgName}-${pkgVersion}, stored hash doesn't match expected: ${dist.shasum} vs ${localSha}`)
                } else {
                    logger.hit(pkgName, pkgVersion);
                    sendBinary(res, buffer);
                }
            } catch (error) {
                // Didn't have binary locally, fetch from remote
                logger.miss(pkgName, pkgVersion);
                const location = await getTarLocationAsync(dist);
                const tar = await downloadTarAsync(id, location)
                sendBinary(res, tar);
            }
        } catch (error) {
            logger.error(`failed fetching binary locally or remotely`);
            logger.error(error);
            res.status(500).send(error);
            return;
        }

        // Update the Skim DB download count for this specific version
        try {
            const docUpdate = await skimLocal.get(pkgName);
            docUpdate.versions[pkgVersion].downloads
                ? docUpdate.versions[pkgVersion].downloads += 1
                : docUpdate.versions[pkgVersion].downloads = 1;
            await skimLocal.put(docUpdate);
        } catch (error) {
            logger.error(`Exception updated download count: ${pkgName}, ${pkgVersion}`);
            logger.error(error);
        }

        // If we get here we sent a response, don't send again
    }

    // Unscoped packages
    router.get('/tarballs/:name/:version.tgz', unScopedTarballRoute);
    // NPM no longer requires or use the /tarballs/ prefix by default
    // NPM allows downloads from both URLs though, so we need to support both
    router.get('/:name/-/:version.tgz', unScopedTarballRoute);

    async function unScopedTarballRoute(req, res) {
        var pkgName = req.params.name;
        // Strip the package name prefix off the version if present
        var pkgVersion = req.params.version.replace(`${pkgName}-`, '');
        var id = `${pkgName}-${pkgVersion}`;

        const doc = await getDocumentAsync(pkgName);
        await GetTarLocallyOrRemotelyAsync(res, doc, id, pkgName, pkgVersion);
    }

    router.put('/*', proxy(FAT_REMOTE, {
        limit: Infinity
    }));

    router.get('/*', (req, res) => {
        logger.code(`Default Route Handler: ${req.path}`);
        res.sendStatus(404);
    });

    var sync;

    function replicateSkim() {
        skimRemote.info()
            .then((info) => {
                sync = skimLocal.replicate.from(skimRemote, {
                    live: true,
                    batch_size: 200,
                    retry: true
                }).on('change', (change) => {
                    startingTimeout = 1000;
                    var percent = Math.min(100,
                        (Math.floor(change.last_seq / info.update_seq * 10000) / 100).toFixed(2));
                    logger.sync(change.last_seq, `${percent}%`);
                }).on('error', (err) => {
                    // shouldn't happen
                    logger.warn(err);
                    logger.warn('Error during replication with ' + SKIM_REMOTE);
                });
            }).catch((err) => {
                logger.warn(err);
                logger.warn('Error fetching info() from ' + SKIM_REMOTE +
                    ', retrying after ' + Math.round(startingTimeout) + ' ms...');
                restartReplication();
            });
    }

    function restartReplication() {
        // just keep going
        startingTimeout *= backoff;
        setTimeout(replicateSkim, Math.round(startingTimeout));
    }

    async function getCountAsync() {
        return new Promise((fulfill, reject) => {
            var i = 0;
            db.createKeyStream()
                .on('data', () => {
                    i++;
                }).on('end', () => {
                    fulfill(i);
                }).on('error', reject);
        });
    }
    replicateSkim();

    process.on('SIGINT', () => {
        shutdown();
    });

    var server = app.listen(port, callback);
    server.headersTimeout = 120 * 1000;
    server.keepAliveTimeout = 120 * 1000;

    return {
        server,
        shutdown
    }
};
