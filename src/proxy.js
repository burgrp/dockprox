const fsPro = require("fs").promises;
const http = require("http");
const tls = require("tls");

module.exports = async config => {

    let reverseStr = s => s.split("").reverse().join("");
    let sortMapping = m => m
        .sort((a, b) => reverseStr(b.front.host).localeCompare(reverseStr(a.front.host)))
        .map(m => {
            // use ^ prefix to prioritize naked domains over wildcards e.g.
            // *.foo.bar will take preference over foo.bar, but
            // ^foo.bar takes preference over *.foo.bar
            if (m.front.host.startsWith("^")) {
                m.front.host = m.front.host.substring(1);
            }
            return m;
        });

    let virtualHostMapping = sortMapping(await config.mapper.getMapping());

    function handleError(err, req, res) {
        res.writeHead(err.httpCode || 502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: err.message || err
            }
        }, null, 2));
    }

    function logMapping() {
        console.info("Virtual host mapping:");
        virtualHostMapping.forEach(m => console.info(`  ${m.front.host} -> ${m.back.host}:${m.back.port}${m.back.path}`));
    }

    function getTarget(req) {
        let requestedHost = req.headers.host.split(":")[0];

        let target = virtualHostMapping.find(m => {
            let mh = m.front.host;
            if (mh === requestedHost || (mh.startsWith("*") && requestedHost.endsWith(mh.substring(1)))) {
                return true;
            }
        });

        if (!target) {
            throw new Error(`No configuration for virtual host ${requestedHost}`);
        }

        return { requestedHost, target };
    }

    function getTargetUrl(req, target) {
        return `http://${target.back.host}:${target.back.port}${target.back.path.endsWith("/") ? target.back.path.substring(0, target.back.path.length - 1) : target.back.path}${req.url}`
    }

    logMapping();

    let redirectMap = {};

    async function startServer(protocol, secure, redirectProtocol) {

        let pc = config[protocol];

        function checkRequestHeaders(req) {
            let clientCert = (req.socket.getPeerCertificate && req.socket.getPeerCertificate()) || {};

            let result = [
                ...Object.entries(req.headers).filter(([k, v]) => !k.startsWith("tcc-")),
                ["tcc-fingerprint-sha1", clientCert.fingerprint],
                ["tcc-fingerprint-sha256", clientCert.fingerprint256],
                ["tcc-serial-number", clientCert.serialNumber],
                ["tcc-valid-from", clientCert.valid_from],
                ["tcc-valid-to", clientCert.valid_to],
                ...Object.entries(clientCert.subject || {}).reduce((acc, [k, v]) => ([...acc, ["tcc-subject-" + k.toLowerCase(), v]]), [])
            ].reduce((acc, [k, v]) => (v === undefined ? acc : { ...acc, [k]: v }), {});

            return result;
        }

        if (pc.enabled === true || pc.enabled === "true") {

            redirectMap[protocol] = pc.port;

            for (let key of ["key", "cert", "ca"]) {
                pc.options[key] = pc.options[key] && await fsPro.readFile(pc.options[key]);
            }

            if (pc.letsEncrypt && pc.letsEncrypt.live) {

                async function tryCa(name) {
                    if (pc.letsEncrypt.ca) {
                        try {
                            return await fsPro.readFile(`${pc.letsEncrypt.ca}/${name}.pem`);
                        } catch (e) {
                            if (e.code !== "ENOENT") {
                                throw e;
                            }
                        }
                    }
                }

                let ctxs = (await Promise.all(
                    (await fsPro.readdir(pc.letsEncrypt.live, { withFileTypes: true }))
                        .filter(f => f.isDirectory())
                        .map(async f => ({
                            name: f.name,
                            ctx: tls.createSecureContext({
                                cert: await fsPro.readFile(`${pc.letsEncrypt.live}/${f.name}/fullchain.pem`),
                                key: await fsPro.readFile(`${pc.letsEncrypt.live}/${f.name}/privkey.pem`),
                                ca: await tryCa(f.name)
                            })
                        }))
                )).sort((a, b) => reverseStr(b.name).localeCompare(reverseStr(a.name)));

                pc.options.SNICallback = (servername, cb) => {
                    let ctx = (ctxs.find(({name}) => servername === name || servername.endsWith("." + name)) || {}).ctx;
                    cb(null, ctx);
                }
            }

            var server = require(protocol).createServer(pc.options, (req, res) => {
                try {

                    res.setTimeout(0);

                    let { requestedHost, target } = getTarget(req);

                    if ((target.secure != secure) && redirectMap[redirectProtocol]) {

                        let redirectUrl = `${redirectProtocol}://${requestedHost}:${redirectMap[redirectProtocol]}${req.url}`;

                        console.info(`${req.method} ${protocol}://${req.headers.host}${req.url} >> ${redirectUrl}`);

                        res.writeHead(308, {
                            Location: redirectUrl
                        });
                        res.end();

                    } else {

                        let targetUrl = getTargetUrl(req, target);

                        console.info(`${req.method} ${protocol}://${req.headers.host}${req.url} -> ${targetUrl}`);

                        let targetReq = http.request(targetUrl, {
                            agent: new http.Agent(), // avoid dead locks by request queueing 
                            method: req.method,
                            headers: checkRequestHeaders(req),
                        }, targetRes => {
                            res.writeHead(targetRes.statusCode, targetRes.statusMessage, targetRes.headers);

                            // ugly hack: flush the head in case of docker wait call
                            if (req.url.endsWith("/wait?condition=removed")) {
                                res.write("\n");
                            }

                            targetRes.pipe(res);
                        });

                        targetReq.on("error", e => {
                            handleError(e, req, res);
                        });

                        req.pipe(targetReq);
                    }

                } catch (e) {
                    handleError(e, req, res);
                }
            });

            server.on("clientError", (e, socket) => {
                if (e.code !== "ECONNRESET") {
                    console.error("Client error: ", e);
                }
                socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
            });

            server.on("upgrade", async (req, socket, head) => {
                try {

                    socket.on("error", e => {
                        if (e.code !== "EPIPE") {
                            console.error("Upgraded socket error:", e);
                        }
                    });

                    let { target } = getTarget(req);
                    let targetUrl = getTargetUrl(req, target);

                    console.info(`${req.method} ${protocol}://${req.headers.host}${req.url} -> ${targetUrl}`);

                    let targetReq = http.request(targetUrl, {
                        agent: new http.Agent(), // avoid dead locks by request queueing 
                        method: req.method,
                        headers: checkRequestHeaders(req),
                    });

                    targetReq.on("error", e => {
                        if (e.code !== "ECONNRESET") {
                            console.error("Upgraded socket error: ", e);
                        }
                    });

                    targetReq.on("upgrade", (targetRes, targetSocket, upgradeHead) => {

                        socket.write(
                            `HTTP/${targetRes.httpVersion} ${targetRes.statusCode} ${targetRes.statusMessage}\n` +
                            Object.entries(targetRes.headers).map(([k, v]) => `${k}: ${v}\n`).join("") +
                            "\n"
                        );

                        socket.pipe(targetSocket).pipe(socket);

                    });

                    targetReq.end(head);

                } catch (e) {
                    console.error("Error proxying upgrade request", e);
                    //TODO: return valid HTTP response 
                    socket.destroy();
                }
            });

            server.listen(pc.port).on("listening", () => console.info(`${protocol.toUpperCase()} server listening on port ${pc.port}`));
        }
    }

    return {
        async start() {

            await startServer("http", false, "https");
            await startServer("https", true, "http");

            config.mapper.onChange(newMapping => {
                virtualHostMapping = sortMapping(newMapping);
                logMapping();
            });
        }
    }
}