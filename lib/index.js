#!/usr/bin/env node

'use strict';

const node_util = require('util');
const stream = require('stream');
const pipeline = node_util.promisify(stream.pipeline);
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
var fs = require('fs');
var fsp = require('fs').promises;

var Logger = require('./logger');
var util = require('./util')
var pkg = require('./../package.json');
var findVersion = require('./find-version');
var pouchServerLite = require('./pouchdb-server-lite');

const pause = node_util.promisify((a, f) => setTimeout(f, a));

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
    const useFiles = true;
    const downloadStats = false;

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

    // Make sure the directory exists
    const filedb = path.resolve(directory, 'filedb');
    if (!fs.existsSync(filedb)){
        fs.mkdirSync(filedb);
    }

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
            logger.warn("couldn't proxy to skimdb");
            logger.warn(err);
        }
    }

    function massageMetadata(urlBase, doc) {
        // This will be scoped, like '@types/aws-lambda' or just 'request'
        var scopedName = doc.name;
        var pkgName = scopedName;
        if (scopedName.indexOf('/') > 0) {
            pkgName = scopedName.split('/')[1];
        }
        var versions = Object.keys(doc.versions);
        for (var i = 0, len = versions.length; i < len; i++) {
            var version = versions[i];
            if (!semver.valid(version)) {
                // apparently some npm modules like handlebars
                // have invalid semver ranges, and npm deletes them
                // on-the-fly
                delete doc.versions[version];
            } else {
                doc.versions[version].dist.tarball = `${urlBase}/${scopedName}/-/${pkgName}-${version}.tgz`;
                doc.versions[version].dist.info = `${urlBase}/${scopedName}/${version}`;

                // doc.versions[version].dist.tarball = urlBase + '/' + name + '/' + version + '.tgz';
                // doc.versions[version].dist.info = urlBase + '/' + name + '/' + version;
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
            doc = response.body;
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

    // 2020-12-09 - This version worked, but it could never
    // hit the dist.info block because .info is not persisted
    // to the local skimdb and it's only generated on the fly
    // on a route that does not call this function.
    // This function has been replaced with dist.tarball
    // async function getRemoteTarLocationAsync(dist) {
    //     if (dist.info) {
    //         const response = await request(dist.info,  {
    //             followRedirect: false,
    //             // Do throw on 404
    //             simple: true,
    //             json: true,
    //             resolveWithFullResponse: true,
    //         });
    //         return response.body.dist.tarball;
    //     } else {
    //         return dist.tarball;
    //     }
    // }

    async function downloadRemoteTarToDBAsync(id, tarball) {
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

    async function downloadRemoteTarToFileAsync(id, tarball) {
        const options = {
            encoding: null,
            followRedirect: false,
            // Throw on 404
            simple: true,
            json: false,
            // Set to false if piping
            resolveWithFullResponse: false,
        };

        const req = request(tarball, options);
        const filePath = path.join(filedb, id);
        const fileStream = fs.createWriteStream(filePath);

        // Use a promisified stream pipeline so we can await completion
        // We need to be sure the file is written before we allow it to be served
        // TODO: De-duplicate simultaneous requests to get the same tgz
        //       This reduces bandwidth and local disk I/O usage while also
        //       returning the same contents for two requests in less time.
        //       Create a set of promises that are all resolved when the
        //       first download finishes.
        // TODO: Write to a temp file and move to final location
        //       This ensures that other readers cannot see our file
        //       when it is incomplete.
        //       This also allows us to check the hash before moving
        //       the file to the "known-good" location.
        //       Since file moves are atomic we don't have to check hashes on
        //       reads anymore (npm will reject the files if we did get
        //       a corrupted database, which I'll be a coke zero will never happen)
        await pipeline(
            req,
            fileStream
        );
    }

    //
    // actual server logic
    //

    

    // allow support for scoped packages
    // Scoped must go before unscoped
    router.get('/tarballs/:user/:package/:version.tgz', scopedPackageRoute);
    router.get('/:user/:package/-/:version.tgz', scopedPackageRoute);
    // router.get('/:user/:package/:version.tgz', scopedPackageRoute);

    async function scopedPackageRoute(req, res) {
        var userName = req.params.user;
        var pkgName = req.params.package;
        var pkgVersion = req.params.version.replace(`${pkgName}-`, '');
        var scopedName = `${userName}/${pkgName}`;
        // If the package is '-' then don't send it for the metadata
        // request
        if (pkgName === '-') scopedName = userName;
        var id = `${userName}-${pkgName}-${pkgVersion}.tgz`;

        const doc = await getDocumentAsync(scopedName);
        const sent = await SendTarFromLocalOrRemoteAsync(res, doc, id, pkgName, pkgVersion);
        // The response was already sent, awaiting this takes no more client time
        if (sent) await UpdateDownloadStatsAsync(pkgName, pkgVersion);
    }

    // Unscoped packages
    router.get('/tarballs/:name/:version.tgz', unScopedTarballRoute);
    // NPM allows downloads from both URLs though, so we need to support both
    router.get('/:name/-/:version.tgz', unScopedTarballRoute);

    async function unScopedTarballRoute(req, res) {
        var pkgName = req.params.name;
        // Strip the package name prefix off the version if present
        var pkgVersion = req.params.version.replace(`${pkgName}-`, '');
        var id = `${pkgName}-${pkgVersion}.tgz`;

        const doc = await getDocumentAsync(pkgName);
        const sent = await SendTarFromLocalOrRemoteAsync(res, doc, id, pkgName, pkgVersion);
        // The response was already sent, awaiting this takes no more client time
        if (sent) await UpdateDownloadStatsAsync(pkgName, pkgVersion);
    }

    async function SendTarFromLocalOrRemoteAsync(res, doc, id, pkgName, pkgVersion) {

        try {
            var dist = doc.versions[pkgVersion].dist;
            let buffer;

            // Check if the file exists locally first
            if (useFiles) {
                const filePath = path.join(filedb, id);
                let fileExists = true;
                try {
                    // Stat throws if the file doesn't exist
                    const statRes = await fsp.stat(filePath);
                    if (!statRes.isFile) fileExists = false;
                } catch (err) {
                    fileExists = false;
                }
                if (fileExists) {
                    logger.hit(pkgName, pkgVersion);

                    const fileStream = fs.createReadStream(filePath);
                    fileStream.pipe(res);
                    return true;
                }
            } else {
                // Try to get from local binarydb 
                buffer = await db.get(id, {
                    asBuffer: true,
                    valueEncoding: 'binary'
                });

                if (buffer !== undefined && buffer.length > 0) {
                    // Check hash and return local file
                    const hash = crypto.createHash('sha1');
                    hash.update(buffer);
                    const localSha = hash.digest('hex');
                    if (dist.shasum !== localSha) {
                        logger.warn(`stored hash doesn't match expected: ${dist.shasum} vs ${localSha}`, pkgName, pkgVersion);
                        // Fall through so we re-download remotely
                    } else {
                        logger.hit(pkgName, pkgVersion);

                        // This is the local file...
                        sendBinary(res, buffer);
                        return true;
                    }
                }
            }


            // Didn't have binary locally, fetch from remote
            logger.miss(pkgName, pkgVersion);
            if (useFiles) {
                await downloadRemoteTarToFileAsync(id, dist.tarball);
            } else {
                await downloadRemoteTarToDBAsync(id, dist.tarball);
            }

            const fileStream = fs.createReadStream(path.join(filedb, id));
            res.set('content-type', 'application/octet-stream');
            // Use a promisified stream pipeline so we can await completion
            await pipeline(
                fileStream,
                res
            );
            return true;
        } catch (error) {
            res.status(500).send(error);
            logger.warn(`failed fetching binary locally or remotely`);
            logger.warn(error);
            return false;
        }
        // If we get here we sent a response, don't send again
    }

    async function UpdateDownloadStatsAsync(pkgName, pkgVersion) {
        if (!downloadStats) return;

        // Update the Skim DB download count for this specific version
        for (let i = 0; i < 3; i++) {
            try {
                const docUpdate = await skimLocal.get(pkgName);
                if (docUpdate === undefined) {
                    logger.warn(`UpdateDownloadStatsAsync Got no doc for pkgName: ${pkgName}`);
                    return;
                } else {
                    docUpdate.versions[pkgVersion].downloads
                        ? docUpdate.versions[pkgVersion].downloads += 1
                        : docUpdate.versions[pkgVersion].downloads = 1;
                    await skimLocal.put(docUpdate);
                }

                return;
            } catch (error) {
                // Sometimes multiple versions of the same package are downloaded
                // right around the same time; some of the download count updates will fail
                // Wait a bit before trying again
                await pause(200);
            }
        }

        // If we get here all attempts failed, this we should log
        logger.warn(`Exception updating download count: ${pkgName}, ${pkgVersion}`);
    }

    // This route was called by the /name route
    router.get('/:pkgname/:version', VersionInfoAsync);
    router.get('/:user/:pkgname/:version', VersionInfoAsync);

    async function VersionInfoAsync(req, res) {
        try {
            const pkgName = req.params.pkgName;
            const user = req.params.user;
            const version = req.params.version;
            const scopedName = user !== undefined ? `${user}/${pkgName}` : pkgName;

            const doc = await getDocumentAsync(scopedName);
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
            logger.warn('unexpected exception in VersionInfoAsync',
                req.params.user, req.params.pkgName, req.params.version)
            logger.warn(error);
            res.status(500).json({
                error
            });
        }
    }

    router.get('/:name', async (req, res) => {
        try {
            const name = req.params.name;
            const doc = await getDocumentAsync(name)
            const metadata = massageMetadata(localBase, doc);
            res.json(metadata);
        } catch(error) {
            logger.warn('unexpected exception in /:name')
            logger.warn(error);
            res.status(500).json({
                error
            });
        }
    });

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
    // For Docker default graceful shutdown signal
    process.on('SIGTERM', () => {
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
